import test from "node:test";
import assert from "node:assert/strict";
import {
  CloudApiError,
  DEVICE_ONLY_SETTING_KEYS,
  DEVICE_PREFERENCE_KEYS,
  isAbort,
  isLiveUnavailable,
  loadCloudState,
  mergeRecords,
  mergeStates,
  saveCloudState,
  watchCloud
} from "../src/lib/cloud-api.ts";

function fakeFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return calls;
}

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("loadCloudState tolerates a 404 as 'nothing saved yet'", async () => {
  fakeFetch(() => json(404, { error: "not-found" }));
  const state = await loadCloudState();
  assert.deepEqual(state, { settings: {}, records: [], trash: [], version: 0, updatedAt: null });
});

test("loadCloudState repairs a partial payload", async () => {
  fakeFetch(() => json(200, { records: "not-an-array", version: "7" }));
  const state = await loadCloudState();
  assert.deepEqual(state.records, []);
  assert.equal(state.version, 7);
});

test("saveCloudState sends version + force and strips the PIN", async () => {
  const calls = fakeFetch(() => json(201, { version: 3 }));
  const out = await saveCloudState(
    { settings: { branch: "Tantar", pin: "4321" }, records: [{ date: "2026-09-01" }], trash: [] },
    { version: 2 }
  );
  assert.equal(out.ok, true);
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.version, 2);
  assert.equal(sent.force, false);
  assert.equal(sent.settings.pin, undefined, "PIN is device-only");
  assert.equal(sent.settings.branch, "Tantar");
  assert.deepEqual(DEVICE_ONLY_SETTING_KEYS, ["pin"]);
});

test("a 409 comes back as a value, not an exception", async () => {
  fakeFetch(() => json(409, { error: "version-conflict", message: "Another device saved first.", currentVersion: 9 }));
  const out = await saveCloudState({ settings: {}, records: [], trash: [] }, { version: 4 });
  assert.equal(out.ok, false);
  assert.equal(out.status, 409);
  assert.equal(out.error, "version-conflict");
  assert.equal(out.currentVersion, 9);
});

test("mergeRecords keeps the newest write per date", () => {
  const { rows, conflicts } = mergeRecords(
    [{ date: "2026-09-01", cash: "local", updated: "2026-09-01T10:00:00.000Z" }],
    [
      { date: "2026-09-01", cash: "cloud", updated: "2026-09-01T08:00:00.000Z" },
      { date: "2026-08-30", cash: "only-cloud", updated: "2026-08-30T08:00:00.000Z" }
    ]
  );
  assert.deepEqual(rows.map((r) => r.date), ["2026-08-30", "2026-09-01"]);
  assert.equal(rows[1].cash, "local");
  assert.deepEqual(conflicts, ["2026-09-01"]);
});

test("mergeStates takes newer shared settings but keeps local device preferences", () => {
  const local = {
    settings: {
      branch: "Local Branch",
      template: "local template",
      theme: "dark",
      autoSync: false,
      realtime: false,
      settingsUpdatedAt: "2026-09-01T08:00:00.000Z",
      pin: "1111"
    },
    records: [{ date: "2026-09-01", updated: "2026-09-01T08:00:00.000Z" }],
    trash: []
  };
  const cloud = {
    settings: { branch: "Cloud Branch", template: "cloud template", settingsUpdatedAt: "2026-09-05T08:00:00.000Z" },
    records: [{ date: "2026-09-02", updated: "2026-09-02T08:00:00.000Z" }],
    trash: [],
    version: 4,
    updatedAt: "2026-09-05T08:00:00.000Z"
  };
  const merged = mergeStates(local, cloud);
  assert.equal(merged.settings.branch, "Cloud Branch", "shared settings follow the newer edit");
  assert.equal(merged.settings.theme, "dark", "per-device theme stays local");
  assert.equal(merged.settings.pin, undefined);
  assert.equal(merged.settings.autoSync, undefined);
  assert.equal(merged.settings.realtime, undefined);
  assert.deepEqual(merged.records.map((r) => r.date), ["2026-09-01", "2026-09-02"]);
});

test("mergeStates leaves shared settings alone when the local edit is newer", () => {
  const local = {
    settings: { branch: "Local Branch", settingsUpdatedAt: "2026-09-09T08:00:00.000Z" },
    records: [],
    trash: []
  };
  const cloud = {
    settings: { branch: "Cloud Branch", settingsUpdatedAt: "2026-09-05T08:00:00.000Z" },
    records: [],
    trash: [],
    version: 1,
    updatedAt: null
  };
  assert.equal(mergeStates(local, cloud).settings.branch, "Local Branch");
});

test("reads the deployed endpoint's { ok, empty, state } envelope", async () => {
  // shape copied from a live GET https://fsib.netlify.app/api/sync
  fakeFetch(() =>
    json(200, {
      ok: true,
      empty: false,
      state: {
        settings: { branch: "Tantar Branch", zone: "Cumilla" },
        records: [{ date: "2026-09-14", cash: "1257100", updated: "2026-09-14T09:08:00.514Z" }],
        trash: [{ date: "2026-09-09", deleted: "2026-09-10T12:07:25.737Z" }],
        version: 16,
        updatedAt: "2026-09-14T09:08:02.462Z"
      }
    })
  );
  const state = await loadCloudState();
  assert.equal(state.version, 16, "version must come from inside the envelope");
  assert.deepEqual(state.records.map((r) => r.date), ["2026-09-14"]);
  assert.deepEqual(state.trash.map((r) => r.date), ["2026-09-09"]);
  assert.equal(state.settings.zone, "Cumilla");
});

test("an enveloped 409 still reports the server's version", async () => {
  fakeFetch(() => json(409, { ok: false, error: "version-conflict", message: "stale", state: { version: 16 } }));
  const out = await saveCloudState({ settings: {}, records: [], trash: [] }, { version: 0 });
  assert.equal(out.ok, false);
  assert.equal(out.currentVersion, 16);
});

/* ---------------- real-time channel: watchCloud() ---------------- */

test("watchCloud parks on /api/live with the cursor and the wait in seconds", async () => {
  const calls = fakeFetch(() => new Response(null, { status: 304, headers: { etag: '"9"' } }));
  const out = await watchCloud(9, { waitSeconds: 20 });
  assert.equal(calls[0].url, "/api/live?version=9&wait=20");
  assert.equal(calls[0].init.cache, "no-store");
  assert.deepEqual(out, { kind: "quiet", version: 9 });
});

test("watchCloud decodes a change, a baseline and a reset", async () => {
  fakeFetch(() => json(200, { ok: true, changed: true, version: 12, updatedAt: "2026-09-21T09:00:00.000Z", waitedMs: 4321 }));
  assert.deepEqual(await watchCloud(11), {
    kind: "changed",
    version: 12,
    updatedAt: "2026-09-21T09:00:00.000Z",
    waitedMs: 4321
  });

  fakeFetch(() => json(200, { ok: true, changed: false, baseline: true, version: 12, updatedAt: "2026-09-21T09:00:00.000Z" }));
  assert.deepEqual(await watchCloud(-1), { kind: "baseline", version: 12, updatedAt: "2026-09-21T09:00:00.000Z" });

  /* A cleared cloud reports version 0, which is both "different" and "behind":
     reset must win, or a device would pull an empty state as if it were news. */
  fakeFetch(() => json(200, { ok: true, changed: false, reset: true, version: 0, updatedAt: null }));
  assert.deepEqual(await watchCloud(6), { kind: "reset", version: 0, updatedAt: null });
});

test("a quiet 304 with no ETag keeps the cursor the caller already had", async () => {
  fakeFetch(() => new Response(null, { status: 304 }));
  assert.deepEqual(await watchCloud(4), { kind: "quiet", version: 4 });
});

test("watchCloud throws a CloudApiError the caller can classify", async () => {
  fakeFetch(() => json(404, { ok: false, error: "not-found" }));
  await assert.rejects(() => watchCloud(1), (err) => {
    assert.equal(err instanceof CloudApiError, true);
    assert.equal(err.status, 404);
    assert.equal(isLiveUnavailable(err), true, "an old deploy must be recognised, not retried forever");
    return true;
  });

  fakeFetch(() => json(400, { ok: false, error: "version-required" }));
  await assert.rejects(() => watchCloud(1), (err) => {
    assert.equal(isLiveUnavailable(err), false, "a 400 is our bug, not a missing endpoint");
    return true;
  });
});

test("isAbort separates our own cancel from a real failure", async () => {
  const err = Object.assign(new Error("aborted"), { name: "AbortError" });
  assert.equal(isAbort(err), true);
  assert.equal(isAbort(new Error("network")), false);
});

test("watchCloud forwards the caller's AbortSignal so a hidden tab can drop it", async () => {
  const calls = fakeFetch(() => new Response(null, { status: 304 }));
  const controller = new AbortController();
  await watchCloud(3, { signal: controller.signal });
  assert.equal(calls[0].init.signal, controller.signal);
});
