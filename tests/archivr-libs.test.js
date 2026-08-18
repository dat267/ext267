"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");

function runVendor(output, globalName) {
  const ctx = vm.createContext({});
  vm.runInContext(fs.readFileSync(output, "utf8"), ctx, { filename: output });
  return ctx[globalName];
}

function loadArchivrLibs() {
  const sandbox = {
    window: {},
    location: { protocol: "moz-extension:", pathname: "/popup.html" },
    document: {}
  };
  const ctx = vm.createContext(sandbox);
  for (const rel of [
    "plugins/archivr-libs/parse-srcset.js",
    "plugins/archivr-libs/uglifycss.js",
    "plugins/archivr-libs/turndown.js",
    "plugins/archivr-libs/turndown-plugin-gfm.js"
  ])
    vm.runInContext(fs.readFileSync(path.join(__dirname, "..", rel), "utf8"), ctx, { filename: rel });

  return ctx;
}

test("vendor-cjs wraps a CommonJS module as a global", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vendor-"));
  const input = path.join(dir, "mod.js");
  const output = path.join(dir, "mod-out.js");
  fs.writeFileSync(input, 'module.exports = function greet() { return "hi"; };');
  execFileSync(process.execPath, [path.join(__dirname, "..", "tools", "vendor-cjs.js"), input, output, "greet"], {
    cwd: path.join(__dirname, "..")
  });
  assert.equal(runVendor(output, "greet")(), "hi");
});

test("vendored libs expose expected globals", () => {
  const ctx = loadArchivrLibs();
  assert.equal(typeof ctx.parseSrcset, "function");
  assert.equal(typeof ctx.UglifyCSS, "function");
  assert.equal(typeof ctx.TurndownService, "function");
  assert.equal(typeof ctx.turndownPluginGfm, "function");
});

test("parseSrcset parses an x-descriptor srcset", () => {
  const ctx = loadArchivrLibs();
  assert.deepEqual(Array.from(ctx.parseSrcset("img-1x.png 1x, img-2x.png 2x").map((e) => e.url)), [
    "img-1x.png",
    "img-2x.png"
  ]);
});

test("UglifyCSS minifies and preserves url() tokens", () => {
  const ctx = loadArchivrLibs();
  const css = "a { color: red; background-image: url('img.png'); }";
  assert.equal(ctx.UglifyCSS.processString(css), "a{color:red;background-image:url('img.png')}");
});

test("TurndownService converts basic HTML to markdown", () => {
  const ctx = loadArchivrLibs();
  const md = new ctx.TurndownService().turndown("<h1>Title</h1><p>Body text</p>");
  assert.match(md, /^# Title\n\nBody text/);
});
