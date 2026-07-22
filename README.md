# ext267

A multipurpose, extensible browser toolkit with a plugin-based architecture.

## Plugins

### cliget
Capture download requests from your browser and generate equivalent CLI commands for **curl**, **wget**, and **aria2c**. Emulates the same cookies, user agent, and referrer as your browser session.

Useful for downloading login-protected files (email attachments, private repos, purchased software) to a remote server without downloading locally first.

*Windows users*: Enable the "Escape with double-quotes" option (cmd.exe doesn't support single quotes). Cygwin users can keep the default.

### Activity Recorder
Record all browser network activity to reverse-engineer website functionality. Captures every request's URL, method, headers, request body, status code, content-type, and timing — grouped by page navigation. Export as **AI-friendly Markdown** (structured by domain, with header tables and body code blocks) or raw **JSON**.

Ideal for generating API documentation, implementing automated processing in Go/Python/JavaScript, or feeding context to coding agents.

---

## Developer Guide

This extension uses a self-registering plugin system. Each plugin is fully self-contained — no shared utilities, no cross-plugin dependencies.

### Plugin Types

**Download-intercepting** (like cliget) — uses the `_isBackground` guard to register `webRequest` listeners in the background context, communicates with the popup via namespaced messages.

**Standalone** (like the recorder) — all logic lives in `render(panel, context)`. Can use `ext.*` APIs directly.

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
npm run lint     # web-ext lint + ESLint
npm run build    # package signed XPI
```

---

## CI/CD

A GitHub Actions pipeline at `.github/workflows/amo-publish.yml` handles AMO signing. Trigger by pushing a `v*` tag or manually from the Actions tab. Requires `AMO_API_KEY` and `AMO_API_SECRET` repository secrets.
