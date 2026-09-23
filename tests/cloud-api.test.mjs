import test from "node:test";
import assert from "node:assert/strict";
import {
  DEVICE_ONLY_SETTING_KEYS,
  loadCloudState,
  mergeRecords,
  mergeStates,
  saveCloudState
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
