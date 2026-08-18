"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const ARCHIVR = fs.readFileSync(path.join(ROOT, "plugins", "archivr.js"), "utf8");

// cliget.js declares `const ext` / `const extAction` at file top level. Classic
// (non-module) scripts share one global lexical environment, so if archivr.js
// also declared those names the SECOND script parsed would throw
// `SyntaxError: Identifier 'ext' has already been declared` and its plugin
// would never register. These tests evaluate both plugins in ONE shared vm
// context in the real popup and background load orders and assert the
// collision is gone.
function loadTogether(scripts, sandbox) {
  const ctx = vm.createContext(sandbox);
  for (const rel of scripts) vm.runInContext(fs.readFileSync(path.join(ROOT, rel), "utf8"), ctx, { filename: rel });
  return ctx;
}

function callHandlers(handlers, msg) {
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

test("popup order (archivr.js then cliget.js) parses and registers both plugins", () => {
  const ctx = loadTogether(["plugins/archivr.js", "plugins/cliget.js"], {
    window: {},
    location: { protocol: "moz-extension:", pathname: "/popup.html" },
    browser: {
      runtime: { onMessage: { addListener() {} }, sendMessage: async () => null },
      action: { setBadgeText: async () => {} },
      storage: { local: { get: async () => ({}), set: async () => {} } }
    },
    console
  });
  assert.ok(ctx.Plugins.has("archivr"), "archivr registered");
  assert.ok(ctx.Plugins.has("cliget"), "cliget registered (no duplicate const ext collision)");
});

test("background order (cliget.js then archivr.js) parses and both message namespaces respond", async () => {
  const handlers = [];
  const noop = () => {};
  const api = {
    runtime: {
      onMessage: {
        addListener(fn) {
          handlers.push(fn);
        }
      },
      onStartup: { addListener: noop }
    },
    action: {
      setBadgeText: async () => {},
      setBadgeBackgroundColor: async () => {},
      getBadgeText: async () => ""
    },
    webRequest: {
      onBeforeRequest: { addListener: noop },
      onSendHeaders: { addListener: noop },
      onResponseStarted: { addListener: noop },
      onBeforeRedirect: { addListener: noop },
      onErrorOccurred: { addListener: noop }
    },
    storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
    downloads: { download: async () => 1 }
  };

  // Grab a memory store via a throwaway probe load (same pattern as the
  // integration test) so the archivr background listener can answer
  // archivr:list without IndexedDB.
  const probeApi = {
    runtime: { onMessage: { addListener: noop }, onStartup: { addListener: noop } },
    action: {},
    storage: { local: { get: async () => ({}), set: async () => {} } }
  };
  const probe = vm.createContext({ browser: probeApi, console, __archivrTest: {} });
  vm.runInContext(ARCHIVR, probe, { filename: "plugins/archivr.js" });
  const memoryStore = probe.__archivrTest.createMemoryStore();

  const sandbox = {
    browser: api,
    console,
    __archivrTest: { store: memoryStore },
    URL: { createObjectURL: () => "blob:mock", revokeObjectURL: () => {} },
    Blob: class {},
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    setTimeout: () => 0,
    clearTimeout: () => {}
  };
  const ctx = loadTogether(["plugins/cliget.js", "plugins/archivr.js"], sandbox);
  assert.ok(ctx.Plugins.has("cliget"), "cliget registers in background too");

  const dl = await callHandlers(handlers, ["cliget:getDownloadList"]);
  assert.deepEqual([...dl], [], "cliget:getDownloadList answered by cliget listener");
  const list = await callHandlers(handlers, ["archivr:list"]);
  assert.deepEqual([...list], [], "archivr:list answered by archivr listener");
});
