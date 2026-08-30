# Project Overview: ext267

**ext267** is a modernized, responsive, extensible browser toolkit with a plugin-based architecture. It ships with one plugin: **cliget** (download interception → CLI command generation).

### Main Technologies

- **Platform**: Browser WebExtension (Manifest V3 compatible).
- **Languages**: Plain JavaScript, CSS3 (Modern Firefox-inspired theme).
- **Tooling**: `web-ext` for building, linting, and packaging. ESLint v9 flat config for code quality.
- **Permissions**: `webRequest`, `storage`, `tabs`, `downloads`.

### Core Architecture

- **Plugin-based Extensible Tools**: Each plugin registers itself dynamically in both popup and background scopes via a standard `registerPlugin` registry map. Plugins do not rely on shared scripts like `utils.js` or `background.js`.
- **Dynamic Popup UI Selector**: The popup selector is built dynamically in [popup.js](file:///home/dat/repos/ext267/popup.js) by mapping registered plugin metadata from the global map.
- **Decoupled Plugin Execution**: Plugins run as completely self-contained entities. If a plugin requires background listeners (such as downloads interception via webRequest APIs) or utility helpers (like shell escaping), all that logic resides inside the plugin file itself (e.g. [cliget.js](file:///home/dat/repos/ext267/plugins/cliget.js)), isolated behind the `_isBackground` guard. Each plugin file defines its own `ext` at file scope and does not rely on shared globals from other scripts.
- **Self-Contained Dynamic Interfaces**: Each plugin panel dynamically registers and builds its own layout. If it uses custom rendering (via the `render(panel, context)` hook), it draws all forms, picker select lists, options inputs, output textareas, and buttons locally.

### Plugins

| Plugin                                                       | Type                  | Purpose                                                                           |
| ------------------------------------------------------------ | --------------------- | --------------------------------------------------------------------------------- |
| [cliget.js](file:///home/dat/repos/ext267/plugins/cliget.js) | Download-intercepting | Intercepts main_frame/sub_frame downloads and generates curl/wget/aria2c commands |

---

## Coding Standards & Performance Guidelines

To maintain extension performance, stability, and compatibility on both desktop and mobile platforms, all code modifications must adhere to the following standards:

### 1. Static WebRequest Listeners

- **Why**: Continuous tracking of non-document resources drains system resources.
- **Standard**: Inside the `_isBackground` guard of plugins that use webRequest, listeners must be statically registered synchronously at startup. The `types` filter must be as narrow as the plugin requires:
  - **cliget** (download interception): `["main_frame", "sub_frame"]` only.

### 2. Stateless MV3 Message Passing

- **Why**: Manifest V3 background service workers are ephemeral and will suspend when idle. Keeping request objects only in background memory and looking them up via IDs from the popup will fail if the background worker has recycled.
- **Standard**: When sending messages from the popup to request actions, **always pass the full request payload object** rather than a database/Map ID reference. Refer to `render` in each plugin and the corresponding message handler branch.

### 3. Memory Leak Protection (FIFO Map Eviction)

- **Why**: The background map stores pending request details. If network requests are aborted or never complete, this Map can grow unboundedly.
- **Standard**: Implement a FIFO eviction limit on pending request Maps:
  ```js
  if (pendingRequests.size > 200) {
    const oldestKey = pendingRequests.keys().next().value;
    pendingRequests.delete(oldestKey);
  }
  ```

### 4. Redirect & Error Handling in webRequest Pipelines

- **Why**: Redirected requests fire `onBeforeRedirect` instead of `onCompleted`. Failed requests fire `onErrorOccurred`. Without handling these, pending request entries accumulate and leak memory.
- **Standard**: Always register listeners for `onBeforeRedirect` (clean up pending entries) and `onErrorOccurred` (finalize + clean up).

### 5. Plugin Registry Standards

- **Why**: To keep the extension codebase modular and decoupled from specific plugins, allowing new tools to be added with zero changes to popup or background core scripts.
- **Standard**: Every plugin must register itself at load time via `globalThis.registerPlugin()`. Plugins come in two forms:

  **A. Background-intercepting plugin** (uses `_isBackground` guard, registers webRequest/message listeners):

  ```js
  const ext = typeof browser !== "undefined" ? browser : chrome;

  // Correct cross-browser background context detection:
  // - Chrome MV3: window is undefined (pure service worker)
  // - Firefox MV3: background.scripts runs as event page — window exists, but document does not
  //   and location.pathname is NOT /popup.html
  const _isBackground =
    typeof window === "undefined" || (typeof location !== "undefined" && location.pathname !== "/popup.html");

  if (_isBackground) {
    ext.webRequest.onResponseStarted.addListener(/* ... */);
    ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      // Namespace all messages with your plugin id: "myplugin:action"
    });
  }

  globalThis.registerPlugin({
    id: "myplugin",
    name: "My Plugin",
    render: async function (panel, context) {
      const { refresh } = context; // context only provides { refresh }
      // Each plugin defines its own `ext` at file scope — do NOT use context.ext
    }
  });
  ```

  **B. Standalone webapp plugin** (no background guard needed):

  ```js
  const ext = typeof browser !== "undefined" ? browser : chrome;

  globalThis.registerPlugin({
    id: "myplugin",
    name: "My Plugin",
    render: async function (panel, context) {
      const { refresh } = context;
      // Use ext.* APIs directly — ext is defined at this file's scope
    }
  });
  ```

- **`render(panel, context)` context shape**: `{ refresh }` only. The popup shell passes no extension APIs — each plugin is responsible for its own `ext` variable defined at file scope.

---

## Design and Styling System

All styling resides in [popup.css](file:///home/dat/repos/ext267/popup.css) using CSS variable design tokens.

### Outlined Buttons Conventions

- To maintain a uniform, modern UI aesthetic, all action and form buttons must use the outlined button styling conventions:
  - Use the `.btn` base class.
  - Combine with modifier classes like `.btn-blue` (accent borders) or `.btn-red` (warning borders).
  - Avoid filling solid backgrounds unless explicitly required for prominent primary actions.
  - Interactive states must define transitions for hover/active states with subtle scaling or border highlights.

### CSS Animations

- Add animations in [popup.css](file:///home/dat/repos/ext267/popup.css) as `@keyframes` blocks. Use dedicated utility classes rather than inline animation styles.

---

## Coding Style & Portability Rules

- **Plain JavaScript**: Do not use Babel, TypeScript, webpack, or npm bundlers. Keep the source code transparent and readable for review on AMO / Chrome Web Store.
- **Cross-Browser Compatibility**: Always use the polyfill-ready variable `ext` to call standard extension APIs:
  ```js
  const ext = typeof browser !== "undefined" ? browser : chrome;
  ```
- **Unicode / CJK Support**: Prevent mojibake in filename extraction. Content-Disposition headers with non-Latin characters must be parsed using the `decodeHeaderValue` helper defined inside [cliget.js](file:///home/dat/repos/ext267/plugins/cliget.js):
  ```js
  function decodeHeaderValue(str) { ... }
  ```
- **No innerHTML for Dynamic Content**: Always use `document.createElement` and `textContent` for rendering user-visible or dynamic values. Do not use `innerHTML` with template literals containing runtime data.

---

## Linting & Code Quality

- **ESLint**: Uses ESLint v9 flat config ([eslint.config.mjs](file:///home/dat/repos/ext267/eslint.config.mjs)) with `eslint:recommended`, `eslint-plugin-prettier`, and custom rules (`no-shadow`, `prefer-arrow-callback`, `curly`). Node.js build scripts use `globals.node`; extension code uses `globals.browser` + `globals.webextensions`.
- **Prettier**: Configured via [.prettierrc](file:///home/dat/repos/ext267/.prettierrc) and run as an ESLint rule.
- **Empty catch blocks**: Use `catch { /* explain why */ }` (optional catch binding, ES2019+). Never use `catch (e) {}` with an empty body.

---

## Building & Verification

Verify changes by running the following tasks:

- **Verify**: `npm run verify` (unit tests + web-ext lint + eslint).
- **Development**: Run `npx web-ext run` to test changes inside Firefox.
- **Build**: `npm run build` or `npm run package:xpi` to package the extension into `web-ext-artifacts/ext267.xpi`.

---

## Behavioral Notes (cliget)

These were verified by end-to-end testing (see "Testing (End-to-End)" below) and
are non-obvious design decisions worth documenting:

1. **`Content-Disposition: attachment` beats content-type exclusions.**
   The `isAttachment` check short-circuits before the content-type block
   (`text/html`, `text/plain`, `image/`, …). A `main_frame` navigation to
   `image/png` with `Content-Disposition: attachment` IS captured as a
   download — the server explicitly asked for it. Only when there is no
   `attachment` disposition does the content-type exclusion apply.

2. **Windows (double-quote) mode double-escapes glob metacharacters.**
   `escapeGlobbing()` runs before `escapeShellArg()` with `doubleQuotes=false`.
   When the user toggles Windows mode, `escapeShellArg` is re-run with
   `doubleQuotes=true`, which escapes backslashes — so `\[1\]` becomes
   `\\[1\\]` in the output. This is harmless in `cmd.exe` (which does not
   glob-unescape), but the backslash-doubling can surprise manual inspection.

3. **Only real WebDriver clicks carry user activation for clipboard writes.**
   Plugin code uses `navigator.clipboard.writeText(cmd)` in the Copy button's
   `onclick`. An in-page synthetic `btn.click()` is correctly rejected by
   Firefox with `NotAllowedError`. A genuine WebDriver `click()` (Marionette)
   sets the user-activation flag and the write succeeds. See the E2E section
   for how to verify this.

---

## Testing (End-to-End)

The extension can be tested end-to-end against a real Firefox 154+ with no
AMO signing thanks to the `temporary: true` flag on the add-on install
endpoint. The following recipe was verified against the `cliget` plugin.

### Prerequisites

- Firefox 154+ (or any version that supports `--marionette`).
- [`geckodriver`](https://github.com/mozilla/geckodriver/releases) ≥ 0.36.0.
- KDE / GNOME / Xvfb display (Wayland or X11 — Marionette screenshots work on
  both). The `--allow-system-access` flag unlocks the Marionette **chrome
  context** which is required to `loadURI()` an extension page.

### What the recipe proves

The full pipeline: HTTP fixture → `ext.webRequest` (real background context)
→ `storage.local` → popup `render()` → `runtime.onMessage` `generateCommand`
→ DOM → system clipboard → screenshots.

### Key gotchas (cost hours to discover, so read this first)

| Gotcha                                                                                                                                 | Why                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Extension origin uses a random UUID**, not the add-on ID.                                                                            | `moz-extension://ext267@dat267.github.io/…` is **not valid**. Use `WebExtensionPolicy.getByID(id).getURL("popup.html")` to get the real UUID-based URL.                                                       |
| **`pageLoadStrategy: "none"`** on the WebDriver session.                                                                               | Otherwise `navigate()` to the extension page hangs forever (Marionette waits for a load event that never fires for extension pages).                                                                          |
| **`browsingContext.loadURI(Services.io.newURI(url), {triggeringPrincipal})`** — the positional string form is rejected in Firefox 154. | Must pass a real `nsIURI` object as the first argument.                                                                                                                                                       |
| **`--allow-system-access`** on the geckodriver invocation.                                                                             | Without it, `WebDriver:Navigate` to `moz-extension://` URLs is blocked by Marionette's privileged-URL guard.                                                                                                  |
| **Each tab is its own window handle** in the **content** context.                                                                      | Create the tab (chrome context), then switch to content context and enumerate `/window/handles` — the tab with the right URL is a separate handle. Scripts run in real page scope with `browser.*` available. |
| **A stale `wl-copy` daemon shadows Firefox clipboard writes.**                                                                         | Kill any running `wl-copy` processes before the copy-buffer test, or verify in-page via `navigator.clipboard.readText()` after granting `clipboardRead` permission with `Services.perms`.                     |

### Verification commands

```bash
# Quick local verification (no signing, no AMO)
npm run verify       # unit tests + web-ext lint + eslint

# Release-quality gates
npm run verify && npm run build
```

---

## Packaging & Build

The extension is packaged with `web-ext build`. To reduce the shipped payload
from 80 % dev-only cruft to runtime-only, the build ignores test files, build
scripts, config files, and documentation (see `webExt.ignoreFiles` in
`package.json`). Lint (`web-ext lint`) and the CI `sign` step also honour
the same ignore list, so the test-scratch files in `tests/` never pollute the
linter output.

---

## CI/CD & Publishing (addons.mozilla.org)

A GitHub Actions pipeline is configured at `.github/workflows/amo-publish.yml` to automate submission and signing to the Mozilla Add-ons (AMO) store.

### Configuration & Secrets

For the pipeline to work, configure the following **Repository Secrets** in your GitHub repository:

- `AMO_API_KEY`: The API key (JWT issuer) from the [AMO Developer Hub](https://addons.mozilla.org/developers/addon/api/key/).
- `AMO_API_SECRET`: The API secret (JWT secret) from the AMO Developer Hub.

### Workflow Behavior

1. **Trigger Options**:
   - **Tag Pushes**: Runs automatically when a tag matching `v*` is pushed. Submits to the **unlisted** channel for self-distribution.
   - **Manual Dispatch**: Can be triggered manually from the GitHub Actions tab. Allows selecting between **listed** (AMO store release) and **unlisted** (self-distribution package) channels.
2. **Execution Steps**:
   - Checks out the repository.
   - Installs Node.js dependencies (`npm ci`).
   - Runs the webextension linter (`npm run lint`).
   - Calls `npx web-ext sign` to package, upload, and submit/sign the extension.
   - For the `listed` channel, it passes `--approval-timeout 0` so the pipeline finishes immediately after a successful upload rather than hanging for manual review.
   - Uploads built artifact packages to the run summary.

### Android Installation

For Firefox on Android, trigger the workflow with the `unlisted` channel. The signed XPI from the artifacts can be side-loaded via `Settings → Install extension from file` (enable debug menu: tap the Firefox logo 5 times in `Settings → About Firefox`).

### Releasing (AMO)

Follow [RELEASE.md](RELEASE.md) before any AMO submission. Two invariants prevent the historical CI failures:

- **A version is never reused** — AMO consumes a version even on post-upload failures, so never re-push a tag whose release already succeeded; bump first.
- **The version pre-check runs before signing** — CI calls `tools/amo-version-check.js` (also available as `npm run check:version`) to confirm the manifest version is not already on AMO and that required metadata is present, failing fast with a readable message. Run it locally with your `.env` sourced before tagging.

### Secret Handling

- Pass all credentials (`AMO_API_KEY`, `AMO_API_SECRET`, …) to tools **only via environment variables or GitHub secrets** — never as command-line arguments (`npm` echoes the full command line; this once leaked a secret into session output).
- **Whenever a secret value appears in tool output, logs, shell history, a diff, or this session's transcripts — always alert the user immediately and explicitly:** say where it appeared, tell them to rotate it at the provider (e.g. [AMO Developer Hub](https://addons.mozilla.org/developers/addon/api/key/)), and list what needs updating afterwards (GitHub secrets, local `.env`). Never continue silently after an exposure.
- `.env` is gitignored and must stay mode `600`.
