import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { instantiateMazeBenchEngineV1 } from "../engine/v1/engine.mjs";
import {
  RANDOM_AGENT_DIRECTIONS_V1,
  RANDOM_AGENT_START_POSITION_V1,
  randomAgentPixelV1,
  runRandomAgentV1,
  tagRandomAgentWorldV1
} from "../world-solver/v1/random-agent.mjs";
import {
  ROOM_BFS_DIRECTIONS_V1,
  ROOM_BFS_META_STRATEGIES_V1,
  ROOM_BFS_START_POSITION_V1,
  runRoomBfsV1
} from "../world-solver/v1/room-bfs.mjs";

const blocks = [
  { id: "floor", roleId: "floor", visual: { kind: "floor" } },
  { id: "wall", roleId: "solid", visual: { kind: "cube" } },
  { id: "ice-slope", roleId: "ice", visual: { kind: "slope" } },
  { id: "floating-floor", roleId: "floating-floor", visual: { kind: "platform" } },
  { id: "player", roleId: "player", visual: { kind: "cube" } },
  { id: "gem", roleId: "goal", visual: { kind: "model" } }
];

function oneRoomWorld(objects, size = 3) {
  const room = {
    fileName: "start.json",
    position: ["H", "I"],
    columnIndex: 0,
    rowIndex: 0,
    width: size,
    height: size,
    objects
  };
  return {
    columns: ["H"],
    rows: ["I"],
    roomWidth: size,
    roomHeight: size,
    rooms: [room],
    blocks,
    blockDefinitions: new Map(blocks.map((block) => [block.id, block]))
  };
}

async function engine() {
  const bytes = await readFile(new URL("../world-solver/v1/random-agent.wasm", import.meta.url));
  return instantiateMazeBenchEngineV1(bytes);
}

test("random agent uses only four directions and starts at H×I", () => {
  assert.deepEqual(RANDOM_AGENT_START_POSITION_V1, ["H", "I"]);
  assert.deepEqual(RANDOM_AGENT_DIRECTIONS_V1, ["up", "right", "down", "left"]);
});

test("room BFS uses the same four commands and starts at H×I", () => {
  assert.deepEqual(ROOM_BFS_START_POSITION_V1, ["H", "I"]);
  assert.deepEqual(ROOM_BFS_DIRECTIONS_V1, ["up", "right", "down", "left"]);
  assert.deepEqual(ROOM_BFS_META_STRATEGIES_V1, [
    "breadth",
    "depth",
    "super-astar",
    "row-astar"
  ]);
});

test("room BFS exhausts exact states, paints cells, records exits, and locks", async () => {
  const floors = [];
  for (let y = 0; y < 3; y += 1) {
    for (let x = 0; x < 3; x += 1) floors.push({ x, y, z: 0, blockId: "floor" });
  }
  const native = await engine();
  const progress = [];
  const stats = await runRoomBfsV1(native, oneRoomWorld([
    { x: 1, y: 1, z: 0, blockId: "player" },
    ...floors
  ]), {
    chunkSize: 512,
    progressDelayMs: 0,
    onProgress: (message) => progress.push(message)
  });

  assert.equal(stats.states, 9);
  assert.equal(stats.expanded, 1);
  assert.equal(stats.transitions, 36);
  assert.equal(stats.edgeStates, 12);
  assert.equal(stats.exitCells, 8);
  assert.deepEqual(
    [...new Set(progress.flatMap((message) => message.visitedCells))].sort((a, b) => a - b),
    [0, 1, 2, 3, 4, 5, 6, 7, 8]
  );
  assert.equal(native.exports.room_bfs_run(1), 1);
  assert.equal(native.exports.room_bfs_states(), 9);
  assert.equal(native.exports.room_bfs_expanded(), 1);
});

test("room BFS keeps collected and uncollected board states distinct", async () => {
  const floors = [];
  for (let y = 0; y < 3; y += 1) {
    for (let x = 0; x < 3; x += 1) floors.push({ x, y, z: 0, blockId: "floor" });
  }
  const stats = await runRoomBfsV1(await engine(), oneRoomWorld([
    { x: 1, y: 1, z: 0, blockId: "player" },
    ...floors,
    { x: 2, y: 1, z: 0, blockId: "gem" }
  ]), { chunkSize: 32, progressDelayMs: 0 });

  // Eight reachable positions before collection plus all nine after collection.
  assert.equal(stats.states, 17);
  assert.equal(stats.expanded, 2);
  assert.equal(stats.gems, 1);
});

test("World BFS resets each newly reached room and searches it only once", async () => {
  const floors = [];
  for (let y = 0; y < 3; y += 1) {
    for (let x = 0; x < 3; x += 1) floors.push({ x, y, z: 0, blockId: "floor" });
  }
  const north = {
    fileName: "north.json",
    position: ["H", "H"],
    columnIndex: 0,
    rowIndex: 0,
    width: 3,
    height: 3,
    objects: floors
  };
  const start = {
    fileName: "start.json",
    position: ["H", "I"],
    columnIndex: 0,
    rowIndex: 1,
    width: 3,
    height: 3,
    objects: [{ x: 1, y: 1, z: 0, blockId: "player" }, ...floors]
  };
  const progress = [];
  const stats = await runRoomBfsV1(await engine(), {
    columns: ["H"],
    rows: ["H", "I"],
    roomWidth: 3,
    roomHeight: 3,
    rooms: [north, start],
    blocks,
    blockDefinitions: new Map(blocks.map((block) => [block.id, block]))
  }, {
    chunkSize: 32,
    progressDelayMs: 0,
    onProgress: (message) => progress.push(message)
  });

  assert.equal(stats.rooms, 2);
  assert.equal(stats.processedRooms, 2);
  assert.equal(stats.states, 18);
  assert.equal(stats.gems, 0);
  assert.ok(progress.some((message) => message.stats.currentRoom === "H×H"));

  const roomStatuses = new Map();
  const roomForCell = (cell) => {
    const x = cell % 3;
    const y = Math.floor(cell / 3);
    return y < 3 ? "north.json" : "start.json";
  };
  for (const message of progress) {
    for (const update of message.roomUpdates || []) {
      roomStatuses.set(update.fileName, update.searchStatus);
    }
    for (const cell of message.trail || []) {
      assert.notEqual(roomStatuses.get(roomForCell(cell)), "searched");
    }
  }
  assert.deepEqual([...roomStatuses.entries()].sort(), [
    ["north.json", "searched"],
    ["start.json", "searched"]
  ]);
  for (const roomName of roomStatuses.keys()) {
    const updates = progress.flatMap((message) => message.roomUpdates || [])
      .filter((update) => update.fileName === roomName)
      .map((update) => update.searchStatus);
    assert.deepEqual(updates, ["open", "searched"]);
  }
});

test("DFS Meta immediately explores a new room and then resumes the exact parent BFS", async () => {
  const floors = [];
  for (let y = 0; y < 3; y += 1) {
    for (let x = 0; x < 3; x += 1) floors.push({ x, y, z: 0, blockId: "floor" });
  }
  const room = (fileName, position, columnIndex, rowIndex, objects = floors) => ({
    fileName,
    position,
    columnIndex,
    rowIndex,
    width: 3,
    height: 3,
    objects
  });
  const progress = [];
  const stats = await runRoomBfsV1(await engine(), {
    columns: ["H", "I"],
    rows: ["H", "I"],
    roomWidth: 3,
    roomHeight: 3,
    rooms: [
      room("north.json", ["H", "H"], 0, 0),
      room("start.json", ["H", "I"], 0, 1, [
        { x: 1, y: 1, z: 0, blockId: "player" },
        ...floors,
        { x: 2, y: 1, z: 0, blockId: "gem" }
      ]),
      room("east.json", ["I", "I"], 1, 1)
    ],
    blocks,
    blockDefinitions: new Map(blocks.map((block) => [block.id, block]))
  }, {
    metaStrategy: "depth",
    chunkSize: 512,
    progressDelayMs: 0,
    onProgress: (message) => progress.push(message)
  });

  const events = progress.map((message) =>
    `${message.type}:${message.stats.currentRoom}`);
  const firstChild = events.findIndex((event) => event === "room-start:H×H");
  const startComplete = events.findIndex((event) => event === "room-complete:H×I");
  assert.ok(firstChild >= 0 && firstChild < startComplete);
  assert.ok(events.includes("room-suspend:H×I"));
  assert.ok(events.includes("room-resume:H×I"));
  assert.ok(events.includes("room-start:I×I"));
  assert.equal(stats.rooms, 3);
  assert.equal(stats.processedRooms, 3);
  assert.equal(stats.states, 35);
  assert.equal(stats.gems, 1);
});

test("Super A* time-slices a global room portfolio toward gems and outlets", async () => {
  const floors = [];
  for (let y = 0; y < 3; y += 1) {
    for (let x = 0; x < 3; x += 1) floors.push({ x, y, z: 0, blockId: "floor" });
  }
  const room = (fileName, position, columnIndex, rowIndex, objects = floors) => ({
    fileName,
    position,
    columnIndex,
    rowIndex,
    width: 3,
    height: 3,
    objects
  });
  const progress = [];
  const stats = await runRoomBfsV1(await engine(), {
    columns: ["H", "I"],
    rows: ["H", "I"],
    roomWidth: 3,
    roomHeight: 3,
    rooms: [
      room("north.json", ["H", "H"], 0, 0),
      room("start.json", ["H", "I"], 0, 1, [
        { x: 1, y: 1, z: 0, blockId: "player" },
        ...floors,
        { x: 2, y: 1, z: 0, blockId: "gem" }
      ]),
      room("east.json", ["I", "I"], 1, 1)
    ],
    blocks,
    blockDefinitions: new Map(blocks.map((block) => [block.id, block]))
  }, {
    metaStrategy: "super-astar",
    heuristicWeight: 3,
    chunkSize: 1,
    progressDelayMs: 0,
    onProgress: (message) => progress.push(message)
  });

  assert.ok(progress.some((message) => message.type === "search-yield"));
  assert.ok(progress.some((message) => message.stats.currentRoom === "H×H"));
  assert.ok(progress.some((message) => message.stats.currentRoom === "I×I"));
  assert.equal(stats.rooms, 3);
  assert.equal(stats.processedRooms, 3);
  assert.equal(stats.states, 35);
  assert.equal(stats.gems, 1);
  assert.equal(stats.activeSearches, 0);
  assert.equal(stats.heuristicWeight, 3);
  assert.ok(stats.searchSlices >= 3);
});

test("Row A* covers reached rows while treating gems and exits as incidental", async () => {
  const floors = [];
  for (let y = 0; y < 3; y += 1) {
    for (let x = 0; x < 3; x += 1) floors.push({ x, y, z: 0, blockId: "floor" });
  }
  const room = (fileName, position, columnIndex, rowIndex, objects = floors) => ({
    fileName,
    position,
    columnIndex,
    rowIndex,
    width: 3,
    height: 3,
    objects
  });
  const stats = await runRoomBfsV1(await engine(), {
    columns: ["H", "I"],
    rows: ["H", "I"],
    roomWidth: 3,
    roomHeight: 3,
    rooms: [
      room("north.json", ["H", "H"], 0, 0),
      room("start.json", ["H", "I"], 0, 1, [
        { x: 1, y: 1, z: 0, blockId: "player" },
        ...floors,
        { x: 2, y: 1, z: 0, blockId: "gem" }
      ]),
      room("east.json", ["I", "I"], 1, 1)
    ],
    blocks,
    blockDefinitions: new Map(blocks.map((block) => [block.id, block]))
  }, {
    metaStrategy: "row-astar",
    heuristicWeight: 3,
    chunkSize: 512,
    progressDelayMs: 0
  });

  assert.equal(stats.rooms, 3);
  assert.equal(stats.processedRooms, 3);
  // The gem tile is reached only after the collection transition, so the
  // starter room expands both its pre- and post-collection board states.
  assert.equal(stats.states, 35);
  assert.equal(stats.gems, 1);
  assert.equal(stats.rowTargets, 9);
  assert.equal(stats.rowVisited, 9);
  assert.equal(stats.rowsDiscovered, 1);
  assert.equal(stats.rowCoverageComplete, 1);
});

test("Row A* keeps ice slopes and floating floors in its landscape without falling back", async () => {
  const native = await engine();
  const stats = await runRoomBfsV1(native, oneRoomWorld([
    { x: 1, y: 1, z: 1, blockId: "player" },
    { x: 1, y: 1, z: 0, blockId: "floating-floor" },
    { x: 0, y: 0, z: 0, blockId: "ice-slope" },
    { x: 1, y: 1, z: 0, blockId: "floor" }
  ]), {
    metaStrategy: "row-astar",
    chunkSize: 32,
    progressDelayMs: 0
  });

  const targets = Array.from(
    { length: native.exports.row_astar_target_count() },
    (_, index) => [
      native.exports.row_astar_target_x(index),
      native.exports.row_astar_target_y(index),
      native.exports.row_astar_target_z(index)
    ]
  );
  assert.ok(targets.some(([x, y, z]) => x === 0 && y === 0 && z === 1));
  assert.ok(targets.some(([x, y, z]) => x === 1 && y === 1 && z === 1));
  assert.equal(stats.rowsDiscovered, 1);
  assert.equal(stats.rowTargets, 2);
  assert.equal(stats.rowVisited, 1);
  assert.equal(stats.rowCoverageComplete, 0);
  assert.equal(stats.processedRooms, 1);
});

test("world pixels span the 256×256 map and ignore z", () => {
  const world = { columns: Array(16), rows: Array(16), roomWidth: 16, roomHeight: 16 };
  const room = { columnIndex: 15, rowIndex: 15 };
  assert.deepEqual(randomAgentPixelV1(world, room, { x: 15, y: 15, z: 999 }), {
    x: 255,
    y: 255,
    index: 65_535
  });
});

test("random-agent object IDs remain stable per authored room", () => {
  const tagged = tagRandomAgentWorldV1(oneRoomWorld([
    { x: 1, y: 1, z: 0, blockId: "player" },
    { x: 1, y: 1, z: 0, blockId: "floor" }
  ]));
  assert.deepEqual(tagged.rooms[0].objects.map((object) => object.randomAgentObjectId), [
    "start.json:0",
    "start.json:1"
  ]);
});

test("random agent keeps safe actions and reports live visits", async () => {
  const floors = [];
  for (let y = 0; y < 3; y += 1) {
    for (let x = 0; x < 3; x += 1) floors.push({ x, y, z: 0, blockId: "floor" });
  }
  const progress = [];
  const result = await runRandomAgentV1(await engine(), oneRoomWorld([
    { x: 1, y: 1, z: 0, blockId: "player" },
    ...floors
  ]), {
    maximumActions: 8,
    seed: 1,
    reportEveryMs: 1,
    yieldEvery: 2,
    onProgress: (message) => progress.push(message)
  });
  assert.equal(result.actions, 8);
  assert.equal(result.rooms, 1);
  assert.equal(result.undos, 0);
  assert.ok(progress.flatMap((message) => message.visitedCells).length >= 2);
});

test("only a player death triggers the one-action undo", async () => {
  const result = await runRandomAgentV1(await engine(), oneRoomWorld([
    { x: 1, y: 1, z: 0, blockId: "player" },
    { x: 1, y: 1, z: 0, blockId: "floor" }
  ]), {
    maximumActions: 1,
    seed: 1
  });
  assert.equal(result.actions, 1);
  assert.equal(result.undos, 1);
  assert.equal(result.currentRoom, "H×I");
});

test("the random agent teleports to a reached room after each 10,000 moves", async () => {
  const floors = [];
  for (let y = 0; y < 3; y += 1) {
    for (let x = 0; x < 3; x += 1) floors.push({ x, y, z: 0, blockId: "floor" });
  }
  let lastProgress;
  await runRandomAgentV1(await engine(), oneRoomWorld([
    { x: 1, y: 1, z: 0, blockId: "player" },
    ...floors
  ]), {
    maximumActions: 10_001,
    seed: 1,
    onProgress: (message) => { lastProgress = message; }
  });
  assert.equal(lastProgress.stats.teleports, 1);
});
