import { getStore } from "@netlify/blobs";
import { BLOB_KEY, STORE_NAME, createSyncHandler, type BlobAdapter } from "../../../src/lib/store.ts";

/*
  Nitro server route for /api/sync — the file layout used by the deployed
  fsib.netlify.app build (Nitro/Nuxt style: server/routes/**).

  This repository's own deploy path is the Netlify Function in
  netlify/functions/sync.ts, which is what Netlify picks up from a
  buildless static site. Both files are thin adapters over the same
  src/lib/store.ts handler, so the wire contract cannot drift between them.

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

const handler = createSyncHandler(adapter);

export default defineEventHandler(async (event) => {
  const response = await handler(toWebRequest(event));
  return sendWebResponse(event, response);
});
