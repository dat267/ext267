"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function loadContent(sandbox) {
  sandbox = Object.assign({ browser: {}, console, setTimeout }, sandbox);
  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "plugins", "archivr-content.js"), "utf8"), ctx, {
    filename: "plugins/archivr-content.js"
  });
  return ctx;
}

function makeDoc(overrides) {
  return Object.assign(
    {
      baseURI: "https://example.com/",
      title: "Page Title",
      documentElement: { outerHTML: "<html><body>content</body></html>" },
      body: { textContent: "content" }
    },
    overrides
  );
}

test("shouldCapture accepts only populated http/https pages", () => {
  const ctx = loadContent({});
  assert.equal(ctx.shouldCapture({ protocol: "http:", title: "T", html: "<html><body><b>hi</b></body></html>" }), true);
  assert.equal(ctx.shouldCapture({ protocol: "https:", title: "T", html: "<html><body><p>x</p></body></html>" }), true);
  assert.equal(
    ctx.shouldCapture({ protocol: "file:", title: "T", html: "<html><body><b>hi</b></body></html>" }),
    false
  );
  assert.equal(ctx.shouldCapture({ protocol: "http:", title: "", html: "" }), false);
  assert.equal(ctx.shouldCapture({ protocol: "http:", title: "Blank", html: "<html><body></body></html>" }), false);
});

test("shouldCapture rejects body noise (whitespace-only or tag-only pages)", () => {
  const ctx = loadContent({});
  assert.equal(ctx.shouldCapture({ protocol: "http:", title: "T", html: "<html><body>  \n\t </body></html>" }), false);
  assert.equal(
    ctx.shouldCapture({ protocol: "http:", title: "T", html: "<html><body><div></div></body></html>" }),
    false
  );
});

test("extractSnapshot returns the required capture payload", () => {
  const ctx = loadContent({});
  const shot = ctx.extractSnapshot(makeDoc());
  assert.equal(shot.url, "https://example.com/");
  assert.equal(shot.title, "Page Title");
  assert.equal(shot.baseURI, "https://example.com/");
  assert.equal(shot.html, "<html><body>content</body></html>");
  assert.equal(typeof shot.ts, "number");
});

test("armSpaCapture re-arms on events and disarms cleanly", async () => {
  const ctx = loadContent({});
  const listeners = {};
  const windowStub = {
    addEventListener(type, fn) {
      listeners[type] = fn;
    },
    removeEventListener(type) {
      delete listeners[type];
    }
  };
  let captures = 0;
  const disarm = ctx.armSpaCapture(windowStub, null, () => {
    captures++;
  });
  listeners.popstate();
  await tick(450);
  assert.equal(captures, 1);
  listeners.popstate();
  await tick(450);
  assert.equal(captures, 2);
  disarm();
  assert.equal(listeners.popstate, undefined);
  await tick(450);
  assert.equal(captures, 2);
});
