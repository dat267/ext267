// ==================================================================
// ext267 — End-to-end test
// Drives a real Firefox 154+ with the extension temporarily installed,
// verifies the full webRequest → storage → popup render → clipboard
// pipeline.  Screenshots are saved to tests/e2e/shots/.
//
// Usage:
//   node tests/e2e/e2e.mjs
//
// Environment variables:
//   GECKODRIVER    path to geckodriver binary (auto-detected otherwise)
//   E2E_TARGET     path to install (dir or xpi); defaults to repo root
//   E2E_PORT       fixture server port (default 8799)
// ==================================================================
import { withBrowser, savePng, sleep, EXT_ID, PREFS, SHOTS, DL_DIR, SRC_DIR, HOST } from "./harness.mjs";
import { spawn } from "node:child_process";
import fs from "node:fs";
const results = [];
const t0 = Date.now();
let main = null;

// ---------------------------------------------------------------
// helpers
// ---------------------------------------------------------------
function check(name, pass, info) {
  results.push({ name, pass: !!pass, info: String(info ?? "").slice(0, 400) });
  console.log(
    `${pass ? "PASS" : "FAIL"}  ${name}${info ? "\n        " + String(info).replace(/\n/g, " ⏎ ").slice(0, 260) : ""}`
  );
}

let fixtureSrv = null;
function startFixture() {
  fixtureSrv = spawn(process.execPath, [new URL("server.mjs", import.meta.url).pathname], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  fixtureSrv.stdout.on("data", (d) => process.stdout.write(`[fixture] ${d}`));
  fixtureSrv.stderr.pipe(process.stderr);
  return new Promise((r) => setTimeout(r, 1200));
}
function stopFixture() {
  if (fixtureSrv) fixtureSrv.kill("SIGTERM");
}

async function until(wd, expr, ms = 9000) {
  const end = Date.now() + ms;
  let v = null;
  while (Date.now() < end) {
    v = await wd.script(`return (${expr});`).catch(() => null);
    if (v) return v;
    await sleep(150);
  }
  return v;
}

async function settle(wd, ms = 9000) {
  const end = Date.now() + ms;
  let prev = null,
    same = 0;
  while (Date.now() < end) {
    const v = await wd.script(`return document.querySelector("textarea")?.value ?? "NO-TA";`).catch(() => null);
    if (v !== null && v === prev) {
      if (++same >= 2) return v;
    } else {
      same = 0;
      prev = v;
    }
    await sleep(150);
  }
  return prev;
}

async function openPopup(wd) {
  await closeExtras(wd, main);
  await wd.setContext("chrome");
  const url = await wd.script(
    `const {ExtensionParent}=ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
     return ExtensionParent.WebExtensionPolicy.getByID(arguments[0]).getURL("popup.html");`,
    [EXT_ID]
  );
  await wd.script(
    `const win = Services.wm.getMostRecentWindow("navigator:browser");
     const gb = win.gBrowser;
     const SP = Services.scriptSecurityManager.getSystemPrincipal();
     const t = gb.addTrustedTab();
     gb.selectedTab = t;
     t.linkedBrowser.browsingContext.loadURI(Services.io.newURI(arguments[0]), {triggeringPrincipal:SP});
     return true;`,
    [url]
  );
  await wd.setContext("content");
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    for (const h of await wd.windows()) {
      await wd.switchTo(h);
      const loc = await wd.script(`return location.href;`).catch(() => "");
      if (loc !== url) continue;
      const ready = await wd
        .script(
          `return document.readyState === "complete" && globalThis.Plugins?.size === 1
           && document.getElementById("tab-content-area")?.children.length > 0;`
        )
        .catch(() => false);
      if (ready) return url;
    }
    await sleep(200);
  }
  throw new Error("popup tab never became ready");
}

async function closeExtras(wd, keep) {
  await wd.setContext("content");
  for (const h of await wd.windows()) {
    if (h === keep) continue;
    await wd.switchTo(h);
    await wd.closeWindow().catch(() => {});
  }
  await wd.switchTo(keep);
}

async function panelMatchesStorage(wd) {
  const end = Date.now() + 9000;
  while (Date.now() < end) {
    const [s, st] = [await snap(wd), await stored(wd)];
    if (st.length === 0 ? s.empty : (s.downloadPicker ?? []).length === st.length) return s;
    await sleep(250);
  }
  return snap(wd);
}

const SNAP = `
  const d = document, area = d.getElementById("tab-content-area");
  const ta = area.querySelector("textarea");
  const sels = [...area.querySelectorAll(".options-container select")];
  const inputs = [...area.querySelectorAll(".options-container input[type=text]")];
  return {
    href: location.href, plugins: globalThis.Plugins?.size ?? -1,
    selector: [...d.querySelectorAll("#plugin-selector option")].map(o=>o.value),
    empty: !!area.querySelector(".empty-state"),
    emptyText: area.querySelector(".empty-state")?.textContent.trim() ?? null,
    textarea: ta?.value ?? null,
    downloadPicker: sels[0] ? [...sels[0].options].map(o=>o.textContent) : null,
    toolSelect: sels[1]?.value ?? null,
    buttons: [...area.querySelectorAll("button")].map(b=>({t:b.textContent.trim(), d:b.disabled})),
    excludeInput: inputs[0]?.value ?? null, extraInput: inputs[1]?.value ?? null,
    labels: [...area.querySelectorAll(".text-input-label")].map(l=>l.firstChild?.textContent.trim() ?? ""),
    bg: getComputedStyle(d.body).backgroundColor, fg: getComputedStyle(d.body).color
  };`;
const snap = (wd) => wd.script(SNAP);

async function shot(wd, name) {
  savePng(await wd.screenshot(), `${SHOTS}/${name}.png`);
  process.stdout.write(`            shot -> ${name}.png\n`);
}

const stored = (wd) =>
  wd.asyncScript(
    `const cb=arguments[arguments.length-1];
     browser.storage.local.get("_cliget_downloads").then(r=>
       cb((r._cliget_downloads||[]).map(d=>({f:d.filename,t:d.type,s:d.size,u:d.url}))),
       e=>cb({err:String(e).slice(0,120)}));`
  );

async function badgeText(wd) {
  await wd.setContext("chrome");
  await wd.script(
    `const d=Services.wm.getMostRecentWindow("navigator:browser").document;
     const p=d.getElementById("unified-extensions-panel")??d.querySelector("#unified-extensions-view")?.closest("panel");
     if(!p||p.state!=="open") d.getElementById("unified-extensions-button").click();`
  );
  await sleep(700);
  const val = await wd.script(`
    const d=Services.wm.getMostRecentWindow("navigator:browser").document;
    const el=d.getElementById("${EXT_ID.replace(/[@.]/g, "_")}-BAP")
      || [...d.querySelectorAll("toolbarbutton")].find(x=>/ext267/.test(x.label??"")&&x.closest("panel"));
    const out=el? (el.getAttribute("badge")??"") : "NO-BUTTON";
    d.getElementById("unified-extensions-panel")?.hidePopup();
    return out;`);
  await wd.setContext("content");
  return val;
}

const setTool = async (wd, tool) => {
  await wd.script(
    `const s=document.querySelectorAll(".options-container select")[1];
     s.value=arguments[0]; s.dispatchEvent(new Event("change"));`,
    [tool]
  );
  await until(wd, `document.querySelectorAll(".options-container select")[1].value===${JSON.stringify(tool)}`);
};

const setInput = (wd, idx, value) =>
  wd.script(
    `const i=document.querySelectorAll(".options-container input[type=text]")[arguments[0]];
     i.value=arguments[1]; i.dispatchEvent(new Event("change"));`,
    [idx, value]
  );

const clearStorage = (wd) =>
  wd.asyncScript(`const cb=arguments[arguments.length-1]; browser.storage.local.clear().then(()=>cb(true));`);

async function goto(wd, path) {
  await closeExtras(wd, main);
  await wd.switchTo(main);
  await wd.navigate(`${HOST}${path}`);
  await sleep(900);
}

// ---------------------------------------------------------------
// main
// ---------------------------------------------------------------
try {
  await startFixture();
  fs.mkdirSync(DL_DIR, { recursive: true });

  await withBrowser(
    async (wd) => {
      const caps = await wd.newSession({ "moz:firefoxOptions": { prefs: PREFS } });
      check("[01] real Firefox session", !!caps.browserVersion, `Firefox ${caps.browserVersion}`);

      const installed = await wd.installAddon(SRC_DIR);
      const id = typeof installed === "string" ? installed : installed.id;
      check("[02] extension installs temporarily (no AMO)", id === EXT_ID, `id=${id}`);

      await wd.navigate(`${HOST}/`);
      main = (await wd.windows())[0];
      check(
        "[03] fixture reachable",
        !!(await until(wd, `location.href===${JSON.stringify(`${HOST}/`)}`)),
        await wd.urlNow()
      );

      // ---------- empty state ----------
      await openPopup(wd);
      await panelMatchesStorage(wd);
      let s = await snap(wd);
      check("[04] popup runs in extension origin", s.plugins === 1 && s.href.endsWith("/popup.html"), s.href);
      check("[05] dynamic selector", JSON.stringify(s.selector) === '["cliget"]', JSON.stringify(s.selector));
      check(
        "[06] empty state",
        s.empty && /No downloads intercepted/.test(s.emptyText ?? ""),
        JSON.stringify(s.emptyText)
      );
      check(
        "[07] CSS tokens applied",
        s.bg === "rgb(43, 42, 51)" && s.fg === "rgb(251, 251, 254)",
        `${s.bg} / ${s.fg}`
      );
      await shot(wd, "01-empty-state");

      // ---------- main_frame attachment ----------
      await goto(wd, "/dl/attachment?n=1");
      await sleep(700);
      const files = fs.readdirSync(DL_DIR);
      check("[08] browser saved the file", files.includes("quarterly-report.pdf"), files.join(", "));

      await openPopup(wd);
      s = await panelMatchesStorage(wd);
      check(
        "[09] interception reaches popup",
        !!s.textarea && s.textarea.startsWith("curl "),
        (s.textarea ?? "").slice(-90)
      );
      check(
        "[10] filename + size",
        (s.downloadPicker ?? []).some((o) => o === "quarterly-report.pdf (4.0 KB)"),
        JSON.stringify(s.downloadPicker)
      );
      check(
        "[11] UI elements present",
        s.buttons.length === 2 &&
          s.buttons[0].t === "Clear Intercept Session" &&
          s.buttons[1].t === "Copy Command" &&
          !!s.textarea &&
          s.toolSelect === "curl" &&
          s.excludeInput === "Accept-Encoding Connection",
        JSON.stringify(s.buttons)
      );
      await shot(wd, "02-curl-intercepted");

      // ---------- negative controls ----------
      await goto(wd, "/dl/inline?n=2");
      await goto(wd, "/dl/weird?n=3");
      await goto(wd, "/dl/image?n=4");
      await openPopup(wd);
      let st = await panelMatchesStorage(wd).then(() => stored(wd));
      const names = st.map((x) => x.f);
      check("[12] inline NOT intercepted", !st.some((x) => x.u.includes("inline")), JSON.stringify(names));
      check(
        "[13] image+attachment IS intercepted (disposition wins)",
        names.includes("image-attachment.png"),
        JSON.stringify(names)
      );
      check(
        "[14] brackets+quotes preserved",
        names.some((f) => f === "O'Brien's file [1].zip"),
        JSON.stringify(names)
      );
      await shot(wd, "03-negative-controls");

      // ---------- sub_frame + CJK ----------
      await goto(wd, "/dl/iframe");
      await goto(wd, "/dl/cjk");
      await openPopup(wd);
      st = await panelMatchesStorage(wd).then(() => stored(wd));
      const names2 = st.map((x) => x.f);
      check(
        "[15] sub_frame intercepted",
        st.some((x) => x.t === "sub_frame" && x.f === "noheader"),
        JSON.stringify(st.filter((x) => x.t === "sub_frame"))
      );
      check(
        "[16] <img> NOT captured (types filter)",
        !st.some((x) => x.t === "image"),
        JSON.stringify(st.map((x) => x.t))
      );
      check(
        "[17] CJK filename decoded",
        names2.includes("\u6d4b\u8bd5\u6587\u4ef6-\u2713.pdf"),
        JSON.stringify(names2)
      );
      s = await snap(wd);
      check(
        "[18] picker newest-first, sizes",
        (s.downloadPicker ?? []).length === st.length &&
          /^\u6d4b\u8bd5\u6587\u4ef6-\u2713\.pdf \(4\.0 KB\)$/.test(s.downloadPicker[0]),
        JSON.stringify(s.downloadPicker)
      );
      await shot(wd, "04-picker-multi");

      // ---------- CLI generators ----------
      const pick = async (needle) => {
        await wd.script(
          `const p=document.querySelectorAll(".options-container select")[0];
           const o=[...p.options].find(x=>x.textContent.includes(arguments[0]));
           if(o){p.value=o.value;p.dispatchEvent(new Event("change"));}return o?.textContent??null;`,
          [needle]
        );
        await sleep(700);
      };
      await pick("O'Brien");
      await setTool(wd, "curl");
      await until(wd, `document.querySelector("textarea").value.startsWith("curl")`);
      const curlCmd = (await snap(wd)).textarea;
      await shot(wd, "05-curl-weird");
      await setTool(wd, "wget");
      await until(wd, `document.querySelector("textarea").value.startsWith("wget")`);
      const wgetCmd = (await snap(wd)).textarea;
      await shot(wd, "06-wget-weird");
      await setTool(wd, "aria2");
      await until(wd, `document.querySelector("textarea").value.startsWith("aria2c")`);
      const ariaCmd = (await snap(wd)).textarea;
      await shot(wd, "07-aria2-weird");

      check("[19] curl: escaping", curlCmd.includes(`--output 'O'\\''Brien'\\''s file [1].zip'`), curlCmd?.slice(-56));
      check(
        "[20] curl: headers + URL",
        curlCmd.startsWith("curl ") &&
          curlCmd.includes("--header 'Host:") &&
          curlCmd.includes(`'${HOST}/dl/weird?n=3'`),
        curlCmd?.slice(0, 110)
      );
      check(
        "[21] wget: escaping",
        wgetCmd.startsWith("wget ") && wgetCmd.includes(`--output-document 'O'\\''Brien`),
        wgetCmd?.slice(-56)
      );
      check(
        "[22] aria2c: escaping",
        ariaCmd.startsWith("aria2c ") && ariaCmd.includes(`--out 'O'\\''Brien`),
        ariaCmd?.slice(-56)
      );

      // ---------- glob ----------
      await clearStorage(wd);
      await goto(wd, "/dl/attachment?g=[1]{2}&n=42");
      await openPopup(wd);
      await panelMatchesStorage(wd);
      await setTool(wd, "curl");
      await sleep(600);
      const globCmd = (await snap(wd)).textarea;
      check(
        "[23] URL glob chars escaped",
        globCmd.includes(`'${HOST}/dl/attachment?g=\\[1\\]\\{2\\}&n=42'`),
        globCmd?.slice(-80)
      );
      await shot(wd, "08-glob-url");

      // ---------- Windows mode ----------
      await wd.script(`document.querySelector(".options-container input[type=checkbox]").click();`);
      await until(wd, `document.querySelector("textarea").value.includes('"')`);
      const winCmd = (await snap(wd)).textarea;
      check(
        "[24] Windows mode",
        /^curl /.test(winCmd) &&
          winCmd.includes(`"${HOST}/dl/attachment?g=`) &&
          /--output "quarterly-report\.pdf"$/.test(winCmd),
        winCmd?.slice(-80)
      );
      await shot(wd, "09-windows-quotes");
      await wd.script(`document.querySelector(".options-container input[type=checkbox]").click();`);
      await sleep(800);

      // ---------- dependsOn + extra args ----------
      s = await snap(wd);
      check(
        "[25] dependsOn works",
        s.labels.some((l) => /Extra cURL/.test(l)) && !s.labels.some((l) => /Extra Wget|Extra Aria2/.test(l)),
        JSON.stringify(s.labels)
      );
      await setInput(wd, 1, "--insecure -L");
      await until(wd, `document.querySelector("textarea").value.trim().endsWith("--insecure -L")`);
      s = await snap(wd);
      check("[26] extra args appended", s.textarea.trim().endsWith("--insecure -L"), s.textarea?.slice(-40));
      await shot(wd, "10-extra-args");
      await setInput(wd, 1, "");
      await until(wd, `!document.querySelector("textarea").value.includes("--insecure")`);

      // ---------- exclude headers ----------
      const before = await settle(wd);
      await setInput(wd, 0, "Accept-Language Host Referer");
      await until(wd, `!document.querySelector("textarea").value.includes("Accept-Language")`);
      const after = await settle(wd);
      check(
        "[27] exclude-headers",
        before.includes("--header 'Accept-Language:") &&
          before.includes("--header 'Host:") &&
          !after.includes("Accept-Language") &&
          !after.includes("'Host:") &&
          after.includes("Accept-Encoding") &&
          after.includes("Upgrade-Insecure"),
        `${before.length} -> ${after.length} chars`
      );
      await shot(wd, "11-exclude-headers");
      await setInput(wd, 0, "Accept-Encoding Connection");
      await until(wd, `document.querySelector("textarea").value.includes("Accept-Language")`);

      // ---------- badge ----------
      await clearStorage(wd);
      await goto(wd, "/dl/attachment?n=51");
      await goto(wd, "/dl/cjk?n=52");
      const b1 = await badgeText(wd);
      check("[28] badge counts downloads", /^\d+$/.test(b1) && Number(b1) >= 2, `badge=${b1}`);
      await openPopup(wd);
      await panelMatchesStorage(wd);
      const b2 = await badgeText(wd);
      check("[29] badge cleared after render", b2 === "", `badge="${b2}"`);
      await shot(wd, "12-badge-cleared");

      // ---------- copy + clipboard ----------
      await wd.setContext("chrome");
      const perm = await wd.script(
        `const {ExtensionParent}=ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
         const u=ExtensionParent.WebExtensionPolicy.getByID(arguments[0]).getURL("popup.html");
         try{Services.perms.addFromPrincipal(
           Services.scriptSecurityManager.createContentPrincipalFromOrigin(new URL(u).origin),
           "clipboardRead",1);return"granted";}
         catch(e){return"ERR "+String(e).slice(0,90);}`,
        [EXT_ID]
      );
      await wd.setContext("content");
      await wd.click(await wd.find("button.btn-blue"));
      await until(wd, `[...document.querySelectorAll("button")].some(b=>b.textContent.trim()==="Copied!")`);
      s = await snap(wd);
      check(
        "[30] copy feedback",
        s.buttons.some((b) => b.t === "Copied!"),
        JSON.stringify(s.buttons)
      );
      await shot(wd, "13-copied");
      const clip = await wd.asyncScript(
        `const cb=arguments[arguments.length-1];
         navigator.clipboard.readText().then(t=>cb(t),e=>cb("ERR:"+e.name+" "+e.message));`
      );
      check(
        "[31] clipboard holds command",
        String(clip).startsWith("curl ") && String(clip).includes("--output"),
        `${perm} -> ${String(clip).slice(0, 100)}`
      );

      // ---------- stateless message passing ----------
      const gen = await wd.asyncScript(
        `const cb=arguments[arguments.length-1];
         browser.runtime.sendMessage(["cliget:generateCommand",
           {url:"https://example.com/a b[1].bin",method:"GET",
            headers:[{name:"Cookie",value:"a=b"},{name:"Accept-Encoding",value:"gzip"}],
            payload:null,filename:"a b[1].bin"},
           {cliTool:"curl",curlOptions:"",excludeHeaders:"Accept-Encoding",doubleQuotes:false}])
           .then(c=>cb(c),e=>cb("ERR:"+e.message));`
      );
      check(
        "[32] stateless message",
        String(gen).startsWith("curl ") &&
          String(gen).includes("--cookie 'a=b'") &&
          !String(gen).includes("Accept-Encoding"),
        String(gen).slice(0, 120)
      );

      const ariaPost = await wd.asyncScript(
        `const cb=arguments[arguments.length-1];
         browser.runtime.sendMessage(["cliget:generateCommand",
           {url:"https://x/y",method:"POST",headers:[],payload:null,filename:"y"},
           {cliTool:"aria2",excludeHeaders:""}])
           .then(c=>cb(c),e=>cb("ERR:"+e.message));`
      );
      check(
        "[33] aria2 POST error",
        /^Error generating command: Unsupported HTTP method/.test(String(ariaPost)),
        String(ariaPost)
      );

      // ---------- MAX_ITEMS ----------
      await clearStorage(wd);
      for (let i = 0; i < 13; i++) {
        await wd.switchTo(main);
        await wd.navigate(`${HOST}/dl/noheader?i=${i}`).catch(() => {});
        await sleep(260);
      }
      await sleep(800);
      await openPopup(wd);
      st = await stored(wd);
      check("[34] MAX_ITEMS=10 enforced", st.length === 10, `len=${st.length}`);
      s = await snap(wd);
      check(
        "[35] picker shows capped list",
        (s.downloadPicker ?? []).length === 10,
        `${(s.downloadPicker ?? []).length} options`
      );
      await shot(wd, "14-capped-list");

      // ---------- redirect + clear ----------
      await clearStorage(wd);
      await goto(wd, "/redir");
      await sleep(1200);
      await openPopup(wd);
      st = await panelMatchesStorage(wd).then(() => stored(wd));
      check(
        "[36] redirect yields one entry",
        st.length === 1 && st[0].f === "quarterly-report.pdf",
        JSON.stringify(st)
      );
      await wd.click(await wd.find("button.btn-red"));
      await until(wd, `!!document.querySelector(".empty-state")`);
      s = await snap(wd);
      st = await stored(wd);
      check(
        "[37] clear empties UI + storage",
        s.empty && s.textarea === null && st.length === 0,
        `${s.emptyText} | len=${st.length}`
      );
      await shot(wd, "15-after-clear");

      // ---------- plugin error isolation ----------
      await wd.script(
        `globalThis.Plugins.set("boom",{id:"boom",name:"boom",render:async()=>{throw new Error("simulated plugin failure");}});
         const sel=document.getElementById("plugin-selector");
         const o=document.createElement("option");o.value="boom";o.textContent="boom";sel.appendChild(o);
         sel.value="boom";sel.dispatchEvent(new Event("change"));`
      );
      await until(wd, `/Plugin error/.test(document.querySelector("#tab-content-area").textContent)`);
      const err = await wd.script(
        `const e=document.querySelector("#tab-content-area .empty-state");
         return{text:e?.textContent.trim()??null,shell:!!document.getElementById("plugin-selector")};`
      );
      check(
        "[38] plugin error isolation",
        /Plugin error: simulated plugin failure/.test(err.text ?? "") && err.shell,
        err.text
      );
      await shot(wd, "16-plugin-error-isolation");

      // ---------- persistence ----------
      await wd.script(
        `globalThis.Plugins.delete("boom");
         const sel=document.getElementById("plugin-selector");
         [...sel.options].find(x=>x.value==="boom")?.remove();
         sel.value="cliget";sel.dispatchEvent(new Event("change"));`
      );
      await sleep(600);
      await clearStorage(wd);
      await goto(wd, "/dl/cjk?final=1");
      await closeExtras(wd, main);
      await openPopup(wd);
      s = await panelMatchesStorage(wd);
      check(
        "[39] popup reopen persistence",
        !!s.textarea && s.textarea.includes("\u6d4b\u8bd5\u6587\u4ef6"),
        (s.textarea ?? "").slice(-60)
      );
      await shot(wd, "17-final-cjk");
    },
    { port: 4492 }
  );
} finally {
  stopFixture();
}

const passed = results.filter((r) => r.pass).length;
const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n================ ${passed}/${results.length} checks passed  (${secs}s) ================`);
for (const r of results.filter((x) => !x.pass)) console.log(`  FAILED: ${r.name}  |  ${r.info}`);
fs.writeFileSync(
  new URL("results.json", import.meta.url).pathname,
  JSON.stringify({ passed, total: results.length, secs, results }, null, 2)
);
process.exit(passed === results.length ? 0 : 1);
