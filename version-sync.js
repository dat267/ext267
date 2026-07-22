"use strict";

const fs = require("fs");
const path = require("path");

const pkgPath = path.join(__dirname, "package.json");
const manifestPath = path.join(__dirname, "manifest.json");

try {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

  // Align version and description
  manifest.version = pkg.version;
  if (pkg.description) manifest.description = pkg.description;

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  console.log(`Version synced successfully to manifest.json: ${pkg.version}`);
} catch (err) {
  console.error("Failed to synchronize manifest version:", err);
  process.exit(1);
}
