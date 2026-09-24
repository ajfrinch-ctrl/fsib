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
  itself ~1.5 s after the last keystroke. Every time: there is no daily gate,
  no budget, and no Auto-sync switch. Every change goes up on its own.
- **Offline** — nothing changes: edits queue locally, the parked request is
  dropped, and the queue flushes the moment the device is back online.

- **What a phone cannot know, the server tells it** — every `/api/live` answer
  (the 304 included) carries `X-Live-Max-Wait-Ms`: the longest hold this
  deployment will really honour. A hold that outlives the platform's function
  timeout is *killed*, and a killed hold reaches the browser as a gateway error,
  not as "the cloud is quiet" — so the app used to treat it as a broken channel
  and back off for up to two minutes. Now the app parks for exactly the
  advertised ceiling and grows the hold again when a host proves it can.
- **Both signals are always armed** — a parked request waits on the in-process
  hub (instant, for a write this instance served) *and* on the shared blob
  poller. Netlify runs each invocation in its own instance, so the poller is the
  half that actually finds another device's write; a hub-only hold could only
  ever learn about it by timing out.
- **Safety net** — whenever no request is parked (an older deploy without
  `/api/live`, a gateway that cuts every hold, a tab that has just come back),
  the app looks for changes on a timer instead, and it flushes the pending edit
  the moment the tab is hidden so the other phone sees it before the officer
  puts the phone away.

Long-poll rather than SSE/WebSocket because a Netlify Function is stateless and
capped at 60 s: a held GET works on every host this repo deploys to, with no
reconnect choreography and no sticky session. The live channel is always on. Settings has no Cloud Sync section and no
switch that can turn it off. A deploy without `/api/live` is
detected once (404/405) and never retried — downloads then arrive on startup,
the safety net and manual refresh while edits still upload by themselves.

The header shows the truth about the channel: `LIVE` (parked and watching),
`UPDATING` (pulling), `RETRY` (backing off), `NO LIVE` (server has no endpoint)
or `LIVE OFF`. There is no sync-status button. A green border along the bottom
of the top bar means this device is online and synced.

## Dashboard

The top of the dashboard is the four periods the branch reads at a glance, each
with the accounts opened and the deposit collected in it:

| Period | Accounts | Deposit |
| --- | --- | --- |
| Today | new accounts opened today | today's deposit |
| This week | accounts in the branch week | deposit in the branch week |
| This month | accounts this calendar month | deposit this calendar month |
| Last 30 days | accounts in the rolling 30 days | deposit in the rolling 30 days |

"Deposit" here is one number: the day's cash, clearing/BFTN, RTGS, NPSB and
agent outlet deposits **plus** the initial deposits the new accounts brought in
(the card's footer says so and shows how much of the 30-day figure is account
money). The entry form, the WhatsApp text and the report PDFs keep the official
Total Deposit untouched — nothing about what the branch files changes.

"This week" follows `weeklyStart`/`weeklyEnd` (Sunday–Thursday by default), the
same window History groups by and the weekly report is filed against, so the row
and the report cannot disagree. A column with no entry is `0`, never blank.
Below it the dashboard keeps the today hero (with the entry button), the 7-day
trend, the monthly target and the highlights.

## Reports

Both report views keep only what the branch reads at a glance always visible —
the period tabs, the period picker and the hero (period, the period's total, the
target progress). Everything else is a **closed section with a one-line summary
in its header**, so a tap opens it and the page never arrives as twenty open
cards:

```
> Summary          5 recorded days · 10 accounts · 78.50 Lac
> Deposit by method 5 methods · 78.50 Lac
> Activity         2 officers · 1 visit type
> Daily details    5 days · ৳ 78,50,000
    > 24 Sep       7 places · 2 accounts      ৳ 15,90,000
```

A day row is closed the same way — date, what happened, what it collected — and
opens onto the places / new accounts / A/C deposit trio plus the deposit,
officer and account breakdowns. The accounts view groups by day the same way
and carries a hero of its own. Native `<details>`, so a tap, Enter or Space all
work, and opening one section leaves any other open section alone.

## WhatsApp share

The report the branch sends has two parts, both built in the page:

- **Current Daily Report** — the editable treasury template. It carries
  `Total Places Visited: {{visits}}`, `Total Accounts: {{accounts}}` and
  `Total Deposit: Tk {{deposit}} ({{depositLac}})`, so the places visited and the
  number of accounts opened that day go out with the day's money. Settings lists
  every available field (`{{visits}}`, `{{accounts}}` and `{{depositLac}}`
  included), and an older, hand-edited template keeps working.
- **Detailed Daily Activity** — the plain-text breakdown: officers, visit
  details, deposit details, new accounts. Every amount in it is written in
  **lakh** beside the full figure (`Tk 15,00,000 (15.00 Lac)`), because that is
  the unit the branch reads.

An account number is not collected at all. The entry form asks for an account
type and the money it brought in, and the detailed message says
**`NUMBER OF ACCOUNTS:`** — how many accounts were opened that day — and lists
each new account by type and amount. The number is dropped on every read and
write by the same rule that drops the retired sync switches (`no` in
`RETIRED_ACCOUNT_FIELDS`), so an older blob cannot bring it back, and a day
saved by an older build simply loses it on the next sync.

## API

`OPTIONS` on either endpoint is a 204 preflight, so a shell served from another
host (GitHub Pages) can use this cloud.

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

`wait` is in **seconds** and is clamped server-side. Every answer carries
`X-Live-Max-Wait-Ms`: the effective ceiling, so a client can park for exactly
what the deployment will serve. `netlify/functions/live.ts` defaults to an 8 s
hold — under the 10 s function timeout a Netlify site has unless it has been
raised — and 2 s between blob polls; `FSIB_LIVE_MAX_WAIT_MS` and
`FSIB_LIVE_POLL_MS` override both. The Nitro route uses the same defaults.

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
Retired sync switches (`autoSync`, `realtime`) are stripped on every read and
write too. Sync is always real-time. Settings does not contain a sync section,
and an older blob cannot bring those switches back.

## Two hosts: the shell and the cloud

The app shell is static, the cloud is not. Normally both live on the Netlify
deployment. But the branch's phones have the **GitHub Pages** link
(`ajfrinch-ctrl.github.io/fsib`) on their home screens, and GitHub Pages serves
files only — `/api/sync` there is a **404**, so each phone saved into its own
localStorage and no device ever saw another's entry. That is not a sync bug that
a retry can fix; there is nothing to retry against.

So the shell knows where its cloud is:

- `STATIC_HOST_API` in `index.html` maps a static host to the API origin
  (`ajfrinch-ctrl.github.io` → `https://fsib.netlify.app`). An install from
  Pages therefore syncs through the Netlify functions.
- `?api=https://host` overrides the origin for a test or a new host, and is
  remembered in `localStorage["bmr_v1_apiOrigin"]`. The sync panel shows the
  origin it is using as **Cloud host**.
- Both endpoints answer CORS, preflight included (`OPTIONS` → 204), and expose
  the headers the app reads (`etag`, `x-live-max-wait-ms`). The default is
  `access-control-allow-origin: *` — this API has never carried a credential, so
  that is not a new exposure; set `FSIB_ALLOWED_ORIGINS` on the Netlify site to a
  comma-separated list to restrict it to the hosts you name.

Data that a phone saved while it was running a Pages install with no cloud lives
in that device's localStorage under the Pages origin, so switching to the
Netlify link does not upload it: use **Settings → Backup JSON** in the old app
and **Restore Backup** in the new one (or keep using the Pages link, which now
syncs too).

## Layout

| Path | What it is |
| --- | --- |
| `index.html` | The whole PWA: UI, local-first storage, sync client, real-time channel, dashboard, API-origin resolution |
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
npm test           # 87 tests: store, live channel (holds, ceiling, hub+poller), client merge, app↔API, CORS, safety net, two devices over real HTTP, a Pages install over real HTTP, offline report generate/preview/download, the WhatsApp share text, the retired account number
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
latency. `tests/pdf-export.test.mjs` boots the app with every network call
failing and walks the whole report flow — pick a date, generate, check the
preview, download — proving all three report PDFs (statement, visiting,
accounts) are built and saved by the browser alone, and that nothing is
written to disk unless Download is tapped. Every report PDF — statement,
visiting, and accounts, for a day, a week, or a month — is the same landscape
statement: one row per date in that period, and a column for every daily
entry. A column with no entry is left blank. WhatsApp share text is separate
and is not this table.

## Deploy

`netlify.toml` builds with `npm run build` and publishes `public/`; both
functions are picked up from `netlify/functions/`.

A GitHub Pages deploy of the same branch is supported as a *shell only*: the
app runs there and talks to this API cross-origin (see above). Nothing about the
cloud runs on Pages, so a Pages URL alone can never sync.

`service-worker.js` is network-first for the app shell: a phone must never keep
running an old build (a cache-first shell is exactly how a device "works" while
silently missing every edit another device makes). The cache is the offline
fallback, `/api/` is never cached, and a new worker taking over an installed app
reloads it once so the phone starts on the build it just downloaded. Netlify Blobs needs no
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
