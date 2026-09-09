"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Load cliget.js into a sandboxed VM context (same as cliget.test.js).
// `window` is defined, so `_isBackground` is false and the browser-only
// wiring is skipped — but the top-level DownloadStore class is reachable.
function loadCliget() {
  const source = fs.readFileSync(path.join(__dirname, "..", "plugins", "cliget.js"), "utf8");
  const sandbox = { browser: {}, window: {}, console };
  const context = vm.createContext(sandbox);
  vm.runInContext(source, context, { filename: "cliget.js" });
  // class declarations are global *lexical* bindings (unlike function
  // declarations), so read the class back by evaluating the identifier.
  context.DownloadStore = vm.runInContext("DownloadStore", context);
  return context;
}

const ctx = loadCliget();

// In-memory stand-ins for ext.storage.local and ext.action.
function makeDeps(overrides = {}) {
  // default fake storage starts empty
  const data = Object.assign({}, overrides.seed || {});
  delete overrides.seed;
  const storage = {
    async get(key) {
      return { [key]: data[key] };
    },
    async set(obj) {
      Object.assign(data, obj);
    },
    async remove(key) {
      delete data[key];
    }
  };
  const action = {
    badge: "",
    async getBadgeText() {
      return this.badge;
    },
    async setBadgeText({ text }) {
      this.badge = text;
    }
  };
  return Object.assign({ storage, action }, overrides);
}

function makeStore(overrides = {}) {
  const deps = makeDeps(overrides);
  const store = new ctx.DownloadStore(deps);
  return { store, deps };
}

// A controllable clock to drive timestamp-dependent behavior (dedupe,
// FIFO eviction) deterministically.
let __clock = 0;
function tick(ms = 1) {
  __clock += ms;
  return __clock;
}

// Track + finish one request through the store, returning onResponseStarted's
// acceptance boolean.
async function intercept(store, requestId, url, opts = {}) {
  store.track({
    requestId,
    url,
    method: opts.method ?? "GET",
    type: opts.type ?? "main_frame",
    payload: opts.payload
  });
  return store.onResponseStarted({
    requestId,
    statusCode: opts.statusCode ?? 200,
    fromCache: opts.fromCache ?? false,
    responseHeaders: opts.responseHeaders ?? [
      { name: "Content-Type", value: "application/pdf" },
      { name: "Content-Disposition", value: 'attachment; filename="a.pdf"' }
    ]
  });
}

test("DownloadStore: attachment main_frame response is saved with filename, size and badge", async () => {
  const { store, deps } = makeStore({ now: tick });
  assert.equal((await store.list()).length, 0, "seed list empty");

  const saved = await intercept(store, "1", "https://x/file.pdf", {
    responseHeaders: [
      { name: "Content-Type", value: "application/pdf" },
      { name: "Content-Disposition", value: 'attachment; filename="report.pdf"' },
      { name: "Content-Length", value: "4096" }
    ]
  });

  assert.equal(saved, true, "attachment should be accepted as a download");
  const list = await store.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].filename, "report.pdf");
  assert.equal(list[0].size, 4096);
  assert.equal(list[0].method, "GET");
  assert.equal(deps.action.badge, "1");
});

test("DownloadStore: same URL within 5s is deduplicated, badge counts once", async () => {
  const { store, deps } = makeStore({ now: tick });
  const saved1 = await intercept(store, "r1", "https://x/a.pdf");
  tick(3000);
  const saved2 = await intercept(store, "r2", "https://x/a.pdf");
  assert.equal(saved1, true);
  assert.equal(saved2, false, "duplicate URL inside the window is rejected");
  assert.equal((await store.list()).length, 1);
  assert.equal(deps.action.badge, "1");
});

test("DownloadStore: concurrent completions save serially, no clobbering", async () => {
  const { store, deps } = makeStore({ now: tick });
  // Fire both completions before either resolves (the historical race:
  // read-modify-write storage saves stomping each other).
  const p1 = intercept(store, "c1", "https://x/1.pdf");
  const p2 = intercept(store, "c2", "https://x/2.pdf");
  await Promise.all([p1, p2]);

  const list = await store.list();
  assert.equal(list.length, 2, "both finishes must survive");
  assert.equal(deps.action.badge, "2");
});

test("DownloadStore: MAX_ITEMS=10 cap keeps the newest downloads", async () => {
  const { store, deps } = makeStore({ now: tick });
  for (let i = 0; i < 13; i++) {
    await intercept(store, `cap-${i}`, `https://x/${i}.pdf`);
    tick(1000);
  }
  const list = await store.list();
  assert.equal(list.length, 10, "list is capped at 10");
  assert.equal(list[0].url, "https://x/3.pdf", "oldest entries are evicted");
  assert.equal(list[list.length - 1].url, "https://x/12.pdf");
  assert.equal(deps.action.badge, "13", "badge still counts every save");
});

test("DownloadStore: non-200 and fromCache responses are not saved", async () => {
  const { store } = makeStore({ now: tick });
  assert.equal(await intercept(store, "e1", "https://x/fail.pdf", { statusCode: 500 }), false);
  assert.equal(await intercept(store, "e2", "https://x/cached.pdf", { fromCache: true }), false);
  assert.equal((await store.list()).length, 0);
});

test("DownloadStore: inline text/html without attachment is NOT a download", async () => {
  const { store } = makeStore({ now: tick });
  const saved = await intercept(store, "h1", "https://x/page", {
    responseHeaders: [{ name: "Content-Type", value: "text/html; charset=utf-8" }]
  });
  assert.equal(saved, false);
  assert.equal((await store.list()).length, 0);
});

test("DownloadStore: image/* with attachment disposition IS captured (disposition wins)", async () => {
  const { store } = makeStore({ now: tick });
  const saved = await intercept(store, "img1", "https://x/pic.png", {
    responseHeaders: [
      { name: "Content-Type", value: "image/png" },
      { name: "Content-Disposition", value: 'attachment; filename="pic.png"' }
    ]
  });
  assert.equal(saved, true);
  assert.equal((await store.list())[0].filename, "pic.png");
});

test("DownloadStore: tracked request headers are attached to the completed request", async () => {
  const { store } = makeStore({ now: tick });
  store.track({ requestId: "hdr1", url: "https://x/f.pdf", method: "GET", type: "main_frame" });
  store.setHeaders({ requestId: "hdr1", requestHeaders: [{ name: "Cookie", value: "a=b" }] });
  await store.onResponseStarted({
    requestId: "hdr1",
    statusCode: 200,
    fromCache: false,
    responseHeaders: [
      { name: "Content-Type", value: "application/pdf" },
      { name: "Content-Disposition", value: 'attachment; filename="f.pdf"' }
    ]
  });
  assert.deepEqual((await store.list())[0].headers, [{ name: "Cookie", value: "a=b" }]);
});

test("DownloadStore: discard frees a pending entry (redirect/error paths)", async () => {
  const { store } = makeStore({ now: tick });
  store.track({ requestId: "gone", url: "https://x/g.pdf", method: "GET", type: "main_frame" });
  store.discard("gone");
  // No pending entry left → unknown requestId → not accepted.
  assert.equal(
    await store.onResponseStarted({
      requestId: "gone",
      statusCode: 200,
      fromCache: false,
      responseHeaders: [{ name: "Content-Disposition", value: 'attachment; filename="g.pdf"' }]
    }),
    false
  );
  assert.equal((await store.list()).length, 0);
});

test("DownloadStore: pending FIFO evicts oldest when over 150", async () => {
  const { store } = makeStore({ now: tick });
  for (let i = 0; i < 152; i++)
    store.track({ requestId: `p-${i}`, url: `https://x/${i}.pdf`, method: "GET", type: "main_frame" });
  // p-0 and p-1 were evicted; the rest still resolve.
  const gone = await store.onResponseStarted({
    requestId: "p-0",
    statusCode: 200,
    fromCache: false,
    responseHeaders: [{ name: "Content-Disposition", value: 'attachment; filename="0.pdf"' }]
  });
  assert.equal(gone, false, "evicted request is unknown");
  const alive = await store.onResponseStarted({
    requestId: "p-151",
    statusCode: 200,
    fromCache: false,
    responseHeaders: [{ name: "Content-Disposition", value: 'attachment; filename="151.pdf"' }]
  });
  assert.equal(alive, true);
});

test("DownloadStore: clear removes the list and resets the badge", async () => {
  const { store, deps } = makeStore({ now: tick });
  await intercept(store, "clr1", "https://x/clr.pdf");
  assert.equal((await store.list()).length, 1);
  assert.equal(deps.action.badge, "1");
  await store.clear();
  assert.equal((await store.list()).length, 0);
  assert.equal(deps.action.badge, "");
});
