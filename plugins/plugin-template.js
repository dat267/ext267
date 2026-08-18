/**
 * ext267 Plugin Template
 *
 * HOW TO ADD A NEW PLUGIN
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. Copy this file and rename it (e.g., plugins/httpie.js).
 * 2. Fill in the plugin metadata (id, name, etc.) and implement render().
 * 3. Add the script to manifest.json → "background" → "scripts" array
 *    so it runs in the background service worker / event page.
 * 4. Add a <script> tag for it in popup.html, BEFORE popup.js:
 *      <script src="plugins/httpie.js"></script>
 * 5. Reload the extension. The popup selector will auto-populate.
 *
 * PLUGIN TYPES
 * ─────────────────────────────────────────────────────────────────────────────
 * A) Download-intercepting plugin (like cliget):
 *    - Uses _isBackground guard to register webRequest listeners in background.
 *    - Communicates with popup via ext.runtime.sendMessage (namespaced by id).
 *    - Implements render() to display intercepted data and a generated command.
 *
 * B) Standalone webapp plugin (like a scratchpad or browser tool):
 *    - No background guard needed; all logic lives in render().
 *    - Can use ext.* APIs directly inside render() since plugins define their
 *      own `ext` at file scope.
 *    - No generate() required.
 *
 * CONTEXT OBJECT (passed to render)
 * ─────────────────────────────────────────────────────────────────────────────
 *   { refresh }
 *   - refresh(): Re-runs this plugin's render() to update the panel UI.
 *                Call after any state change (e.g., storage write).
 *
 * NOTE: Each plugin defines its own `ext` at file scope. Do NOT rely on
 * context.ext — it is not provided by the popup shell.
 */

"use strict";

const ext = typeof browser !== "undefined" ? browser : chrome;

// Self-registration bootstrap (safe to duplicate across plugin files)
globalThis.Plugins = globalThis.Plugins || new Map();
if (typeof globalThis.registerPlugin !== "function")
  globalThis.registerPlugin = function (plugin) {
    globalThis.Plugins.set(plugin.id, plugin);
  };

// ─────────────────────────────────────────────────────────────────────────────
// SECTION A: Background-only code (service worker / event page)
// Remove this entire block if this plugin does NOT intercept network traffic.
// ─────────────────────────────────────────────────────────────────────────────
const _isBackground =
  typeof window === "undefined" || (typeof location !== "undefined" && location.pathname !== "/popup.html");

if (_isBackground) {
  // Example: store intercepted data keyed by plugin id to avoid collisions
  const _store = new Map();

  // Example message handler (namespace all messages with your plugin id)
  ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!Array.isArray(msg)) return;
    // eslint-disable-next-line no-unused-vars
    const [name, ...args] = msg;

    if (name === "mytool:getData") {
      sendResponse(Array.from(_store.values()));
      return true;
    }
  });

  // Example: webRequest listener (only needed if capturing requests/downloads)
  // ext.webRequest.onResponseStarted.addListener(
  //   (details) => { /* ... */ },
  //   { urls: ["<all_urls>"], types: ["main_frame", "sub_frame"] },
  //   ["responseHeaders"]
  // );
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION B: Plugin registration (runs in both popup and background)
// ─────────────────────────────────────────────────────────────────────────────
globalThis.registerPlugin({
  /** Unique plugin ID. Used as message namespace prefix and storage key. */
  id: "mytool",

  /** Display name shown in the popup selector dropdown. */
  name: "MyTool",

  /**
   * Render the plugin's UI into the given panel element.
   *
   * @param {HTMLElement} panel   - The content area to render into. Always cleared before call.
   * @param {Object}      context - { refresh } — call refresh() after any state change.
   */
  render: async function (panel, context) {
    const { refresh } = context;

    // ── Example: load persisted state ──────────────────────────────────────
    const stored = await ext.storage.local.get(["mytool_value"]);
    const currentValue = stored.mytool_value || "";

    // ── Build UI ────────────────────────────────────────────────────────────
    const label = document.createElement("label");
    label.className = "text-input-label";
    label.textContent = "My Setting:";

    const input = document.createElement("input");
    input.type = "text";
    input.value = currentValue;
    input.placeholder = "Enter a value…";
    input.onchange = async (e) => {
      await ext.storage.local.set({ mytool_value: e.target.value });
      refresh();
    };
    label.appendChild(input);

    const btn = document.createElement("button");
    btn.className = "btn btn-blue btn-full";
    btn.textContent = "Do Something";
    btn.onclick = () => {
      alert(`Value: ${input.value || "(empty)"}`);
    };

    panel.appendChild(label);
    panel.appendChild(btn);
  }
});
