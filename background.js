const DEFAULTS = {
  gatewayUrl: "http://127.0.0.1:8642",
  apiKey: "",
  includePageContext: true,
  streamResponses: false,
  conversationHistory: [],
  maxHistory: 50,
  model: "hermes-agent",
  provider: "",
  baseUrl: "",
  useSessionApi: true,
  currentSessionId: "",
  systemPrompt: "You are Hermes Agent, a helpful local AI assistant. Be concise, accurate, and technical.",
};

const GATEWAY_CANDIDATES = [
  "http://127.0.0.1:8642",
  "http://localhost:8642",
  "http://127.0.0.1:9119",
  "http://localhost:9119",
  "http://127.0.0.1:8000",
  "http://localhost:8000",
  "http://127.0.0.1:8080",
  "http://localhost:8080",
];

const HEALTH_PATHS = ["/health", "/api/health", "/v1/models"];

const HERMES_BUILTIN_SLASH_COMMANDS = [
  ["new", "Start a new session"], ["reset", "Alias for /new"], ["retry", "Retry the last message"],
  ["undo", "Remove the last exchange"], ["title", "Set a session title", "[name]"],
  ["branch", "Branch/fork the current session", "[name]"], ["fork", "Alias for /branch"],
  ["compress", "Compress conversation context", "[focus topic]"], ["rollback", "List/restore checkpoints", "[number]"],
  ["snapshot", "Create/restore state snapshots", "[create|restore <id>|prune]"], ["stop", "Stop running background processes"],
  ["approve", "Approve a pending dangerous command", "[session|always]"], ["deny", "Deny a pending dangerous command"],
  ["background", "Run a prompt in the background", "<prompt>"], ["bg", "Alias for /background", "<prompt>"],
  ["btw", "Ephemeral side question", "<question>"], ["queue", "Queue a prompt", "<prompt>"], ["q", "Alias for /queue", "<prompt>"],
  ["status", "Show session status"], ["profile", "Show active profile"], ["sethome", "Set this chat as home channel"],
  ["set-home", "Alias for /sethome"], ["sessions", "Browse recent sessions"], ["ss", "Alias for /sessions"],
  ["resume", "Resume a named session", "[name]"], ["continue", "Resume the most recent session"], ["c", "Alias for /continue"],
  ["model", "Switch/show model", "[model] [--global]"], ["provider", "Show/switch provider"],
  ["personality", "Set personality", "[name]"], ["yolo", "Toggle YOLO approvals bypass"],
  ["reasoning", "Manage reasoning effort", "[level|show|hide]"], ["fast", "Toggle fast mode", "[normal|fast|status]"],
  ["voice", "Toggle voice mode", "[on|off|tts|status]"], ["reload", "Reload .env variables"],
  ["reload-mcp", "Reload MCP servers"], ["reload_mcp", "Alias for /reload-mcp"],
  ["commands", "Browse all commands", "[page]"], ["help", "Show help"], ["restart", "Restart gateway"],
  ["usage", "Show token usage/rate limits"], ["insights", "Show usage insights", "[days]"],
  ["update", "Update Hermes Agent"], ["debug", "Upload debug report"],
].map(([name, description, args_hint = ""]) => ({
  name: `/${name}`,
  usage: `/${name}${args_hint ? ` ${args_hint}` : ""}`,
  desc: description,
  source: "hermes",
}));

chrome.runtime.onInstalled.addListener(async () => {
  await installLocalOriginStripRules();
  const existing = await chrome.storage.local.get(Object.keys(DEFAULTS));
  const missing = Object.fromEntries(
    Object.entries(DEFAULTS).filter(([key]) => existing[key] === undefined)
  );
  if (Object.keys(missing).length) {
    await chrome.storage.local.set(missing);
  }
  chrome.runtime.openOptionsPage();
  console.log("[hermes-chrome] Installed/updated");
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case "get-state":
        return await getState();

      case "set-gateway-url":
        await chrome.storage.local.set({ gatewayUrl: normalizeBaseUrl(msg.url) });
        return { ok: true };

      case "set-option":
        await chrome.storage.local.set({ [msg.key]: msg.value });
        return { ok: true };

      case "get-conversation": {
        const { conversationHistory } = await getState();
        return { history: conversationHistory };
      }

      case "clear-conversation":
        await chrome.storage.local.set({ conversationHistory: [], currentSessionId: "" });
        return { ok: true };

      case "check-gateway": {
        const state = await getState();
        return await checkGateway(state.gatewayUrl, state.apiKey);
      }

      case "detect-gateway":
        return await detectGateway(msg.candidates, msg.apiKey);

      case "get-hermes-config": {
        const state = await getState();
        return await getHermesConfig(state);
      }

      case "get-available-models": {
        const state = await getState();
        return await getAvailableModels(state, msg.provider);
      }

      case "get-slash-commands": {
        const state = await getState();
        return await getSlashCommands(state);
      }

      case "get-tools-summary": {
        const state = await getState();
        return await getToolsSummary(state);
      }

      case "update-hermes-config": {
        const state = await getState();
        return await updateHermesConfig(state, msg.config || {});
      }

      case "send-approval-decision": {
        const state = await getState();
        return await sendApprovalDecision(state, msg.approval || {}, msg.approved === true);
      }

      case "send-to-hermes": {
        const state = await getState();
        return await sendToHermes(state, msg.message, msg.pageContext);
      }

      default:
        return { error: "Unknown message type: " + msg.type };
    }
  })()
    .then(sendResponse)
    .catch(err => sendResponse({ error: err.message || String(err) }));

  return true;
});

chrome.runtime.onStartup?.addListener(() => {
  installLocalOriginStripRules().catch(err => console.warn("[hermes-chrome] Could not install DNR rules", err));
});

chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

installLocalOriginStripRules().catch(err => console.warn("[hermes-chrome] Could not install DNR rules", err));

async function installLocalOriginStripRules() {
  // Strip extension Origin for loopback Hermes requests; Hermes blocks browser origins unless CORS is configured.
  if (!chrome.declarativeNetRequest?.updateDynamicRules) return;

  const ruleIds = [864201, 864202];
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: ruleIds,
    addRules: [
      {
        id: 864201,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [{ header: "origin", operation: "remove" }],
        },
        condition: {
          regexFilter: "^http://127\\.0\\.0\\.1(:[0-9]+)?/",
          resourceTypes: ["xmlhttprequest"],
        },
      },
      {
        id: 864202,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [{ header: "origin", operation: "remove" }],
        },
        condition: {
          regexFilter: "^http://localhost(:[0-9]+)?/",
          resourceTypes: ["xmlhttprequest"],
        },
      },
    ],
  });
}

async function getState() {
  const data = await chrome.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...data };
}

function normalizeBaseUrl(url) {
  return (url || DEFAULTS.gatewayUrl).trim().replace(/\/+$/, "");
}

function authHeaders(apiKey = "") {
  const headers = { "Content-Type": "application/json" };
  const token = String(apiKey || "").trim();
  if (token && !/^optional/i.test(token) && !/^change-me/i.test(token)) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function fetchJson(url, options = {}, timeoutMs = 2500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    const text = await resp.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { text }; }
    return { resp, data };
  } finally {
    clearTimeout(timer);
  }
}

async function checkGateway(url, apiKey = "") {
  const baseUrl = normalizeBaseUrl(url);
  const errors = [];

  for (const path of HEALTH_PATHS) {
    try {
      const { resp, data } = await fetchJson(baseUrl + path, {
        method: "GET",
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      });

      if (resp.ok) {
        return {
          ok: true,
          url: baseUrl,
          path,
          status: data?.status || data?.object || "ok",
          data,
        };
      }
      errors.push(`${path}: HTTP ${resp.status}`);
    } catch (err) {
      errors.push(`${path}: ${err.message}`);
    }
  }

  return { ok: false, url: baseUrl, error: errors.join("; ") || "No health endpoint responded" };
}

async function detectGateway(extraCandidates = [], apiKey = "") {
  const candidates = [...new Set([...(extraCandidates || []), ...GATEWAY_CANDIDATES].map(normalizeBaseUrl))];
  const results = await Promise.all(candidates.map(async (url) => {
    const result = await checkGateway(url, apiKey);
    return { url, ...result };
  }));

  const found = results.find(result => result.ok && looksLikeHermes(result));
    
  if (found) {
    await chrome.storage.local.set({ gatewayUrl: found.url });
    return { ok: true, selected: found.url, result: found, results };
  }

  const anyHealthy = results.find(result => result.ok);
  if (anyHealthy) {
    await chrome.storage.local.set({ gatewayUrl: anyHealthy.url });
    return { ok: true, selected: anyHealthy.url, result: anyHealthy, results, warning: "Healthy local API found, but Hermes identity was not confirmed." };
  }

  return { ok: false, error: "No local Hermes gateway found", results };
}

function looksLikeHermes(result) {
  const blob = JSON.stringify(result.data || {}).toLowerCase();
  return result.url.includes(":8642") || blob.includes("hermes") || blob.includes("hermes-agent");
}

async function gatewayGet(state, path) {
  const { resp, data } = await fetchJson(`${normalizeBaseUrl(state.gatewayUrl)}${path}`, {
    method: "GET",
    headers: authHeaders(state.apiKey),
  }, 7000);
  if (!resp.ok) throw new Error(`Gateway returned ${resp.status}: ${JSON.stringify(data)}`);
  return data;
}

async function gatewayJson(state, path, method, body) {
  const { resp, data } = await fetchJson(`${normalizeBaseUrl(state.gatewayUrl)}${path}`, {
    method,
    headers: authHeaders(state.apiKey),
    body: body === undefined ? undefined : JSON.stringify(body),
  }, 15000);
  if (!resp.ok) throw new Error(`Gateway returned ${resp.status}: ${JSON.stringify(data)}`);
  return data;
}

async function getHermesConfig(state) {
  const data = await gatewayGet(state, "/api/config");
  await chrome.storage.local.set({
    model: data.model || state.model,
    provider: data.provider || state.provider || "",
    baseUrl: data.base_url || state.baseUrl || "",
  });
  return data;
}

async function getAvailableModels(state, provider) {
  const qs = provider ? `?provider=${encodeURIComponent(provider)}` : "";
  return await gatewayGet(state, `/api/available-models${qs}`);
}

async function getSlashCommands(state) {
  const byName = new Map(HERMES_BUILTIN_SLASH_COMMANDS.map(c => [c.name, c]));

  try {
    const cfg = await gatewayGet(state, "/api/config");
    const quick = cfg?.config?.quick_commands || {};
    if (quick && typeof quick === "object") {
      for (const [name, value] of Object.entries(quick)) {
        const slash = name.startsWith("/") ? name : `/${name}`;
        byName.set(slash, {
          name: slash,
          usage: slash,
          desc: typeof value === "string" ? value.slice(0, 90) : "User quick command",
          source: "quick_command",
        });
      }
    }
  } catch (err) {
    console.warn("[hermes-chrome] Could not load quick commands", err);
  }

  try {
    const skills = await gatewayGet(state, "/api/skills");
    const items = skills?.items || skills?.skills || [];
    for (const skill of items) {
      const candidates = [];
      if (Array.isArray(skill.commands)) candidates.push(...skill.commands);
      if (Array.isArray(skill.slash_commands)) candidates.push(...skill.slash_commands);
      if (skill.command) candidates.push(skill.command);
      for (const item of candidates) {
        const raw = typeof item === "string" ? { name: item } : item;
        if (!raw?.name) continue;
        const slash = raw.name.startsWith("/") ? raw.name : `/${raw.name}`;
        byName.set(slash, {
          name: slash,
          usage: raw.usage || `${slash}${raw.args_hint ? ` ${raw.args_hint}` : ""}`,
          desc: raw.description || raw.desc || skill.description || `Skill: ${skill.name || slash}`,
          source: "skill",
        });
      }
    }
  } catch (err) {
    console.warn("[hermes-chrome] Could not load skill commands", err);
  }

  return { ok: true, commands: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}

async function getToolsSummary(state) {
  const data = await gatewayGet(state, "/api/config");
  const config = data?.config || {};
  const platformToolsets = config.platform_toolsets || config.platform_tools || {};
  const apiServerToolsets = platformToolsets.api_server || platformToolsets.apiServer || [];
  const mcpServers = config.mcp_servers && typeof config.mcp_servers === "object"
    ? Object.keys(config.mcp_servers)
    : [];
  const disabledTools = config.disabled_tools || config.tools_disabled || [];
  return {
    ok: true,
    globalToolsets: Array.isArray(config.toolsets) ? config.toolsets : [],
    apiServerToolsets: Array.isArray(apiServerToolsets) ? apiServerToolsets : [],
    mcpServers,
    disabledTools: Array.isArray(disabledTools) ? disabledTools : [],
    notes: [
      "Hermes does not currently expose the full CLI /tools manager through the API server, so this extension shows the tool configuration available from /api/config.",
      "Use the Hermes CLI for enable/disable/configure operations: hermes tools",
    ],
  };
}

async function updateHermesConfig(state, config) {
  const body = {
    provider: config.provider || undefined,
    model: config.model || undefined,
    base_url: config.baseUrl ?? config.base_url,
  };
  const data = await gatewayJson(state, "/api/config", "PATCH", body);
  await chrome.storage.local.set({
    provider: data.provider || body.provider || "",
    model: data.model || body.model || state.model,
    baseUrl: data.base_url || data.baseUrl || body.base_url || "",
  });
  return data;
}

async function sendToHermes(state, message, pageContext) {
  if (state.useSessionApi !== false) {
    try {
      return await sendToHermesSession(state, message, pageContext);
    } catch (err) {
      console.warn("[hermes-chrome] Session API failed; falling back to chat completions", err);
    }
  }

  const baseUrl = normalizeBaseUrl(state.gatewayUrl);
  const endpoint = `${baseUrl}/v1/chat/completions`;

  const messages = [];
  if (state.systemPrompt) messages.push({ role: "system", content: state.systemPrompt });

  for (const item of (state.conversationHistory || []).slice(-state.maxHistory)) {
    if (item?.role && item?.content) messages.push({ role: item.role, content: item.content });
  }

  const content = pageContext
    ? `${message}\n\n---\nBrowser context:\n${formatPageContext(pageContext)}`
    : message;
  messages.push({ role: "user", content });

  const payload = {
    model: state.model || DEFAULTS.model,
    messages,
    stream: !!state.streamResponses,
  };

  let resp = await postChat(endpoint, payload, state.apiKey);

  if ((resp.status === 401 || resp.status === 403) && String(state.apiKey || "").trim()) {
    console.warn("[hermes-chrome] Authenticated request was rejected; retrying without bearer token");
    resp = await postChat(endpoint, payload, "");
    if (resp.ok) {
      await chrome.storage.local.set({ apiKey: "" });
    }
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    const authHint = resp.status === 401 || resp.status === 403
      ? ` Check Options → API key; clear it unless Hermes API_SERVER_KEY is configured. If the key is blank, reload the extension so it can install its local Origin-stripping rule, or add this extension origin to API_SERVER_CORS_ORIGINS and restart Hermes: ${chrome.runtime.getURL("").replace(/\/$/, "")}`
      : "";
    throw new Error(`Gateway returned ${resp.status}: ${body || resp.statusText}.${authHint}`);
  }

  let responseText = "";
  let raw = null;
  const contentType = resp.headers.get("content-type") || "";

  if (payload.stream || contentType.includes("text/event-stream")) {
    responseText = await readOpenAIStream(resp);
    raw = { streamed: true };
  } else {
    raw = await resp.json();
    responseText = raw?.choices?.[0]?.message?.content
      || raw?.output_text
      || raw?.response
      || raw?.message
      || raw?.content
      || "";
  }

  const newHistory = [
    ...(state.conversationHistory || []).slice(-(state.maxHistory - 2)),
    { role: "user", content: message },
    { role: "assistant", content: responseText || "No response body" },
  ];

  await chrome.storage.local.set({ conversationHistory: newHistory });
  return { response: responseText, raw };
}

async function sendToHermesSession(state, message, pageContext) {
  let sessionId = state.currentSessionId;
  if (!sessionId) {
    const created = await gatewayJson(state, "/api/sessions", "POST", {
      title: "Hermes Chrome",
      source: "chrome_extension",
      model: state.model || "hermes-agent",
      system_prompt: state.systemPrompt || "",
    });
    sessionId = created?.session?.id || created?.session?.session_id;
    if (!sessionId) throw new Error("Session API did not return a session id");
    await chrome.storage.local.set({ currentSessionId: sessionId });
  }

  const content = pageContext
    ? `${message}\n\n---\nBrowser context:\n${formatPageContext(pageContext)}`
    : message;

  const data = await postSessionChatStream(state, sessionId, {
    message: content,
    model: state.model || "hermes-agent",
    system_message: state.systemPrompt || undefined,
  });

  const responseText = data.final_response || data.response || data.content || "";
  const newHistory = [
    ...(state.conversationHistory || []).slice(-(state.maxHistory - 2)),
    { role: "user", content: message },
    { role: "assistant", content: responseText || "No response body" },
  ];
  await chrome.storage.local.set({ conversationHistory: newHistory, currentSessionId: sessionId });
  return { response: responseText, raw: data, sessionId };
}

async function sendApprovalDecision(state, approval, approved) {
  const message = approved
    ? { type: "command_approved", command: approval.command || "" }
    : { type: "command_denied" };
  return await sendToHermes(state, JSON.stringify(message), null);
}

async function postSessionChatStream(state, sessionId, payload) {
  const endpoint = `${normalizeBaseUrl(state.gatewayUrl)}/api/sessions/${encodeURIComponent(sessionId)}/chat/stream`;
  const resp = await postChat(endpoint, payload, state.apiKey);
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Gateway returned ${resp.status}: ${body || resp.statusText}`);
  }
  return await readHermesSessionStream(resp);
}

async function readHermesSessionStream(resp) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let final = { content: "", final_response: "", events: [] };

  const handleEvent = (name, data) => {
    final.events.push({ event: name, data });
    const eventApproval = extractCommandApproval(data);
    if (eventApproval) {
      chrome.runtime.sendMessage({ type: "approval-required", approval: eventApproval }).catch(() => {});
    }
    if (name === "assistant.delta") {
      final.content += data.delta || "";
    } else if (name === "assistant.completed") {
      final.final_response = data.content || final.content;
      final.completed = data.completed;
      final.partial = data.partial;
      final.interrupted = data.interrupted;
      const contentApproval = extractCommandApproval(final.final_response);
      if (contentApproval) {
        chrome.runtime.sendMessage({ type: "approval-required", approval: contentApproval }).catch(() => {});
      }
    } else if (name === "approval.required") {
      chrome.runtime.sendMessage({ type: "approval-required", approval: data }).catch(() => {});
    } else if (name === "tool.started" || name === "tool.progress" || name === "tool.completed") {
      chrome.runtime.sendMessage({ type: "tool-event", event: name, payload: data }).catch(() => {});
    }
  };

  const consumeFrame = (frame) => {
    let eventName = "message";
    const dataLines = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) return;
    try {
      handleEvent(eventName, JSON.parse(dataLines.join("\n")));
    } catch {
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() || "";
    frames.forEach(consumeFrame);
  }
  if (buffer.trim()) consumeFrame(buffer);
  if (!final.final_response) final.final_response = final.content;
  return final;
}

async function postChat(endpoint, payload, apiKey) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  try {
    return await fetch(endpoint, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function extractCommandApproval(value) {
  let obj = value;
  if (typeof value === "string") {
    let text = value.trim();
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced) text = fenced[1].trim();
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first >= 0 && last > first) text = text.slice(first, last + 1);
    try { obj = JSON.parse(text); } catch { return null; }
  }
  if (!obj || typeof obj !== "object") return null;
  if (obj.type !== "command_approval" && obj.requires_approval !== true) return null;
  return {
    type: "command_approval",
    command: obj.command || "",
    risk_level: obj.risk_level || obj.risk || "unknown",
    warnings: Array.isArray(obj.warnings) ? obj.warnings : [],
    message: obj.message || "This command requires approval.",
    requires_approval: true,
  };
}

async function readOpenAIStream(resp) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let out = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const json = JSON.parse(data);
        out += json.choices?.[0]?.delta?.content || json.choices?.[0]?.message?.content || "";
      } catch {
      }
    }
  }
  return out;
}

function formatPageContext(ctx) {
  const lines = [`Title: ${ctx.title || ""}`, `URL: ${ctx.url || ""}`];
  if (ctx.lang) lines.push(`Language: ${ctx.lang}`);
  if (ctx.text) lines.push(`Visible text excerpt:\n${ctx.text}`);
  return lines.join("\n");
}
