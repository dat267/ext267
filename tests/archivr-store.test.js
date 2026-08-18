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

const { createMemoryStore, createIdbStore } = loadBackgroundStore();

function rec(url, ts) {
  return { url, title: "T", baseURI: url, html: "<html></html>", ts };
}

// Minimal in-memory IndexedDB lookalike covering only what createIdbStore uses
// (open, createObjectStore, add, get, clear, openCursor). Data lives inside the
// fake, so two createIdbStore instances over the same fake simulate two MV3
// worker lifetimes over the same durable backing store.
function createFakeIndexedDB() {
  const dbs = new Map();
  const makeStoreApi = (store) => ({
    add(value) {
      const req = { result: null, error: null, onsuccess: null, onerror: null };
      let key = store.keyPath ? value[store.keyPath] : undefined;
      if (key === undefined || key === null) {
        key = ++store.db.keyGen;
        if (store.keyPath) value[store.keyPath] = key;
      } else if (key > store.db.keyGen) {
        store.db.keyGen = key;
      }
      if (store.records.has(key)) {
        req.error = new Error("ConstraintError: key already exists");
        queueMicrotask(() => req.onerror && req.onerror());
      } else {
        store.records.set(key, value);
        req.result = key;
        queueMicrotask(() => req.onsuccess && req.onsuccess());
      }
      return req;
    },
    get(id) {
      const req = { result: null, error: null, onsuccess: null, onerror: null };
      req.result = store.records.get(id);
      queueMicrotask(() => req.onsuccess && req.onsuccess());
      return req;
    },
    clear() {
      const req = { result: null, error: null, onsuccess: null, onerror: null };
      store.records.clear();
      queueMicrotask(() => req.onsuccess && req.onsuccess());
      return req;
    },
    openCursor() {
      const req = { result: null, error: null, onsuccess: null, onerror: null };
      const keys = Array.from(store.records.keys()).sort((a, b) => b - a);
      let i = 0;
      const cursorAt = (idx) => ({
        key: keys[idx],
        value: store.records.get(keys[idx]),
        continue() {
          i++;
          advance();
        }
      });
      const advance = () => {
        req.result = i < keys.length ? cursorAt(i) : null;
        queueMicrotask(() => req.onsuccess && req.onsuccess());
      };
      advance();
      return req;
    }
  });
  const makeConnection = (db) => ({
    objectStoreNames: {
      contains(name) {
        return db.stores.has(name);
      }
    },
    createObjectStore(name, opts) {
      const store = {
        records: new Map(),
        keyPath: opts && opts.keyPath,
        autoIncrement: !!(opts && opts.autoIncrement),
        db
      };
      db.stores.set(name, store);
      return makeStoreApi(store);
    },
    transaction() {
      return { objectStore: (name) => makeStoreApi(db.stores.get(name)) };
    }
  });
  return {
    open(name) {
      let db = dbs.get(name);
      const fresh = !db;
      if (fresh) {
        db = { stores: new Map(), keyGen: 0 };
        dbs.set(name, db);
      }
      const req = { result: null, error: null, onupgradeneeded: null, onsuccess: null, onerror: null };
      req.result = makeConnection(db);
      queueMicrotask(() => {
        if (fresh && req.onupgradeneeded) req.onupgradeneeded();
        if (req.onsuccess) req.onsuccess();
      });
      return req;
    }
  };
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
  assert.equal(typeof list[0].size, "number", "list() must populate size");
  assert.equal(list[0].size, "<html></html>".length, "size must equal html.length");
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

test("idb store survives worker recycle: list restores and ids continue", async () => {
  const fake = createFakeIndexedDB();

  const store1 = createIdbStore("archivr-captures", fake);
  const id1 = await store1.add(rec("https://a.com/1", 1000));
  const id2 = await store1.add(rec("https://a.com/2", 2000));
  assert.deepEqual([id1, id2], [1, 2]);

  // Fresh worker lifetime over the SAME backing database.
  const store2 = createIdbStore("archivr-captures", fake);
  const list = await store2.list();
  assert.deepEqual(
    [...list.map((r) => r.url)],
    ["https://a.com/2", "https://a.com/1"],
    "list() restored from IDB after worker recycle"
  );
  assert.equal(list.length, 2);
  assert.equal(typeof list[0].size, "number", "hydrated entries carry size");

  const id3 = await store2.add(rec("https://a.com/3", 3000));
  assert.equal(id3, 3, "id sequence continues from max id, no reuse");

  const rows = await store2.getByIds([id1, id3]);
  assert.equal(rows.length, 2);
  assert.ok("html" in rows[0], "getByIds reads full records from IDB across recycle");
  assert.equal(await store2.count(), 3);
});

test("idb store survives worker recycle with a full index (cap + fresh ids)", async () => {
  const fake = createFakeIndexedDB();
  const store1 = createIdbStore("archivr-captures", fake);
  for (let i = 0; i < 320; i++) await store1.add(rec(`https://a.com/${i}`, i));

  const store2 = createIdbStore("archivr-captures", fake);
  const list = await store2.list();
  assert.equal(list.length, 300, "hydrated index is capped at 300");
  assert.equal(list[0].url, "https://a.com/319", "newest first after hydration");

  const id = await store2.add(rec("https://a.com/320", 3200));
  assert.equal(id, 321, "id continues beyond the max stored id (320)");
  assert.equal((await store2.list())[0].id, 321);
});
