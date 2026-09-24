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
  live = true
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
      if (settingsOverride) {
        window.localStorage.setItem(
          "bmr_v1_settings",
          JSON.stringify({ branch: "Tantar Branch", zone: "Cumilla", team: "Team-8", totalBranch: 21, target: 0, ...settingsOverride })
        );
      }
      if (metaOverride) window.localStorage.setItem("bmr_v1_syncMeta", JSON.stringify(metaOverride));

      /* Delays stay real, so a test can tell "uploaded by itself in real time"
         from "uploaded by the legacy 45 s debounce". The parked long-poll and
         every backoff timer die with the window in after(). */
      window.fetch = async (input, init) => {
        const url = typeof input === "string" ? input : (input && input.url) || "";
        const isLive = url.indexOf("/api/live") !== -1;
        if (!isLive && url.indexOf("/api/sync") === -1) throw new Error("unexpected network call: " + url);
        if (isLive && !liveHandler) {
          // a deploy without /api/live: the app must notice and fall back
          return new Response(JSON.stringify({ ok: false, error: "not-found" }), { status: 404 });
        }
        // the app calls the relative "/api/sync"; Node's Request needs an absolute URL
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
    settings: { realtime: false }
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
    settings: { realtime: false }
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
    records: [day("2026-09-01", "5000", "2026-09-01T09:00:00.000Z")]
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
  await appSettled(a.window);
  const resA = await a.window.syncNow("manual");
  assert.equal(resA.error, undefined);
  assert.equal(blob.peek().version, 1);
  assert.deepEqual(blob.peek().records.map((r) => r.date), ["2026-09-01"]);

  /* Device B: fresh phone, its own 20 September, never seen A's data. */
  const b = bootApp({ records: [day("2026-09-20", "8888", "2026-09-20T09:00:00.000Z")], handler });
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
  const monthlyOf = (w) => [...w.document.querySelectorAll("#dashboard .metric")][3].textContent.replace(/\s+/g, " ").trim();
  assert.equal(monthlyOf(a.window), monthlyOf(b.window));
  assert.match(monthlyOf(a.window), /13,888/);
  assert.deepEqual([...a.errors, ...b.errors], []);
});

test("real-time off: the old scheduled rules still hold (pull on first open, then only when there is work)", async () => {
  const blob = memoryBlob({
    settings: {},
    records: [day("2026-09-01", "5000", "2026-09-01T09:00:00.000Z")],
    trash: [],
    version: 1,
    updatedAt: "2026-09-01T09:00:00.000Z"
  });
  // realtime:false = a device that switched the live channel off in Settings
  const { window, requests } = bootApp({ handler: createSyncHandler(blob.adapter), settings: { realtime: false } });
  assert.ok(await waitUntil(() => typeof window.dailyAutoSyncDue === "function"));
  await new Promise((r) => setTimeout(r, 300));

  // A phone that has never reached the cloud treats it as "refresh overdue" (9999 days),
  // so it pulls on first open without the user doing anything.
  assert.equal(window.daysSinceCloudContact() > 3, true, "no cloud contact yet");
  assert.equal(window.dailyAutoSyncDue(), true, "first open should auto-pull");
  assert.equal(window.liveInfo().enabled, false, "the channel is switched off on this device");

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
  assert.equal(requests.filter((r) => r.live).length, 0, "no /api/live traffic while real-time is off");
});

test("real-time on: the once-a-day gate stands down while the live channel has budget", async () => {
  const backend = makeBackend({
    settings: {},
    records: [day("2026-09-01", "5000", "2026-09-01T09:00:00.000Z")],
    trash: [],
    version: 1,
    updatedAt: "2026-09-01T09:00:00.000Z"
  });
  const { window } = bootApp({ backend });
  assert.ok(await waitUntil(() => typeof window.liveInfo === "function"));
  await new Promise((r) => setTimeout(r, 300));

  assert.equal(window.liveInfo().enabled, true);
  assert.equal(window.realtimeUploadAllowed(), true, "a fresh device has its whole budget");
  // The scheduled sync must not race the live channel for the same edit.
  assert.equal(window.dailyAutoSyncDue(), false, "real-time owns uploads while it has budget");

  window.queueSettingsChange();
  assert.ok(await waitUntil(() => window.pendingCount() >= 1));
  assert.equal(window.dailyAutoSyncDue(), false, "still real-time's job, not the daily gate's");
  assert.match(window.autoSyncStatusText(), /real-time/, "the settings copy says real-time");
});

test("the live channel carries one device's edit to another with nobody tapping Sync", async () => {
  const backend = makeBackend(null);

  /* Device A: the branch phone that types the report.
     The app is real-time, so it would upload this day by itself within a second
     and a half — which is the behaviour under test further down, not here. Park
     that reflex while the test sets its starting position by hand. */
  const a = bootApp({
    backend,
    records: [day("2026-09-01", "5000", "2026-09-01T09:00:00.000Z")]
  });
  assert.ok(await waitUntil(() => typeof a.window.syncNow === "function"));
  a.window.setAutoUploadDelay(60000);
  assert.ok(await waitUntil(() => a.window.pendingCount() >= 1, 5000), "A's record was not queued for upload");
  await appSettled(a.window);
  const first = await a.window.syncNow("manual");
  assert.equal(first.error, undefined, JSON.stringify(first.error && first.error.message));
  assert.ok(backend.blob.peek(), "nothing was written to the cloud");
  assert.equal(backend.blob.peek().version, 1);

  /* Device B: the manager's phone, opened afterwards, never asked to sync. */
  const b = bootApp({ backend });
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
  const monthlyOf = (w) => [...w.document.querySelectorAll("#dashboard .metric")][3].textContent.replace(/\s+/g, " ").trim();
  assert.equal(monthlyOf(a.window), monthlyOf(b.window));
  assert.deepEqual([...a.errors, ...b.errors], []);
});

test("the real-time budget is the safety net: uploads stop, the live channel does not", async () => {
  const backend = makeBackend(null);
  const { window, requests } = bootApp({ backend, settings: { branch: "Tantar Branch" } });
  assert.ok(await waitUntil(() => typeof window.realtimeLeftToday === "function"));
  await appSettled(window);
  const posts = () => requests.filter((r) => r.method === "POST").length;

  // While there is budget, an edit uploads on its own and does NOT spend the
  // once-a-day slot — that slot is the fallback's, not real-time's.
  assert.equal(window.realtimeUploadAllowed(), true);
  const baselinePosts = posts();
  const baselineUsed = window.realtimeUsedToday();
  window.queueSettingsChange();
  assert.ok(await waitUntil(() => posts() > baselinePosts, 8000), "the edit never uploaded by itself");
  assert.equal(window.realtimeUsedToday(), baselineUsed + 1, "the write was charged to the real-time budget");
  assert.equal(window.syncDayUsedToday(), false, "a real-time upload must not spend the daily slot");

  // Now spend the rest of the budget: a runaway queue must not write forever.
  window.setRealtimeMaxPerDay(window.realtimeUsedToday());
  assert.equal(window.realtimeLeftToday(), 0, "budget spent");
  assert.equal(window.realtimeUploadAllowed(), false);
  await appSettled(window);
  const capped = posts();
  const skipped = await window.syncNow("realtime-upload");
  assert.equal(skipped.skipped, "realtime-budget");
  assert.equal(posts(), capped, "a real-time upload happened while the budget was spent");

  // The scheduled once-a-day sync takes over: exactly one more automatic write.
  window.setLegacySyncDelay(150);
  const before = posts();
  window.queueSettingsChange();
  assert.equal(window.dailyAutoSyncDue(), true, "the fallback should be armed for the queued edit");
  assert.ok(await waitUntil(() => posts() > before, 8000), "the scheduled fallback never ran");
  assert.equal(window.syncDayUsedToday(), true, "the fallback spends the day's single scheduled sync");
  assert.equal(window.dailyAutoSyncDue(), false, "and then stays quiet until tomorrow");

  // Nothing automatic happens any more today, however much is edited.
  // (The edit is queued first and only then given time, so the assertion is
  // about the cap rather than about winning a race with the fallback timer.)
  window.setLegacySyncDelay(60000);
  window.queueSettingsChange();
  assert.ok(window.pendingCount() >= 1, "the capped edit stays queued on the device, not lost");
  const settled = posts();
  await new Promise((r) => setTimeout(r, 900));
  assert.equal(posts(), settled, "more than the one scheduled sync got through the cap");

  // A manual sync is the user's own decision: never budgeted, never blocked.
  const manual = await window.syncNow("manual");
  assert.equal(manual.error, undefined, JSON.stringify(manual.error && manual.error.message));
  assert.equal(window.pendingCount(), 0, "manual sync sent it");

  // Downloads keep flowing: the channel is a parked request, not a write.
  assert.ok(requests.filter((r) => r.live).length > 0, "the live channel stopped with the budget");
  assert.equal(window.liveInfo().supported, true);
});

test("a server without /api/live degrades to the scheduled sync instead of retrying forever", async () => {
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
  assert.equal(window.realtimeUploadAllowed(), false, "no channel means no real-time uploads");

  // The scheduled sync takes over the moment the app learns there is no channel:
  // a fresh device's first-open pull has usually already spent today's slot, so
  // release it here and check that a queued edit goes up on the legacy path.
  assert.equal(window.dailyAutoTarget() !== "" || window.syncDayUsedToday(), true, "no fallback armed");
  window.releaseSyncDay();
  window.setLegacySyncDelay(150);
  const before = requests.filter((r) => !r.live && r.method === "POST").length;
  window.queueSettingsChange();
  assert.ok(
    await waitUntil(() => requests.filter((r) => !r.live && r.method === "POST").length > before, 8000),
    "the scheduled sync never took over"
  );
  assert.equal(window.syncDayUsedToday(), true, "the fallback spends the day's single scheduled sync");

  // The app still works end to end.
  const res = await window.syncNow("manual");
  assert.equal(res.error, undefined);
  assert.deepEqual(errors, []);
});

test("switching real-time off drops the parked request and re-arms the scheduled sync", async () => {
  const backend = makeBackend(null);
  const { window } = bootApp({ backend });
  assert.ok(await waitUntil(() => typeof window.liveInfo === "function"));
  assert.ok(await waitUntil(() => window.liveInfo().state === "watching", 4000));

  // What the Settings toggle does.
  window.setRealtimeEnabled(false);
  assert.equal(window.liveInfo().enabled, false);
  assert.equal(window.liveInfo().state, "disabled");
  assert.equal(JSON.parse(window.localStorage.getItem("bmr_v1_settings")).realtime, false, "the choice is per device");

  // Back on again, without a reload.
  window.setRealtimeEnabled(true);
  assert.equal(window.liveInfo().enabled, true);
  assert.ok(
    await waitUntil(() => window.liveInfo().state === "watching", 4000),
    "the channel did not reopen: " + JSON.stringify(window.liveInfo())
  );
});
