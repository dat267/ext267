#!/usr/bin/env node
"use strict";

/*
 * tools/amo-version-check.js
 *
 * Pre-flight check before an AMO submission. Verifies that the current
 * manifest version is NOT already registered on addons.mozilla.org (AMO
 * rejects duplicate versions: a version is consumed even by submissions that
 * failed after upload, which has caused CI failures before) and that the
 * required submission metadata is present.
 *
 * Usage:
 *   AMO_API_KEY=... AMO_API_SECRET=... node tools/amo-version-check.js
 *   AMO_API_KEY=... AMO_API_SECRET=... node tools/amo-version-check.js --channel listed
 *   AMO_API_KEY=... AMO_API_SECRET=... node tools/amo-version-check.js --version 1.1.2
 *
 * The API key/secret must come from the environment (or a sourced .env) —
 * never from command-line arguments, so they cannot leak into npm's command
 * echo or shell history.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function die(message) {
  console.error(`[amo-version-check] FAIL: ${message}`);
  process.exitCode = 1;
}

function parseArgs(argv) {
  const out = { channel: "unlisted" };
  for (let i = 0; i < argv.length; i++)
    if (argv[i] === "--channel") out.channel = argv[++i];
    else if (argv[i] === "--version") out.version = argv[++i];
    else if (argv[i] === "--manifest") out.manifest = argv[++i];

  return out;
}

function makeJwt(apiKey, apiSecret) {
  const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const header = { alg: "HS256", typ: "JWT" };
  const iat = Math.floor(Date.now() / 1000);
  const payload = { iss: apiKey, jti: crypto.randomUUID(), iat, exp: iat + 60 };
  const signingInput = `${b64url(header)}.${b64url(payload)}`;
  const sig = crypto.createHmac("sha256", apiSecret).update(signingInput).digest("base64url");
  return `${signingInput}.${sig}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifestPath = path.join(process.cwd(), args.manifest || "manifest.json");
  const metaPath = path.join(process.cwd(), "amo-metadata.json");

  const apiKey = process.env.AMO_API_KEY;
  const apiSecret = process.env.AMO_API_SECRET;
  if (!apiKey || !apiSecret) {
    // Mirror the workflow's sign step: absent keys skip gracefully.
    console.warn("[amo-version-check] AMO_API_KEY / AMO_API_SECRET not set — skipping check");
    return;
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (err) {
    return die(`cannot read ${manifestPath}: ${err.message}`);
  }

  const guid =
    manifest.browser_specific_settings && manifest.browser_specific_settings.gecko
      ? manifest.browser_specific_settings.gecko.id
      : null;
  if (!guid) return die("manifest has no browser_specific_settings.gecko.id");

  const version = args.version || manifest.version;
  console.log(`[amo-version-check] add-on ${guid} — checking version "${version}" (channel: ${args.channel})`);

  // Metadata sanity checks mirroring AMO's requirements.
  if (fs.existsSync(metaPath)) {
    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    } catch (err) {
      return die(`cannot parse ${metaPath}: ${err.message}`);
    }
    if (args.channel === "listed" && (!Array.isArray(meta.categories) || meta.categories.length === 0))
      return die("amo-metadata.json must declare categories for the listed channel");
    if (!meta.version || !meta.version.license) return die("amo-metadata.json is missing version.license");
  } else {
    console.warn("[amo-version-check] warning: amo-metadata.json not found (submission may fail)");
  }

  const token = makeJwt(apiKey, apiSecret);
  // filter=all_with_unlisted is required: unlisted-only add-ons expose no
  // versions on the default list.
  const url = `https://addons.mozilla.org/api/v5/addons/addon/${encodeURIComponent(guid)}/versions/?page_size=200&filter=all_with_unlisted`;

  let res;
  try {
    res = await fetch(url, { headers: { Authorization: `JWT ${token}` } });
  } catch (err) {
    return die(`AMO API unreachable: ${err.message}`);
  }

  if (res.status === 404) {
    console.log("[amo-version-check] add-on does not exist on AMO yet — first submission, version is free");
    return;
  }
  if (res.status === 401 || res.status === 403)
    return die(
      `AMO rejected the API key (HTTP ${res.status}). Check AMO_API_KEY / AMO_API_SECRET — if a secret was ever ` +
        "exposed, rotate it at https://addons.mozilla.org/developers/addon/api/key/ and update GitHub secrets + .env"
    );

  if (!res.ok) return die(`AMO API error HTTP ${res.status}: ${await res.text()}`);

  let data;
  try {
    data = await res.json();
  } catch {
    return die("AMO API returned an unparseable response");
  }

  const versions = (data.results || []).map((entry) => entry.version);
  console.log(`[amo-version-check] versions on AMO: ${versions.length ? versions.join(", ") : "(none)"}`);
  if (versions.includes(version))
    return die(
      `version ${version} is ALREADY on AMO — bump the version in package.json and manifest.json before ` +
        "submitting. Never re-push a tag whose release already succeeded."
    );

  console.log(`[amo-version-check] OK: version ${version} is free to submit`);
}

main().catch((err) => {
  console.error(`[amo-version-check] unexpected error: ${err.message}`);
  process.exitCode = 1;
});
