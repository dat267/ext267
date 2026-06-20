"use strict";

const ext = typeof browser !== "undefined" ? browser : chrome;
const extAction = ext.action || ext.browserAction;

// Define local plugin registry
globalThis.Plugins = globalThis.Plugins || new Map();
if (typeof globalThis.registerPlugin !== "function") {
  globalThis.registerPlugin = function (plugin) {
    globalThis.Plugins.set(plugin.id, plugin);
  };
}

// Helper to convert size to human readable text
function fileSizeToText(size) {
  let unit = "B";
  if (size >= 1024) {
    size /= 1024;
    unit = "KB";
    if (size >= 1024) {
      size /= 1024;
      unit = "MB";
      if (size >= 1024) {
        size /= 1024;
        unit = "GB";
      }
    }
  }
  return `${size.toFixed(1)} ${unit}`;
}

// Helper to resolve options for popup context
async function getMergedOptions(plugin) {
  const defaults = Object.assign(
    { doubleQuotes: false, excludeHeaders: "Accept-Encoding Connection" },
    plugin.defaultOptions || {}
  );
  const stored = await ext.storage.local.get();
  return Object.assign({}, defaults, stored);
}

// Global state
let currentDownloads = [];
let selectedDownloadId = "";

// Initialize everything
async function init() {
  // Clear badge
  if (extAction && extAction.setBadgeText) {
    extAction.setBadgeText({ text: "" });
  }

  // Build dynamic selector
  const plugins = Array.from(globalThis.Plugins.values());

  // Load active plugin state from storage, defaulting to the first plugin if not set
  const stored = await ext.storage.local.get(["lastActiveTab"]);
  let lastActiveTab = stored.lastActiveTab;
  if (!lastActiveTab && plugins.length > 0) {
    lastActiveTab = plugins[0].id;
  }
  
  // Ensure the default active plugin is valid
  if (!plugins.some(p => p.id === lastActiveTab)) {
    lastActiveTab = plugins[0]?.id || "";
  }
  
  setupPluginSelector(plugins, lastActiveTab);
}

// ----------------------------------------------------
// Dynamic Plugin Selector & Routing
// ----------------------------------------------------
function setupPluginSelector(plugins, startPlugin) {
  const selector = document.getElementById("plugin-selector");
  if (!selector) return;

  selector.innerHTML = "";
  plugins.forEach(plugin => {
    const opt = document.createElement("option");
    opt.value = plugin.id;
    opt.textContent = plugin.name || plugin.id;
    if (plugin.id === startPlugin) {
      opt.selected = true;
    }
    selector.appendChild(opt);
  });

  selector.onchange = async (e) => {
    const activePlugin = e.target.value;
    await ext.storage.local.set({ lastActiveTab: activePlugin });
    renderToolPanel(activePlugin);
  };

  // Initial render
  renderToolPanel(startPlugin);
}

// ----------------------------------------------------
// Tool Command Panel Rendering
// ----------------------------------------------------
async function defaultRender(panel, plugin, context) {
  const { ext, options, currentDownloads, selectedDownloadId, fileSizeToText, refresh, setSelectedDownloadId } = context;

  const request = plugin.capturesDownloads ? currentDownloads.find(r => r.id === selectedDownloadId) : null;
  const activeOptions = Object.assign({}, options, { command: plugin.id });
  
  let cmd = "";
  if (typeof plugin.generate === "function") {
    cmd = request 
      ? await ext.runtime.sendMessage([`${plugin.id}:generateCommand`, request, activeOptions]) 
      : await ext.runtime.sendMessage([`${plugin.id}:generateCommand`, null, activeOptions]);
  }

  // Create Download Picker Container (only if plugin captures downloads)
  if (plugin.capturesDownloads) {
    const pickerContainer = document.createElement("div");
    pickerContainer.className = "options-container";
    pickerContainer.style.marginBottom = "10px";

    const pickerLabel = document.createElement("label");
    pickerLabel.className = "text-input-label";
    pickerLabel.appendChild(document.createTextNode("Intercepted Download:"));

    const pickerSelect = document.createElement("select");
    if (currentDownloads.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "(No intercepted downloads)";
      opt.disabled = true;
      pickerSelect.appendChild(opt);
    } else {
      for (let i = currentDownloads.length - 1; i >= 0; --i) {
        const req = currentDownloads[i];
        const opt = document.createElement("option");
        opt.value = req.id;
        let sizeText = req.size ? ` (${fileSizeToText(req.size)})` : "";
        opt.textContent = `${req.filename || "Untitled"}${sizeText}`;
        if (req.id === selectedDownloadId) {
          opt.selected = true;
        }
        pickerSelect.appendChild(opt);
      }
    }

    pickerSelect.onchange = async (e) => {
      await setSelectedDownloadId(e.target.value);
      refresh();
    };

    pickerLabel.appendChild(pickerSelect);
    pickerContainer.appendChild(pickerLabel);

    const clearBtn = document.createElement("button");
    clearBtn.className = "btn btn-red btn-full";
    clearBtn.style.marginTop = "8px";
    clearBtn.textContent = "Clear Intercept Session";
    if (currentDownloads.length === 0) {
      clearBtn.disabled = true;
    } else {
      clearBtn.onclick = () => {
        ext.runtime.sendMessage([`${plugin.id}:clear`]).then(async () => {
          await setSelectedDownloadId("");
          refresh();
        });
      };
    }
    pickerContainer.appendChild(clearBtn);
    panel.appendChild(pickerContainer);
  }

  // Copy button row (only if generate function exists)
  if (typeof plugin.generate === "function") {
    const nav = document.createElement("div");
    nav.className = "nav";

    const copyBtn = document.createElement("button");
    copyBtn.className = "btn btn-blue btn-full";
    copyBtn.textContent = "Copy Command";
    if (!cmd) {
      copyBtn.disabled = true;
    } else {
      copyBtn.onclick = () => {
        navigator.clipboard.writeText(cmd).then(() => {
          const oldText = copyBtn.textContent;
          copyBtn.textContent = "Copied!";
          setTimeout(() => copyBtn.textContent = oldText, 2000);
        });
      };
    }
    nav.appendChild(copyBtn);
    panel.appendChild(nav);

    // Command Textarea
    const textArea = document.createElement("textarea");
    textArea.value = cmd;
    textArea.readOnly = true;
    textArea.onclick = () => textArea.select();
    panel.appendChild(textArea);
  }

  // Options container
  const inlineOptions = document.createElement("div");
  inlineOptions.className = "options-container";

  // Windows escaping checkbox (if shell escaping is supported by the tool)
  if (plugin && plugin.shellEscaping) {
    const winLabel = document.createElement("label");
    winLabel.className = "checkbox-label";
    const winInput = document.createElement("input");
    winInput.type = "checkbox";
    winInput.checked = options.doubleQuotes;
    winInput.onchange = async (e) => {
      await ext.storage.local.set({ doubleQuotes: e.target.checked });
      refresh();
    };
    winLabel.appendChild(winInput);
    winLabel.appendChild(document.createTextNode("Escape with double-quotes (Windows)"));
    inlineOptions.appendChild(winLabel);
  }

  // Exclude Headers input
  const excludeLabel = document.createElement("label");
  excludeLabel.className = "text-input-label";
  excludeLabel.style.marginTop = "8px";
  excludeLabel.appendChild(document.createTextNode("Exclude headers:"));
  const excludeInput = document.createElement("input");
  excludeInput.type = "text";
  excludeInput.value = options.excludeHeaders || "";
  excludeInput.placeholder = "e.g. Accept-Encoding Connection";
  excludeInput.onchange = async (e) => {
    await ext.storage.local.set({ excludeHeaders: e.target.value });
    refresh();
  };
  excludeLabel.appendChild(excludeInput);
  inlineOptions.appendChild(excludeLabel);

  // Custom Options Inputs (dynamically generated from plugin definition)
  if (plugin && plugin.customInputs) {
    plugin.customInputs.forEach(inputMeta => {
      // Check dependency constraint
      if (inputMeta.dependsOn) {
        const depKey = inputMeta.dependsOn.key;
        const depValue = inputMeta.dependsOn.value;
        if (options[depKey] !== depValue) {
          return;
        }
      }

      if (inputMeta.type === "text") {
        const labelEl = document.createElement("label");
        labelEl.className = "text-input-label";
        labelEl.style.marginTop = "8px";
        labelEl.appendChild(document.createTextNode(inputMeta.label));
        
        const inputEl = document.createElement("input");
        inputEl.type = "text";
        inputEl.value = options[inputMeta.key] || "";
        inputEl.placeholder = inputMeta.placeholder || "";
        inputEl.onchange = async (e) => {
          const update = {};
          update[inputMeta.key] = e.target.value;
          await ext.storage.local.set(update);
          refresh();
        };
        labelEl.appendChild(inputEl);
        inlineOptions.appendChild(labelEl);
      } else if (inputMeta.type === "checkbox") {
        const checkboxLabel = document.createElement("label");
        checkboxLabel.className = "checkbox-label";
        checkboxLabel.style.marginTop = "8px";
        
        const inputEl = document.createElement("input");
        inputEl.type = "checkbox";
        inputEl.checked = !!options[inputMeta.key];
        inputEl.onchange = async (e) => {
          const update = {};
          update[inputMeta.key] = e.target.checked;
          await ext.storage.local.set(update);
          refresh();
        };
        checkboxLabel.appendChild(inputEl);
        checkboxLabel.appendChild(document.createTextNode(inputMeta.label));
        inlineOptions.appendChild(checkboxLabel);
      } else if (inputMeta.type === "select") {
        const labelEl = document.createElement("label");
        labelEl.className = "text-input-label";
        labelEl.style.marginTop = "8px";
        labelEl.appendChild(document.createTextNode(inputMeta.label));

        const selectEl = document.createElement("select");
        (inputMeta.options || []).forEach(opt => {
          const optEl = document.createElement("option");
          optEl.value = opt.value;
          optEl.textContent = opt.name || opt.value;
          if (options[inputMeta.key] === opt.value) {
            optEl.selected = true;
          }
          selectEl.appendChild(optEl);
        });

        selectEl.onchange = async (e) => {
          const update = {};
          update[inputMeta.key] = e.target.value;
          await ext.storage.local.set(update);
          refresh();
        };
        labelEl.appendChild(selectEl);
        inlineOptions.appendChild(labelEl);
      }
    });
  }

  panel.appendChild(inlineOptions);
}

async function renderToolPanel(genId) {
  const panel = document.getElementById("tab-content-area");
  if (!panel) return;
  
  panel.innerHTML = "";
  panel.className = "command-view";

  const activePlugin = globalThis.Plugins.get(genId);
  if (!activePlugin) return;

  // Retrieve current downloads specific to active tool if configured
  if (activePlugin.capturesDownloads) {
    const list = await ext.runtime.sendMessage([`${genId}:getDownloadList`]);
    currentDownloads = list || [];

    // Ensure selectedDownloadId is valid
    if (currentDownloads.length > 0) {
      if (!selectedDownloadId || !currentDownloads.some(d => d.id === selectedDownloadId)) {
        selectedDownloadId = currentDownloads[currentDownloads.length - 1].id;
        await ext.storage.local.set({ selectedDownloadId });
      }
    } else {
      selectedDownloadId = "";
    }
  } else {
    currentDownloads = [];
    selectedDownloadId = "";
  }

  // Retrieve storage options merged with defaults
  const options = await getMergedOptions(activePlugin);

  // Render empty state if plugin captures downloads and has none intercepted
  if (activePlugin.capturesDownloads && currentDownloads.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No downloads intercepted in this session.";
    panel.appendChild(empty);
    return;
  }

  const context = {
    ext,
    options,
    currentDownloads,
    selectedDownloadId,
    fileSizeToText,
    refresh: () => renderToolPanel(genId),
    setSelectedDownloadId: async (id) => {
      selectedDownloadId = id;
      await ext.storage.local.set({ selectedDownloadId: id });
    }
  };

  if (activePlugin && typeof activePlugin.render === "function") {
    await activePlugin.render(panel, context);
  } else if (activePlugin) {
    await defaultRender(panel, activePlugin, context);
  }
}

document.addEventListener("DOMContentLoaded", init);
