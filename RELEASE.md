# Releasing ext267 to AMO

Runbook for publishing new versions to addons.mozilla.org. Follow it so we
never repeat the CI failures of v1.0.8 and v1.1.0 (both caused by submitting a
version AMO had already claimed).

## Hard rules

1. **Never reuse a version number.** AMO rejects a version that already exists
   on the add-on — it is *consumed* even by submissions that failed *after*
   upload. That means:
   - Never re-push a git tag whose release already succeeded (each `v*` tag
     push re-triggers CI, which will then fail on the duplicate version).
   - If a tag push failed *before* upload, re-running is fine — only a
     successful (or post-upload) submission consumes the version.
2. **Submit a version that is strictly newer** than everything AMO has,
   including in-tree versions you never shipped.
3. **Never put AMO credentials on the command line.** Pass them as
   environment variables only (a literal `--api-key` flag caused `npm` to echo
   a secret into tool output once). GitHub secrets are auto-masked by Actions;
   local `.env` is for interactive use.

## Standard release flow

```bash
# 1. Start from a clean, up-to-date tree
git checkout main && git pull --ff-only && git status --porcelain | grep -q . && echo "working tree is NOT clean" || true

# 2. Choose the next version (SemVer). It MUST exceed the last version on AMO —
#    check with the pre-flight tool before committing to anything:
set -a && source .env && set +a
npm run check:version            # expected: "OK: version x.y.z is free to submit"

# 3. Bump: edit "version" in package.json AND manifest.json (kept in sync by
#    version-sync.js when you use `npm version`)
npm version 1.1.2 --no-git-tag-version   # optional; manual edits are fine too

# 4. Re-run the pre-flight to confirm the new version is free
npm run check:version

# 5. Quality gates
npm test && npm run lint && npx eslint .

# 6. Commit the bump
git commit -am "chore(release): bump to 1.1.2 for AMO submission"

# 7. Create an annotated tag matching the version
git tag -a v1.1.2 -m "1.1.2: <short description>"

# 8. Push — tag push signs UNLISTED (self-distribution) by default
git push origin main
git push origin v1.1.2
```

For a **public store listing** instead: don't rely on the tag push — trigger
**Publish to Mozilla Add-ons (AMO)** manually from the Actions tab with
channel `listed`. `categories` in `amo-metadata.json` are required for that
channel (`npm run check:version -- --channel listed` validates).

## What CI now does (and why)

1. `Run Linter` — `web-ext lint` on the source.
2. `Check AMO Version Availability` — `tools/amo-version-check.js` (new): asks
   AMO whether the manifest version already exists and whether required
   metadata (`categories` for listed, `version.license`) is present. **Fails
   fast with a readable message before any upload is attempted.**
3. `Build and Sign Extension` — `web-ext sign` (the actual submission).
4. `Upload Build Artifacts` — bundles the signed XPI.

## Troubleshooting

| CI symptom | Meaning | Fix |
|---|---|---|
| Check step fails: *"version … is ALREADY on AMO"* | Version was consumed (e.g. re-pushed tag or manual upload) | Bump the version, create a NEW tag, push again |
| Check step fails about `categories`/`license` | Metadata incomplete for the chosen channel | Add the fields to `amo-metadata.json` (see `--channel listed` validation) |
| Sign step: `401`/`403` from AMO | API key invalid, expired, or revoked | Rotate at [AMO Developer Hub → API keys](https://addons.mozilla.org/developers/addon/api/key/); update the GitHub secret `AMO_API_SECRET` and local `.env` |
| Warning *"secrets are not configured. Skipping signing step"* | `AMO_API_KEY`/`AMO_API_SECRET` GitHub secrets unset | Add them in repo Settings → Secrets and variables → Actions |
| Sign step fails with a version error despite the check passing | Race between check and upload | Re-run the workflow (same tag); if it persists, bump the version |

## Security notes

- Only ever pass `AMO_API_KEY`/`AMO_API_SECRET` via environment variables or
  GitHub secrets — never inline on a command line.
- If a secret is ever exposed (logs, chat, git history), rotate it at the AMO
  Developer Hub **and** update both the GitHub secret and local `.env`.
- `.env` is gitignored and should stay mode `600` (see the secrets audit).