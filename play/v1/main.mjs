import { loadMazeBenchEngineV1 } from "../../engine/v1/engine.mjs";
import { ThreeMazeRendererV1 } from "../../render/v1/three-renderer.mjs";
import { loadMainWorldV2 } from "../../render/v1/voxel-world-v2.mjs";
import { PlaySessionV1 } from "./play-session.mjs";
import { installRoomControlsV1 } from "./room-controls.mjs";

const elements = {
  stage: document.getElementById("stage"),
  canvas: document.getElementById("play-canvas"),
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
  editorLink: document.getElementById("editor-link"),
  directionButtons: [...document.querySelectorAll("[data-direction]")]
};

let world;
let engine;
let renderer;
let session;
let currentRoom;
let markCurrentRoom;

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
}

function updateSession(summary) {
  elements.moveCount.textContent = String(summary.moves);
  elements.gemCount.textContent = String(summary.gems);
  elements.directionButtons.forEach((button) => {
    button.disabled = summary.solved || !summary.playerActive;
  });
  elements.undo.disabled = !summary.canUndo;
  if (summary.error) elements.state.textContent = summary.error;
  else if (summary.undone) elements.state.textContent = "Undid the last command.";
  else if (summary.reset) elements.state.textContent = "Room reset.";
  else if (summary.solved) elements.state.textContent = "All gems collected.";
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
  session.open(room);
}

elements.reset.addEventListener("click", () => session?.reset());
elements.undo.addEventListener("click", () => session?.undo());
elements.directionButtons.forEach((button) => {
  button.addEventListener("click", () => session?.move(button.dataset.direction));
});
window.addEventListener("keydown", (event) => {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
  const key = event.key.toLowerCase();
  if (key === "r" || key === "z") {
    event.preventDefault();
    if (event.repeat) return;
    if (key === "r") session?.reset();
    else session?.undo();
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
  session = new PlaySessionV1(engine, world.blocks, {
    onFrame: showFrame,
    onChange: updateSession
  });
  new ResizeObserver(() => renderer.resize()).observe(elements.stage);
  openRoom(currentRoom);
  elements.stage.classList.add("is-ready");
} catch (error) {
  elements.loading.textContent = error?.message || "Play mode failed to load.";
  elements.state.textContent = "Play mode failed to load.";
  console.error(error);
}
