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

const blocks = [
  { id: "floor", roleId: "floor", visual: { kind: "floor" } },
  { id: "wall", roleId: "solid", visual: { kind: "cube" } },
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
