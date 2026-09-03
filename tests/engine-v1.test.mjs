import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { countActiveRoleV1 } from "../engine/v1/adapter.mjs";
import {
  ENGINE_SOURCE_COMMIT,
  ENGINE_SOURCE_REPOSITORY,
  ENGINE_SOURCE_TREE,
  ENGINE_WASM_SHA256,
  instantiateMazeBenchEngineV1
} from "../engine/v1/engine.mjs";
import { cameraRelativeMoveDirection } from "../play/v1/camera-relative-input.mjs";
import { ConnectedWorldSessionV1 } from "../play/v1/connected-world-session.mjs";
import {
  DEFAULT_PLAY_FRAME_DELAY_MS,
  PlaySessionV1
} from "../play/v1/play-session.mjs";

const blocks = [
  { id: "floor", roleId: "floor", visual: { kind: "floor" } },
  { id: "ice-floor", roleId: "ice", visual: { kind: "floor" } },
  { id: "wall", roleId: "solid", visual: { kind: "cube" } },
  { id: "player", roleId: "player", visual: { kind: "cube" } },
  { id: "gem", roleId: "goal", visual: { kind: "model" } },
  { id: "gate", roleId: "player-gate", visual: { kind: "gate" } },
  { id: "puncher", roleId: "puncher", visual: { kind: "puncher" } },
  { id: "crate", roleId: "pushable", visual: { kind: "cube" } },
  { id: "floating-floor", roleId: "floating-floor", visual: { kind: "platform" } }
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

test("play animation timing defaults to 105 ms and zero skips to the final frame", async () => {
  assert.equal(DEFAULT_PLAY_FRAME_DELAY_MS, 105);
  const room = {
    width: 1,
    height: 3,
    objects: [{ x: 0, y: 2, z: 0, blockId: "player" }]
  };
  const middle = {
    ...room,
    objects: [{ x: 0, y: 1, z: 0, blockId: "player" }]
  };
  const final = {
    ...room,
    objects: [{ x: 0, y: 0, z: 0, blockId: "player" }]
  };
  const seen = [];
  const fakeEngine = {
    createState: (value) => structuredClone(value),
    simulateCommand: async () => ({ frames: [middle, final], final, cycle: null })
  };
  const session = new PlaySessionV1(fakeEngine, blocks, {
    frameDelay: 0,
    onFrame: (state) => seen.push(state.objects[0].y)
  });
  session.open(room);
  seen.length = 0;
  await session.move("up");
  assert.deepEqual(seen, [0]);
  assert.equal(session.state.objects[0].y, 0);
  assert.equal(session.setFrameDelay(105), 105);
  assert.throws(() => session.setFrameDelay(-1), /non-negative number/);
});

test("connected play reloads rooms normally and undo crosses back with exact state", async () => {
  const { engine } = await loadEngine();
  const roomA = {
    fileName: "a.json",
    position: ["A", "A"],
    columnIndex: 0,
    rowIndex: 0,
    width: 3,
    height: 2,
    objects: [
      { x: 1, y: 0, z: 0, blockId: "player" },
      { x: 1, y: 0, z: 0, blockId: "floor" },
      { x: 2, y: 0, z: 0, blockId: "floor" },
      { x: 0, y: 1, z: 0, blockId: "gem" }
    ]
  };
  const roomB = {
    fileName: "b.json",
    position: ["B", "A"],
    columnIndex: 1,
    rowIndex: 0,
    width: 3,
    height: 2,
    objects: [
      { x: 1, y: 1, z: 0, blockId: "player" },
      { x: 0, y: 0, z: 0, blockId: "floor" }
    ]
  };
  const connectedWorld = new ConnectedWorldSessionV1(engine, blocks, [roomA, roomB]);
  const entered = [];
  const session = new PlaySessionV1(engine, blocks, {
    frameDelay: 0,
    onRoomChange: (room) => entered.push(room.fileName),
    resolveCommand: (state, room, direction) =>
      connectedWorld.simulateCommand(state, room, direction)
  });
  session.open(roomA);
  session.state.objects.find((object) => object.blockId === "gem").x = -1;

  await session.move("right");
  assert.equal(session.room, roomA);
  assert.deepEqual(
    session.state.objects.filter((object) => object.blockId === "player")
      .map(({ x, y }) => ({ x, y })),
    [{ x: 2, y: 0 }]
  );
  const stateBeforeTransition = structuredClone(session.state);

  await session.move("right");
  assert.equal(session.room, roomB);
  assert.deepEqual(
    session.state.objects.filter((object) => object.blockId === "player")
      .map(({ x, y }) => ({ x, y })),
    [{ x: 0, y: 0 }]
  );
  assert.equal(session.history.length, 2);

  assert.equal(session.undo(), true);
  assert.equal(session.room, roomA);
  assert.deepEqual(
    session.state.objects.filter((object) => object.blockId === "player")
      .map(({ x, y }) => ({ x, y })),
    [{ x: 2, y: 0 }]
  );
  assert.deepEqual(session.state, stateBeforeTransition);
  assert.equal(session.moves, 1);
  assert.deepEqual(entered, ["b.json", "a.json"]);

  await session.move("right");
  assert.equal(session.room, roomB);

  await session.move("left");
  assert.equal(session.room, roomA);
  assert.equal(session.state.objects.some((object) =>
    object.blockId === "gem" && object.x === 0 && object.y === 1), true);
  assert.equal(session.moves, 3);
  assert.deepEqual(entered, ["b.json", "a.json", "b.json", "a.json"]);
});

test("one Ice command dynamically combines only the rooms reached by a long slide", async () => {
  const { engine } = await loadEngine();
  const makeRoom = (fileName, columnIndex, objects) => ({
    fileName,
    position: [String.fromCharCode(65 + columnIndex), "A"],
    columnIndex,
    rowIndex: 0,
    width: 3,
    height: 2,
    objects
  });
  const support = (blockId, x) => ({ x, y: 0, z: 0, blockId });
  const roomA = makeRoom("ice-a.json", 0, [
    { x: 0, y: 0, z: 0, blockId: "player" },
    support("floor", 0),
    support("ice-floor", 1),
    support("ice-floor", 2)
  ]);
  const roomB = makeRoom("ice-b.json", 1, [
    { x: 1, y: 1, z: 0, blockId: "player" },
    support("ice-floor", 0),
    support("ice-floor", 1),
    support("ice-floor", 2)
  ]);
  const roomC = makeRoom("ice-c.json", 2, [
    { x: 1, y: 1, z: 0, blockId: "player" },
    support("ice-floor", 0),
    support("ice-floor", 1),
    support("floor", 2)
  ]);
  const connectedWorld = new ConnectedWorldSessionV1(engine, blocks, [roomA, roomB, roomC]);
  const result = await connectedWorld.simulateCommand(engine.createState(roomA), roomA, "right");

  assert.equal(result.room, roomC);
  assert.deepEqual(
    result.final.objects.filter((object) => object.blockId === "player")
      .map(({ x, y }) => ({ x, y })),
    [{ x: 2, y: 0 }]
  );
  assert.deepEqual([...new Set(result.animationFrames.map(({ room }) => room.fileName))], [
    "ice-a.json",
    "ice-b.json",
    "ice-c.json"
  ]);
});

test("a redirected punch grows an L-shaped temporary level without adding the missing room", async () => {
  const { engine } = await loadEngine();
  const makeRoom = (fileName, columnIndex, rowIndex, objects) => ({
    fileName,
    position: [String.fromCharCode(65 + columnIndex), String.fromCharCode(65 + rowIndex)],
    columnIndex,
    rowIndex,
    width: 4,
    height: 4,
    objects
  });
  const floor = (x, y) => ({ x, y, z: 0, blockId: "floor" });
  const roomA = makeRoom("punch-a.json", 0, 0, [
    { x: 1, y: 2, z: 0, blockId: "player" },
    { x: 1, y: 1, z: 0, blockId: "puncher", orientation: "right", stateId: 0 },
    floor(1, 2), floor(1, 1), floor(2, 1), floor(3, 1)
  ]);
  const roomB = makeRoom("punch-b.json", 1, 0, [
    { x: 0, y: 1, z: 0, blockId: "player" },
    { x: 2, y: 1, z: 0, blockId: "puncher", orientation: "down", stateId: 0 },
    floor(0, 1), floor(1, 1), floor(2, 1), floor(2, 2), floor(2, 3)
  ]);
  const roomC = makeRoom("punch-c.json", 1, 1, [
    { x: 0, y: 0, z: 0, blockId: "player" },
    floor(2, 0), floor(2, 1), floor(2, 2), floor(2, 3),
    { x: 2, y: 3, z: 0, blockId: "wall" }
  ]);
  const unvisitedRoom = makeRoom("not-visited.json", 0, 1, [
    { x: 0, y: 0, z: 0, blockId: "player" },
    floor(0, 0)
  ]);
  const connectedWorld = new ConnectedWorldSessionV1(
    engine,
    blocks,
    [roomA, roomB, roomC, unvisitedRoom]
  );
  const result = await connectedWorld.simulateCommand(engine.createState(roomA), roomA, "up");

  assert.equal(result.room, roomC);
  assert.deepEqual(
    result.final.objects.filter((object) => object.blockId === "player")
      .map(({ x, y }) => ({ x, y })),
    [{ x: 2, y: 2 }]
  );
  assert.deepEqual([...new Set(result.animationFrames.map(({ room }) => room.fileName))], [
    "punch-a.json",
    "punch-b.json",
    "punch-c.json"
  ]);
  assert.equal(result.connectedRooms.includes("not-visited.json"), false);
});

test("engine v1 is the byte-identical UnitTest WebAssembly build", async () => {
  const { bytes, engine } = await loadEngine();
  assert.match(ENGINE_SOURCE_COMMIT, /^[0-9a-f]{40}$/);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), ENGINE_WASM_SHA256);
  assert.deepEqual(engine.info, {
    version: "v1",
    abi: 4,
    voxelCapacity: 65_536,
    searchVoxelCapacity: 4_096,
    searchNodeCapacity: 180_000
  });
});

test("every vendored engine file matches its recorded upstream hash", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../engine/v1/upstream.json", import.meta.url), "utf8")
  );
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.sourceRepository, ENGINE_SOURCE_REPOSITORY);
  assert.equal(manifest.sourceCommit, ENGINE_SOURCE_COMMIT);
  assert.equal(manifest.sourceTree, ENGINE_SOURCE_TREE);
  assert.equal(manifest.wasm.sha256, ENGINE_WASM_SHA256);

  const wasm = await readFile(new URL("../engine/v1/voxel_physics.wasm", import.meta.url));
  assert.equal(wasm.byteLength, manifest.wasm.bytes);
  assert.equal(createHash("sha256").update(wasm).digest("hex"), manifest.wasm.sha256);

  for (const entry of manifest.files) {
    assert.equal(entry.path.startsWith("/") || entry.path.includes(".."), false);
    const contents = await readFile(new URL(`../engine/v1/core/${entry.path}`, import.meta.url));
    assert.equal(
      createHash("sha256").update(contents).digest("hex"),
      entry.sha256,
      `vendored engine file differs: ${entry.path}`
    );
  }
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

test("edge finder enumerates shortest boundary witnesses without gems", async () => {
  const { engine } = await loadEngine();
  const room = {
    width: 3,
    height: 3,
    objects: [{ x: 1, y: 1, z: 0, blockId: "player" }]
  };
  for (let y = 0; y < 3; y += 1) {
    for (let x = 0; x < 3; x += 1) {
      room.objects.push({ x, y, z: 0, blockId: "floor" });
    }
  }
  const result = engine.findEdges(room, blocks, { maximumNodes: 1_000 });
  assert.equal(result.status, "solved");
  assert.equal(result.proven, true);
  assert.equal(result.edgeCount, 12);
  assert.equal(result.edges.length, 12);
  assert.deepEqual(result.edges[0].solution, ["up", "up"]);

  const dynamic = {
    width: 4,
    height: 3,
    objects: [
      { x: 1, y: 2, z: 0, blockId: "player" },
      { x: 1, y: 1, z: 0, blockId: "crate" }
    ]
  };
  for (let y = 0; y < 3; y += 1) {
    for (let x = 0; x < 4; x += 1) {
      dynamic.objects.push({ x, y, z: 0, blockId: "floor" });
    }
  }
  const variants = engine.findEdges(dynamic, blocks, { maximumNodes: 1_000 });
  assert.ok(variants.edgeCount > 14, "different dynamic board states share edge coordinates");
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

test("player gates rise one frame after the player approaches", async () => {
  const { engine } = await loadEngine();
  const room = {
    width: 6,
    height: 6,
    objects: [
      { x: 0, y: 5, z: 0, blockId: "player" },
      { x: 0, y: 3, z: 0, blockId: "gate", stateId: 0 },
      { x: 0, y: 3, z: 0, blockId: "floor" },
      { x: 0, y: 4, z: 0, blockId: "floor" },
      { x: 0, y: 5, z: 0, blockId: "floor" }
    ]
  };
  const result = await engine.simulateCommand(room, "up", blocks);
  assert.equal(result.frames.length, 2);
  assert.equal(result.frames[0].objects[0].y, 4);
  assert.equal(result.frames[0].objects[1].stateId, 0);
  assert.equal(result.frames[1].objects[1].stateId, 1);
  assert.equal(result.final.objects[1].stateId, 1);
});

test("punchers encode direction, expose their sprung frame, and reset", async () => {
  const { engine } = await loadEngine();
  const room = {
    width: 5,
    height: 5,
    objects: [
      { x: 1, y: 3, z: 0, blockId: "player" },
      { x: 1, y: 2, z: 0, blockId: "puncher", orientation: "right", stateId: 0 },
      { x: 0, y: 2, z: 0, blockId: "wall" },
      { x: 4, y: 2, z: 0, blockId: "wall" },
      { x: 1, y: 3, z: 0, blockId: "floor" },
      { x: 1, y: 2, z: 0, blockId: "floor" },
      { x: 2, y: 2, z: 0, blockId: "floor" },
      { x: 3, y: 2, z: 0, blockId: "floor" },
      { x: 4, y: 2, z: 0, blockId: "floor" }
    ]
  };
  const result = await engine.simulateCommand(room, "up", blocks);
  assert.equal(result.frames.some((frame) => frame.objects[1].stateId === 1), true);
  assert.deepEqual(
    { x: result.final.objects[0].x, y: result.final.objects[0].y },
    { x: 3, y: 2 }
  );
  assert.equal(result.final.objects[1].orientation, "right");
  assert.equal(result.final.objects[1].stateId, 0);
});

test("a floating floor fills a Row-0 hole on the following tick", async () => {
  const { engine } = await loadEngine();
  const room = {
    width: 6,
    height: 6,
    objects: [
      { x: 0, y: 5, z: 0, blockId: "player" },
      { x: 0, y: 4, z: 0, blockId: "floating-floor" },
      { x: 0, y: 4, z: 0, blockId: "floor" },
      { x: 0, y: 5, z: 0, blockId: "floor" }
    ]
  };
  const result = await engine.simulateCommand(room, "up", blocks);
  assert.equal(result.frames.length, 2);
  assert.deepEqual(
    { y: result.frames[0].objects[1].y, z: result.frames[0].objects[1].z,
      blockId: result.frames[0].objects[1].blockId },
    { y: 3, z: 0, blockId: "floating-floor" }
  );
  assert.deepEqual(
    { y: result.final.objects[1].y, z: result.final.objects[1].z,
      blockId: result.final.objects[1].blockId },
    { y: 3, z: 0, blockId: "floor" }
  );
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
