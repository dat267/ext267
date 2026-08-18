"use strict";

function cleanName(title) {
  let t = String(title || "")
    // eslint-disable-next-line no-control-regex
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

// eslint-disable-next-line no-unused-vars
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
  const ct = String(contentType || "")
    .toLowerCase()
    .split(";")[0]
    .trim();
  if (ct) return ct;
  const ext = (url.split("?")[0].split("#")[0].split(".").pop() || "").toLowerCase();
  const map = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
    svg: "image/svg+xml",
    ico: "image/x-icon",
    woff: "font/woff",
    woff2: "font/woff2",
    ttf: "font/ttf",
    otf: "font/otf",
    css: "text/css",
    js: "text/javascript",
    txt: "text/plain",
    html: "text/html"
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

// ---- Page serializer (popup/background path; globalThis.parseSrcset and
// ---- globalThis.UglifyCSS are referenced lazily, never at module top level) ---

function parseHtml(html, parser) {
  // Return the Document, not documentElement: downstream code calls
  // Document-only methods (createElement) on the result.
  return parser.parseFromString(html, "text/html");
}

function absolutizeStyleUrls(styleText, baseUri) {
  return styleText.replace(/\burl\(\s*(?:(["'])(.*?)\1|([^)'"\s]+))\s*\)/g, (full, _q, quoted, unquoted) => {
    const url = (quoted || unquoted || "").trim();
    return url && !/^data:/i.test(url) ? `url("${absolutizeUrlStr(url, baseUri)}")` : full;
  });
}

function absolutizeHtml(doc, baseUri) {
  for (const name of ["src", "href", "poster", "data-src"])
    for (const node of doc.querySelectorAll(`[${name}]`)) {
      const value = node.getAttribute(name);
      if (value) node.setAttribute(name, absolutizeUrlStr(value, baseUri));
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
        let desc = "";
        if (p.w) desc = `${p.w}w`;
        else if (p.h) desc = `${p.h}h`;
        else if (p.d) desc = `${p.d}x`;
        rebuilt.push(dataUrl + (desc ? " " + desc : ""));
      }
      node.setAttribute("srcset", rebuilt.join(", "));
    } catch {
      // leave the original srcset untouched on parse failure
    }
  }
  return doc;
}

async function fetchText(url, fetcher, state) {
  void state; // signature parity with the other fetcher helpers
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
      for (let i = 0; i < bytes.length; i += 0x8000)
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));

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
  if (!state.cssImports) state.cssImports = new Set();
  const impRe = /@import\s+(?:url\(\s*)?(["']?)([^"')\s]+)\1\s*\)?\s*([^;]*);/gi;
  const parts = [];
  let lastIndex = 0;
  let m;
  while ((m = impRe.exec(cssText)) !== null) {
    parts.push(cssText.slice(lastIndex, m.index));
    const statement = m[0];
    const before = cssText.slice(0, m.index);
    const opens = (before.match(/\/\*/g) || []).length;
    const closes = (before.match(/\*\//g) || []).length;
    if (opens > closes) {
      parts.push(statement);
      lastIndex = impRe.lastIndex;
      continue;
    }
    const abs = absolutizeUrlStr(m[2], cssUrl);
    if (state.cssImports.has(abs)) {
      lastIndex = impRe.lastIndex;
      continue;
    }
    state.cssImports.add(abs);
    const sub = await fetchText(abs, fetcher, state);
    if (sub !== null) {
      const subCss = await inlineCssText(sub, abs, fetcher, state);
      const condition = (m[3] || "").trim();
      if (condition) parts.push(`@media ${condition} { ${subCss} }`);
      else parts.push(subCss);
    }
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
    let src = node.getAttribute("src");
    const dataSrc = node.getAttribute("data-src");
    // Lazy-loaded images carry a tiny placeholder in src and the real URL in
    // data-src; when the two differ, prefer the real one for inlining.
    if (dataSrc && (!src || dataSrc !== src)) src = dataSrc;
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
    for (const attr of Array.from(node.attributes)) if (/^on/i.test(attr.name)) node.removeAttribute(attr.name);

    if (node.hasAttribute("href") && /^\s*javascript:/i.test(node.getAttribute("href") || ""))
      node.removeAttribute("href");
  }
  return doc;
}

function toHtml(doc) {
  // doc is a Document; serialize its root element.
  return "<!DOCTYPE html>\n" + doc.documentElement.outerHTML;
}

async function serializePage({ html, baseUri }, fetcher) {
  const doc = parseHtml(html, new DOMParser());
  const state = { cache: new Map(), cssImports: new Set() };
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

// ---- Archive builder (popup path; globalThis.TurndownService and
// ---- globalThis.turndownPluginGfm are referenced lazily so this file can also
// ---- load in the background where those libraries do not exist) ----

function htmlToMarkdown(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const service = new globalThis.TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-"
  });
  if (globalThis.turndownPluginGfm && globalThis.turndownPluginGfm.gfm) service.use(globalThis.turndownPluginGfm.gfm);

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
  return (
    `ext267-archive-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.zip`
  );
}

function bytesToBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));

  return btoa(bin);
}

async function defaultFetcher(url) {
  const res = await fetch(url);
  return {
    ok: res.ok,
    headers: { get: (name) => res.headers.get(name) },
    text: () => res.text(),
    arrayBuffer: () => res.arrayBuffer()
  };
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
    const serialized = await serialize({ html: e.html, baseUri: e.baseURI }, fetcher);
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

  return globalThis.zipBytes(files);
}

// NOTE: top-level bindings are deliberately NOT named `ext`/`extAction` —
// cliget.js declares those names in the shared global lexical environment and a
// duplicate `const` would throw a SyntaxError in whichever script parses second.
const archivrExt = typeof browser !== "undefined" ? browser : chrome;
const archivrExtAction = archivrExt.action || archivrExt.browserAction;

// Context detection:
// - background: Chrome MV3 has no window; Firefox event page has window but its
//   pathname is NOT the popup.
// - content: page protocol (http/https). The popup protocol is moz-/chrome-extension.
// - popup: everything else (popup.html).
const isPopup = typeof location !== "undefined" && location.pathname.endsWith("/popup.html");
const isContentScript =
  typeof window !== "undefined" &&
  typeof location !== "undefined" &&
  (location.protocol === "http:" || location.protocol === "https:");
const isBackground = !isPopup && !isContentScript;

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
        if (newest && newest.url === rec.url && Math.abs(newest.ts - rec.ts) < DEDUPE_MS) return null;

        const id = ++seq;
        const full = Object.assign({ id, ts: rec.ts || Date.now() }, rec, { size: (rec.html || "").length });
        records.set(id, full);
        ordered.unshift(id);
        if (ordered.length > MAX_LIST) {
          const drop = ordered.pop();
          records.delete(drop);
        }
        return id;
      },
      // Rebuild the in-memory index from persisted rows (used to rehydrate
      // after an MV3 worker recycle). Rows carry `id` and `size`; the id
      // sequence continues from the highest stored id so fresh adds never
      // collide with persisted records.
      async seed(rows) {
        for (const row of rows) {
          if (!row || typeof row.id !== "number") continue;
          if (row.id > seq) seq = row.id;
          records.set(row.id, row);
          ordered.push(row.id);
        }
        ordered.sort((a, b) => b - a); // newest id first
        while (ordered.length > MAX_LIST) {
          const drop = ordered.pop();
          records.delete(drop);
        }
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

  function createIdbStore(dbName, backend) {
    const idb = backend || (typeof indexedDB !== "undefined" ? indexedDB : null);
    let dbPromise = null;
    let readyPromise = null;
    const inMemory = createMemoryStore();

    const db = () => {
      if (dbPromise) return dbPromise;
      dbPromise = new Promise((resolve, reject) => {
        const req = idb.open(dbName, 1);
        req.onupgradeneeded = () => {
          if (req.result.objectStoreNames.contains("captures")) return;
          req.result.createObjectStore("captures", { keyPath: "id", autoIncrement: true });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      return dbPromise;
    };

    // MV3 background workers recycle when idle (Chrome ~30s, Firefox suspends
    // event pages). The in-memory index is gone after a recycle, so rehydrate
    // it from IDB on first use (newest first, capped at MAX_LIST) and continue
    // the id sequence from the highest stored id.
    const ensureReady = () => {
      if (readyPromise) return readyPromise;
      readyPromise = (async () => {
        const objectStore = (await db()).transaction("captures", "readonly").objectStore("captures");
        const rows = await new Promise((resolve, reject) => {
          const collected = [];
          const req = objectStore.openCursor(null, "prev"); // newest id first
          req.onsuccess = () => {
            const cursor = req.result;
            if (!cursor) return resolve(collected);
            collected.push(cursor.value);
            if (collected.length < MAX_LIST) cursor.continue();
            else resolve(collected);
          };
          req.onerror = () => reject(req.error);
        });
        await inMemory.seed(rows);
      })();
      return readyPromise;
    };

    return {
      async add(rec) {
        await ensureReady();
        const sized = Object.assign({}, rec, { size: (rec.html || "").length });
        const id = await inMemory.add(sized);
        if (id === null) return null;
        const store = (await db()).transaction("captures", "readwrite").objectStore("captures");
        await new Promise((resolve, reject) => {
          const req = store.add(Object.assign({}, sized, { id }));
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        return id;
      },
      async list() {
        await ensureReady();
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
        await ensureReady();
        return inMemory.count();
      }
    };
  }

  const setBadge = (text) => {
    if (archivrExtAction && archivrExtAction.setBadgeText) archivrExtAction.setBadgeText({ text });
  };

  const store =
    globalThis.__archivrTest && globalThis.__archivrTest.store
      ? globalThis.__archivrTest.store
      : createIdbStore("archivr-captures");

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
      const id = await archivrExt.downloads.download({
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

  archivrExt.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    void sender;
    if (!Array.isArray(msg) || typeof msg[0] !== "string" || !msg[0].startsWith("archivr:")) return false;
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

  if (archivrExt.runtime.onStartup)
    archivrExt.runtime.onStartup.addListener(() => {
      store.clear().catch(() => {});
    });

  if (globalThis.__archivrTest) {
    globalThis.__archivrTest.createMemoryStore = createMemoryStore;
    globalThis.__archivrTest.createIdbStore = createIdbStore;
  }
}

if (isPopup) {
  globalThis.Plugins = globalThis.Plugins || new Map();
  if (typeof globalThis.registerPlugin !== "function")
    globalThis.registerPlugin = function (plugin) {
      globalThis.Plugins.set(plugin.id, plugin);
    };

  // Popup-session selection state. Lives here (the popup-only block) so it
  // survives re-renders via refresh() while staying inert in the background.
  const selection = new Set();
  let selectionInitialized = false;

  globalThis.registerPlugin({
    id: "archivr",
    name: "Archiver",
    defaultOptions: { enabled: false },
    render: async function (panel, context) {
      const { refresh } = context;
      if (archivrExtAction && archivrExtAction.setBadgeText) archivrExtAction.setBadgeText({ text: "" });
      archivrExt.runtime.sendMessage(["archivr:clearBadge"]).catch(() => {});

      const settings = await archivrExt.storage.local.get(["archivr.enabled"]).catch(() => ({}));
      const enabled = !!settings["archivr.enabled"];

      const toggleLabel = document.createElement("label");
      toggleLabel.className = "checkbox-label";
      const toggle = document.createElement("input");
      toggle.type = "checkbox";
      toggle.checked = enabled;
      toggle.onchange = async (e) => {
        await archivrExt.storage.local.set({ "archivr.enabled": e.target.checked }).catch(() => {});
        refresh();
      };
      toggleLabel.appendChild(toggle);
      toggleLabel.appendChild(document.createTextNode("Auto-capture pages this session"));
      panel.appendChild(toggleLabel);

      const list = (await archivrExt.runtime.sendMessage(["archivr:list"]).catch(() => null)) || [];
      if (list.length === 0) {
        const empty = document.createElement("div");
        empty.className = "empty-state";
        empty.textContent = "No pages captured yet. Enable Auto-capture, browse, then save them here.";
        panel.appendChild(empty);
        return;
      }

      // Keep the session selection: drop ids for captures that were removed
      // (store cleared/evicted) and, on the very first render of a popup
      // session, default to every capture selected. Never re-select after a
      // user deselects — an empty selection must stay empty across refresh().
      for (const id of Array.from(selection)) if (!list.some((r) => r.id === id)) selection.delete(id);

      if (!selectionInitialized) {
        list.forEach((r) => selection.add(r.id));
        selectionInitialized = true;
      }

      const selectAll = document.createElement("label");
      selectAll.className = "checkbox-label";
      const selectAllInput = document.createElement("input");
      selectAllInput.type = "checkbox";
      selectAllInput.checked = selection.size === list.length;
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
          refresh();
        };
        row.appendChild(cb);
        const text = document.createElement("span");
        let host = r.url;
        try {
          host = new URL(r.url).host;
        } catch {
          // keep raw url
        }
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
          const records = (await archivrExt.runtime.sendMessage(["archivr:getRecords", ids]).catch(() => null)) || [];
          const bytes = await buildArchive(
            records.filter((r) => r && r.html),
            defaultFetcher,
            {}
          );
          await archivrExt.runtime.sendMessage([
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
        await archivrExt.runtime.sendMessage(["archivr:clear"]).catch(() => {});
        refresh();
      };
      panel.appendChild(clearBtn);
    }
  });
}
