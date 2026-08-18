"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// ---- minimal fake DOM used by the serializer-path archive test ----------------

function matchesSelector(node, sel) {
  const attrIdx = sel.indexOf("[");
  const tag = attrIdx === -1 ? sel : sel.slice(0, attrIdx);
  if (tag && tag !== "*" && tag !== node.tag) return false;
  if (attrIdx === -1) return true;
  const attrSel = sel.slice(attrIdx + 1, sel.lastIndexOf("]"));
  for (const part of attrSel.split("][")) {
    const eq = part.indexOf("=");
    if (eq === -1) {
      if (!node.hasAttribute(part)) return false;
    } else {
      const name = part.slice(0, eq);
      const value = part.slice(eq + 1).replace(/^["']|["']$/g, "");
      if (node.getAttribute(name) !== value) return false;
    }
  }
  return true;
}

function el(tag, attrs = {}) {
  const elem = {
    tag,
    attrs: Object.assign({}, attrs),
    children: [],
    parent: null,
    getAttribute(name) {
      return name in this.attrs ? this.attrs[name] : null;
    },
    setAttribute(name, value) {
      if (value === null || value === undefined) return;
      this.attrs[name] = String(value);
    },
    removeAttribute(name) {
      delete this.attrs[name];
    },
    hasAttribute(name) {
      return name in this.attrs;
    },
    remove() {
      if (this.parent) {
        const i = this.parent.children.indexOf(this);
        if (i !== -1) this.parent.children.splice(i, 1);
      }
    },
    insertBefore(node, ref) {
      node.remove();
      node.parent = this;
      const i = this.children.indexOf(ref);
      this.children.splice(i === -1 ? 0 : i, 0, node);
      return node;
    },
    appendChild(node) {
      node.remove();
      node.parent = this;
      this.children.push(node);
      return node;
    },
    querySelectorAll(sel) {
      const out = [];
      const selectors = sel.split(",").map((s) => s.trim());
      const matches = (n) => selectors.some((s) => matchesSelector(n, s));
      const walk = (n) => {
        if (matches(n)) out.push(n);
        n.children.forEach(walk);
      };
      walk(this);
      return out;
    },
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] || null;
    },
    get attributes() {
      return Object.entries(this.attrs).map(([name, value]) => ({ name, value }));
    },
    get parentNode() {
      return this.parent;
    },
    get firstChild() {
      return this.children[0] || null;
    },
    get outerHTML() {
      const body = this.children.map((c) => c.outerHTML || c.textContent || "").join("");
      return `<${this.tag}${Object.entries(this.attrs)
        .map(([k, v]) => ` ${k}="${String(v).replace(/"/g, "&quot;")}"`)
        .join("")}>${body}</${this.tag}>`;
    }
  };
  return elem;
}

function fakeDoc() {
  const head = el("head");
  const body = el("body");
  const root = el("html", {});
  root.appendChild(head);
  root.appendChild(body);
  const doc = { documentElement: root, head, body };
  doc.querySelectorAll = (sel) => root.querySelectorAll(sel);
  doc.querySelector = (sel) => root.querySelectorAll(sel)[0] || null;
  doc.createElement = (tag) => el(tag);
  return doc;
}

let pendingDoc = null;
function loadArchive() {
  const sandbox = {
    window: {},
    location: { protocol: "moz-extension:", pathname: "/popup.html" },
    console,
    browser: {},
    URL,
    DOMParser: class {
      parseFromString(src) {
        const doc = pendingDoc || fakeDoc();
        pendingDoc = null;
        doc._src = src;
        return doc;
      }
    },
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    TextEncoder,
    TextDecoder,
    Uint8Array
  };
  const ctx = vm.createContext(sandbox);
  for (const rel of [
    "plugins/archivr-libs/parse-srcset.js",
    "plugins/archivr-libs/uglifycss.js",
    "plugins/archivr-zip.js",
    "plugins/archivr.js"
  ])
    vm.runInContext(fs.readFileSync(path.join(__dirname, "..", rel), "utf8"), ctx, { filename: rel });
  return ctx;
}
const ctx = loadArchive();

function makeFetcher(map) {
  const fetchMap = new Map(Object.entries(map));
  return async (url) => {
    const entry = fetchMap.get(url);
    if (entry === undefined) return null;
    return {
      ok: true,
      headers: { get: () => entry.contentType || null },
      async text() {
        return typeof entry.data === "string" ? entry.data : new TextDecoder().decode(entry.data);
      },
      async arrayBuffer() {
        return typeof entry.data === "string" ? new TextEncoder().encode(entry.data).buffer : entry.data.buffer;
      }
    };
  };
}

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

// extract a named entry's raw bytes from a STORE-only zip (central directory walk)
function zipEntryData(bytes, targetName) {
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

  const manifestRaw = zipEntryData(bytes, "a/manifest.json").toString("utf8");
  const manifest = JSON.parse(manifestRaw);
  assert.equal(manifest.count, 1);
  assert.equal(manifest.entries[0].url, "https://a.com/p");
  assert.equal(manifest.entries[0].title, "P");
  assert.equal(manifest.entries[0].html, "a/01 - P/index.html");
  assert.ok(typeof manifest.savedAt === "number");
});

test("buildArchive default serializer passes baseUri and inlines assets", async () => {
  const doc = fakeDoc();
  const link = el("link", { rel: "stylesheet", href: "style.css" });
  doc.head.appendChild(link);
  doc.body.appendChild(el("img", { src: "pic.png", "data-src": "pic.png" }));
  pendingDoc = doc;
  const fetcher = makeFetcher({
    "https://a.com/dir/style.css": { data: "a{background:url(p.png)}", contentType: "text/css" },
    "https://a.com/dir/p.png": { data: "AA==", contentType: "image/png" },
    "https://a.com/dir/pic.png": { data: "AA==", contentType: "image/png" }
  });
  const entries = [
    { url: "https://a.com/page", title: "P", baseURI: "https://a.com/dir/page.html", ts: 1, html: "<html></html>" }
  ];

  // No serializePage injected: buildArchive must use the real serializePage and
  // pass baseUri so relative assets are absolutized against the entry baseURI.
  const bytes = await ctx.buildArchive(entries, fetcher, { dirName: "a", mdFn: () => "# P" });
  const html = zipEntryData(bytes, "a/01 - P/index.html").toString("utf8");

  assert.ok(html.includes('<base href="https://a.com/dir/page.html">'), "base element uses the entry baseURI");
  assert.ok(!html.includes('href="undefined"'), "base element must not render as undefined");
  assert.match(html, /data:image\/png;base64/, "relative img and css url() inlined as data URIs");
  assert.ok(!html.includes('src="pic.png"'), "relative img src replaced by its data URI");
  assert.ok(!html.includes('<link rel="stylesheet"'), "stylesheet link replaced by an inline style");
});
