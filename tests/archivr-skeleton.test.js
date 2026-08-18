"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadArchivr(sandbox) {
  const ctx = vm.createContext(sandbox);
  const src = fs.readFileSync(path.join(__dirname, "..", "plugins", "archivr.js"), "utf8");
  vm.runInContext(src, ctx, { filename: "plugins/archivr.js" });
  return ctx;
}

test("archivr registers in popup context", () => {
  const ctx = loadArchivr({
    document: { createElement: () => ({ appendChild() {} }), createTextNode: () => ({}) },
    location: { protocol: "moz-extension:", pathname: "/popup.html" },
    browser: { runtime: { onMessage: { addListener() {} }, onStartup: { addListener() {} } } },
    console
  });
  assert.ok(ctx.Plugins.has("archivr"));
});

test("archivr stays inert in background context and registers no plugin", () => {
  const ctx = loadArchivr({
    browser: { runtime: { onMessage: { addListener() {} }, onStartup: { addListener() {} } }, action: {} },
    console
  });
  assert.equal(ctx.Plugins, undefined);
});

test("archivr background listener only responds to archivr: messages", async () => {
  let captured;
  const runtime = {
    onMessage: {
      addListener(fn) {
        captured = fn;
      }
    },
    onStartup: { addListener() {} }
  };
  loadArchivr({ browser: { runtime, action: {} }, console });
  assert.ok(captured, "background onMessage listener is registered");

  let responded = 0;
  const sendResponse = () => {
    responded++;
  };

  // Non-archivr messages must not be swallowed (cliget depends on this).
  assert.equal(captured(["cliget:getDownloadList"], {}, sendResponse), false);
  assert.equal(captured(["cliget:generateCommand"], {}, sendResponse), false);
  assert.equal(captured("cliget:getDownloadList", {}, sendResponse), false);
  assert.equal(captured([123], {}, sendResponse), false);
  assert.equal(captured([], {}, sendResponse), false);
  assert.equal(responded, 0);

  assert.equal(captured(["archivr:ping"], {}, sendResponse), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(responded, 1);
});

test("archivr-content stays inert in non-page contexts", () => {
  const sandbox = { browser: {}, location: { protocol: "moz-extension:", pathname: "/popup.html" }, console };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "plugins", "archivr-content.js"), "utf8"), ctx, {
    filename: "plugins/archivr-content.js"
  });
  assert.equal(ctx.Plugins, undefined);
});
