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

function makeSandbox(messages) {
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
  return {
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
}

function stubSteps(ctx) {
  // stub the heavy pure steps so the test stays fast
  ctx.buildArchive = async () => new Uint8Array([1, 2, 3]);
  ctx.bytesToBase64 = () => "AQID";
}

function makePanelRunner(ctx) {
  const plugin = ctx.Plugins.get("archivr");
  const panel = makeElement("div");
  let lastRefresh = null;
  const refresh = () => {
    panel.children = [];
    lastRefresh = plugin.render(panel, { refresh });
    return lastRefresh;
  };
  return {
    panel,
    refresh,
    get lastRefresh() {
      return lastRefresh;
    }
  };
}

function labelChildrenText(label) {
  return label.children
    .filter((c) => c.isText)
    .map((c) => c.textContent)
    .join("");
}

function findSelectAllInput(panel) {
  const label = panel.children.find((c) => c.tag === "label" && labelChildrenText(c) === "Select all");
  return label && label.children.find((c) => c.tag === "input");
}

function findRowCbs(panel) {
  return panel.children
    .filter(
      (c) => c.tag === "label" && c.children.some((k) => k.tag === "input") && c.children.some((k) => k.tag === "span")
    )
    .map((c) => c.children.find((k) => k.tag === "input"));
}

function findSaveBtn(panel) {
  return panel.children.find((c) => c.tag === "button" && /Save selected/.test(c.textContent));
}

test("render loads list, renders rows, and save triggers a download message", async () => {
  const messages = [];
  const ctx = loadPopup(makeSandbox(messages));
  stubSteps(ctx);
  const runner = makePanelRunner(ctx);
  await runner.refresh();

  const checks = runner.panel.children.filter((c) => c.tag === "label");
  assert.ok(checks.length >= 3, "toggle + select-all + 2 rows rendered");

  const saveBtn = findSaveBtn(runner.panel);
  assert.ok(saveBtn, "save button present");
  await saveBtn.onclick();

  assert.ok(messages.some((m) => m[0] === "archivr:getRecords" && m[1].length === 2));
  assert.ok(messages.some((m) => m[0] === "archivr:download" && m[1].filename.endsWith(".zip")));
});

test("unchecking select-all stays unchecked across refresh", async () => {
  const messages = [];
  const ctx = loadPopup(makeSandbox(messages));
  stubSteps(ctx);
  const runner = makePanelRunner(ctx);
  await runner.refresh();

  const selectAll = findSelectAllInput(runner.panel);
  assert.equal(selectAll.checked, true, "select-all starts checked");

  selectAll.checked = false;
  selectAll.onchange({ target: selectAll });
  await runner.lastRefresh;

  assert.equal(findSelectAllInput(runner.panel).checked, false, "select-all stays unchecked after refresh");
  assert.deepEqual(
    findRowCbs(runner.panel).map((cb) => cb.checked),
    [false, false],
    "no rows re-selected after select-all uncheck"
  );
});

test("refresh after toggling a row off keeps that row deselected", async () => {
  const messages = [];
  const ctx = loadPopup(makeSandbox(messages));
  stubSteps(ctx);
  const runner = makePanelRunner(ctx);
  await runner.refresh();

  const rowCbs = findRowCbs(runner.panel);
  assert.equal(rowCbs.length, 2, "two row checkboxes rendered");
  rowCbs[1].checked = false;
  rowCbs[1].onchange();
  await runner.lastRefresh;

  assert.deepEqual(
    findRowCbs(runner.panel).map((cb) => cb.checked),
    [true, false],
    "toggled-off row stays deselected across refresh"
  );
  assert.equal(findSelectAllInput(runner.panel).checked, false, "select-all reflects partial selection");
});

test("deselected rows are excluded from getRecords ids on save", async () => {
  const messages = [];
  const ctx = loadPopup(makeSandbox(messages));
  stubSteps(ctx);
  const runner = makePanelRunner(ctx);
  await runner.refresh();

  const rowCbs = findRowCbs(runner.panel);
  rowCbs[1].checked = false;
  rowCbs[1].onchange();
  await runner.lastRefresh;

  const saveBtn = findSaveBtn(runner.panel);
  assert.ok(saveBtn, "save button present");
  await saveBtn.onclick();

  const getRecords = messages.find((m) => m[0] === "archivr:getRecords");
  assert.ok(getRecords, "getRecords sent");
  assert.deepEqual(Array.from(getRecords[1]), [1], "only the still-selected id is requested");
});
