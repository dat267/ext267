# ext267

A multipurpose, extensible browser toolkit with a plugin-based architecture.

## Plugins

### cliget
Capture download requests from your browser and generate equivalent CLI commands for **curl**, **wget**, and **aria2c**. Emulates the same cookies, user agent, and referrer as your browser session.

Useful for downloading login-protected files (email attachments, private repos, purchased software) to a remote server without downloading locally first.

*Windows users*: Enable the "Escape with double-quotes" option (cmd.exe doesn't support single quotes). Cygwin users can keep the default.

### archivr
Automatically captures every page you browse during a session (opt-in toggle) and bulk-saves a
selection as a single ZIP: each page becomes a folder with a self-contained `index.html` (resources
inlined, single-file style) and a `page.md` (Markdown) version, plus a `manifest.json` and README.
Captures are session-only and are wiped on browser restart.

---

## Developer Guide

This extension uses a self-registering plugin system. Each plugin is fully self-contained — no shared utilities, no cross-plugin dependencies.

### Plugin Types

**Download-intercepting** (like cliget) — uses the `_isBackground` guard to register `webRequest` listeners in the background context, communicates with the popup via namespaced messages.

**Standalone** — all logic lives in `render(panel, context)`. Can use `ext.*` APIs directly.

### Adding a New Plugin

1. Copy `plugins/plugin-template.js` to `plugins/yourplugin.js`.
2. Set `id`, `name`, and implement `render(panel, context)`.
3. Add the script to `manifest.json` → `background.scripts`.
4. Add a `<script>` tag in `popup.html` before `popup.js`.
5. Reload the extension — the popup selector auto-populates.

Full architecture details are in [AGENTS.md](AGENTS.md).

---

## Building

```bash
npm ci
npm test     # unit tests (node:test)
npm run lint # web-ext lint + ESLint
npm run build    # package signed XPI
```

---

## CI/CD

A GitHub Actions pipeline at `.github/workflows/amo-publish.yml` handles AMO signing. Trigger by pushing a `v*` tag (defaults to **unlisted** for self-distribution) or manually from the Actions tab. Requires `AMO_API_KEY` and `AMO_API_SECRET` repository secrets.
