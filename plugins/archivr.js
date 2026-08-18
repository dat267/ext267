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
  ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    void sender;
    if (!Array.isArray(msg) || typeof msg[0] !== "string" || !msg[0].startsWith("archivr:")) return false;

    sendResponse(null);
    return true;
  });
  if (ext.runtime.onStartup) ext.runtime.onStartup.addListener(() => {});
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
