"use strict";

// eslint-disable-next-line no-unused-vars
function cleanName(title) {
  let t = String(title || "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) t = "untitled";
  return t.slice(0, 120);
}

// eslint-disable-next-line no-unused-vars
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

// eslint-disable-next-line no-unused-vars
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

// eslint-disable-next-line no-unused-vars
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

// eslint-disable-next-line no-unused-vars
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

// eslint-disable-next-line no-unused-vars
function formatRelativeTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000) return "just now";
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  return `${Math.floor(hrs / 24)} day ago`;
}

const ext = typeof browser !== "undefined" ? browser : chrome;
const extAction = ext.action || ext.browserAction;

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

  if (ext.runtime.onStartup)
    ext.runtime.onStartup.addListener(() => {
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
