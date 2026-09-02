import { ThreeMazeRendererV1 } from "../../render/v1/three-renderer.mjs";
import { cellForTool, describeCell } from "../../render/v1/world-renderer.mjs";
import { encodeVoxelRoom, loadMainWorldV2 } from "../../render/v1/voxel-world-v2.mjs";
import {
  eraseOneObjectAtCell,
  objectPaintsInsideClickedBody,
  objectsAtCell,
  placeObjectInCell
} from "../../render/v1/cell-objects-v2.mjs";
import { renderToolboxPreviews } from "./toolbox-previews.mjs";
import { isDirectionalTool, parserToolTokens, portraitToken } from "./directional-tools.mjs";
import {
  resolveEditorPaintTargetV2,
  rotateVoxelObject,
  voxelPlacementForTool
} from "./face-placement-v2.mjs";

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
let savedObjects = null;
let dirty = false;

const cloneObjects = (objects) => objects.map((object) => ({ ...object }));
const countBlock = (objects, blockId) => objects.filter((object) => object.blockId === blockId).length;
const coordinateLabel = ({ x, y, z }) => `${x}, ${y}, ${z}`;

function setStatus(message, error = false) {
  elements.status.textContent = message;
  elements.status.classList.toggle("is-error", error);
}

function markDirty(message = "Unsaved changes.") {
  dirty = true;
  elements.save.textContent = "Save";
  elements.save.classList.add("primary");
  elements.gemCount.textContent = String(countBlock(currentRoom.objects, "gem"));
  setStatus(message);
}

function markSaved() {
  dirty = false;
  savedObjects = cloneObjects(currentRoom.objects);
  elements.save.textContent = "Saved";
  elements.save.classList.remove("primary");
  setStatus(`Saved ${currentRoom.fileName}.`);
}

function pushUndo() {
  undoStack.push(cloneObjects(currentRoom.objects));
  if (undoStack.length > 50) undoStack.shift();
  elements.undo.disabled = false;
}

function inspectCoordinate(coordinate) {
  selectedCell = { ...coordinate };
  elements.cellPosition.textContent = coordinateLabel(coordinate);
  elements.cellValue.disabled = false;
  elements.applyCell.disabled = false;
  elements.cellValue.value = JSON.stringify(objectsAtCell(currentRoom.objects, coordinate), null, 2);
  renderer.selectCell(renderer.world.rooms[0], coordinate.x, coordinate.y, coordinate.z);
}

function inspect(hit) {
  if (!hit) return;
  inspectCoordinate({
    x: hit.sourceX ?? hit.cellX,
    y: hit.sourceY ?? hit.cellY,
    z: hit.sourceZ ?? 0
  });
}

function paint(hit, gesture) {
  const erase = currentTool === "__erase_top__";
  if (gesture.start) pushUndo();

  if (erase) {
    const coordinate = resolveEditorPaintTargetV2(hit, { erase: true });
    const result = eraseOneObjectAtCell(currentRoom.objects, coordinate, hit.selectionKey);
    if (!result.changed) return;
    currentRoom.objects = result.objects;
    renderer.setRoom(currentRoom, { preserveCamera: true });
    inspectCoordinate(coordinate);
    markDirty(`Erased ${result.removed.blockId} at ${coordinateLabel(coordinate)}.`);
    return;
  }

  const preview = voxelPlacementForTool(currentTool, { x: 0, y: 0, z: 0 }, hit, renderer.cameraDirections());
  if (!preview) {
    setStatus("That object cannot be mounted on this face.", true);
    return;
  }
  const selectedBlock = world.blockDefinitions.get(preview.blockId);
  const coordinate = resolveEditorPaintTargetV2(hit, {
    selectedCanShare: objectPaintsInsideClickedBody(selectedBlock)
  });
  if (["floor", "ice-floor", "exit"].includes(preview.blockId)) coordinate.z = 0;
  if (coordinate.x < 0 || coordinate.y < 0 || coordinate.x >= currentRoom.width || coordinate.y >= currentRoom.height) {
    setStatus("That face points outside this room.", true);
    return;
  }
  const placement = voxelPlacementForTool(currentTool, coordinate, hit, renderer.cameraDirections());
  if (!placement) {
    setStatus("That object cannot be mounted on this face.", true);
    return;
  }
  if (placement.blockId === "player") {
    currentRoom.objects = currentRoom.objects.filter((object) => object.blockId !== "player");
  }
  const result = placeObjectInCell(currentRoom.objects, placement, world.blockDefinitions);
  if (!result.changed) return;
  currentRoom.objects = result.objects;
  renderer.setRoom(currentRoom, { preserveCamera: true });
  inspectCoordinate(placement);
  markDirty(`Placed ${toolName(currentTool)} at ${coordinateLabel(placement)}.`);
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
  return toolboxCatalog.tools?.[baseToken]?.description || `Place the MazeBench ${token} object.`;
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
  parserToolTokens(parser).forEach((token) => {
    const button = document.createElement("button");
    const descriptor = describeCell(cellForTool(token));
    const visual = descriptor.actor || descriptor.terrain;
    button.type = "button";
    button.className = "tool";
    button.dataset.token = token;
    const directionHint = isDirectionalTool(parser, token) ? " — faces camera when placed" : "";
    button.title = `${toolName(token)} — ${token}${directionHint}`;
    button.setAttribute("aria-label", `${toolName(token)}${directionHint}`);
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
    if (token !== "__erase_top__") previews.push({ button, canvas, token: portraitToken(parser, token) });
  });
  elements.toolbox.replaceChildren(fragment);
  setTool(currentTool);
  renderToolboxPreviews(previews).catch((error) => console.warn("Toolbox previews could not be rendered.", error));
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
  elements.gemCount.textContent = String(countBlock(currentRoom.objects, "gem"));
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
  if (dirty) currentRoom.objects = cloneObjects(savedObjects);
  currentRoom = room;
  savedObjects = cloneObjects(room.objects);
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
  setStatus(`Editing v2 room ${room.position.join("×")}.`);
}

function transformRoom(transform) {
  pushUndo();
  currentRoom.objects = currentRoom.objects.map((object) =>
    rotateVoxelObject(object, transform, currentRoom.width, currentRoom.height));
  renderer.setRoom(currentRoom, { preserveCamera: true });
  selectedCell = null;
  elements.cellValue.disabled = true;
  elements.applyCell.disabled = true;
  elements.cellPosition.textContent = "—";
  markDirty(`${transform} transform applied.`);
}

async function saveRoom() {
  elements.save.disabled = true;
  setStatus(`Saving ${currentRoom.fileName}…`);
  try {
    const response = await fetch(`/api/v2/levels/${encodeURIComponent(currentRoom.fileName)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(encodeVoxelRoom(currentRoom))
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
  currentRoom.objects = previous;
  renderer.setRoom(currentRoom, { preserveCamera: true });
  elements.undo.disabled = undoStack.length === 0;
  markDirty("Undid the last edit.");
});
elements.applyCell.addEventListener("click", () => {
  if (!selectedCell) return;
  try {
    const parsed = JSON.parse(elements.cellValue.value || "[]");
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    const replacements = entries.map((entry) => {
      if (!entry || typeof entry !== "object" || !world.blockDefinitions.has(entry.blockId)) {
        throw new Error("Every 3D object needs a known blockId.");
      }
      return { ...entry, ...selectedCell };
    });
    pushUndo();
    const selectedKey = coordinateLabel(selectedCell);
    currentRoom.objects = [
      ...currentRoom.objects.filter((object) => coordinateLabel(object) !== selectedKey),
      ...replacements
    ];
    renderer.setRoom(currentRoom, { preserveCamera: true });
    inspectCoordinate(selectedCell);
    markDirty(`Applied ${replacements.length} object${replacements.length === 1 ? "" : "s"} at ${coordinateLabel(selectedCell)}.`);
  } catch (error) {
    setStatus(error.message || "Invalid object JSON.", true);
  }
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
    loadMainWorldV2((complete, total) => {
      if (complete % 32 === 0 || complete === total) elements.loading.textContent = `Loading v2 ${complete}/${total}`;
    }),
    fetch("./level_parsing.json").then((response) => response.json()),
    fetch("./toolbox.json").then((response) => response.json())
  ]);
  buildToolbox();
  buildRoomControls();
  const requested = new URL(location.href).searchParams.get("room")?.toUpperCase();
  currentRoom = world.rooms.find((room) => room.position.join("X") === requested) || world.rooms[0];
  savedObjects = cloneObjects(currentRoom.objects);
  renderer = new ThreeMazeRendererV1(elements.canvas, {
    ...world,
    columns: [currentRoom.position[0]],
    rows: [currentRoom.position[1]],
    roomWidth: currentRoom.width,
    roomHeight: currentRoom.height,
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
  setStatus(`Editing v2 room ${currentRoom.position.join("×")}.`);
} catch (error) {
  elements.loading.textContent = error.message || "Could not load editor.";
  setStatus("Editor failed to load.", true);
  console.error(error);
}
