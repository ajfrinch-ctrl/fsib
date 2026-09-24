/* Local dev server: serves the app shell and implements /api/sync with the exact
   handler that ships to Netlify (src/lib/store.ts), backed by a JSON file
   instead of Netlify Blobs.

     node dev-server.mjs          # http://localhost:8080
     PORT=9000 node dev-server.mjs
     rm .tmp/dev-state.json       # reset the cloud state

   Nothing here re-implements the API: createSyncHandler is the production code. */
import { createServer } from "node:http";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import path from "node:path";
import { createSyncHandler } from "./src/lib/store.ts";
import { LIVE_DEFAULT_WAIT_MS, LIVE_MAX_WAIT_MS, createLiveHandler, createLiveHub, withLiveNotify } from "./src/lib/live.ts";

const ROOT = process.cwd();
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "0.0.0.0";
/* STATE_FILE is overridable so a test can run its own server against a
   throwaway state file instead of the developer's .tmp/dev-state.json. */
const STATE_FILE = process.env.STATE_FILE ? path.resolve(process.env.STATE_FILE) : path.join(ROOT, ".tmp", "dev-state.json");
const STATE_DIR = path.dirname(STATE_FILE);

const adapter = {
  async get() {
    try {
      return JSON.parse(await readFile(STATE_FILE, "utf8"));
    } catch {
      return null;
    }
  },
  async set(value) {
    await mkdir(STATE_DIR, { recursive: true });
    await writeFile(STATE_FILE, JSON.stringify(value, null, 2), "utf8");
  },
  async del() {
    await rm(STATE_FILE, { force: true });
  }
};

/* One hub for the whole dev server: a write through /api/sync wakes every
   parked /api/live request in this process instantly, so two browser tabs
   see each other's edits in real time with no polling delay. */
const hub = createLiveHub();
const liveAdapter = withLiveNotify(adapter, hub);

const handleSync = createSyncHandler(liveAdapter);
const handleLive = createLiveHandler(liveAdapter, hub.wait, {
  maxWaitMs: Number(process.env.LIVE_MAX_WAIT_MS || LIVE_MAX_WAIT_MS),
  defaultWaitMs: Number(process.env.LIVE_DEFAULT_WAIT_MS || LIVE_DEFAULT_WAIT_MS)
});

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".css": "text/css; charset=utf-8",
  ".webmanifest": "application/manifest+json"
};

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? Buffer.concat(chunks).toString("utf8") : undefined;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  /* /api/live — the real-time long-poll. Held for up to `wait` seconds and
     answered the instant the state file's version moves. */
  if (url.pathname === "/api/live" || url.pathname.startsWith("/api/live/")) {
    const request = new Request(url.toString(), { method: req.method, headers: req.headers });
    const started = Date.now();
    const response = await handleLive(request);
    const payload = Buffer.from(await response.arrayBuffer());
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    res.end(payload);
    console.log(`${req.method} ${url.pathname}${url.search} -> ${response.status} (${Date.now() - started}ms held)`);
    return;
  }

  if (url.pathname === "/api/sync" || url.pathname.startsWith("/api/sync/")) {
    const body = ["GET", "HEAD"].includes(req.method) ? undefined : await readBody(req);
    const request = new Request(url.toString(), { method: req.method, headers: req.headers, body });
    const response = await handleSync(request);
    const payload = Buffer.from(await response.arrayBuffer());
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    res.end(payload);
    console.log(`${req.method} ${url.pathname} -> ${response.status}`);
    return;
  }

  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  const filePath = path.join(ROOT, path.normalize(pathname).replace(/^(\.\.[/\\])+/, ""));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { "content-type": TYPES[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  }
});

server.listen(PORT, HOST, () => {
  /* PORT=0 asks the OS for a free port; log the one we actually got so a
     spawned test server can be reached. */
  const bound = server.address().port;
  console.log(`FSIB dev server on http://${HOST}:${bound}  (cloud state: ${path.relative(ROOT, STATE_FILE)})`);
  console.log(`  GET /api/sync        full state (ETag = cloud version)`);
  console.log(`  GET /api/live?version=N&wait=S   real-time long-poll: 200 changed / 304 nothing`);
});

/* Parked /api/live requests are woken by writes that go through this process
   (withLiveNotify). Watching the state file too means an edit made by hand — or
   by a second dev server sharing .tmp/dev-state.json — is also picked up live. */
try {
  await mkdir(STATE_DIR, { recursive: true });
  const watcher = watch(STATE_DIR, (_event, filename) => {
    if (!filename || String(filename).startsWith("dev-state.json")) hub.notify();
  });
  watcher.on("error", () => {});
} catch {
  /* no watcher is fine: the handler's own poll loop still notices changes */
}
