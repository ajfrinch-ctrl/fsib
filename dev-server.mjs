/* Local dev server: serves the app shell and implements /api/sync with the exact
   handler that ships to Netlify (src/lib/store.ts), backed by a JSON file
   instead of Netlify Blobs.

     node dev-server.mjs          # http://localhost:8080
     PORT=9000 node dev-server.mjs
     rm .tmp/dev-state.json       # reset the cloud state

   Nothing here re-implements the API: createSyncHandler is the production code. */
import { createServer } from "node:http";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createSyncHandler } from "./src/lib/store.ts";

const ROOT = process.cwd();
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "0.0.0.0";
const STATE_DIR = path.join(ROOT, ".tmp");
const STATE_FILE = path.join(STATE_DIR, "dev-state.json");

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

const handleSync = createSyncHandler(adapter);

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
  console.log(`FSIB dev server on http://${HOST}:${PORT}  (cloud state: ${path.relative(ROOT, STATE_FILE)})`);
});
