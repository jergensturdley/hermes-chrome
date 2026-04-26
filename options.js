const gatewayUrlInput = document.getElementById("gateway-url");
const apiKeyInput = document.getElementById("api-key");
const providerSelect = document.getElementById("provider-select");
const modelSelect = document.getElementById("model-select");
const baseUrlInput = document.getElementById("base-url");
const includePageContextInput = document.getElementById("include-page-context");
const useSessionApiInput = document.getElementById("use-session-api");
const streamResponsesInput = document.getElementById("stream-responses");
const systemPromptInput = document.getElementById("system-prompt");
const btnDetect = document.getElementById("btn-detect");
const btnTest = document.getElementById("btn-test");
const btnLoadRuntime = document.getElementById("btn-load-runtime");
const btnSaveRuntime = document.getElementById("btn-save-runtime");
const btnReset = document.getElementById("btn-reset");
const btnSave = document.getElementById("btn-save");
const testResult = document.getElementById("test-result");
const runtimeResult = document.getElementById("runtime-result");
const saveStatus = document.getElementById("save-status");

const DEFAULTS = {
  gatewayUrl: "http://127.0.0.1:8642",
  apiKey: "",
  provider: "",
  model: "hermes-agent",
  baseUrl: "",
  useSessionApi: true,
  includePageContext: true,
  streamResponses: false,
  systemPrompt: "You are Hermes Agent, a helpful local AI assistant. Be concise, accurate, and technical.",
};

async function loadSettings() {
  const data = await chrome.storage.local.get(DEFAULTS);
  gatewayUrlInput.value = data.gatewayUrl;
  apiKeyInput.value = data.apiKey || "";
  baseUrlInput.value = data.baseUrl || "";
  includePageContextInput.checked = data.includePageContext;
  useSessionApiInput.checked = data.useSessionApi !== false;
  streamResponsesInput.checked = data.streamResponses;
  systemPromptInput.value = data.systemPrompt;
  setSelectOptions(providerSelect, data.provider ? [{ id: data.provider, label: data.provider }] : []);
  setSelectOptions(modelSelect, [{ id: data.model || "hermes-agent", label: data.model || "hermes-agent" }]);
}

function setSelectOptions(select, items, selected = "") {
  select.innerHTML = "";
  for (const item of items) {
    const opt = document.createElement("option");
    opt.value = item.id;
    opt.textContent = item.label || item.id;
    select.appendChild(opt);
  }
  if (selected) select.value = selected;
}

async function detectGateway() {
  showResult(testResult, "Scanning localhost for Hermes gateway...", "checking");
  btnDetect.disabled = true;
  try {
    await chrome.storage.local.set({ apiKey: apiKeyInput.value.trim() });
    const result = await chrome.runtime.sendMessage({ type: "detect-gateway", apiKey: apiKeyInput.value.trim() });
    if (!result.ok) {
      const details = (result.results || []).slice(0, 4).map(r => `${r.url}: ${r.error || r.status || "unknown"}`).join(" | ");
      throw new Error(`${result.error || "No gateway found"}${details ? ` — ${details}` : ""}`);
    }
    gatewayUrlInput.value = result.selected;
    showResult(testResult, `Detected ${result.selected}${result.warning ? ` (${result.warning})` : ""}`, "success");
    await loadRuntime();
  } catch (err) {
    showResult(testResult, `Auto-detect failed: ${err.message}`, "error");
  } finally {
    btnDetect.disabled = false;
  }
}

async function testConnection() {
  const url = gatewayUrlInput.value.trim();
  if (!url) return showResult(testResult, "Enter a URL first", "error");
  showResult(testResult, "Testing...", "checking");
  await chrome.storage.local.set({ gatewayUrl: url.replace(/\/+$/, ""), apiKey: apiKeyInput.value.trim() });
  try {
    const result = await chrome.runtime.sendMessage({ type: "check-gateway" });
    if (!result.ok) throw new Error(result.error);
    showResult(testResult, `Connected via ${result.path} (status: ${result.status || "ok"})`, "success");
  } catch (err) {
    showResult(testResult, `Failed: ${err.message}`, "error");
  }
}

async function loadRuntime() {
  showResult(runtimeResult, "Loading Hermes runtime...", "checking");
  await saveSettings(false);
  try {
    const config = await chrome.runtime.sendMessage({ type: "get-hermes-config" });
    if (config.error) throw new Error(config.error);
    const available = await chrome.runtime.sendMessage({ type: "get-available-models", provider: config.provider });
    if (available.error) throw new Error(available.error);

    const providers = (available.providers || []).map(p => ({
      id: p.id,
      label: `${p.label || p.id}${p.authenticated === false ? " (not authenticated)" : ""}`,
    }));
    if (config.provider && !providers.some(p => p.id === config.provider)) providers.unshift({ id: config.provider, label: config.provider });
    setSelectOptions(providerSelect, providers, config.provider || available.provider || "");

    const models = (available.models || []).map(m => ({ id: m.id, label: `${m.id}${m.provider ? ` · ${m.provider}` : ""}${m.description ? ` — ${m.description}` : ""}` }));
    if (config.model && !models.some(m => m.id === config.model)) models.unshift({ id: config.model, label: `${config.model} — current` });
    setSelectOptions(modelSelect, models, config.model || "hermes-agent");
    baseUrlInput.value = config.base_url || "";
    showResult(runtimeResult, `Loaded ${config.provider || "provider"} / ${config.model || "model"}`, "success");
  } catch (err) {
    showResult(runtimeResult, `Failed to load runtime: ${err.message}`, "error");
  }
}

async function loadModelsForProvider() {
  const provider = providerSelect.value;
  if (!provider) return;
  showResult(runtimeResult, `Loading ${provider} models...`, "checking");
  await saveSettings(false);
  try {
    const available = await chrome.runtime.sendMessage({ type: "get-available-models", provider });
    if (available.error) throw new Error(available.error);
    const models = (available.models || []).filter(m => !m.provider || m.provider === provider || m.provider === "ollama").map(m => ({
      id: m.id,
      label: `${m.id}${m.description ? ` — ${m.description}` : ""}`,
    }));
    setSelectOptions(modelSelect, models, models[0]?.id || "");
    showResult(runtimeResult, `Loaded ${models.length} model(s) for ${provider}`, "success");
  } catch (err) {
    showResult(runtimeResult, `Failed to load models: ${err.message}`, "error");
  }
}

async function saveRuntime() {
  showResult(runtimeResult, "Applying to Hermes...", "checking");
  await saveSettings(false);
  try {
    const result = await chrome.runtime.sendMessage({
      type: "update-hermes-config",
      config: { provider: providerSelect.value, model: modelSelect.value, baseUrl: baseUrlInput.value.trim() },
    });
    if (result.error) throw new Error(result.error);
    showResult(runtimeResult, `Applied ${result.provider || providerSelect.value} / ${result.model || modelSelect.value}`, "success");
  } catch (err) {
    showResult(runtimeResult, `Failed to apply runtime: ${err.message}`, "error");
  }
}

function showResult(el, msg, type) {
  el.textContent = msg;
  el.className = `test-result ${type}`;
}

async function saveSettings(show = true) {
  const data = {
    gatewayUrl: (gatewayUrlInput.value.trim() || DEFAULTS.gatewayUrl).replace(/\/+$/, ""),
    apiKey: apiKeyInput.value.trim(),
    provider: providerSelect.value,
    model: modelSelect.value || DEFAULTS.model,
    baseUrl: baseUrlInput.value.trim(),
    useSessionApi: useSessionApiInput.checked,
    includePageContext: includePageContextInput.checked,
    streamResponses: streamResponsesInput.checked,
    systemPrompt: systemPromptInput.value.trim() || DEFAULTS.systemPrompt,
  };
  await chrome.storage.local.set(data);
  if (show) {
    saveStatus.textContent = "Saved!";
    saveStatus.className = "save-status success";
    setTimeout(() => { saveStatus.textContent = ""; }, 2000);
  }
}

async function resetSettings() {
  if (!confirm("Reset all settings to defaults? This will clear your conversation history and current Hermes Chrome session.")) return;
  await chrome.storage.local.set({ ...DEFAULTS, conversationHistory: [], currentSessionId: "" });
  await loadSettings();
  saveStatus.textContent = "Reset to defaults";
  saveStatus.className = "save-status success";
}

btnDetect.addEventListener("click", detectGateway);
btnTest.addEventListener("click", testConnection);
btnLoadRuntime.addEventListener("click", loadRuntime);
btnSaveRuntime.addEventListener("click", saveRuntime);
providerSelect.addEventListener("change", loadModelsForProvider);
btnSave.addEventListener("click", () => saveSettings(true));
btnReset.addEventListener("click", resetSettings);
gatewayUrlInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); testConnection(); } });
document.addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); saveSettings(true); } });

loadSettings().then(loadRuntime);
