import { benchmarkFetch } from "./benchmark-api.mjs";
import { runCompany, selectRuns } from "./run-library.mjs";
import { comparisonCondition } from "./heatmap-import.mjs";
import { prepareHeatmap, comparisonBounds, croppedBounds, comparisonScale, defaultComparison, drawComparisonMap, displayModelName, tileAt, roomAt } from "./heatmap-comparison.mjs";

const $ = id => document.getElementById(id);
const number = value => (value || 0).toLocaleString();
const dates = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const percent = value => `${new Intl.NumberFormat(undefined, { maximumSignificantDigits: 3 }).format(value)}%`;
const params = new URLSearchParams(location.search);
let runs = [], fullWorld = params.get("area") === "world", selectedTile = null, serial = 0, refreshing = false;
let screenshotMode = false, previousScroll = 0;
let panelCount = params.get("models") === "3" || params.has("third") ? 3 : 2;
const cache = new Map(), pending = new Map();
if (params.get("scale") === "share") $("color-scale").value = "share";

const panels = ["left", "right", "third"].map((side, index) => {
  const element = document.createElement("section");
  element.className = "comparison-panel";
  element.setAttribute("aria-label", `${side} run comparison`);
  element.innerHTML = `
    <div class="comparison-selectors">
      <label><span>Model ${index + 1}</span><select class="model-select" aria-label="${side} model" disabled></select></label>
      <label><span>Run</span><select class="run-select" aria-label="${side} run" disabled></select></label>
    </div>
    <div class="comparison-run-meta"><span class="run-description">Choose a run</span><a class="open-run" hidden>Open run ↗</a></div>
    <dl class="comparison-stats"><div><dt>Actions</dt><dd data-stat="actions">—</dd></div><div><dt>Tiles visited</dt><dd data-stat="tiles">—</dd></div><div><dt>Rooms</dt><dd data-stat="rooms">—</dd></div><div><dt>Gems</dt><dd data-stat="gems">—</dd></div></dl>
    <div class="comparison-map"><canvas width="640" height="640" tabindex="0" role="img" aria-label="${side} run heatmap" aria-describedby="${side}-tile"></canvas><div class="map-message" role="status">Loading runs…</div></div>
    <footer><output id="${side}-tile" class="tile-readout">Hover or tap a tile</output><span class="map-coverage">Recorded visits</span></footer>
    <p class="screenshot-model-name"></p>`;
  $("comparison-panels").append(element);
  const panel = { side, element, model: element.querySelector(".model-select"), run: element.querySelector(".run-select"),
    canvas: element.querySelector("canvas"), message: element.querySelector(".map-message"), data: null, layout: null };
  panel.model.addEventListener("change", () => {
    const previous = runs.find(run => run.id === panel.run.value);
    const preferred = runs.find(run => run.model === panel.model.value && comparisonCondition(run) === comparisonCondition(previous));
    populateRuns(panel, preferred?.id); loadSelection();
  });
  panel.run.addEventListener("change", loadSelection);
  const inspect = event => {
    if (screenshotMode || !panel.layout || !panel.data) return;
    const rect = panel.canvas.getBoundingClientRect();
    selectedTile = tileAt(panel.layout, event.clientX - rect.left, event.clientY - rect.top);
    drawMaps();
  };
  panel.canvas.addEventListener("pointermove", inspect);
  panel.canvas.addEventListener("pointerdown", inspect);
  panel.canvas.addEventListener("keydown", event => {
    if (screenshotMode) return;
    const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (event.key === "Escape") { selectedTile = null; drawMaps(); return; }
    if (!direction || !panel.layout || !panel.data) return;
    event.preventDefault();
    const b = panel.layout, p = selectedTile || { x: b.minX, y: b.minY };
    selectedTile = { x: Math.max(b.minX, Math.min(b.minX + b.columns - 1, p.x + direction[0])),
      y: Math.max(b.minY, Math.min(b.minY + b.rows - 1, p.y + direction[1])) };
    drawMaps();
  });
  return panel;
});

const activePanels = () => panels.slice(0, panelCount);
function updatePanelCount() {
  panels[2].element.hidden = panelCount === 2;
  $("model-count").value = String(panelCount);
  $("comparison-panels").style.setProperty("--comparison-count", panelCount);
}
updatePanelCount();

async function importedJSON(path) {
  const response = await fetch(new URL(path, import.meta.url), { signal: AbortSignal.timeout(15000), cache: "no-cache" });
  if (!response.ok) throw new Error(`Imported heatmaps unavailable (${response.status}).`);
  return response.json();
}

async function api(url) {
  const response = await benchmarkFetch(url, { signal: AbortSignal.timeout(60000) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `Request failed (${response.status}).`);
  return value;
}

function report(id) {
  const cached = cache.get(id);
  if (cached && Date.now() - cached.at < 30000) return Promise.resolve(cached.value);
  if (pending.has(id)) return pending.get(id);
  const run = runs.find(run => run.id === id);
  const request = (run?.source ? importedJSON(`../imports/${encodeURIComponent(id)}.json`)
    : api(`/api/benchmark/v1/runs/${encodeURIComponent(id)}?view=analysis`)).then(value => {
    const result = { map: prepareHeatmap(value.heatmap), actions: value.action_count || 0 };
    if (pending.get(id) === request) {
      cache.delete(id); cache.set(id, { value: result, at: Date.now() });
      if (cache.size > 4) cache.delete(cache.keys().next().value);
    }
    return result;
  }).finally(() => { if (pending.get(id) === request) pending.delete(id); });
  pending.set(id, request);
  return request;
}

function populateModels(panel, id) {
  panel.model.replaceChildren(new Option("Choose a model", ""));
  const companies = new Map();
  for (const run of selectRuns(runs, { sort: "company" })) {
    const company = runCompany(run);
    if (!companies.has(company)) companies.set(company, new Set());
    companies.get(company).add(run.model);
  }
  for (const [company, models] of companies) {
    const group = document.createElement("optgroup"); group.label = company;
    for (const model of models) group.append(new Option(model, model));
    panel.model.append(group);
  }
  panel.model.disabled = !runs.length;
  panel.model.value = runs.find(run => run.id === id)?.model || "";
  populateRuns(panel, id);
}

function populateRuns(panel, id) {
  const matching = runs.filter(run => run.model === panel.model.value);
  panel.run.replaceChildren(...matching.map(run => new Option(
    `${run.source ? "Imported · " : ""}${comparisonCondition(run)} · ${run.observation_mode === "vision" ? "Vision · " : ""}${run.created_at ? dates.format(new Date(run.created_at)) : "Undated"} · ${run.id.slice(-6)}`, run.id)));
  if (!matching.length) panel.run.append(new Option("Choose a model first", ""));
  panel.run.disabled = !matching.length;
  panel.run.value = matching.find(run => run.id === id)?.id || matching[0]?.id || "";
}

function updateURL() {
  const url = new URL(location.href);
  for (const panel of panels) {
    if (activePanels().includes(panel) && panel.run.value) url.searchParams.set(panel.side, panel.run.value);
    else url.searchParams.delete(panel.side);
  }
  url.searchParams.set("models", String(panelCount));
  if (fullWorld) url.searchParams.set("area", "world"); else url.searchParams.delete("area");
  if ($("color-scale").value === "share") url.searchParams.set("scale", "share"); else url.searchParams.delete("scale");
  history.replaceState(null, "", url);
}

function renderPanel(panel) {
  const run = runs.find(run => run.id === panel.run.value), data = panel.data;
  panel.element.querySelector(".screenshot-model-name").textContent = displayModelName(run?.model);
  const link = panel.element.querySelector(".open-run");
  link.hidden = !run;
  if (run) link.href = run.source?.url || `./run.html?id=${encodeURIComponent(run.id)}`;
  link.textContent = run?.source ? "Source run ↗" : "Open run ↗";
  panel.element.querySelector(".run-description").textContent = run
    ? `${run.source ? `Imported from ${new URL(run.source.origin).host}` : `${run.effort || "Default"} reasoning`} · ${run.observation_mode === "vision" ? "Vision" : "ASCII"} · ${String(run.status || "unknown").replaceAll("-", " ")}` : "Choose a run";
  const stats = { actions: data?.actions, tiles: data?.map.points.length, rooms: data ? run?.rooms_visited : null, gems: data ? run?.gems_collected : null };
  for (const [key, value] of Object.entries(stats)) panel.element.querySelector(`[data-stat="${key}"]`).textContent = value == null ? "—" : number(value);
  panel.element.querySelector(".map-coverage").textContent = data
    ? `${number(data.map.total)} visits · ${run.source ? "action endpoints · imported snapshot" : `paths tracked for ${number(data.map.trackedActions)} of ${number(data.actions)} actions`}` : "Recorded visits";
  panel.canvas.setAttribute("aria-label", data ? `${run.model}: ${number(data.map.points.length)} tiles visited, ${number(data.map.total)} visits. Use arrow keys to inspect tiles.` : "Heatmap unavailable");
}

function drawMaps() {
  const visible = activePanels();
  const maps = visible.map(panel => panel.data?.map), bounds = comparisonBounds(maps, fullWorld);
  const scale = $("color-scale").value, colors = comparisonScale(maps, scale);
  const crops = maps.map(croppedBounds);
  const grid = $("comparison-panels");
  const labelHeight = screenshotMode ? Math.max(...visible.map(panel => panel.element.querySelector(".screenshot-model-name").clientHeight)) : 0;
  // Crop each run independently but keep the same tile size across maps.
  const screenshotCell = screenshotMode ? Math.max(1, Math.min(
    (grid.clientWidth - parseFloat(getComputedStyle(grid).columnGap) * (panelCount - 1)) / panelCount / Math.max(...crops.map(crop => crop.columns)),
    (window.innerHeight - 72 - labelHeight) / Math.max(...crops.map(crop => crop.rows))
  )) : 1;
  $("explored-area").setAttribute("aria-pressed", String(!fullWorld));
  $("full-world").setAttribute("aria-pressed", String(fullWorld));
  for (const [index, panel] of visible.entries()) {
    panel.layout = drawComparisonMap(panel.canvas, panel.data?.map, screenshotMode ? crops[index] : bounds, scale, colors, selectedTile, { screenshotMode, screenshotCell });
    const count = panel.data?.map.counts.get(`${selectedTile?.x},${selectedTile?.y}`) || 0;
    panel.element.querySelector(".tile-readout").textContent = !panel.data ? "No heatmap loaded" : !selectedTile ? "Hover or tap a tile to compare visits"
      : `Room ${roomAt(selectedTile)} · tile ${selectedTile.x % 16}, ${selectedTile.y % 16} · ${number(count)} visits${scale === "share" ? ` · ${percent(panel.data.map.total ? count / panel.data.map.total * 100 : 0)}` : ""}`;
  }
  $("comparison-legend").hidden = !colors.maximum;
  const format = scale === "share" ? percent : number;
  $("legend-min").textContent = format(colors.minimum);
  $("legend-max").textContent = format(colors.maximum);
  $("legend-label").textContent = `${scale === "share" ? "Share of each run’s visits" : "Visits per tile"} · logarithmic scale`;
  $("screenshot-mode").disabled = !visible.every(panel => panel.data?.map.points.length);
}

function setScreenshotMode(active) {
  if (active && $("screenshot-mode").disabled) return;
  if (active) previousScroll = window.scrollY;
  screenshotMode = active;
  selectedTile = null;
  document.documentElement.classList.toggle("screenshot-mode", active);
  for (const panel of panels) panel.canvas.tabIndex = active ? -1 : 0;
  if (active) {
    document.querySelector(".compare-main").focus({ preventScroll: true });
    window.scrollTo(0, 0);
  } else {
    $("screenshot-mode").focus({ preventScroll: true });
    window.scrollTo(0, previousScroll);
  }
  drawMaps();
}

function comparisonNote() {
  const selected = activePanels().map(panel => runs.find(run => run.id === panel.run.value)).filter(Boolean);
  const notes = [];
  if (selected.length > 1) {
    if (new Set(selected.map(run => run.id)).size < selected.length) notes.push("Some panels show the same run.");
    if (new Set(selected.map(comparisonCondition)).size > 1) notes.push("These runs use different tool settings.");
    if (new Set(selected.map(run => run.observation_mode || "ascii")).size > 1) notes.push("These runs use different observation modes.");
    if (new Set(selected.filter(run => run.effort).map(run => run.effort)).size > 1) notes.push("These runs use different reasoning settings.");
  }
  if (selected.some(run => run.source)) notes.push("Imported heatmaps preserve the older run’s world and recorded action endpoints.");
  $("comparison-note").hidden = !notes.length;
  $("comparison-note").textContent = notes.join(" ");
}

async function loadSelection() {
  const generation = ++serial;
  selectedTile = null;
  updateURL(); comparisonNote();
  $("comparison-status").classList.remove("error");
  $("comparison-status").textContent = "Loading heatmaps…";
  let failed = false;
  const jobs = activePanels().map(async panel => {
    const id = panel.run.value;
    panel.data = null;
    panel.message.hidden = false;
    panel.message.textContent = id ? "Loading heatmap…" : runs.length ? "Choose a model and run to compare." : "No Main World runs yet. Launch one from Benchmark.";
    panel.element.setAttribute("aria-busy", String(Boolean(id)));
    renderPanel(panel);
    if (!id) return;
    try {
      const data = await report(id);
      if (serial !== generation) return;
      panel.data = data;
      panel.message.hidden = Boolean(data.map.points.length);
      panel.message.textContent = "No recorded visits in this run yet.";
    } catch (error) {
      if (serial !== generation) return;
      failed = true;
      panel.message.textContent = `Couldn’t load this heatmap. ${error.message} Use Refresh to retry.`;
    } finally {
      if (serial === generation) {
        panel.element.setAttribute("aria-busy", "false"); renderPanel(panel); drawMaps();
      }
    }
  });
  drawMaps();
  await Promise.all(jobs);
  if (serial !== generation) return;
  const count = activePanels().filter(panel => panel.data).length;
  $("comparison-status").classList.toggle("error", failed);
  $("comparison-status").textContent = failed ? "Some data couldn’t be loaded" : count ? `Updated ${new Date().toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}` : "Choose runs to compare";
}

async function refresh(initial = false) {
  if (refreshing) return;
  refreshing = true; $("refresh-comparison").disabled = true;
  try {
    const [local, imported] = await Promise.allSettled([api("/api/benchmark/v1/runs?view=library"), importedJSON("../imports/index.json")]);
    if (local.status === "rejected" && imported.status === "rejected") throw local.reason;
    runs = selectRuns([...(local.value?.runs || []), ...(imported.value?.runs || [])].filter(run => !run.world || run.world === "main-world"));
    if (initial && !params.has("models") && !params.has("left") && runs.some(run => /^claude-haiku-4[.-]5(?:-|$)/.test(run.model))) panelCount = 3;
    updatePanelCount();
    const choices = initial ? defaultComparison(runs, params.get("left"), params.get("right"), params.get("third"), 3) : panels.map(panel => panel.run.value);
    cache.clear(); pending.clear();
    panels.forEach((panel, index) => populateModels(panel, choices[index]));
    await loadSelection();
    const warnings = [local.status === "rejected" ? "Local runs unavailable" : "", imported.status === "rejected" ? "Imported heatmaps unavailable" : ""].filter(Boolean);
    if (warnings.length) { $("comparison-status").textContent = warnings.join(" · "); $("comparison-status").classList.add("error"); }
  } catch (error) {
    $("comparison-status").classList.add("error");
    $("comparison-status").textContent = `Couldn’t refresh runs. ${error.message}`;
    if (initial) for (const panel of panels) panel.message.textContent = "Runs unavailable. Use Refresh to retry.";
  } finally { refreshing = false; $("refresh-comparison").disabled = false; }
}

$("refresh-comparison").addEventListener("click", () => refresh());
$("model-count").addEventListener("change", () => { panelCount = Number($("model-count").value); updatePanelCount(); loadSelection(); });
$("screenshot-mode").addEventListener("click", () => setScreenshotMode(true));
document.addEventListener("keydown", event => {
  if (screenshotMode && event.key === "Escape") { event.preventDefault(); setScreenshotMode(false); }
});
document.addEventListener("pointerdown", () => { if (screenshotMode) setScreenshotMode(false); });
$("explored-area").addEventListener("click", () => { fullWorld = false; selectedTile = null; updateURL(); drawMaps(); });
$("full-world").addEventListener("click", () => { fullWorld = true; selectedTile = null; updateURL(); drawMaps(); });
$("color-scale").addEventListener("change", () => { updateURL(); drawMaps(); });
const observer = new ResizeObserver(drawMaps);
for (const panel of panels) observer.observe(panel.canvas);
refresh(true);
