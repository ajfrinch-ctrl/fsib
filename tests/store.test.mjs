import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_STATE_BYTES,
  applyWrite,
  createSyncHandler,
  emptyState,
  normalizeRecords,
  normalizeSettings,
  normalizeState
} from "../src/lib/store.ts";

function memoryAdapter(initial = null) {
  let value = initial;
  return {
    adapter: {
      async get() {
        return value;
      },
      async set(v) {
        value = v;
      },
      async del() {
        value = null;
      }
    },
    peek: () => value
  };
}

function request(method, body) {
  return new Request("https://example.test/api/sync", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

const day = (date, cash, updated) => ({ date, cash, updated });

test("GET on an empty blob returns the documented empty state", async () => {
  const handler = createSyncHandler(memoryAdapter().adapter);
  const res = await handler(request("GET"));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { settings: {}, records: [], trash: [], version: 0, updatedAt: null });
});

test("POST creates version 1, sorted and stripped of the PIN", async () => {
  const { adapter, peek } = memoryAdapter();
  const handler = createSyncHandler(adapter);
  const res = await handler(
    request("POST", {
      settings: { branch: "Tantar Branch", pin: "1234", theme: "light" },
      records: [day("2026-09-14", "2400000", "2026-09-14T09:00:00.000Z"), day("2026-09-01", "10", "2026-09-01T09:00:00.000Z")],
      trash: [],
      version: 0,
      force: false
    })
  );
  assert.equal(res.status, 201);
  const state = await res.json();
  assert.equal(state.version, 1);
  assert.deepEqual(state.records.map((r) => r.date), ["2026-09-01", "2026-09-14"]);
  assert.equal(state.settings.pin, undefined, "PIN must never reach the blob");
  assert.equal(state.settings.branch, "Tantar Branch");
  assert.equal(peek().settings.pin, undefined);
});

test("a stale version is rejected with 409 and the current version", async () => {
  const { adapter } = memoryAdapter();
  const handler = createSyncHandler(adapter);
  await handler(request("POST", { settings: {}, records: [day("2026-09-01", "1", "2026-09-01T09:00:00.000Z")], trash: [], version: 0 }));
  const res = await handler(
    request("POST", { settings: {}, records: [day("2026-09-02", "2", "2026-09-02T09:00:00.000Z")], trash: [], version: 0 })
  );
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error, "version-conflict");
  assert.equal(body.currentVersion, 1);
  assert.equal(body.providedVersion, 0);
});

test("force: true overwrites a stale version", async () => {
  const { adapter } = memoryAdapter();
  const handler = createSyncHandler(adapter);
  await handler(request("POST", { settings: {}, records: [day("2026-09-01", "1", "2026-09-01T09:00:00.000Z")], trash: [], version: 0 }));
  const res = await handler(
    request("POST", { settings: {}, records: [day("2026-09-09", "9", "2026-09-09T09:00:00.000Z")], trash: [], version: 0, force: true })
  );
  assert.equal(res.status, 201);
  const state = await res.json();
  assert.equal(state.version, 2);
  assert.deepEqual(state.records.map((r) => r.date), ["2026-09-09"]);
});

test("PUT behaves like POST, and DELETE clears the blob", async () => {
  const { adapter } = memoryAdapter();
  const handler = createSyncHandler(adapter);
  await handler(request("POST", { settings: {}, records: [day("2026-09-01", "1", "2026-09-01T09:00:00.000Z")], trash: [], version: 0 }));
  const put = await handler(
    request("PUT", { settings: {}, records: [day("2026-09-01", "5", "2026-09-01T10:00:00.000Z")], trash: [], version: 1 })
  );
  assert.equal(put.status, 200);
  assert.equal((await put.json()).version, 2);

  const del = await handler(request("DELETE"));
  assert.equal(del.status, 200);
  const after = await handler(request("GET"));
  assert.equal((await after.json()).version, 0);
});

test("writes need a version (or force), and only known verbs are allowed", async () => {
  const handler = createSyncHandler(memoryAdapter().adapter);
  const noVersion = await handler(request("POST", { settings: {}, records: [], trash: [] }));
  assert.equal(noVersion.status, 400);
  assert.equal((await noVersion.json()).error, "version-required");

  const patch = await handler(request("PATCH", { version: 0 }));
  assert.equal(patch.status, 405);
  assert.deepEqual((await patch.json()).allowed, ["GET", "POST", "PUT", "DELETE"]);
});

test("a body that is not JSON is a 400, not a 500", async () => {
  const handler = createSyncHandler(memoryAdapter().adapter);
  const res = await handler(
    new Request("https://example.test/api/sync", { method: "POST", body: "{not json", headers: { "content-type": "application/json" } })
  );
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "invalid-json");
});

test("normalizeRecords drops malformed rows and keeps the newest write per date", () => {
  const rows = normalizeRecords([
    { date: "not-a-date", cash: 1 },
    { date: "2026-09-01", cash: "old", updated: "2026-09-01T08:00:00.000Z", injected: "drop me" },
    { date: "2026-09-01", cash: "new", updated: "2026-09-01T09:00:00.000Z" },
    { date: "2026-09-02", visits: [{ type: "School", name: "X" }, "junk"] }
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].cash, "new");
  assert.equal(rows[0].injected, undefined);
  assert.deepEqual(rows[1].visits, [{ type: "School", name: "X" }]);
});

test("normalizeSettings keeps device preferences but never the PIN", () => {
  const out = normalizeSettings({ branch: "Tantar", pin: "9999", theme: "dark", fn: () => 1, undef: undefined });
  assert.deepEqual(out, { branch: "Tantar", theme: "dark" });
});

test("applyWrite refuses a state over the size limit", () => {
  const big = "x".repeat(Math.ceil(MAX_STATE_BYTES / 2));
  const outcome = applyWrite(emptyState(), {
    settings: {},
    records: [day("2026-09-01", big, "2026-09-01T09:00:00.000Z"), day("2026-09-02", big, "2026-09-02T09:00:00.000Z")],
    trash: [],
    version: 0
  });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.status, 413);
    assert.equal(outcome.body.error, "state-too-large");
  }
});

test("normalizeState repairs a corrupt blob instead of throwing", () => {
  const state = normalizeState({ settings: "nope", records: { nope: 1 }, trash: null, version: "12", updatedAt: 5 });
  assert.deepEqual(state, { settings: {}, records: [], trash: [], version: 12, updatedAt: null });
});
