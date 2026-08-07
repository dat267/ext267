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

| Plugin | Type | Purpose |
|--------|------|---------|
| [cliget.js](file:///home/dat/repos/ext267/plugins/cliget.js) | Download-intercepting | Intercepts main_frame/sub_frame downloads and generates curl/wget/aria2c commands |

---

## Coding Standards & Performance Guidelines

To maintain extension performance, stability, and compatibility on both desktop and mobile platforms, all code modifications must adhere to the following standards:

### 1. Static WebRequest Listeners
* **Why**: Continuous tracking of non-document resources drains system resources.
* **Standard**: Inside the `_isBackground` guard of plugins that use webRequest, listeners must be statically registered synchronously at startup. The `types` filter must be as narrow as the plugin requires:
  * **cliget** (download interception): `["main_frame", "sub_frame"]` only.

### 2. Stateless MV3 Message Passing
* **Why**: Manifest V3 background service workers are ephemeral and will suspend when idle. Keeping request objects only in background memory and looking them up via IDs from the popup will fail if the background worker has recycled.
* **Standard**: When sending messages from the popup to request actions, **always pass the full request payload object** rather than a database/Map ID reference. Refer to `render` in each plugin and the corresponding message handler branch.

### 3. Memory Leak Protection (FIFO Map Eviction)
* **Why**: The background map stores pending request details. If network requests are aborted or never complete, this Map can grow unboundedly.
* **Standard**: Implement a FIFO eviction limit on pending request Maps:
  ```js
  if (pendingRequests.size > 200) {
    const oldestKey = pendingRequests.keys().next().value;
    pendingRequests.delete(oldestKey);
  }
  ```

### 4. Redirect & Error Handling in webRequest Pipelines
* **Why**: Redirected requests fire `onBeforeRedirect` instead of `onCompleted`. Failed requests fire `onErrorOccurred`. Without handling these, pending request entries accumulate and leak memory.
* **Standard**: Always register listeners for `onBeforeRedirect` (clean up pending entries) and `onErrorOccurred` (finalize + clean up).

### 5. Plugin Registry Standards
* **Why**: To keep the extension codebase modular and decoupled from specific plugins, allowing new tools to be added with zero changes to popup or background core scripts.
* **Standard**: Every plugin must register itself at load time via `globalThis.registerPlugin()`. Plugins come in two forms:

  **A. Background-intercepting plugin** (uses `_isBackground` guard, registers webRequest/message listeners):
  ```js
  const ext = typeof browser !== "undefined" ? browser : chrome;

  // Correct cross-browser background context detection:
  // - Chrome MV3: window is undefined (pure service worker)
  // - Firefox MV3: background.scripts runs as event page — window exists, but document does not
  //   and location.pathname is NOT /popup.html
  const _isBackground = typeof window === "undefined" ||
    (typeof location !== "undefined" && location.pathname !== "/popup.html");

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

* **`render(panel, context)` context shape**: `{ refresh }` only. The popup shell passes no extension APIs — each plugin is responsible for its own `ext` variable defined at file scope.

---

## Design and Styling System

All styling resides in [popup.css](file:///home/dat/repos/ext267/popup.css) using CSS variable design tokens.

### Outlined Buttons Conventions
* To maintain a uniform, modern UI aesthetic, all action and form buttons must use the outlined button styling conventions:
  * Use the `.btn` base class.
  * Combine with modifier classes like `.btn-blue` (accent borders) or `.btn-red` (warning borders).
  * Avoid filling solid backgrounds unless explicitly required for prominent primary actions.
  * Interactive states must define transitions for hover/active states with subtle scaling or border highlights.

### CSS Animations
* Add animations in [popup.css](file:///home/dat/repos/ext267/popup.css) as `@keyframes` blocks. Use dedicated utility classes (e.g., `.recording-indicator`) rather than inline animation styles.

---

## Coding Style & Portability Rules

* **Plain JavaScript**: Do not use Babel, TypeScript, webpack, or npm bundlers. Keep the source code transparent and readable for review on AMO / Chrome Web Store.
* **Cross-Browser Compatibility**: Always use the polyfill-ready variable `ext` to call standard extension APIs:
  ```js
  const ext = typeof browser !== "undefined" ? browser : chrome;
  ```
* **Unicode / CJK Support**: Prevent mojibake in filename extraction. Content-Disposition headers with non-Latin characters must be parsed using the `decodeHeaderValue` helper defined inside [cliget.js](file:///home/dat/repos/ext267/plugins/cliget.js):
  ```js
  function decodeHeaderValue(str) { ... }
  ```
* **No innerHTML for Dynamic Content**: Always use `document.createElement` and `textContent` for rendering user-visible or dynamic values. Do not use `innerHTML` with template literals containing runtime data.

---

## Linting & Code Quality

* **ESLint**: Uses ESLint v9 flat config ([eslint.config.mjs](file:///home/dat/repos/ext267/eslint.config.mjs)) with `eslint:recommended`, `eslint-plugin-prettier`, and custom rules (`no-shadow`, `prefer-arrow-callback`, `curly`). Node.js build scripts use `globals.node`; extension code uses `globals.browser` + `globals.webextensions`.
* **Prettier**: Configured via [.prettierrc](file:///home/dat/repos/ext267/.prettierrc) and run as an ESLint rule.
* **Empty catch blocks**: Use `catch { /* explain why */ }` (optional catch binding, ES2019+). Never use `catch (e) {}` with an empty body.

---

## Building & Verification

Verify changes by running the following tasks:
* **Lint**: `npm run lint` (Checks WebExtension structure via `web-ext lint`). Also run `npx eslint .` for code quality.
* **Development**: Run `npx web-ext run` to test changes inside Firefox.
* **Build**: `npm run build` or `npm run package:xpi` to package the extension into `web-ext-artifacts/ext267.xpi`.

---

## CI/CD & Publishing (addons.mozilla.org)

A GitHub Actions pipeline is configured at `.github/workflows/amo-publish.yml` to automate submission and signing to the Mozilla Add-ons (AMO) store.

### Configuration & Secrets
For the pipeline to work, configure the following **Repository Secrets** in your GitHub repository:
* `AMO_API_KEY`: The API key (JWT issuer) from the [AMO Developer Hub](https://addons.mozilla.org/developers/addon/api/key/).
* `AMO_API_SECRET`: The API secret (JWT secret) from the AMO Developer Hub.

### Workflow Behavior
1. **Trigger Options**:
   * **Tag Pushes**: Runs automatically when a tag matching `v*` is pushed. Submits to the **unlisted** channel for self-distribution.
   * **Manual Dispatch**: Can be triggered manually from the GitHub Actions tab. Allows selecting between **listed** (AMO store release) and **unlisted** (self-distribution package) channels.
2. **Execution Steps**:
   * Checks out the repository.
   * Installs Node.js dependencies (`npm ci`).
   * Runs the webextension linter (`npm run lint`).
   * Calls `npx web-ext sign` to package, upload, and submit/sign the extension.
   * For the `listed` channel, it passes `--approval-timeout 0` so the pipeline finishes immediately after a successful upload rather than hanging for manual review.
   * Uploads built artifact packages to the run summary.

### Android Installation
For Firefox on Android, trigger the workflow with the `unlisted` channel. The signed XPI from the artifacts can be side-loaded via `Settings → Install extension from file` (enable debug menu: tap the Firefox logo 5 times in `Settings → About Firefox`).
