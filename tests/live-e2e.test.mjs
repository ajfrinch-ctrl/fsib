/* End-to-end real-time test over actual HTTP.

   Everything else in this suite hands the app a handler function in place of a
   network. This one spawns the real dev-server.mjs on a free port and boots two
   real jsdom devices against it, so the parts that only exist in production are
   covered too: URL building, the parked socket, AbortSignal, the 304 with an
   empty body, and the server's own wait clamp.

   It is the test that answers "does another branch phone actually see my edit
   without anyone tapping Sync?" — and how long that takes. */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { JSDOM, VirtualConsole } from "jsdom";

const ROOT = new URL("..", import.meta.url).pathname;
const HTML = readFileSync(new URL("../index.html", import.meta.url), "utf8");

const day = (date, cash, updated) => ({
  date,
  places: "2",
  cash,
  clearing: "",
  rtgs: "",
  npsb: "",
  agent: "",
  officers: [],
  visits: [],
  accounts: [],
  created: updated,
  updated
});

let server = null;
let dir = "";
let stateFile = "";
let BASE = "";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, ms, label) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (fn()) return Date.now() - started;
    await sleep(50);
  }
  throw new Error(`timed out after ${ms}ms waiting for ${label}`);
}

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "fsib-live-"));
  stateFile = path.join(dir, "state.json");
  // a cloud that already holds one day, written by some third device
  await writeFile(
    stateFile,
    JSON.stringify({
      settings: { branch: "Tantar Branch", zone: "Cumilla" },
      records: [day("2026-09-01", "5000", "2026-09-01T09:00:00.000Z")],
      trash: [],
      version: 1,
      updatedAt: "2026-09-01T09:00:00.000Z"
    }),
    "utf8"
  );

  server = spawn(process.execPath, ["dev-server.mjs"], {
    cwd: ROOT,
    env: { ...process.env, PORT: "0", HOST: "127.0.0.1", STATE_FILE: stateFile },
    stdio: ["ignore", "pipe", "pipe"]
  });

  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("dev server did not start")), 20000);
    let buffer = "";
    const onData = (chunk) => {
      buffer += String(chunk);
      const match = buffer.match(/http:\/\/[^:]+:(\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    };
    server.stdout.on("data", onData);
    server.stderr.on("data", onData);
    server.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`dev server exited early (code ${code}): ${buffer.slice(0, 400)}`));
    });
  });
  BASE = `http://127.0.0.1:${port}`;
});

after(async () => {
  if (server && server.exitCode === null) server.kill("SIGKILL");
  await rm(dir, { recursive: true, force: true });
});

/* ---------- a real device, on real sockets ---------- */

function fakeIndexedDB(window) {
  const stores = {};
  const mkStore = (name) => {
    stores[name] = stores[name] || new Map();
    const m = stores[name];
    const mkReq = () => ({ result: undefined, onsuccess: null, onerror: null });
    const done = (r, val) => setTimeout(() => { r.result = val; r.onsuccess && r.onsuccess({ target: r }); }, 0);
    return {
      createIndex: () => ({}),
      get: (k) => { const r = mkReq(); done(r, m.has(k) ? { key: k, value: m.get(k) } : undefined); return r; },
      put: (v) => { const key = v && v.key !== undefined ? v.key : v; const r = mkReq(); done(r, key); m.set(key, v && v.value !== undefined ? v.value : v); return r; },
      add: (v) => { const key = v && v.id !== undefined ? v.id : m.size + 1; const r = mkReq(); done(r, key); m.set(key, v); return r; },
      getAll: () => { const r = mkReq(); done(r, [...m.values()]); return r; },
      delete: (k) => { const r = mkReq(); done(r, undefined); m.delete(k); return r; },
      clear: () => { const r = mkReq(); done(r, undefined); m.clear(); return r; }
    };
  };
  window.indexedDB = {
    open: () => {
      const created = new Set(Object.keys(stores));
      const req = { onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null, result: null, error: null };
      setTimeout(() => {
        const db = {
          objectStoreNames: { contains: (n) => created.has(n) },
          createObjectStore: (n) => { created.add(n); return mkStore(n); },
          transaction: () => ({ objectStore: mkStore }),
          close: () => {}
        };
        req.result = db;
        try { req.onupgradeneeded && req.onupgradeneeded({ target: req }); } catch (e) { req.error = e; req.onerror && req.onerror({ target: req }); return; }
        req.onsuccess && req.onsuccess({ target: req });
      }, 0);
      return req;
    }
  };
}

const booted = [];

function bootDevice({ records = [], meta = null, label = "device", query = "" }) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => {
    const msg = String((e && e.message) || e);
    if (/scrollTo/.test(msg)) return;
    errors.push(msg);
  });
  vc.on("error", (...a) => errors.push(a.join(" ")));

  const dom = new JSDOM(HTML, {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    url: BASE + "/" + query,
    virtualConsole: vc,
    beforeParse(window) {
      fakeIndexedDB(window);
      window.matchMedia = (q) => ({ media: q, matches: false, add() {}, addListener() {}, removeListener() {}, addEventListener() {}, dispatchEvent: () => false });
      if (!window.crypto || typeof window.crypto.getRandomValues !== "function") {
        Object.defineProperty(window, "crypto", {
          configurable: true,
          value: { getRandomValues: (a) => { for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256); return a; } }
        });
      }
      window.navigator.serviceWorker = { register: () => Promise.resolve({}), ready: new Promise(() => {}), controller: null, addEventListener() {} };
      window.confirm = () => true;
      window.alert = () => {};
      window.prompt = () => null;
      if (records.length) window.localStorage.setItem("bmr_v1_records", JSON.stringify(records));
      if (meta) window.localStorage.setItem("bmr_v1_syncMeta", JSON.stringify(meta));
      /* jsdom has no fetch of its own; Node's is the real thing, so the only
         change is making the app's relative URLs absolute. */
      window.AbortController = AbortController;
      window.fetch = (input, init) => {
        const url = typeof input === "string" ? input : (input && input.url) || "";
        return fetch(/^https?:/.test(url) ? url : BASE + url, init);
      };
    }
  });

  booted.push(dom.window);
  return { window: dom.window, errors };
}

after(() => {
  for (const window of booted) {
    try {
      window.close();
    } catch {
      /* already gone */
    }
  }
});

const localDates = (window) => JSON.parse(window.localStorage.getItem("bmr_v1_records") || "[]").map((r) => r.date);

/* Pretend this device synced a moment ago, so the test measures "another device
   edited" rather than "this device caught up on history". */
async function settledOnCloud(window, label) {
  await until(() => typeof window.liveInfo === "function", 15000, `${label} boot`);
  const res = await window.syncNow("manual");
  assert.equal(res.error, undefined, `${label} sync failed: ${JSON.stringify(res.error && res.error.message)}`);
  const hash = window.computeLocalHash();
  window.eval(`_meta.lastCloudHash=${JSON.stringify(hash)}`);
  await until(() => window.liveInfo().state === "watching", 15000, `${label} to park a long-poll`);
  return window.liveInfo();
}

test("the real-time channel works over HTTP: /api/live answers a parked request", async () => {
  // baseline
  const base = await (await fetch(`${BASE}/api/live?version=-1`)).json();
  assert.equal(base.baseline, true);
  assert.equal(base.version, 1);

  // a quiet hold: 304, empty body, and it really did wait
  const started = Date.now();
  const quiet = await fetch(`${BASE}/api/live?version=1&wait=2`);
  const held = Date.now() - started;
  assert.equal(quiet.status, 304);
  assert.equal(await quiet.text(), "");
  assert.equal(quiet.headers.get("etag"), '"1"');
  assert.ok(held >= 1800, `should have held ~2s, held ${held}ms`);

  // a write wakes a parked watcher
  const parked = fetch(`${BASE}/api/live?version=1&wait=25`).then(async (res) => ({ res, at: Date.now() }));
  await sleep(400);
  const write = await fetch(`${BASE}/api/sync`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      settings: { branch: "Tantar Branch", zone: "Cumilla" },
      records: [day("2026-09-01", "5000", "2026-09-01T09:00:00.000Z"), day("2026-09-02", "6000", "2026-09-02T09:00:00.000Z")],
      trash: [],
      version: 1
    })
  });
  assert.equal(write.status, 201);
  const { res, at } = await parked;
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.changed, true);
  assert.equal(body.version, 2);
  assert.ok(body.waitedMs < 5000, `woken by the write, not by a timeout (${body.waitedMs}ms)`);
  assert.ok(at - started > 0);
});

test("two devices converge in real time with nobody tapping Sync", async (t) => {
  const a = bootDevice({ label: "A", records: [day("2026-09-10", "1000", "2026-09-10T09:00:00.000Z")] });
  const b = bootDevice({ label: "B", records: [] });

  await settledOnCloud(a.window, "A");
  await settledOnCloud(b.window, "B");

  // B is a fresh phone: the channel's baseline must have handed it the cloud copy.
  assert.ok(localDates(b.window).includes("2026-09-01"), "B never received the branch's existing day");
  assert.equal(b.window.liveInfo().supported, true);
  assert.deepEqual(a.errors, []);
  assert.deepEqual(b.errors, []);

  /* A types a report. No Sync button is touched on either device. */
  a.window.setAutoUploadDelay(200);
  const stamp = new Date().toISOString();
  a.window.eval(`(function(){
    const row = ${JSON.stringify(day("2026-09-24", "2400000", stamp))};
    records.push(row);
    queueRecordChange(row.date, "CREATE", row);
    save();
  })()`);

  const latency = await until(() => localDates(b.window).includes("2026-09-24"), 20000, "B to receive A's edit");
  t.diagnostic(`B saw A's edit ${latency}ms after the keystroke`);
  assert.ok(latency < 15000, `real-time means seconds, took ${latency}ms`);
  assert.ok(b.window.liveInfo().changesApplied >= 1, "the live pull was not counted");
  assert.equal(b.window.getCloudVersion(), a.window.getCloudVersion(), "both cursors follow the cloud");

  // And the other direction, so neither device is special.
  b.window.setAutoUploadDelay(200);
  const stamp2 = new Date().toISOString();
  b.window.eval(`(function(){
    const row = ${JSON.stringify(day("2026-09-25", "777000", stamp2))};
    records.push(row);
    queueRecordChange(row.date, "CREATE", row);
    save();
  })()`);
  const back = await until(() => localDates(a.window).includes("2026-09-25"), 20000, "A to receive B's edit");
  t.diagnostic(`A saw B's edit ${back}ms after the keystroke`);

  /* Both dashboards now tell the same story, and the cloud holds every day. */
  a.window.renderDashboard();
  b.window.renderDashboard();
  const monthly = (w) => w.document.querySelector('#dashboard .prow[data-period="month"] .pdep').textContent.replace(/\s+/g, " ").trim();
  assert.equal(monthly(a.window), monthly(b.window));

  const cloud = await (await fetch(`${BASE}/api/sync`)).json();
  const dates = cloud.state.records.map((r) => r.date);
  for (const expected of ["2026-09-01", "2026-09-02", "2026-09-10", "2026-09-24", "2026-09-25"]) {
    assert.ok(dates.includes(expected), `the cloud lost ${expected}: ${dates.join(",")}`);
  }
  assert.deepEqual(a.errors, []);
  assert.deepEqual(b.errors, []);
});

test("the public read-only view follows the cloud live", async () => {
  // ?view=1 is the share link: read-only, no PIN, no queue, no writes.
  const viewer = bootDevice({ label: "viewer", records: [], query: "?view=1" });
  await until(() => typeof viewer.window.loadPublicView === "function", 15000, "viewer boot");
  assert.equal(viewer.window.eval("isPublicView()"), true);
  await until(() => viewer.window.eval("records.length") >= 1, 20000, "the public view to load the cloud report");
  await until(() => viewer.window.liveInfo().state === "watching", 15000, "the public view to park a long-poll");

  // Another device saves; the wall screen must follow without a refresh.
  const cloud = await (await fetch(`${BASE}/api/sync`)).json();
  const version = cloud.state.version;
  const res = await fetch(`${BASE}/api/sync`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      settings: cloud.state.settings,
      records: [...cloud.state.records, day("2026-09-26", "313000", new Date().toISOString())],
      trash: cloud.state.trash,
      version
    })
  });
  assert.equal(res.status, 201);

  await until(() => viewer.window.eval("records.some(r=>r.date==='2026-09-26')"), 20000, "the public view to refresh");
  // A read-only viewer must never write.
  assert.equal(viewer.window.pendingCount(), 0);
  assert.deepEqual(viewer.errors, []);
});
