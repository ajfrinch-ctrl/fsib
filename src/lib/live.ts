/* ------------------------------------------------------------------
   FSIB Branch Marketing Report — real-time channel (/api/live)

   A long-poll "did the cloud move?" endpoint. It never carries the
   document itself: devices already hold the state, they only need to
   know that a *different* device saved.

     GET /api/live?version=12&wait=20
       200 { ok, changed:true,  version, updatedAt, etag, waitedMs }  -> go pull /api/sync
       304 (empty body)                                              -> nothing moved
       200 { ok, changed:false, reset:true }                         -> our cursor is ahead of
                                                                        the cloud (DELETE / a
                                                                        restored backup)
       400 version-required | 405 method-not-allowed | 500 internal

     GET /api/live?version=-1
       200 { ok, changed:false, baseline:true, version }             -> "where is the cloud?"
                                                                        answered at once, no hold

   Why long-poll and not SSE/WebSocket: a Netlify Function is stateless
   and capped at 60 s, so a held GET that returns the instant the blob
   version moves is the shape that survives every host this repo
   deploys to (Netlify Functions, the Nitro server route, dev-server.mjs)
   with no reconnect choreography and no sticky sessions.

   Every answer also carries X-Live-Max-Wait-Ms: the longest hold this
   deployment will actually honour. A client cannot guess it, and a hold
   that outlives the platform's own function timeout is killed as a
   gateway error instead of answered — which a phone can only read as a
   broken channel. (Netlify's default is 10 s per synchronous invocation,
   hence the 8 s hold netlify/functions/live.ts asks for.)

   Cost is bounded twice over: the wait is capped (LIVE_MAX_WAIT_MS),
   and a held request costs one function invocation + one blob read
   per LIVE_POLL_INTERVAL_MS only while nothing has changed.

   Dependency-free on purpose, exactly like store.ts: the blob adapter
   and the "wake me when something changed" signal are both injected.
------------------------------------------------------------------ */

import { corsHeaders, normalizeState, withCors, type BlobAdapter, type CloudState } from "./store.ts";

export type LiveRevision = { version: number; updatedAt: string | null };

export type LiveAdapter = BlobAdapter;

/**
 * Resolves as soon as *this process* learns the state changed, otherwise at
 * `deadlineMs`. `watch()` must never reject — a missed wake-up only means the
 * poll loop below notices the change on its next tick.
 */
export type LiveWait = (deadlineMs: number) => Promise<void>;

export const LIVE_PATH = "/api/live";

/**
 * Advertises the longest this deployment will hold a request, in ms. A client
 * cannot guess the ceiling — a Netlify Function kills a synchronous invocation
 * at its platform timeout (10 s on the default plan), and a killed hold looks
 * like a network failure to the phone, not like "the cloud is quiet". So every
 * answer carries the real clamp and the app parks for exactly that long.
 */
export const LIVE_MAX_WAIT_HEADER = "x-live-max-wait-ms";

/** Longest a single request may be held. Netlify kills a function at 60 s. */
export const LIVE_MAX_WAIT_MS = 55_000;

/** Default hold when the client does not ask for one (?wait is in seconds). */
export const LIVE_DEFAULT_WAIT_MS = 20_000;

/**
 * How often the blob is re-read when nobody can notify us.
 *
 * This is the number that decides what a deployed real-time channel costs.
 * Netlify gives a Function instance no shared memory with the instance that
 * served the write, so a parked request has to look for itself — but every
 * request parked on the same instance shares ONE poller (see trackerFor), so
 * a hold costs ~wait/interval blob reads per instance, not per device.
 */
export const LIVE_POLL_INTERVAL_MS = 750;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function revisionOf(state: CloudState): LiveRevision {
  return { version: state.version, updatedAt: state.updatedAt };
}

export async function currentRevision(adapter: LiveAdapter): Promise<LiveRevision> {
  return revisionOf(normalizeState(await adapter.get()));
}

/** `"12"` — the cheap change token every live response carries. */
export function liveEtag(version: number): string {
  return String(Number(version) || 0);
}

export type LiveOptions = {
  maxWaitMs?: number;
  defaultWaitMs?: number;
  pollIntervalMs?: number;
};

function parseVersion(raw: string | null): number | null {
  if (raw === null || raw === "") return null;
  const n = Number(raw);
  /* Negative on purpose: version=-1 means "baseline me, do not wait". */
  return Number.isFinite(n) ? Math.floor(n) : NaN;
}

/**
 * `wait` is in SECONDS on the wire — the number a human would put in a URL —
 * and is clamped to the platform limit. A junk or missing value falls back to
 * the server default rather than being guessed at.
 */
function parseWaitSeconds(raw: string | null, opts: Required<LiveOptions>): number {
  if (raw === null || raw === "") return opts.defaultWaitMs;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds)) return opts.defaultWaitMs;
  return Math.min(Math.max(0, Math.floor(seconds * 1000)), opts.maxWaitMs);
}

/** Strip an optional W/ prefix and surrounding quotes from If-None-Match. */
function etagFromHeader(value: string | null): string | null {
  if (!value) return null;
  const first = value.split(",")[0].trim();
  return first ? first.replace(/^W\//i, "").replace(/^"|"$/g, "") : null;
}

/**
 * The whole /api/live contract, expressed against an injected blob adapter.
 * Pass `wait` from createLiveHub().wait in a single-process host (dev server,
 * tests) to make wake-ups event-driven; omit it to poll the blob instead.
 */
export function createLiveHandler(adapter: LiveAdapter, wait?: LiveWait, options?: LiveOptions) {
  const opts: Required<LiveOptions> = {
    maxWaitMs: options?.maxWaitMs ?? LIVE_MAX_WAIT_MS,
    defaultWaitMs: options?.defaultWaitMs ?? LIVE_DEFAULT_WAIT_MS,
    pollIntervalMs: options?.pollIntervalMs ?? LIVE_POLL_INTERVAL_MS
  };

  const handle = async function handleLiveRequest(req: Request): Promise<Response> {
    const method = (req.method || "GET").toUpperCase();
    /* Every answer — including a 304 — carries the real hold ceiling. */
    const answer = (status: number, payload: unknown) => jsonResponse(status, payload, opts);
    try {
      if (method === "OPTIONS") {
        /* Cross-origin preflight: the app shell may be served from a static host
           (GitHub Pages) while the cloud lives on the Netlify deployment. */
        return new Response(null, {
          status: 204,
          headers: { ...corsHeaders(req), ...jsonHeaders(opts, undefined), allow: "GET, HEAD, OPTIONS" }
        });
      }
      if (method !== "GET" && method !== "HEAD") {
        return answer(405, {
          ok: false,
          error: "method-not-allowed",
          message: `${method} is not supported on ${LIVE_PATH}. It is a read-only change feed.`,
          allowed: ["GET", "HEAD"]
        });
      }

      const url = new URL(req.url, "http://localhost");
      /* The cursor may arrive as ?version= or as If-None-Match, so an ETag-aware
         proxy/cache can revalidate on our behalf. */
      const provided = parseVersion(url.searchParams.get("version")) ?? parseVersion(etagFromHeader(req.headers.get("if-none-match")));
      if (provided === null || Number.isNaN(provided)) {
        return answer(400, {
          ok: false,
          error: "version-required",
          message: `Send the cloud version you hold, e.g. ${LIVE_PATH}?version=12&wait=20.`
        });
      }

      const revision0 = await currentRevision(adapter);

      /* version=-1 is "I hold nothing, just tell me where the cloud is".
         Answered at once, without holding the request. */
      if (provided < 0) {
        return answer(200, {
          ok: true,
          changed: false,
          baseline: true,
          version: revision0.version,
          updatedAt: revision0.updatedAt,
          etag: liveEtag(revision0.version),
          waitedMs: 0
        });
      }

      const waitMs = parseWaitSeconds(url.searchParams.get("wait"), opts);
      const started = Date.now();
      const deadline = started + waitMs;

      let revision = revision0;

      /* Our cursor is ahead of the cloud: the blob was cleared (DELETE) or an
         older backup was restored. Tell the device to re-baseline, not to spin. */
      if (revision.version < provided) {
        return answer(200, {
          ok: true,
          changed: false,
          reset: true,
          version: revision.version,
          updatedAt: revision.updatedAt,
          etag: liveEtag(revision.version),
          waitedMs: Date.now() - started
        });
      }

      if (revision.version !== provided) {
        return answer(200, {
          ok: true,
          changed: true,
          version: revision.version,
          updatedAt: revision.updatedAt,
          etag: liveEtag(revision.version),
          waitedMs: Date.now() - started
        });
      }

      /* Nothing has moved yet — hold the request until it does or time runs out.
         Both signals are always armed: the hub resolves the instant a write in
         THIS process lands, and the shared poller finds a write made by any other
         instance. A Netlify Function instance has no memory of the instance that
         served the write, so a hub-only hold (the old behaviour) could only ever
         learn about a remote write by timing out. */
      const tracker = trackerFor(adapter, opts.pollIntervalMs);
      const lookup = (deadlineMs: number) => tracker.next(provided, deadlineMs);
      while (Date.now() < deadline) {
        const budget = deadline - Date.now();
        if (budget <= 0) break;
        await (wait ? Promise.race([wait(deadline), lookup(deadline)]) : lookup(deadline));
        revision = await currentRevision(adapter);
        /* Backwards first: a cloud that was cleared (DELETE) or rolled back to an
           older backup is a reset, not a change to pull. Checking `!==` first
           would swallow it, since 0 !== 4 is also true. */
        if (revision.version < provided) {
          return answer(200, {
            ok: true,
            changed: false,
            reset: true,
            version: revision.version,
            updatedAt: revision.updatedAt,
            etag: liveEtag(revision.version),
            waitedMs: Date.now() - started
          });
        }
        if (revision.version !== provided) {
          return answer(200, {
            ok: true,
            changed: true,
            version: revision.version,
            updatedAt: revision.updatedAt,
            etag: liveEtag(revision.version),
            waitedMs: Date.now() - started
          });
        }
      }

      /* Held for the full `wait` and the version never moved. 304 with no body:
         the cheapest possible "still nothing" a device can receive. */
      return new Response(null, { status: 304, headers: jsonHeaders(opts, liveEtag(revision.version)) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return answer(500, { ok: false, error: "internal", message: message.slice(0, 200) });
    }
  };
  /* A shell on another host must be able to read a 200, a 304 and a 400 alike. */
  return async function handleLiveRequest(req: Request): Promise<Response> {
    return withCors(req, await handle(req));
  };
}

/* A long-poll is worthless if anything in the path buffers or caches it, so
   every answer says so explicitly: no-store for caches, no-transform for
   proxies, and X-Accel-Buffering for the nginx-family that honours it. */
const LIVE_HEADERS: Record<string, string> = {
  "cache-control": "no-store, no-transform",
  "x-accel-buffering": "no"
};

function jsonHeaders(opts: { maxWaitMs: number }, etag?: string): HeadersInit {
  const headers: Record<string, string> = {
    ...LIVE_HEADERS,
    [LIVE_MAX_WAIT_HEADER]: String(Math.max(0, Math.round(opts.maxWaitMs)))
  };
  if (etag !== undefined) headers.etag = `"${etag}"`;
  return headers;
}

function jsonResponse(status: number, body: unknown, opts: { maxWaitMs: number }): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...jsonHeaders(opts),
      "content-type": "application/json; charset=utf-8"
    }
  });
}

/* ------------------------------------------------------------------
   One shared poller per adapter

   A serverless host cannot notify a parked request: the instance that
   served the write is not the instance holding the connection. So the
   held requests look for themselves — and they look together. Every
   watcher parked on the same adapter joins one loop that reads the blob
   at most once per LIVE_POLL_INTERVAL_MS and releases whoever it woke.

   The loop stops as soon as nobody is parked, so an idle site costs
   nothing at all.
------------------------------------------------------------------ */

type Tracker = {
  /** Resolves when the cloud version is no longer `since`, or at `deadlineMs`. */
  next(since: number, deadlineMs: number): Promise<void>;
  /** Requests currently waiting on the shared poller. */
  waiting(): number;
};

const trackers = new WeakMap<object, Tracker>();

export function trackerFor(adapter: LiveAdapter, pollIntervalMs: number = LIVE_POLL_INTERVAL_MS): Tracker {
  const existing = trackers.get(adapter);
  if (existing) return existing;

  type Waiter = { since: number; deadline: number; resolve: () => void };
  let waiters: Waiter[] = [];
  let polling: Promise<void> | null = null;

  const release = (w: Waiter) => {
    waiters = waiters.filter((x) => x !== w);
    w.resolve();
  };

  const poll = async () => {
    while (waiters.length) {
      const tick = Math.min(
        pollIntervalMs,
        ...waiters.map((w) => Math.max(0, w.deadline - Date.now()))
      );
      await sleep(tick > 0 ? tick : 0);
      let version = -1;
      try {
        version = (await currentRevision(adapter)).version;
      } catch {
        /* A failed read must not end anybody's hold: they have their own
           deadline, and the caller answers 304 when it runs out. */
      }
      const now = Date.now();
      for (const w of [...waiters]) {
        if (w.deadline <= now || (version >= 0 && version !== w.since)) release(w);
      }
    }
    polling = null;
  };

  const tracker: Tracker = {
    next(since: number, deadlineMs: number) {
      return new Promise<void>((resolve) => {
        const remaining = deadlineMs - Date.now();
        if (remaining <= 0) {
          resolve();
          return;
        }
        waiters.push({ since, deadline: deadlineMs, resolve });
        if (!polling) polling = poll();
      });
    },
    waiting: () => waiters.length
  };

  trackers.set(adapter, tracker);
  return tracker;
}

export type LiveHub = {
  /** Tell every held /api/live request in this process to re-read the blob now. */
  notify(): void;
  /** Resolves on notify() or at deadlineMs, whichever comes first. Never rejects. */
  wait(deadlineMs: number): Promise<void>;
  /** How many requests are parked right now (tests, logs). */
  parked(): number;
};

/**
 * In-process wake-up signal. Netlify runs each invocation in its own instance,
 * so a hub only short-circuits the wait for writes made *by that instance*
 * (or by a dev server / test process). Everywhere else the poll loop in
 * createLiveHandler carries the change — that is the part that works on any host.
 */
export function createLiveHub(): LiveHub {
  let waiters = new Set<() => void>();

  const notify = () => {
    const current = waiters;
    waiters = new Set();
    for (const resolve of current) {
      try {
        resolve();
      } catch {
        /* a parked request that already went away is not an error */
      }
    }
  };

  const wait = (deadlineMs: number) =>
    new Promise<void>((resolve) => {
      const remaining = deadlineMs - Date.now();
      if (remaining <= 0) {
        resolve();
        return;
      }
      let settled = false;
      const timer = setTimeout(done, remaining);
      function done() {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        waiters.delete(done);
        resolve();
      }
      waiters.add(done);
    });

  return { notify, wait, parked: () => waiters.size };
}

/**
 * Wrap a blob adapter so every write wakes this process's parked /api/live
 * requests. /api/sync does not know the live channel exists; the hub lives in
 * the adapter, which both handlers share.
 */
export function withLiveNotify<T extends BlobAdapter>(adapter: T, hub: LiveHub): T {
  return {
    ...adapter,
    async set(value: CloudState) {
      await adapter.set(value);
      hub.notify();
    },
    async del() {
      await adapter.del();
      hub.notify();
    }
  } as T;
}
