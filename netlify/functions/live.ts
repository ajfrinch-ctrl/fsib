import { getStore } from "@netlify/blobs";
import { BLOB_KEY, STORE_NAME, type BlobAdapter } from "../../src/lib/store.ts";
import { createLiveHandler, createLiveHub, withLiveNotify } from "../../src/lib/live.ts";

/*
  Netlify Function backing /api/live — the real-time channel.

  Long-poll: GET /api/live?version=<the version I hold>&wait=<seconds>.
    200 { changed:true, version }  -> another device saved; pull /api/sync now
    304                            -> nothing moved while we held the request
    200 { changed:false, reset }   -> the cloud went backwards (DELETE/restore)

  It carries no document, only "the version moved", so a watch costs one
  invocation and one blob read instead of shipping the whole state around.

  How a remote write reaches a parked request: Netlify gives one instance no
  memory of the instance that served a write, so every hold runs BOTH signals —
  the in-process hub (instant, for a write this instance served) and the shared
  blob poller in createLiveHandler (which is what actually finds another
  device's write). Without the poller a deployed hold could only ever learn
  about a remote write by timing out — the reason two phones looked out of sync.

  Holding time: a synchronous Function is killed at the site's function timeout,
  which is 10 s on the default plan. A killed hold reaches the browser as a
  gateway error, so the app treats it as a broken channel and backs off — exactly
  the wrong lesson. Hence the platform-safe 8 s default, advertised back to the
  client in X-Live-Max-Wait-Ms so it parks for that long and no longer.

    FSIB_LIVE_MAX_WAIT_MS   raise it after raising the site's function timeout
                            (Netlify allows up to 30 s on request)
    FSIB_LIVE_POLL_MS       how often a parked hold re-reads the blob looking
                            for another instance's write (default 2 s)
*/

function envMs(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.floor(raw)));
}

let store: ReturnType<typeof getStore> | null = null;

function blobs() {
  if (!store) store = getStore({ name: STORE_NAME, consistency: "strong" });
  return store;
}

const adapter: BlobAdapter = {
  async get() {
    return await blobs().get(BLOB_KEY, { type: "json" });
  },
  async set(value) {
    await blobs().setJSON(BLOB_KEY, value);
  },
  async del() {
    await blobs().delete(BLOB_KEY);
  }
};

const hub = createLiveHub();

export const config = {
  path: "/api/live"
};

export default createLiveHandler(withLiveNotify(adapter, hub), hub.wait, {
  /* 8 s: under the 10 s default function timeout, so the answer is a 304 the
     app can read rather than a gateway error it has to retry. */
  maxWaitMs: envMs("FSIB_LIVE_MAX_WAIT_MS", 8_000, 1_000, 55_000),
  /* 2 s: every tick is a billed blob read on Netlify, and a two-second worst
     case is still "another phone's entry appeared while I watched". */
  pollIntervalMs: envMs("FSIB_LIVE_POLL_MS", 2_000, 250, 30_000)
});
