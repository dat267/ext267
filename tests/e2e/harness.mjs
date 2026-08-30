// Shared harness: spawn geckodriver + Firefox, run a test body, tear down.
import { WD, savePng, sleep } from "./wd.mjs";
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));

export const SHOTS = path.join(DIR, "shots");
export const DL_DIR = path.join(DIR, "dl");
export const GD_LOG = path.join(DIR, "gd.log");
export const EXT_ID = "ext267@dat267.github.io";
export const SRC_DIR = process.env.E2E_TARGET || path.resolve(DIR, "..", "..");
export const HOST = "http://127.0.0.1:8799";
export const FIXTURE_PORT = 8799;

export const PREFS = {
  "browser.startup.page": 0,
  "browser.startup.homepage": "about:blank",
  "browser.aboutConfig.showWarning": false,
  "browser.shell.checkDefaultBrowser": false,
  "datareporting.policy.dataSubmissionEnabled": false,
  "toolkit.telemetry.enabled": false,
  "app.shield.optoutstudies.enabled": false,
  "browser.migrate.ignore.autofilled": true,
  "browser.download.useDownloadDir": true,
  "browser.download.folderList": 2,
  "browser.download.dir": DL_DIR,
  "browser.download.lastDir": DL_DIR,
  "browser.download.autohideButton": false,
  "browser.download.always_ask_before_handling_new_types": false,
  "extensions.langpacks.signatures_required": false,
  "dom.security.https_first": false,
  "network.dns.disablePrefetch": true,
  "browser.urlbar.suggest.searches": false,
  "network.proxy.type": 0,
  "signon.autofillForms": false,
  "browser.privatebrowsing.autostart": false
};

// Locate the geckodriver binary.  Priority: GECKODRIVER env var, then PATH,
// then a common npm-installed location.
function findGeckoDriver() {
  const env = process.env.GECKODRIVER;
  if (env) return env;
  try {
    return execSync("which geckodriver", { encoding: "utf8" }).trim();
  } catch {
    const npm = path.resolve(DIR, "..", "..", "node_modules", ".bin", "geckodriver");
    if (fs.existsSync(npm)) return npm;
  }
  return null;
}

function startGd(port, systemAccess) {
  const bin = findGeckoDriver();
  if (!bin)
    throw new Error(
      "geckodriver not found.  Install it via your package manager or download\n" +
        "from https://github.com/mozilla/geckodriver/releases and place it on\n" +
        "PATH, or set the GECKODRIVER environment variable."
    );
  const args = [`--port=${port}`, "--binary=/usr/bin/firefox", "--log=error"];
  if (systemAccess) args.push("--allow-system-access");
  const out = fs.openSync(GD_LOG, "a");
  const p = spawn(bin, args, { stdio: ["ignore", out, out] });
  return p;
}

export async function withBrowser(fn, { port = 4455, systemAccess = true } = {}) {
  fs.rmSync(GD_LOG, { force: true });
  const gd = startGd(port, systemAccess);
  const base = `http://127.0.0.1:${port}`;
  let tries = 0;
  while (tries++ < 60) {
    try {
      const r = await fetch(`${base}/status`);
      if (r.ok) break;
    } catch {
      /* fixture not ready yet, retry */
    }
    await sleep(300);
  }
  const wd = new WD(base);
  try {
    return await fn(wd);
  } finally {
    await wd.deleteSession();
    gd.kill("SIGTERM");
    await sleep(700);
  }
}

export { WD, savePng, sleep };
