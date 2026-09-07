import { benchmarkFetch, visionAvailable, visionUrl } from "./benchmark-api.mjs";
const numberedWorld = run => ["ice-maze", "slotski"].includes(run.world);
const worldName = run => ({ "ice-maze": "Ice Maze", slotski: "Slotski" }[run.world] || "Main World");
const elements = Object.fromEntries([
  "world", "world-description", "world-objective", "connection-status", "launch-form", "provider", "model", "effort", "action-limit",
  "tools-enabled", "tools-label", "sequence-option", "sequence-enabled", "observation-option", "observation-mode", "vision-preview", "vision-preview-image", "vision-preview-status", "vision-room", "vision-left", "vision-right", "vision-tilt", "launch-single", "launch-pair",
  "launch-status", "refresh", "run-list", "record-count", "codex-version", "codex-update-status", "check-codex"
].map((id) => [id, document.getElementById(id)]));

let models = [];
let polling = false;
let launching = false;
let codexReady = false;
let installationStatus = {};

function updateReadiness() {
  const provider = elements.provider.value;
  const status = installationStatus[provider];
  codexReady = Boolean(status?.available && status?.tested && (provider !== "claude-code" || status.authenticated) && models.some(model => model.id === elements.model.value && (model.provider || "codex") === provider));
  elements["codex-version"].textContent = status?.version ? `${provider === "claude-code" ? "Claude Code" : "Codex"} ${status.version.replace(/^codex-cli /, "")}` : "Checking agent…";
  const labels = { "up-to-date": "Up to date", "update-available": `Update available: ${status?.latest_version}. Run codex update, then restart the server.`, "newer-than-release": "Newer than the current stable release", unknown: "Latest release check unavailable" };
  elements["codex-update-status"].textContent = !status ? "Checking installation and sign-in…" : status.error || (provider === "claude-code"
    ? `${status?.authenticated ? "Signed in" : "Not signed in"} · ${status?.tested ? "Benchmark tool boundary verified" : "Version needs validation"}`
    : `${labels[status?.update_status] || "Checking installation"} · ${status?.tested ? "Benchmark checks supported" : "Version needs validation"}`);
  elements["check-codex"].textContent = provider === "claude-code" ? "Check installation" : "Check for updates";
  elements["launch-single"].disabled = launching || !codexReady;
  elements["launch-pair"].disabled = launching || !codexReady;
}

async function checkCodex(force = false) {
  elements["check-codex"].disabled = true;
  try {
    installationStatus = await api(`/api/benchmark/v1/providers${force ? "?force=1" : ""}`);
  } catch (error) { installationStatus = { codex: { error: error.message }, "claude-code": { error: error.message } }; }
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

function statusLabel(value) {
  return String(value || "unknown").replaceAll("-", " ");
}

function compactDate(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

function duration(run) {
  if (!run.created_at) return "";
  const end = run.completed_at || run.stopped_at || Date.now();
  const seconds = Math.max(0, Math.floor((new Date(end) - new Date(run.created_at)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function recordHref(run) {
  return `./run.html?id=${encodeURIComponent(run.id)}`;
}

function renderRuns(runs) {
  elements["run-list"].replaceChildren();
  elements["record-count"].textContent = `${runs.length} record${runs.length === 1 ? "" : "s"}`;
  if (!runs.length) {
    const empty = document.createElement("div");
    empty.className = "records-empty";
    empty.innerHTML = "<strong>No evaluations yet</strong><p>Launch a model above. Its record will appear here immediately.</p>";
    elements["run-list"].append(empty);
    return;
  }
  for (const run of runs) {
    const card = document.createElement("article");
    card.className = `record-card${run.tools_enabled ? " tools" : ""}`;
    const link = document.createElement("a");
    link.className = "record-card-link";
    link.href = recordHref(run);
    const progress = run.action_limit
      ? Math.min(100, (run.action_count || 0) / run.action_limit * 100)
      : run.status === "completed" ? 100 : 0;

    const top = document.createElement("div");
    top.className = "record-top";
    const condition = document.createElement("span");
    condition.className = "condition";
    condition.textContent = `${run.observation_mode === "vision" ? "Vision · " : ""}${run.tools_enabled ? "Python on" : "Python off"}`;
    const recordStatus = document.createElement("span");
    recordStatus.className = `record-status ${run.status}`;
    recordStatus.textContent = statusLabel(run.status);
    top.append(condition, recordStatus);

    const model = document.createElement("strong");
    model.className = "record-model";
    model.textContent = run.model;
    const meta = document.createElement("span");
    meta.className = "record-meta";
    meta.textContent = `${worldName(run)} · ${run.provider === "claude-code" ? "Claude Code" : "Codex"} · ${run.effort} reasoning${run.world === "slotski" ? ` · ${run.sequence_enabled === false ? "Single moves" : "Batched moves"} · ${run.service_tier === "fast" ? "Fast" : "Standard speed"}` : ""} · ${compactDate(run.created_at)} · ${duration(run)}`;

    const progressBar = document.createElement("span");
    progressBar.className = "run-progress";
    const progressValue = document.createElement("i");
    progressValue.style.width = `${progress}%`;
    progressBar.append(progressValue);

    const metrics = document.createElement("div");
    metrics.className = "record-metrics";
    const values = [
      ["Actions", `${run.action_count || 0}${run.action_limit ? `/${run.action_limit}` : ""}`],
      [numberedWorld(run) ? "Levels solved" : "Gems", numberedWorld(run) ? `${run.levels_solved || 0}/${run.levels_total || (run.world === "slotski" ? 1 : 30)}` : run.gems_collected || 0],
      [numberedWorld(run) ? "Level" : "Rooms", numberedWorld(run) ? run.level_number : run.rooms_visited || 1],
      ["Cells", run.unique_cells || 1]
    ];
    for (const [label, value] of values) {
      const metric = document.createElement("span");
      const name = document.createElement("small");
      const output = document.createElement("b");
      name.textContent = label;
      output.textContent = value;
      metric.append(name, output);
      metrics.append(metric);
    }

    const footer = document.createElement("div");
    footer.className = "record-footer";
    const runId = document.createElement("code");
    runId.textContent = run.id.slice(-13);
    const footerActions = document.createElement("div");
    footerActions.className = "record-footer-actions";
    const open = document.createElement("a");
    open.href = recordHref(run);
    open.textContent = "Open model report →";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "record-delete danger";
    remove.dataset.deleteRun = run.id;
    remove.textContent = "Delete";
    remove.disabled = Boolean(run.runner_active);
    remove.title = run.runner_active
      ? "Stop or pause this run before deleting it."
      : "Permanently delete this run.";
    footerActions.append(open, remove);
    footer.append(runId, footerActions);
    link.append(top, model, meta, progressBar, metrics);
    card.append(link, footer);
    elements["run-list"].append(card);
  }
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
    option.selected = model.id === (elements.provider.value === "codex" ? "gpt-5.6-terra" : "claude-sonnet-5");
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
  if (elements["action-limit"].value === "unlimited") elements["action-limit"].value = elements.world.value === "slotski" ? "1000" : "100";
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
  const value = await api("/api/benchmark/v1/runs");
  renderRuns(value.runs);
}

function showError(error) {
  elements["connection-status"].textContent = error.message;
  elements["connection-status"].classList.add("error");
}

async function poll() {
  if (polling) return;
  polling = true;
  try {
    await refreshRuns();
    elements["connection-status"].textContent = "local supervisor online";
    elements["connection-status"].classList.remove("error");
  } catch (error) {
    showError(error);
  } finally {
    polling = false;
  }
}

elements["launch-form"].addEventListener("submit", launchSingle);
elements["check-codex"].addEventListener("click", () => checkCodex(true));
elements["launch-pair"].addEventListener("click", launchPair);
elements.refresh.addEventListener("click", () => poll());
elements["run-list"].addEventListener("click", async (event) => {
  const button = event.target.closest("[data-delete-run]");
  if (!button || button.disabled) return;
  const id = button.dataset.deleteRun;
  const run = (await api("/api/benchmark/v1/runs")).runs.find((entry) => entry.id === id);
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
function updateWorld() {
  const ice = elements.world.value === "ice-maze", slotski = elements.world.value === "slotski";
  elements["sequence-option"].hidden = !slotski;
  elements["observation-option"].hidden = ice || slotski;
  if (ice || slotski) elements["observation-mode"].value = "ascii";
  updateObservation();
  elements["world-objective"].textContent = slotski ? "Move A to the exit" : ice ? "Solve 30 levels" : "Collect 100 gems";
  elements["world-description"].textContent = slotski ? "One classic Slotski puzzle. Choose a labelled block and direction; move the 2×2 target A to the bottom-center exit. Python is optional." : ice ? "Solve the original 30 Ice Maze puzzles in order. All players slide together; every goal must be covered at rest. Choose whether the agent gets isolated Python." : "Start at H×I with the canonical prompt and choose whether the model gets an isolated Python workspace.";
}
let previewYaw = 0, previewPitch = 2, previewGeneration = 0;
async function updateObservation() {
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
  elements["action-limit"].value = elements.world.value === "slotski" ? "1000" : "100";
  updateWorld();
});
updateWorld();
elements.model.addEventListener("change", updateEfforts);
elements.provider.addEventListener("change", updateModels);
elements["tools-enabled"].addEventListener("change", () => {
  elements["tools-label"].textContent = elements["tools-enabled"].checked ? "On" : "Off";
});

try {
  setLaunching(false, elements["launch-status"].textContent);
  await Promise.all([loadModels(), checkCodex()]);
  await poll();
  setInterval(poll, 2000);
  setInterval(() => checkCodex(), 15 * 60_000);
} catch (error) {
  showError(error);
  elements["launch-status"].textContent = error.message;
}
