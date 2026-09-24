/* Integration test: boots the real index.html in jsdom and points its fetch at the
   real /api/sync handler from src/lib/store.ts and the real /api/live long-poll
   handler from src/lib/live.ts. No HTTP, no re-implemented logic — the app's own
   syncNow() and its real-time channel talk to the same code Netlify runs. */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM, VirtualConsole } from "jsdom";
import { createSyncHandler } from "../src/lib/store.ts";
import { createLiveHandler, createLiveHub, withLiveNotify } from "../src/lib/live.ts";

const HTML = readFileSync(new URL("../index.html", import.meta.url), "utf8");

/* Every booted app parks a real-time long-poll and arms backoff timers. Closing
   the jsdom windows at the end of the file drops them, so `node --test` exits
   instead of waiting on an app that is (correctly) still watching the cloud. */
const bootedWindows = [];
after(() => {
  for (const window of bootedWindows) {
    try {
      window.close();
    } catch {
      /* already gone */
    }
  }
});

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

/**
 * A whole fake backend on one in-memory blob: /api/sync for the document and
 * /api/live for the real-time channel, wired through one hub so a write on
 * either path wakes every parked long-poll exactly like dev-server.mjs does.
 */
function makeBackend(cloud = null) {
  const blob = memoryBlob(cloud);
  const hub = createLiveHub();
  const adapter = withLiveNotify(blob.adapter, hub);
  return {
    blob,
    hub,
    handler: createSyncHandler(adapter),
    // short hold so a test never parks a request for the production 20 s
    liveHandler: createLiveHandler(adapter, hub.wait, { defaultWaitMs: 150, maxWaitMs: 400, pollIntervalMs: 20 })
  };
}

function bootApp({
  records = [],
  cloud = null,
  settings: settingsOverride = null,
  meta: metaOverride = null,
  onFirstPost = null,
  handler: sharedHandler = null,
  liveHandler: sharedLiveHandler = null,
  backend = null,
  live = true,
  /* Hold automatic uploads so a test can drive syncNow() itself. Not a setting. */
  holdUpload = false,
  /* Where the app shell is served from (default: a host that has the API). */
  url = "https://example.test/",
  /* Extra localStorage keys to seed before the app boots. */
  storage = null
} = {}) {
  const own = backend || makeBackend(cloud);
  const blob = own.blob;
  // pass shared handlers to put two "devices" on the same blob
  const handler = sharedHandler || own.handler;
  const liveHandler = sharedLiveHandler || (live && !sharedHandler ? own.liveHandler : null);
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
    url,
    virtualConsole: vc,
    beforeParse(window) {
      if (holdUpload) window.__fsibHoldUpload = true;
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
      if (settingsOverride) {
        window.localStorage.setItem(
          "bmr_v1_settings",
          JSON.stringify({ branch: "Tantar Branch", zone: "Cumilla", team: "Team-8", totalBranch: 21, target: 0, ...settingsOverride })
        );
      }
      if (metaOverride) window.localStorage.setItem("bmr_v1_syncMeta", JSON.stringify(metaOverride));
      for (const [key, value] of Object.entries(storage || {})) window.localStorage.setItem(key, value);

      /* Delays stay real, so a test can tell "uploaded by itself in real time"
         from "waiting for the Sync button". The parked long-poll and
         every backoff timer die with the window in after(). */
      window.fetch = async (input, init) => {
        const url = typeof input === "string" ? input : (input && input.url) || "";
        const isLive = url.indexOf("/api/live") !== -1;
        if (!isLive && url.indexOf("/api/sync") === -1) throw new Error("unexpected network call: " + url);
        if (isLive && !liveHandler) {
          // a deploy without /api/live: the app must notice and fall back
          return new Response(JSON.stringify({ ok: false, error: "not-found" }), { status: 404 });
        }
        // the app calls "/api/sync" relative, or an absolute URL when the shell
        // is served from a static host; Node's Request needs it absolute either way
        const absolute = /^https?:/.test(url) ? url : "https://example.test" + url;
        const req = new Request(absolute, init || {});
        const body = init && typeof init.body === "string" ? JSON.parse(init.body) : null;
        requests.push({ method: req.method, body, live: isLive, url });

        // Simulate a competing device winning the race before this write lands.
        if (req.method === "POST" && onFirstPost && !raced) {
          raced = true;
          await onFirstPost(handler);
        }
        return await (isLive ? liveHandler(req) : handler(req));
      };
    }
  });

  bootedWindows.push(dom.window);
  return {
    window: dom.window,
    dom,
    blob,
    requests,
    errors,
    hub: own.hub,
    backend: own,
    liveRequests: () => requests.filter((r) => r.live),
    close: () => {
      try {
        dom.window.close();
      } catch {
        /* already gone */
      }
    }
  };
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

/**
 * Wait until the app has finished its own start-up business: the live channel
 * has baselined (and pulled, if this device had never seen the cloud) and no
 * sync is in flight. Tests that then drive syncNow() by hand need this, because
 * a real-time app is already talking to the cloud before anyone taps anything.
 */
async function appSettled(window, timeoutMs = 8000) {
  if (typeof window.liveInfo !== "function") return false;
  const quiet = () => {
    const info = window.liveInfo();
    const state = info.state;
    const settled = state === "watching" || state === "disabled";
    return settled && !window.eval("_syncInProgress");
  };
  const ok = await waitUntil(quiet, timeoutMs);
  // let any trailing state write land before the test starts asserting
  await new Promise((r) => setTimeout(r, 120));
  return ok;
}

test("first sync uploads the local records and records the cloud version", async () => {
  const { window, blob, errors } = bootApp({
    records: [day("2026-09-01", "5000", "2026-09-01T09:00:00.000Z"), day("2026-09-14", "2400000", "2026-09-14T09:00:00.000Z")],
    holdUpload: true
  });
  assert.ok(await waitUntil(() => typeof window.pendingCount === "function" && window.pendingCount() >= 2), "records were not queued for upload");
  await appSettled(window);

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
    onFirstPost: otherDeviceWrite,
    holdUpload: true
  });
  assert.ok(await waitUntil(() => typeof window.pendingCount === "function" && window.pendingCount() >= 2));
  await appSettled(window);

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
    records: [day("2026-09-01", "5000", "2026-09-01T09:00:00.000Z")],
    holdUpload: true
  });
  assert.ok(await waitUntil(() => typeof window.setPinValue === "function"));
  await appSettled(window);
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
  /* A day that opened accounts, so the deposit column can be checked against the
     money the new accounts brought in as well as the day's own deposit. */
  const withAccounts = {
    ...day("2026-09-16", "100000", "2026-09-16T09:00:00.000Z"),
    accounts: [
      { category: "Savings", no: "9001", amount: "25000" },
      { category: "DPS / Other", no: "9002", amount: "5000" }
    ]
  };
  const { window, errors } = bootApp({
    records: [
      day("2026-09-01", "5000", "2026-09-01T09:00:00.000Z"),
      day("2026-09-14", "2400000", "2026-09-14T09:00:00.000Z"),
      withAccounts
    ]
  });
  assert.ok(await waitUntil(() => typeof window.renderDashboard === "function"));
  window.renderDashboard();
  /* The dashboard is the four periods the branch reads at a glance, each with
     the accounts opened and the deposit collected in it. */
  const periods = [...window.document.querySelectorAll("#dashboard .prow[data-period]")].map((r) => r.dataset.period);
  assert.deepEqual(periods, ["today", "week", "month", "30d"]);
  const cell = (key, cls) => window.document.querySelector(`#dashboard .prow[data-period="${key}"] .${cls}`).textContent.replace(/\s+/g, " ").trim();
  assert.equal(cell("today", "pacct"), "0", "nothing saved today");
  assert.match(cell("today", "pdep"), /৳ 0/, "no deposit today");
  assert.match(cell("month", "pdep"), /25,35,000/, "this month totals every day, new-account deposits included");
  assert.match(cell("30d", "pdep"), /25,35,000/, "the last 30 days include every day");
  assert.equal(cell("month", "pacct"), "2", "the two accounts opened this month are counted");
  assert.deepEqual(errors, []);
});

test("the settings page has no sync section or sync controls", async () => {
  const { window, errors } = bootApp({
    records: [day("2026-09-01", "5000", "2026-09-01T09:00:00.000Z")]
  });
  assert.ok(await waitUntil(() => typeof window.nav === "function"));
  window.nav("settings");
  const panel = window.document.querySelector("#settings");
  const html = panel.innerHTML;
  assert.equal(window.document.querySelector("#sCloudVersion"), null);
  assert.equal(window.document.querySelector("#sAutoSync"), null);
  assert.equal(window.document.querySelector("#sRealtime"), null);
  assert.equal(window.document.querySelector("#saveSyncCode"), null);
  assert.equal(window.document.querySelector("#pushCloud"), null);
  assert.equal(window.document.querySelector("#pullCloud"), null);
  assert.equal(window.document.querySelector("#cloudSyncStatus"), null);
  assert.doesNotMatch(html, /Cloud Sync|Cloud endpoint|Real-time endpoint|Save Sync Settings|Auto-sync|Sync Now|Sync history|sJsonbinKey|sBinId/);
  assert.equal(window.document.querySelector("#sPublicLink").value, "https://example.test/?view=1");
  assert.deepEqual(errors, []);
});

test("there is no sync status button; an online sync paints the top bar green", async () => {
  const { window, errors } = bootApp({ holdUpload: true });
  assert.ok(await waitUntil(() => typeof window.updateSyncUI === "function"));
  assert.equal(window.document.querySelector("#syncBtn"), null);
  assert.doesNotMatch(window.document.body.innerHTML, /class="syncbtn"/);
  await appSettled(window);
  const top = window.document.querySelector("header.top");
  assert.equal(top.classList.contains("online-synced"), true, "online and caught up should be green");
  assert.match(window.document.querySelector("style").textContent, /\.top\.online-synced\{[^}]*#3ee08a/);
  window.eval("_syncStatus='error'");
  window.updateSyncUI();
  assert.equal(top.classList.contains("online-synced"), false, "a failed sync must not keep the green border");
  window.eval("_syncStatus='synced'");
  window.updateSyncUI();
  assert.equal(top.classList.contains("online-synced"), true);
  assert.deepEqual(errors, []);
});

test("two devices on the same blob converge on the same data", async () => {
  const blob = memoryBlob(null);
  const handler = createSyncHandler(blob.adapter);

  /* Device A: has 1 September, syncs first. */
  const a = bootApp({ records: [day("2026-09-01", "5000", "2026-09-01T09:00:00.000Z")], handler, holdUpload: true });
  assert.ok(await waitUntil(() => typeof a.window.pendingCount === "function" && a.window.pendingCount() >= 1));
  await appSettled(a.window);
  const resA = await a.window.syncNow("manual");
  assert.equal(resA.error, undefined);
  assert.equal(blob.peek().version, 1);
  assert.deepEqual(blob.peek().records.map((r) => r.date), ["2026-09-01"]);

  /* Device B: fresh phone, its own 20 September, never seen A's data. */
  const b = bootApp({ records: [day("2026-09-20", "8888", "2026-09-20T09:00:00.000Z")], handler, holdUpload: true });
  assert.ok(await waitUntil(() => typeof b.window.pendingCount === "function" && b.window.pendingCount() >= 1));
  await appSettled(b.window);
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
  const monthlyOf = (w) => w.document.querySelector('#dashboard .prow[data-period="month"] .pdep').textContent.replace(/\s+/g, " ").trim();
  assert.equal(monthlyOf(a.window), monthlyOf(b.window));
  assert.match(monthlyOf(a.window), /13,888/);
  assert.deepEqual([...a.errors, ...b.errors], []);
});

test("a stored auto-sync or real-time switch is ignored, stripped, and never uploaded", async () => {
  const backend = makeBackend({
    settings: { branch: "Tantar Branch", autoSync: false, realtime: false },
    records: [day("2026-09-01", "5000", "2026-09-01T09:00:00.000Z")],
    trash: [],
    version: 1,
    updatedAt: "2026-09-01T09:00:00.000Z"
  });
  const { window, requests } = bootApp({ backend, settings: { realtime: false, autoSync: false } });
  assert.ok(await waitUntil(() => typeof window.queueSettingsChange === "function"));
  await appSettled(window);

  const stored = JSON.parse(window.localStorage.getItem("bmr_v1_settings") || "{}");
  assert.equal(stored.autoSync, undefined, "autoSync must not survive on the device");
  assert.equal(stored.realtime, undefined, "realtime must not survive on the device");
  assert.equal(window.liveInfo().enabled, true, "the channel is not a setting");
  assert.ok(requests.some((r) => r.live), "a stored realtime:false must not stop the live channel");
  assert.match(window.autoSyncStatusText(), /real-time/);
  assert.equal(window.autoSyncStatusText().indexOf("Off"), -1);

  window.setAutoUploadDelay(150);
  const before = requests.filter((r) => r.method === "POST").length;
  window.queueSettingsChange();
  assert.ok(
    await waitUntil(() => requests.filter((r) => r.method === "POST").length > before, 8000),
    "an edit must still upload when an older build had the switches off"
  );
  const posted = requests.filter((r) => r.method === "POST").at(-1);
  assert.equal(posted.body.settings.autoSync, undefined);
  assert.equal(posted.body.settings.realtime, undefined);
  assert.equal(backend.blob.peek().settings.autoSync, undefined, "the blob must not keep the switch");
  assert.equal(backend.blob.peek().settings.realtime, undefined);
});

test("auto sync is unlimited: every edit uploads by itself, with no daily gate", async () => {
  const backend = makeBackend(null);
  const { window, requests } = bootApp({ backend });
  assert.ok(await waitUntil(() => typeof window.liveInfo === "function"));
  await appSettled(window);
  window.setAutoUploadDelay(150);

  assert.equal(window.autoSyncStatusText().indexOf("1/day"), -1, "the old once-a-day copy is gone");

  for (let i = 1; i <= 3; i++) {
    const before = requests.filter((r) => r.method === "POST").length;
    window.queueSettingsChange();
    assert.ok(
      await waitUntil(() => requests.filter((r) => r.method === "POST").length > before, 8000),
      "edit " + i + " never uploaded by itself"
    );
    await appSettled(window);
  }
  assert.ok(requests.filter((r) => r.method === "POST").length >= 3, "three edits, three uploads: nothing was capped after the first");
  assert.equal(window.pendingCount(), 0, "every edit reached the cloud — nothing is stuck");

  // Manual sync stays unlimited and unblocked too.
  const res = await window.syncNow("manual");
  assert.equal(res.error, undefined, JSON.stringify(res.error && res.error.message));
});

test("the live channel carries one device's edit to another with nobody tapping Sync", async () => {
  const backend = makeBackend(null);

  /* Device A: the branch phone that types the report.
     The app is real-time, so it would upload this day by itself within a second
     and a half — which is the behaviour under test further down, not here. Park
     that reflex while the test sets its starting position by hand. */
  const a = bootApp({
    backend,
    records: [day("2026-09-01", "5000", "2026-09-01T09:00:00.000Z")],
    holdUpload: true
  });
  assert.ok(await waitUntil(() => typeof a.window.syncNow === "function"));
  a.window.setAutoUploadDelay(60000);
  assert.ok(await waitUntil(() => a.window.pendingCount() >= 1, 5000), "A's record was not queued for upload");
  await appSettled(a.window);
  const first = await a.window.syncNow("manual");
  assert.equal(first.error, undefined, JSON.stringify(first.error && first.error.message));
  assert.ok(backend.blob.peek(), "nothing was written to the cloud");
  assert.equal(backend.blob.peek().version, 1);

  /* Device B: the manager's phone, opened afterwards, never asked to sync.
     Automatic startup upload is held so the ONLY way this phone can catch up
     is the live channel — which is exactly what is under test. */
  const b = bootApp({ backend, holdUpload: true });
  assert.ok(await waitUntil(() => typeof b.window.liveInfo === "function"));
  assert.ok(
    await waitUntil(() => b.window.liveInfo().state === "watching", 4000),
    "B never parked a long-poll: " + JSON.stringify(b.window.liveInfo())
  );
  // B pulled A's day on the way in, through the live channel's own sync.
  assert.ok(
    await waitUntil(() => localRecords(b.window).some((r) => r.date === "2026-09-01"), 6000),
    "B did not receive the existing cloud day"
  );

  /* A edits. No Sync button is touched on either phone.
     `records` is a script-level binding, so go through the window's own scope. */
  a.window.__fsibHoldUpload = false;
  a.window.setAutoUploadDelay(120); // now let the reflex back in
  const stamp = new Date().toISOString();
  a.window.eval(`(function(){
    const row = ${JSON.stringify(day("2026-09-21", "777000", stamp))};
    records.push(row);
    queueRecordChange(row.date, "CREATE", row);
    save();
  })()`);

  // A uploads on its own debounce, B is woken by the hub and pulls.
  assert.ok(
    await waitUntil(() => (backend.blob.peek().records || []).some((r) => r.date === "2026-09-21"), 15000),
    "A's edit never reached the cloud on its own"
  );
  assert.ok(
    await waitUntil(() => localRecords(b.window).some((r) => r.date === "2026-09-21"), 15000),
    "B did not receive A's edit in real time: " + JSON.stringify(localRecords(b.window).map((r) => r.date))
  );
  assert.ok(b.window.liveInfo().changesApplied >= 1, "the live pull was not counted");
  assert.equal(b.window.getCloudVersion(), backend.blob.peek().version, "B's cursor follows the cloud");

  /* Both dashboards now tell the same story. */
  a.window.renderDashboard();
  b.window.renderDashboard();
  const monthlyOf = (w) => w.document.querySelector('#dashboard .prow[data-period="month"] .pdep').textContent.replace(/\s+/g, " ").trim();
  assert.equal(monthlyOf(a.window), monthlyOf(b.window));
  assert.deepEqual([...a.errors, ...b.errors], []);
});

test("an edit is flushed before the phone goes back in a pocket", async () => {
  /* Background tabs throttle timers, so the 1.5s upload debounce can stretch to
     a minute once the app is hidden. Device A's entry must be in the cloud before
     the officer puts the phone away, or device B shows nothing for minutes. */
  const { window, blob, requests, errors } = bootApp({});
  assert.ok(await waitUntil(() => typeof window.setAutoUploadDelay === "function"));
  await appSettled(window);
  window.setAutoUploadDelay(60000);

  const posts = () => requests.filter((r) => !r.live && r.method === "POST").length;
  const before = posts();
  window.eval(`(function(){
    const row = ${JSON.stringify(day("2026-09-21", "123000", "2026-09-21T09:00:00.000Z"))};
    records.push(row);
    queueRecordChange(row.date, "CREATE", row);
    save();
  })()`);
  assert.equal(posts(), before, "the long debounce already uploaded");

  Object.defineProperty(window.document, "hidden", { configurable: true, get: () => true });
  window.document.dispatchEvent(new window.Event("visibilitychange"));

  assert.ok(await waitUntil(() => posts() > before, 4000), "going hidden did not flush the edit");
  assert.ok(
    await waitUntil(() => (blob.peek().records || []).some((r) => r.date === "2026-09-21"), 4000),
    "the edit never reached the cloud"
  );
  assert.deepEqual(errors, []);
});

test("a shell on GitHub Pages talks to the cloud on Netlify, not to itself", async () => {
  /* GitHub Pages serves static files only: /api/sync there is a 404, so an
     install from that link would save on the phone and nowhere else — the
     "device A saved, device B never shows it" bug. The shell must point its
     API calls at the host that actually runs them. */
  const { window, requests, errors } = bootApp({ url: "https://ajfrinch-ctrl.github.io/fsib/" });
  assert.ok(await waitUntil(() => typeof window.liveInfo === "function"));
  assert.ok(await waitUntil(() => requests.length > 0, 5000), "the app never called the cloud");

  const targets = [...new Set(requests.map((r) => r.url.split("?")[0]))];
  assert.deepEqual(
    targets.sort(),
    ["https://fsib.netlify.app/api/live", "https://fsib.netlify.app/api/sync"],
    "a static-host install must use the Netlify API: " + JSON.stringify(targets)
  );
  assert.deepEqual(errors, []);
});

test("?api=<origin> moves the cloud, and the choice is remembered", async () => {
  const { window, requests } = bootApp({ url: "https://ajfrinch-ctrl.github.io/fsib/?api=https://cloud.example" });
  assert.ok(await waitUntil(() => typeof window.liveInfo === "function"));
  assert.ok(await waitUntil(() => requests.length > 0, 5000));
  for (const r of requests) assert.match(r.url, /^https:\/\/cloud\.example\/api\//);
  assert.equal(window.localStorage.getItem("bmr_v1_apiOrigin"), "https://cloud.example");

  /* And it sticks for the next launch on this device. */
  const second = bootApp({ storage: { bmr_v1_apiOrigin: "https://cloud.example" } });
  assert.ok(await waitUntil(() => typeof second.window.liveInfo === "function"));
  assert.equal(second.window.eval("CLOUD_ORIGIN"), "https://cloud.example");
  assert.deepEqual(second.errors, []);
});

test("the app parks for the hold the server advertises", async () => {
  /* A client cannot guess how long a host will hold a request. The server says so
     in X-Live-Max-Wait-Ms, and the app must ask for no more than that — asking for
     more is the request the platform kills, and a killed hold looks like a dead
     channel. */
  const blob = memoryBlob(null);
  const hub = createLiveHub();
  const adapter = withLiveNotify(blob.adapter, hub);
  const { window, errors } = bootApp({
    handler: createSyncHandler(adapter),
    liveHandler: createLiveHandler(adapter, hub.wait, { defaultWaitMs: 5000, maxWaitMs: 5000, pollIntervalMs: 20 })
  });
  assert.ok(await waitUntil(() => typeof window.liveInfo === "function"));

  assert.ok(
    await waitUntil(() => window.liveInfo().serverMaxWaitMs === 5000, 5000),
    "the advertised ceiling was not read: " + JSON.stringify(window.liveInfo())
  );
  const info = window.liveInfo();
  assert.ok(info.waitMs <= 5000, `asking for ${info.waitMs}ms on a server that holds 5000ms`);
  assert.ok(info.waitMs < 20000, "the app kept asking for the default hold and ignored the server");
  assert.notEqual(info.state, "error");
  assert.deepEqual(errors, []);
});

test("a gateway that kills the long-poll is not treated as a broken channel", async () => {
  /* What a Netlify Function timeout looks like from the browser: the hold dies
     (a 504, or a closed connection) after a few hundred milliseconds. The old
     client called that an error and backed off exponentially, so device B sat
     for two minutes showing data from before A's entry. It must instead learn
     the ceiling, keep the channel green, and re-park immediately. */
  const blob = memoryBlob(null);
  const sync = createSyncHandler(blob.adapter);
  let cuts = 0;
  const liveCuts = (req) => {
    cuts++;
    return new Promise((resolve) => {
      setTimeout(() => resolve(new Response("", { status: 504 })), 250);
    });
  };

  const { window, errors } = bootApp({ handler: sync, liveHandler: liveCuts });
  assert.ok(await waitUntil(() => typeof window.liveInfo === "function"));
  assert.ok(await waitUntil(() => window.liveInfo().holdCuts >= 1, 6000), "the cut was never noticed");
  const info = window.liveInfo();
  assert.notEqual(info.state, "error", "a killed hold must not look like a dead channel");
  assert.equal(info.fails, 0, "fails drove the exponential backoff that hid A's entry");
  assert.ok(info.waitMs < 20000, "the app kept asking for a hold the host cannot give");
  assert.ok(await waitUntil(() => cuts >= 2, 4000), "the app did not re-park after the hold was cut");
  assert.ok(window.liveInfo().waitMs <= 20000);
  assert.deepEqual(errors, []);
});

test("with no live endpoint a safety net still brings the other device's day", async () => {
  /* An older deploy (or a gateway that never lets a long-poll through) must not
     mean "device B never updates". The safety net looks for changes on a timer
     whenever the channel is not parked. */
  const blob = memoryBlob(null);
  const backend = { blob };
  const handler = createSyncHandler(blob.adapter);

  // a cloud with one day already in it
  await handler(new Request("https://example.test/api/sync", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ settings: { branch: "Tantar Branch" }, records: [day("2026-09-01", "5000", "2026-09-01T09:00:00.000Z")], trash: [], version: 0 })
  }));

  const { window, errors } = bootApp({ handler, live: false });
  assert.ok(await waitUntil(() => typeof window.setFallbackPollDelay === "function"));
  assert.ok(await waitUntil(() => window.eval("pendingCount()") === 0, 5000), "the app never settled");
  window.setFallbackPollDelay(250);

  // another device saves a day; nobody can signal this device at all
  const write = await handler(new Request("https://example.test/api/sync", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ settings: { branch: "Tantar Branch" }, records: [day("2026-09-01", "5000", "2026-09-01T09:00:00.000Z"), day("2026-09-19", "640000", "2026-09-19T09:00:00.000Z")], trash: [], version: blob.peek().version })
  }));
  assert.equal(write.status, 201);

  assert.ok(
    await waitUntil(() => localRecords(window).some((r) => r.date === "2026-09-19"), 6000),
    "the safety net never refreshed: " + JSON.stringify(localRecords(window).map((r) => r.date))
  );
  assert.deepEqual(errors, []);
});

test("a server without /api/live: the channel goes quiet, but edits still upload automatically", async () => {
  const blob = memoryBlob(null);
  // shared /api/sync handler and no live handler == an older deploy
  const { window, requests, errors } = bootApp({ handler: createSyncHandler(blob.adapter) });
  assert.ok(await waitUntil(() => typeof window.liveInfo === "function"));
  assert.ok(
    await waitUntil(() => window.liveInfo().supported === false, 4000),
    "the app never noticed the missing endpoint: " + JSON.stringify(window.liveInfo())
  );
  const liveCalls = requests.filter((r) => r.live).length;
  await new Promise((r) => setTimeout(r, 900));
  assert.equal(requests.filter((r) => r.live).length, liveCalls, "it kept hammering a 404 endpoint");

  // The badge must not pretend to be connecting.
  assert.equal(window.liveInfo().state, "disabled");
  assert.match(window.liveStatusText(), /unavailable/i);

  // No channel does not mean no sync: the edit uploads on its own debounce.
  window.setAutoUploadDelay(150);
  const before = requests.filter((r) => !r.live && r.method === "POST").length;
  window.queueSettingsChange();
  assert.ok(
    await waitUntil(() => requests.filter((r) => !r.live && r.method === "POST").length > before, 8000),
    "an edit should still upload by itself with no live endpoint"
  );

  // And the app still works end to end.
  const res = await window.syncNow("manual");
  assert.equal(res.error, undefined, JSON.stringify(res.error && res.error.message));
  assert.deepEqual(errors, []);
});

test("writing the old sync switches back does not turn anything off", async () => {
  const backend = makeBackend(null);
  const { window } = bootApp({ backend });
  assert.ok(await waitUntil(() => typeof window.liveInfo === "function"));
  assert.ok(await waitUntil(() => window.liveInfo().state === "watching", 4000));
  assert.equal(typeof window.setRealtimeEnabled, "undefined", "the settings toggle is gone");

  window.eval("settings.autoSync=false;settings.realtime=false;save();");
  assert.ok(await waitUntil(() => {
    const stored = JSON.parse(window.localStorage.getItem("bmr_v1_settings") || "{}");
    return stored.autoSync === undefined && stored.realtime === undefined;
  }), "save() must strip the retired switches");
  assert.equal(window.liveInfo().enabled, true);
  assert.notEqual(window.liveInfo().state, "disabled");
});
