// Minimal WebDriver (Marionette) client for Firefox. Plain Node, zero deps.
import fs from "node:fs";
import path from "node:path";

const WEB_ELEMENT = "element-6066-11e4-a52e-4f735466cecf";

export class WD {
  constructor(base) {
    this.sid = null;
    this.base = base;
    this.timeoutMs = 60000;
  }
  async raw(method, urlPath, body) {
    const url = urlPath.startsWith("http") ? urlPath : this.base + urlPath;
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`non-JSON ${res.status} ${method} ${urlPath}: ${text.slice(0, 300)}`);
    }
    const v = json.value;
    const isErr = res.status >= 400 || (v && typeof v === "object" && (v.error || (v.message && v.stacktrace)));
    if (isErr) throw new Error(`WD ${method} ${urlPath} -> ${res.status} ${JSON.stringify(v).slice(0, 300)}`);
    return v;
  }
  u(p) {
    return `/session/${this.sid}${p}`;
  }
  async newSession(caps) {
    const merged = Object.assign({ pageLoadStrategy: "none" }, caps);
    const v = await this.raw("POST", "/session", { capabilities: { alwaysMatch: merged } });
    this.capsInfo = v.capabilities || {};
    this.sid = v.sessionId;
    return this.capsInfo;
  }
  async navigate(url) {
    return this.raw("POST", this.u("/url"), { url });
  }
  refresh() {
    return this.raw("POST", this.u("/refresh"), {});
  }
  urlNow() {
    return this.raw("GET", this.u("/url"));
  }
  async script(code, args = [], timeoutMs = 30000) {
    await this.raw("POST", this.u("/timeouts"), { script: timeoutMs });
    return this.raw("POST", this.u("/execute/sync"), { script: code, args });
  }
  async asyncScript(code, args = [], timeoutMs = 30000) {
    await this.raw("POST", this.u("/timeouts"), { script: timeoutMs });
    return this.raw("POST", this.u("/execute/async"), { script: code, args });
  }
  async find(selector) {
    const v = await this.raw("POST", this.u("/element"), { using: "css selector", value: selector });
    return v;
  }
  click(el) {
    return this.raw("POST", this.u(`/element/${el[WEB_ELEMENT]}/click`), {});
  }
  screenshot() {
    return this.raw("GET", this.u("/screenshot"));
  }
  async windows() {
    return this.raw("GET", this.u("/window/handles"));
  }
  switchTo(handle) {
    return this.raw("POST", this.u("/window"), { handle });
  }
  closeWindow() {
    return this.raw("DELETE", this.u("/window"));
  }
  setContext(context) {
    return this.raw("POST", this.u("/moz/context"), { context });
  }
  installAddon(pathOrOpts) {
    const opts = typeof pathOrOpts === "string" ? { path: pathOrOpts } : pathOrOpts;
    return this.raw("POST", this.u("/moz/addon/install"), Object.assign({ temporary: true }, opts));
  }
  deleteSession() {
    return this.raw("DELETE", `/session/${this.sid}`).catch(() => {});
  }
}

export function savePng(b64, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(b64, "base64"));
  return file;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
