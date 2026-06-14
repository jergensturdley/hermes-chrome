// Hermes Chrome — side panel controller.
// Talks to background.js via chrome.runtime.sendMessage. All state is local;
// the background owns Hermes session lifecycle and HTTP I/O.
const messagesEl = document.getElementById("messages");
const welcomeEl = document.getElementById("welcome");
const userInput = document.getElementById("user-input");
const btnSend = document.getElementById("btn-send");
const btnClear = document.getElementById("btn-clear");
const btnSettings = document.getElementById("btn-settings");
const btnToggleContext = document.getElementById("btn-toggle-context");
const pageContextLabel = document.querySelector(".page-context-label");
const pageContextBar = document.getElementById("page-context-bar");
const statusDot = document.getElementById("connection-status");
const connectionBanner = document.getElementById("connection-banner");
const bannerText = document.getElementById("banner-text");
const btnRedetect = document.getElementById("btn-redetect");
const btnOpenSettings = document.getElementById("btn-open-settings");
let state = {};
let includeContext = true;
let isLoading = false;
let lastApproval = null;
let commandPalette = null;
let commandPaletteIndex = 0;
let commandPaletteMatches = [];
let commandPaletteQuery = "";

const SLASH_COMMANDS = [
  { name: "/help", usage: "/help", desc: "Show available slash commands" },
  { name: "/clear", usage: "/clear", desc: "Clear chat and start a fresh Hermes session" },
  { name: "/new", usage: "/new", desc: "Alias for /clear" },
  { name: "/settings", usage: "/settings", desc: "Open extension settings" },
  { name: "/status", usage: "/status", desc: "Check local Hermes gateway status" },
  { name: "/detect", usage: "/detect", desc: "Auto-detect the local Hermes gateway" },
  { name: "/context", usage: "/context on|off|toggle", desc: "Control page context for messages" },
  { name: "/runtime", usage: "/runtime", desc: "Show Hermes provider/model/base URL" },
  { name: "/tools", usage: "/tools [list|status]", desc: "Show Hermes tool/toolset configuration" },
  { name: "/model", usage: "/model [model-id]", desc: "Show or set Hermes model" },
  { name: "/provider", usage: "/provider [provider-id]", desc: "Show or set Hermes provider" },
  { name: "/baseurl", usage: "/baseurl [url|clear]", desc: "Show or set provider base URL" },
  { name: "/page", usage: "/page", desc: "Preview the page context Hermes will receive" },
  { name: "/approve", usage: "/approve", desc: "Approve the latest command approval request" },
  { name: "/deny", usage: "/deny", desc: "Deny the latest command approval request" },
  { name: "/send", usage: "/send /literal text", desc: "Send text beginning with / to Hermes" },
];

function sendMessage(type, payload = {}) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type, ...payload }, response => {
      if (chrome.runtime.lastError) {
        resolve({ error: chrome.runtime.lastError.message });
      } else {
        resolve(response || {});
      }
    });
  });
}

async function init() {
  state = await sendMessage("get-state");
  includeContext = state.includePageContext !== false;
  applyContextToggle();
  applyContextBarVisibility();

  await checkConnection();
  await loadSlashCommands();

  const conv = await sendMessage("get-conversation");
  if (conv.history && conv.history.length > 0) {
    welcomeEl.style.display = "none";
    for (const msg of conv.history) addMessage(msg.role, msg.content, { animate: false });
    scrollToBottom();
  }

  document.querySelectorAll(".quick-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      userInput.value = btn.dataset.msg;
      autoResize();
      sendMessageFromInput();
    });
  });
}
async function checkConnection() {
  statusDot.classList.add("checking");
  statusDot.classList.remove("connected", "disconnected");
  const result = await sendMessage("check-gateway");
  statusDot.classList.remove("checking");
  if (result?.ok && !result.authRequired) {
    setConnection("connected", "Connected to Hermes");
    return;
  }
  if (result?.ok && result.authRequired) {
    // Gateway is up but the bearer token is missing or wrong.
    showBanner(
      `Hermes gateway at ${result.url || state.gatewayUrl} needs an API key.`,
      "auth-needed"
    );
    setConnection("disconnected", "API key required");
    return;
  }
  const detected = await sendMessage("detect-gateway", { apiKey: state.apiKey });
  if (detected?.ok) {
    state.gatewayUrl = detected.selected;
    if (detected.needsApiKey) {
      showBanner(
        `Detected Hermes at ${detected.selected}, but it needs an API key.`,
        "auth-needed"
      );
      setConnection("disconnected", "API key required");
      return;
    }
    setConnection("connected", "Connected: " + detected.selected);
    hideBanner();
    return;
  }
  showBanner(`Disconnected. ${detected?.error || result?.error || "No gateway reachable."}`, "error");
  setConnection("disconnected", detected?.error || result?.error || "Disconnected");
}

function showBanner(message, kind) {
  bannerText.textContent = message;
  connectionBanner.classList.remove("hidden", "auth-needed");
  if (kind === "auth-needed") connectionBanner.classList.add("auth-needed");
}

function hideBanner() {
  connectionBanner.classList.add("hidden");
}

function setConnection(stateName, title) {
  statusDot.classList.remove("connected", "disconnected", "checking");
  statusDot.classList.add(stateName);
  statusDot.title = title;
  statusDot.setAttribute("aria-label", title);
}

async function sendMessageFromInput() {
  let text = userInput.value.trim();
  if (!text || isLoading) return;

  if (text.startsWith("/") && !text.startsWith("//")) {
    const handled = await handleSlashCommand(text);
    if (handled) {
      userInput.value = "";
      autoResize();
      btnSend.disabled = true;
      hideCommandPalette();
      return;
    }
  }
  if (text.startsWith("//")) text = text.slice(1);

  isLoading = true;
  btnSend.disabled = true;
  userInput.value = "";
  autoResize();
  hideCommandPalette();

  welcomeEl.style.display = "none";

  addMessage("user", text);
  scrollToBottom();

  const typingEl = showTyping();
  scrollToBottom();

  let pageContext = null;
  if (includeContext) {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) pageContext = await getPageContext(tab);
    } catch {
      // Page context is best-effort; proceed without it.
    }
  }

  const result = await sendMessage("send-to-hermes", { message: text, pageContext });
  typingEl.remove();

  if (result?.error) {
    addMessage("error", "Failed to reach Hermes: " + result.error);
    if (/returned 401|returned 403|Unauthorized|Forbidden/i.test(result.error)) {
      showBanner("Hermes gateway needs an API key. Open Settings to add one.", "auth-needed");
    } else {
      checkConnection();
    }
  } else {
    addMessage("assistant", result.response);
  }

  isLoading = false;
  btnSend.disabled = userInput.value.trim() === "";
  scrollToBottom();
}

function addMessage(role, content, { animate = true } = {}) {
  const div = document.createElement("div");
  div.className = `message ${role}`;
  if (animate) div.classList.add("message-enter");

  const roleEl = document.createElement("div");
  roleEl.className = "role";
  roleEl.textContent = role;
  div.appendChild(roleEl);

  const body = document.createElement("div");
  body.className = "body";
  body.textContent = content;
  div.appendChild(body);

  if (role === "assistant" || role === "system") {
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "copy-btn";
    copyBtn.setAttribute("aria-label", "Copy message");
    copyBtn.innerHTML = COPY_ICON;
    copyBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(content);
        copyBtn.classList.add("copied");
        copyBtn.innerHTML = CHECK_ICON;
        setTimeout(() => {
          copyBtn.classList.remove("copied");
          copyBtn.innerHTML = COPY_ICON;
        }, 1400);
      } catch {
        // Clipboard unavailable; nothing to do.
      }
    });
    div.appendChild(copyBtn);
  }

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
  requestAnimationFrame(() => {
    messagesEl.scrollTo({
      top: messagesEl.scrollHeight,
      behavior: isLoading ? "auto" : "smooth",
    });
  });
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

async function handleSlashCommand(input) {
  const [rawCommand, ...rest] = input.split(/\s+/);
  const command = rawCommand.toLowerCase();
  const arg = rest.join(" ").trim();

  switch (command) {
    case "/help":
      addSystemMessage(SLASH_COMMANDS.map(c => `${c.usage} — ${c.desc}`).join("\n"));
      return true;

    case "/clear":
    case "/new":
      await clearConversation();
      addSystemMessage("Started a fresh Hermes Chrome session.");
      return true;

    case "/settings":
      chrome.runtime.openOptionsPage();
      addSystemMessage("Opened settings.");
      return true;

    case "/status": {
      const result = await sendMessage("check-gateway");
      if (result?.ok) {
        addSystemMessage(`Hermes gateway connected at ${result.url || state.gatewayUrl} via ${result.path || "health check"}.`);
      } else {
        addMessage("error", `Gateway disconnected: ${result?.error || "unknown error"}`);
      }
      return true;
    }

    case "/detect": {
      addSystemMessage("Scanning localhost for Hermes gateway...");
      const result = await sendMessage("detect-gateway", { apiKey: state.apiKey });
      if (result?.ok) {
        state.gatewayUrl = result.selected;
        const note = result.needsApiKey ? " (needs API key)" : "";
        addSystemMessage(`Detected Hermes gateway: ${result.selected}${note}`);
        if (!result.needsApiKey) await checkConnection();
        else showBanner(`Detected Hermes at ${result.selected}, but it needs an API key.`, "auth-needed");
      } else {
        addMessage("error", `Auto-detect failed: ${result?.error || "not found"}`);
      }
      return true;
    }

    case "/context": {
      const mode = arg.toLowerCase();
      if (!["on", "off", "toggle", ""].includes(mode)) {
        addMessage("error", "Usage: /context on|off|toggle");
        return true;
      }
      includeContext = mode === "on" ? true : mode === "off" ? false : !includeContext;
      applyContextToggle();
      applyContextBarVisibility();
      await sendMessage("set-option", { key: "includePageContext", value: includeContext });
      addSystemMessage(`Page context is now ${includeContext ? "ON" : "OFF"}.`);
      return true;
    }

    case "/runtime": {
      const config = await sendMessage("get-hermes-config");
      if (config?.error) addMessage("error", config.error);
      else {
        addSystemMessage(
          `Provider: ${config.provider || "(default)"}\n` +
          `Model: ${config.model || "hermes-agent"}\n` +
          `API mode: ${config.api_mode || "(default)"}\n` +
          `Base URL: ${config.base_url || "(provider default)"}`
        );
      }
      return true;
    }

    case "/tools": {
      if (arg && !["list", "status"].includes(arg.toLowerCase())) {
        addMessage("error", "Usage: /tools [list|status]. Enable/disable is intentionally not exposed from the extension yet.");
        return true;
      }
      const result = await sendMessage("get-tools-summary");
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
      else {
        const excerpt = (ctx.text || "").slice(0, 800) + (ctx.text && ctx.text.length > 800 ? "..." : "");
        addSystemMessage(`Title: ${ctx.title || ""}\nURL: ${ctx.url || ""}\nText excerpt: ${excerpt}`);
      }
      return true;
    }

    case "/approve":
    case "/deny": {
      if (!lastApproval) {
        addMessage("error", "No pending command approval has been seen in this panel.");
        return true;
      }
      const approved = command === "/approve";
      const result = await sendMessage("send-approval-decision", { approval: lastApproval, approved });
      if (result?.error) addMessage("error", result.error);
      else addSystemMessage(approved ? "Approved latest command request." : "Denied latest command request.");
      return true;
    }

    case "/send":
      if (arg) {
        userInput.value = arg.startsWith("/") ? "/" + arg : arg;
        autoResize();
        setTimeout(() => sendMessageFromInput(), 0);
      }
      return true;

    default:
      return false;
  }
}

async function showOrSetRuntime(key, value, allowEmpty = false) {
  const config = await sendMessage("get-hermes-config");
  if (config?.error) {
    addMessage("error", config.error);
    return true;
  }
  if (!value && !allowEmpty) {
    const label = key === "baseUrl" ? "base URL" : key;
    const current = key === "baseUrl" ? (config.base_url || "(provider default)") : (config[key] || "(default)");
    addSystemMessage(`Current ${label}: ${current}`);
    return true;
  }
  const update = {
    provider: key === "provider" ? value : config.provider,
    model: key === "model" ? value : config.model,
    baseUrl: key === "baseUrl" ? value : config.base_url,
  };
  const result = await sendMessage("update-hermes-config", { config: update });
  if (result?.error) {
    addMessage("error", result.error);
  } else {
    addSystemMessage(
      `Updated Hermes runtime:\n` +
      `Provider: ${result.provider || update.provider || "(default)"}\n` +
      `Model: ${result.model || update.model || "hermes-agent"}\n` +
      `Base URL: ${result.base_url || update.baseUrl || "(provider default)"}`
    );
  }
  return true;
}

async function loadSlashCommands() {
  try {
    const result = await sendMessage("get-slash-commands");
    if (!result?.ok || !Array.isArray(result.commands)) return;
    const byName = new Map(SLASH_COMMANDS.map(c => [c.name, c]));
    for (const command of result.commands) {
      if (!command?.name) continue;
      const name = command.name.startsWith("/") ? command.name : `/${command.name}`;
      if (byName.has(name)) {
        byName.set(name, { ...command, ...byName.get(name), source: "local" });
      } else {
        byName.set(name, {
          name,
          usage: command.usage || `${name}${command.args_hint ? ` ${command.args_hint}` : ""}`,
          desc: command.desc || command.description || "Hermes command",
          source: command.source || "hermes",
        });
      }
    }
    SLASH_COMMANDS.length = 0;
    for (const c of byName.values()) SLASH_COMMANDS.push(c);
    SLASH_COMMANDS.sort((a, b) => a.name.localeCompare(b.name));
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
  await sendMessage("clear-conversation");
  messagesEl.innerHTML = "";
  messagesEl.appendChild(welcomeEl);
  welcomeEl.style.display = "flex";
  lastApproval = null;
}

function applyContextToggle() {
  btnToggleContext.classList.toggle("active", includeContext);
  btnToggleContext.textContent = includeContext ? "On" : "Off";
  btnToggleContext.setAttribute("aria-pressed", includeContext ? "true" : "false");
  if (pageContextLabel) {
    pageContextLabel.textContent = includeContext ? "Page context on" : "Page context off";
  }
}

function applyContextBarVisibility() {
  // Bar is always rendered so the toggle is discoverable; it just gets
  // different label/active state.
  pageContextBar.classList.remove("hidden");
}

function addApprovalCard(approval) {
  lastApproval = approval;
  const div = document.createElement("div");
  const riskClass = String(approval.risk_level || "unknown").toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  div.className = `message approval risk-${riskClass}`;

  const role = document.createElement("div");
  role.className = "role";
  role.textContent = "Command approval";
  const badge = document.createElement("span");
  badge.className = "risk-badge";
  badge.textContent = approval.risk_level || "unknown";
  role.appendChild(document.createTextNode(" "));
  role.appendChild(badge);
  div.appendChild(role);

  const summary = document.createElement("div");
  summary.className = "body";

  const heading = document.createElement("strong");
  heading.textContent = approval.message || approval.description || "This command requires approval.";
  summary.appendChild(heading);

  const pre = document.createElement("pre");
  pre.textContent = approval.command || "";
  summary.appendChild(pre);

  const warnings = Array.isArray(approval.warnings) ? approval.warnings : [];
  if (warnings.length) {
    const ul = document.createElement("ul");
    ul.className = "approval-warnings";
    for (const w of warnings) {
      const li = document.createElement("li");
      li.textContent = w;
      ul.appendChild(li);
    }
    summary.appendChild(ul);
  }

  const actions = document.createElement("div");
  actions.className = "approval-actions";
  const approveBtn = document.createElement("button");
  approveBtn.type = "button";
  approveBtn.dataset.approved = "true";
  approveBtn.className = "btn-approve";
  approveBtn.textContent = "Approve";
  const denyBtn = document.createElement("button");
  denyBtn.type = "button";
  denyBtn.dataset.approved = "false";
  denyBtn.className = "btn-deny";
  denyBtn.textContent = "Deny";
  actions.appendChild(approveBtn);
  actions.appendChild(denyBtn);
  summary.appendChild(actions);
  div.appendChild(summary);

  const handleDecision = async (approved) => {
    approveBtn.disabled = denyBtn.disabled = true;
    try {
      const result = await sendMessage("send-approval-decision", { approval, approved });
      if (result?.error) throw new Error(result.error);
      div.classList.add(approved ? "approved" : "denied");
      role.firstChild.textContent = approved ? "Command approved" : "Command denied";
    } catch (err) {
      role.firstChild.textContent = "Approval failed: " + err.message;
      approveBtn.disabled = denyBtn.disabled = false;
    }
  };
  approveBtn.addEventListener("click", () => handleDecision(true));
  denyBtn.addEventListener("click", () => handleDecision(false));

  messagesEl.appendChild(div);
  scrollToBottom();
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "approval-required") {
    addApprovalCard(msg.approval || {});
  } else if (msg?.type === "tool-event") {
    addToolEvent(msg.event, msg.payload);
  }
});

function addToolEvent(eventName, payload) {
  const div = document.createElement("div");
  div.className = "message tool-event";

  const role = document.createElement("div");
  role.className = "role";
  role.textContent = "Tool";
  div.appendChild(role);

  const body = document.createElement("div");
  body.className = "body";

  const status = eventName === "tool.started" ? "started"
    : eventName === "tool.progress" ? "in progress"
    : "completed";
  const toolName = payload?.name || payload?.tool || "";
  body.textContent = toolName ? `${toolName}: ${status}` : status;

  div.appendChild(body);
  messagesEl.appendChild(div);
  scrollToBottom();
}

const COPY_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const CHECK_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';

function ensureCommandPalette() {
  if (commandPalette) return commandPalette;
  commandPalette = document.createElement("div");
  commandPalette.id = "command-palette";
  commandPalette.className = "hidden";
  commandPalette.setAttribute("role", "listbox");
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
  palette.innerHTML = "";
  for (let index = 0; index < commandPaletteMatches.length; index++) {
    const c = commandPaletteMatches[index];
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "command-item" + (index === commandPaletteIndex ? " selected" : "");
    btn.setAttribute("role", "option");
    btn.setAttribute("aria-selected", index === commandPaletteIndex ? "true" : "false");
    btn.dataset.index = String(index);
    btn.dataset.command = c.name;

    const name = document.createElement("span");
    name.className = "command-name";
    name.textContent = c.usage;
    const desc = document.createElement("span");
    desc.className = "command-desc";
    desc.textContent = c.desc + (c.source && c.source !== "local" ? ` · ${c.source}` : "");

    btn.appendChild(name);
    btn.appendChild(desc);
    btn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      commandPaletteIndex = Number(btn.dataset.index || 0);
      userInput.value = btn.dataset.command + " ";
      userInput.focus();
      autoResize();
      updateCommandPalette();
    });
    palette.appendChild(btn);
  }
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
  autoResize();
  updateCommandPalette();
  return true;
}

function hideCommandPalette() {
  if (commandPalette) commandPalette.classList.add("hidden");
}

function autoResize() {
  userInput.style.height = "auto";
  userInput.style.height = Math.min(userInput.scrollHeight, 160) + "px";
  btnSend.disabled = userInput.value.trim() === "" || isLoading;
}

btnSend.addEventListener("click", sendMessageFromInput);

userInput.addEventListener("keydown", (e) => {
  const paletteOpen = commandPalette && !commandPalette.classList.contains("hidden");
  if (paletteOpen && e.key === "ArrowDown") { e.preventDefault(); selectCommandPaletteItem(1); return; }
  if (paletteOpen && e.key === "ArrowUp") { e.preventDefault(); selectCommandPaletteItem(-1); return; }
  if (paletteOpen && (e.key === "Tab" || e.key === "Enter")) {
    e.preventDefault();
    if (e.key === "Tab" || !userInput.value.includes(" ")) {
      acceptCommandPaletteItem();
    } else {
      sendMessageFromInput();
    }
    return;
  }
  if (e.key === "Escape") hideCommandPalette();

  if (!paletteOpen && e.altKey && e.key === "ArrowUp") { e.preventDefault(); messagesEl.scrollBy({ top: -120, behavior: "smooth" }); return; }
  if (!paletteOpen && e.altKey && e.key === "ArrowDown") { e.preventDefault(); messagesEl.scrollBy({ top: 120, behavior: "smooth" }); return; }
  if (!paletteOpen && e.key === "PageUp") { e.preventDefault(); messagesEl.scrollBy({ top: -messagesEl.clientHeight * 0.85, behavior: "smooth" }); return; }
  if (!paletteOpen && e.key === "PageDown") { e.preventDefault(); messagesEl.scrollBy({ top: messagesEl.clientHeight * 0.85, behavior: "smooth" }); return; }

  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessageFromInput(); }
});

userInput.addEventListener("input", () => {
  autoResize();
  updateCommandPalette();
});

userInput.addEventListener("blur", () => setTimeout(hideCommandPalette, 120));

btnClear.addEventListener("click", clearConversation);

btnSettings.addEventListener("click", () => chrome.runtime.openOptionsPage());

btnOpenSettings?.addEventListener("click", () => chrome.runtime.openOptionsPage());
btnRedetect?.addEventListener("click", async () => {
  btnRedetect.disabled = true;
  const prev = btnRedetect.textContent;
  btnRedetect.textContent = "Scanning…";
  try {
    const detected = await sendMessage("detect-gateway", { apiKey: state.apiKey });
    if (detected?.ok) {
      state.gatewayUrl = detected.selected;
      if (detected.needsApiKey) {
        showBanner(`Detected Hermes at ${detected.selected}, but it needs an API key.`, "auth-needed");
        setConnection("disconnected", "API key required");
      } else {
        hideBanner();
        setConnection("connected", "Connected: " + detected.selected);
      }
    } else {
      showBanner(`Disconnected. ${detected?.error || "No gateway reachable."}`, "error");
      setConnection("disconnected", "Disconnected");
    }
  } finally {
    btnRedetect.disabled = false;
    btnRedetect.textContent = prev;
  }
});

btnToggleContext.addEventListener("click", async () => {
  includeContext = !includeContext;
  applyContextToggle();
  applyContextBarVisibility();
  await sendMessage("set-option", { key: "includePageContext", value: includeContext });
});

init();
