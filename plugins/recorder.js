"use strict";

const ext = typeof browser !== "undefined" ? browser : chrome;
const extAction = ext.action || ext.browserAction;

globalThis.Plugins = globalThis.Plugins || new Map();
if (typeof globalThis.registerPlugin !== "function")
  globalThis.registerPlugin = function (plugin) {
    globalThis.Plugins.set(plugin.id, plugin);
  };

const _isBackground =
  typeof window === "undefined" || (typeof location !== "undefined" && location.pathname !== "/popup.html");

if (_isBackground) {
  const MAX_REQUESTS = 500;
  const MAX_BODY_BYTES = 50 * 1024;
  const FIFO_LIMIT = 200;
  const MAX_PAGES = 50;

  let isRecording = false;
  let currentPage = null;

  let session = {
    startTime: null,
    endTime: null,
    pages: []
  };

  const pendingRequests = new Map();

  function getOrCreatePage(tabId, url, title) {
    if (currentPage && currentPage.tabId === tabId) {
      if (url && !currentPage.url) {
        currentPage.url = url;
        currentPage.title = title || "";
      }
      return currentPage;
    }
    for (let i = session.pages.length - 1; i >= 0; i--)
      if (session.pages[i].tabId === tabId) {
        currentPage = session.pages[i];
        if (url && !currentPage.url) {
          currentPage.url = url;
          currentPage.title = title || "";
        }
        return currentPage;
      }

    if (!isRecording) return null;
    if (session.pages.length >= MAX_PAGES) session.pages.shift();

    currentPage = {
      tabId: tabId,
      url: url || "",
      title: title || "",
      startTime: Date.now(),
      endTime: null,
      requests: []
    };
    session.pages.push(currentPage);
    return currentPage;
  }

  function decodeBody(raw) {
    if (!raw || !raw.length) return null;
    let total = 0;
    for (let i = 0; i < raw.length; i++) if (raw[i].bytes) total += raw[i].bytes.byteLength;

    if (total > MAX_BODY_BYTES * 2) return null;
    const decoder = new TextDecoder();
    const parts = [];
    let remaining = MAX_BODY_BYTES;
    for (let i = 0; i < raw.length && remaining > 0; i++)
      if (raw[i].bytes) {
        const slice = raw[i].bytes.slice(0, remaining);
        parts.push(decoder.decode(slice));
        remaining -= slice.byteLength;
      }

    let body = parts.join("");
    if (total > MAX_BODY_BYTES) body += "\n... [body truncated]";

    return body;
  }

  function addRequest(details, extra) {
    if (!isRecording) return;
    const tabId = details.tabId >= 0 ? details.tabId : -1;
    let page = getOrCreatePage(tabId, "", "");
    if (!page) return;

    if (page.requests.length >= MAX_REQUESTS) page.requests.shift();

    page.requests.push({
      id: details.requestId || "",
      url: details.url || "",
      method: details.method || "GET",
      type: details.type || "other",
      statusCode: extra.statusCode || null,
      contentType: extra.contentType || "",
      requestHeaders: extra.requestHeaders || [],
      responseHeaders: extra.responseHeaders || [],
      requestBody: extra.requestBody || null,
      startTime: details.timeStamp,
      endTime: extra.endTime || null
    });
  }

  ext.webRequest.onBeforeRequest.addListener(
    (details) => {
      if (!isRecording) return;

      if (pendingRequests.size > FIFO_LIMIT) {
        const oldestKey = pendingRequests.keys().next().value;
        pendingRequests.delete(oldestKey);
      }

      let requestBody = null;
      if (details.requestBody) {
        if (details.requestBody.raw) requestBody = decodeBody(details.requestBody.raw);

        if (!requestBody && details.requestBody.formData)
          try {
            requestBody = JSON.stringify(details.requestBody.formData);
          } catch {
            requestBody = null;
          }
      }

      pendingRequests.set(details.requestId, {
        url: details.url,
        method: details.method,
        type: details.type,
        tabId: details.tabId,
        timeStamp: details.timeStamp,
        requestBody: requestBody,
        requestHeaders: [],
        responseHeaders: [],
        statusCode: null,
        contentType: ""
      });

      if (details.type === "main_frame" && details.tabId >= 0)
        ext.tabs
          .get(details.tabId)
          .then((tab) => {
            getOrCreatePage(details.tabId, details.url, tab.title || "");
          })
          .catch(() => {
            getOrCreatePage(details.tabId, details.url, "");
          });
    },
    { urls: ["<all_urls>"] },
    ["requestBody"]
  );

  ext.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
      if (!isRecording) return;
      const pending = pendingRequests.get(details.requestId);
      if (pending) pending.requestHeaders = details.requestHeaders || [];
    },
    { urls: ["<all_urls>"] },
    ["requestHeaders"]
  );

  ext.webRequest.onResponseStarted.addListener(
    (details) => {
      if (!isRecording) return;
      const pending = pendingRequests.get(details.requestId);
      if (pending) {
        pending.statusCode = details.statusCode;
        pending.responseHeaders = details.responseHeaders || [];
        for (let i = 0; i < pending.responseHeaders.length; i++)
          if (pending.responseHeaders[i].name.toLowerCase() === "content-type") {
            pending.contentType = pending.responseHeaders[i].value || "";
            break;
          }
      }
    },
    { urls: ["<all_urls>"] },
    ["responseHeaders"]
  );

  ext.webRequest.onCompleted.addListener(
    (details) => {
      if (!isRecording) return;
      const pending = pendingRequests.get(details.requestId);
      if (pending) {
        addRequest(
          {
            requestId: details.requestId,
            url: pending.url,
            method: pending.method,
            type: pending.type,
            tabId: pending.tabId,
            timeStamp: pending.timeStamp
          },
          {
            statusCode: pending.statusCode,
            contentType: pending.contentType,
            requestHeaders: pending.requestHeaders,
            responseHeaders: pending.responseHeaders,
            requestBody: pending.requestBody,
            endTime: details.timeStamp
          }
        );
        pendingRequests.delete(details.requestId);
      }
    },
    { urls: ["<all_urls>"] }
  );

  ext.webRequest.onErrorOccurred.addListener(
    (details) => {
      if (!isRecording) return;
      const pending = pendingRequests.get(details.requestId);
      if (pending) {
        addRequest(
          {
            requestId: details.requestId,
            url: pending.url,
            method: pending.method,
            type: pending.type,
            tabId: pending.tabId,
            timeStamp: pending.timeStamp
          },
          {
            statusCode: details.error || -1,
            contentType: pending.contentType,
            requestHeaders: pending.requestHeaders,
            responseHeaders: [],
            requestBody: pending.requestBody,
            endTime: details.timeStamp
          }
        );
        pendingRequests.delete(details.requestId);
      }
    },
    { urls: ["<all_urls>"] }
  );

  ext.webRequest.onBeforeRedirect.addListener(
    (details) => {
      if (!isRecording) return;
      pendingRequests.delete(details.requestId);
    },
    { urls: ["<all_urls>"] }
  );

  function persistSession() {
    if (session.pages.length > 0 || session.startTime)
      ext.storage.session.set({ _recorder_session: session }).catch(() => {});
  }

  ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!Array.isArray(msg)) return;
    const name = msg[0];
    const args = msg.slice(1);

    if (name === "recorder:start") {
      if (!isRecording) {
        isRecording = true;
        session = {
          startTime: Date.now(),
          endTime: null,
          pages: []
        };
        currentPage = null;
        ext.storage.session
          .set({
            _recorder_status: "recording",
            _recorder_started: Date.now()
          })
          .catch(() => {});
        extAction.setBadgeText({ text: "REC" }).catch(() => {});
        extAction.setBadgeBackgroundColor({ color: "#e22850" }).catch(() => {});
        sendResponse({ success: true, status: "recording" });
      } else {
        sendResponse({ success: false, status: "already-recording" });
      }
      return false;
    }

    if (name === "recorder:stop") {
      if (isRecording) {
        isRecording = false;
        if (currentPage) {
          currentPage.endTime = Date.now();
          currentPage = null;
        }
        session.endTime = Date.now();
        persistSession();
        extAction.setBadgeText({ text: "" }).catch(() => {});
        ext.storage.session
          .set({
            _recorder_status: "idle",
            _recorder_session: session
          })
          .catch(() => {});
        sendResponse({
          success: true,
          status: "idle",
          pageCount: session.pages.length,
          requestCount: session.pages.reduce((s, p) => s + p.requests.length, 0)
        });
      } else {
        sendResponse({ success: false, status: "not-recording" });
      }
      return false;
    }

    if (name === "recorder:getStatus") {
      sendResponse({
        isRecording: isRecording,
        session: session,
        pageCount: session.pages.length,
        requestCount: session.pages.reduce((sum, p) => sum + p.requests.length, 0),
        startTime: session.startTime
      });
      return false;
    }

    if (name === "recorder:clear") {
      session = { startTime: null, endTime: null, pages: [] };
      currentPage = null;
      pendingRequests.clear();
      ext.storage.session.remove("_recorder_session").catch(() => {});
      ext.storage.session.remove("_recorder_status").catch(() => {});
      extAction.setBadgeText({ text: "" }).catch(() => {});
      sendResponse({ success: true });
      return false;
    }

    if (name === "recorder:export") {
      const format = args[0] || "markdown";
      const exported = format === "json" ? JSON.stringify(session, null, 2) : generateMarkdown(session);
      sendResponse({ success: true, data: exported, format: format });
      return false;
    }
  });

  function generateMarkdown(sessionData) {
    const lines = [];

    lines.push("# Web Recording Session");
    lines.push("");

    if (sessionData.startTime) lines.push(`- **Date**: ${new Date(sessionData.startTime).toISOString()}`);

    if (sessionData.endTime && sessionData.startTime) {
      const durSec = Math.round((sessionData.endTime - sessionData.startTime) / 1000);
      const min = Math.floor(durSec / 60);
      const sec = durSec % 60;
      lines.push(`- **Duration**: ${durSec}s (${min}m ${sec}s)`);
    }
    lines.push(`- **Pages Visited**: ${sessionData.pages.length}`);
    const totalReq = sessionData.pages.reduce((s, p) => s + p.requests.length, 0);
    lines.push(`- **Total Requests**: ${totalReq}`);
    lines.push("");
    lines.push("---");
    lines.push("");

    for (let pi = 0; pi < sessionData.pages.length; pi++) {
      const page = sessionData.pages[pi];
      const disp = page.url || page.title || "(unknown)";
      lines.push(`## Page ${pi + 1}: ${disp}`);

      if (page.title) lines.push(`- **Title**: ${page.title}`);

      if (page.endTime && page.startTime) {
        const durSec = Math.round((page.endTime - page.startTime) / 1000);
        lines.push(`- **Duration**: ${durSec}s`);
      }
      lines.push(`- **Requests**: ${page.requests.length}`);
      lines.push("");

      const endpoints = {};
      const scripts = [];

      for (const req of page.requests) {
        if (req.type === "script") {
          scripts.push(req.url);
          continue;
        }

        let host;
        try {
          host = new URL(req.url).origin;
        } catch {
          host = "(invalid-url)";
        }

        if (!endpoints[host]) endpoints[host] = [];

        endpoints[host].push(req);
      }

      const hosts = Object.keys(endpoints).sort();
      for (const host of hosts) {
        lines.push(`### Domain: ${host}`);
        lines.push("");

        const reqs = endpoints[host];
        for (let ri = 0; ri < reqs.length; ri++) {
          const req = reqs[ri];
          const favIcon = req.type === "xmlhttprequest" || req.type === "fetch" ? " [API]" : "";
          let path;
          try {
            path = new URL(req.url).pathname + new URL(req.url).search;
          } catch {
            path = req.url;
          }

          lines.push(`#### ${req.method} ${path}${favIcon}`);
          lines.push(`- **Full URL**: ${req.url}`);
          lines.push(`- **Type**: ${req.type}`);
          lines.push(`- **Status**: ${req.statusCode != null ? req.statusCode : "cancelled"}`);
          if (req.contentType) lines.push(`- **Content-Type**: ${req.contentType}`);

          if (req.endTime && req.startTime) {
            const ms = Math.round(req.endTime - req.startTime);
            lines.push(`- **Timing**: ${ms}ms`);
          }

          if (req.requestHeaders && req.requestHeaders.length) {
            lines.push("");
            lines.push("**Request Headers:**");
            lines.push("");
            lines.push("| Header | Value |");
            lines.push("|--------|-------|");
            for (const h of req.requestHeaders) {
              let val = h.value ? h.value.substring(0, 300) : "";
              val = val.replace(/\|/g, "\\|");
              lines.push(`| ${h.name} | ${val} |`);
            }
          }

          if (req.requestBody) {
            lines.push("");
            lines.push("**Request Body:**");
            lines.push("");
            let lang = "";
            if (req.contentType && req.contentType.includes("json")) lang = "json";

            lines.push("```" + lang);
            lines.push(truncateStr(req.requestBody, 5000));
            lines.push("```");
          }

          if (req.responseHeaders && req.responseHeaders.length) {
            lines.push("");
            lines.push("**Response Headers:**");
            lines.push("");
            lines.push("| Header | Value |");
            lines.push("|--------|-------|");
            for (const h of req.responseHeaders) {
              let val = h.value ? h.value.substring(0, 300) : "";
              val = val.replace(/\|/g, "\\|");
              lines.push(`| ${h.name} | ${val} |`);
            }
          }

          lines.push("");
        }
      }

      if (scripts.length) {
        const unique = [...new Set(scripts)];
        lines.push("### Loaded Scripts");
        lines.push("");
        for (const url of unique) lines.push(`- \`${url}\``);

        lines.push("");
      }
    }

    lines.push("---");
    lines.push("");
    lines.push("*Generated by ext267 Activity Recorder*");

    return lines.join("\n");
  }

  function truncateStr(str, maxLen) {
    if (typeof str !== "string") str = JSON.stringify(str);
    if (str.length <= maxLen) return str;
    return str.substring(0, maxLen) + "\n... [truncated, " + (str.length - maxLen) + " more bytes]";
  }

  ext.storage.session.get(["_recorder_status", "_recorder_session"]).then((result) => {
    if (result._recorder_status === "recording") {
      isRecording = true;
      extAction.setBadgeText({ text: "REC" }).catch(() => {});
      extAction.setBadgeBackgroundColor({ color: "#e22850" }).catch(() => {});
    }
    if (result._recorder_session) session = result._recorder_session;
  });
}

async function render(panel, context) {
  const { refresh } = context;

  const status = await ext.runtime.sendMessage(["recorder:getStatus"]);

  const header = document.createElement("div");
  header.style.cssText = "display:flex;align-items:center;justify-content:space-between;";

  const title = document.createElement("h2");
  title.textContent = "Activity Recorder";
  title.style.cssText = "margin:0;font-size:14px;";
  header.appendChild(title);

  if (status.isRecording) {
    const dot = document.createElement("span");
    dot.className = "recording-indicator";
    dot.style.cssText =
      "width:12px;height:12px;background:#e22850;border-radius:50%;display:inline-block;flex-shrink:0;";
    header.appendChild(dot);
  }

  panel.appendChild(header);

  const statsDiv = document.createElement("div");
  statsDiv.className = "options-container";
  statsDiv.style.cssText = "font-size:12px;";

  const grid = document.createElement("div");
  grid.style.cssText = "display:grid;grid-template-columns:auto 1fr;gap:4px 10px;";

  const rows = [
    ["Status:", "strong", status.isRecording ? "Recording" : "Idle"],
    ["Pages:", "span", String(status.pageCount || 0)],
    ["Requests:", "span", String(status.requestCount || 0)]
  ];
  if (status.startTime) rows.push(["Started:", "span", new Date(status.startTime).toLocaleTimeString()]);

  for (const [label, tag, value] of rows) {
    const l = document.createElement("span");
    l.style.cssText = "opacity:0.7";
    l.textContent = label;
    grid.appendChild(l);

    const v = document.createElement(tag);
    v.textContent = value;
    grid.appendChild(v);
  }

  statsDiv.appendChild(grid);
  panel.appendChild(statsDiv);

  const ctrlRow = document.createElement("div");
  ctrlRow.className = "nav";
  ctrlRow.style.cssText = "gap:6px;";

  const recBtn = document.createElement("button");
  recBtn.className = "btn btn-full " + (status.isRecording ? "btn-red" : "btn-blue");
  recBtn.textContent = status.isRecording ? "Stop Recording" : "Start Recording";
  recBtn.onclick = async () => {
    if (status.isRecording) await ext.runtime.sendMessage(["recorder:stop"]);
    else await ext.runtime.sendMessage(["recorder:start"]);

    refresh();
  };
  ctrlRow.appendChild(recBtn);
  panel.appendChild(ctrlRow);

  if (!status.isRecording && status.requestCount > 0) {
    const exportRow = document.createElement("div");
    exportRow.className = "nav";
    exportRow.style.cssText = "gap:6px;";

    const mdBtn = document.createElement("button");
    mdBtn.className = "btn btn-full btn-blue";
    mdBtn.textContent = "Export as Markdown";
    mdBtn.onclick = async () => {
      mdBtn.textContent = "Exporting...";
      mdBtn.disabled = true;
      try {
        const result = await ext.runtime.sendMessage(["recorder:export", "markdown"]);
        if (result && result.success) {
          const blob = new Blob([result.data], { type: "text/markdown;charset=utf-8" });
          const url = URL.createObjectURL(blob);
          const ts = new Date().toISOString().replace(/[:.]/g, "-").substring(0, 19);
          await ext.downloads.download({
            url: url,
            filename: `recording-${ts}.md`,
            saveAs: true
          });
          setTimeout(() => URL.revokeObjectURL(url), 10000);
        }
      } catch (err) {
        mdBtn.textContent = "Failed: " + err.message;
        setTimeout(() => {
          mdBtn.textContent = "Export as Markdown";
          mdBtn.disabled = false;
        }, 3000);
        return;
      }
      mdBtn.textContent = "Export as Markdown";
      mdBtn.disabled = false;
    };
    exportRow.appendChild(mdBtn);

    const jsonBtn = document.createElement("button");
    jsonBtn.className = "btn btn-full";
    jsonBtn.textContent = "Export as JSON";
    jsonBtn.onclick = async () => {
      jsonBtn.textContent = "Exporting...";
      jsonBtn.disabled = true;
      try {
        const result = await ext.runtime.sendMessage(["recorder:export", "json"]);
        if (result && result.success) {
          const blob = new Blob([result.data], { type: "application/json;charset=utf-8" });
          const url = URL.createObjectURL(blob);
          const ts = new Date().toISOString().replace(/[:.]/g, "-").substring(0, 19);
          await ext.downloads.download({
            url: url,
            filename: `recording-${ts}.json`,
            saveAs: true
          });
          setTimeout(() => URL.revokeObjectURL(url), 10000);
        }
      } catch (err) {
        jsonBtn.textContent = "Failed: " + err.message;
        setTimeout(() => {
          jsonBtn.textContent = "Export as JSON";
          jsonBtn.disabled = false;
        }, 3000);
        return;
      }
      jsonBtn.textContent = "Export as JSON";
      jsonBtn.disabled = false;
    };
    exportRow.appendChild(jsonBtn);
    panel.appendChild(exportRow);

    const clearBtn = document.createElement("button");
    clearBtn.className = "btn btn-full btn-red";
    clearBtn.style.cssText = "margin-top:4px;";
    clearBtn.textContent = "Clear All Recordings";
    clearBtn.onclick = async () => {
      await ext.runtime.sendMessage(["recorder:clear"]);
      refresh();
    };
    panel.appendChild(clearBtn);
  }

  if (status.isRecording) {
    const hint = document.createElement("div");
    hint.className = "empty-state";
    hint.style.cssText = "padding:14px;font-size:11px;";
    hint.textContent =
      "Recording active. Browse normally — all network requests are being captured. Click Stop when done.";
    panel.appendChild(hint);
  }

  if (!status.isRecording && status.pageCount === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = 'No recordings yet. Click "Start Recording" to begin capturing network activity.';
    panel.appendChild(empty);
  }
}

globalThis.registerPlugin({
  id: "recorder",
  name: "Activity Recorder",
  render: render
});
