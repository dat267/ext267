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
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    append(...nodes) {
      nodes.forEach((n) => this.appendChild(n));
    },
    setAttribute(k, v) {
      this.props[k] = v;
    }
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
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "plugins", "archivr.js"), "utf8"), ctx, {
    filename: "plugins/archivr.js"
  });
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
        if (msg[0] === "archivr:list")
          return [
            { id: 1, url: "https://a.com/1", title: "One", size: 100, ts: Date.now() },
            { id: 2, url: "https://b.com/2", title: "Two", size: 200, ts: Date.now() }
          ];

        if (msg[0] === "archivr:getRecords")
          return [
            { id: 1, url: "https://a.com/1", baseURI: "https://a.com/1", title: "One", ts: 1, html: "<p>1</p>" },
            { id: 2, url: "https://b.com/2", baseURI: "https://b.com/2", title: "Two", ts: 2, html: "<p>2</p>" }
          ];

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
    setTimeout,
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
