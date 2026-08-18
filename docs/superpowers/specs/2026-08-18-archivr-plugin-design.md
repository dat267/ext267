# Archivr Plugin — Design Spec

Date: 2026-08-18
Status: Draft (pending user review)
Extension: ext267 (MPL-2.0, Manifest V3 WebExtension)

## Overview

A new self-contained plugin, **Archivr** (id `archivr`), that automatically captures every page the
user browses during a browser session and lets them bulk-save a selection as a single ZIP archive on
their device, containing per-page self-contained HTML files (SingleFile-style, with resources
inlined) plus Markdown versions.

Product decisions (confirmed with the user):

- **Capture mode**: auto-capture every navigation, controlled by a master on/off toggle.
- **Formats**: HTML (self-contained) + Markdown. PDF is out of scope for v1.
- **Bulk save**: one ZIP archive per save action, downloaded via the `downloads` API.
- **Retention**: session-only. Captured pages are wiped on browser restart.
- **Offline assets**: resources are inlined (this overrides the earlier "references only" choice).
  The HTML serializer reimplements SingleFile's mechanism — does NOT bundle SingleFile itself.
- **Dependencies**: vendor everything into the repo under `plugins/archivr-libs/`, MIT-licensed
  parser libraries with license headers intact. No references to external repositories or CDNs.

## Architecture

The plugin follows the existing self-contained plugin conventions in AGENTS.md. It spans files
because it runs in three contexts with distinct responsibilities.

### Files

| File | Contexts | Responsibility |
|------|----------|----------------|
| `plugins/archivr.js` | background + popup | Capture store (IndexedDB), message handlers, save/serialize/zip/download pipeline, popup render UI, plugin registration |
| `plugins/archivr-content.js` | content script (every http/https page) | Extract page snapshot and report it to the background |
| `plugins/archivr-libs/parse-srcset.js` | background | Vendored MIT: parse/rewrite `srcset` attributes |
| `plugins/archivr-libs/parse-css-font.js` | background | Vendored MIT: parse `@font-face` / font shorthand |
| `plugins/archivr-libs/uglifycss.js` | background | Vendored MIT: minify CSS while preserving `url()` tokens |
| `plugins/archivr-libs/mimetype.js` | background | Vendored MIT (whatwg-mimetype): content-type detection for fetched subresources |
| `plugins/archivr-libs/turndown.js` | background | Vendored MIT: HTML→Markdown conversion |
| `plugins/archivr-libs/turndown-plugin-gfm.js` | background | Vendored MIT: GFM extensions for Turndown (tables, strikethrough) |

All vendored files are committed physically into the repo with their original MIT license headers.
No file references an external URL for loading.

### Context detection

Each file determines its context at load:

- **Background**: `typeof window === "undefined"` (Chrome MV3 service worker) OR
  (`typeof location !== "undefined"` AND `location.pathname !== "/popup.html"` — Firefox event
  page). Same pattern as cliget.
- **Content script**: `typeof window !== "undefined"` AND `location.protocol` is `http:` or
  `https:` (page protocol; extension pages use `moz-extension:`/`chrome-extension:`).
- **Popup**: anything that is not background and not content (i.e. `location.pathname ===
  "/popup.html"`).

### Data flow

- **Page → background**: content script sends `{ kind: "archivr:capture", url, title, baseURI, html, ts }`
  via `ext.runtime.sendMessage`. Background stores it and bumps the action badge.
- **Popup → background**: popup requests the capture list (`archivr:list`), triggers save
  (`archivr:save`, passing an array of capture ids), and clears the store (`archivr:clear`).
  Captures live in durable IndexedDB (not ephemeral background maps), so the popup passes capture
  **ids** and the background resolves them — worker recycling cannot lose them.
- The entire save pipeline (serialize → markdown → zip → download) runs in the background so it
  survives the popup closing.

## Manifest changes

```jsonc
{
  "content_scripts": [
    {
      "matches": ["http://*/*", "https://*/*"],
      "js": ["plugins/archivr-content.js"],
      "run_at": "document_idle"
    }
  ],
  "background": {
    "scripts": [
      "plugins/archivr-libs/parse-srcset.js",
      "plugins/archivr-libs/parse-css-font.js",
      "plugins/archivr-libs/uglifycss.js",
      "plugins/archivr-libs/mimetype.js",
      "plugins/archivr-libs/turndown.js",
      "plugins/archivr-libs/turndown-plugin-gfm.js",
      "plugins/archivr.js"
    ]
  }
}
```

`popup.html` gains one `<script src="plugins/archivr.js">` tag (placed before `popup.js`, matching
how cliget is loaded). Vendored libs are **not** loaded in the popup, so `archivr.js` must only
reference vendored-lib globals (e.g. `TurndownService`, `parseSrcset`) lazily, inside
background-guarded functions — never at file top-level or in the popup render path. Serialization
never runs in the popup, so it does not need them.

No new permissions are required: `webRequest`, `storage`, `tabs`, `downloads`, and `<all_urls>`
host permissions are already declared. Subresource fetches for inlining rely on the existing
`<all_urls>` host permission.

## Storage

IndexedDB database `archivr-captures` owned by the background:

- Object store `captures`, keyed by capture id (monotonic counter).
- Records: `{ id, url, title, baseURI, html, ts, size }` where `size` is the byte length of `html`.
- Survives MV3 service-worker recycling.
- **Session-only**: on `ext.runtime.onStartup` the whole database is cleared. This fires once per
  browser launch in both Chrome and Firefox MV3. It is NOT cleared on worker spin-up (that happens
  mid-session and must not wipe captures).
- An in-memory index (array of `{ id, url, title, ts, size }`, newest first) is kept in the
  background for fast popup listing; capped at 300 entries (FIFO eviction) while IndexedDB holds the
  full session. Keeping both mirrors the cliget pattern of a bounded in-memory map.

## Capture pipeline

### Content script (`plugins/archivr-content.js`)

Runs at `document_idle` in every http/https page:

1. Read the master toggle from `storage.local` (`archivr.enabled`, default `false`). If off, do
   nothing.
2. Skip noise:
   - Document has no usable title and no visible body text.
   - `location.protocol` other than `http:`/`https:` (e.g. `about:`, `data:`, `blob:`).
3. Extract `document.title`, `location.href`, `document.baseURI`, and
   `document.documentElement.outerHTML` (cheap same-process snapshot; no serialization/fetching
   here — capture must stay instant).
4. Send `{ kind: "archivr:capture", url, title, baseURI, html, ts: Date.now() }` to the background.
5. Disarm for this tab so hash changes and pushState storms do not spam duplicates.
6. **SPA support**: re-arm via a hook on `pushState`/`replaceState`/`popstate` (and the modern
   `navigation` API where available), then re-capture ~400ms after the new route settles. Dedupe in
   the background still applies.

### Background handling

- On `archivr:capture`: dedupe by URL equalling the most recent capture within 5 seconds (same
  heuristic as cliget). Store if unique.
- Badge shows the session capture count; cleared when the Archivr panel is opened.

## File generation (background, on demand)

Runs only when the user saves — never during browsing.

### HTML serialization (custom logic around vendored parsers)

1. Take stored `html` and absolutize all relative URLs against `baseURI`.
2. Rewrite `srcset` attributes using vendored **parse-srcset** (handles comma/whitespace rules and
   `x`/`w` descriptors).
3. For each `<link rel=stylesheet>`:
   - Fetch the CSS via the `<all_urls>` host permission.
   - Minify with vendored **UglifyCSS** while preserving token fidelity.
   - Walk declarations, find `url(...)` and `@font-face src` references, fetch and inline them as
     `data:` URIs using vendored **whatwg-mimetype** for the MIME type.
   - Recurse into `@import`.
   - Emit the finished CSS as an inline `<style>` and remove the original `<link>`.
4. Inline `<img src>`, `<picture><source>`, and CSS-referenced assets (background images, fonts).
5. Strip `<script>` tags and `on*`/`href="javascript:"` attributes (faithful visual copy, no
   executable code).
6. Insert `<base href={baseURI}>` so remaining absolute references still resolve offline.
7. Emit one self-contained `.html` file.

The fetch queue, MIME sniffing, data-URI assembly, dedupe of fetched resources, and the overall
serializer are written by us. Vendored parsers only tokenize.

### Markdown

Turndown (+ GFM plugin) converts the same captured HTML to a `.md` file alongside the HTML.

### ZIP + download

- Custom STORE-only zip writer (~80 lines): local file headers + central directory + EOCD, UTF-8
  filename flag set, CRC32 computed per file. STORE (no compression) is acceptable for text.
- Archive layout for a save of N selected captures:

```
ext267-archive-YYYYMMDD-HHMMSS/
  01 - Some Title/index.html
  01 - Some Title/page.md
  02 - Another Title/index.html
  02 - Another Title/page.md
  ...
  manifest.json       // { savedAt, count, entries: [{ title, url, ts, html, md }] }
  README.txt          // generated summary + notes on how to use the archive
```

- Sanitize titles into safe file/folder names (strip path separators and control characters),
  dedupe colliding names with numeric suffixes, preserve order by capture time.
- Download via `ext.downloads.download({ url: blobURL, filename, saveAs: false, conflictAction:
  "uniquify" })`, then revoke the blob URL.

## Popup UI

Mirrors cliget's render style (DOM creation via `document.createElement`, no innerHTML):

- Master **"Auto-capture"** toggle (persisted in `storage.local` as `archivr.enabled`, default off).
- Capture list: checkbox per entry (title, host, size, relative time), newest first, select-all,
  per-entry deselect.
- **"Save selected as .zip"** (btn-blue, outlined) → asks the background to save, shows
  progress/disabled state while serialization runs.
- **"Clear session"** (btn-red) → wipes IndexedDB store and badge.
- Empty-state message with instructions when nothing was captured this session.
- The plugin registers itself with `globalThis.registerPlugin({ id: "archivr", name: "Archiver",
  render })` and defines its own `ext` at file scope.

## Error handling & edge cases

- **Per-resource failure** (CORS, auth-walled assets, dead links): log to console, skip the
  resource, leave the URL as a normal reference. The HTML stays valid; it is just not 100%
  complete (SingleFile behaves this way too).
- **IndexedDB unavailable**: fall back to `storage.local` (bounded by quota); captures degrade
  gracefully.
- **Huge pages** (> ~5MB html): still captured; content-script messaging handles large strings via
  structured clone. Serialization of many/large pages may take seconds — the popup shows progress.
- **Empty selection**: the save action is disabled.
- **Browser restart**: everything is cleared by design (session-only).
- **Windows/unicode file names**: sanitized on export; Unicode titles preserved (used the UTF-8 zip
  filename flag).

## Testing

Same `node:test` + `vm` harness as the existing `tests/cliget.test.js`, loading
`plugins/archivr.js` into a sandbox with stubbed `ext` APIs.

- **Zip writer** (pure): produce an archive, verify byte layout and CRC32, and validate round-trip
  (structural assertions + in-memory fixture; `unzip -t` optional manual check).
- **Absolutizer**: relative/absolute/root-relative/`//` URLs against a base URI.
- **srcset rewriting**: vendored parse-srcset behavior on representative attributes.
- **CSS token walk**: `url()` extraction, `@import` recursion, `@font-face` handling.
- **data-URI assembly**: MIME handling, base64 correctness.
- **Escaping/sanitizing**: title → folder name, dedupe collisions.
- **Dedupe logic**: same-URL-within-5s rejection, distinct-URL acceptance.
- **Turndown output**: representative page → expected Markdown.
- **Archive layout**: folder names, manifest.json structure, per-entry html+md presence.

CI already runs `npm test` — new tests must pass there. `npx eslint .` and `npm run lint`
(web-ext) must stay clean.

## Out of scope (v1)

- PDF export.
- Cloud destinations (Google Drive, GitHub).
- Multi-tab processing, iframe serialization, annotations, user scripts.
- Compression in the zip (STORE only).