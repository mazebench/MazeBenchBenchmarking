import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { countActiveRoleV1 } from "../engine/v1/adapter.mjs";
import { instantiateMazeBenchEngineV1 } from "../engine/v1/engine.mjs";
import { cameraRelativeMoveDirection } from "../play/v1/camera-relative-input.mjs";
import { PlaySessionV1 } from "../play/v1/play-session.mjs";

const blocks = [
  { id: "floor", roleId: "floor", visual: { kind: "floor" } },
  { id: "ice-floor", roleId: "ice", visual: { kind: "floor" } },
  { id: "wall", roleId: "solid", visual: { kind: "cube" } },
  { id: "player", roleId: "player", visual: { kind: "cube" } },
  { id: "gem", roleId: "goal", visual: { kind: "model" } }
];

async function loadEngine() {
  const bytes = await readFile(new URL("../engine/v1/voxel_physics.wasm", import.meta.url));
  return { bytes, engine: await instantiateMazeBenchEngineV1(bytes) };
}

test("play arrows rotate from screen space into world space at every camera heading", () => {
  assert.deepEqual(
    [0, 1, 2, 3].map((heading) =>
      ["up", "right", "down", "left"].map((direction) =>
        cameraRelativeMoveDirection(direction, heading))),
    [
      ["up", "right", "down", "left"],
      ["left", "up", "right", "down"],
      ["down", "left", "up", "right"],
      ["right", "down", "left", "up"]
    ]
  );
  assert.equal(cameraRelativeMoveDirection("unknown", 0), null);
  assert.equal(cameraRelativeMoveDirection("up", -1), "right");
});

test("engine v1 is the byte-identical UnitTest WebAssembly build", async () => {
  const { bytes, engine } = await loadEngine();
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    "09357602e0d68e7ddea6ddb1de407884f832ba981fac2c37fe9a4272cb4fe59f"
  );
  assert.deepEqual(engine.info, {
    version: "v1",
    abi: 4,
    voxelCapacity: 65_536,
    searchVoxelCapacity: 4_096,
    searchNodeCapacity: 180_000
  });
});

test("exact solver and play commands share the copied engine", async () => {
  const { engine } = await loadEngine();
  const room = {
    width: 3,
    height: 3,
    objects: [
      { x: 1, y: 2, z: 0, blockId: "player" },
      { x: 1, y: 2, z: 0, blockId: "floor" },
      { x: 1, y: 1, z: 0, blockId: "floor" },
      { x: 1, y: 0, z: 0, blockId: "floor" },
      { x: 1, y: 0, z: 0, blockId: "gem" }
    ]
  };
  const result = engine.solve(room, blocks, { maximumNodes: 1_000 });
  assert.equal(result.status, "solved");
  assert.equal(result.proven, true);
  assert.deepEqual(result.solution, ["up", "up"]);

  let state = engine.createState(room);
  for (const direction of result.solution) {
    state = (await engine.simulateCommand(state, direction, blocks)).final;
  }
  assert.equal(countActiveRoleV1(state, blocks, "goal"), 0);
  assert.deepEqual(state.objects[0], { x: 1, y: 0, z: 0, blockId: "player" });
});

test("storage-v2 surface Ice produces the engine's multi-tick slide", async () => {
  const { engine } = await loadEngine();
  const room = {
    width: 3,
    height: 5,
    objects: [
      { x: 1, y: 4, z: 0, blockId: "player" },
      { x: 1, y: 4, z: 0, blockId: "floor" },
      { x: 1, y: 3, z: 0, blockId: "ice-floor" },
      { x: 1, y: 2, z: 0, blockId: "ice-floor" },
      { x: 1, y: 1, z: 0, blockId: "ice-floor" },
      { x: 1, y: 0, z: 0, blockId: "floor" }
    ]
  };
  const result = await engine.simulateCommand(room, "up", blocks);
  assert.deepEqual(result.frames.map((frame) => frame.objects[0].y), [3, 2, 1, 0]);
  assert.equal(result.final.objects[0].y, 0);
});

test("play v1 undo restores the prior engine state and reset clears history", async () => {
  const { engine } = await loadEngine();
  const room = {
    width: 3,
    height: 3,
    objects: [
      { x: 1, y: 2, z: 0, blockId: "player" },
      { x: 1, y: 2, z: 0, blockId: "floor" },
      { x: 1, y: 1, z: 0, blockId: "floor" },
      { x: 1, y: 0, z: 0, blockId: "floor" }
    ]
  };
  const changes = [];
  const session = new PlaySessionV1(engine, blocks, {
    frameDelay: 0,
    onChange: (summary) => changes.push(summary)
  });
  session.open(room);

  await session.move("up");
  assert.equal(session.moves, 1);
  assert.equal(session.state.objects[0].y, 1);
  assert.equal(changes.at(-1).canUndo, true);

  assert.equal(session.undo(), true);
  assert.equal(session.moves, 0);
  assert.equal(session.state.objects[0].y, 2);
  assert.equal(changes.at(-1).undone, true);
  assert.equal(changes.at(-1).canUndo, false);

  await session.move("up");
  session.reset();
  assert.equal(session.moves, 0);
  assert.equal(session.state.objects[0].y, 2);
  assert.equal(changes.at(-1).reset, true);
  assert.equal(session.undo(), false);
});

test("play v1 continues accepting movement after the final gem is collected", async () => {
  const { engine } = await loadEngine();
  const room = {
    width: 3,
    height: 4,
    objects: [
      { x: 1, y: 3, z: 0, blockId: "player" },
      { x: 1, y: 3, z: 0, blockId: "floor" },
      { x: 1, y: 2, z: 0, blockId: "floor" },
      { x: 1, y: 2, z: 0, blockId: "gem" },
      { x: 1, y: 1, z: 0, blockId: "floor" }
    ]
  };
  const changes = [];
  const session = new PlaySessionV1(engine, blocks, {
    frameDelay: 0,
    onChange: (summary) => changes.push(summary)
  });
  session.open(room);

  await session.move("up");
  assert.equal(session.gemCount, 0);
  assert.equal(session.state.objects[0].y, 2);
  await session.move("up");
  assert.equal(session.moves, 2);
  assert.equal(session.state.objects[0].y, 1);
  assert.equal(changes.at(-1).playerActive, true);
  assert.equal("solved" in changes.at(-1), false);
});
