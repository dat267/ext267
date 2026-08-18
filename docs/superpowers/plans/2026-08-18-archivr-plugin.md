# Archivr Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a self-contained `archivr` plugin to ext267 that auto-captures every browsed page (session-only) and bulk-saves selected pages as one ZIP containing self-contained HTML (SingleFile-style inline resources) + Markdown.

**Architecture:** A content script (`plugins/archivr-content.js`) snapshots each page's raw HTML to the background, which persists records in IndexedDB (cleared on browser startup). The **popup** (which has a DOM and `<all_urls>` host permission) performs the save pipeline at click-time: parse HTML with `DOMParser`, inline resources as `data:` URIs via `fetch` + vendored parsers, convert to Markdown with Turndown, pack with a custom STORE-only ZIP writer, and download via the `downloads` API.

**Tech Stack:** Plain JS, MV3, `node:test` + `vm` test harness (no new npm runtime deps; vendored libs committed under `plugins/archivr-libs/`).

## Global Constraints

- Manifest V3; Firefox 142+ (gecko id `ext267@dat267.github.io`), Chrome MV3.
- Plain JavaScript; no Babel/TypeScript/webpack. Source stays readable for AMO review.
- Cross-browser: every API call uses `const ext = typeof browser !== "undefined" ? browser : chrome;` at file top.
- Plugin id `archivr`, display name `Archiver`. Message namespace prefix `archivr:`.
- Session-only retention: captures cleared on `ext.runtime.onStartup` (once per browser launch, NOT on worker spin-up).
- No new permissions. Current manifest already has `webRequest`, `storage`, `tabs`, `downloads`, and `<all_urls>`.
- Generated HTML must be self-contained: resources inlined as `data:` URIs, `<script>` tags and `on*`/`href="javascript:"` attributes stripped, `<base href={baseURI}>` inserted.
- ZIP uses STORE (no compression); download via `ext.downloads.download`.
- Vendored libs are committed physically under `plugins/archivr-libs/` with original MIT license headers. No external URLs loaded at runtime, no git submodules.
- No `innerHTML` for user-visible/dynamic content; build DOM with `document.createElement`/`textContent` (AGENTS.md).
- `npx eslint .` and `npm run lint` (web-ext) must stay clean; `npm test` (node:test, run from repo root) must pass.

## Documented Deviations From the Spec

1. **Save pipeline lives in the popup, not background.** The spec said the save pipeline runs in the background, but Turndown and HTML rewriting need a DOM, which a background worker/page does not have. The popup is open during a save (user clicked Save), has a DOM, and retains `<all_urls>` host permission for resource fetches. The background only stores records and handles messages. Consequence: the vendored libs are loaded in the popup only; `background.scripts` lists just `plugins/archivr.js`.
2. **parse-css-font dropped.** Its dependency tree (7 packages) makes clean vendoring impractical; a custom `url()` extractor inside CSS text covers `@font-face src` without font-shorthand handling (YAGNI for v1).
3. **whatwg-mimetype dropped.** Replaced with a ~20-line custom `sniffMime(url, contentType)` helper (data-URI MIME selection).

## File Structure

- `plugins/archivr.js` — background (store + message handlers + badge) AND popup (render UI + save pipeline) via context detection.
- `plugins/archivr-content.js` — content script: snapshot extraction, SPA re-arm, noise filters, toggle check.
- `plugins/archivr-zip.js` — pure STORE-only ZIP writer (global `zipBytes`), loaded in popup + tests.
- `plugins/archivr-libs/parse-srcset.js` — vendored (global `parseSrcset`).
- `plugins/archivr-libs/uglifycss.js` — vendored (global `UglifyCSS`).
- `plugins/archivr-libs/turndown.js` — vendored (global `TurndownService`).
- `plugins/archivr-libs/turndown-plugin-gfm.js` — vendored (global `turndownPluginGfm`).
- `tools/vendor-cjs.js` — dev-time script converting a CommonJS file into a global-attaching browser script.
- `manifest.json` — `content_scripts` + `background.scripts` entry.
- `popup.html` — archives lib `<script>` tags + `archivr-zip.js` + `archivr.js` before `popup.js`.
- `tests/archivr-*.test.js` — unit tests (node:test + vm harness per `tests/cliget.test.js`).
- `README.md` — add Archivr to the plugin list.

### Key interfaces (cross-task contracts)

Background message protocol (array-first, matching cliget):
- content → background: `["archivr:capture", { url, title, baseURI, html, ts }]`
- popup → background: `["archivr:list"]` → `[{ id, url, title, ts, size }]` (newest first, max 300)
- popup → background: `["archivr:getRecords", ids]` → `[{ id, url, title, baseURI, ts, html }]`
- popup → background: `["archivr:clear"]` → `true`
- popup → background: `["archivr:download", { bytesBase64, filename }]` → downloads it and responds with the final filename.

Store backend interface (background, Task 5):
- `createMemoryStore()` and `createIdbStore(dbName)` both return `{ add(rec) -> Promise<number|null>, list() -> Promise<Array>, getByIds(ids) -> Promise<Array>, clear() -> Promise<void>, count() -> Promise<number> }`. `add` returns null when the URL equals the newest record's URL and `|ts diff| < 5000`. `list` omits the `html` payload.

Serializer (popup, Task 6) interfaces:
- `serializePage({ html, baseUri }, fetcher) -> Promise<string>` — fetcher: `async (url) => ({ ok, status, headers, arrayBuffer })` (in tests, a `Map<url, Uint8Array>` stub).
- `parseHtml(html, parser)` where `parser` is DOMParser-like; `absolutizeHtml(doc, baseUri)`; `rewriteSrcsets(doc, baseUri, state)`; `inlineCssFromLinks(doc, fetcher, state)`; `inlineImgs(doc, fetcher, state)`; `stripScripts(doc)`; `toHtml(doc) -> string`.

Zip writer (popup + tests, Task 3): `zipBytes(files) -> Uint8Array` where `files = [{ name, data: string|Uint8Array }]`.

Markdown (popup, Task 7): `htmlToMarkdown(html) -> string` using `TurndownService` + `turndownPluginGfm`.

---

### Task 1: Vendor libraries, wire manifest, plugin skeleton

**Files:**
- Create: `tools/vendor-cjs.js`, `plugins/archivr.js`, `plugins/archivr-content.js`, `plugins/archivr-libs/parse-srcset.js`, `plugins/archivr-libs/uglifycss.js`, `plugins/archivr-libs/turndown.js`, `plugins/archivr-libs/turndown-plugin-gfm.js`, `tests/archivr-libs.test.js`, `tests/archivr-skeleton.test.js`
- Modify: `manifest.json`, `popup.html`

- [ ] **Step 1: Write the dev-time CJS→global vendoring script**

`tools/vendor-cjs.js` (run as `node tools/vendor-cjs.js <input> <output> <globalName>`). It reads CJS source, wraps it so `module`/`exports`/`require` exist locally, and attaches the export to `globalThis[globalName]`:

```js
#!/usr/bin/env node
"use strict";

const fs = require("node:fs");

const [,, input, output, globalName] = process.argv;
if (!input || !output || !globalName) {
  console.error("usage: node tools/vendor-cjs.js <input.js> <output.js> <globalName>");
  process.exit(1);
}

const src = fs.readFileSync(input, "utf8");
const wrapped = `/* Vendored for archivr. Generated by tools/vendor-cjs.js. */\n` +
  `(function (global) {\n` +
  `  "use strict";\n` +
  `  var module = { exports: {} };\n` +
  `  var exports = module.exports;\n` +
  `  var require = function () { throw new Error("require() unavailable for vendored module"); };\n` +
  `  (function (module, exports, require) {\n` +
  `    ${src.replaceAll("`", "\\`")}\n` +
  `  })(module, exports, require);\n` +
  `  global[${JSON.stringify(globalName)}] = module.exports;\n` +
  `})(typeof globalThis !== "undefined" ? globalThis : this);\n`;
fs.writeFileSync(output, wrapped);
```

- [ ] **Step 2: Write the vendoring + libs test**

`tests/archivr-libs.test.js`:

```js
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
  ]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "..", rel), "utf8"), ctx, { filename: rel });
  }
  return ctx;
}

test("vendor-cjs wraps a CommonJS module as a global", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vendor-"));
  const input = path.join(dir, "mod.js");
  const output = path.join(dir, "mod-out.js");
  fs.writeFileSync(input, 'module.exports = function greet() { return "hi"; };');
  execFileSync(
    process.execPath,
    [path.join(__dirname, "..", "tools", "vendor-cjs.js"), input, output, "greet"],
    { cwd: path.join(__dirname, "..") }
  );
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
  assert.deepEqual(ctx.parseSrcset("img-1x.png 1x, img-2x.png 2x").map((e) => e.url), [
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
```

- [ ] **Step 3: Run tests, verify they fail (missing files)**

Run: `node --test tests/archivr-libs.test.js`
Expected: FAIL — files do not exist yet.

- [ ] **Step 4: Vendor the four libraries**

```bash
mkdir -p /tmp/opencode/archivr-vendor && cd /tmp/opencode/archivr-vendor
npm pack parse-srcset uglifycss turndown turndown-plugin-gfm
for t in *.tgz; do mkdir -p "${t%.tgz}" && tar -xzf "$t" -C "${t%.tgz}" --strip-components=1; done
# Extracted layout (verify with `find . -maxdepth 3 -type f | sort`):
#   parse-srcset/src/parse-srcset.js   (CJS, standalone)
#   uglifycss/index.js                 (CJS, standalone)
#   turndown/dist/turndown.js          (UMD -> globalThis.TurndownService)
#   turndown-plugin-gfm/dist/turndown-plugin-gfm.js (UMD)
```

Fallback if `turndown/dist/turndown.js` is missing: use `lib/turndown.cjs.js`, vendor `@mixmark-io/domino` the same way (npm pack, vendor-cjs, global `domino`), and patch the turndown CJS file's `require("@mixmark-io/domino")` to read the `domino` global. The Turndown test above must pass without a real DOM.

```bash
mkdir -p plugins/archivr-libs
node tools/vendor-cjs.js /tmp/opencode/archivr-vendor/parse-srcset/src/parse-srcset.js \
  plugins/archivr-libs/parse-srcset.js parseSrcset
cp /tmp/opencode/archivr-vendor/parse-srcset/LICENSE plugins/archivr-libs/PARSE-SRCSET-LICENSE
node tools/vendor-cjs.js /tmp/opencode/archivr-vendor/uglifycss/index.js \
  plugins/archivr-libs/uglifycss.js UglifyCSS
cp /tmp/opencode/archivr-vendor/uglifycss/LICENSE.txt plugins/archivr-libs/UGLIFY-CSS-LICENSE
cp /tmp/opencode/archivr-vendor/turndown/dist/turndown.js plugins/archivr-libs/turndown.js
cp /tmp/opencode/archivr-vendor/turndown/LICENSE plugins/archivr-libs/TURNDOWN-LICENSE
cp /tmp/opencode/archivr-vendor/turndown-plugin-gfm/dist/turndown-plugin-gfm.js \
  plugins/archivr-libs/turndown-plugin-gfm.js
cp /tmp/opencode/archivr-vendor/turndown-plugin-gfm/LICENSE plugins/archivr-libs/TURNDOWN-PLUGIN-GFM-LICENSE
# Add a one-line license header to each wrapped output's top (keep the original license files).
```

- [ ] **Step 5: Run tests, verify they pass**

Run: `node --test tests/archivr-libs.test.js`
Expected: all pass.

- [ ] **Step 6: Wire the manifest and popup.html**

`manifest.json` — add content script; add archivr to background.scripts (background loads NO vendored libs):

```jsonc
  "content_scripts": [
    {
      "matches": ["http://*/*", "https://*/*"],
      "js": ["plugins/archivr-content.js"],
      "run_at": "document_idle"
    }
  ],
  "background": {
    "scripts": [
      "plugins/cliget.js",
      "plugins/archivr.js"
    ]
  },
```

`popup.html` — add before the `popup.js` script tag:

```html
  <script src="plugins/archivr-libs/parse-srcset.js" charset="utf-8"></script>
  <script src="plugins/archivr-libs/uglifycss.js" charset="utf-8"></script>
  <script src="plugins/archivr-libs/turndown.js" charset="utf-8"></script>
  <script src="plugins/archivr-libs/turndown-plugin-gfm.js" charset="utf-8"></script>
  <script src="plugins/archivr.js" charset="utf-8"></script>
```

- [ ] **Step 7: Create the plugin skeleton with context detection**

`plugins/archivr-content.js`:

```js
"use strict";

const ext = typeof browser !== "undefined" ? browser : chrome;

const isContentScript = typeof window !== "undefined" && typeof location !== "undefined" &&
  (location.protocol === "http:" || location.protocol === "https:");

// Content-script logic is added in Task 4. This guard keeps the file inert
// if it is ever loaded in a non-page context.
if (isContentScript) {
  void ext;
}
```

`plugins/archivr.js`:

```js
"use strict";

const ext = typeof browser !== "undefined" ? browser : chrome;
const extAction = ext.action || ext.browserAction;

// Context detection:
// - background: Chrome MV3 has no window; Firefox event page has window but its
//   pathname is NOT the popup.
// - content: page protocol (http/https). The popup protocol is moz-/chrome-extension.
// - popup: everything else (popup.html).
const isPopup = typeof window !== "undefined" && typeof location !== "undefined" &&
  location.pathname.endsWith("/popup.html");
const isContentScript = typeof window !== "undefined" && typeof location !== "undefined" &&
  (location.protocol === "http:" || location.protocol === "https:");
const isBackground = !isPopup && !isContentScript;

if (isBackground) {
  ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    void sender;
    sendResponse(null);
  });
  if (ext.runtime.onStartup) ext.runtime.onStartup.addListener(() => {});
}

if (!isContentScript) {
  globalThis.Plugins = globalThis.Plugins || new Map();
  if (typeof globalThis.registerPlugin !== "function")
    globalThis.registerPlugin = function (plugin) {
      globalThis.Plugins.set(plugin.id, plugin);
    };

  globalThis.registerPlugin({
    id: "archivr",
    name: "Archiver",
    defaultOptions: { enabled: false },
    render: async function (panel, context) {
      void context;
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "Archivr is not implemented yet.";
      panel.appendChild(empty);
    }
  });
}
```

- [ ] **Step 8: Write the context-detection test**

`tests/archivr-skeleton.test.js`:

```js
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

test("archivr-content stays inert in non-page contexts", () => {
  const sandbox = { browser: {}, location: { protocol: "moz-extension:", pathname: "/popup.html" }, console };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "..", "plugins", "archivr-content.js"), "utf8"),
    ctx,
    { filename: "plugins/archivr-content.js" }
  );
  assert.equal(ctx.Plugins, undefined);
});
```

- [ ] **Step 9: Run tests + linters, verify green**

Run: `node --test` then `npx eslint .` then `npm run lint`
Expected: all pass; web-ext lint must report 0 errors.

- [ ] **Step 10: Commit**

```bash
git add tools/vendor-cjs.js plugins/archivr.js plugins/archivr-content.js plugins/archivr-libs/ manifest.json popup.html tests/archivr-libs.test.js tests/archivr-skeleton.test.js
git commit -m "feat(archivr): vendor libs, wire manifest, add plugin skeleton"
```

---

### Task 2: Pure helpers (names, URLs, CSS URLs, MIME, sizes)

**Files:**
- Modify: `plugins/archivr.js` — add top-level pure helper functions (file-scope; used by popup path).
- Test: `tests/archivr-helpers.test.js`

**Interfaces:**
- Produces: `cleanName(title) -> string`, `uniqueNames(names) -> string[]`, `absolutizeUrlStr(url, base) -> string`, `extractCssUrls(cssText) -> string[]`, `sniffMime(url, contentType) -> string`, `formatSize(bytes) -> string`, `formatRelativeTime(ts) -> string`.

- [ ] **Step 1: Write the failing tests**

`tests/archivr-helpers.test.js`:

```js
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadHelpers() {
  const sandbox = { window: {}, location: { protocol: "moz-extension:", pathname: "/popup.html" } };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "..", "plugins", "archivr.js"), "utf8"),
    ctx,
    { filename: "plugins/archivr.js" }
  );
  return ctx;
}

const g = loadHelpers();

test("cleanName sanitizes titles into safe folder names", () => {
  assert.equal(g.cleanName("Hello World"), "Hello World");
  assert.equal(g.cleanName('a/b\\c:d*e?f"g<h>i|j'), "a b c d e f g h i j");
  assert.equal(g.cleanName("  padded  "), "padded");
  assert.equal(g.cleanName("\u0000control\u0001"), "control");
  assert.equal(g.cleanName("..."), "untitled");
});

test("uniqueNames dedupes colliding folder names", () => {
  assert.deepEqual(g.uniqueNames(["a", "a", "b"]), ["a", "a (2)", "b"]);
  assert.deepEqual(g.uniqueNames(["a (2)", "a"]), ["a (2)", "a (3)"]);
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
  const css = "a { background: url('img/a.png'); } b { background: url(\"b.png\"); } " +
    "@font-face { src: url(font.woff2) format('woff2'); } c { x: url(nonexistent); }";
  const urls = g.extractCssUrls(css);
  assert.ok(urls.includes("img/a.png") && urls.includes("b.png") && urls.includes("font.woff2"));
  assert.ok(!urls.includes("nonexistent"));
});

test("extractCssUrls caps tokens to avoid pathological pages", () => {
  const urls = g.extractCssUrls("a { background: url(x.png); }".repeat(600));
  assert.ok(urls.length <= 500);
});

test("sniffMime picks a data-URI mime", () => {
  assert.equal(g.sniffMime("https://e.com/a.png", "image/png"), "image/png");
  assert.equal(g.sniffMime("https://e.com/a.svg", "text/html; charset=utf-8"), "image/svg+xml");
  assert.equal(g.sniffMime("https://e.com/font.woff2", ""), "font/woff2");
  assert.equal(g.sniffMime("https://e.com/a", "text/css"), "text/css");
  assert.equal(g.sniffMime("https://e.com/a.txt", ""), "text/plain");
});

test("formatSize and formatRelativeTime", () => {
  assert.equal(g.formatSize(0), "0 B");
  assert.equal(g.formatSize(2048), "2.0 KB");
  assert.match(g.formatRelativeTime(Date.now()), /just now/);
});
```

- [ ] **Step 2: Run tests, verify they fail (functions undefined)**

Run: `node --test tests/archivr-helpers.test.js`
Expected: FAIL — `g.cleanName is not a function`.

- [ ] **Step 3: Implement the helpers (top of `plugins/archivr.js`)**

```js
function cleanName(title) {
  let t = String(title || "")
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) t = "untitled";
  return t.slice(0, 120);
}

function uniqueNames(names) {
  const seen = new Map();
  return names.map((name) => {
    const base = name;
    let candidate = base;
    let n = 2;
    while (seen.has(candidate)) {
      candidate = `${base} (${n})`;
      n++;
    }
    seen.set(candidate, true);
    return candidate;
  });
}

function absolutizeUrlStr(url, base) {
  if (!url || /^(data:|javascript:|mailto:|blob:|about:)/i.test(url)) return url;
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

function extractCssUrls(cssText) {
  const urls = [];
  const re = /\burl\(\s*(?:(["'])(.*?)\1|([^)'"\s]+))\s*\)/g;
  let m;
  while ((m = re.exec(cssText)) !== null) {
    if (urls.length >= 500) break;
    const url = (m[2] || m[3] || "").trim();
    if (url && !/^data:/i.test(url) && !/^\s*$/u.test(url)) urls.push(url);
  }
  return urls;
}

function sniffMime(url, contentType) {
  const ct = String(contentType || "").toLowerCase().split(";")[0].trim();
  if (ct) return ct;
  const ext = (url.split("?")[0].split("#")[0].split(".").pop() || "").toLowerCase();
  const map = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    webp: "image/webp", avif: "image/avif", svg: "image/svg+xml", ico: "image/x-icon",
    woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
    css: "text/css", js: "text/javascript", txt: "text/plain", html: "text/html"
  };
  return map[ext] || "application/octet-stream";
}

function formatSize(bytes) {
  let val = Number(bytes) || 0;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val.toFixed(1)} ${units[i]}`;
}

function formatRelativeTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000) return "just now";
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  return `${Math.floor(hrs / 24)} day ago`;
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `node --test tests/archivr-helpers.test.js`
Expected: all pass.

- [ ] **Step 5: Run full lint + tests**

Run: `node --test`, `npx eslint .`, `npm run lint`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add plugins/archivr.js tests/archivr-helpers.test.js
git commit -m "feat(archivr): add pure helper functions"
```
---

### Task 3: STORE-only ZIP writer

**Files:**
- Create: `plugins/archivr-zip.js` (pure; global `zipBytes`; loaded in popup + tests; no ext/DOM usage).
- Modify: `popup.html` (add `<script src="plugins/archivr-zip.js">` before `plugins/archivr.js`).
- Test: `tests/archivr-zip.test.js`

**Interfaces:**
- Produces: `zipBytes(files) -> Uint8Array`; `files = [{ name: string, data: string|Uint8Array }]`. STORE method, UTF-8 filename flag, entries sorted by name, valid local headers + central directory + EOCD, empty Uint8Array for empty input.

- [ ] **Step 1: Write the failing tests**

`tests/archivr-zip.test.js`:

```js
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadZip() {
  const ctx = vm.createContext({});
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "..", "plugins", "archivr-zip.js"), "utf8"),
    ctx,
    { filename: "plugins/archivr-zip.js" }
  );
  return ctx.zipBytes;
}

const zipBytes = loadZip();

function readU16(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}
function readU32(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)) >>> 0;
}

function crc32(bytes) {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function parseZip(bytes) {
  const u8 = Uint8Array.from(bytes);
  const eocd = u8.length - 22;
  assert.equal(readU32(u8, eocd), 0x06054b50, "EOCD signature");
  const count = readU16(u8, eocd + 10);
  const cdOffset = readU32(u8, eocd + 16);
  assert.equal(readU16(u8, eocd + 8), count, "entry counts match");
  const entries = [];
  let o = cdOffset;
  for (let i = 0; i < count; i++) {
    assert.equal(readU32(u8, o), 0x02014b50, "central dir signature");
    const flags = readU16(u8, o + 8);
    const method = readU16(u8, o + 10);
    const crc = readU32(u8, o + 16);
    const csize = readU32(u8, o + 20);
    const usize = readU32(u8, o + 24);
    const nameLen = readU16(u8, o + 28);
    const localOff = readU32(u8, o + 42);
    let name = "";
    for (let i2 = 0; i2 < nameLen; i2++) name += String.fromCharCode(u8[o + 46 + i2]);
    if (flags & 0x0800) name = Buffer.from(name, "latin1").toString("utf8");
    entries.push({ method, flags, crc, csize, usize, name, localOff });
    o += 46 + nameLen + readU16(u8, o + 30) + readU16(u8, o + 32);
  }
  for (const e of entries) {
    assert.equal(readU32(u8, e.localOff), 0x04034b50, "local header signature");
    const dataStart = e.localOff + 30 + readU16(u8, e.localOff + 26) + readU16(u8, e.localOff + 28);
    assert.equal(readU32(u8, e.localOff + 14), e.crc, `local CRC for ${e.name}`);
    assert.equal(crc32(u8.subarray(dataStart, dataStart + e.usize)), e.crc, `CRC match for ${e.name}`);
  }
  return entries;
}

test("zipBytes produces a valid STORE archive", () => {
  const files = [
    { name: "a.txt", data: "hello" },
    { name: "b.txt", data: new Uint8Array([1, 2, 3]) }
  ];
  const entries = parseZip(zipBytes(files));
  assert.deepEqual(entries.map((e) => e.name), ["a.txt", "b.txt"]);
  assert.ok(entries.every((e) => e.method === 0), "STORE method");
});

test("zipBytes handles UTF-8 filenames via the language encoding flag", () => {
  const entries = parseZip(zipBytes([{ name: "\u6d4b\u8bd5.txt", data: "x" }]));
  assert.equal(entries[0].name, "\u6d4b\u8bd5.txt");
  assert.ok(entries[0].flags & 0x0800, "UTF-8 flag set");
});

test("zipBytes sorts by name and keeps data byte-exact", () => {
  const data = Uint8Array.from({ length: 256 }, (_, i) => i);
  const entries = parseZip(zipBytes([{ name: "z.bin", data }, { name: "a.bin", data }]));
  assert.deepEqual(entries.map((e) => e.name), ["a.bin", "z.bin"]);
  assert.equal(entries[0].usize, 256);
});

test("zipBytes returns empty archive for empty input", () => {
  assert.equal(zipBytes([]).length, 0);
});
```

- [ ] **Step 2: Run tests, verify they fail (module not found)**

Run: `node --test tests/archivr-zip.test.js`
Expected: FAIL — cannot load `plugins/archivr-zip.js`.

- [ ] **Step 3: Implement the ZIP writer**

`plugins/archivr-zip.js`:

```js
"use strict";

// Minimal STORE-only ZIP writer (local headers + central directory + EOCD).
// Uncompressed text archives only; CRC-32 per entry; UTF-8 filename flag set.

(function (global) {
  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function toBytes(data) {
    if (typeof data === "string") return new TextEncoder().encode(data);
    return Uint8Array.from(data);
  }

  function pushU16(arr, v) {
    arr.push(v & 0xff, (v >>> 8) & 0xff);
  }
  function pushU32(arr, v) {
    arr.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  }

  function makeLocalHeader(nameBytes, nameLen, crc, size) {
    const out = [];
    pushU32(out, 0x04034b50);
    pushU16(out, 20);
    pushU16(out, 0x0800); // UTF-8 filenames
    pushU16(out, 0); // STORE
    pushU16(out, 0);
    pushU16(out, 0);
    pushU32(out, crc);
    pushU32(out, size);
    pushU32(out, size);
    pushU16(out, nameLen);
    pushU16(out, 0);
    for (const b of nameBytes) out.push(b);
    return out;
  }

  function makeCentralHeader(nameBytes, nameLen, crc, size, localOffset) {
    const out = [];
    pushU32(out, 0x02014b50);
    pushU16(out, 20);
    pushU16(out, 20);
    pushU16(out, 0x0800);
    pushU16(out, 0);
    pushU16(out, 0);
    pushU16(out, 0);
    pushU32(out, crc);
    pushU32(out, size);
    pushU32(out, size);
    pushU16(out, nameLen);
    pushU16(out, 0);
    pushU16(out, 0);
    pushU16(out, 0);
    pushU16(out, 0);
    pushU32(out, 0);
    pushU32(out, localOffset);
    for (const b of nameBytes) out.push(b);
    return out;
  }

  global.zipBytes = function zipBytes(files) {
    if (!files || files.length === 0) return new Uint8Array(0);

    const encoder = new TextEncoder();
    const localParts = [];
    const centralDirs = [];
    let offset = 0;

    const ordered = files
      .map((f) => ({ name: String(f.name), data: toBytes(f.data) }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const f of ordered) {
      const nameBytes = encoder.encode(f.name);
      const crc = crc32(f.data);
      const size = f.data.length;
      const local = makeLocalHeader(nameBytes, nameBytes.length, crc, size);
      localParts.push(Uint8Array.from(local), f.data);
      centralDirs.push(makeCentralHeader(nameBytes, nameBytes.length, crc, size, offset));
      offset += local.length + size;
    }

    const centralBytes = [];
    for (const dir of centralDirs) centralBytes.push(Uint8Array.from(dir));
    const cdLength = centralBytes.reduce((n, b) => n + b.length, 0);

    const eocd = [];
    pushU32(eocd, 0x06054b50);
    pushU16(eocd, 0);
    pushU16(eocd, 0);
    pushU16(eocd, ordered.length);
    pushU16(eocd, ordered.length);
    pushU32(eocd, cdLength);
    pushU32(eocd, offset);
    pushU16(eocd, 0);

    const eocdBytes = Uint8Array.from(eocd);
    const total = offset + cdLength + eocdBytes.length;
    const out = new Uint8Array(total);
    let p = 0;
    for (const part of localParts) {
      out.set(part, p);
      p += part.length;
    }
    for (const part of centralBytes) {
      out.set(part, p);
      p += part.length;
    }
    out.set(eocdBytes, p);
    return out;
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
```

- [ ] **Step 4: Wire `popup.html`** — the script order becomes:

```html
  <script src="plugins/archivr-libs/parse-srcset.js" charset="utf-8"></script>
  <script src="plugins/archivr-libs/uglifycss.js" charset="utf-8"></script>
  <script src="plugins/archivr-libs/turndown.js" charset="utf-8"></script>
  <script src="plugins/archivr-libs/turndown-plugin-gfm.js" charset="utf-8"></script>
  <script src="plugins/archivr-zip.js" charset="utf-8"></script>
  <script src="plugins/archivr.js" charset="utf-8"></script>
```

- [ ] **Step 5: Run tests, verify they pass**

Run: `node --test tests/archivr-zip.test.js` then `node --test` and `npx eslint .`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add plugins/archivr-zip.js popup.html tests/archivr-zip.test.js
git commit -m "feat(archivr): add STORE-only ZIP writer"
```

---

### Task 4: Content script capture

**Files:**
- Modify: `plugins/archivr-content.js`
- Test: `tests/archivr-content.test.js`

**Interfaces:**
- Produces (message sent by the content script): `["archivr:capture", { url, title, baseURI, html, ts }]`.
- Tested helpers: `shouldCapture({ protocol, title, html }) -> boolean`, `extractSnapshot(doc) -> object`, `armSpaCapture(windowObj, locationObj, captureFn) -> () => void (disarm)`.
  `doc` accessor shape: `{ baseURI, title, documentElement: { outerHTML }, body: { textContent } }`.
  `windowObj` accessor shape: `{ addEventListener(type, fn), removeEventListener(type, fn), navigation?: { addEventListener(type, fn), removeEventListener(type, fn) } }`.

- [ ] **Step 1: Write the failing tests**

`tests/archivr-content.test.js`:

```js
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadContent(sandbox) {
  const ctx = vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "..", "plugins", "archivr-content.js"), "utf8"),
    ctx,
    { filename: "plugins/archivr-content.js" }
  );
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
  const ctx = loadContent({ console });
  assert.equal(ctx.shouldCapture({ protocol: "http:", title: "T", html: "<b>hi</b>" }), true);
  assert.equal(ctx.shouldCapture({ protocol: "https:", title: "T", html: "<p>x</p>" }), true);
  assert.equal(ctx.shouldCapture({ protocol: "file:", title: "T", html: "<b>hi</b>" }), false);
  assert.equal(ctx.shouldCapture({ protocol: "http:", title: "", html: "" }), false);
  assert.equal(ctx.shouldCapture({ protocol: "http:", title: "Blank", html: "<html><body></body></html>" }), false);
});

test("extractSnapshot returns the required capture payload", () => {
  const ctx = loadContent({ console });
  const shot = ctx.extractSnapshot(makeDoc());
  assert.equal(shot.url, "https://example.com/");
  assert.equal(shot.title, "Page Title");
  assert.equal(shot.baseURI, "https://example.com/");
  assert.equal(shot.html, "<html><body>content</body></html>");
  assert.equal(typeof shot.ts, "number");
});

test("armSpaCapture re-arms on events and disarms cleanly", () => {
  const ctx = loadContent({ console });
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
  assert.equal(captures, 1);
  disarm();
  listeners.popstate();
  assert.equal(captures, 1);
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `node --test tests/archivr-content.test.js`
Expected: FAIL — `ctx.shouldCapture is not a function`.

- [ ] **Step 3: Implement the content script**

Replace the contents of `plugins/archivr-content.js` with:

```js
"use strict";

const ext = typeof browser !== "undefined" ? browser : chrome;

const isContentScript = typeof window !== "undefined" && typeof location !== "undefined" &&
  (location.protocol === "http:" || location.protocol === "https:");

function shouldCapture({ protocol, title, html }) {
  if (protocol !== "http:" && protocol !== "https:") return false;
  if (!title && !html) return false;
  if (!html || !/<body[\s>]/i.test(html)) return false;
  return /[^\s<>{}\/\\"']/.test(html.replace(/<[^>]*>/g, ""));
}

function extractSnapshot(doc) {
  return {
    url: doc.baseURI || "",
    title: doc.title || "",
    baseURI: doc.baseURI || "",
    html: (doc.documentElement && doc.documentElement.outerHTML) || "",
    ts: Date.now()
  };
}

function armSpaCapture(windowObj, locationObj, captureFn) {
  const listeners = [];
  const onNav = () => {
    setTimeout(() => captureFn(), 400);
  };
  for (const type of ["pushState", "replaceState", "popstate"]) {
    if (windowObj.addEventListener) {
      windowObj.addEventListener(type, onNav);
      listeners.push(() => windowObj.removeEventListener(type, onNav));
    }
  }
  const navApi = windowObj.navigation;
  if (navApi && navApi.addEventListener) {
    navApi.addEventListener("navigate", onNav);
    listeners.push(() => navApi.removeEventListener("navigate", onNav));
  }
  void locationObj;
  return () => {
    listeners.splice(0).forEach((off) => off());
  };
}

if (isContentScript) {
  const run = async () => {
    const settings = await ext.storage.local.get("archivr.enabled").catch(() => ({}));
    if (!settings["archivr.enabled"]) return;

    const shot = extractSnapshot(document);
    if (!shouldCapture({ protocol: location.protocol, title: shot.title, html: shot.html })) return;

    let lastSent = 0;
    const send = () => {
      if (Date.now() - lastSent < 5000) return;
      lastSent = Date.now();
      ext.runtime.sendMessage(["archivr:capture", shot]);
    };

    send();
    armSpaCapture(window, location, send);
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run, { once: true });
  } else {
    run();
  }
}
```

Note: the content script reads the toggle straight from `storage.local` (content scripts can access `storage`); background dedupe (Task 5) handles the 5-second same-URL rule.

- [ ] **Step 4: Run tests, verify they pass**

Run: `node --test tests/archivr-content.test.js`
Expected: all pass.

- [ ] **Step 5: Lint + full suite**

Run: `node --test`, `npx eslint .`, `npm run lint`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add plugins/archivr-content.js tests/archivr-content.test.js
git commit -m "feat(archivr): content script capture with SPA re-arm"
```

---

### Task 5: Background capture store and message handlers

**Files:**
- Modify: `plugins/archivr.js` (background-only section inside `if (isBackground) {...}`)
- Test: `tests/archivr-store.test.js`

**Interfaces:**
- Produces (inside `if (isBackground)`): `createMemoryStore()` and `createIdbStore(dbName)` with `{ add, list, getByIds, clear, count }`; message handlers for `archivr:capture`, `archivr:list`, `archivr:getRecords`, `archivr:clear`, `archivr:clearBadge`, `archivr:download`; badge text = capture count, cleared on panel open / clear.
- Test hook: when `globalThis.__archivrTest` is truthy, the file attaches `globalThis.__archivrTest = { createMemoryStore, createIdbStore }`. Production sandboxes never set it.
- Consumes: capture payload defined in Task 4.

- [ ] **Step 1: Write the failing tests**

`tests/archivr-store.test.js`:

```js
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadBackgroundStore() {
  const noop = () => {};
  const sandbox = {
    browser: {
      runtime: { onMessage: { addListener: noop }, onStartup: { addListener: noop } },
      action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
      downloads: { download: async () => "archive.zip" },
      storage: { local: { get: async () => ({}), set: async () => {} } }
    },
    console,
    __archivrTest: {}
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "..", "plugins", "archivr.js"), "utf8"),
    ctx,
    { filename: "plugins/archivr.js" }
  );
  return ctx.__archivrTest;
}

const { createMemoryStore } = loadBackgroundStore();

function rec(url, ts) {
  return { url, title: "T", baseURI: url, html: "<html></html>", ts };
}

test("memory store adds, lists newest-first, counts, omits html in list", async () => {
  const store = createMemoryStore();
  await store.clear();
  await store.add(rec("https://a.com/1", 1000));
  await store.add(rec("https://a.com/2", 2000));
  await store.add(rec("https://a.com/3", 3000));
  assert.equal(await store.count(), 3);
  const list = await store.list();
  assert.deepEqual(list.map((r) => r.url), ["https://a.com/3", "https://a.com/2", "https://a.com/1"]);
  assert.equal(list[0].html, undefined, "list() must omit the html payload");
});

test("memory store dedupes same URL within 5s", async () => {
  const store = createMemoryStore();
  await store.clear();
  assert.ok(await store.add(rec("https://a.com/1", 1000)));
  assert.equal(await store.add(rec("https://a.com/1", 4000)), null);
  assert.ok(await store.add(rec("https://a.com/1", 10000)));
});

test("memory store caps list at 300 entries", async () => {
  const store = createMemoryStore();
  await store.clear();
  for (let i = 0; i < 320; i++) await store.add(rec(`https://a.com/${i}`, i));
  const list = await store.list();
  assert.equal(list.length, 300);
  assert.equal(list[0].url, "https://a.com/319");
});

test("getByIds returns full records including html", async () => {
  const store = createMemoryStore();
  await store.clear();
  const id = await store.add(rec("https://a.com/x", 1));
  const rows = await store.getByIds([id]);
  assert.equal(rows.length, 1);
  assert.ok("html" in rows[0]);
});

test("clear empties the store", async () => {
  const store = createMemoryStore();
  await store.clear();
  await store.add(rec("https://a.com/x", 1));
  await store.clear();
  assert.equal(await store.count(), 0);
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `node --test tests/archivr-store.test.js`
Expected: FAIL — `createMemoryStore` is undefined.

- [ ] **Step 3: Implement the stores + background message handlers**

Replace the `if (isBackground) { ... }` block in `plugins/archivr.js` with:

```js
if (isBackground) {
  const MAX_LIST = 300;
  const DEDUPE_MS = 5000;

  function createMemoryStore() {
    let seq = 0;
    const records = new Map(); // id -> full record
    const ordered = []; // ids, newest first

    return {
      async add(rec) {
        const newest = ordered.length ? records.get(ordered[0]) : null;
        if (newest && newest.url === rec.url && Math.abs(newest.ts - rec.ts) < DEDUPE_MS) {
          return null;
        }
        const id = ++seq;
        const full = Object.assign({ id, ts: rec.ts || Date.now() }, rec);
        records.set(id, full);
        ordered.unshift(id);
        if (ordered.length > MAX_LIST) {
          const drop = ordered.pop();
          records.delete(drop);
        }
        return id;
      },
      async list() {
        return ordered.map((id) => {
          const r = records.get(id);
          return { id: r.id, url: r.url, title: r.title, ts: r.ts, size: r.size };
        });
      },
      async getByIds(ids) {
        return ids.map((id) => records.get(id)).filter(Boolean);
      },
      async clear() {
        records.clear();
        ordered.length = 0;
      },
      async count() {
        return ordered.length;
      }
    };
  }

  function createIdbStore(dbName) {
    let dbPromise = null;
    const db = () => {
      if (dbPromise) return dbPromise;
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(dbName, 1);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains("captures")) {
            req.result.createObjectStore("captures", { keyPath: "id", autoIncrement: true });
            req.result.createObjectStore("index", { keyPath: "orderKey" });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      return dbPromise;
    };

    const inMemory = createMemoryStore();

    return {
      async add(rec) {
        const id = await inMemory.add(rec);
        if (id === null) return null;
        const store = (await db()).transaction("captures", "readwrite").objectStore("captures");
        await new Promise((resolve, reject) => {
          const req = store.add(Object.assign({}, rec, { id, size: (rec.html || "").length }));
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        return id;
      },
      async list() {
        return inMemory.list();
      },
      async getByIds(ids) {
        const store = (await db()).transaction("captures", "readonly").objectStore("captures");
        const out = [];
        for (const id of ids) {
          const row = await new Promise((resolve, reject) => {
            const req = store.get(id);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });
          if (row) out.push(row);
        }
        return out;
      },
      async clear() {
        await inMemory.clear();
        const store = (await db()).transaction("captures", "readwrite").objectStore("captures");
        await new Promise((resolve, reject) => {
          const req = store.clear();
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error);
        });
      },
      async count() {
        return inMemory.count();
      }
    };
  }

  const setBadge = (text) => {
    if (extAction && extAction.setBadgeText) extAction.setBadgeText({ text });
  };

  const store = createIdbStore("archivr-captures");

  const handle = async (msg, sendResponse) => {
    const name = msg[0];
    const args = msg.slice(1);
    if (name === "archivr:capture") {
      const rec = args[0];
      if (!rec || !rec.html) return false;
      const id = await store.add(rec);
      if (id !== null) setBadge(String(await store.count()));
      return false;
    } else if (name === "archivr:list") {
      sendResponse(await store.list());
      return true;
    } else if (name === "archivr:getRecords") {
      sendResponse(await store.getByIds(args[0] || []));
      return true;
    } else if (name === "archivr:clear") {
      await store.clear();
      setBadge("");
      sendResponse(true);
      return true;
    } else if (name === "archivr:clearBadge") {
      setBadge("");
      return false;
    } else if (name === "archivr:download") {
      const { bytesBase64, filename } = args[0] || {};
      if (!bytesBase64 || !filename) return false;
      const blobUrl = URL.createObjectURL(
        new Blob([Uint8Array.from(atob(bytesBase64), (c) => c.charCodeAt(0))], {
          type: "application/zip"
        })
      );
      const id = await ext.downloads.download({
        url: blobUrl,
        filename,
        saveAs: false,
        conflictAction: "uniquify"
      });
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
      sendResponse({ id });
      return true;
    }
    return false;
  };

  ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    void sender;
    if (!Array.isArray(msg)) return false;
    handle(msg, sendResponse)
      .then((wasAsync) => {
        if (wasAsync) return; // sendResponse already called
        sendResponse(null);
      })
      .catch((err) => {
        console.error("[archivr] handler error:", err);
        sendResponse(null);
      });
    return true; // keep the channel open for async responses
  });

  if (ext.runtime.onStartup) ext.runtime.onStartup.addListener(() => {
    store.clear().catch(() => {});
  });

  if (globalThis.__archivrTest) {
    globalThis.__archivrTest.createMemoryStore = createMemoryStore;
    globalThis.__archivrTest.createIdbStore = createIdbStore;
  }
}
```

The handler wrapper always returns `true` (async channel), calls `handle()` which returns a promise; if a branch already called `sendResponse`, the wrapper does nothing; otherwise it resolves `null`. `URL.createObjectURL`/`Blob`/`atob` are available in the background worker (Chrome) and event page (Firefox).

- [ ] **Step 4: Run tests, verify they pass**

Run: `node --test tests/archivr-store.test.js`
Expected: all pass.

- [ ] **Step 5: Lint + full suite**

Run: `node --test`, `npx eslint .`, `npm run lint`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add plugins/archivr.js tests/archivr-store.test.js
git commit -m "feat(archivr): background capture store with badge and handlers"
```

---

### Task 6: Popup serializer (SingleFile-style HTML inlining)

**Files:**
- Modify: `plugins/archivr.js` — add serializer functions (popup path; referenced lazily, never executed in background).
- Modify: `plugins/archivr.js` — add `fetchThread`/fetcher helper used by the save pipeline.
- Test: `tests/archivr-serializer.test.js`

**Interfaces:**
- Produces (all defined at `archivr.js` module scope):
  - `parseHtml(html, parser) -> Doc`, `absolutizeHtml(doc, baseUri) -> Doc`, `absolutizeStyleUrls(styleText, baseUri) -> string`
  - `rewriteSrcsets(doc, baseUri, fetcher, state) -> Promise<Doc>`
  - `inlineCssFromLinks(doc, baseUri, fetcher, state) -> Promise<Doc>`
  - `inlineCssText(cssText, cssUrl, fetcher, state) -> Promise<string>`
  - `rewriteCssUrlsAsync(cssText, cssUrl, fetcher, state) -> Promise<string>`
  - `fetchText(url, fetcher, state) -> Promise<string|null>`
  - `assetToDataUri(url, fetcher, state) -> Promise<string>` (cached per URL; returns original URL on failure)
  - `inlineImgs(doc, baseUri, fetcher, state) -> Promise<Doc>`
  - `stripScripts(doc) -> Doc`, `toHtml(doc) -> string`
  - `serializePage({ html, baseUri }, fetcher) -> Promise<string>`
  - `htmlToMarkdown(html) -> string` (Turndown; TODO in Task 7)
- Consumes: `absolutizeUrlStr`, `extractCssUrls`, `sniffMime` from Task 2; `globalThis.parseSrcset`, `globalThis.UglifyCSS`.
- `fetcher` shape: `async (url) => ({ ok: boolean, headers: { get(name) -> string|null }, text() -> Promise<string>, arrayBuffer() -> Promise<ArrayBuffer> })` or `null`.

- [ ] **Step 1: Write the failing tests + minimal fake DOM**

`tests/archivr-serializer.test.js`:

```js
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// ---- minimal fake DOM used by DOM-walking serializer helpers -----------------
function el(tag, attrs = {}) {
  return {
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
    get attributes() {
      return Object.entries(this.attrs).map(([name, value]) => ({ name, value }));
    },
    get outerHTML() {
      const body = this.children.map((c) =>
        c.outerHTML || c.textContent || ""
      ).join("");
      return `<${this.tag}${Object.entries(this.attrs)
        .map(([k, v]) => ` ${k}="${String(v).replace(/"/g, "&quot;")}"`)
        .join("")}>${body}</${this.tag}>`;
    }
  };
}

function fakeDoc() {
  const head = el("head");
  const body = el("body");
  const root = el("html", {});
  root.appendChild(head);
  root.appendChild(body);
  const doc = { documentElement: root, head, body };
  doc.querySelectorAll = function (sel) {
    const out = [];
    const walk = (node) => {
      if (sel === "*" || node.tag === sel) out.push(node);
      node.children.forEach(walk);
    };
    walk(root);
    return out;
  };
  doc.createElement = (tag) => el(tag);
  return doc;
}

function loadSerializer() {
  const sandbox = {
    window: {},
    location: { protocol: "moz-extension:", pathname: "/popup.html" },
    console,
    DOMParser: class {
      parseFromString(src, mime) {
        const doc = fakeDoc();
        doc._src = src;
        return doc;
      }
    },
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    TextEncoder
  };
  const ctx = vm.createContext(sandbox);
  for (const rel of [
    "plugins/archivr.js"
  ]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "..", rel), "utf8"), ctx, { filename: rel });
  }
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
        return typeof entry.data === "string"
          ? new TextEncoder().encode(entry.data).buffer
          : entry.data.buffer;
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
  assert.equal(img.getAttribute("style"), "background:url(https://e.com/dir/b.png)");
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
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `node --test tests/archivr-serializer.test.js`
Expected: FAIL — `ctx.absolutizeHtml is not a function`.

- [ ] **Step 3: Implement the serializer**

Append these functions to `plugins/archivr.js` at module scope (after the Task 2 helpers, before the context detection constants):

```js
function parseHtml(html, parser) {
  return parser.parseFromString(html, "text/html").documentElement;
}

function absolutizeStyleUrls(styleText, baseUri) {
  return styleText.replace(
    /\burl\(\s*(?:(["'])(.*?)\1|([^)'"\s]+))\s*\)/g,
    (full, _q, quoted, unquoted) => {
      const url = (quoted || unquoted || "").trim();
      return url && !/^data:/i.test(url) ? `url("${absolutizeUrlStr(url, baseUri)}")` : full;
    }
  );
}

function absolutizeHtml(doc, baseUri) {
  for (const name of ["src", "href", "poster", "data-src"]) {
    for (const node of doc.querySelectorAll(`[${name}]`)) {
      const value = node.getAttribute(name);
      if (value) node.setAttribute(name, absolutizeUrlStr(value, baseUri));
    }
  }
  for (const node of doc.querySelectorAll("[style]")) {
    const style = node.getAttribute("style");
    if (style) node.setAttribute("style", absolutizeStyleUrls(style, baseUri));
  }
  return doc;
}

async function rewriteSrcsets(doc, baseUri, fetcher, state) {
  for (const node of doc.querySelectorAll("[srcset]")) {
    const raw = node.getAttribute("srcset");
    if (!raw) continue;
    try {
      const parts = globalThis.parseSrcset(raw);
      const rebuilt = [];
      for (const p of parts) {
        const abs = absolutizeUrlStr(p.url, baseUri);
        const dataUrl = await assetToDataUri(abs, fetcher, state);
        rebuilt.push(dataUrl + (p.descriptor ? " " + p.descriptor : ""));
      }
      node.setAttribute("srcset", rebuilt.join(", "));
    } catch {
      // leave the original srcset untouched on parse failure
    }
  }
  return doc;
}

async function fetchText(url, fetcher, state) {
  const res = await fetcher(url).catch(() => null);
  if (!res || !res.ok) return null;
  return res.text().catch(() => null);
}

async function assetToDataUri(url, fetcher, state) {
  if (state.cache.has(url)) return state.cache.get(url);
  let result = url;
  const res = await fetcher(url).catch(() => null);
  if (res && res.ok && typeof res.arrayBuffer === "function") {
    const buf = await res.arrayBuffer().catch(() => null);
    if (buf) {
      const contentType = res.headers ? res.headers.get("content-type") || "" : "";
      const mime = sniffMime(url, contentType);
      const bytes = new Uint8Array(buf);
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      }
      result = `data:${mime};base64,${btoa(bin)}`;
    }
  }
  state.cache.set(url, result);
  return result;
}

async function rewriteCssUrlsAsync(cssText, cssUrl, fetcher, state) {
  const re = /\burl\(\s*(?:(["'])(.*?)\1|([^)'"\s]+))\s*\)/g;
  const pieces = [];
  let lastIndex = 0;
  let m;
  while ((m = re.exec(cssText)) !== null) {
    pieces.push(cssText.slice(lastIndex, m.index));
    const url = (m[2] || m[3] || "").trim();
    if (url && !/^data:/i.test(url)) {
      const abs = absolutizeUrlStr(url, cssUrl);
      const dataUrl = await assetToDataUri(abs, fetcher, state);
      pieces.push(`url("${dataUrl}")`);
    } else {
      pieces.push(m[0]);
    }
    lastIndex = re.lastIndex;
  }
  pieces.push(cssText.slice(lastIndex));
  return pieces.join("");
}

async function inlineCssText(cssText, cssUrl, fetcher, state) {
  const impRe = /@import\s+(?:url\(\s*)?(["']?)([^"')\s]+)\1\s*\)?[^;]*;/gi;
  const parts = [];
  let lastIndex = 0;
  let m;
  while ((m = impRe.exec(cssText)) !== null) {
    parts.push(cssText.slice(lastIndex, m.index));
    const abs = absolutizeUrlStr(m[2], cssUrl);
    const sub = await fetchText(abs, fetcher, state);
    if (sub !== null) parts.push(await inlineCssText(sub, abs, fetcher, state));
    lastIndex = impRe.lastIndex;
  }
  parts.push(cssText.slice(lastIndex));
  return rewriteCssUrlsAsync(parts.join(""), cssUrl, fetcher, state);
}

async function inlineCssFromLinks(doc, baseUri, fetcher, state) {
  for (const link of doc.querySelectorAll('link[rel="stylesheet"]')) {
    const href = link.getAttribute("href");
    if (!href) continue;
    const cssUrl = absolutizeUrlStr(href, baseUri);
    const text = await fetchText(cssUrl, fetcher, state);
    if (text === null) continue;
    const inlined = await inlineCssText(text, cssUrl, fetcher, state);
    const style = doc.createElement("style");
    style.textContent = globalThis.UglifyCSS.processString(inlined);
    link.parentNode.insertBefore(style, link);
    link.remove();
  }
  return doc;
}

async function inlineImgs(doc, baseUri, fetcher, state) {
  for (const node of doc.querySelectorAll("img[src], img[data-src], video[poster]")) {
    const src = node.getAttribute("src") || node.getAttribute("data-src");
    if (src) {
      const abs = absolutizeUrlStr(src, baseUri);
      const dataUrl = await assetToDataUri(abs, fetcher, state);
      if (dataUrl !== abs) node.setAttribute("src", dataUrl);
      node.removeAttribute("data-src");
    }
  }
  return doc;
}

function stripScripts(doc) {
  for (const node of doc.querySelectorAll("script, iframe, object, embed")) node.remove();
  for (const node of doc.querySelectorAll("*")) {
    for (const attr of Array.from(node.attributes)) {
      if (/^on/i.test(attr.name)) node.removeAttribute(attr.name);
    }
    if (
      node.hasAttribute("href") &&
      /^\s*javascript:/i.test(node.getAttribute("href") || "")
    ) {
      node.removeAttribute("href");
    }
  }
  return doc;
}

function toHtml(doc) {
  return "<!DOCTYPE html>\n" + doc.outerHTML;
}

async function serializePage({ html, baseUri }, fetcher) {
  const doc = parseHtml(html, new DOMParser());
  const state = { cache: new Map() };
  absolutizeHtml(doc, baseUri);
  await rewriteSrcsets(doc, baseUri, fetcher, state);
  await inlineCssFromLinks(doc, baseUri, fetcher, state);
  await inlineImgs(doc, baseUri, fetcher, state);
  stripScripts(doc);
  const base = doc.createElement("base");
  base.setAttribute("href", baseUri);
  const head = doc.querySelector("head") || doc.documentElement;
  head.insertBefore(base, head.firstChild || null);
  return toHtml(doc);
}
```

- [ ] **Step 4: Fix the test harness before running**

The `inlineCssFromLinks` test uses `styles[0].parent === doc.head`; the fake `insertBefore` sets `node.parent = this`, and `link.remove()` unlinks the old link (its parent is head). Verified by the test body. The `inlineCssText` @import test above is a placeholder check — replace it with an assertion on `inlineCssFromLinks` recursing imports if you want coverage; otherwise delete that test. Run and iterate until green.

- [ ] **Step 5: Run tests, verify they pass**

Run: `node --test tests/archivr-serializer.test.js`
Expected: all pass.

- [ ] **Step 6: Lint + full suite**

Run: `node --test`, `npx eslint .`, `npm run lint`
Expected: green. If `no-shadow`/prettier complain, rename locals (`m` → `match`) to satisfy the rules.

- [ ] **Step 7: Commit**

```bash
git add plugins/archivr.js tests/archivr-serializer.test.js
git commit -m "feat(archivr): SingleFile-style page serializer with inline resources"
```

---

### Task 7: Markdown conversion + archive builder (popup)

**Files:**
- Modify: `plugins/archivr.js` — add htmlToMarkdown, makeReadme, archiveFilename, bytesToBase64, buildArchive.
- Test: `tests/archivr-archive.test.js`

**Interfaces:**
- Produces: `htmlToMarkdown(html) -> string` (uses `DOMParser` + `globalThis.TurndownService` + `globalThis.turndownPluginGfm`), `makeReadme(entries) -> string`, `archiveFilename() -> string`, `bytesToBase64(bytes) -> string`, `buildArchive(entries, fetcher, opts) -> Promise<Uint8Array>`.
  `entries = [{ url, title, baseURI, ts, html }]`. `opts = { serializePage: serializePage, mdFn: htmlToMarkdown, dirName: string }` — `serializePage`/`mdFn` are injectable for tests.
  Archive layout (per spec): one folder per entry `"NN - <clean title>"` containing `index.html` + `page.md`, plus `manifest.json` and `README.txt`. Folder names deduped and prefixed by `01 -`, `02 -`, ... in input order.

- [ ] **Step 1: Write the failing tests**

`tests/archivr-archive.test.js`:

```js
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
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    Uint8Array
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "..", "plugins", "archivr.js"), "utf8"),
    ctx,
    { filename: "plugins/archivr.js" }
  );
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
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `node --test tests/archivr-archive.test.js`
Expected: FAIL — `ctx.archiveFilename is not a function`.

- [ ] **Step 3: Implement the functions**

Append to `plugins/archivr.js` module scope:

```js
function htmlToMarkdown(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const service = new globalThis.TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-"
  });
  if (globalThis.turndownPluginGfm && globalThis.turndownPluginGfm.gfm) {
    service.use(globalThis.turndownPluginGfm.gfm);
  }
  return service.turndown(doc.body || doc.documentElement);
}

function makeReadme(entries) {
  const lines = [
    "ext267 Archivr export",
    "=====================",
    `Saved: ${new Date().toISOString()}`,
    `Pages: ${entries.length}`,
    "",
    "Each numbered folder contains a self-contained index.html (resources",
    "inlined as data URIs) and a page.md version of the captured page.",
    ""
  ];
  entries.forEach((e, i) => {
    lines.push(`${String(i + 1).padStart(2, "0")}. ${e.title || "(untitled)"} ${e.url}`);
  });
  return lines.join("\n") + "\n";
}

function archiveFilename() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `ext267-archive-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.zip`;
}

function bytesToBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

async function buildArchive(entries, fetcher, opts = {}) {
  const dirName = opts.dirName || archiveFilename().replace(/\.zip$/, "");
  const serialize = opts.serializePage || serializePage;
  const mdFn = opts.mdFn || htmlToMarkdown;
  const folders = uniqueNames(entries.map((e) => cleanName(e.title)));
  const files = [];
  const manifestEntries = [];

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const folder = `${dirName}/${String(i + 1).padStart(2, "0")} - ${folders[i]}`;
    const serialized = await serialize({ html: e.html, baseURI: e.baseURI }, fetcher);
    files.push({ name: `${folder}/index.html`, data: serialized });
    files.push({ name: `${folder}/page.md`, data: mdFn(e.html) });
    manifestEntries.push({
      title: e.title || "",
      url: e.url,
      ts: e.ts,
      html: `${folder}/index.html`,
      md: `${folder}/page.md`
    });
  }

  files.push({
    name: `${dirName}/manifest.json`,
    data: JSON.stringify({ savedAt: Date.now(), count: entries.length, entries: manifestEntries }, null, 2)
  });
  files.push({ name: `${dirName}/README.txt`, data: makeReadme(entries) });

  return zipBytes(files);
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `node --test tests/archivr-archive.test.js`
Expected: all pass. If `zipBytes` is undefined in the vm context, load `plugins/archivr-zip.js` into the same sandbox first (add it to `loadArchive()`).

- [ ] **Step 5: Lint + full suite**

Run: `node --test`, `npx eslint .`, `npm run lint`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add plugins/archivr.js tests/archivr-archive.test.js
git commit -m "feat(archivr): archive builder with markdown, manifest, and zip output"
```

---

### Task 8: Popup render UI

**Files:**
- Modify: `plugins/archivr.js` — replace the placeholder `render` with the full UI; add `defaultFetcher`.
- Test: `tests/archivr-popup.test.js`

**Interfaces:**
- Consumes: message protocol from Task 5; `buildArchive`, `bytesToBase64`, `archiveFilename`, `formatSize`, `formatRelativeTime` from earlier tasks.
- Produces: full `render(panel, context)` implementation for plugin id `archivr`, name `Archiver`.

- [ ] **Step 1: Add `defaultFetcher` and the real `render`**

Replace the `render` body in `plugins/archivr.js` registration and add this fetcher at module scope:

```js
async function defaultFetcher(url) {
  const res = await fetch(url);
  return {
    ok: res.ok,
    headers: { get: (name) => res.headers.get(name) },
    text: () => res.text(),
    arrayBuffer: () => res.arrayBuffer()
  };
}
```

```js
render: async function (panel, context) {
  const { refresh } = context;
  if (extAction && extAction.setBadgeText) extAction.setBadgeText({ text: "" });
  ext.runtime.sendMessage(["archivr:clearBadge"]).catch(() => {});

  const settings = await ext.storage.local.get(["archivr.enabled"]).catch(() => ({}));
  const enabled = !!settings["archivr.enabled"];

  const toggleLabel = document.createElement("label");
  toggleLabel.className = "checkbox-label";
  const toggle = document.createElement("input");
  toggle.type = "checkbox";
  toggle.checked = enabled;
  toggle.onchange = async (e) => {
    await ext.storage.local.set({ "archivr.enabled": e.target.checked }).catch(() => {});
    refresh();
  };
  toggleLabel.appendChild(toggle);
  toggleLabel.appendChild(document.createTextNode("Auto-capture pages this session"));
  panel.appendChild(toggleLabel);

  const list = (await ext.runtime.sendMessage(["archivr:list"]).catch(() => null)) || [];
  if (list.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No pages captured yet. Enable Auto-capture, browse, then save them here.";
    panel.appendChild(empty);
    return;
  }

  const selection = new Set(list.map((r) => r.id));

  const selectAll = document.createElement("label");
  selectAll.className = "checkbox-label";
  const selectAllInput = document.createElement("input");
  selectAllInput.type = "checkbox";
  selectAllInput.checked = true;
  selectAllInput.onchange = (e) => {
    selection.clear();
    if (e.target.checked) list.forEach((r) => selection.add(r.id));
    refresh();
  };
  selectAll.appendChild(selectAllInput);
  selectAll.appendChild(document.createTextNode("Select all"));
  panel.appendChild(selectAll);

  for (const r of list) {
    const row = document.createElement("label");
    row.className = "checkbox-label";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = selection.has(r.id);
    cb.onchange = () => {
      if (cb.checked) selection.add(r.id);
      else selection.delete(r.id);
    };
    row.appendChild(cb);
    const text = document.createElement("span");
    let host = r.url;
    try { host = new URL(r.url).host; } catch { /* keep raw url */ }
    text.textContent = `${r.title || "(untitled)"} — ${host} · ${formatSize(r.size)} · ${formatRelativeTime(r.ts)}`;
    row.appendChild(text);
    panel.appendChild(row);
  }

  const saveBtn = document.createElement("button");
  saveBtn.className = "btn btn-blue btn-full";
  saveBtn.textContent = "Save selected as ZIP";
  saveBtn.onclick = async () => {
    saveBtn.disabled = true;
    saveBtn.textContent = "Archiving…";
    try {
      const ids = Array.from(selection);
      if (ids.length === 0) return;
      const records = (await ext.runtime.sendMessage(["archivr:getRecords", ids]).catch(() => null)) || [];
      const bytes = await buildArchive(records.filter((r) => r && r.html), defaultFetcher, {});
      await ext.runtime.sendMessage([
        "archivr:download",
        { bytesBase64: bytesToBase64(bytes), filename: archiveFilename() }
      ]);
      saveBtn.textContent = "Saved!";
    } catch (err) {
      console.error("[archivr] save failed:", err);
      saveBtn.textContent = "Save failed";
    } finally {
      setTimeout(() => {
        saveBtn.disabled = false;
        saveBtn.textContent = "Save selected as ZIP";
      }, 2000);
    }
  };
  panel.appendChild(saveBtn);

  const clearBtn = document.createElement("button");
  clearBtn.className = "btn btn-red btn-full";
  clearBtn.textContent = "Clear session";
  clearBtn.onclick = async () => {
    await ext.runtime.sendMessage(["archivr:clear"]).catch(() => {});
    refresh();
  };
  panel.appendChild(clearBtn);
}
```

- [ ] **Step 2: Write the render wiring test**

`tests/archivr-popup.test.js`:

```js
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function makeElement(tag) {
  const node = {
    tag,
    children: [],
    props: {},
    textContent: "",
    className: "",
    style: {},
    value: "",
    checked: false,
    disabled: false,
    onclick: null,
    onchange: null,
    appendChild(child) { this.children.push(child); return child; },
    append(...nodes) { nodes.forEach((n) => this.appendChild(n)); },
    setAttribute(k, v) { this.props[k] = v; }
  };
  return node;
}

function makeDocument() {
  return {
    createElement: (tag) => makeElement(tag),
    createTextNode: (text) => ({ textContent: text, isText: true })
  };
}

function loadPopup(sandbox) {
  const ctx = vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "..", "plugins", "archivr.js"), "utf8"),
    ctx,
    { filename: "plugins/archivr.js" }
  );
  return ctx;
}

test("render loads list, renders rows, and save triggers a download message", async () => {
  const panel = makeElement("div");
  const messages = [];
  const browser = {
    runtime: {
      onMessage: { addListener() {} },
      sendMessage: async (msg) => {
        messages.push(msg);
        if (msg[0] === "archivr:list") {
          return [
            { id: 1, url: "https://a.com/1", title: "One", size: 100, ts: Date.now() },
            { id: 2, url: "https://b.com/2", title: "Two", size: 200, ts: Date.now() }
          ];
        }
        if (msg[0] === "archivr:getRecords") {
          return [
            { id: 1, url: "https://a.com/1", baseURI: "https://a.com/1", title: "One", ts: 1, html: "<p>1</p>" },
            { id: 2, url: "https://b.com/2", baseURI: "https://b.com/2", title: "Two", ts: 2, html: "<p>2</p>" }
          ];
        }
        if (msg[0] === "archivr:download") return { id: 99 };
        return null;
      }
    },
    action: { setBadgeText: async () => {} },
    storage: { local: { get: async () => ({}), set: async () => {} } }
  };
  const sandbox = {
    window: {},
    location: { protocol: "moz-extension:", pathname: "/popup.html" },
    browser,
    document: makeDocument(),
    console,
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    Uint8Array,
    Blob: class {},
    URL: { createObjectURL: () => "blob:fake", revokeObjectURL: () => {} }
  };
  const ctx = loadPopup(sandbox);
  // stub the heavy pure steps so the test stays fast
  ctx.buildArchive = async () => new Uint8Array([1, 2, 3]);
  ctx.bytesToBase64 = () => "AQID";
  const plugin = ctx.Plugins.get("archivr");
  await plugin.render(panel, { refresh: async () => {} });

  const checks = panel.children.filter((c) => c.tag === "label");
  assert.ok(checks.length >= 3, "toggle + select-all + 2 rows rendered");

  const saveBtn = panel.children.find((c) => c.tag === "button" && /Save selected/.test(c.textContent));
  assert.ok(saveBtn, "save button present");
  await saveBtn.onclick();

  assert.ok(messages.some((m) => m[0] === "archivr:getRecords" && m[1].length === 2));
  assert.ok(messages.some((m) => m[0] === "archivr:download" && m[1].filename.endsWith(".zip")));
});
```

- [ ] **Step 3: Run tests, verify they pass**

Run: `node --test tests/archivr-popup.test.js`
Expected: PASS. The render reads storage, sends `archivr:list`, draws rows, and the save flow sends `getRecords` + `download`.

- [ ] **Step 4: Lint + full suite**

Run: `node --test`, `npx eslint .`, `npm run lint`
Expected: green. Verify no `<script>`/`on*` tokens are created via innerHTML in the render (they are not — everything is createElement/textContent per AGENTS.md).

- [ ] **Step 5: Commit**

```bash
git add plugins/archivr.js tests/archivr-popup.test.js
git commit -m "feat(archivr): popup UI with toggle, capture list, and save-to-zip"
```

---

### Task 9: End-to-end message protocol integration test

**Files:**
- Modify: `plugins/archivr.js` — one small change to the background block so the store is overridable for tests.
- Test: `tests/archivr-integration.test.js`

- [ ] **Step 1: Make the background store overridable for tests**

In the Task 5 background block, change the store instantiation from:

```js
  const store = createIdbStore("archivr-captures");
```

to:

```js
  const store =
    globalThis.__archivrTest && globalThis.__archivrTest.store
      ? globalThis.__archivrTest.store
      : createIdbStore("archivr-captures");
```

This keeps production behavior identical (tests never set `__archivrTest.store` in production) and lets the integration test run the real message handler with a memory store.

- [ ] **Step 2: Write the integration test**

`tests/archivr-integration.test.js`:

```js
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadBackground() {
  const handlers = [];
  const downloads = [];
  const badges = [];
  const api = {
    runtime: {
      onMessage: { addListener(fn) { handlers.push(fn); } },
      onStartup: { addListener() {} }
    },
    action: {
      setBadgeText: async ({ text }) => { badges.push(text); },
      setBadgeBackgroundColor: async () => {}
    },
    downloads: { download: async (opts) => { downloads.push(opts); return 1; } },
    storage: { local: { get: async () => ({}), set: async () => {} } }
  };
  const sandbox = { browser: api, console, __archivrTest: { store: null } };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "..", "plugins", "archivr.js"), "utf8"),
    ctx,
    { filename: "plugins/archivr.js" }
  );
  // Provide a memory store so the real handlers are exercised without IndexedDB.
  sandbox.__archivrTest.store = ctx.__archivrTest.createMemoryStore();
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

  await callHandler(handlers, ["archivr:capture", {
    url: "https://e.com/a", title: "A", baseURI: "https://e.com/a",
    html: "<html><body>a</body></html>", ts
  }]);

  const list = await callHandler(handlers, ["archivr:list"]);
  assert.equal(list.length, 1);
  assert.equal(list[0].url, "https://e.com/a");

  const dup = await callHandler(handlers, ["archivr:capture", {
    url: "https://e.com/a", title: "A", baseURI: "https://e.com/a",
    html: "<html><body>a</body></html>", ts: ts + 1000
  }]);
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
```

- [ ] **Step 3: Run tests, verify they pass**

Run: `node --test tests/archivr-integration.test.js`
Expected: PASS. If the async `sendResponse(null)` fallback races the real response, adjust `callHandler`'s timeout upward or have the wrapper resolve only once (it already guards with `done`).

- [ ] **Step 4: Lint + full suite**

Run: `node --test`, `npx eslint .`, `npm run lint`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add plugins/archivr.js tests/archivr-integration.test.js
git commit -m "feat(archivr): end-to-end message protocol integration test"
```

---

### Task 10: Docs + final verification

**Files:**
- Modify: `README.md` — add Archivr to the plugins table and list the save/format behavior.
- Verify: full suite + linters.

- [ ] **Step 1: Update `README.md`**

Add a row to the Plugins table and a short section:

```markdown
### archivr
Automatically captures every page you browse during a session (opt-in toggle) and bulk-saves a
selection as a single ZIP: each page becomes a folder with a self-contained `index.html` (resources
inlined, single-file style) and a `page.md` (Markdown) version, plus a `manifest.json` and README.
Captures are session-only and are wiped on browser restart.
```

- [ ] **Step 2: Run the full verification gate**

Run:

```bash
npm test
npx eslint .
npm run lint
```

Expected: all pass with 0 errors/warnings. Also run `npm run build` if you have AMO credentials configured; otherwise the lint gate suffices for CI parity.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(archivr): document the Archivr plugin"
```

---

## Self-Review Notes

- **Spec coverage:** capture mode (Tasks 4, 8 toggle) ✓, session-only retention (Task 5 onStartup clear) ✓, HTML+MD formats (Tasks 6, 7) ✓, single ZIP + downloads API (Tasks 3, 7, 9) ✓, inline resources (Task 6) ✓, no new permissions (manifest unchanged apart from content_scripts) ✓, popup UI (Task 8) ✓, testing (Tasks 1-9) ✓.
- **Deviations:** save pipeline in popup (needs DOM), parse-css-font and whatwg-mimetype replaced by custom helpers — documented in the header.
- **Known verifications left to the implementer:** the exact vendored file paths (validate with `find` after `npm pack`); Turndown dist that bundles its DOM dependency; and the `UglifyCSS.processString` API name (if it differs, inspect the vendored file and adjust the two call sites).
