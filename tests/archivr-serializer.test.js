"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// ---- minimal fake DOM used by DOM-walking serializer helpers -----------------

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
  elem.createElement = (tagName) => el(tagName);
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
function loadSerializer() {
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
    TextDecoder
  };
  const ctx = vm.createContext(sandbox);
  for (const rel of ["plugins/archivr-libs/parse-srcset.js", "plugins/archivr-libs/uglifycss.js", "plugins/archivr.js"])
    vm.runInContext(fs.readFileSync(path.join(__dirname, "..", rel), "utf8"), ctx, { filename: rel });

  return ctx;
}

const ctx = loadSerializer();

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

test("absolutizeHtml makes src/href/style absolute", () => {
  const doc = fakeDoc();
  const img = el("img", { src: "a.png", style: "background:url(b.png)" });
  doc.body.appendChild(img);
  ctx.absolutizeHtml(doc, "https://e.com/dir/page.html");
  assert.equal(img.getAttribute("src"), "https://e.com/dir/a.png");
  assert.equal(img.getAttribute("style"), 'background:url("https://e.com/dir/b.png")');
});

test("rewriteSrcsets inlines each candidate via parseSrcset", async () => {
  const doc = fakeDoc();
  const img = el("img", { srcset: "img-1x.png 1x, img-2x.png 2x" });
  doc.body.appendChild(img);
  const fetcher = makeFetcher({
    "https://e.com/dir/img-1x.png": { data: "AA==", contentType: "image/png" },
    "https://e.com/dir/img-2x.png": { data: "AA==", contentType: "image/png" }
  });
  await ctx.rewriteSrcsets(doc, "https://e.com/dir/page.html", fetcher, { cache: new Map() });
  const s = img.getAttribute("srcset");
  assert.match(s, /^data:image\/png;base64/);
  assert.ok(s.includes(" 1x,") && s.includes(" 2x"));
});

test("inlineCssFromLinks inlines css and rewrites url() to data URIs", async () => {
  const doc = fakeDoc();
  const link = el("link", { rel: "stylesheet", href: "style.css" });
  doc.head.appendChild(link);
  const fetcher = makeFetcher({
    "https://e.com/dir/style.css": { data: "a{background:url(pic.png)}", contentType: "text/css" },
    "https://e.com/dir/pic.png": { data: "AA==", contentType: "image/png" }
  });
  await ctx.inlineCssFromLinks(doc, "https://e.com/dir/page.html", fetcher, { cache: new Map() });
  const styles = doc.querySelectorAll("style");
  assert.equal(styles.length, 1);
  assert.equal(styles[0].parent === doc.head, true);
  assert.match(styles[0].textContent, /data:image\/png;base64/);
});

test("inlineCssFromLinks recurses into @import", async () => {
  const doc = fakeDoc();
  const link = el("link", { rel: "stylesheet", href: "main.css" });
  doc.head.appendChild(link);
  const fetcher = makeFetcher({
    "https://e.com/dir/main.css": {
      data: "@import url('theme.css'); b{color:red}",
      contentType: "text/css"
    },
    "https://e.com/dir/theme.css": { data: "a{x:y}", contentType: "text/css" }
  });
  await ctx.inlineCssFromLinks(doc, "https://e.com/dir/page.html", fetcher, { cache: new Map() });
  const styles = doc.querySelectorAll("style");
  assert.equal(styles.length, 1);
  assert.ok(styles[0].textContent.includes("a{x:y}"), "imported rules inlined");
  assert.ok(styles[0].textContent.includes("b{color:red}"), "root rules kept");
});

test("inlineCssText terminates on circular @import", async () => {
  const fetcher = makeFetcher({
    "https://e.com/self.css": { data: '@import url("self.css"); a{color:red}', contentType: "text/css" }
  });
  const out = await ctx.inlineCssText('@import url("self.css");', "https://e.com/self.css", fetcher, {
    cache: new Map()
  });
  assert.ok(out.includes("a{color:red}"), "rules inlined despite circular import");
});

test("inlineCssText terminates on mutual @import cycles", async () => {
  const fetcher = makeFetcher({
    "https://e.com/a.css": { data: '@import url("b.css"); a{color:red}', contentType: "text/css" },
    "https://e.com/b.css": { data: '@import url("a.css"); b{color:blue}', contentType: "text/css" }
  });
  const out = await ctx.inlineCssText('@import url("a.css");', "https://e.com/a.css", fetcher, {
    cache: new Map()
  });
  assert.ok(out.includes("a{color:red}"), "cycle a->b->a inlines a's rules");
  assert.ok(out.includes("b{color:blue}"), "cycle a->b->a inlines b's rules");
});

test("inlineCssText preserves @import media conditions", async () => {
  const fetcher = makeFetcher({
    "https://e.com/mobile.css": { data: "b{color:blue}", contentType: "text/css" }
  });
  const out = await ctx.inlineCssText(
    '@import url("mobile.css") screen and (max-width:600px);',
    "https://e.com/mobile.css",
    fetcher,
    { cache: new Map() }
  );
  assert.ok(out.includes("@media screen and (max-width:600px)"), "condition preserved via @media wrap");
  assert.ok(out.includes("b{color:blue}"), "imported rules wrapped");
});

test("inlineCssText leaves commented-out @import untouched", async () => {
  const fetcher = makeFetcher({
    "https://e.com/x.css": { data: "never{appear:true}", contentType: "text/css" }
  });
  const out = await ctx.inlineCssText('/* @import url("x.css"); */', "https://e.com/x.css", fetcher, {
    cache: new Map()
  });
  assert.ok(out.includes("@import"), "commented import statement retained");
  assert.ok(!out.includes("never{appear:true}"), "commented import not inlined");
});

test("inlineImgs inlines img[src] and removes data-src wrapper", async () => {
  const doc = fakeDoc();
  const img = el("img", { src: "https://e.com/pic.png", "data-src": "https://e.com/pic.png" });
  doc.body.appendChild(img);
  const fetcher = makeFetcher({
    "https://e.com/pic.png": { data: "AA==", contentType: "image/png" }
  });
  await ctx.inlineImgs(doc, "https://e.com/pic.png", fetcher, { cache: new Map() });
  assert.match(img.getAttribute("src"), /^data:image\/png;base64/);
  assert.equal(img.hasAttribute("data-src"), false);
});

test("stripScripts removes scripts and on* attributes", () => {
  const doc = fakeDoc();
  const s = el("script", { src: "https://e.com/x.js" });
  const a = el("a", { href: "javascript:void(0)", onclick: "steal()" });
  doc.body.appendChild(s);
  doc.body.appendChild(a);
  ctx.stripScripts(doc);
  assert.equal(doc.querySelectorAll("script").length, 0);
  assert.equal(a.hasAttribute("onclick"), false);
  assert.equal(a.hasAttribute("href"), false);
});

test("assetToDataUri caches per URL and falls back to the original URL", async () => {
  const fetcher = makeFetcher({});
  const state = { cache: new Map() };
  const r1 = await ctx.assetToDataUri("https://e.com/gone.png", fetcher, state);
  assert.equal(r1, "https://e.com/gone.png"); // fetch failed -> original URL
  assert.equal(state.cache.get("https://e.com/gone.png"), "https://e.com/gone.png");
});

test("serializePage produces pristine output with inlined assets", async () => {
  const doc = fakeDoc();
  const link = el("link", { rel: "stylesheet", href: "style.css" });
  doc.head.appendChild(link);
  doc.body.appendChild(el("img", { src: "pic.png", "data-src": "pic.png" }));
  doc.body.appendChild(el("script", { src: "x.js" }));
  doc.body.appendChild(el("a", { href: "javascript:void(0)", onclick: "steal()" }));
  pendingDoc = doc;
  const fetcher = makeFetcher({
    "https://e.com/dir/style.css": { data: "a{background:url(p.png)}", contentType: "text/css" },
    "https://e.com/dir/p.png": { data: "AA==", contentType: "image/png" },
    "https://e.com/dir/pic.png": { data: "AA==", contentType: "image/png" }
  });
  const out = await ctx.serializePage({ html: "<html></html>", baseUri: "https://e.com/dir/page.html" }, fetcher);
  assert.match(out, /^<!DOCTYPE html>\n/);
  assert.ok(out.includes('<base href="https://e.com/dir/page.html">'), "base element inserted");
  assert.match(out, /data:image\/png;base64/, "css + img assets inlined");
  assert.ok(!out.includes("<script"), "scripts stripped");
  assert.ok(!out.includes("onclick"), "on* attributes stripped");
  assert.ok(!out.includes("javascript:void"), "javascript: href stripped");
  assert.ok(!out.includes('<link rel="stylesheet"'), "link replaced by inline style");
});
