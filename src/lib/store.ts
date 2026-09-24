/* ------------------------------------------------------------------
   FSIB Branch Marketing Report — cloud state core (Netlify Blobs)

   Dependency-free on purpose: the blob adapter is injected, so the exact
   same logic runs inside a Netlify Function, a Nitro server route, the
   local dev server (dev-server.mjs) and the unit tests.

   Blob:  store "fsib-app"  ·  key "state"  ·  consistency "strong"
   HTTP:  GET/POST/PUT/DELETE /api/sync
------------------------------------------------------------------ */

export type SyncRecord = {
  date: string;
  places?: string | number;
  cash?: string | number;
  clearing?: string | number;
  rtgs?: string | number;
  npsb?: string | number;
  agent?: string | number;
  officers?: Array<Record<string, unknown>>;
  visits?: Array<Record<string, unknown>>;
  accounts?: Array<Record<string, unknown>>;
  created?: string;
  updated?: string;
};

export type CloudState = {
  settings: Record<string, unknown>;
  records: SyncRecord[];
  trash: SyncRecord[];
  version: number;
  updatedAt: string | null;
};

export type BlobAdapter = {
  get(): Promise<unknown>;
  set(value: CloudState): Promise<void>;
  del(): Promise<void>;
};

export const STORE_NAME = "fsib-app";
export const BLOB_KEY = "state";

/** Blobs accept large values, but a runaway payload means a runaway bill. */
export const MAX_STATE_BYTES = 5_000_000;

/**
 * Device-only settings. The PIN unlocks one phone; syncing it would copy a
 * 4-digit secret into a blob that every device can read with a plain GET.
 */
export const DEVICE_ONLY_SETTING_KEYS = ["pin"];

/**
 * Switches that used to live in Settings. Sync is always real-time, so these
 * are not settings anymore: every read and write drops them, and an older blob
 * cannot turn a device off.
 */
export const RETIRED_SYNC_SETTING_KEYS = ["autoSync", "realtime"];

const RECORD_FIELDS = [
  "date",
  "places",
  "cash",
  "clearing",
  "rtgs",
  "npsb",
  "agent",
  "officers",
  "visits",
  "accounts",
  "created",
  "updated"
];

const ARRAY_FIELDS = ["officers", "visits", "accounts"];

/**
 * The account number is not collected anymore: the branch reports how many
 * accounts were opened, not which numbers. Like the retired sync switches, it
 * is dropped on every read and write, so an older blob cannot bring it back.
 */
const RETIRED_ACCOUNT_FIELDS = ["no"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ROWS = 20000;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStorable(v: unknown): boolean {
  const t = typeof v;
  return t === "string" || t === "number" || t === "boolean" || t === "object";
}

export function emptyState(): CloudState {
  return { settings: {}, records: [], trash: [], version: 0, updatedAt: null };
}

/** Coerce arbitrary JSON into the documented state shape, dropping anything unknown. */
export function normalizeSettings(input: unknown): Record<string, unknown> {
  if (!isPlainObject(input)) return {};
  const out: Record<string, unknown> = {};
  let count = 0;
  for (const key of Object.keys(input)) {
    if (count >= 64) break;
    if (DEVICE_ONLY_SETTING_KEYS.includes(key) || RETIRED_SYNC_SETTING_KEYS.includes(key)) continue;
    const value = input[key];
    if (value === undefined || !isStorable(value)) continue;
    out[key] = value;
    count++;
  }
  return out;
}

/** Keep only well-formed daily rows, newest wins per date, sorted ascending by date. */
export function normalizeRecords(input: unknown): SyncRecord[] {
  if (!Array.isArray(input)) return [];
  const byDate = new Map<string, SyncRecord>();
  for (const raw of input) {
    if (byDate.size >= MAX_ROWS) break;
    if (!isPlainObject(raw)) continue;
    const date = typeof raw.date === "string" ? raw.date : String(raw.date ?? "");
    if (!DATE_RE.test(date)) continue;
    const row: Record<string, unknown> = { date };
    for (const field of RECORD_FIELDS) {
      if (field === "date") continue;
      const value = raw[field];
      if (value === undefined || value === null) continue;
      if (ARRAY_FIELDS.includes(field)) {
        if (!Array.isArray(value)) continue;
        row[field] = value.filter(isPlainObject).map((item) => {
          const clean: Record<string, unknown> = {};
          for (const k of Object.keys(item)) {
            if (field === "accounts" && RETIRED_ACCOUNT_FIELDS.includes(k)) continue;
            if (isStorable(item[k])) clean[k] = item[k];
          }
          return clean;
        });
        continue;
      }
      if (!isStorable(value) || Array.isArray(value)) continue;
      row[field] = value;
    }
    const prev = byDate.get(date);
    if (prev && String(prev.updated ?? "") > String(row.updated ?? "")) continue;
    byDate.set(date, row as SyncRecord);
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export function normalizeState(input: unknown): CloudState {
  const base = emptyState();
  if (!isPlainObject(input)) return base;
  const version = Number(input.version);
  return {
    settings: normalizeSettings(input.settings),
    records: normalizeRecords(input.records),
    trash: normalizeRecords(input.trash),
    version: Number.isFinite(version) && version > 0 ? Math.floor(version) : 0,
    updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : null
  };
}

export type WriteOutcome =
  | { ok: true; state: CloudState }
  | { ok: false; status: 400 | 409 | 413; body: Record<string, unknown> };

/**
 * Optimistic concurrency, exactly as the API documents it:
 *   { settings, records, trash, version, force }
 * A write carrying a stale `version` is rejected with 409 unless `force` is true.
 * The server — never the client — owns the version increment.
 */
export function applyWrite(current: CloudState, body: unknown, now?: string): WriteOutcome {
  if (!isPlainObject(body)) {
    return { ok: false, status: 400, body: { error: "invalid-body", message: "Expected a JSON object." } };
  }
  const provided = body.version;
  const hasVersion = typeof provided === "number" && Number.isFinite(provided);
  const force = body.force === true;

  if (!hasVersion && !force) {
    return {
      ok: false,
      status: 400,
      body: { error: "version-required", message: "Send the version you loaded, or force: true to overwrite." }
    };
  }
  if (hasVersion && !force && Math.floor(provided as number) !== current.version) {
    return {
      ok: false,
      status: 409,
      body: {
        error: "version-conflict",
        message: "Another device saved first. Reload the cloud state, merge, then retry.",
        currentVersion: current.version,
        providedVersion: Math.floor(provided as number),
        updatedAt: current.updatedAt
      }
    };
  }

  const normalized = normalizeState(body);
  const state: CloudState = {
    settings: normalized.settings,
    records: normalized.records,
    trash: normalized.trash,
    version: current.version + 1,
    updatedAt: now ?? new Date().toISOString()
  };

  const bytes = Buffer.byteLength(JSON.stringify(state), "utf8");
  if (bytes > MAX_STATE_BYTES) {
    return {
      ok: false,
      status: 413,
      body: {
        error: "state-too-large",
        message: `State is ${bytes} bytes; the limit is ${MAX_STATE_BYTES}. Export a backup and prune old records.`,
        bytes,
        limit: MAX_STATE_BYTES
      }
    };
  }
  return { ok: true, state };
}

/* ------------------------------------------------------------------
   CORS — the app shell and the cloud may live on different hosts

   GitHub Pages can serve index.html but it cannot run server code, so an
   install from there has to talk to this API on the Netlify deployment. That
   makes every call cross-origin, including the POST preflight, so both
   endpoints answer OPTIONS and mark their answers readable.

   The API has never had a credential (a public GET/POST is by design — see
   README), so the default is `*`. Set FSIB_ALLOWED_ORIGINS to a comma-separated
   list to restrict it, e.g. "https://ajfrinch-ctrl.github.io,https://fsib.netlify.app".
------------------------------------------------------------------ */

export const ALLOWED_ORIGINS_ENV = "FSIB_ALLOWED_ORIGINS";

/** Configured origins, or ["*"] — read per request so a test can set it. */
export function allowedOrigins(): string[] {
  const raw = typeof process !== "undefined" && process.env ? process.env[ALLOWED_ORIGINS_ENV] : "";
  const list = String(raw || "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  return list.length ? list : ["*"];
}

/** The CORS half of every answer on /api/sync and /api/live. */
export function corsHeaders(req: Request): Record<string, string> {
  const origin = (req.headers.get("origin") || "").replace(/\/+$/, "");
  const allow = allowedOrigins();
  const any = allow.includes("*");
  const headers: Record<string, string> = {
    "access-control-allow-methods": "GET, HEAD, POST, PUT, DELETE, OPTIONS",
    "access-control-allow-headers": "content-type, accept, if-none-match",
    /* The app reads both of these off the response, so they must be exposed. */
    "access-control-expose-headers": "etag, x-live-max-wait-ms",
    "access-control-max-age": "600",
    vary: "origin"
  };
  if (any) headers["access-control-allow-origin"] = "*";
  else if (origin && allow.includes(origin)) headers["access-control-allow-origin"] = origin;
  return headers;
}

/** Mark an existing answer as cross-origin-readable without rebuilding it. */
export function withCors(req: Request, res: Response): Response {
  const headers = new Headers(res.headers);
  const extra = corsHeaders(req);
  Object.keys(extra).forEach((k) => {
    if (!headers.has(k)) headers.set(k, extra[k]);
  });
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers }
  });
}

/** `"12"` — the cloud version as an HTTP validator, so a plain GET on /api/sync
    can be revalidated cheaply and /api/live has a token to compare. */
export function stateEtag(version: number): string {
  return `"${Number(version) || 0}"`;
}

/** The whole /api/sync contract, expressed against an injected blob adapter. */
export function createSyncHandler(adapter: BlobAdapter) {
  const handle = async function handleSyncRequest(req: Request): Promise<Response> {
    const method = (req.method || "GET").toUpperCase();
    try {
      if (method === "GET") {
        const state = normalizeState(await adapter.get());
        const etag = stateEtag(state.version);
        /* Conditional GET: a device that already holds this exact version gets a
           304 with no body, which is all the real-time channel needs to know. */
        const inm = req.headers.get("if-none-match");
        if (inm && inm.split(",").some((tag) => tag.trim().replace(/^W\//i, "") === etag)) {
          return new Response(null, {
            status: 304,
            headers: { etag, "cache-control": "no-store" }
          });
        }
        /* The deployed /api/sync wraps the document in { ok, empty, state }; keep
           that envelope so this Function is a drop-in replacement for it. */
        return jsonResponse(
          200,
          {
            ok: true,
            empty: state.version === 0 && state.records.length === 0 && state.trash.length === 0,
            state
          },
          { etag }
        );
      }

      if (method === "POST" || method === "PUT") {
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return jsonResponse(400, { ok: false, error: "invalid-json", message: "Request body must be JSON." });
        }
        const current = normalizeState(await adapter.get());
        const outcome = applyWrite(current, body);
        if (!outcome.ok) return jsonResponse(outcome.status, { ok: false, ...outcome.body });
        await adapter.set(outcome.state);
        return jsonResponse(method === "POST" ? 201 : 200, { ok: true, state: outcome.state }, { etag: stateEtag(outcome.state.version) });
      }

      if (method === "DELETE") {
        await adapter.del();
        return jsonResponse(200, { ok: true, cleared: true, at: new Date().toISOString() });
      }

      if (method === "OPTIONS") {
        /* Preflight: the browser sends this before a cross-origin POST/GET with
           headers we read (content-type, if-none-match). */
        return new Response(null, {
          status: 204,
          headers: { ...corsHeaders(req), allow: "GET, HEAD, POST, PUT, DELETE, OPTIONS" }
        });
      }

      return jsonResponse(405, {
        ok: false,
        error: "method-not-allowed",
        message: `${method} is not supported on /api/sync.`,
        allowed: ["GET", "POST", "PUT", "DELETE"]
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonResponse(500, { ok: false, error: "internal", message: message.slice(0, 200) });
    }
  };
  /* Every answer — the 304 and the OPTIONS preflight included — is marked
     cross-origin-readable, so a shell served from a static host can use it. */
  return async function handleSyncRequest(req: Request): Promise<Response> {
    return withCors(req, await handle(req));
  };
}
