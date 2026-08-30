"use strict";

const ext = typeof browser !== "undefined" ? browser : chrome;
const extAction = ext.action;

// Self-registration setup
globalThis.Plugins = globalThis.Plugins || new Map();
if (typeof globalThis.registerPlugin !== "function")
  globalThis.registerPlugin = function (plugin) {
    globalThis.Plugins.set(plugin.id, plugin);
  };

// ----------------------------------------------------
// Utility Helpers (Self-Contained)
// ----------------------------------------------------
function escapeShellArg(arg, doubleQuotes) {
  if (!arg) return "''";
  let ret;

  if (doubleQuotes) {
    ret = arg.replace(/["\\]/g, (m) => `\\${m}`);
    return `"${ret}"`;
  }

  ret = arg.replace(/'/g, () => `'\\''`);
  return `'${ret}'`;
}

function decodeHeaderValue(str) {
  if (!str) return str;
  try {
    return decodeURIComponent(
      str.replace(/[\u0080-\uffff]/g, (ch) => {
        let hex = ch.charCodeAt(0).toString(16);
        while (hex.length < 2) hex = "0" + hex;
        return "%" + hex;
      })
    );
  } catch {
    return str;
  }
}

function getFilenameFromContentDisposition(header) {
  if (!header) return null;

  const filenameStarRegex = /filename\*=(?:utf-8|ascii)''([^;]+)/i;
  const starMatch = header.match(filenameStarRegex);
  if (starMatch && starMatch[1])
    try {
      return decodeURIComponent(starMatch[1].trim());
    } catch {
      /* filename-star decode failure; fall through */
    }

  const filenameQuotedRegex = /filename="([^"\\]*(?:\\.[^"\\]*)*)"/i;
  const quotedMatch = header.match(filenameQuotedRegex);
  if (quotedMatch && quotedMatch[1]) {
    let raw = quotedMatch[1].replace(/\\(.)/g, "$1");
    return decodeHeaderValue(raw) || raw;
  }

  const filenameRegex = /filename=([^;]+)/i;
  const match = header.match(filenameRegex);
  if (match && match[1]) {
    let raw = match[1].trim();
    return decodeHeaderValue(raw) || raw;
  }

  return null;
}

function getFilenameFromUrl(url) {
  if (!url) return "download";

  let j = url.indexOf("?");
  if (j === -1) j = url.indexOf("#");
  if (j === -1) j = url.length;

  let i = url.lastIndexOf("/", j);
  let name = url.slice(i + 1, j);

  if (!name) return "download";

  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

function toQueryString(obj) {
  let parts = [];
  for (let [key, values] of Object.entries(obj))
    if (Array.isArray(values))
      for (let value of values) parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
    else parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(values)}`);

  return parts.join("&");
}

function escapeGlobbing(url) {
  return url.replace(/[[\]{}]/g, (m) => `\\${m.slice(0, 1)}`);
}

// ----------------------------------------------------
// cURL Command Generator
// ----------------------------------------------------
function generateCurl(url, method, headers, payload, filename, options) {
  const esc = escapeShellArg;
  let contentType;
  let parts = ["curl"];

  for (let header of headers) {
    if (!header.value) continue;
    let headerName = header.name.toLowerCase();

    if (headerName === "content-type") {
      contentType = header.value.toLowerCase();
      let v = header.value;
      if (v.startsWith("multipart/form-data;")) v = v.slice(0, 20);
      let h = esc(`${header.name}: ${v}`, options.doubleQuotes);
      parts.push(`--header ${h}`);
    } else if (headerName === "content-length") {
      // Skip
    } else if (headerName === "referer") {
      parts.push(`--referer ${esc(header.value, options.doubleQuotes)}`);
    } else if (headerName === "cookie") {
      parts.push(`--cookie ${esc(header.value, options.doubleQuotes)}`);
    } else if (headerName === "user-agent") {
      parts.push(`--user-agent ${esc(header.value, options.doubleQuotes)}`);
    } else {
      let h = esc(`${header.name}: ${header.value}`, options.doubleQuotes);
      parts.push(`--header ${h}`);
    }
  }

  if (method !== "GET" || payload) parts.push(`--request ${method}`);

  if (payload)
    if (payload.formData)
      if (contentType === "application/x-www-form-urlencoded")
        for (let [key, values] of Object.entries(payload.formData))
          for (let value of values) {
            let v = esc(`${encodeURIComponent(key)}=${value}`, options.doubleQuotes);
            parts.push(`--data-urlencode ${v}`);
          }
      else if (contentType.startsWith("multipart/form-data;"))
        for (let [key, values] of Object.entries(payload.formData))
          for (let value of values) {
            let v = esc(`${encodeURIComponent(key)}=${value}`, options.doubleQuotes);
            parts.push(`--form-string ${v}`);
          }

  parts.push(esc(escapeGlobbing(url), options.doubleQuotes));

  if (filename) parts.push(`--output ${esc(filename, options.doubleQuotes)}`);
  else parts.push("--remote-name --remote-header-name");

  if (options.curlOptions) parts.push(options.curlOptions);

  return parts.join(" ");
}

// ----------------------------------------------------
// Wget Command Generator
// ----------------------------------------------------
function generateWget(url, method, headers, payload, filename, options) {
  const esc = escapeShellArg;
  let contentType;
  let parts = ["wget"];

  for (let header of headers) {
    if (!header.value) continue;
    let headerName = header.name.toLowerCase();

    if (headerName === "content-type") {
      contentType = header.value.toLowerCase();
      let v = header.value;
      if (v.startsWith("multipart/form-data;")) v = v.slice(0, 20);
      let h = esc(`${header.name}: ${v}`, options.doubleQuotes);
      parts.push(`--header ${h}`);
    } else if (headerName === "content-length") {
      // Skip
    } else if (headerName === "referer") {
      parts.push(`--referer ${esc(header.value, options.doubleQuotes)}`);
    } else if (headerName === "user-agent") {
      parts.push(`--user-agent ${esc(header.value, options.doubleQuotes)}`);
    } else {
      let h = esc(`${header.name}: ${header.value}`, options.doubleQuotes);
      parts.push(`--header ${h}`);
    }
  }

  if (method !== "GET" || payload) parts.push(`--method ${method}`);

  if (payload)
    if (payload.formData)
      if (contentType === "application/x-www-form-urlencoded")
        parts.push(`--body-data ${esc(toQueryString(payload.formData))}`);

  parts.push(esc(url, options.doubleQuotes));

  if (filename) parts.push(`--output-document ${esc(filename, options.doubleQuotes)}`);

  if (options.wgetOptions) parts.push(options.wgetOptions);

  return parts.join(" ");
}

// ----------------------------------------------------
// Aria2 Command Generator
// ----------------------------------------------------
function generateAria2(url, method, headers, payload, filename, options) {
  if (method !== "GET") throw new Error("Unsupported HTTP method");

  const esc = escapeShellArg;
  let parts = ["aria2c"];

  for (let header of headers) {
    if (!header.value) continue;
    let headerName = header.name.toLowerCase();

    if (headerName === "referer") {
      parts.push(`--referer ${esc(header.value, options.doubleQuotes)}`);
    } else if (headerName === "user-agent") {
      parts.push(`--user-agent ${esc(header.value, options.doubleQuotes)}`);
    } else {
      let h = esc(`${header.name}: ${header.value}`, options.doubleQuotes);
      parts.push(`--header ${h}`);
    }
  }

  parts.push(esc(url, options.doubleQuotes));

  if (filename) parts.push(`--out ${esc(filename, options.doubleQuotes)}`);

  if (options.aria2Options) parts.push(options.aria2Options);

  return parts.join(" ");
}

function generate(url, method, headers, payload, filename, options) {
  const tool = options.cliTool || "curl";
  switch (tool) {
    case "curl":
      return generateCurl(url, method, headers, payload, filename, options);
    case "wget":
      return generateWget(url, method, headers, payload, filename, options);
    case "aria2":
      return generateAria2(url, method, headers, payload, filename, options);
    default:
      throw new Error(`Unknown CLI tool: ${tool}`);
  }
}

// ----------------------------------------------------
// Isolated Background Execution (Service Worker / Event Page context)
// Chrome MV3: typeof window === "undefined" (pure service worker)
// Firefox MV3: background.scripts loads at _generated_background_page.html
// ----------------------------------------------------
const _isBackground =
  typeof window === "undefined" || (typeof location !== "undefined" && location.pathname !== "/popup.html");
if (_isBackground) {
  const MAX_ITEMS = 10;
  const currentRequests = new Map();

  const getDownloads = async () => {
    let res = await ext.storage.local.get("_cliget_downloads");
    return res._cliget_downloads || [];
  };

  const saveDownloads = async (downloadsArray) => {
    await ext.storage.local.set({ _cliget_downloads: downloadsArray });
  };

  const clearDownloads = async () => {
    await ext.storage.local.remove("_cliget_downloads");
    if (extAction && extAction.setBadgeText) extAction.setBadgeText({ text: "" });
  };

  // Serialize storage read-modify-write saves. Parallel request completions
  // (e.g. several downloads finishing at once) must not clobber each other's
  // writes or miscount the badge, so every save runs through one queue.
  let saveQueue = Promise.resolve();

  const saveOneDownload = async (request) => {
    let downloads = await getDownloads();
    if (downloads.some((d) => d.url === request.url && Math.abs(d.timestamp - request.timestamp) < 5000)) return;

    downloads.push(request);
    if (downloads.length > MAX_ITEMS) downloads = downloads.slice(-MAX_ITEMS);
    await saveDownloads(downloads);
    await ext.storage.local.set({ selectedDownloadId: request.id });

    if (extAction && extAction.getBadgeText) {
      const txt = await extAction.getBadgeText({});
      const num = parseInt(txt, 10) || 0;
      extAction.setBadgeText({ text: `${num + 1}` });
    }
  };

  const saveToDownloads = (request) => {
    const run = saveQueue.then(() => saveOneDownload(request));
    // Keep the chain alive even if one save rejects.
    saveQueue = run.catch(() => {});
    return run;
  };

  const beforeRequestCallback = (details) => {
    if (details.tabId >= 0) {
      const now = Date.now();

      const payload = details.requestBody;

      currentRequests.set(details.requestId, {
        id: details.requestId,
        method: details.method,
        url: details.url,
        type: details.type,
        timestamp: now,
        payload: payload
      });

      if (currentRequests.size > 150) {
        const oldestKey = currentRequests.keys().next().value;
        currentRequests.delete(oldestKey);
      }
    }
  };

  const sendHeadersCallback = (details) => {
    const req = currentRequests.get(details.requestId);
    if (req) req.headers = details.requestHeaders;
  };

  const responseStartedCallback = (details) => {
    const request = currentRequests.get(details.requestId);
    if (!request) return;

    currentRequests.delete(details.requestId);

    let contentType,
      contentDisposition,
      size = 0;
    let filename = "";

    if (details.responseHeaders)
      for (let header of details.responseHeaders) {
        let headerName = header.name.toLowerCase();
        if (headerName === "content-type") {
          contentType = header.value?.toLowerCase();
        } else if (headerName === "content-disposition") {
          contentDisposition = header.value?.toLowerCase();
          filename = getFilenameFromContentDisposition(header.value);
        } else if (headerName === "content-length") {
          size = parseInt(header.value || "0", 10);
        }
      }

    if (!filename) filename = getFilenameFromUrl(request.url);

    request.filename = filename;
    request.size = size;

    if (request.type === "main_frame" || request.type === "sub_frame") {
      if (details.statusCode !== 200 || details.fromCache) return;

      const isAttachment = contentDisposition && contentDisposition.includes("attachment");
      let isDownload = false;

      if (isAttachment) isDownload = true;
      else if (contentType)
        if (
          !contentType.includes("text/html") &&
          !contentType.includes("text/plain") &&
          !contentType.includes("application/xhtml") &&
          !contentType.includes("application/xml") &&
          !contentType.includes("image/")
        )
          isDownload = true;

      if (isDownload) saveToDownloads(request);
    }
  };

  // Register WebRequest listeners for cliget downloads interception
  const filter = { urls: ["<all_urls>"], types: ["main_frame", "sub_frame"] };

  ext.webRequest.onBeforeRequest.addListener(beforeRequestCallback, filter, ["requestBody"]);

  ext.webRequest.onSendHeaders.addListener(sendHeadersCallback, filter, ["requestHeaders"]);

  ext.webRequest.onResponseStarted.addListener(responseStartedCallback, filter, ["responseHeaders"]);

  // Free pending entries on redirect (no onResponseStarted fires for the
  // original request) and on error (aborted / failed requests).
  ext.webRequest.onBeforeRedirect.addListener(
    (details) => {
      currentRequests.delete(details.requestId);
    },
    filter,
    ["responseHeaders"]
  );

  ext.webRequest.onErrorOccurred.addListener((details) => {
    currentRequests.delete(details.requestId);
  }, filter);

  if (extAction && extAction.setBadgeBackgroundColor) extAction.setBadgeBackgroundColor({ color: "#4a90d9" });

  // Handle cliget popup request commands
  ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const name = msg[0];
    const args = msg.slice(1);

    if (name === "cliget:getDownloadList") {
      getDownloads().then(sendResponse);
      return true;
    } else if (name === "cliget:clear") {
      clearDownloads().then(sendResponse);
      return true;
    } else if (name === "cliget:generateCommand") {
      const [requestOrId, options] = args;

      const proceedWithRequest = (request) => {
        if (!request) {
          sendResponse("Request not found");
          return;
        }

        const excludeHeaders = (options.excludeHeaders || "").split(" ").map((h) => h.toLowerCase());

        const headers = (request.headers || []).filter((h) => excludeHeaders.indexOf(h.name.toLowerCase()) === -1);

        try {
          const cmd = generate(
            request.url,
            request.method,
            headers,
            request.payload,
            request.filename || null,
            options
          );
          sendResponse(cmd);
        } catch (err) {
          sendResponse(`Error generating command: ${err.message}`);
        }
      };

      if (typeof requestOrId === "object" && requestOrId !== null) proceedWithRequest(requestOrId);
      else if (requestOrId)
        getDownloads().then((downloads) => {
          let request = downloads.find((r) => r.id === requestOrId);
          proceedWithRequest(request);
        });
      else proceedWithRequest(null);

      return true;
    }
  });
}

// ----------------------------------------------------
// Registry Registration & Custom Popup Render UI
// ----------------------------------------------------
globalThis.registerPlugin({
  id: "cliget",
  name: "cliget",
  defaultOptions: {
    cliTool: "curl",
    curlOptions: "",
    wgetOptions: "",
    aria2Options: ""
  },
  customInputs: [
    {
      key: "cliTool",
      label: "CLI Tool:",
      type: "select",
      options: [
        { value: "curl", name: "cURL" },
        { value: "wget", name: "Wget" },
        { value: "aria2", name: "Aria2" }
      ]
    },
    {
      key: "curlOptions",
      label: "Extra cURL arguments:",
      placeholder: "e.g. --insecure",
      type: "text",
      dependsOn: { key: "cliTool", value: "curl" }
    },
    {
      key: "wgetOptions",
      label: "Extra Wget arguments:",
      placeholder: "e.g. --no-check-certificate",
      type: "text",
      dependsOn: { key: "cliTool", value: "wget" }
    },
    {
      key: "aria2Options",
      label: "Extra Aria2 arguments:",
      placeholder: "e.g. --max-connection-per-server=4",
      type: "text",
      dependsOn: { key: "cliTool", value: "aria2" }
    }
  ],
  render: async function (panel, context) {
    const { refresh } = context;

    // Clear the badge whenever this plugin's panel is opened
    if (extAction && extAction.setBadgeText) extAction.setBadgeText({ text: "" });

    // Local fileSizeToText helper
    const fileSizeToText = (size) => {
      let val = size;
      const units = ["B", "KB", "MB", "GB", "TB"];
      let i = 0;
      while (val >= 1024 && i < units.length - 1) {
        val /= 1024;
        i++;
      }
      return `${val.toFixed(1)} ${units[i]}`;
    };

    // Load state and download list
    const list = await ext.runtime.sendMessage(["cliget:getDownloadList"]);
    const currentDownloads = list || [];

    const stored = await ext.storage.local.get(["selectedDownloadId"]);
    let selectedDownloadId = stored.selectedDownloadId;

    if (currentDownloads.length > 0) {
      if (!selectedDownloadId || !currentDownloads.some((d) => d.id === selectedDownloadId)) {
        selectedDownloadId = currentDownloads[currentDownloads.length - 1].id;
        await ext.storage.local.set({ selectedDownloadId });
      }
    } else {
      selectedDownloadId = "";
    }

    if (currentDownloads.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "No downloads intercepted in this session.";
      panel.appendChild(empty);
      return;
    }

    // Merge options
    const defaults = Object.assign(
      { doubleQuotes: false, excludeHeaders: "Accept-Encoding Connection" },
      this.defaultOptions || {}
    );
    const storedOptions = await ext.storage.local.get();
    const options = Object.assign({}, defaults, storedOptions);

    const request = currentDownloads.find((r) => r.id === selectedDownloadId);
    const activeOptions = Object.assign({}, options);
    const cmd = request ? await ext.runtime.sendMessage(["cliget:generateCommand", request, activeOptions]) : "";

    // Create Download Picker Container
    const pickerContainer = document.createElement("div");
    pickerContainer.className = "options-container";
    pickerContainer.style.marginBottom = "10px";

    const pickerLabel = document.createElement("label");
    pickerLabel.className = "text-input-label";
    pickerLabel.appendChild(document.createTextNode("Intercepted Download:"));

    const pickerSelect = document.createElement("select");
    for (let i = currentDownloads.length - 1; i >= 0; --i) {
      const req = currentDownloads[i];
      const opt = document.createElement("option");
      opt.value = req.id;
      let sizeText = req.size ? ` (${fileSizeToText(req.size)})` : "";
      opt.textContent = `${req.filename || "Untitled"}${sizeText}`;
      if (req.id === selectedDownloadId) opt.selected = true;

      pickerSelect.appendChild(opt);
    }

    pickerSelect.onchange = async (e) => {
      await ext.storage.local.set({ selectedDownloadId: e.target.value });
      refresh();
    };

    pickerLabel.appendChild(pickerSelect);
    pickerContainer.appendChild(pickerLabel);

    const clearBtn = document.createElement("button");
    clearBtn.className = "btn btn-red btn-full";
    clearBtn.style.marginTop = "8px";
    clearBtn.textContent = "Clear Intercept Session";
    clearBtn.onclick = () => {
      ext.runtime.sendMessage(["cliget:clear"]).then(async () => {
        await ext.storage.local.remove("selectedDownloadId");
        refresh();
      });
    };
    pickerContainer.appendChild(clearBtn);
    panel.appendChild(pickerContainer);

    // Copy button row
    const nav = document.createElement("div");
    nav.className = "nav";

    const copyBtn = document.createElement("button");
    copyBtn.className = "btn btn-blue btn-full";
    copyBtn.textContent = "Copy Command";
    if (!cmd) copyBtn.disabled = true;
    else
      copyBtn.onclick = () => {
        navigator.clipboard.writeText(cmd).then(() => {
          const oldText = copyBtn.textContent;
          copyBtn.textContent = "Copied!";
          setTimeout(() => (copyBtn.textContent = oldText), 2000);
        });
      };

    nav.appendChild(copyBtn);
    panel.appendChild(nav);

    // Command Textarea
    const textArea = document.createElement("textarea");
    textArea.value = cmd;
    textArea.readOnly = true;
    textArea.onclick = () => textArea.select();
    panel.appendChild(textArea);

    // Options container
    const inlineOptions = document.createElement("div");
    inlineOptions.className = "options-container";

    // Windows escaping checkbox
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
    const customInputs = this.customInputs || [];
    customInputs.forEach((inputMeta) => {
      if (inputMeta.dependsOn) {
        const depKey = inputMeta.dependsOn.key;
        const depValue = inputMeta.dependsOn.value;
        if (options[depKey] !== depValue) return;
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
        (inputMeta.options || []).forEach((opt) => {
          const optEl = document.createElement("option");
          optEl.value = opt.value;
          optEl.textContent = opt.name || opt.value;
          if (options[inputMeta.key] === opt.value) optEl.selected = true;

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

    panel.appendChild(inlineOptions);
  }
});
