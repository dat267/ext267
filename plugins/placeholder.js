// Self-registration setup
globalThis.Plugins = globalThis.Plugins || new Map();
if (typeof globalThis.registerPlugin !== "function") {
  globalThis.registerPlugin = function (plugin) {
    globalThis.Plugins.set(plugin.id, plugin);
  };
}

globalThis.registerPlugin({
  id: "placeholder",
  name: "Placeholder Tool",
  // No capturesDownloads or generate() - this is a pure webapp plugin
  render: async function (panel, context) {
    panel.innerHTML = "";

    const container = document.createElement("div");
    container.style.padding = "10px 0";

    const title = document.createElement("h3");
    title.textContent = "Placeholder WebApp";
    title.style.margin = "0 0 8px 0";
    title.style.fontSize = "16px";
    container.appendChild(title);

    const desc = document.createElement("p");
    desc.textContent = "This is a custom plugin panel demonstrating a decoupled web application layout. It operates with direct access to extension APIs.";
    desc.style.fontSize = "12px";
    desc.style.lineHeight = "1.4";
    desc.style.color = "var(--caption-color, #888)";
    desc.style.margin = "0 0 15px 0";
    container.appendChild(desc);

    // Interactive element
    const inputLabel = document.createElement("label");
    inputLabel.className = "text-input-label";
    inputLabel.textContent = "Custom WebApp Input:";
    
    const inputEl = document.createElement("input");
    inputEl.type = "text";
    inputEl.placeholder = "Enter custom payload...";
    inputEl.style.width = "100%";
    inputEl.style.boxSizing = "border-box";
    inputEl.style.marginTop = "4px";
    inputLabel.appendChild(inputEl);
    container.appendChild(inputLabel);

    const actionBtn = document.createElement("button");
    actionBtn.className = "btn btn-blue btn-full";
    actionBtn.style.marginTop = "12px";
    actionBtn.textContent = "Test Alert Action";
    actionBtn.onclick = () => {
      const val = inputEl.value.trim() || "Default Value";
      alert(`WebApp Action Triggered!\nInput value: ${val}`);
    };
    container.appendChild(actionBtn);

    panel.appendChild(container);
  }
});
