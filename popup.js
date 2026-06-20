"use strict";

// Plugin registry — populated by each plugin <script> before this file runs.
// popup.js is read-only here; plugins bootstrap globalThis.Plugins themselves.

// ----------------------------------------------------
// Pure DOM Shell — no extension API usage here.
// Tab persistence uses localStorage (plain Web Storage).
// All extension-specific logic lives inside each plugin.
// ----------------------------------------------------
async function init() {
  const plugins = Array.from(globalThis.Plugins.values());
  if (plugins.length === 0) return;

  // Restore last selected plugin from plain localStorage
  let lastActive = localStorage.getItem("lastActiveTab");
  if (!lastActive || !plugins.some(p => p.id === lastActive)) {
    lastActive = plugins[0].id;
  }

  buildSelector(plugins, lastActive);
}

function buildSelector(plugins, startPlugin) {
  const selector = document.getElementById("plugin-selector");
  if (!selector) return;

  // Hide the selector when only a single plugin is installed — no choice to make
  const header = document.querySelector(".app-header");
  if (plugins.length <= 1) {
    if (header) header.style.display = "none";
  } else {
    if (header) header.style.display = "";
    selector.innerHTML = "";
    plugins.forEach(plugin => {
      const opt = document.createElement("option");
      opt.value = plugin.id;
      opt.textContent = plugin.name || plugin.id;
      if (plugin.id === startPlugin) opt.selected = true;
      selector.appendChild(opt);
    });

    selector.onchange = (e) => {
      const activeId = e.target.value;
      localStorage.setItem("lastActiveTab", activeId);
      renderPanel(activeId);
    };
  }

  renderPanel(startPlugin);
}

async function renderPanel(pluginId) {
  const panel = document.getElementById("tab-content-area");
  if (!panel) return;

  panel.innerHTML = "";
  panel.className = "plugin-panel";

  const plugin = globalThis.Plugins.get(pluginId);
  if (!plugin) return;

  if (typeof plugin.render === "function") {
    try {
      await plugin.render(panel, { refresh: () => renderPanel(pluginId) });
    } catch (err) {
      panel.innerHTML = "";
      const errDiv = document.createElement("div");
      errDiv.className = "empty-state";
      errDiv.textContent = `Plugin error: ${err.message}`;
      panel.appendChild(errDiv);
      console.error(`[ext267] Plugin "${pluginId}" render error:`, err);
    }
  }
}

document.addEventListener("DOMContentLoaded", init);
