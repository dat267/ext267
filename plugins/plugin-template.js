/**
 * Extension Generator Plugin Template
 * 
 * To add a new command generator to this extension by hand:
 * 
 * 1. Copy this file and rename it (e.g. httpie.js).
 * 2. Configure the metadata fields below:
 *    - id: Unique string ID.
 *    - name: Display name in the popup UI selector.
 *    - shellEscaping: True if it uses shell escaping (shows Windows double-quotes checkbox).
 *    - defaultOptions: Key/value options specific to this tool.
 *    - customInputs: Metadata describing UI inputs for the configuration panel.
 * 3. Implement the generate() function to format and return the CLI command.
 * 4. Add the plugin script to the background scripts list in manifest.json and include it in popup.html before popup.js.
 * 5. Rebuild or reload the extension. The popup UI will automatically render the tool.
 *    Optionally, you can define a custom render(panel, context) function to completely
 *    override and customize the plugin's UI layout and event logic.
 */

// Self-registration setup
globalThis.Plugins = globalThis.Plugins || new Map();
if (typeof globalThis.registerPlugin !== "function") {
  globalThis.registerPlugin = function (plugin) {
    globalThis.Plugins.set(plugin.id, plugin);
  };
}

globalThis.registerPlugin({
  // Unique tool ID. Used internally and as the command option key
  id: "mytool",

  // Human-readable name shown in the tool selector in popup UI
  name: "MyTool",

  // Set to true if this tool accepts shell escaping options (Windows doubleQuotes).
  // If true, the popup will render the "Escape with double-quotes (Windows)" checkbox.
  shellEscaping: true,

  // Default option values specific to this tool.
  // These are merged automatically with global defaultOptions at startup.
  defaultOptions: {
    mytoolOptions: ""
  },

  // Input configurations dynamically rendered in the popup options panel for this tool.
  customInputs: [
    {
      key: "mytoolOptions",
      label: "Extra MyTool arguments:",
      placeholder: "e.g. --verbose --insecure",
      type: "text" // Supports "text" and "checkbox" types
    }
  ],

  /**
   * Generates the command-line instruction string.
   * 
   * @param {string} url - The intercepted request URL.
   * @param {string} method - HTTP method (e.g., GET, POST).
   * @param {Array<{name: string, value: string}>} headers - Filtered request headers.
   * @param {Object|null} payload - Request payload/body info.
   * @param {string|null} filename - Captured file name or null.
   * @param {Object} options - Current configuration options.
   * @returns {string} The formatted command-line execution string.
   */
  generate: function (url, method, headers, payload, filename, options) {
    const esc = globalThis.escapeShellArg;
    
    // Build the command array
    let parts = ["mytool"];

    // Append extra arguments configured in popup UI
    if (options.mytoolOptions) {
      parts.push(options.mytoolOptions);
    }

    // Append headers
    for (let header of headers) {
      let formattedHeader = esc(`${header.name}: ${header.value}`, options.doubleQuotes);
      parts.push(`--header ${formattedHeader}`);
    }

    // Append URL
    parts.push(esc(url, options.doubleQuotes));

    // Return final command string joined by space
    return parts.join(" ");
  }
});
