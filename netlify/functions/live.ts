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

  `wait` comes from the in-process hub: a write made by *this* function
  instance wakes its own parked watchers immediately. Writes made by other
  instances are picked up by the poll loop inside createLiveHandler, which is
  the part that needs no shared memory — Netlify gives us none.

  config.path routes it (Netlify Functions v2). A synchronous function may run
  up to 60 s, so LIVE_MAX_WAIT_MS caps a single hold below that.
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

const hub = createLiveHub();

export const config = {
  path: "/api/live"
};

export default createLiveHandler(withLiveNotify(adapter, hub), hub.wait);
