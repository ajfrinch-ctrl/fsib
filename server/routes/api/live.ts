import { getStore } from "@netlify/blobs";
import { BLOB_KEY, STORE_NAME, type BlobAdapter } from "../../../src/lib/store.ts";
import { createLiveHandler, createLiveHub, withLiveNotify } from "../../../src/lib/live.ts";

/*
  Nitro server route for /api/live — the real-time channel, for the deployed
  fsib.netlify.app build (Nitro/Nuxt style: server/routes/**).

  Thin adapter over the same src/lib/live.ts handler that netlify/functions/live.ts,
  dev-server.mjs and the tests use, so the long-poll contract cannot drift
  between them.

  `defineEventHandler`, `toWebRequest` and `sendWebResponse` are h3
  auto-imports provided by the Nitro runtime.
*/

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

/* A Netlify-hosted route is a synchronous Function too, so it inherits the same
   platform ceiling: a hold that outlives the site's function timeout is killed
   as a gateway error, which a phone can only read as a broken channel. Hold for
   8 s by default (under the 10 s default timeout) and advertise that ceiling in
   X-Live-Max-Wait-Ms so the app parks for exactly that long. Raise it with
   FSIB_LIVE_MAX_WAIT_MS once the site's function timeout is higher. */
function envMs(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.floor(raw)));
}

const hub = createLiveHub();
const handler = createLiveHandler(withLiveNotify(adapter, hub), hub.wait, {
  maxWaitMs: envMs("FSIB_LIVE_MAX_WAIT_MS", 8_000, 1_000, 55_000),
  pollIntervalMs: envMs("FSIB_LIVE_POLL_MS", 2_000, 250, 30_000)
});

export default defineEventHandler(async (event) => {
  const response = await handler(toWebRequest(event));
  return sendWebResponse(event, response);
});
