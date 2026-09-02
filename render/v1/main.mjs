import { RENDERER_VERSION, loadMainWorld } from "./world-renderer.mjs";
import { ThreeMazeRendererV1 } from "./three-renderer.mjs";

const elements = {
  canvas: document.getElementById("world"),
  viewport: document.getElementById("viewport"),
  status: document.getElementById("status"),
  loading: document.getElementById("loading"),
  room: document.getElementById("room-value"),
  file: document.getElementById("file-value"),
  cell: document.getElementById("cell-value"),
  editor: document.getElementById("editor-link"),
  zoomIn: document.getElementById("zoom-in"),
  zoomOut: document.getElementById("zoom-out"),
  fit: document.getElementById("fit-map")
};

let renderer = null;
let selectedRoom = null;

function inspect(hit) {
  if (!hit) return;
  elements.room.textContent = `${hit.room.position[0]}×${hit.room.position[1]}`;
  elements.file.textContent = hit.room.fileName;
  elements.file.title = hit.room.fileName;
  elements.cell.textContent = `${hit.cellX},${hit.cellY}  ${hit.cell || "air"}`;
}

function select(hit) {
  if (!hit) return;
  selectedRoom = hit.room;
  renderer.selectRoom(hit.room);
  inspect(hit);
  elements.editor.href = `./editor/v1/?room=${encodeURIComponent(hit.room.position.join("x"))}`;
  elements.editor.textContent = `Edit ${hit.room.position.join("×")}`;
}

elements.zoomIn.addEventListener("click", () => renderer?.zoomBy(0.78));
elements.zoomOut.addEventListener("click", () => renderer?.zoomBy(1 / 0.78));
elements.fit.addEventListener("click", () => renderer?.resetView());
elements.canvas.addEventListener("dblclick", () => renderer?.focusRoom(selectedRoom));

try {
  const world = await loadMainWorld((complete, total) => {
    if (complete === total || complete % 16 === 0) {
      elements.loading.lastElementChild.textContent = `Reading rooms ${complete}/${total}`;
      elements.status.textContent = `Loading ${complete}/${total}`;
    }
  });
  renderer = new ThreeMazeRendererV1(elements.canvas, world, {
    mode: "world",
    onInspect: inspect,
    onSelect: select
  });
  new ResizeObserver(() => renderer.resize()).observe(elements.viewport);
  elements.viewport.classList.remove("is-loading");
  const cellCount = world.columns.length * world.roomWidth * world.rows.length * world.roomHeight;
  elements.status.textContent = `${world.rooms.length} rooms · ${cellCount.toLocaleString()} cells · Three.js`;
  document.title = `MazeBench — Main World · Three.js renderer v${RENDERER_VERSION}`;
} catch (error) {
  elements.loading.lastElementChild.textContent = error.message || "Could not render the world.";
  elements.status.textContent = "Load failed";
  elements.loading.classList.add("is-error");
  console.error(error);
}
