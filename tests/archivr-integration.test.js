"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ARCHIVR_SRC = fs.readFileSync(path.join(__dirname, "..", "plugins", "archivr.js"), "utf8");

// Probe-load the plugin in a throwaway context to grab the background store
// factory. The background block binds `const store = ...` at load time, so the
// harness must hand the memory store to __archivrTest.store BEFORE the real
// load (swapping after load would be too late for the already-captured binding).
function loadBackgroundHooks() {
  const noop = () => {};
  const sandbox = {
    browser: {
      runtime: { onMessage: { addListener: noop }, onStartup: { addListener: noop } },
      action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
      downloads: { download: async () => 1 },
      storage: { local: { get: async () => ({}), set: async () => {} } }
    },
    console,
    __archivrTest: {}
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(ARCHIVR_SRC, ctx, { filename: "plugins/archivr.js" });
  return ctx.__archivrTest;
}

function loadBackground() {
  const handlers = [];
  const downloads = [];
  const badges = [];
  const api = {
    runtime: {
      onMessage: {
        addListener(fn) {
          handlers.push(fn);
        }
      },
      onStartup: { addListener() {} }
    },
    action: {
      setBadgeText: async ({ text }) => {
        badges.push(text);
      },
      setBadgeBackgroundColor: async () => {}
    },
    downloads: {
      download: async (opts) => {
        downloads.push(opts);
        return 1;
      }
    },
    storage: { local: { get: async () => ({}), set: async () => {} } }
  };
  const sandbox = {
    browser: api,
    console,
    __archivrTest: { store: loadBackgroundHooks().createMemoryStore() },
    // The real archivr:download handler builds a Blob URL and schedules its
    // revocation, so the sandbox must supply these DOM/Web globals.
    URL: { createObjectURL: () => "blob:mock", revokeObjectURL: () => {} },
    Blob: class {
      constructor(parts, opts) {
        this.parts = parts;
        this.type = opts && opts.type;
      }
    },
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    setTimeout: () => 0,
    clearTimeout: () => {}
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(ARCHIVR_SRC, ctx, { filename: "plugins/archivr.js" });
  return { handlers, downloads, badges };
}

function callHandler(handlers, msg) {
  return new Promise((resolve) => {
    let done = false;
    const sendResponse = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    handlers.forEach((h) => h(msg, {}, sendResponse));
    setTimeout(() => {
      if (!done) {
        done = true;
        resolve(null);
      }
    }, 100);
  });
}

test("capture -> list -> getRecords -> download -> clear round-trip", async () => {
  const { handlers, downloads, badges } = loadBackground();
  const ts = Date.now();

  await callHandler(handlers, [
    "archivr:capture",
    {
      url: "https://e.com/a",
      title: "A",
      baseURI: "https://e.com/a",
      html: "<html><body>a</body></html>",
      ts
    }
  ]);

  const list = await callHandler(handlers, ["archivr:list"]);
  assert.equal(list.length, 1);
  assert.equal(list[0].url, "https://e.com/a");

  const dup = await callHandler(handlers, [
    "archivr:capture",
    {
      url: "https://e.com/a",
      title: "A",
      baseURI: "https://e.com/a",
      html: "<html><body>a</body></html>",
      ts: ts + 1000
    }
  ]);
  assert.equal(dup, null, "duplicate within 5s is rejected");

  const records = await callHandler(handlers, ["archivr:getRecords", [list[0].id]]);
  assert.equal(records.length, 1);
  assert.match(records[0].html, /<body>/);

  const payload = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  const dl = await callHandler(handlers, [
    "archivr:download",
    { bytesBase64: Buffer.from(payload).toString("base64"), filename: "a.zip" }
  ]);
  assert.ok(dl && dl.id === 1);
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].filename, "a.zip");
  assert.match(downloads[0].url, /^blob:/);

  const cleared = await callHandler(handlers, ["archivr:clear"]);
  assert.equal(cleared, true);
  const after = await callHandler(handlers, ["archivr:list"]);
  assert.equal(after.length, 0);
  assert.ok(badges.includes(""), "badge cleared on clear");
});
