const messagesEl = document.getElementById("messages");
const welcomeEl = document.getElementById("welcome");
const userInput = document.getElementById("user-input");
const btnSend = document.getElementById("btn-send");
const btnClear = document.getElementById("btn-clear");
const btnSettings = document.getElementById("btn-settings");
const btnToggleContext = document.getElementById("btn-toggle-context");
const pageContextBar = document.getElementById("page-context-bar");
const statusDot = document.getElementById("connection-status");

let state = {};
let includeContext = true;
let isLoading = false;
let lastApproval = null;
let commandPalette = null;
let commandPaletteIndex = 0;
let commandPaletteOffset = 0;
let commandPaletteMatches = [];
let commandPaletteQuery = "";

let SLASH_COMMANDS = [
  { name: "/help", usage: "/help", desc: "Show available slash commands" },
  { name: "/clear", usage: "/clear", desc: "Clear Chrome chat history and start a fresh Hermes session" },
  { name: "/new", usage: "/new", desc: "Alias for /clear" },
  { name: "/settings", usage: "/settings", desc: "Open extension settings" },
  { name: "/status", usage: "/status", desc: "Check local Hermes gateway status" },
  { name: "/detect", usage: "/detect", desc: "Auto-detect the local Hermes gateway" },
  { name: "/context", usage: "/context on|off|toggle", desc: "Control page context for messages" },
  { name: "/runtime", usage: "/runtime", desc: "Show Hermes provider/model/base URL" },
  { name: "/tools", usage: "/tools [list|status]", desc: "Show Hermes tool/toolset configuration visible to the extension" },
  { name: "/model", usage: "/model [model-id]", desc: "Show or set Hermes model" },
  { name: "/provider", usage: "/provider [provider-id]", desc: "Show or set Hermes provider" },
  { name: "/baseurl", usage: "/baseurl [url|clear]", desc: "Show or set provider base URL" },
  { name: "/page", usage: "/page", desc: "Preview the page context Hermes will receive" },
  { name: "/approve", usage: "/approve", desc: "Approve the latest command approval request" },
  { name: "/deny", usage: "/deny", desc: "Deny the latest command approval request" },
  { name: "/send", usage: "/send /literal text", desc: "Send text beginning with / to Hermes" },
];
const LOCAL_COMMAND_NAMES = new Set(SLASH_COMMANDS.map(c => c.name));

async function init() {
  state = await getState();
  includeContext = state.includePageContext !== false;
  btnToggleContext.classList.toggle("active", includeContext);
  btnToggleContext.textContent = includeContext ? "ON" : "OFF";

  if (state.includePageContext) {
    pageContextBar.classList.remove("hidden");
  }

  await checkConnection();
  await loadSlashCommands();

  const conv = await getConversation();
  if (conv.history.length > 0) {
    welcomeEl.style.display = "none";
    conv.history.forEach(msg => addMessage(msg.role, msg.content, false));
    scrollToBottom();
  }

  document.querySelectorAll(".quick-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      userInput.value = btn.dataset.msg;
      sendMessage();
    });
  });
}

function getState() {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type: "get-state" }, resolve);
  });
}

function getConversation() {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type: "get-conversation" }, resolve);
  });
}

async function checkConnection() {
  statusDot.classList.add("checking");
  const result = await new Promise(resolve => {
    chrome.runtime.sendMessage({ type: "check-gateway" }, resolve);
  });
  statusDot.classList.remove("checking");
  if (result.ok) {
    statusDot.classList.add("connected");
    statusDot.title = "Connected to Hermes";
    state.gatewayUrl = result.url || state.gatewayUrl;
  } else {
    const detected = await new Promise(resolve => {
      chrome.runtime.sendMessage({ type: "detect-gateway" }, resolve);
    });
    if (detected?.ok) {
      state.gatewayUrl = detected.selected;
      statusDot.classList.add("connected");
      statusDot.title = "Connected to Hermes at " + detected.selected;
      return;
    }
    statusDot.classList.remove("connected");
    statusDot.title = "Disconnected: " + result.error;
  }
}

async function sendMessage() {
  let text = userInput.value.trim();
  if (!text || isLoading) return;

  isLoading = true;
  btnSend.disabled = true;
  userInput.value = "";
  userInput.style.height = "auto";
  hideCommandPalette();

  if (text.startsWith("/") && !text.startsWith("//")) {
    const handled = await handleSlashCommand(text);
    if (handled) {
      isLoading = false;
      btnSend.disabled = false;
      return;
    }
  }
  if (text.startsWith("//")) text = text.slice(1);

  welcomeEl.style.display = "none";

  addMessage("user", text);
  scrollToBottom();

  const typingEl = showTyping();
  scrollToBottom();

  let pageContext = null;
  if (includeContext) {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) {
        pageContext = await getPageContext(tab);
      }
    } catch (e) {
    }
  }

  try {
    const result = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        type: "send-to-hermes",
        message: text,
        pageContext: pageContext,
      }, response => {
        if (response.error) {
          reject(new Error(response.error));
        } else {
          resolve(response);
        }
      });
    });

    typingEl.remove();
    addMessage("assistant", result.response);
  } catch (err) {
    typingEl.remove();
    addMessage("error", "Failed to reach Hermes: " + err.message);
    checkConnection();
  } finally {
    isLoading = false;
    btnSend.disabled = false;
    scrollToBottom();
  }
}

function addMessage(role, content, animate = true) {
  const div = document.createElement("div");
  div.className = `message ${role}`;
  if (animate) div.style.animation = "fadeIn 0.2s ease";
  div.innerHTML = `<div class="role">${role}</div>${escapeHtml(content)}`;
  messagesEl.appendChild(div);
}

function showTyping() {
  const div = document.createElement("div");
  div.className = "typing";
  div.innerHTML = "<span></span><span></span><span></span>";
  messagesEl.appendChild(div);
  return div;
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function getPageContext(tab) {
  const fallback = { title: tab.title, url: tab.url };
  if (!tab.id || !tab.url || /^(chrome|edge|about|chrome-extension):\/\//.test(tab.url)) {
    return fallback;
  }

  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const clone = document.body?.cloneNode(true);
        if (!clone) return { title: document.title, url: location.href };
        clone.querySelectorAll("script,style,noscript,iframe,nav,footer,header,aside,[aria-hidden='true']").forEach(el => el.remove());
        let text = (clone.innerText || clone.textContent || "").replace(/\n\s*\n/g, "\n\n").trim();
        if (text.length > 4000) text = text.slice(0, 4000) + "... (truncated)";
        return {
          title: document.title,
          url: location.href,
          lang: document.documentElement.lang || "",
          text,
        };
      },
    });
    return result || fallback;
  } catch {
    return fallback;
  }
}

function escapeHtml(text) {
  const d = document.createElement("div");
  d.textContent = text;
  return d.innerHTML;
}

async function handleSlashCommand(input) {
  const [rawCommand, ...rest] = input.split(/\s+/);
  const command = rawCommand.toLowerCase();
  const arg = rest.join(" ").trim();

  switch (command) {
    case "/help":
      addSystemMessage(SLASH_COMMANDS.map(c => `${c.usage}\n  ${c.desc}`).join("\n\n"));
      return true;

    case "/clear":
    case "/new":
      await clearConversation();
      hideCommandPalette();
      addSystemMessage("Started a fresh Hermes Chrome session.");
      return true;

    case "/settings":
      chrome.runtime.openOptionsPage();
      addSystemMessage("Opened settings.");
      return true;

    case "/status": {
      const result = await chrome.runtime.sendMessage({ type: "check-gateway" });
      if (result?.ok) addSystemMessage(`Hermes gateway is connected at ${result.url || state.gatewayUrl} via ${result.path || "health check"}.`);
      else addMessage("error", `Gateway disconnected: ${result?.error || "unknown error"}`);
      return true;
    }

    case "/detect": {
      addSystemMessage("Scanning localhost for Hermes gateway...");
      const result = await chrome.runtime.sendMessage({ type: "detect-gateway" });
      if (result?.ok) {
        state.gatewayUrl = result.selected;
        addSystemMessage(`Detected Hermes gateway: ${result.selected}`);
        await checkConnection();
      } else {
        addMessage("error", `Auto-detect failed: ${result?.error || "not found"}`);
      }
      return true;
    }

    case "/context": {
      const mode = arg.toLowerCase();
      if (["on", "off", "toggle", ""].includes(mode)) {
        includeContext = mode === "on" ? true : mode === "off" ? false : !includeContext;
        btnToggleContext.classList.toggle("active", includeContext);
        btnToggleContext.textContent = includeContext ? "ON" : "OFF";
        await chrome.runtime.sendMessage({ type: "set-option", key: "includePageContext", value: includeContext });
        addSystemMessage(`Page context is now ${includeContext ? "ON" : "OFF"}.`);
      } else {
        addMessage("error", "Usage: /context on|off|toggle");
      }
      return true;
    }

    case "/runtime": {
      const config = await chrome.runtime.sendMessage({ type: "get-hermes-config" });
      if (config?.error) addMessage("error", config.error);
      else addSystemMessage(`Provider: ${config.provider || "(default)"}\nModel: ${config.model || "hermes-agent"}\nAPI mode: ${config.api_mode || "(default)"}\nBase URL: ${config.base_url || "(provider default)"}`);
      return true;
    }

    case "/tools": {
      if (arg && !["list", "status"].includes(arg.toLowerCase())) {
        addMessage("error", "Usage: /tools [list|status]. Enable/disable is intentionally not exposed from the extension yet.");
        return true;
      }
      const result = await chrome.runtime.sendMessage({ type: "get-tools-summary" });
      if (result?.error) addMessage("error", result.error);
      else addSystemMessage(formatToolsSummary(result));
      return true;
    }

    case "/model":
      return await showOrSetRuntime("model", arg);

    case "/provider":
      return await showOrSetRuntime("provider", arg);

    case "/baseurl":
      return await showOrSetRuntime("baseUrl", arg === "clear" ? "" : arg, true);

    case "/page": {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const ctx = tab ? await getPageContext(tab) : null;
      if (!ctx) addMessage("error", "No active tab context available.");
      else addSystemMessage(`Title: ${ctx.title || ""}\nURL: ${ctx.url || ""}\nText excerpt: ${(ctx.text || "").slice(0, 800)}${ctx.text && ctx.text.length > 800 ? "..." : ""}`);
      return true;
    }

    case "/approve":
    case "/deny": {
      if (!lastApproval) {
        addMessage("error", "No pending command approval has been seen in this panel.");
        return true;
      }
      const approved = command === "/approve";
      const result = await chrome.runtime.sendMessage({ type: "send-approval-decision", approval: lastApproval, approved });
      if (result?.error) addMessage("error", result.error);
      else addSystemMessage(approved ? "Approved latest command request." : "Denied latest command request.");
      return true;
    }

    case "/send":
      userInput.value = arg.startsWith("/") ? "/" + arg : arg;
      if (arg) setTimeout(sendMessage, 0);
      return true;

    default:
      return false;
  }
}

async function showOrSetRuntime(key, value, allowEmpty = false) {
  const config = await chrome.runtime.sendMessage({ type: "get-hermes-config" });
  if (config?.error) {
    addMessage("error", config.error);
    return true;
  }
  if (!value && !allowEmpty) {
    const label = key === "baseUrl" ? "base URL" : key;
    addSystemMessage(`Current ${label}: ${key === "baseUrl" ? (config.base_url || "(provider default)") : (config[key] || "(default)")}`);
    return true;
  }
  const update = {
    provider: key === "provider" ? value : config.provider,
    model: key === "model" ? value : config.model,
    baseUrl: key === "baseUrl" ? value : config.base_url,
  };
  const result = await chrome.runtime.sendMessage({ type: "update-hermes-config", config: update });
  if (result?.error) addMessage("error", result.error);
  else addSystemMessage(`Updated Hermes runtime:\nProvider: ${result.provider || update.provider || "(default)"}\nModel: ${result.model || update.model || "hermes-agent"}\nBase URL: ${result.base_url || update.baseUrl || "(provider default)"}`);
  return true;
}

async function loadSlashCommands() {
  try {
    const result = await chrome.runtime.sendMessage({ type: "get-slash-commands" });
    if (!result?.ok || !Array.isArray(result.commands)) return;
    const localByName = new Map(SLASH_COMMANDS.map(c => [c.name, c]));
    for (const command of result.commands) {
      if (!command?.name) continue;
      const name = command.name.startsWith("/") ? command.name : `/${command.name}`;
      if (localByName.has(name)) {
        localByName.set(name, { ...command, ...localByName.get(name), source: "local" });
      } else {
        localByName.set(name, {
          name,
          usage: command.usage || `${name}${command.args_hint ? ` ${command.args_hint}` : ""}`,
          desc: command.desc || command.description || "Hermes command",
          source: command.source || "hermes",
        });
      }
      for (const alias of command.aliases || []) {
        const aliasName = alias.startsWith("/") ? alias : `/${alias}`;
        if (!localByName.has(aliasName)) {
          localByName.set(aliasName, {
            name: aliasName,
            usage: aliasName,
            desc: `Alias for ${name}`,
            source: command.source || "hermes",
          });
        }
      }
    }
    SLASH_COMMANDS = [...localByName.values()].sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    console.warn("[hermes-chrome] Could not load slash commands", err);
  }
}

function formatToolsSummary(result) {
  const lines = ["Hermes tools/toolsets visible from API config:"];
  lines.push(`API server platform toolsets: ${result.apiServerToolsets?.length ? result.apiServerToolsets.join(", ") : "(default / not explicitly configured)"}`);
  lines.push(`Global toolsets: ${result.globalToolsets?.length ? result.globalToolsets.join(", ") : "(none configured)"}`);
  if (result.mcpServers?.length) lines.push(`MCP servers: ${result.mcpServers.join(", ")}`);
  if (result.disabledTools?.length) lines.push(`Disabled tools: ${result.disabledTools.join(", ")}`);
  if (result.notes?.length) lines.push("\nNotes:\n" + result.notes.map(n => `- ${n}`).join("\n"));
  return lines.join("\n");
}

function addSystemMessage(content) {
  welcomeEl.style.display = "none";
  addMessage("system", content);
}

async function clearConversation() {
  await chrome.runtime.sendMessage({ type: "clear-conversation" });
  messagesEl.innerHTML = "";
  messagesEl.appendChild(welcomeEl);
  welcomeEl.style.display = "flex";
}

function addApprovalCard(approval) {
  lastApproval = approval;
  const div = document.createElement("div");
  const riskClass = String(approval.risk_level || "unknown").toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  div.className = `message approval risk-${riskClass}`;
  const warnings = Array.isArray(approval.warnings) ? approval.warnings : [];
  div.innerHTML = `
    <div class="role">command approval <span class="risk-badge">${escapeHtml(approval.risk_level || "unknown")}</span></div>
    <div><strong>${escapeHtml(approval.message || approval.description || "This command requires approval.")}</strong></div>
    <pre>${escapeHtml(approval.command || "")}</pre>
    ${warnings.length ? `<ul class="approval-warnings">${warnings.map(w => `<li>${escapeHtml(w)}</li>`).join("")}</ul>` : ""}
    <div class="approval-actions">
      <button data-approved="true">Approve</button>
      <button data-approved="false" class="deny">Deny</button>
    </div>
  `;
  div.querySelectorAll("button[data-approved]").forEach(button => {
    button.addEventListener("click", async () => {
      const approved = button.dataset.approved === "true";
      div.querySelectorAll("button").forEach(b => b.disabled = true);
      try {
        const result = await chrome.runtime.sendMessage({
          type: "send-approval-decision",
          approval,
          approved,
        });
        if (result?.error) throw new Error(result.error);
        div.classList.add(approved ? "approved" : "denied");
        div.querySelector(".role").textContent = approved ? "command approved" : "command denied";
      } catch (err) {
        div.querySelector(".role").textContent = "approval failed: " + err.message;
        div.querySelectorAll("button").forEach(b => b.disabled = false);
      }
    });
  });
  messagesEl.appendChild(div);
  scrollToBottom();
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "approval-required") {
    addApprovalCard(msg.approval || {});
  }
});

function ensureCommandPalette() {
  if (commandPalette) return commandPalette;
  commandPalette = document.createElement("div");
  commandPalette.id = "command-palette";
  commandPalette.className = "hidden";
  document.getElementById("input-area").prepend(commandPalette);
  return commandPalette;
}

function updateCommandPalette() {
  const value = userInput.value.trimStart();
  const palette = ensureCommandPalette();
  if (!value.startsWith("/") || value.startsWith("//")) {
    hideCommandPalette();
    return;
  }

  const query = value.split(/\s+/, 1)[0].toLowerCase();
  if (query !== commandPaletteQuery) {
    commandPaletteQuery = query;
    commandPaletteIndex = 0;
    commandPaletteOffset = 0;
  }

  commandPaletteMatches = SLASH_COMMANDS.filter(c => c.name.startsWith(query));
  if (!commandPaletteMatches.length) {
    hideCommandPalette();
    return;
  }

  commandPaletteIndex = Math.max(0, Math.min(commandPaletteIndex, commandPaletteMatches.length - 1));
  renderCommandPalette();
  palette.classList.remove("hidden");
}

function renderCommandPalette() {
  const palette = ensureCommandPalette();
  palette.innerHTML = commandPaletteMatches.map((c, index) => `
    <button class="command-item ${index === commandPaletteIndex ? "selected" : ""}" data-index="${index}" data-command="${escapeHtml(c.name)}" type="button">
      <span class="command-name">${escapeHtml(c.usage)}</span>
      <span class="command-desc">${escapeHtml(c.desc)}${c.source && c.source !== "local" ? ` · ${escapeHtml(c.source)}` : ""}</span>
    </button>
  `).join("");
  palette.querySelectorAll(".command-item").forEach(item => {
    item.addEventListener("click", () => {
      commandPaletteIndex = Number(item.dataset.index || 0);
      userInput.value = item.dataset.command + " ";
      userInput.focus();
      userInput.dispatchEvent(new Event("input"));
    });
  });
}

function selectCommandPaletteItem(delta) {
  if (!commandPalette || commandPalette.classList.contains("hidden")) return false;
  if (!commandPaletteMatches.length) return false;
  commandPaletteIndex = Math.max(0, Math.min(commandPaletteIndex + delta, commandPaletteMatches.length - 1));
  renderCommandPalette();
  commandPalette.querySelector(".command-item.selected")?.scrollIntoView({ block: "nearest" });
  return true;
}

function acceptCommandPaletteItem() {
  if (!commandPalette || commandPalette.classList.contains("hidden")) return false;
  const command = commandPaletteMatches[commandPaletteIndex];
  if (!command) return false;
  userInput.value = command.name + " ";
  userInput.focus();
  userInput.dispatchEvent(new Event("input"));
  return true;
}

function hideCommandPalette() {
  if (commandPalette) commandPalette.classList.add("hidden");
}

function cleanupCommandPalette() {
  if (commandPalette && commandPalette.parentNode) {
    commandPalette.parentNode.removeChild(commandPalette);
  }
  commandPalette = null;
}

btnSend.addEventListener("click", sendMessage);

userInput.addEventListener("keydown", (e) => {
  const paletteOpen = commandPalette && !commandPalette.classList.contains("hidden");
  if (paletteOpen && e.key === "ArrowDown") {
    e.preventDefault();
    selectCommandPaletteItem(1);
    return;
  }
  if (paletteOpen && e.key === "ArrowUp") {
    e.preventDefault();
    selectCommandPaletteItem(-1);
    return;
  }
  if ((e.key === "Tab" || (paletteOpen && e.key === "Enter")) && paletteOpen) {
    e.preventDefault();
    acceptCommandPaletteItem();
    return;
  }
  if (e.key === "Escape") hideCommandPalette();

  if (!paletteOpen && e.altKey && e.key === "ArrowUp") {
    e.preventDefault();
    messagesEl.scrollBy({ top: -120, behavior: "smooth" });
    return;
  }
  if (!paletteOpen && e.altKey && e.key === "ArrowDown") {
    e.preventDefault();
    messagesEl.scrollBy({ top: 120, behavior: "smooth" });
    return;
  }
  if (!paletteOpen && e.key === "PageUp") {
    e.preventDefault();
    messagesEl.scrollBy({ top: -messagesEl.clientHeight * 0.85, behavior: "smooth" });
    return;
  }
  if (!paletteOpen && e.key === "PageDown") {
    e.preventDefault();
    messagesEl.scrollBy({ top: messagesEl.clientHeight * 0.85, behavior: "smooth" });
    return;
  }

  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

userInput.addEventListener("input", () => {
  btnSend.disabled = userInput.value.trim() === "";
  userInput.style.height = "auto";
  userInput.style.height = Math.min(userInput.scrollHeight, 120) + "px";
  updateCommandPalette();
});

btnClear.addEventListener("click", clearConversation);

btnSettings.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

btnToggleContext.addEventListener("click", async () => {
  includeContext = !includeContext;
  btnToggleContext.classList.toggle("active", includeContext);
  btnToggleContext.textContent = includeContext ? "ON" : "OFF";
  await new Promise(resolve => {
    chrome.runtime.sendMessage({ type: "set-option", key: "includePageContext", value: includeContext }, resolve);
  });
});

const style = document.createElement("style");
style.textContent = `@keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }`;
document.head.appendChild(style);

// Cleanup on page unload
window.addEventListener("beforeunload", cleanupCommandPalette);

init();
