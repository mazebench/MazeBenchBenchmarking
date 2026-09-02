import { loadMazeBenchEngineV1 } from "../../engine/v1/engine.mjs";
import { AsciiMazeRendererV1 } from "../../render-ascii/v1/ascii-renderer.mjs";
import { ThreeMazeRendererV1 } from "../../render/v1/three-renderer.mjs";
import { loadMainWorldV2 } from "../../render/v1/voxel-world-v2.mjs";
import { PlaySessionV1 } from "./play-session.mjs";
import { installRoomControlsV1 } from "./room-controls.mjs";

const elements = {
  stage: document.getElementById("stage"),
  canvas: document.getElementById("play-canvas"),
  asciiView: document.getElementById("ascii-view"),
  asciiBoard: document.getElementById("ascii-board"),
  asciiCamera: document.getElementById("ascii-camera"),
  asciiLegend: document.getElementById("ascii-legend"),
  asciiSeed: document.getElementById("ascii-seed"),
  seededGlyphs: document.getElementById("seeded-glyphs"),
  cameraHelp: document.getElementById("camera-help"),
  loading: document.getElementById("loading"),
  roomName: document.getElementById("room-name"),
  roomSelect: document.getElementById("room-select"),
  roomGrid: document.getElementById("room-grid"),
  fileName: document.getElementById("file-name"),
  moveCount: document.getElementById("move-count"),
  gemCount: document.getElementById("gem-count"),
  state: document.getElementById("play-state"),
  reset: document.getElementById("reset"),
  undo: document.getElementById("undo"),
  viewToggle: document.getElementById("view-toggle"),
  editorLink: document.getElementById("editor-link"),
  directionButtons: [...document.querySelectorAll("[data-direction]")]
};

let world;
let engine;
let renderer;
let asciiRenderer;
let session;
let currentRoom;
let markCurrentRoom;
let viewMode = "3d";
let asciiPitch = 1;
let lastAsciiPitchStep = 0;

const ASCII_VIEW_NAMES = Object.freeze([
  "top",
  "top-diagonal",
  "diagonal",
  "side-diagonal",
  "side"
]);

function isEditableTarget(target) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || ["SELECT", "TEXTAREA"].includes(target.tagName)) return true;
  if (target.tagName !== "INPUT") return false;
  return !["button", "checkbox", "radio", "range"].includes(target.type);
}

function roomWorld(room) {
  return {
    ...world,
    columns: [room.position[0]],
    rows: [room.position[1]],
    roomWidth: room.width,
    roomHeight: room.height,
    rooms: [{ ...room, columnIndex: 0, rowIndex: 0 }]
  };
}

function showFrame(state, room) {
  const renderedRoom = engine.roomFromState(state, room);
  renderer.setRoom(renderedRoom, { preserveCamera: true });
  asciiRenderer.setRoom(renderedRoom);
}

function updateAsciiCameraLabel() {
  const yaw = renderer?.heading || 0;
  elements.asciiCamera.textContent = `${ASCII_VIEW_NAMES[asciiPitch]} · ${yaw * 90}°`;
}

function setAsciiPitch(pitch) {
  asciiPitch = Math.max(0, Math.min(ASCII_VIEW_NAMES.length - 1, Math.round(pitch)));
  asciiRenderer?.setPitch(asciiPitch);
  updateAsciiCameraLabel();
}

function setViewMode(mode) {
  viewMode = mode === "ascii" ? "ascii" : "3d";
  const ascii = viewMode === "ascii";
  elements.asciiView.hidden = !ascii;
  elements.stage.classList.toggle("is-ascii", ascii);
  elements.stage.dataset.viewMode = viewMode;
  elements.viewToggle.textContent = ascii ? "3D (M)" : "ASCII (M)";
  elements.viewToggle.setAttribute("aria-pressed", String(ascii));
  elements.cameraHelp.textContent = ascii
    ? "M 3D · arrows move · R reset · Z undo · A/D rotate · W/S pitch"
    : "M ASCII · arrows move · R reset · Z undo · A/D rotate · W/S tilt · Q/E zoom";
  if (ascii) {
    asciiRenderer.setYaw(renderer.heading);
    asciiRenderer.setPitch(asciiPitch);
    updateAsciiCameraLabel();
  }
}

function toggleViewMode() {
  setViewMode(viewMode === "3d" ? "ascii" : "3d");
}

function updateSeedOptions({ persist = true } = {}) {
  const hideNames = elements.seededGlyphs.checked;
  const hideNamesSeed = elements.asciiSeed.value.trim() || "1";
  elements.asciiSeed.disabled = !hideNames;
  asciiRenderer?.setSeedOptions({ hideNames, hideNamesSeed });
  if (!persist) return;
  const url = new URL(location.href);
  if (hideNames) {
    url.searchParams.set("seededGlyphs", "1");
    url.searchParams.set("asciiSeed", hideNamesSeed);
  } else {
    url.searchParams.delete("seededGlyphs");
    url.searchParams.delete("asciiSeed");
  }
  history.replaceState(null, "", url);
}

function updateSession(summary) {
  elements.moveCount.textContent = String(summary.moves);
  elements.gemCount.textContent = String(summary.gems);
  elements.directionButtons.forEach((button) => {
    button.disabled = !summary.playerActive;
  });
  elements.undo.disabled = !summary.canUndo;
  if (summary.error) elements.state.textContent = summary.error;
  else if (summary.undone) elements.state.textContent = "Undid the last command.";
  else if (summary.reset) elements.state.textContent = "Room reset.";
  else if (!summary.playerActive) elements.state.textContent = "Player fell out of the room.";
  else if (summary.cycle) elements.state.textContent = "Cycle detected; command rolled back.";
  else if (summary.busy) elements.state.textContent = summary.queued ? `Running · ${summary.queued} queued` : "Running command…";
  else elements.state.textContent = "Ready for arrow-key input.";
}

function openRoom(room) {
  currentRoom = room;
  const label = room.position.join("×");
  const routeRoom = encodeURIComponent(room.position.join("x"));
  elements.roomName.textContent = label;
  elements.fileName.textContent = room.fileName;
  elements.editorLink.href = `../../editor/v1/?room=${routeRoom}`;
  elements.editorLink.textContent = `Edit ${label}`;
  elements.editorLink.setAttribute("aria-label", `Edit room ${label} in editor v1`);
  markCurrentRoom(room);
  const url = new URL(location.href);
  url.searchParams.set("room", room.position.join("x"));
  history.replaceState(null, "", url);
  asciiRenderer.openRoom(room);
  session.open(room);
}

elements.viewToggle.addEventListener("click", toggleViewMode);
elements.reset.addEventListener("click", () => session?.reset());
elements.undo.addEventListener("click", () => session?.undo());
elements.seededGlyphs.addEventListener("change", updateSeedOptions);
elements.asciiSeed.addEventListener("change", updateSeedOptions);
elements.directionButtons.forEach((button) => {
  button.addEventListener("click", () => session?.move(button.dataset.direction));
});
window.addEventListener("keydown", (event) => {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || isEditableTarget(event.target)) return;
  const key = event.key.toLowerCase();
  if (key === "m") {
    event.preventDefault();
    if (!event.repeat) toggleViewMode();
    return;
  }
  if (key === "r" || key === "z") {
    event.preventDefault();
    if (event.repeat) return;
    if (key === "r") session?.reset();
    else session?.undo();
    return;
  }
  if (viewMode === "ascii" && (key === "w" || key === "s")) {
    event.preventDefault();
    const now = performance.now();
    if (!event.repeat || now - lastAsciiPitchStep >= 140) {
      lastAsciiPitchStep = now;
      setAsciiPitch(asciiPitch + (key === "w" ? -1 : 1));
    }
    return;
  }
  if (viewMode === "ascii" && (key === "a" || key === "d")) {
    event.preventDefault();
    if (!event.repeat) {
      renderer?.rotateCardinal(key === "a" ? -1 : 1);
      asciiRenderer?.setYaw(renderer?.heading || 0);
      updateAsciiCameraLabel();
    }
    return;
  }
  const direction = {
    ArrowUp: "up",
    ArrowRight: "right",
    ArrowDown: "down",
    ArrowLeft: "left"
  }[event.key];
  if (!direction) return;
  event.preventDefault();
  if (!event.repeat) session?.move(direction);
});

try {
  [world, engine] = await Promise.all([
    loadMainWorldV2((complete, total) => {
      if (complete % 32 === 0 || complete === total) {
        elements.loading.textContent = `Loading rooms ${complete}/${total}`;
      }
    }),
    loadMazeBenchEngineV1()
  ]);
  markCurrentRoom = installRoomControlsV1(
    world,
    elements.roomSelect,
    elements.roomGrid,
    openRoom
  );
  const requested = new URL(location.href).searchParams.get("room")?.toUpperCase();
  currentRoom = world.rooms.find((room) => room.position.join("X") === requested) || world.rooms[0];
  renderer = new ThreeMazeRendererV1(elements.canvas, roomWorld(currentRoom), { mode: "play" });
  const params = new URL(location.href).searchParams;
  elements.seededGlyphs.checked = params.get("seededGlyphs") === "1";
  elements.asciiSeed.value = params.get("asciiSeed") || "1";
  asciiRenderer = new AsciiMazeRendererV1(
    elements.asciiBoard,
    elements.asciiLegend,
    world.blockDefinitions,
    {
      hideNames: elements.seededGlyphs.checked,
      hideNamesSeed: elements.asciiSeed.value
    }
  );
  updateSeedOptions({ persist: false });
  session = new PlaySessionV1(engine, world.blocks, {
    onFrame: showFrame,
    onChange: updateSession
  });
  new ResizeObserver(() => renderer.resize()).observe(elements.stage);
  openRoom(currentRoom);
  setViewMode("3d");
  elements.stage.classList.add("is-ready");
} catch (error) {
  elements.loading.textContent = error?.message || "Play mode failed to load.";
  elements.state.textContent = "Play mode failed to load.";
  console.error(error);
}
