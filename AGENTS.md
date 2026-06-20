# Project Overview: ext267

**ext267** is a modernized, responsive, and personal fork of the original `cliget` extension. It enables users to capture download requests from their browser and generate equivalent command-line instructions for `curl`, `wget`, and `aria2c`.

### Main Technologies
- **Platform**: Browser WebExtension (Manifest V3 compatible).
- **Languages**: Plain JavaScript, CSS3 (Modern Firefox-inspired theme).
- **Tooling**: `web-ext` for building, linting, and packaging.
- **Permissions**: `webRequest`, `storage`, `tabs`, `downloads`.

### Core Architecture
- **Plugin-based Extensible Generators**: Each plugin registers itself dynamically in both popup and background scopes via a standard `registerPlugin` registry map. Plugins do not rely on shared scripts like `utils.js` or `background.js`.
- **Dynamic Popup UI Selector**: The popup selector is built dynamically in [popup.js](file:///home/dat/repos/ext267/popup.js) by mapping registered plugin metadata from the global map.
- **Decoupled Plugin Execution**: Plugins run as completely self-contained entities. If a plugin requires background listeners (such as downloads interception via webRequest APIs) or utility helpers (like shell escaping), all that logic resides inside the plugin file itself (e.g. [cliget.js](file:///home/dat/repos/ext267/plugins/cliget.js)), isolated inside a service worker context check.
- **Self-Contained Dynamic Interfaces**: Each plugin panel dynamically registers and builds its own layout. If it uses custom rendering (via the `render(panel, context)` hook), it draws all forms, picker select lists, options inputs, output textareas, and buttons locally.

---

## Coding Standards & Performance Guidelines

To maintain extension performance, stability, and compatibility on both desktop and mobile platforms, all code modifications must adhere to the following standards:

### 1. Static WebRequest Listeners
* **Why**: Continuous tracking of non-document resources drains system resources. 
* **Standard**: Inside the service worker check of download-capturing plugins (e.g., [cliget.js](file:///home/dat/repos/ext267/plugins/cliget.js)), webRequest listeners must be statically registered synchronously at startup, matching only `["main_frame", "sub_frame"]` to capture document page frame downloads with zero excess overhead.

### 2. Stateless MV3 Message Passing
* **Why**: Manifest V3 background service workers are ephemeral and will suspend when idle. Keeping request objects only in background memory and looking them up via IDs from the popup will fail if the background worker has recycled.
* **Standard**: When sending messages from the popup to request actions (like generating commands), **always pass the full request payload object** rather than a database/Map ID reference. Refer to `render` in `cliget.js` and the corresponding message handler branch.

### 3. Memory Leak Protection (FIFO Map Eviction)
* **Why**: The background map stores pending request details. If network requests are aborted or never complete, this Map can grow unboundedly.
* **Standard**: Implement a FIFO eviction limit in `beforeRequestCallback` inside the plugin's background check to bound the Map size:
  ```js
  if (currentRequests.size > 150) {
    const oldestKey = currentRequests.keys().next().value;
    currentRequests.delete(oldestKey);
  }
  ```

### 4. Plugin Registry Standards
* **Why**: To keep the extension codebase modular and decoupled from specific plugins, allowing new tools to be added with zero changes to popup or background core scripts.
* **Standard**: Every plugin must register itself at load time. If it requires a fully customized interface or specialized event logic, it can optionally provide a `render(panel, context)` function:
  ```js
  globalThis.registerPlugin({
    id: "tool-id",
    name: "Display Name",
    shellEscaping: true, // Set true if it accepts shell escaping options (Windows doubleQuotes)
    defaultOptions: {
      toolOptions: "" // Custom options defaults
    },
    customInputs: [
      {
        key: "toolOptions",
        label: "Extra Tool arguments:",
        placeholder: "e.g. --flags",
        type: "text" // Support text inputs and checkboxes
      }
    ],
    generate: function (url, method, headers, payload, filename, options) {
      // Return generated command string
    },
    render: async function (panel, context) {
      // Optional: draw custom controls and attach event listeners to panel
    }
  });
  ```

---

## Design and Styling System

All styling resides in [popup.css](file:///home/dat/repos/ext267/popup.css) using CSS variable design tokens.

### Outlined Buttons Conventions
* To maintain a uniform, modern UI aesthetic, all action and form buttons must use the outlined button styling conventions:
  * Use the `.btn` base class.
  * Combine with modifier classes like `.btn-blue` (accent borders) or `.btn-red` (warning borders).
  * Avoid filling solid backgrounds unless explicitly required for prominent primary actions.
  * Interactive states must define transitions for hover/active states with subtle scaling or border highlights.

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

---

## Building & Verification

Verify changes by running the following tasks:
* **Lint**: `npm run lint` (Checks WebExtension and ESLint structure)
* **Development**: Run `npx web-ext run` to test changes inside Firefox.
* **Build**: `npm run build` or `npm run package:xpi` to package the extension.
