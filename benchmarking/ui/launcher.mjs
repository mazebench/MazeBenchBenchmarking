import { benchmarkFetch, visionAvailable, visionUrl } from "./benchmark-api.mjs";
import { RunListView, providerName, runCompany, selectRuns } from "./run-library.mjs";
const elements = Object.fromEntries([
  "world", "world-description", "world-objective", "connection-status", "launch-form", "provider", "model", "effort", "action-limit", "run-options-summary",
  "tools-enabled", "tools-label", "sequence-option", "sequence-enabled", "observation-option", "observation-mode", "vision-preview", "vision-preview-image", "vision-preview-status", "vision-room", "vision-left", "vision-right", "vision-tilt", "launch-single", "launch-pair",
  "launch-status", "refresh", "run-list", "record-count", "codex-version", "codex-update-status", "check-codex", "runtime-details", "agent-readiness", "run-pagination", "run-page", "previous-runs", "next-runs", "run-company", "run-model", "run-sort"
].map((id) => [id, document.getElementById(id)]));

let models = [];
let polling = false;
let launching = false;
let codexReady = false;
let installationStatus = {};

function providerCompatible(provider) {
  return !["grok-build", "antigravity"].includes(provider) || (elements.world.value === "main-world" && elements["observation-mode"].value === "ascii");
}

function updateReadiness() {
  const provider = elements.provider.value;
  const status = installationStatus[provider];
  const needsAuth = ["claude-code", "grok-build", "antigravity"].includes(provider);
  codexReady = Boolean(status?.available && status?.tested && (!needsAuth || status.authenticated) && providerCompatible(provider) && models.some(model => model.id === elements.model.value && (model.provider || "codex") === provider));
  elements["codex-version"].textContent = status?.version ? `${providerName(provider)} ${status.version.replace(/^codex-cli /, "")}` : "Checking agent…";
  const labels = { "up-to-date": "Up to date", "update-available": `Update available: ${status?.latest_version}. Run codex update, then restart the server.`, "newer-than-release": "Newer than the current stable release", unknown: "Latest release check unavailable" };
  elements["codex-update-status"].textContent = !providerCompatible(provider)
    ? `${providerName(provider)} currently supports Main World with ASCII observations.`
    : !status ? "Checking installation and sign-in…" : status.error || (needsAuth
    ? `${status?.authenticated ? "Signed in" : "Not signed in"} · ${status?.tested ? "Benchmark tool boundary verified" : "Version needs validation"}`
    : `${labels[status?.update_status] || "Checking installation"} · ${status?.tested ? "Benchmark checks supported" : "Version needs validation"}`);
  elements["check-codex"].textContent = provider === "codex" ? "Check for updates" : "Check installation";
  elements["agent-readiness"].textContent = codexReady ? "Ready" : status ? "Needs attention" : "Checking…";
  elements["runtime-details"].classList.toggle("needs-attention", Boolean(status && !codexReady));
  if (status && !codexReady) elements["runtime-details"].open = true;
  elements["launch-single"].disabled = launching || !codexReady;
  elements["launch-pair"].disabled = launching || !codexReady;
}

async function checkCodex(force = false) {
  elements["check-codex"].disabled = true;
  try {
    installationStatus = await api(`/api/benchmark/v1/providers${force ? "?force=1" : ""}`);
  } catch (error) { installationStatus = Object.fromEntries(["codex", "claude-code", "grok-build", "antigravity"].map(provider => [provider, { error: error.message }])); }
  finally { elements["check-codex"].disabled = false; updateReadiness(); }
}

async function api(path, options = {}) {
  const response = await benchmarkFetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || `Request failed (${response.status}).`);
  return value;
}

const runList = new RunListView(elements["run-list"]);
let latestRuns = [];
let pollTimer;

function filterOptions(select, values, placeholder) {
  const options = [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const signature = JSON.stringify(options);
  if (select.dataset.options === signature) return;
  const selected = select.value;
  select.replaceChildren(new Option(placeholder, ""), ...options.map(value => new Option(value, value)));
  select.value = options.includes(selected) ? selected : "";
  select.dataset.options = signature;
}

function renderRuns(runs, page) {
  latestRuns = runs;
  filterOptions(elements["run-company"], runs.map(runCompany), "All companies");
  const company = elements["run-company"].value;
  filterOptions(elements["run-model"], runs.filter(run => !company || runCompany(run) === company).map(run => run.model), "All models");
  const visible = selectRuns(runs, { company, model: elements["run-model"].value, sort: elements["run-sort"].value });
  const result = runList.update(visible, page);
  elements["record-count"].textContent = visible.length === runs.length
    ? `${runs.length} run${runs.length === 1 ? "" : "s"}` : `${visible.length} of ${runs.length} runs`;
  elements["run-list"].setAttribute("aria-busy", "false");
  elements["run-pagination"].hidden = result.totalPages === 1;
  elements["run-page"].textContent = `${result.page + 1} of ${result.totalPages}`;
  elements["previous-runs"].disabled = result.page === 0;
  elements["next-runs"].disabled = result.page + 1 === result.totalPages;
}

function updateEfforts() {
  const selected = models.find((model) => model.id === elements.model.value) || models[0];
  elements.effort.replaceChildren();
  for (const effort of selected?.efforts || ["medium"]) {
    const option = document.createElement("option");
    option.value = effort;
    option.textContent = effort;
    option.selected = effort === selected?.default_effort;
    elements.effort.append(option);
  }
}

function updateModels() {
  const providerModels = models.filter(model => (model.provider || "codex") === elements.provider.value);
  elements.model.replaceChildren();
  for (const model of providerModels) {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = model.name;
    const preferred = ({ codex: "gpt-5.6-terra", "claude-code": "claude-sonnet-5-5", "grok-build": "grok-4.7", antigravity: "gemini-3.8-flash-medium" })[elements.provider.value];
    option.selected = model.id === preferred;
    elements.model.append(option);
  }
  updateEfforts();
  updateReadiness();
}
async function loadModels() {
  const catalog = await api("/api/benchmark/v1/models");
  models = catalog.models;
  updateModels();
}

function launchPayload(toolsEnabled = elements["tools-enabled"].checked) {
  return {
    world: elements.world.value,
    ...(elements.world.value === "main-world" ? { observation_mode: elements["observation-mode"].value } : {}),
    provider: elements.provider.value,
    model: elements.model.value,
    effort: elements.effort.value,
    tools_enabled: toolsEnabled,
    ...(elements.world.value === "slotski" ? { sequence_enabled: elements["sequence-enabled"].value === "true" } : {}),
    action_limit: elements["action-limit"].value === "unlimited"
      ? null
      : Number(elements["action-limit"].value),
    start_room: elements.world.value !== "main-world" ? "Level 1" : "HxI"
  };
}

function setLaunching(active, message) {
  launching = active;
  elements["launch-single"].disabled = active || !codexReady;
  elements["launch-pair"].disabled = active || !codexReady;
  elements["launch-status"].textContent = message;
}

async function launchSingle(event) {
  event.preventDefault();
  setLaunching(true, "Preparing the game and checking the isolation boundary…");
  try {
    const run = await api("/api/benchmark/v1/runs", {
      method: "POST",
      body: JSON.stringify(launchPayload())
    });
    await refreshRuns();
    setLaunching(false, `Launched ${run.model}. Its live record is ready below.`);
  } catch (error) {
    setLaunching(false, error.message);
  }
}

async function launchPair() {
  setLaunching(true, "Preflighting Python isolation, then starting both conditions…");
  try {
    await api("/api/benchmark/v1/pairs", {
      method: "POST",
      body: JSON.stringify(launchPayload(false))
    });
    await refreshRuns();
    setLaunching(false, "Matched pair launched. Open either record to watch its model report.");
  } catch (error) {
    setLaunching(false, error.message);
  }
}

async function refreshRuns() {
  const value = await api("/api/benchmark/v1/runs?view=library");
  renderRuns(value.runs);
}

function showError(error) {
  elements["connection-status"].textContent = error.message;
  elements["connection-status"].classList.add("error");
  elements["connection-status"].classList.remove("connected");
}

async function poll() {
  clearTimeout(pollTimer);
  if (polling) return;
  polling = true;
  try {
    await refreshRuns();
    elements["connection-status"].textContent = "Connected";
    elements["connection-status"].classList.remove("error");
    elements["connection-status"].classList.add("connected");
  } catch (error) {
    showError(error);
    if (elements["run-list"].getAttribute("aria-busy") === "true") {
      const message = document.createElement("p");
      message.className = "empty-copy";
      message.textContent = "Runs couldn’t load. Refresh to try again.";
      elements["run-list"].replaceChildren(message);
    }
  } finally {
    elements["run-list"].setAttribute("aria-busy", "false");
    polling = false;
    if (!document.hidden) {
      const active = latestRuns.some(run => run.runner_active || ["queued", "running", "continuing", "preparing", "pausing"].includes(run.status));
      pollTimer = setTimeout(poll, active ? 5000 : 30000);
    }
  }
}

elements["launch-form"].addEventListener("submit", launchSingle);
elements["check-codex"].addEventListener("click", () => checkCodex(true));
elements["launch-pair"].addEventListener("click", launchPair);
elements.refresh.addEventListener("click", () => poll());
for (const id of ["run-company", "run-model", "run-sort"]) {
  elements[id].addEventListener("change", () => renderRuns(latestRuns, 0));
}
for (const [id, step] of [["previous-runs", -1], ["next-runs", 1]]) {
  elements[id].addEventListener("click", () => {
    renderRuns(latestRuns, runList.page + step);
    elements["run-list"].scrollIntoView({ block: "start" });
  });
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) clearTimeout(pollTimer);
  else poll();
});
elements["run-list"].addEventListener("click", async (event) => {
  const button = event.target.closest("[data-delete-run]");
  if (!button || button.disabled) return;
  const id = button.dataset.deleteRun;
  const run = (await api("/api/benchmark/v1/runs?view=library")).runs.find((entry) => entry.id === id);
  if (!run) return poll();
  const confirmed = window.confirm(
    `Permanently delete ${run.model} run ${run.id}?\n\nThis removes its record, workspace, replay, and interview chats. This cannot be undone.`
  );
  if (!confirmed) return;
  button.disabled = true;
  try {
    await api(`/api/benchmark/v1/runs/${encodeURIComponent(id)}`, { method: "DELETE" });
    await poll();
  } catch (error) {
    button.disabled = false;
    showError(error);
  }
});
function updateRunOptionsSummary() {
  const limit = elements["action-limit"].value;
  const actions = limit === "unlimited" ? "Unlimited actions" : `${Number(limit).toLocaleString()} actions`;
  const sequences = elements.world.value === "slotski"
    ? ` · ${elements["sequence-enabled"].value === "true" ? "Batch moves" : "Single moves"}`
    : "";
  elements["run-options-summary"].textContent = actions + sequences;
}

function updateWorld() {
  const ice = elements.world.value === "ice-maze", slotski = elements.world.value === "slotski";
  elements["sequence-option"].hidden = !slotski;
  elements["observation-option"].hidden = ice || slotski;
  if (ice || slotski) elements["observation-mode"].value = "ascii";
  updateObservation();
  updateReadiness();
  elements["world-objective"].textContent = slotski ? "Move A to the exit" : ice ? "Solve 30 levels" : "Collect 100 gems";
  elements["world-description"].textContent = slotski ? "Move the 2×2 target block to the bottom-center exit." : ice ? "Solve 30 puzzles in order. All players slide together." : "Explore Main World from room H×I.";
  updateRunOptionsSummary();
}
let previewYaw = 0, previewPitch = 2, previewGeneration = 0;
async function updateObservation() {
  updateReadiness();
  const enabled = elements.world.value === "main-world" && elements["observation-mode"].value === "vision";
  elements["vision-preview"].hidden = !enabled;
  if (!enabled) return;
  const generation = ++previewGeneration;
  elements["vision-preview-status"].textContent = "Rendering the agent's view…";
  if (!await visionAvailable()) { elements["vision-preview-status"].textContent = "Vision runner is offline."; return; }
  if (generation !== previewGeneration) return;
  const img = elements["vision-preview-image"];
  img.onload = () => { elements["vision-preview-status"].textContent = "Preview only · no benchmark actions are taken"; };
  img.onerror = () => { elements["vision-preview-status"].textContent = "The image could not be rendered. Try again."; };
  img.src = visionUrl(`/api/benchmark/vision/preview?room=${elements["vision-room"].value}&yaw=${previewYaw}&pitch=${previewPitch}`);
}
elements["observation-mode"].addEventListener("change", updateObservation);
elements["vision-room"].addEventListener("change", updateObservation);
elements["vision-left"].addEventListener("click", () => { previewYaw = (previewYaw + 3) % 4; updateObservation(); });
elements["vision-right"].addEventListener("click", () => { previewYaw = (previewYaw + 1) % 4; updateObservation(); });
elements["vision-tilt"].addEventListener("click", () => { previewPitch = (previewPitch + 1) % 5; updateObservation(); });
if (new URLSearchParams(location.search).get("mode") === "vision") elements["observation-mode"].value = "vision";
const requestedWorld = new URLSearchParams(location.search).get("world");
if (["ice-maze", "slotski"].includes(requestedWorld)) elements.world.value = requestedWorld;
if (elements.world.value === "slotski") elements["action-limit"].value = "1000";
elements.world.addEventListener("change", () => {
  elements["action-limit"].value = elements.world.value === "slotski" ? "1000" : "unlimited";
  updateWorld();
});
updateWorld();
elements["action-limit"].addEventListener("change", updateRunOptionsSummary);
elements["sequence-enabled"].addEventListener("change", updateRunOptionsSummary);
elements.model.addEventListener("change", updateEfforts);
elements.provider.addEventListener("change", updateModels);
elements["tools-enabled"].addEventListener("change", () => {
  elements["tools-label"].textContent = elements["tools-enabled"].checked ? "On" : "Off";
});

try {
  setLaunching(false, elements["launch-status"].textContent);
  await Promise.all([loadModels(), checkCodex(), poll()]);
  setInterval(() => { if (!document.hidden) checkCodex(); }, 15 * 60_000);
} catch (error) {
  showError(error);
  elements["launch-status"].textContent = error.message;
}
