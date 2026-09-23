/* Integration test: boots the real index.html in jsdom and points its fetch at the
   real /api/sync handler from src/lib/store.ts. No HTTP, no re-implemented logic —
   the app's own syncNow() talks to the same code Netlify runs. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM, VirtualConsole } from "jsdom";
import { createSyncHandler } from "../src/lib/store.ts";

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

function memoryBlob(initial = null) {
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

function fakeIndexedDB(window) {
  const stores = {};
  const mkStore = (name) => {
    stores[name] = stores[name] || new Map();
    const m = stores[name];
    const mkReq = () => ({ result: undefined, onsuccess: null, onerror: null });
    const done = (r, val) => setTimeout(() => { r.result = val; r.onsuccess && r.onsuccess({ target: r }); }, 0);
    return {
      createIndex: () => ({ name: name + "_index" }),
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
          transaction: () => ({ objectStore: mkStore, oncomplete: null, onerror: null, onabort: null }),
          close: () => {}
        };
        req.result = db;
        try {
          req.onupgradeneeded && req.onupgradeneeded({ target: req });
        } catch (e) {
          req.error = e;
          req.onerror && req.onerror({ target: req });
          return;
        }
        req.onsuccess && req.onsuccess({ target: req });
      }, 0);
      return req;
    }
  };
}

function bootApp({ records = [], cloud = null, onFirstPost = null, handler: sharedHandler = null } = {}) {
  const blob = memoryBlob(cloud);
  // pass a shared handler to put two "devices" on the same blob
  const handler = sharedHandler || createSyncHandler(blob.adapter);
  const errors = [];
  const requests = [];
  let raced = false;

  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => {
    const msg = String((e && e.message) || e);
    if (/scrollTo/.test(msg)) return; // jsdom has no layout
    errors.push(msg);
  });
  vc.on("error", (...a) => errors.push(a.join(" ")));

  const dom = new JSDOM(HTML, {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    url: "https://example.test/",
    virtualConsole: vc,
    beforeParse(window) {
      fakeIndexedDB(window);
      window.matchMedia = (q) => ({
        media: q, matches: false, onchange: null,
        addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false
      });
      // jsdom exposes window.crypto as a getter-only property
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

      window.fetch = async (input, init) => {
        const url = typeof input === "string" ? input : (input && input.url) || "";
        if (url.indexOf("/api/sync") === -1) throw new Error("unexpected network call: " + url);
        // the app calls the relative "/api/sync"; Node's Request needs an absolute URL
        const absolute = /^https?:/.test(url) ? url : "https://example.test" + url;
        const req = new Request(absolute, init || {});
        const body = init && typeof init.body === "string" ? JSON.parse(init.body) : null;
        requests.push({ method: req.method, body });

        // Simulate a competing device winning the race before this write lands.
        if (req.method === "POST" && onFirstPost && !raced) {
          raced = true;
          await onFirstPost(handler);
        }
        return await handler(req);
      };
    }
  });

  return { window: dom.window, blob, requests, errors };
}

async function waitUntil(fn, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

const localRecords = (window) => JSON.parse(window.localStorage.getItem("bmr_v1_records") || "[]");

test("first sync uploads the local records and records the cloud version", async () => {
  const { window, blob, errors } = bootApp({
    records: [day("2026-09-01", "5000", "2026-09-01T09:00:00.000Z"), day("2026-09-14", "2400000", "2026-09-14T09:00:00.000Z")]
  });
  assert.ok(await waitUntil(() => typeof window.pendingCount === "function" && window.pendingCount() >= 2), "records were not queued for upload");

  const result = await window.syncNow("manual");
  assert.equal(result.error, undefined, JSON.stringify(result.error && result.error.message));
  assert.equal(result.uploaded, 2);
  assert.equal(result.version, 1);
  assert.equal(window.getCloudVersion(), 1);
  assert.equal(window.localStorage.getItem("bmr_v1_cloud_version"), "1");
  assert.equal(blob.peek().records.length, 2);
  assert.equal(window.pendingCount(), 0);
  assert.deepEqual(errors, []);
});

test("a refresh pulls down another device's day", async () => {
  const cloud = {
    settings: { branch: "Tantar Branch" },
    records: [day("2026-09-12", "77000", "2026-09-12T09:00:00.000Z")],
    trash: [],
    version: 1,
    updatedAt: "2026-09-12T09:00:00.000Z"
  };
  const { window, errors } = bootApp({ cloud });
  assert.ok(await waitUntil(() => typeof window.syncNow === "function"));
  await new Promise((r) => setTimeout(r, 400)); // let the app's local-DB init settle

  const result = await window.syncNow("refresh");
  assert.equal(result.error, undefined, JSON.stringify(result.error && result.error.message));
  assert.equal(window.getCloudVersion(), 1);
  assert.deepEqual(localRecords(window).map((r) => r.date), ["2026-09-12"]);
  assert.deepEqual(errors, []);
});

test("a lost race (409) re-merges and retries without losing either device's day", async () => {
  const cloud = {
    settings: { branch: "Tantar Branch" },
    records: [day("2026-09-10", "1000", "2026-09-10T09:00:00.000Z")],
    trash: [],
    version: 1,
    updatedAt: "2026-09-10T09:00:00.000Z"
  };
  const otherDeviceWrite = (handler) =>
    handler(
      new Request("https://example.test/api/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          settings: { branch: "Tantar Branch" },
          records: [day("2026-09-10", "1000", "2026-09-10T09:00:00.000Z"), day("2026-09-11", "2222", "2026-09-11T09:00:00.000Z")],
          trash: [],
          version: 1,
          force: false
        })
      })
    );

  const { window, blob, requests, errors } = bootApp({
    records: [day("2026-09-10", "1000", "2026-09-10T09:00:00.000Z"), day("2026-09-20", "8888", "2026-09-20T09:00:00.000Z")],
    cloud,
    onFirstPost: otherDeviceWrite
  });
  assert.ok(await waitUntil(() => typeof window.pendingCount === "function" && window.pendingCount() >= 2));

  const result = await window.syncNow("manual");
  assert.equal(result.error, undefined, JSON.stringify(result.error && result.error.message));

  assert.equal(requests.filter((r) => r.method === "POST").length, 2, "expected one rejected write and one retry");
  assert.equal(blob.peek().version, 3);
  assert.equal(window.getCloudVersion(), 3);
  assert.deepEqual(blob.peek().records.map((r) => r.date), ["2026-09-10", "2026-09-11", "2026-09-20"]);
  assert.deepEqual(errors, []);
});

test("the PIN stays on the device and never reaches the blob", async () => {
  const { window, blob, errors } = bootApp({
    records: [day("2026-09-01", "5000", "2026-09-01T09:00:00.000Z")]
  });
  assert.ok(await waitUntil(() => typeof window.setPinValue === "function"));
  window.setPinValue("4321");
  window.queueSettingsChange();
  await waitUntil(() => window.pendingCount() >= 2);

  const result = await window.syncNow("manual");
  assert.equal(result.error, undefined, JSON.stringify(result.error && result.error.message));
  assert.equal(window.getPin(), "4321", "PIN still unlocks this device");
  assert.equal(blob.peek().settings.pin, undefined, "PIN was uploaded");
  assert.equal(JSON.parse(window.localStorage.getItem("bmr_v1_settings") || "{}").pin, undefined);
  assert.deepEqual(errors, []);
});

test("the dashboard renders the synced numbers", async () => {
  const { window, errors } = bootApp({
    records: [day("2026-09-01", "5000", "2026-09-01T09:00:00.000Z"), day("2026-09-14", "2400000", "2026-09-14T09:00:00.000Z")]
  });
  assert.ok(await waitUntil(() => typeof window.renderDashboard === "function"));
  window.renderDashboard();
  const cards = [...window.document.querySelectorAll("#dashboard .metric")].map((c) => c.textContent.replace(/\s+/g, " ").trim());
  assert.equal(cards.length, 6);
  assert.match(cards[3], /24,05,000/, "monthly deposit should total both days");
  assert.deepEqual(errors, []);
});

test("the settings page shows the endpoint instead of the removed key fields", async () => {
  const { window, errors } = bootApp({
    records: [day("2026-09-01", "5000", "2026-09-01T09:00:00.000Z")]
  });
  assert.ok(await waitUntil(() => typeof window.nav === "function"));
  window.nav("settings");
  const panel = window.document.querySelector("#settings");
  const html = panel.innerHTML;
  assert.match(html, /\/api\/sync/, "cloud endpoint should be visible");
  assert.match(html, /Cloud version/, "version cursor should be visible");
  assert.doesNotMatch(html, /sJsonbinKey|sBinId/, "the credential fields are gone");
  assert.equal(typeof window.document.querySelector("#sAutoSync").checked, "boolean");
  assert.equal(window.document.querySelector("#sPublicLink").value, "https://example.test/?view=1");
  assert.deepEqual(errors, []);
});

test("two devices on the same blob converge on the same data", async () => {
  const blob = memoryBlob(null);
  const handler = createSyncHandler(blob.adapter);

  /* Device A: has 1 September, syncs first. */
  const a = bootApp({ records: [day("2026-09-01", "5000", "2026-09-01T09:00:00.000Z")], handler });
  assert.ok(await waitUntil(() => typeof a.window.pendingCount === "function" && a.window.pendingCount() >= 1));
  const resA = await a.window.syncNow("manual");
  assert.equal(resA.error, undefined);
  assert.equal(blob.peek().version, 1);
  assert.deepEqual(blob.peek().records.map((r) => r.date), ["2026-09-01"]);

  /* Device B: fresh phone, its own 20 September, never seen A's data. */
  const b = bootApp({ records: [day("2026-09-20", "8888", "2026-09-20T09:00:00.000Z")], handler });
  assert.ok(await waitUntil(() => typeof b.window.pendingCount === "function" && b.window.pendingCount() >= 1));
  const resB = await b.window.syncNow("manual");
  assert.equal(resB.error, undefined);

  // B's upload merged with A's day instead of overwriting it
  assert.equal(blob.peek().version, 2);
  assert.deepEqual(blob.peek().records.map((r) => r.date), ["2026-09-01", "2026-09-20"]);
  assert.deepEqual(localRecords(b.window).map((r) => r.date), ["2026-09-01", "2026-09-20"], "B now holds both days");

  /* Device A refreshes and picks up B's day. */
  const resA2 = await a.window.syncNow("refresh");
  assert.equal(resA2.error, undefined);
  assert.deepEqual(localRecords(a.window).map((r) => r.date), ["2026-09-01", "2026-09-20"], "A now holds both days");
  assert.equal(a.window.getCloudVersion(), b.window.getCloudVersion());

  /* And both dashboards show the same monthly total. */
  a.window.renderDashboard();
  b.window.renderDashboard();
  const monthlyOf = (w) => [...w.document.querySelectorAll("#dashboard .metric")][3].textContent.replace(/\s+/g, " ").trim();
  assert.equal(monthlyOf(a.window), monthlyOf(b.window));
  assert.match(monthlyOf(a.window), /13,888/);
  assert.deepEqual([...a.errors, ...b.errors], []);
});

test("auto-refresh rules: pull on first open, then only when there is something to send", async () => {
  const blob = memoryBlob({
    settings: {},
    records: [day("2026-09-01", "5000", "2026-09-01T09:00:00.000Z")],
    trash: [],
    version: 1,
    updatedAt: "2026-09-01T09:00:00.000Z"
  });
  const { window } = bootApp({ handler: createSyncHandler(blob.adapter) });
  assert.ok(await waitUntil(() => typeof window.dailyAutoSyncDue === "function"));
  await new Promise((r) => setTimeout(r, 300));

  // A phone that has never reached the cloud treats it as "refresh overdue" (9999 days),
  // so it pulls on first open without the user doing anything.
  assert.equal(window.daysSinceCloudContact() > 3, true, "no cloud contact yet");
  assert.equal(window.dailyAutoSyncDue(), true, "first open should auto-pull");

  const res = await window.syncNow("refresh");
  assert.equal(res.error, undefined);
  assert.deepEqual(localRecords(window).map((r) => r.date), ["2026-09-01"], "pulled the other device's day");

  // Contact is fresh and nothing is pending, so it stays quiet (AUTO_REFRESH_DAYS = 3).
  assert.equal(window.dailyAutoSyncDue(), false, "nothing to do, cloud contact is fresh");

  // A local edit makes an upload due, which also merges the cloud copy on the way up.
  window.queueSettingsChange();
  assert.ok(await waitUntil(() => window.pendingCount() >= 1));
  assert.equal(window.dailyAutoTarget(), "daily-upload");
  assert.equal(window.dailyAutoSyncDue(), true);
});
