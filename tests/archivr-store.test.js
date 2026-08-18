"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadBackgroundStore() {
  const noop = () => {};
  const sandbox = {
    browser: {
      runtime: { onMessage: { addListener: noop }, onStartup: { addListener: noop } },
      action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
      downloads: { download: async () => "archive.zip" },
      storage: { local: { get: async () => ({}), set: async () => {} } }
    },
    console,
    __archivrTest: {}
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "plugins", "archivr.js"), "utf8"), ctx, {
    filename: "plugins/archivr.js"
  });
  return ctx.__archivrTest;
}

const { createMemoryStore } = loadBackgroundStore();

function rec(url, ts) {
  return { url, title: "T", baseURI: url, html: "<html></html>", ts };
}

test("memory store adds, lists newest-first, counts, omits html in list", async () => {
  const store = createMemoryStore();
  await store.clear();
  await store.add(rec("https://a.com/1", 1000));
  await store.add(rec("https://a.com/2", 2000));
  await store.add(rec("https://a.com/3", 3000));
  assert.equal(await store.count(), 3);
  const list = await store.list();
  assert.deepEqual([...list.map((r) => r.url)], ["https://a.com/3", "https://a.com/2", "https://a.com/1"]);
  assert.equal(list[0].html, undefined, "list() must omit the html payload");
});

test("memory store dedupes same URL within 5s", async () => {
  const store = createMemoryStore();
  await store.clear();
  assert.ok(await store.add(rec("https://a.com/1", 1000)));
  assert.equal(await store.add(rec("https://a.com/1", 4000)), null);
  assert.ok(await store.add(rec("https://a.com/1", 10000)));
});

test("memory store caps list at 300 entries", async () => {
  const store = createMemoryStore();
  await store.clear();
  for (let i = 0; i < 320; i++) await store.add(rec(`https://a.com/${i}`, i));
  const list = await store.list();
  assert.equal(list.length, 300);
  assert.equal(list[0].url, "https://a.com/319");
});

test("getByIds returns full records including html", async () => {
  const store = createMemoryStore();
  await store.clear();
  const id = await store.add(rec("https://a.com/x", 1));
  const rows = await store.getByIds([id]);
  assert.equal(rows.length, 1);
  assert.ok("html" in rows[0]);
});

test("clear empties the store", async () => {
  const store = createMemoryStore();
  await store.clear();
  await store.add(rec("https://a.com/x", 1));
  await store.clear();
  assert.equal(await store.count(), 0);
});
