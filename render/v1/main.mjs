import { RENDERER_VERSION } from "./world-renderer.mjs";
import { ThreeMazeRendererV1 } from "./three-renderer.mjs";
import { loadMainWorldV2 } from "./voxel-world-v2.mjs";

const elements = {
  canvas: document.getElementById("world"),
  viewport: document.getElementById("viewport"),
  status: document.getElementById("status"),
  loading: document.getElementById("loading"),
  room: document.getElementById("room-value"),
  file: document.getElementById("file-value"),
  cell: document.getElementById("cell-value"),
  play: document.getElementById("play-link"),
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
  const cellX = hit.sourceX ?? hit.cellX;
  const cellY = hit.sourceY ?? hit.cellY;
  const objects = hit.room.objects?.filter((object) => object.x === cellX && object.y === cellY) || [];
  elements.cell.textContent = `${cellX},${cellY}  ${objects.length ? objects.map((object) => object.blockId).join(" + ") : "air"}`;
}

function select(hit) {
  if (!hit) return;
  selectedRoom = hit.room;
  const routeRoom = encodeURIComponent(hit.room.position.join("x"));
  const roomLabel = hit.room.position.join("×");
  renderer.selectRoom(hit.room);
  inspect(hit);
  elements.play.href = `./play/v1/?room=${routeRoom}`;
  elements.play.textContent = `Play ${roomLabel}`;
  elements.play.setAttribute("aria-label", `Play room ${roomLabel} in play mode v1`);
  elements.editor.href = `./editor/v1/?room=${routeRoom}`;
  elements.editor.textContent = `Edit ${roomLabel}`;
}

elements.zoomIn.addEventListener("click", () => renderer?.zoomBy(0.78));
elements.zoomOut.addEventListener("click", () => renderer?.zoomBy(1 / 0.78));
elements.fit.addEventListener("click", () => renderer?.resetView());
elements.canvas.addEventListener("dblclick", () => renderer?.focusRoom(selectedRoom));

try {
  const world = await loadMainWorldV2((complete, total) => {
    if (complete === total || complete % 16 === 0) {
      elements.loading.lastElementChild.textContent = `Reading v2 rooms ${complete}/${total}`;
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
  const objectCount = world.rooms.reduce((total, room) => total + room.objects.length, 0);
  elements.status.textContent = `${world.rooms.length} rooms · ${objectCount.toLocaleString()} 3D objects · Three.js`;
  document.title = `MazeBench — Main World · Three.js renderer v${RENDERER_VERSION}`;
} catch (error) {
  elements.loading.lastElementChild.textContent = error.message || "Could not render the world.";
  elements.status.textContent = "Load failed";
  elements.loading.classList.add("is-error");
  console.error(error);
}
