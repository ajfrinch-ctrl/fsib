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
  assert.match(SW, /fsib-branch-marketing-v5/);
});
