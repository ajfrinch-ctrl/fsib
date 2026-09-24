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

const hub = createLiveHub();
const handler = createLiveHandler(withLiveNotify(adapter, hub), hub.wait);

export default defineEventHandler(async (event) => {
  const response = await handler(toWebRequest(event));
  return sendWebResponse(event, response);
});
