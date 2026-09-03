const elements = Object.fromEntries([
  "status", "world-canvas", "actions-per-second", "actions", "rooms", "gems",
  "undos", "teleports", "current-room", "restart", "stop"
].map((id) => [id.replaceAll("-", ""), document.getElementById(id)]));

const context = elements.worldcanvas.getContext("2d", { alpha: false });
let worker = null;
let width = 256;
let height = 256;
let roomWidth = 16;
let roomHeight = 16;
let visited = new Uint8Array(width * height);
let reachedRooms = new Map();
let recent = [];

function resetMap(nextWidth = 256, nextHeight = 256) {
  width = nextWidth;
  height = nextHeight;
  elements.worldcanvas.width = width;
  elements.worldcanvas.height = height;
  visited = new Uint8Array(width * height);
  reachedRooms = new Map();
  recent = [];
  draw();
}

function draw() {
  const image = context.createImageData(width, height);
  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4;
    image.data[offset] = 9;
    image.data[offset + 1] = 12;
    image.data[offset + 2] = 16;
    image.data[offset + 3] = 255;
  }
  for (const room of reachedRooms.values()) {
    const firstX = room.columnIndex * roomWidth;
    const firstY = room.rowIndex * roomHeight;
    for (let y = firstY; y < firstY + roomHeight; y += 1) {
      for (let x = firstX; x < firstX + roomWidth; x += 1) {
        const offset = (y * width + x) * 4;
        image.data[offset] = 27;
        image.data[offset + 1] = 70;
        image.data[offset + 2] = 37;
      }
    }
  }
  for (let index = 0; index < visited.length; index += 1) {
    if (!visited[index]) continue;
    const offset = index * 4;
    image.data[offset] = 255;
    image.data[offset + 1] = 216;
    image.data[offset + 2] = 64;
  }
  recent.forEach((index, age) => {
    const amount = recent.length === 1 ? 1 : age / (recent.length - 1);
    const offset = index * 4;
    image.data[offset] = 255;
    image.data[offset + 1] = Math.round(216 + (52 - 216) * amount);
    image.data[offset + 2] = Math.round(64 + (35 - 64) * amount);
  });
  context.putImageData(image, 0, 0);
}

function update(message) {
  if (message.width && message.height && (message.width !== width || message.height !== height)) {
    resetMap(message.width, message.height);
  }
  roomWidth = message.roomWidth || roomWidth;
  roomHeight = message.roomHeight || roomHeight;
  for (const room of message.reachedRooms || []) reachedRooms.set(room.fileName, room);
  for (const index of message.visitedCells || []) {
    if (index < 0 || index >= visited.length) continue;
    visited[index] = 1;
  }
  if (message.trailReplaces) recent = [];
  for (const index of message.trail || []) {
    if (index >= 0 && index < visited.length) recent.push(index);
  }
  if (recent.length > 50) recent.splice(0, recent.length - 50);
  const stats = message.stats || {};
  elements.actionspersecond.textContent = Number(stats.actionsPerSecond || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
  elements.actions.textContent = Number(stats.actions || 0).toLocaleString();
  elements.rooms.textContent = Number(stats.rooms || 0).toLocaleString();
  elements.gems.textContent = Number(stats.gems || 0).toLocaleString();
  elements.undos.textContent = Number(stats.undos || 0).toLocaleString();
  elements.teleports.textContent = Number(stats.teleports || 0).toLocaleString();
  elements.currentroom.textContent = stats.currentRoom || "H×I";
  draw();
}

function stop(message = "Random agent stopped.") {
  worker?.terminate();
  worker = null;
  elements.stop.disabled = true;
  elements.status.textContent = message;
}

function start() {
  worker?.terminate();
  resetMap();
  elements.status.style.color = "";
  elements.stop.disabled = false;
  elements.status.textContent = "Loading engine and world at H×I…";
  worker = new Worker(new URL("./worker.mjs", import.meta.url), {
    type: "module",
    name: "mazebench-random-world-agent-v1"
  });
  worker.addEventListener("message", (event) => {
    const message = event.data || {};
    if (["ready", "progress", "complete"].includes(message.type)) {
      update(message);
      elements.status.textContent = message.type === "complete"
        ? "Random agent complete."
        : `Running in ${message.stats.currentRoom} · ${Math.round(message.stats.actionsPerSecond).toLocaleString()} actions/sec`;
    } else if (message.type === "error") {
      stop(message.error);
      elements.status.style.color = "#ff7b72";
    }
  });
  worker.addEventListener("error", (event) => {
    stop(event.message || "Random-agent worker failed.");
    elements.status.style.color = "#ff7b72";
  }, { once: true });
  worker.postMessage({ type: "start" });
}

elements.restart.addEventListener("click", start);
elements.stop.addEventListener("click", () => stop());
window.addEventListener("beforeunload", () => worker?.terminate());

resetMap();
start();
