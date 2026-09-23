import { getStore } from "@netlify/blobs";
import { BLOB_KEY, STORE_NAME, createSyncHandler, type BlobAdapter } from "../../src/lib/store.ts";

/*
  Netlify Function backing /api/sync.

  Routed by the `config.path` export below (Netlify Functions v2), so no
  redirect entry is needed. The blob store is opened lazily: getStore()
  reads NETLIFY_BLOBS_CONTEXT from the runtime, which only exists inside
  a Netlify invocation.

  All request handling lives in src/lib/store.ts so the Function, the
  Nitro server route, the dev server and the tests share one implementation.
*/

let store: ReturnType<typeof getStore> | null = null;

function blobs() {
  if (!store) store = getStore({ name: STORE_NAME, consistency: "strong" });
  return store;
}

const adapter: BlobAdapter = {
  async get() {
    /* v11 of @netlify/blobs has no getJSON(); the JSON shape is an option on get().
       A missing key resolves to null, which normalizeState() treats as empty. */
    return await blobs().get(BLOB_KEY, { type: "json" });
  },
  async set(value) {
    await blobs().setJSON(BLOB_KEY, value);
  },
  async del() {
    await blobs().delete(BLOB_KEY);
  }
};

export const config = {
  path: "/api/sync"
};

export default createSyncHandler(adapter);
