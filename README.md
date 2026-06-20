# cliget

Download login-protected files from the command line using curl, wget or aria2.

This addon will generate commands that emulate the request as though it was
coming from your browser by sending the same cookies, user agent string and
referrer. With this addon you can download email attachments, purchased
software/media, source code from a private repository to a remote server without
having to download the files locally first. If come across a website where
cliget doesn't work, please open an issue providing details to help reproduce
the problem.

*Windows users*: Enable the "Escape with double-quotes" option because Windows
doesn't support single quotes. If you use cygwin, however, you don't need to
enable this option.

**Please be aware** of potential security and privacy implications from cookies
being exposed in the download command.

---

## Developers & Extensibility

This extension is built with a plugin-based architecture, making it extremely easy for a human developer to add new command-line tool plugins (e.g. `httpie`, `fetch`, `curl-custom`) **by hand, without needing an LLM agent**.

### Adding a New Tool:
1. **Copy the Template**: Make a copy of [plugin-template.js](file:///home/dat/repos/ext267/plugins/plugin-template.js) and rename it (e.g., `mytool.js` inside the `plugins/` folder).
2. **Implement Generator**: Set your tool's metadata properties (`id`, `name`, `shellEscaping`, custom settings, and dynamic `customInputs` description) and implement the custom logic inside the `generate` function.
3. **Register Plugin**: Add your plugin script path to:
    - The `background.scripts` array in [manifest.json](file:///home/dat/repos/ext267/manifest.json).
    - A `<script>` tag inside [popup.html](file:///home/dat/repos/ext267/popup.html) before `popup.js`.
4. **Reload/Verify**: Load or refresh the extension. The popup UI will dynamically detect your plugin, add it as an option in the header dropdown selector, and render it. You can optionally implement a custom `render(panel, context)` method on the plugin object to completely customize its UI drawing and logic.
