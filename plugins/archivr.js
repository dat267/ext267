"use strict";

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
