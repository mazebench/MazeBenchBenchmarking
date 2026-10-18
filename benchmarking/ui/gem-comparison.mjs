import { codingLabel, codingMode } from "../coding-mode.mjs";
import { benchmarkFetch } from "./benchmark-api.mjs";
import { runCompany, selectRuns } from "./run-library.mjs";
import { displayModelName } from "./heatmap-comparison.mjs";
import { gemSeries, gemsAt, gemLinePath, axisExtent, layoutEndLabels, limitGemSeries } from "./gem-comparison-data.mjs";
import { comparisonGemCount, correctedGemSeries, editedGemSeries, moveGemPoint } from "./gem-comparison-edits.mjs";
import { gemMarker } from "./gem-comparison-markers.mjs";

const escape = value => String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const number = value => value.toLocaleString();
const score = value => `${(value.collected / value.total * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
const colors = ["#5ee7ff", "#a88bff", "#ffcc66", "#65e3a5", "#ff8b7b", "#72a7ff", "#f49ce0", "#c9e976"];
const dates = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function createGemComparison({ onChange }) {
  const root = document.createElement("section");
  root.className = "gem-comparison";
  root.hidden = true;
  root.innerHTML = `
    <div class="gem-controls">
      <details class="gem-picker"><summary>Choose runs <span class="gem-selection-count">0 selected</span></summary>
        <div class="gem-picker-toolbar"><input type="search" placeholder="Search models or companies" aria-label="Search runs">
          <select aria-label="Filter runs by coding"><option value="all">All runs</option><option value="off">Coding off</option><option value="python">Python only</option><option value="any">Any language</option></select>
          <button type="button" class="gem-select-visible">Select visible</button><button type="button" class="gem-clear">Clear</button></div>
        <div class="gem-run-list"></div><p class="gem-picker-note">Choose any number of runs. Imported heatmap-only snapshots have no move history.</p>
      </details>
      <div class="gem-axis-controls">
        <div class="gem-max-control"><label class="scale-control">Max moves <input class="gem-max-moves" type="number" min="1" step="1" placeholder="Auto" inputmode="numeric"></label><button type="button" class="gem-max-auto">Auto</button></div>
        <label class="scale-control gem-range-control">Gem axis <select class="gem-range"><option value="auto">Auto</option><option value="100">0–100 gems</option></select></label>
      </div>
    </div>
    <div class="gem-edit-controls"><button type="button" class="gem-edit-toggle" aria-pressed="false">Edit curve</button><button type="button" class="gem-edit-reset" disabled>Reset curve edits</button><span class="gem-edit-help">Drag points to reshape a curve. Edits are saved in this browser.</span><span class="gem-edit-status" role="status"></span></div>
    <article class="gem-chart-card">
      <header class="gem-chart-heading"><div><span>MAZEBENCH · MAIN WORLD</span><h2>Gems collected by move</h2></div><span class="gem-chart-count"></span></header>
      <div class="gem-plot"><svg class="gem-chart" role="img" tabindex="0" aria-label="Gems collected by move"></svg><output class="gem-tooltip" hidden></output></div>
      <div class="gem-chart-legend"></div>
      <p class="gem-adjustment-note" hidden></p>
    </article>
    <p class="gem-chart-note">Lines connect collection milestones. Curve edits affect this comparison only. Max moves limits the chart and scores to that move. Moves include all recorded actions, including undo, reset and camera actions. Refresh to update.</p>`;
  document.getElementById("comparison-panels").before(root);
  const $ = selector => root.querySelector(selector);
  let runs = [], active = false, generation = 0, plot = null, loading = false, initialized = false;
  const selected = new Set(new URLSearchParams(location.search).getAll("run"));
  const savedMax = Number(new URLSearchParams(location.search).get("maxMoves"));
  let maxMoves = Number.isSafeInteger(savedMax) && savedMax > 0 ? savedMax : null;
  $(".gem-max-moves").value = maxMoves ?? "";
  const data = new Map(), requests = new Map(), errors = new Map();
  const storageKey = "mazebench-gem-curve-edits-v1";
  let edits = {}, editing = false, drag = null, selectedPoint = null;
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    if (saved?.version === 1 && saved.runs && typeof saved.runs === "object" && !Array.isArray(saved.runs)) edits = saved.runs;
  } catch { /* A missing or unavailable local store starts with recorded curves. */ }
  const fullSeries = run => editedGemSeries(data.get(run.id), edits[run.id]);
  function saveEdits() {
    try {
      localStorage.setItem(storageKey, JSON.stringify({ version: 1, runs: edits }));
      $(".gem-edit-status").textContent = "Saved in this browser.";
    } catch { $(".gem-edit-status").textContent = "Browser storage unavailable; edits last until reload."; }
  }
  const filtered = () => runs.filter(run => {
    const query = $('input[type="search"]').value.toLowerCase();
    const tools = $('select[aria-label="Filter runs by coding"]').value;
    return `${displayModelName(run.model)} ${runCompany(run)} ${run.id}`.toLowerCase().includes(query)
      && (tools === "all" || codingMode(run) === tools);
  });
  const selectedRuns = () => [...selected].map(id => runs.find(run => run.id === id)).filter(Boolean);
  const color = index => colors[index] || `hsl(${(index * 137.508) % 360} 78% 72%)`;
  const detail = run => `${run.effort || "Default"} · ${codingLabel(run)} · ${run.observation_mode === "vision" ? "Vision" : "ASCII"}`;
  function syncURL() {
    const url = new URL(location.href);
    url.searchParams.delete("run");
    for (const id of selected) url.searchParams.append("run", id);
    if (maxMoves === null) url.searchParams.delete("maxMoves"); else url.searchParams.set("maxMoves", maxMoves);
    history.replaceState(null, "", url);
  }
  function renderPicker() {
    $(".gem-selection-count").textContent = `${selected.size} selected`;
    const visible = filtered();
    $(".gem-run-list").innerHTML = visible.length ? visible.map(run => `
      <label class="gem-run-option"><input type="checkbox" value="${escape(run.id)}" ${selected.has(run.id) ? "checked" : ""}>
        <span><strong>${escape(displayModelName(run.model))}</strong><small>${escape(detail(run))} · ${run.created_at ? escape(dates.format(new Date(run.created_at))) : "Undated"} · ${escape(run.id.slice(-6))}</small></span>
        <span class="gem-run-score">${number(fullSeries(run)?.collected ?? comparisonGemCount(run))} gems</span></label>`).join("") : '<p class="gem-empty-list">No matching runs.</p>';
  }
  function changed() {
    syncURL(); renderPicker(); load();
  }
  $(".gem-run-list").addEventListener("change", event => {
    if (!event.target.matches('input[type="checkbox"]')) return;
    if (event.target.checked) selected.add(event.target.value); else selected.delete(event.target.value);
    changed();
  });
  $('input[type="search"]').addEventListener("input", renderPicker);
  $('select[aria-label="Filter runs by coding"]').addEventListener("change", renderPicker);
  $(".gem-select-visible").addEventListener("click", () => { for (const run of filtered()) selected.add(run.id); changed(); });
  $(".gem-clear").addEventListener("click", () => { selected.clear(); changed(); });
  $(".gem-range").addEventListener("change", draw);
  $(".gem-max-moves").addEventListener("input", event => {
    const input = event.target, value = input.value === "" ? null : input.valueAsNumber;
    const valid = !input.validity.badInput && (value === null || Number.isSafeInteger(value) && value > 0);
    input.setCustomValidity(valid ? "" : "Enter a positive whole number, or leave blank for Auto.");
    input.setAttribute("aria-invalid", String(!valid));
    if (!valid) return;
    maxMoves = value; syncURL(); draw();
  });
  $(".gem-max-moves").addEventListener("change", event => event.target.reportValidity());
  $(".gem-max-auto").addEventListener("click", () => {
    maxMoves = null;
    $(".gem-max-moves").value = ""; $(".gem-max-moves").setCustomValidity(""); $(".gem-max-moves").removeAttribute("aria-invalid");
    syncURL(); draw();
  });
  $(".gem-chart-legend").addEventListener("click", event => {
    const button = event.target.closest("button[data-remove]");
    if (button) { selected.delete(button.dataset.remove); changed(); }
  });
  $(".gem-edit-toggle").addEventListener("click", () => {
    editing = !editing; selectedPoint = null;
    $(".gem-edit-status").textContent = ""; draw();
  });
  $(".gem-edit-reset").addEventListener("click", () => {
    for (const id of selected) delete edits[id];
    selectedPoint = null; saveEdits(); renderPicker(); draw();
  });

  async function report(run) {
    if (data.has(run.id)) return data.get(run.id);
    if (requests.has(run.id)) return requests.get(run.id);
    const request = (async () => {
      const response = await benchmarkFetch(`/api/benchmark/v1/runs/${encodeURIComponent(run.id)}/charts`, { signal: AbortSignal.timeout(60000) });
      if (!response.ok) throw new Error(`Couldn’t load history (${response.status})`);
      const result = correctedGemSeries(gemSeries((await response.json()).gems), run.id);
      if (!result) throw new Error("Gem history unavailable");
      data.set(run.id, result); errors.delete(run.id);
      return result;
    })().finally(() => requests.delete(run.id));
    requests.set(run.id, request);
    return request;
  }
  async function load() {
    const token = ++generation;
    if (!active) return;
    loading = true; draw();
    const queue = selectedRuns().filter(run => !data.has(run.id));
    // Keep large selections from flooding the live server with history reads.
    await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
      while (queue.length && token === generation && active) {
        const run = queue.shift();
        try { await report(run); } catch (error) { errors.set(run.id, error.message); }
        if (token === generation) draw();
      }
    }));
    if (token !== generation) return;
    loading = false; renderPicker(); draw();
  }
  function draw() {
    if (!active) return;
    const chosen = selectedRuns();
    const series = chosen.map((run, i) => ({ run, data: limitGemSeries(fullSeries(run), maxMoves), color: color(i), marker: i })).filter(item => item.data);
    const screenshot = document.documentElement.classList.contains("screenshot-mode");
    const handles = editing && !screenshot;
    const svg = $(".gem-chart"), width = Math.max(360, svg.clientWidth || 1000);
    svg.classList.toggle("editing", handles); svg.classList.toggle("dragging", Boolean(drag));
    svg.setAttribute("role", handles ? "group" : "img");
    svg.setAttribute("aria-label", handles ? "Edit gem curves. Focus a point and use arrow keys; Shift moves faster." : "Gems collected by move");
    $(".gem-edit-toggle").setAttribute("aria-pressed", String(editing));
    $(".gem-edit-toggle").textContent = editing ? "Done editing" : "Edit curve";
    $(".gem-edit-reset").disabled = !chosen.some(run => fullSeries(run)?.edited);
    $(".gem-edit-help").textContent = editing ? "Drag a point, or focus it and use arrow keys (Shift for larger steps). Recorded runs stay unchanged." : "Drag points to reshape a curve. Edits are saved in this browser.";
    const labelFont = width < 550 ? 11 : 13;
    const measure = document.createElement("canvas").getContext("2d");
    measure.font = `550 ${labelFont}px -apple-system, BlinkMacSystemFont, sans-serif`;
    const labels = series.map(item => {
      const text = displayModelName(item.run.model);
      return { item, text, measuredWidth: measure.measureText(text).width + 44 };
    });
    const labelSpace = Math.min(width * .45, Math.max(0, ...labels.map(label => label.measuredWidth))) + 24;
    const height = Math.max(Math.min(620, Math.max(330, width * .43)), labels.length * 40 + 110);
    const left = width < 550 ? 48 : 66, right = width - labelSpace - 12, top = 30, bottom = height - 58;
    const xAxis = drag?.xAxis || axisExtent(Math.max(1, ...series.map(item => item.data.moves)), width < 550 ? 3 : 6);
    if (!drag && maxMoves !== null) Object.assign(xAxis, { max: maxMoves, step: axisExtent(maxMoves, width < 550 ? 3 : 6).step });
    const peak = Math.max(1, ...series.flatMap(item => item.data.points.map(point => point.gems)));
    const yAxis = drag?.yAxis || ($(".gem-range").value === "100" ? { max: Math.max(100, peak), step: 20 } : axisExtent(peak));
    const x = move => left + move / xAxis.max * (right - left), y = gems => bottom - gems / yAxis.max * (bottom - top);
    let markup = `<title>Gems collected by move</title><desc>${escape(series.map(item => `${displayModelName(item.run.model)}: ${item.data.collected} gems at ${item.data.moves} moves`).join(". "))}</desc>`;
    for (let value = 0; value <= yAxis.max; value += yAxis.step) markup += `<line class="gem-grid" x1="${left}" x2="${right}" y1="${y(value)}" y2="${y(value)}"/><text class="gem-axis" x="${left - 12}" y="${y(value) + 4}" text-anchor="end">${number(value)}</text>`;
    const xTicks = [];
    for (let value = 0; value < xAxis.max - xAxis.step * .35; value += xAxis.step) xTicks.push(value);
    xTicks.push(xAxis.max);
    for (const value of xTicks) markup += `<line class="gem-grid gem-grid-vertical" x1="${x(value)}" x2="${x(value)}" y1="${top}" y2="${bottom}"/><text class="gem-axis" x="${x(value)}" y="${bottom + 25}" text-anchor="middle">${number(value)}</text>`;
    markup += `<text class="gem-axis-label" x="${left}" y="16">Gems collected</text><text class="gem-axis-label" x="${(left + right) / 2}" y="${height - 8}" text-anchor="middle">Moves</text>`;
    for (const item of series) {
      const points = item.data.points;
      markup += `<g style="--series:${item.color}"><path class="gem-comparison-line" ${item.run.tools_enabled ? 'stroke-dasharray="8 5"' : ""} d="${gemLinePath(points, x, y)}"/>`;
      for (let i = 0; i < points.length; i++) if (i === points.length - 1 || (i > 0 && (handles || points[i].gems !== points[i - 1].gems))) {
        const point = points[i], editable = handles && i > 0 && point.key;
        const focused = selectedPoint?.runId === item.run.id && selectedPoint?.key === point.key;
        const label = `${displayModelName(item.run.model)} · move ${number(point.move)} · ${number(point.gems)} gems`;
        const marker = gemMarker(item.marker, editable ? 7 : 4.5);
        markup += `<g class="gem-comparison-point${editable ? " gem-edit-point" : ""}${focused ? " selected" : ""}" transform="translate(${x(point.move)},${y(point.gems)})"${editable ? ` data-run="${escape(item.run.id)}" data-point="${escape(point.key)}" tabindex="0" role="button" aria-label="${escape(label)}. ${marker.name} marker. Drag or use arrow keys to edit."` : ""}><title>${escape(label)} · ${marker.name}</title>${editable ? '<circle class="gem-point-hit" r="10"/>' : ""}${marker.body}</g>`;
      }
      markup += "</g>";
    }
    const endLabels = layoutEndLabels(labels.map(label => ({ ...label,
      x: x(label.item.data.moves) + 12, y: y(label.item.data.collected),
      width: Math.min(label.measuredWidth, labelSpace - 24)
    })), top + 18, bottom - 18, 40);
    for (const label of endLabels) {
      const nameWidth = label.width - 44;
      const fit = label.measuredWidth > label.width ? ` textLength="${nameWidth}" lengthAdjust="spacingAndGlyphs"` : "";
      const badgeX = label.x + nameWidth + 27;
      markup += `<g style="--series:${label.item.color}"><path class="gem-end-connector" d="M${label.x - 7},${label.y}L${label.x - 3},${label.labelY}"/><text class="gem-end-label" x="${label.x}" y="${label.labelY}" style="font-size:${labelFont}px"${fit}>${escape(label.text)}</text><circle class="gem-end-score-ring" cx="${badgeX}" cy="${label.labelY}" r="17"/><text class="gem-end-score" x="${badgeX}" y="${label.labelY}">${score(label.item.data)}</text></g>`;
    }
    if (!series.length) markup += `<text class="gem-empty" x="${(left + right) / 2}" y="${height / 2}" text-anchor="middle">${loading && chosen.length ? "Loading gem history…" : chosen.length ? "No gem history available" : "Choose runs to compare"}</text>`;
    markup += `<line class="gem-crosshair" x1="0" x2="0" y1="${top}" y2="${bottom}" visibility="hidden"/>`;
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`); svg.style.height = `${height}px`;
    svg.innerHTML = markup;
    $(".gem-tooltip").hidden = true;
    $(".gem-chart-count").textContent = `${series.length} ${series.length === 1 ? "run" : "runs"}${maxMoves === null ? "" : ` · through move ${number(maxMoves)}`}`;
    $(".gem-chart-legend").innerHTML = chosen.map((run, i) => {
      const full = fullSeries(run), value = limitGemSeries(full, maxMoves), duplicate = chosen.filter(item => item.model === run.model).length > 1;
      const marker = gemMarker(i, 5);
      return `<div class="gem-legend-item" style="--series:${color(i)}"><svg class="gem-legend-marker" viewBox="0 0 28 20" role="img" aria-label="${marker.name} markers"><path class="gem-marker-line" d="M0,10H28"${run.tools_enabled ? ' stroke-dasharray="4 3"' : ""}/><g class="gem-comparison-point" transform="translate(14,10)">${marker.body}</g></svg><div><strong>${escape(displayModelName(run.model))}</strong><small>${escape(detail(run))}${duplicate ? ` · ${escape(run.id.slice(-6))}` : ""}${full?.edited ? " · Edited curve" : ""}</small><span>${value ? `${score(value)} · ${number(value.moves)}${value.moves < full.moves ? ` / ${number(full.moves)}` : ""} moves` : escape(errors.get(run.id) || (full ? "No history in this range" : "Loading…"))}</span></div><button type="button" data-remove="${escape(run.id)}" aria-label="Remove ${escape(displayModelName(run.model))} ${escape(run.id.slice(-6))}">×</button></div>`;
    }).join("");
    const notes = series.filter(item => item.data.exclusion).map(item => `${displayModelName(item.run.model)}: ${item.data.exclusion.room} gem excluded.`);
    if (series.some(item => item.data.edited)) notes.push("Edited curves shown.");
    $(".gem-adjustment-note").textContent = notes.join(" ");
    $(".gem-adjustment-note").hidden = !notes.length;
    plot = { x, y, xAxis, yAxis, left, right, top, bottom, width, height, series, move: 0 };
    const status = document.getElementById("comparison-status");
    const failed = chosen.some(run => errors.has(run.id));
    status.classList.toggle("error", failed);
    status.textContent = loading ? `Loading history · ${series.length}/${chosen.length} runs` : failed ? "Some histories couldn’t load · Refresh to retry" : `${series.length} runs compared`;
    onChange();
  }
  function inspect(move) {
    if (!plot?.series.length || document.documentElement.classList.contains("screenshot-mode")) return;
    plot.move = Math.max(0, Math.min(plot.xAxis.max, Math.round(move)));
    const tooltip = $(".gem-tooltip");
    tooltip.innerHTML = `<strong>Move ${number(plot.move)}</strong>` + plot.series.map(item => {
      const value = gemsAt(item.data, plot.move);
      return `<span><i style="background:${item.color}"></i>${escape(displayModelName(item.run.model))}<b>${value === null ? "—" : `${number(value)} gems`}</b></span>`;
    }).join("");
    tooltip.hidden = false;
    tooltip.style.left = `${Math.max(8, Math.min(plot.width - tooltip.offsetWidth - 8, plot.x(plot.move) + 14))}px`;
    const crosshair = $(".gem-crosshair");
    crosshair.setAttribute("x1", plot.x(plot.move)); crosshair.setAttribute("x2", plot.x(plot.move)); crosshair.setAttribute("visibility", "visible");
  }
  function updatePoint(runId, key, position) {
    const run = runs.find(run => run.id === runId), full = run && fullSeries(run);
    const value = moveGemPoint(full, key, position);
    if (!value) return;
    if (!edits[runId] || typeof edits[runId] !== "object" || Array.isArray(edits[runId])) edits[runId] = {};
    edits[runId][key] = value;
    selectedPoint = { runId, key };
    draw();
    $(".gem-edit-status").textContent = `${displayModelName(run.model)} · move ${number(value.move)} · ${number(value.gems)} gems`;
  }
  function finishDrag(cancel = false) {
    if (!drag) return;
    const previous = drag; drag = null;
    const svg = $(".gem-chart");
    if (svg.hasPointerCapture(previous.pointerId)) svg.releasePointerCapture(previous.pointerId);
    if (cancel) { edits[previous.runId] = previous.before; $(".gem-edit-status").textContent = "Drag cancelled."; }
    else saveEdits();
    renderPicker(); draw();
    [...svg.querySelectorAll(".gem-edit-point")].find(point => point.dataset.run === previous.runId && point.dataset.point === previous.key)?.focus({ preventScroll: true });
  }
  $(".gem-chart").addEventListener("pointerdown", event => {
    if (!editing || drag || !plot || event.button !== 0 || document.documentElement.classList.contains("screenshot-mode")) return;
    const point = event.target.closest(".gem-edit-point");
    if (!point) return;
    event.preventDefault();
    const runId = point.dataset.run, key = point.dataset.point;
    drag = { runId, key, pointerId: event.pointerId, before: structuredClone(edits[runId] || {}), xAxis: { ...plot.xAxis }, yAxis: { ...plot.yAxis } };
    selectedPoint = { runId, key };
    event.currentTarget.setPointerCapture(event.pointerId);
    point.focus();
  });
  $(".gem-chart").addEventListener("pointermove", event => {
    if (!plot) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (drag && drag.pointerId === event.pointerId) {
      const move = Math.max(0, Math.min(plot.xAxis.max, ((event.clientX - rect.left) * plot.width / rect.width - plot.left) / (plot.right - plot.left) * plot.xAxis.max));
      const gems = (plot.bottom - (event.clientY - rect.top) * plot.height / rect.height) / (plot.bottom - plot.top) * plot.yAxis.max;
      updatePoint(drag.runId, drag.key, { move, gems: Math.max(0, Math.min(plot.yAxis.max, gems)) });
      return;
    }
    if (editing) return;
    inspect(((event.clientX - rect.left) * plot.width / rect.width - plot.left) / (plot.right - plot.left) * plot.xAxis.max);
  });
  $(".gem-chart").addEventListener("pointerup", event => { if (event.pointerId === drag?.pointerId) finishDrag(); });
  $(".gem-chart").addEventListener("pointercancel", event => { if (event.pointerId === drag?.pointerId) finishDrag(true); });
  $(".gem-chart").addEventListener("lostpointercapture", event => { if (event.pointerId === drag?.pointerId) finishDrag(true); });
  $(".gem-chart").addEventListener("pointerleave", () => { $(".gem-tooltip").hidden = true; $(".gem-crosshair")?.setAttribute("visibility", "hidden"); });
  $(".gem-chart").addEventListener("keydown", event => {
    if (drag && event.key === "Escape") { event.preventDefault(); finishDrag(true); return; }
    const point = event.target.closest(".gem-edit-point");
    if (editing && point && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      event.preventDefault();
      const runId = point.dataset.run, key = point.dataset.point, run = runs.find(run => run.id === runId);
      const current = fullSeries(run).points.find(point => point.key === key);
      const moveStep = event.shiftKey ? Math.max(10, Math.round(plot.xAxis.max / 100)) : 1;
      updatePoint(runId, key, { move: current.move + (event.key === "ArrowRight" ? moveStep : event.key === "ArrowLeft" ? -moveStep : 0),
        gems: current.gems + (event.key === "ArrowUp" ? 1 : event.key === "ArrowDown" ? -1 : 0) * (event.shiftKey ? 5 : 1) });
      saveEdits(); renderPicker();
      [...$(".gem-chart").querySelectorAll(".gem-edit-point")].find(point => point.dataset.run === runId && point.dataset.point === key)?.focus();
      return;
    }
    if (!plot || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    inspect(event.key === "Home" ? 0 : event.key === "End" ? plot.xAxis.max : plot.move + (event.key === "ArrowRight" ? 1 : -1) * Math.max(1, Math.round(plot.xAxis.max / 100)));
  });
  new ResizeObserver(draw).observe($(".gem-plot"));
  return {
    draw, load,
    canScreenshot: () => !loading && selectedRuns().some(run => data.has(run.id)),
    setActive(value) { if (!value) finishDrag(true); active = value; root.hidden = !value; if (!value) { generation++; loading = false; } },
    setRuns(value, defaults) {
      finishDrag(true);
      runs = selectRuns(value.filter(run => !run.source), { sort: "company" });
      if (!initialized) {
        initialized = true;
        if (!selected.size) for (const id of defaults) if (runs.some(run => run.id === id)) selected.add(id);
        if (!selected.size) for (const run of value.filter(run => !run.source).slice(0, 3)) selected.add(run.id);
      }
      for (const id of selected) if (!runs.some(run => run.id === id)) selected.delete(id);
      data.clear(); errors.clear(); renderPicker();
    }
  };
}
