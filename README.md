# FSIB Branch Marketing Report

Offline-first **real-time** daily branch marketing report PWA for First Security
Islami Bank PLC, Tantar Branch. The app shell is a single no-build `index.html`;
cloud state lives in **Netlify Blobs** behind two same-origin endpoints:
`/api/sync` for the document and `/api/live` for the change signal.

There is no credential in the page. The blob key stays on the server, so
view-source reveals nothing to sync against — this replaced a JSONBin access key
that used to ship inline in `index.html`.

## Real-time sync

Two devices now converge in about a second, with nobody tapping **Sync**:

- **Download** — one request is parked on `GET /api/live?version=<ours>&wait=20`
  (long-poll). The server holds it and answers the instant another device saves.
  It carries no data, only "the cloud moved", so the device then pulls
  `/api/sync` and merges. A quiet channel costs one `304` with an empty body per
  hold, and backs off while the app sits idle.
- **Upload** — an edit saves to IndexedDB/localStorage first, then uploads by
  itself ~1.5 s after the last keystroke. Every time: there is no daily gate and
  no budget — as long as **Auto-sync** is on, every change goes up on its own.
  Turning Auto-sync off holds uploads back until **Sync Now**.
- **Offline** — nothing changes: edits queue locally, the parked request is
  dropped, and the queue flushes the moment the device is back online.

Long-poll rather than SSE/WebSocket because a Netlify Function is stateless and
capped at 60 s: a held GET works on every host this repo deploys to, with no
reconnect choreography and no sticky session. The live download channel can be
switched off per device in **Settings → Cloud Sync** (uploads keep running
automatically while Auto-sync is on), and a deploy without `/api/live` is
detected once (404/405) and never retried — downloads then arrive on startup
and manual refresh while edits still upload by themselves.

The header shows the truth about the channel: `LIVE` (parked and watching),
`UPDATING` (pulling), `RETRY` (backing off), `NO LIVE` (server has no endpoint)
or `LIVE OFF`.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/sync` | Load the full state (`ETag` = cloud version) |
| `POST` | `/api/sync` | Save/update (creates version 1 on first write) |
| `PUT` | `/api/sync` | Save/update |
| `DELETE` | `/api/sync` | Clear cloud data |
| `GET` | `/api/live` | Long-poll: has the cloud moved since version N? |

```jsonc
// POST /api/sync
{
  "settings": { "branch": "Tantar Branch", "zone": "Cumilla" },
  "records": [{ "date": "2026-09-14", "cash": "2400000", "updated": "2026-09-14T09:00:00.000Z" }],
  "trash": [],
  "version": 16,     // the version you loaded
  "force": false     // true overwrites regardless of version
}
```

Writes are optimistic-concurrency: a body carrying a stale `version` gets **409**
with `{ error: "version-conflict", currentVersion, providedVersion }`. The server
owns the version increment — clients never choose it. Oversized states get
**413**, a non-JSON body **400**, an unknown verb **405**.

`GET /api/sync` also honours `If-None-Match`, so a device that is already up to
date downloads nothing at all.

### `/api/live`

`wait` is in **seconds** and is clamped server-side (`LIVE_MAX_WAIT_MS`, under
the platform's 60 s function limit).

| Request | Response |
| --- | --- |
| `?version=12&wait=20`, cloud is at 12 | held, then `304` with an empty body and `ETag: "12"` |
| `?version=12&wait=20`, cloud moved to 15 | `200 { ok, changed: true, version: 15, updatedAt, etag, waitedMs }` |
| `?version=-1` | `200 { ok, baseline: true, version }` — answered at once, never held |
| `?version=20`, cloud is at 3 | `200 { ok, changed: false, reset: true, version: 3 }` — the blob was cleared or an older backup restored |
| no `version` (or junk) | `400 { error: "version-required" }` |
| anything but `GET`/`HEAD` | `405 { error: "method-not-allowed" }` |

A client that gets `404`/`405` marks the channel unavailable and stops asking,
so an older deploy is left alone instead of being hammered; uploads keep
working either way.

The `pin` setting is device-only (`localStorage["bmr_v1_pin"]`) and is stripped
server-side, so a lost phone's PIN never reaches a blob every device can read.
`realtime` is a device preference too: one phone can opt out without changing
anyone else's.

## Layout

| Path | What it is |
| --- | --- |
| `index.html` | The whole PWA: UI, local-first storage, sync client, real-time channel |
| `src/lib/store.ts` | The `/api/sync` contract + blob-agnostic state logic (the only implementation) |
| `src/lib/live.ts` | The `/api/live` long-poll contract + the in-process wake-up hub |
| `src/lib/cloud-api.ts` | Typed browser client for both contracts |
| `netlify/functions/sync.ts` | Netlify Function routed to `/api/sync` — what this repo deploys |
| `netlify/functions/live.ts` | Netlify Function routed to `/api/live` |
| `server/routes/api/*.ts` | Nitro-style routes for the deployed fsib.netlify.app build; thin adapters over the same handlers |
| `dev-server.mjs` | Local static server + both endpoints on a JSON file, one hub so two tabs are instant |
| `build.mjs` | Copies the app shell into `public/` for deploy |

`index.html` is deliberately buildless, so it carries an inline mirror of
`src/lib/cloud-api.ts` (search for “Mirrors src/lib/cloud-api.ts” and “real-time
channel: /api/live long-poll”). Keep the two in step.

## Develop

```bash
npm install
npm run dev        # http://localhost:8080 — cloud state in .tmp/dev-state.json
npm test           # 59 tests: store, live channel, client merge, app↔API, two devices over real HTTP
npm run typecheck  # tsc over src/ and netlify/
npm run build      # produce public/
```

Open `npm run dev` in two browser tabs: type in one and the other updates within
about a second. The dev server owns one hub, so a write through `/api/sync`
wakes every parked `/api/live` request in the process instead of waiting for a
poll tick.

```bash
PORT=9000 node dev-server.mjs      # another port
STATE_FILE=/tmp/x.json node dev-server.mjs   # a throwaway cloud (used by the e2e test)
rm .tmp/dev-state.json             # reset the cloud state
```

`npm test` boots the real `index.html` in jsdom and points its `fetch` at the
real handlers from `src/lib/store.ts` and `src/lib/live.ts`, so the app's
`syncNow()` and its live channel are tested against the same code Netlify runs —
including a lost-race 409 that must re-merge and retry, unlimited automatic
uploads with no daily gate, and a server with no `/api/live` whose edits still
upload by themselves. `tests/live-e2e.test.mjs` goes one
step further: it spawns `dev-server.mjs` on a free port and runs two devices
against it over real sockets, and reports the observed keystroke-to-other-screen
latency.

## Deploy

`netlify.toml` builds with `npm run build` and publishes `public/`; both
functions are picked up from `netlify/functions/`. Netlify Blobs needs no
provisioning — the store `fsib-app` / key `state` is created on first write.

Each parked `/api/live` request is one function invocation, so a device left
open all day costs roughly one invocation per `wait` window (default 20 s) while
it is in the foreground; hidden tabs and offline devices park nothing, and an
idle device backs off to one request every two minutes.

Blob reads are the other half of the bill, and they are shared: Netlify gives one
invocation no memory of the instance that served a write, so a parked request has
to look for the change itself — but every request parked on the same instance
joins **one** poller (`trackerFor` in `src/lib/live.ts`), which reads the blob at
most once per `LIVE_POLL_INTERVAL_MS` (750 ms) and stops the moment nobody is
waiting. Six devices on one instance cost one read per tick, not six. Where a
process *can* be notified — `dev-server.mjs`, the tests, a Nitro server — the hub
in `withLiveNotify` wakes the poller immediately instead of waiting for the tick.
