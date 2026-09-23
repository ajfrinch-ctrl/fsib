/* ------------------------------------------------------------------
   FSIB Branch Marketing Report — browser client for /api/sync

   Canonical typed client for the Netlify Blobs API. index.html is a
   no-build PWA shell, so it carries an inline mirror of this transport
   (search index.html for "Mirrors src/lib/cloud-api.ts"); keep the two
   in step. This module is what the tests exercise, and what a bundled
   build would import.

   Contract (server: server/routes/api/sync.ts + src/lib/store.ts):
     GET    /api/sync  -> { settings, records, trash, version, updatedAt }
     POST   /api/sync  -> same shape, body { settings, records, trash, version, force }
     PUT    /api/sync  -> same as POST
     DELETE /api/sync  -> { ok: true, cleared: true }
------------------------------------------------------------------ */

import type { CloudState, SyncRecord } from "./store.ts";

export type { CloudState, SyncRecord };

export const DEFAULT_API_PATH = "/api/sync";
export const CLOUD_VERSION_KEY = "bmr_v1_cloud_version";
export const PIN_KEY = "bmr_v1_pin";

/** Never uploaded: the PIN is per-device (localStorage key bmr_v1_pin). */
export const DEVICE_ONLY_SETTING_KEYS = ["pin"];

/** Per-device preferences that a cloud download must not stomp. */
export const DEVICE_PREFERENCE_KEYS = ["theme", "autoLock", "lastBackup", "lastSync", "autoSync", "settingsUpdatedAt"];

/** Shared across devices; these are what a cloud download is allowed to change. */
export const SHARED_SETTING_KEYS = [
  "branch",
  "zone",
  "team",
  "totalBranch",
  "manager",
  "managerDesignation",
  "target",
  "weeklyStart",
  "weeklyEnd",
  "template"
];

export type SaveOutcome =
  | { ok: true; status: number; state: CloudState }
  | { ok: false; status: number; error: string; message: string; currentVersion?: number };

export class CloudApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "CloudApiError";
    this.status = status;
  }
}

function stripDeviceOnly(settings: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(settings || {})) {
    if (DEVICE_ONLY_SETTING_KEYS.includes(key)) continue;
    out[key] = settings[key];
  }
  return out;
}

/** GET the full state. A 404 means "nothing saved yet", which is an empty state. */
export async function loadCloudState(api: string = DEFAULT_API_PATH): Promise<CloudState> {
  const res = await fetch(api, { method: "GET", headers: { accept: "application/json" }, cache: "no-store" });
  if (res.status === 404) return { settings: {}, records: [], trash: [], version: 0, updatedAt: null };
  if (!res.ok) throw new CloudApiError(`GET ${res.status}`, res.status);
  const data = await res.json();
  /* The deployed endpoint wraps the document in { ok, empty, state }; older and
     self-hosted builds return the bare document. Accept both. */
  const doc = data && typeof data === "object" && data.state && typeof data.state === "object" ? data.state : data;
  return {
    settings: (doc && doc.settings) || {},
    records: Array.isArray(doc && doc.records) ? doc.records : [],
    trash: Array.isArray(doc && doc.trash) ? doc.trash : [],
    version: Number(doc && doc.version) || 0,
    updatedAt: (doc && doc.updatedAt) || null
  };
}

/** POST the full state with optimistic concurrency. Never throws on 409 — returns it. */
export async function saveCloudState(
  payload: { settings: Record<string, unknown>; records: SyncRecord[]; trash: SyncRecord[] },
  options: { version: number; force?: boolean; api?: string }
): Promise<SaveOutcome> {
  const api = options.api || DEFAULT_API_PATH;
  const body = JSON.stringify({
    settings: stripDeviceOnly(payload.settings || {}),
    records: payload.records || [],
    trash: payload.trash || [],
    version: options.version,
    force: options.force === true
  });
  const res = await fetch(api, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body
  });
  const data = await res.json().catch(() => ({}));
  const doc = data && typeof data === "object" && data.state && typeof data.state === "object" ? data.state : data;
  if (res.ok) {
    return { ok: true, status: res.status, state: doc as CloudState };
  }
  return {
    ok: false,
    status: res.status,
    error: (data && data.error) || `HTTP ${res.status}`,
    message: (data && data.message) || "Save rejected by /api/sync",
    currentVersion:
      data && typeof data.currentVersion === "number"
        ? data.currentVersion
        : doc && typeof doc.version === "number"
          ? doc.version
          : undefined
  };
}

export async function clearCloudState(api: string = DEFAULT_API_PATH): Promise<boolean> {
  const res = await fetch(api, { method: "DELETE" });
  return res.ok;
}

/** Newest write wins per date; deletes (trash + tombstone) beat stale edits. */
export function mergeRecords(local: SyncRecord[], cloud: SyncRecord[]): { rows: SyncRecord[]; conflicts: string[] } {
  const map = new Map<string, SyncRecord>();
  const conflicts: string[] = [];
  const stamp = (r: SyncRecord) => String((r && (r.updated || r.created)) || "");
  for (const row of [...(cloud || []), ...(local || [])]) {
    if (!row || !row.date) continue;
    const prev = map.get(row.date);
    if (!prev) {
      map.set(row.date, row);
      continue;
    }
    if (stamp(row) > stamp(prev)) {
      map.set(row.date, row);
      conflicts.push(row.date);
    }
  }
  return { rows: [...map.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)), conflicts };
}

/**
 * Merge a cloud download into local state. Shared branch settings come from
 * whichever side was edited last; per-device preferences always stay local.
 */
export function mergeStates(
  local: { settings: Record<string, unknown>; records: SyncRecord[]; trash: SyncRecord[] },
  cloud: CloudState
): { settings: Record<string, unknown>; records: SyncRecord[]; trash: SyncRecord[]; conflicts: string[] } {
  const records = mergeRecords(local.records, cloud.records);
  const trash = mergeRecords(local.trash, cloud.trash);

  const localAt = String((local.settings && (local.settings.settingsUpdatedAt as string)) || "");
  const cloudAt = String((cloud.settings && (cloud.settings.settingsUpdatedAt as string)) || "");
  const source = cloudAt > localAt ? cloud.settings : local.settings || {};

  const settings: Record<string, unknown> = { ...(local.settings || {}) };
  for (const key of SHARED_SETTING_KEYS) {
    if (key in (source || {})) settings[key] = (source || {})[key];
  }
  for (const key of DEVICE_PREFERENCE_KEYS) {
    if (key in (local.settings || {})) settings[key] = (local.settings || {})[key];
  }
  delete settings.pin;

  return { settings, records: records.rows, trash: trash.rows, conflicts: records.conflicts };
}
