"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadArchive() {
  const sandbox = {
    window: {},
    location: { protocol: "moz-extension:", pathname: "/popup.html" },
    console,
    browser: {},
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    TextEncoder,
    Uint8Array
  };
  const ctx = vm.createContext(sandbox);
  for (const rel of ["plugins/archivr-zip.js", "plugins/archivr.js"])
    vm.runInContext(fs.readFileSync(path.join(__dirname, "..", rel), "utf8"), ctx, { filename: rel });
  return ctx;
}
const ctx = loadArchive();

// lightweight zip entry-name extractor (central directory walk)
function zipNames(bytes) {
  const u8 = Uint8Array.from(bytes);
  const readU32 = (o) => (u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16) | (u8[o + 3] << 24)) >>> 0;
  const cdOffset = readU32(u8.length - 6);
  const count = u8[u8.length - 14] | (u8[u8.length - 13] << 8);
  const names = [];
  let o = cdOffset;
  for (let i = 0; i < count; i++) {
    const nameLen = u8[o + 28] | (u8[o + 29] << 8);
    const extra = u8[o + 30] | (u8[o + 31] << 8);
    const comment = u8[o + 32] | (u8[o + 33] << 8);
    let name = "";
    for (let j = 0; j < nameLen; j++) name += String.fromCharCode(u8[o + 46 + j]);
    names.push(Buffer.from(name, "latin1").toString("utf8"));
    o += 46 + nameLen + extra + comment;
  }
  return names;
}

test("archiveFilename uses the expected ext267-archive-<stamp>.zip shape", () => {
  assert.match(ctx.archiveFilename(), /^ext267-archive-\d{8}-\d{6}\.zip$/);
});

test("bytesToBase64 round-trips", () => {
  const bytes = new Uint8Array([104, 101, 108, 108, 111]); // "hello"
  assert.equal(ctx.bytesToBase64(bytes), Buffer.from("hello").toString("base64"));
});

test("buildArchive lays out folders, files, manifest, and README", async () => {
  const entries = [
    { url: "https://a.com/page1", title: "Page One", baseURI: "https://a.com/", ts: 1, html: "<h1>1</h1>" },
    { url: "https://a.com/page2", title: "Page One", baseURI: "https://a.com/", ts: 2, html: "<h1>2</h1>" },
    { url: "https://a.com/page3", title: "Three", baseURI: "https://a.com/", ts: 3, html: "<h1>3</h1>" }
  ];
  const opts = {
    dirName: "ext267-archive-00000000-000000",
    serializePage: async (r) => `<html><body data-url="${r.baseURI}">SERIALIZED</body></html>`,
    mdFn: (html) => `# ${html}`
  };
  const bytes = await ctx.buildArchive(entries, async () => null, opts);
  const names = zipNames(bytes);

  assert.ok(names.includes(`ext267-archive-00000000-000000/01 - Page One/index.html`));
  assert.ok(names.includes(`ext267-archive-00000000-000000/01 - Page One/page.md`));
  assert.ok(names.includes(`ext267-archive-00000000-000000/02 - Page One (2)/index.html`));
  assert.ok(names.includes(`ext267-archive-00000000-000000/03 - Three/index.html`));
  assert.ok(names.includes(`ext267-archive-00000000-000000/manifest.json`));
  assert.ok(names.includes(`ext267-archive-00000000-000000/README.txt`));
});

test("buildArchive emits a valid manifest.json with entry metadata", async () => {
  const entries = [{ url: "https://a.com/p", title: "P", baseURI: "https://a.com/", ts: 1, html: "<p>x</p>" }];
  const opts = {
    dirName: "a",
    serializePage: async () => "<html></html>",
    mdFn: () => "# P"
  };
  const bytes = await ctx.buildArchive(entries, async () => null, opts);

  // Extract a named entry's bytes from the archive.
  const readEntry = (targetName) => {
    const u8 = Uint8Array.from(bytes);
    const r16 = (o) => u8[o] | (u8[o + 1] << 8);
    const r32 = (o) => (u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16) | (u8[o + 3] << 24)) >>> 0;
    const cdOffset = r32(u8.length - 6);
    const count = r16(u8.length - 14);
    let o = cdOffset;
    for (let i = 0; i < count; i++) {
      const nameLen = r16(o + 28);
      let name = "";
      for (let j = 0; j < nameLen; j++) name += String.fromCharCode(u8[o + 46 + j]);
      const flags = r16(o + 8);
      if (flags & 0x0800) name = Buffer.from(name, "latin1").toString("utf8");
      if (name === targetName) {
        const method = r16(o + 10);
        const csize = r32(o + 20);
        const localOff = r32(o + 42);
        const dataStart = localOff + 30 + r16(localOff + 26) + r16(localOff + 28);
        const data = u8.subarray(dataStart, dataStart + csize);
        assert.equal(method, 0, "STORE expected");
        return Buffer.from(data);
      }
      o += 46 + nameLen + r16(o + 30) + r16(o + 32);
    }
    throw new Error(`entry not found: ${targetName}`);
  };

  const manifestRaw = readEntry("a/manifest.json").toString("utf8");
  const manifest = JSON.parse(manifestRaw);
  assert.equal(manifest.count, 1);
  assert.equal(manifest.entries[0].url, "https://a.com/p");
  assert.equal(manifest.entries[0].title, "P");
  assert.equal(manifest.entries[0].html, "a/01 - P/index.html");
  assert.ok(typeof manifest.savedAt === "number");
});
