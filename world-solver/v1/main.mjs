import { engineRoleIdForObject } from "../../engine/v1/adapter.mjs";
import { loadMainWorldV2 } from "../../render/v1/voxel-world-v2.mjs";
import {
  invalidateStaleRoomsV1,
  masterRouteForNodeV1,
  roomRevisionV1,
  WORLD_SOLVER_FORMAT_V1,
  worldAnalysisStatsV1
} from "./analysis.mjs";

const elements = Object.fromEntries([
  "status", "world-grid", "start-room", "maximum-nodes", "maximum-states",
  "maximum-per-room", "maximum-edges", "run", "exact", "fresh", "stop",
  "rooms", "entries", "transitions", "pending", "gems", "best-gems",
  "review-title", "review-body", "download"
].map((id) => [id.replaceAll("-", ""), document.getElementById(id)]));
const arrows = { up: "↑", right: "→", down: "↓", left: "←" };
let world;
let analysis = null;
let worker = null;
let selectedRoomFileName = null;

function setStatus(message, error = false) {
  elements.status.textContent = message;
  elements.status.style.color = error ? "#ff7b72" : "";
}

function setBusy(busy) {
  elements.run.disabled = busy;
  elements.exact.disabled = busy;
  elements.fresh.disabled = busy;
  elements.stop.disabled = !busy;
}

function playerIn(state) {
  return state?.objects?.find((object) => object.x >= 0 && object.y >= 0 &&
    engineRoleIdForObject(object, world.blockDefinitions) === "player");
}

function marker(room, kind, point, transitionId = null, offset = 0) {
  if (!room || !point) return;
  const cell = elements.worldgrid.querySelector(`[data-file="${CSS.escape(room.fileName)}"]`);
  if (!cell) return;
  const item = document.createElement("i");
  item.className = `marker ${kind}`;
  item.style.left = `${((point.x + 0.5) / room.width) * 100 + (offset % 3 - 1) * 1.3}%`;
  item.style.top = `${((point.y + 0.5) / room.height) * 100 + (Math.floor(offset / 3) % 3 - 1) * 1.3}%`;
  if (transitionId !== null) item.dataset.transition = transitionId;
  item.title = kind === "start" ? "Authored player start" : `${kind} · transition ${transitionId}`;
  cell.append(item);
}

function renderMap() {
  if (!world) return;
  const discovered = new Set((analysis?.nodes || []).map((node) => node.roomFileName));
  elements.worldgrid.querySelectorAll(".room").forEach((cell) => {
    cell.classList.toggle("discovered", discovered.has(cell.dataset.file));
    cell.classList.toggle("selected", cell.dataset.file === selectedRoomFileName);
    cell.querySelectorAll(".marker").forEach((item) => item.remove());
  });
  const root = analysis?.nodes?.find((node) => node.parentId === null);
  const startRoom = world.rooms.find((room) => room.fileName === root?.roomFileName) ||
    world.rooms.find((room) => room.fileName === elements.startroom.value);
  marker(startRoom, "start", playerIn(root?.state || startRoom), null);
  const counts = new Map();
  for (const transition of analysis?.transitions || []) {
    for (const hop of transition.hops || []) {
      const from = world.rooms.find((room) => room.fileName === hop.fromRoomFileName);
      const to = world.rooms.find((room) => room.fileName === hop.toRoomFileName);
      const exitKey = `${hop.fromRoomFileName}:${hop.exit?.x}:${hop.exit?.y}:exit`;
      const entryKey = `${hop.toRoomFileName}:${hop.entry?.x}:${hop.entry?.y}:entry`;
      marker(from, "exit", hop.exit, transition.id, counts.get(exitKey) || 0);
      marker(to, "entry", hop.entry, transition.id, counts.get(entryKey) || 0);
      counts.set(exitKey, (counts.get(exitKey) || 0) + 1);
      counts.set(entryKey, (counts.get(entryKey) || 0) + 1);
    }
  }
}

function updateStats(stats = worldAnalysisStatsV1(analysis)) {
  elements.rooms.textContent = stats.rooms;
  elements.entries.textContent = stats.entryStates;
  elements.transitions.textContent = stats.transitions;
  elements.pending.textContent = stats.pendingStates;
  elements.gems.textContent = stats.reachableGems;
  elements.bestgems.textContent = stats.bestRouteGems;
}

function routeLabel(solution) {
  return solution.map((direction) => arrows[direction] || direction).join(" ");
}

function reviewTransition(id) {
  const transition = analysis?.transitions.find((candidate) => candidate.id === Number(id));
  if (!transition) return;
  const source = analysis.nodes.find((node) => node.id === transition.fromNodeId);
  const destination = analysis.nodes.find((node) => node.id === transition.toNodeId);
  const master = [...masterRouteForNodeV1(analysis, source.id), ...transition.solution];
  elements.reviewtitle.textContent = `Transition ${transition.id}`;
  elements.reviewbody.innerHTML = `
    <p>${source.roomFileName} → ${destination.roomFileName}</p>
    <p>${transition.hops.length} room seam${transition.hops.length === 1 ? "" : "s"} in the final command · ${destination.collectedGemIds.length} unique gems</p>
    <p><b>Local witness</b><br><code>${routeLabel(transition.solution)}</code></p>
    <p><b>Master route</b> · ${master.length} commands<br><code>${routeLabel(master)}</code></p>`;
}

function reviewRoom(fileName) {
  selectedRoomFileName = fileName;
  renderMap();
  const room = world.rooms.find((candidate) => candidate.fileName === fileName);
  const nodes = analysis?.nodes.filter((node) => node.roomFileName === fileName) || [];
  const transitions = analysis?.transitions.filter((edge) => edge.hops?.some((hop) =>
    hop.fromRoomFileName === fileName || hop.toRoomFileName === fileName)) || [];
  elements.reviewtitle.textContent = `Room ${room.position.join("×")}`;
  if (!nodes.length && !transitions.length) {
    elements.reviewbody.textContent = "This room has not been reached.";
    return;
  }
  elements.reviewbody.innerHTML = `<p>${nodes.length} exact entry state${nodes.length === 1 ? "" : "s"} · ${transitions.length} routed transition${transitions.length === 1 ? "" : "s"}</p>`;
  for (const transition of transitions) {
    const button = document.createElement("button");
    button.className = "route";
    button.dataset.reviewTransition = transition.id;
    button.innerHTML = `<b>Transition ${transition.id}</b><code>${routeLabel(transition.solution)}</code>`;
    elements.reviewbody.append(button);
  }
}

function displayAnalysis(next) {
  analysis = next;
  elements.download.disabled = !analysis;
  updateStats();
  renderMap();
  if (selectedRoomFileName) reviewRoom(selectedRoomFileName);
}

function run({ exact = false, resume = true } = {}) {
  worker?.terminate();
  worker = new Worker(new URL("./worker.mjs", import.meta.url), { type: "module", name: "mazebench-world-solver-v1" });
  setBusy(true);
  if (exact) elements.maximumnodes.value = "180000";
  worker.addEventListener("message", (event) => {
    const message = event.data || {};
    if (message.type === "progress") {
      updateStats(message.stats);
      setStatus(message.message);
      return;
    }
    if (message.type === "complete") {
      displayAnalysis(message.analysis);
      setStatus(message.analysis.complete
        ? "Exact reachable graph complete and saved."
        : `Saved partial graph · ${message.analysis.omittedStates || 0} states omitted by limits.`);
      worker.terminate(); worker = null; setBusy(false);
    } else if (message.type === "error") {
      setStatus(message.error, true); worker.terminate(); worker = null; setBusy(false);
    }
  });
  worker.postMessage({
    scope: "world",
    startRoomFileName: elements.startroom.value,
    maximumNodes: Number(elements.maximumnodes.value),
    maximumStates: Number(elements.maximumstates.value),
    maximumStatesPerRoom: Number(elements.maximumperroom.value),
    maximumEdges: Number(elements.maximumedges.value),
    resume
  });
}

elements.run.addEventListener("click", () => run());
elements.exact.addEventListener("click", () => run({ exact: true }));
elements.fresh.addEventListener("click", () => run({ resume: false }));
elements.stop.addEventListener("click", () => {
  worker?.terminate(); worker = null; setBusy(false); setStatus("World solver stopped; the last completed save is intact.");
});
elements.download.addEventListener("click", () => {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([`${JSON.stringify(analysis, null, 2)}\n`], { type: "application/json" }));
  link.download = "mazebench-world-solver-v1.json";
  link.click();
  URL.revokeObjectURL(link.href);
});
elements.worldgrid.addEventListener("click", (event) => {
  const transition = event.target.closest("[data-transition]");
  if (transition) return reviewTransition(transition.dataset.transition);
  const room = event.target.closest(".room");
  if (room) reviewRoom(room.dataset.file);
});
elements.reviewbody.addEventListener("click", (event) => {
  const route = event.target.closest("[data-review-transition]");
  if (route) reviewTransition(route.dataset.reviewTransition);
});

try {
  world = await loadMainWorldV2((complete, total) => setStatus(`Loading rooms ${complete}/${total}…`));
  for (const room of world.rooms) {
    const option = document.createElement("option");
    option.value = room.fileName;
    option.textContent = room.position.join("×");
    elements.startroom.append(option);
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "room";
    cell.dataset.file = room.fileName;
    cell.dataset.label = room.position.join("×");
    cell.title = `${room.position.join("×")} · ${room.fileName}`;
    cell.style.gridColumn = room.columnIndex + 1;
    cell.style.gridRow = room.rowIndex + 1;
    elements.worldgrid.append(cell);
  }
  const saved = await fetch("/api/world-solver/v1").then((response) => response.ok ? response.json() : null);
  if (saved?.format === WORLD_SOLVER_FORMAT_V1) {
    const revisions = Object.fromEntries(world.rooms.map((room) => [room.fileName, roomRevisionV1(room)]));
    const checked = invalidateStaleRoomsV1(saved, revisions);
    displayAnalysis(checked.analysis);
    elements.startroom.value = checked.analysis.startRoomFileName;
    setStatus(`Loaded saved graph · ${checked.invalidatedNodes} stale states removed.`);
  } else {
    elements.startroom.value = world.rooms[0].fileName;
    displayAnalysis(null);
    setStatus("Ready. Run the solver to discover connected entry states.");
  }
} catch (error) {
  setStatus(error.message || "World solver failed to load.", true);
}
