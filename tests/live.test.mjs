/* Unit tests for the real-time channel: /api/live long-poll (src/lib/live.ts)
   plus the ETag half of /api/sync that the channel's cursor is based on. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  LIVE_DEFAULT_WAIT_MS,
  LIVE_MAX_WAIT_HEADER,
  LIVE_MAX_WAIT_MS,
  createLiveHandler,
  createLiveHub,
  currentRevision,
  liveEtag,
  revisionOf,
  withLiveNotify
} from "../src/lib/live.ts";
import { createSyncHandler, emptyState, normalizeState } from "../src/lib/store.ts";

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

const day = (date, cash, updated) => ({ date, cash, updated });

const state = (version, records = [], updatedAt = "2026-09-20T09:00:00.000Z") => ({
  settings: { branch: "Tantar Branch" },
  records,
  trash: [],
  version,
  updatedAt
});

function liveRequest(query, headers = {}) {
  return new Request("https://example.test/api/live" + query, { method: "GET", headers });
}

function post(body) {
  return new Request("https://example.test/api/sync", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

/* Short waits everywhere: these tests assert the shape of the contract, not the
   production 20 s hold. */
const fast = { defaultWaitMs: 120, maxWaitMs: 400, pollIntervalMs: 15 };

test("the revision helpers read the cloud version", async () => {
  const { adapter } = memoryAdapter(state(7, [day("2026-09-20", "5000", "2026-09-20T09:00:00.000Z")]));
  assert.deepEqual(revisionOf(normalizeState(await adapter.get())), { version: 7, updatedAt: "2026-09-20T09:00:00.000Z" });
  assert.deepEqual(await currentRevision(adapter), { version: 7, updatedAt: "2026-09-20T09:00:00.000Z" });
  assert.equal(liveEtag(7), "7");
});

test("an empty cloud reports version 0 rather than failing", async () => {
  const { adapter } = memoryAdapter(null);
  assert.deepEqual(await currentRevision(adapter), { version: 0, updatedAt: null });
  const res = await createLiveHandler(adapter, undefined, fast)(liveRequest("?version=0&wait=0"));
  assert.equal(res.status, 304, "nothing has ever been saved, so nothing has changed");
});

test("a stale cursor is answered immediately: the cloud moved", async () => {
  const { adapter } = memoryAdapter(state(5));
  const res = await createLiveHandler(adapter, undefined, fast)(liveRequest("?version=3&wait=20"));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.changed, true);
  assert.equal(body.version, 5);
  assert.equal(body.etag, "5");
  /* A long-poll must never be cached, transformed or buffered by anything in
     the path, or the "instant" answer arrives whenever a proxy feels like it. */
  assert.match(res.headers.get("cache-control"), /no-store/);
  assert.match(res.headers.get("cache-control"), /no-transform/);
  assert.equal(res.headers.get("x-accel-buffering"), "no");
  assert.ok(body.waitedMs < 50, "a stale cursor must not be held");
});

test("an up-to-date cursor is held, then answered 304 with an empty body", async () => {
  const { adapter } = memoryAdapter(state(5));
  const started = Date.now();
  const res = await createLiveHandler(adapter, undefined, fast)(liveRequest("?version=5&wait=0.12"));
  const held = Date.now() - started;
  assert.equal(res.status, 304);
  assert.equal(await res.text(), "", "a quiet channel must cost no bandwidth");
  assert.equal(res.headers.get("etag"), '"5"');
  assert.ok(held >= 100, `should have held the request, held ${held}ms`);
});

test("the wait is clamped so a client cannot park past the platform limit", async () => {
  const { adapter } = memoryAdapter(state(5));
  const handler = createLiveHandler(adapter, undefined, { defaultWaitMs: 60, maxWaitMs: 200, pollIntervalMs: 15 });
  const started = Date.now();
  const res = await handler(liveRequest("?version=5&wait=99999"));
  assert.equal(res.status, 304);
  assert.ok(Date.now() - started < 1500, "a huge wait must be clamped, not honoured");
  assert.ok(LIVE_MAX_WAIT_MS < 60000, "the default cap must stay inside a 60 s function");
  assert.ok(LIVE_DEFAULT_WAIT_MS <= LIVE_MAX_WAIT_MS);
});

test("version=-1 baselines a device that holds nothing, without holding it", async () => {
  const { adapter } = memoryAdapter(state(9));
  const started = Date.now();
  const res = await createLiveHandler(adapter, undefined, fast)(liveRequest("?version=-1&wait=20"));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.baseline, true);
  assert.equal(body.changed, false);
  assert.equal(body.version, 9);
  assert.ok(Date.now() - started < 100, "a baseline request must not be parked");
});

test("a cursor ahead of the cloud is a reset, not an endless change", async () => {
  const { adapter } = memoryAdapter(state(2));
  const res = await createLiveHandler(adapter, undefined, fast)(liveRequest("?version=8&wait=0.1"));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.changed, false);
  assert.equal(body.reset, true);
  assert.equal(body.version, 2);
});

test("a parked request wakes the moment a write lands in the same process", async () => {
  const blob = memoryAdapter(state(1, [day("2026-09-01", "5000", "2026-09-01T09:00:00.000Z")]));
  const hub = createLiveHub();
  const adapter = withLiveNotify(blob.adapter, hub);
  const live = createLiveHandler(adapter, hub.wait, { defaultWaitMs: 5000, maxWaitMs: 5000, pollIntervalMs: 5000 });
  const sync = createSyncHandler(adapter);

  const parked = live(liveRequest("?version=1&wait=5"));
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(hub.parked(), 1, "the request should be parked on the hub");

  // Another device saves through /api/sync while we are holding this one.
  const write = await sync(
    post({
      settings: { branch: "Tantar Branch" },
      records: [day("2026-09-01", "5000", "2026-09-01T09:00:00.000Z"), day("2026-09-21", "9000", "2026-09-21T09:00:00.000Z")],
      trash: [],
      version: 1
    })
  );
  assert.equal(write.status, 201);

  const started = Date.now();
  const res = await parked;
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.changed, true);
  assert.equal(body.version, 2);
  assert.ok(body.waitedMs < 2000, `woken by the write, not by the poll loop (${body.waitedMs}ms)`);
  assert.ok(Date.now() - started < 2000);
  assert.equal(hub.parked(), 0, "the waiter was released");
});

test("without a hub the poll loop still notices a write from elsewhere", async () => {
  const blob = memoryAdapter(state(1));
  const live = createLiveHandler(blob.adapter, undefined, { defaultWaitMs: 2000, maxWaitMs: 2000, pollIntervalMs: 20 });
  const parked = live(liveRequest("?version=1&wait=2"));
  await new Promise((r) => setTimeout(r, 60));
  // A different process/instance writes straight to the blob: nobody can notify us.
  await blob.adapter.set(state(2, [day("2026-09-22", "1200", "2026-09-22T09:00:00.000Z")]));
  const res = await parked;
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.changed, true);
  assert.equal(body.version, 2);
  assert.ok(body.waitedMs < 1000, `the poll loop should catch it quickly (${body.waitedMs}ms)`);
});

test("many parked requests share one poller, so a hold costs one read per tick", async () => {
  let reads = 0;
  const cloud = state(1);
  const adapter = {
    async get() {
      reads++;
      return cloud;
    },
    async set() {},
    async del() {}
  };
  const handler = createLiveHandler(adapter, undefined, { defaultWaitMs: 300, maxWaitMs: 300, pollIntervalMs: 40 });

  /* Six devices, one function instance, nothing changing: without a shared
     poller this is 6 reads per tick, which is what a long-poll fleet turns
     into on a serverless host. */
  const parked = Promise.all(
    Array.from({ length: 6 }, () => handler(liveRequest("?version=1&wait=0.3")))
  );
  const answers = await parked;
  for (const res of answers) assert.equal(res.status, 304);

  const ticks = 300 / 40;
  assert.ok(reads <= ticks * 2 + 8, `expected ~${Math.round(ticks)} shared reads, got ${reads}`);
  assert.ok(reads >= 6, "each request does read the blob at least once");
  assert.ok(reads < 6 * ticks, "the poller was not shared: reads scaled with devices");
});

test("a DELETE wakes parked watchers as a reset", async () => {
  const blob = memoryAdapter(state(4));
  const hub = createLiveHub();
  const adapter = withLiveNotify(blob.adapter, hub);
  const live = createLiveHandler(adapter, hub.wait, { defaultWaitMs: 5000, maxWaitMs: 5000, pollIntervalMs: 5000 });
  const sync = createSyncHandler(adapter);

  const parked = live(liveRequest("?version=4&wait=5"));
  await new Promise((r) => setTimeout(r, 30));
  await sync(new Request("https://example.test/api/sync", { method: "DELETE" }));

  const res = await parked;
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.reset, true);
  assert.equal(body.version, 0);
});

test("the cursor may arrive as If-None-Match, so a revalidating proxy works", async () => {
  const { adapter } = memoryAdapter(state(6));
  const res = await createLiveHandler(adapter, undefined, fast)(liveRequest("?wait=0", { "if-none-match": '"4"' }));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).changed, true);
});

test("a missing or junk cursor is a 400, and only GET/HEAD are allowed", async () => {
  const { adapter } = memoryAdapter(state(1));
  const handler = createLiveHandler(adapter, undefined, fast);

  const missing = await handler(liveRequest(""));
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).error, "version-required");

  const junk = await handler(liveRequest("?version=abc"));
  assert.equal(junk.status, 400);

  const posted = await handler(new Request("https://example.test/api/live", { method: "POST" }));
  assert.equal(posted.status, 405);
  assert.equal((await posted.json()).error, "method-not-allowed");

  const head = await handler(new Request("https://example.test/api/live?version=1&wait=0", { method: "HEAD" }));
  assert.equal(head.status, 304);
});

test("a broken blob answers 500 instead of hanging", async () => {
  const adapter = {
    async get() {
      throw new Error("blob unreachable");
    },
    async set() {},
    async del() {}
  };
  const res = await createLiveHandler(adapter, undefined, fast)(liveRequest("?version=1&wait=1"));
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.error, "internal");
  assert.match(body.message, /blob unreachable/);
});

test("/api/sync exposes the same cursor as an ETag and honours If-None-Match", async () => {
  const { adapter } = memoryAdapter(state(3, [day("2026-09-01", "5000", "2026-09-01T09:00:00.000Z")]));
  const sync = createSyncHandler(adapter);

  const full = await sync(new Request("https://example.test/api/sync"));
  assert.equal(full.status, 200);
  assert.equal(full.headers.get("etag"), '"3"');

  const cached = await sync(new Request("https://example.test/api/sync", { headers: { "if-none-match": '"3"' } }));
  assert.equal(cached.status, 304);
  assert.equal(await cached.text(), "", "a device that is up to date downloads nothing");

  const stale = await sync(new Request("https://example.test/api/sync", { headers: { "if-none-match": '"2"' } }));
  assert.equal(stale.status, 200);

  const written = await sync(
    post({ settings: {}, records: [day("2026-09-02", "7000", "2026-09-02T09:00:00.000Z")], trash: [], version: 3, force: true })
  );
  assert.equal(written.headers.get("etag"), '"4"', "a write hands back the new cursor");
});

test("every answer advertises the longest hold this deployment will honour", async () => {
  const { adapter } = memoryAdapter(state(1));
  const handler = createLiveHandler(adapter, undefined, { defaultWaitMs: 60, maxWaitMs: 30_000, pollIntervalMs: 10 });

  /* A client cannot guess the ceiling, and a hold that outlives the platform's
     own function timeout is killed as a gateway error instead of answered — which
     a phone can only read as a broken channel. So the number travels with the
     answer, including the 304 that ends a quiet hold. */
  const quiet = await handler(liveRequest("?version=1&wait=1"));
  assert.equal(quiet.status, 304);
  assert.equal(quiet.headers.get(LIVE_MAX_WAIT_HEADER), "30000");

  const baseline = await handler(liveRequest("?version=-1"));
  assert.equal(baseline.headers.get(LIVE_MAX_WAIT_HEADER), "30000");

  const changed = await handler(liveRequest("?wait=0", { "if-none-match": '"0"' }));
  assert.equal(changed.headers.get(LIVE_MAX_WAIT_HEADER), "30000");

  const bad = await handler(liveRequest(""));
  assert.equal(bad.status, 400);
  assert.equal(bad.headers.get(LIVE_MAX_WAIT_HEADER), "30000", "even a 400 tells the client the ceiling");

  /* The library default is the Netlify/Nitro 60s function limit, not a guess. */
  const dflt = await createLiveHandler(adapter)(liveRequest("?version=-1"));
  assert.equal(dflt.headers.get(LIVE_MAX_WAIT_HEADER), String(LIVE_MAX_WAIT_MS));
  assert.equal(LIVE_MAX_WAIT_MS, 55_000);
  assert.equal(LIVE_DEFAULT_WAIT_MS, 20_000);
});

test("a write from another instance reaches a parked request even though a hub exists", async () => {
  /* The production shape: Netlify runs each invocation in its own instance, so
     the hub can only wake a request for a write THIS instance served. A hold that
     only listens to the hub would learn about another device's write by timing
     out — which is what made two phones look out of sync. Both signals must be
     armed, and the shared poller is the one that finds the remote write. */
  const blob = memoryAdapter(state(1));
  const hub = createLiveHub();
  const adapter = withLiveNotify(blob.adapter, hub);
  const live = createLiveHandler(adapter, hub.wait, { defaultWaitMs: 3000, maxWaitMs: 3000, pollIntervalMs: 25 });

  const parked = live(liveRequest("?version=1&wait=3"));
  await new Promise((r) => setTimeout(r, 50));
  /* straight to the blob: no notify(), exactly like a write served elsewhere */
  await blob.adapter.set(state(2, [day("2026-09-23", "1500", "2026-09-23T09:00:00.000Z")]));

  const res = await parked;
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.changed, true);
  assert.equal(body.version, 2);
  assert.ok(body.waitedMs < 1000, `the poller should find a remote write quickly (${body.waitedMs}ms)`);
});

test("the long-poll answers a cross-origin preflight and exposes its headers", async () => {
  /* A shell on GitHub Pages parks its long-poll on the Netlify deployment.
     That is a CORS request with a header the app reads (X-Live-Max-Wait-Ms),
     so both the preflight and the exposure have to be right — without them the
     browser hides the answer and the phone behaves like there is no channel. */
  const { adapter } = memoryAdapter(state(1));
  const handler = createLiveHandler(adapter, undefined, fast);

  const preflight = await handler(
    new Request("https://fsib.netlify.app/api/live?version=1", { method: "OPTIONS", headers: { origin: "https://ajfrinch-ctrl.github.io" } })
  );
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
  assert.equal(preflight.headers.get("allow"), "GET, HEAD, OPTIONS");
  assert.equal(preflight.headers.get(LIVE_MAX_WAIT_HEADER), "400", "the ceiling rides along on the preflight too");

  const answer = await handler(liveRequest("?version=1&wait=0.05", { origin: "https://ajfrinch-ctrl.github.io" }));
  assert.equal(answer.status, 304);
  assert.equal(answer.headers.get("access-control-allow-origin"), "*");
  assert.match(answer.headers.get("access-control-expose-headers"), /x-live-max-wait-ms/);

  const change = await handler(liveRequest("?wait=0", { origin: "https://ajfrinch-ctrl.github.io", "if-none-match": '"0"' }));
  assert.equal(change.status, 200);
  assert.equal(change.headers.get("access-control-allow-origin"), "*");
});

test("the live handler never needs a hub and works with the bare blob adapter", async () => {
  const { adapter } = memoryAdapter(emptyState());
  const res = await createLiveHandler(adapter)(liveRequest("?version=0&wait=0.05"));
  assert.equal(res.status, 304);
});

