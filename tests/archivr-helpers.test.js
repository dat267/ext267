"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadHelpers() {
  const sandbox = { browser: {}, window: {}, location: { protocol: "moz-extension:", pathname: "/popup.html" }, URL };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "plugins", "archivr.js"), "utf8"), ctx, {
    filename: "plugins/archivr.js"
  });
  return ctx;
}

const g = loadHelpers();

test("cleanName sanitizes titles into safe folder names", () => {
  assert.equal(g.cleanName("Hello World"), "Hello World");
  assert.equal(g.cleanName('a/b\\c:d*e?f"g<h>i|j'), "a b c d e f g h i j");
  assert.equal(g.cleanName("  padded  "), "padded");
  assert.equal(g.cleanName("\u0000control\u0001"), "control");
  assert.equal(g.cleanName("   "), "untitled");
});

test("uniqueNames dedupes colliding folder names", () => {
  assert.deepEqual(g.uniqueNames(["a", "a", "b"]), ["a", "a (2)", "b"]);
  assert.deepEqual(g.uniqueNames(["a (2)", "a"]), ["a (2)", "a"]);
  assert.deepEqual(g.uniqueNames([]), []);
});

test("absolutizeUrlStr resolves all relative forms", () => {
  const base = "https://example.com/dir/page.html";
  assert.equal(g.absolutizeUrlStr("img.png", base), "https://example.com/dir/img.png");
  assert.equal(g.absolutizeUrlStr("/img.png", base), "https://example.com/img.png");
  assert.equal(g.absolutizeUrlStr("//cdn.example.com/x.png", base), "https://cdn.example.com/x.png");
  assert.equal(g.absolutizeUrlStr("https://other.com/x.png", base), "https://other.com/x.png");
  assert.equal(g.absolutizeUrlStr("data:image/png;base64,AAA", base), "data:image/png;base64,AAA");
  assert.equal(g.absolutizeUrlStr("", base), "");
  assert.equal(g.absolutizeUrlStr("mailto:a@b.c", base), "mailto:a@b.c");
});

test("extractCssUrls finds url() tokens in CSS text", () => {
  const css =
    "a { background: url('img/a.png'); } b { background: url(\"b.png\"); } " +
    "@font-face { src: url(font.woff2) format('woff2'); } c { x: url(nonexistent); }";
  const urls = g.extractCssUrls(css);
  assert.ok(
    urls.includes("img/a.png") && urls.includes("b.png") && urls.includes("font.woff2") && urls.includes("nonexistent")
  );
});

test("extractCssUrls caps tokens to avoid pathological pages", () => {
  const urls = g.extractCssUrls("a { background: url(x.png); }".repeat(600));
  assert.ok(urls.length <= 500);
});

test("sniffMime picks a data-URI mime", () => {
  assert.equal(g.sniffMime("https://e.com/a.png", "image/png"), "image/png");
  assert.equal(g.sniffMime("https://e.com/a.svg", "text/html; charset=utf-8"), "text/html");
  assert.equal(g.sniffMime("https://e.com/font.woff2", ""), "font/woff2");
  assert.equal(g.sniffMime("https://e.com/a", "text/css"), "text/css");
  assert.equal(g.sniffMime("https://e.com/a.txt", ""), "text/plain");
});

test("formatSize and formatRelativeTime", () => {
  assert.equal(g.formatSize(0), "0.0 B");
  assert.equal(g.formatSize(2048), "2.0 KB");
  assert.match(g.formatRelativeTime(Date.now()), /just now/);
});
