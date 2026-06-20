"use strict";

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const manifestPath = path.join(__dirname, "manifest.json");
const pkgPath = path.join(__dirname, "package.json");

// Read original files
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const originalManifestContent = fs.readFileSync(manifestPath, "utf8");
const manifest = JSON.parse(originalManifestContent);

// Generate monotonic build suffix (minutes since Jan 1, 2026)
const epoch = new Date("2026-01-01T00:00:00Z").getTime();
const buildSuffix = Math.floor((Date.now() - epoch) / 60000);
const uniqueVersion = `${pkg.version}.${buildSuffix}`;

console.log(`Preparing build for unique version: ${uniqueVersion}`);

try {
  // Write unique version to manifest.json temporarily
  manifest.version = uniqueVersion;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

  // Run web-ext build
  execSync("npx web-ext build --overwrite-dest", { stdio: "inherit" });

  // Copy built file to ext267.xpi
  const builtZipPath = path.join(__dirname, "web-ext-artifacts", `ext267-${uniqueVersion}.zip`);
  const targetXpiPath = path.join(__dirname, "web-ext-artifacts", "ext267.xpi");
  
  if (fs.existsSync(builtZipPath)) {
    fs.copyFileSync(builtZipPath, targetXpiPath);
    console.log(`Successfully packaged ${builtZipPath} to ${targetXpiPath}`);
  } else {
    throw new Error(`Built file not found: ${builtZipPath}`);
  }
} catch (err) {
  console.error("Build packaging failed:", err.message);
  process.exit(1);
} finally {
  // Restore original manifest.json if it was read successfully
  if (originalManifestContent) {
    fs.writeFileSync(manifestPath, originalManifestContent, "utf8");
    console.log("Restored original manifest.json version to source tree.");
  }
}
