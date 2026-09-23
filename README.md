# FSIB Branch Marketing Report

Offline-first daily branch marketing report PWA for First Security Islami Bank PLC,
Tantar Branch. The app shell is a single no-build `index.html`; cloud state lives in
**Netlify Blobs** behind one same-origin endpoint, `/api/sync`.

There is no credential in the page. The blob key stays on the server, so view-source
reveals nothing to sync against — this replaced a JSONBin access key that used to ship
inline in `index.html`.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/sync` | Load the full state |
| `POST` | `/api/sync` | Save/update (creates version 1 on first write) |
| `PUT` | `/api/sync` | Save/update |
| `DELETE` | `/api/sync` | Clear cloud data |

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
with `{ error: "version-conflict", currentVersion, providedVersion }`. The server owns
the version increment — clients never choose it. Oversized states get **413**, a
non-JSON body **400**, an unknown verb **405**.

The `pin` setting is device-only (`localStorage["bmr_v1_pin"]`) and is stripped
server-side, so a lost phone's PIN never reaches a blob every device can read.

## Layout

| Path | What it is |
| --- | --- |
| `index.html` | The whole PWA: UI, local-first storage, sync client |
| `src/lib/store.ts` | The `/api/sync` contract + blob-agnostic state logic (the only implementation) |
| `src/lib/cloud-api.ts` | Typed browser client for that contract |
| `netlify/functions/sync.ts` | Netlify Function routed to `/api/sync` — what this repo deploys |
| `server/routes/api/sync.ts` | Nitro-style route for the deployed fsib.netlify.app build; thin adapter over the same handler |
| `dev-server.mjs` | Local static server + `/api/sync` on a JSON file |
| `build.mjs` | Copies the app shell into `public/` for deploy |

`index.html` is deliberately buildless, so it carries an inline mirror of
`src/lib/cloud-api.ts` (search for “Mirrors src/lib/cloud-api.ts”). Keep the two in step.

## Develop

```bash
npm install
npm run dev        # http://localhost:8080 — cloud state in .tmp/dev-state.json
npm test           # 26 tests: store logic, client merge, app↔API round trip
npm run typecheck  # tsc over src/ and netlify/
npm run build      # produce public/
```

`npm test` boots the real `index.html` in jsdom and points its `fetch` at the real
handler from `src/lib/store.ts`, so the app's `syncNow()` is tested against the same
code Netlify runs — including a lost-race 409 that must re-merge and retry.

## Deploy

`netlify.toml` builds with `npm run build` and publishes `public/`; the function is
picked up from `netlify/functions/`. Netlify Blobs needs no provisioning — the store
`fsib-app` / key `state` is created on first write.
