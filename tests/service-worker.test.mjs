import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SW = readFileSync(new URL("../service-worker.js", import.meta.url), "utf8");

test("the service worker never caches /api/ (a cached GET would serve a stale version)", () => {
  const fetchHandler = SW.slice(SW.indexOf('addEventListener("fetch"'));
  const bypass = fetchHandler.indexOf('"/api/"');
  const respondWith = fetchHandler.indexOf("event.respondWith");
  assert.ok(bypass !== -1, "no /api/ bypass in the fetch handler");
  assert.ok(bypass < respondWith, "the bypass must run before respondWith");
});

test("no JSONBin credential or endpoint is left in the shipped app shell", () => {
  const shell = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.doesNotMatch(shell, /api\.jsonbin\.io/);
  assert.doesNotMatch(shell, /X-Master-Key|X-Access-Key/);
  assert.doesNotMatch(shell, /\$2a\$10\$/, "a bcrypt-style key must not ship in the page");
  assert.match(SW, /fsib-branch-marketing-v11/);
});

/* A cache-first shell is how a phone keeps "working" while running a build from
   before real-time sync existed: device A saves, device B never shows it, and
   nobody can see why. The shell must come from the network whenever there is
   one, and from the cache only when there is not. */
test("the app shell is network-first, with the cache as the offline fallback", () => {
  const fetchHandler = SW.slice(SW.indexOf('addEventListener("fetch"'));
  const shellBranch = fetchHandler.slice(fetchHandler.indexOf('isShellRequest(event.request, url)'));
  const network = shellBranch.indexOf("fetch(event.request)");
  const cache = shellBranch.indexOf("caches.match(event.request)");
  assert.ok(network !== -1, "the shell is never fetched from the network");
  assert.ok(cache !== -1, "there is no offline fallback for the shell");
  assert.ok(network < cache, "the cached shell is served before the network one");
  assert.ok(shellBranch.indexOf("caches.match(\"./index.html\")") < shellBranch.indexOf("return;"),
    "an offline navigation must fall back to the cached shell");
  /* and a navigation must be recognised as shell traffic */
  assert.match(SW, /request\.mode === "navigate"/);
});
