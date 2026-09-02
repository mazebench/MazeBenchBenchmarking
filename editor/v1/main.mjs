import { ThreeMazeRendererV1 } from "../../render/v1/three-renderer.mjs";
import {
  cellForTool,
  describeCell,
  loadMainWorld,
  serializeLevel
} from "../../render/v1/world-renderer.mjs";
import { renderToolboxPreviews } from "./toolbox-previews.mjs";

const elements = {
  stage: document.getElementById("stage"),
  canvas: document.getElementById("editor-canvas"),
  loading: document.getElementById("loading"),
  roomName: document.getElementById("room-name"),
  roomSelect: document.getElementById("room-select"),
  roomGrid: document.getElementById("room-grid"),
  fileName: document.getElementById("file-name"),
  gemCount: document.getElementById("gem-count"),
  toolbox: document.getElementById("toolbox"),
  toolName: document.getElementById("tool-name"),
  toolDescription: document.getElementById("tool-description"),
  cellPosition: document.getElementById("cell-position"),
  cellValue: document.getElementById("cell-value"),
  applyCell: document.getElementById("apply-cell"),
  resetView: document.getElementById("reset-view"),
  undo: document.getElementById("undo"),
  save: document.getElementById("save"),
  status: document.getElementById("status")
};

let world;
let parser;
let toolboxCatalog;
let renderer;
let currentRoom;
let currentTool = ".";
let selectedCell = null;
let undoStack = [];
let savedCells = null;
let dirty = false;

const cloneCells = (cells) => cells.map((row) => row.slice());

function setStatus(message, error = false) {
  elements.status.textContent = message;
  elements.status.classList.toggle("is-error", error);
}

function countToken(cells, expected) {
  let count = 0;
  cells.forEach((row) => row.forEach((cell) => {
    String(cell).split("+").forEach((token) => {
      if (token.trim() === expected) count += 1;
    });
  }));
  return count;
}

function markDirty(message = "Unsaved changes.") {
  dirty = true;
  elements.save.textContent = "Save";
  elements.save.classList.add("primary");
  elements.gemCount.textContent = String(countToken(currentRoom.cells, "G"));
  setStatus(message);
}

function markSaved() {
  dirty = false;
  savedCells = cloneCells(currentRoom.cells);
  elements.save.textContent = "Saved";
  elements.save.classList.remove("primary");
  setStatus(`Saved ${currentRoom.fileName}.`);
}

function pushUndo() {
  undoStack.push(cloneCells(currentRoom.cells));
  if (undoStack.length > 50) undoStack.shift();
  elements.undo.disabled = false;
}

function inspect(hit) {
  if (!hit) return;
  selectedCell = { x: hit.cellX, y: hit.cellY };
  elements.cellPosition.textContent = `${hit.cellX}, ${hit.cellY}`;
  elements.cellValue.disabled = false;
  elements.applyCell.disabled = false;
  elements.cellValue.value = currentRoom.cells[hit.cellY]?.[hit.cellX] ?? "";
  renderer.selectCell(renderer.world.rooms[0], hit.cellX, hit.cellY);
}

function removePlayer() {
  currentRoom.cells = currentRoom.cells.map((row) => row.map((cell) => {
    const tokens = String(cell).split("+").map((token) => token.trim() === "p" ? "" : token);
    return tokens.join("+") || "+";
  }));
}

function paint(hit, gesture) {
  if (gesture.start) pushUndo();
  if (currentTool === "p") removePlayer();
  currentRoom.cells[hit.cellY][hit.cellX] = cellForTool(currentTool);
  renderer.setRoom(currentRoom, { preserveCamera: true });
  inspect({ ...hit, room: renderer.world.rooms[0], cell: currentRoom.cells[hit.cellY][hit.cellX] });
  markDirty(`Painted ${toolName(currentTool)} at ${hit.cellX}, ${hit.cellY}.`);
}

function parserTools() {
  const result = ["__erase_top__"];
  Object.values(parser.objects || {}).forEach((definition) => {
    if (typeof definition.token === "string") result.push(definition.token);
    if (Array.isArray(definition.tokens)) {
      definition.tokens.forEach((entry) => result.push(typeof entry === "string" ? entry : entry.token));
    }
  });
  return [...new Set(result.filter(Boolean))];
}

function parserLabel(token) {
  for (const [name, definition] of Object.entries(parser.objects || {})) {
    if (definition.token === token) return definition.label || name.replaceAll("_", " ");
    for (const entry of definition.tokens || []) {
      if ((typeof entry === "string" ? entry : entry.token) === token) {
        return (typeof entry === "object" && entry.label) || definition.label || name.replaceAll("_", " ");
      }
    }
  }
  return token;
}

function toolName(token) {
  return toolboxCatalog.tools?.[token]?.name || parserLabel(token) || token;
}

function toolDescription(token) {
  if (toolboxCatalog.tools?.[token]?.description) return toolboxCatalog.tools[token].description;
  const baseToken = token.replace(/^S[rlud]/, "Sr");
  return toolboxCatalog.tools?.[baseToken]?.description || `Paint the raw MazeBench token ${token}.`;
}

function setTool(token) {
  currentTool = token;
  elements.toolName.textContent = toolName(token);
  elements.toolDescription.textContent = toolDescription(token);
  elements.toolbox.querySelectorAll(".tool").forEach((button) => {
    button.classList.toggle("is-current", button.dataset.token === token);
  });
}

function buildToolbox() {
  const fragment = document.createDocumentFragment();
  const previews = [];
  parserTools().forEach((token) => {
    const button = document.createElement("button");
    const descriptor = describeCell(cellForTool(token));
    const visual = descriptor.actor || descriptor.terrain;
    button.type = "button";
    button.className = "tool";
    button.dataset.token = token;
    button.title = `${toolName(token)} — ${token}`;
    button.setAttribute("aria-label", `${toolName(token)} — ${token}`);
    button.style.setProperty("--tool-color", visual?.color || "#050608");
    const canvas = document.createElement("canvas");
    canvas.width = 96;
    canvas.height = 96;
    canvas.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.textContent = token === "__erase_top__" ? "×" : token;
    button.append(canvas, label);
    button.addEventListener("click", () => setTool(token));
    fragment.append(button);
    if (token !== "__erase_top__") previews.push({ button, canvas, token });
  });
  elements.toolbox.replaceChildren(fragment);
  setTool(currentTool);
  renderToolboxPreviews(previews).catch((error) => {
    console.warn("Toolbox previews could not be rendered.", error);
  });
}

function buildRoomControls() {
  const sorted = world.rooms.slice().sort((a, b) => a.rowIndex - b.rowIndex || a.columnIndex - b.columnIndex);
  sorted.forEach((room) => {
    const label = room.position.join("×");
    const option = document.createElement("option");
    option.value = room.fileName;
    option.textContent = label;
    elements.roomSelect.append(option);
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.file = room.fileName;
    button.title = `${label} — ${room.fileName}`;
    button.setAttribute("aria-label", `Open room ${label}`);
    button.addEventListener("click", () => switchRoom(room));
    elements.roomGrid.append(button);
  });
  elements.roomSelect.addEventListener("change", () => {
    const room = world.rooms.find((candidate) => candidate.fileName === elements.roomSelect.value);
    if (room) switchRoom(room);
  });
}

function updateRoomChrome() {
  const label = currentRoom.position.join("×");
  elements.roomName.textContent = label;
  elements.fileName.textContent = currentRoom.fileName;
  elements.fileName.title = currentRoom.fileName;
  elements.gemCount.textContent = String(countToken(currentRoom.cells, "G"));
  elements.roomSelect.value = currentRoom.fileName;
  elements.roomGrid.querySelectorAll("button").forEach((button) => {
    button.classList.toggle("is-current", button.dataset.file === currentRoom.fileName);
  });
  const url = new URL(location.href);
  url.searchParams.set("room", currentRoom.position.join("x"));
  history.replaceState(null, "", url);
}

function switchRoom(room) {
  if (room === currentRoom) return;
  if (dirty && !confirm(`Discard unsaved changes to room ${currentRoom.position.join("×")}?`)) {
    elements.roomSelect.value = currentRoom.fileName;
    return;
  }
  if (dirty) currentRoom.cells = cloneCells(savedCells);
  currentRoom = room;
  savedCells = cloneCells(room.cells);
  undoStack = [];
  dirty = false;
  selectedCell = null;
  elements.undo.disabled = true;
  elements.cellValue.disabled = true;
  elements.applyCell.disabled = true;
  elements.cellPosition.textContent = "—";
  renderer.setRoom(room);
  updateRoomChrome();
  elements.save.textContent = "Saved";
  elements.save.classList.remove("primary");
  setStatus(`Editing room ${room.position.join("×")}.`);
}

function remapDirectionalCell(cell, transform) {
  const maps = {
    right: { u: "r", r: "d", d: "l", l: "u" },
    left: { u: "l", l: "d", d: "r", r: "u" },
    horizontal: { u: "u", d: "d", l: "r", r: "l" },
    vertical: { u: "d", d: "u", l: "l", r: "r" }
  };
  return String(cell).split("+").map((token) => {
    const slope = token.match(/^S([rlud])(.*)$/);
    if (slope) return `S${maps[transform][slope[1]]}${slope[2]}`;
    const puncher = token.match(/^p([rlud])$/);
    if (puncher) return `p${maps[transform][puncher[1]]}`;
    return token;
  }).join("+");
}

function transformRoom(transform) {
  pushUndo();
  const source = currentRoom.cells;
  let transformed;
  if (transform === "right") {
    transformed = source[0].map((_, x) => source.map((row) => row[x]).reverse());
  } else if (transform === "left") {
    transformed = source[0].map((_, x) => source.map((row) => row[row.length - 1 - x]));
  } else if (transform === "horizontal") {
    transformed = source.map((row) => row.slice().reverse());
  } else {
    transformed = source.slice().reverse().map((row) => row.slice());
  }
  currentRoom.cells = transformed.map((row) => row.map((cell) => remapDirectionalCell(cell, transform)));
  renderer.setRoom(currentRoom, { preserveCamera: true });
  markDirty(`${transform} transform applied.`);
}

async function saveRoom() {
  elements.save.disabled = true;
  setStatus(`Saving ${currentRoom.fileName}…`);
  try {
    const response = await fetch(`/api/levels/${encodeURIComponent(currentRoom.fileName)}`, {
      method: "PUT",
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: serializeLevel(currentRoom.cells, currentRoom.trailingNewline)
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Save failed.");
    markSaved();
  } catch (error) {
    setStatus(error.message || "Save failed.", true);
  } finally {
    elements.save.disabled = false;
  }
}

elements.resetView.addEventListener("click", () => renderer?.resetView());
elements.save.addEventListener("click", saveRoom);
elements.undo.addEventListener("click", () => {
  const previous = undoStack.pop();
  if (!previous) return;
  currentRoom.cells = previous;
  renderer.setRoom(currentRoom, { preserveCamera: true });
  elements.undo.disabled = undoStack.length === 0;
  markDirty("Undid the last edit.");
});
elements.applyCell.addEventListener("click", () => {
  if (!selectedCell) return;
  pushUndo();
  currentRoom.cells[selectedCell.y][selectedCell.x] = elements.cellValue.value || "+";
  renderer.setRoom(currentRoom, { preserveCamera: true });
  renderer.selectCell(renderer.world.rooms[0], selectedCell.x, selectedCell.y);
  markDirty(`Applied raw value at ${selectedCell.x}, ${selectedCell.y}.`);
});
document.querySelectorAll("[data-transform]").forEach((button) => {
  button.addEventListener("click", () => transformRoom(button.dataset.transform));
});
window.addEventListener("beforeunload", (event) => {
  if (!dirty) return;
  event.preventDefault();
  event.returnValue = "";
});
window.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    saveRoom();
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
    event.preventDefault();
    elements.undo.click();
  }
});

try {
  [world, parser, toolboxCatalog] = await Promise.all([
    loadMainWorld((complete, total) => {
      if (complete % 32 === 0 || complete === total) elements.loading.textContent = `Loading ${complete}/${total}`;
    }),
    fetch("./level_parsing.json").then((response) => response.json()),
    fetch("./toolbox.json").then((response) => response.json())
  ]);
  buildToolbox();
  buildRoomControls();
  const requested = new URL(location.href).searchParams.get("room")?.toUpperCase();
  currentRoom = world.rooms.find((room) => room.position.join("X") === requested) || world.rooms[0];
  savedCells = cloneCells(currentRoom.cells);
  renderer = new ThreeMazeRendererV1(elements.canvas, {
    columns: [currentRoom.position[0]],
    rows: [currentRoom.position[1]],
    roomWidth: currentRoom.cells[0].length,
    roomHeight: currentRoom.cells.length,
    rooms: [{ ...currentRoom, columnIndex: 0, rowIndex: 0 }]
  }, {
    mode: "editor",
    onInspect: inspect,
    onSelect: inspect,
    onPaint: paint
  });
  new ResizeObserver(() => renderer.resize()).observe(elements.stage);
  updateRoomChrome();
  elements.stage.classList.add("is-ready");
  setStatus(`Editing room ${currentRoom.position.join("×")}.`);
} catch (error) {
  elements.loading.textContent = error.message || "Could not load editor.";
  setStatus("Editor failed to load.", true);
  console.error(error);
}
