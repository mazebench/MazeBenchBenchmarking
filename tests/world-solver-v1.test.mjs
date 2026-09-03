import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { instantiateMazeBenchEngineV1 } from "../engine/v1/engine.mjs";

import {
  WORLD_SOLVER_FORMAT_V1,
  invalidateAnalysisForRoomV1,
  masterRouteForNodeV1,
  nextWorldNodeV1,
  roomRevisionV1,
  stateFingerprintV1,
  worldAnalysisStatsV1
} from "../world-solver/v1/analysis.mjs";
import {
  graphPointForRoomV1,
  transitionGraphPathV1,
  WORLD_SOLVER_START_POSITION_V1
} from "../world-solver/v1/graph.mjs";
import { findRoomTransitionsV1, tagSolverObjectsV1 } from "../world-solver/v1/runtime.mjs";

test("world state identity keeps coincident entries with different board states", () => {
  const left = { width: 2, height: 2, objects: [
    { x: 0, y: 0, z: 0, blockId: "player" },
    { x: 1, y: 1, z: 0, blockId: "crate" }
  ] };
  const right = { ...left, objects: left.objects.map((object) => ({ ...object })) };
  right.objects[1].x = 0;
  assert.notEqual(stateFingerprintV1("room.json", left), stateFingerprintV1("room.json", right));
  assert.notEqual(stateFingerprintV1("room.json", left, ["gem-a"]), stateFingerprintV1("room.json", left));
  assert.equal(roomRevisionV1(left), roomRevisionV1(structuredClone(left)));
});

test("editing a routed room removes that branch and every downstream route", () => {
  const analysis = {
    format: WORLD_SOLVER_FORMAT_V1,
    roomRevisions: { A: "a", B: "b", C: "c", D: "d" },
    nodes: [
      { id: 0, parentId: null, roomFileName: "A", analyzed: true, collectedGemIds: [] },
      { id: 1, parentId: 0, incomingTransitionId: 10, roomFileName: "B", analyzed: true, collectedGemIds: ["g1"] },
      { id: 2, parentId: 0, incomingTransitionId: 11, roomFileName: "C", analyzed: true, collectedGemIds: [] },
      { id: 3, parentId: 1, incomingTransitionId: 12, roomFileName: "D", analyzed: true, collectedGemIds: ["g1", "g2"] }
    ],
    transitions: [
      { id: 10, fromNodeId: 0, toNodeId: 1, roomDependencies: ["A", "B"], solution: ["right"] },
      { id: 11, fromNodeId: 0, toNodeId: 2, roomDependencies: ["A", "C"], solution: ["left"] },
      { id: 12, fromNodeId: 1, toNodeId: 3, roomDependencies: ["B", "D"], solution: ["down"] }
    ],
    complete: true
  };
  const result = invalidateAnalysisForRoomV1(analysis, "B");
  assert.deepEqual(result.analysis.nodes.map((node) => node.id), [0, 2]);
  assert.deepEqual(result.analysis.transitions.map((edge) => edge.id), [11]);
  assert.equal(result.analysis.nodes[0].analyzed, false);
  assert.equal(result.invalidatedNodes, 2);
  assert.deepEqual(masterRouteForNodeV1(result.analysis, 2), ["left"]);
  assert.deepEqual(worldAnalysisStatsV1(result.analysis), {
    rooms: 2,
    entryStates: 1,
    transitions: 1,
    analyzedStates: 1,
    pendingStates: 1,
    reachableGems: 0,
    bestRouteGems: 0
  });
});

test("world exploration prioritizes the first state in a newly reached room", () => {
  const analysis = { nodes: [
    { id: 0, roomFileName: "H-I", analyzed: true, searchStatus: "solved" },
    { id: 1, roomFileName: "H-H", analyzed: true, searchStatus: "limit-hit", searchMaximumNodes: 12000 },
    { id: 2, roomFileName: "H-H", analyzed: false },
    { id: 3, roomFileName: "H-G", analyzed: false }
  ] };
  assert.equal(nextWorldNodeV1(analysis, 12000).id, 3);
  assert.equal(nextWorldNodeV1(analysis, 180000).id, 3);
  analysis.nodes[3].analyzed = true;
  assert.equal(nextWorldNodeV1(analysis, 12000).id, 2);
});

test("world graph paths connect exact player, exit, and entry positions", () => {
  assert.deepEqual(WORLD_SOLVER_START_POSITION_V1, ["H", "I"]);
  const rooms = [
    { fileName: "left", columnIndex: 0, rowIndex: 0, width: 2, height: 2 },
    { fileName: "right", columnIndex: 1, rowIndex: 0, width: 2, height: 2 }
  ];
  const analysis = { nodes: [
    { id: 0, roomFileName: "left", state: { width: 2, height: 2, objects: [
      { x: 0, y: 1, z: 0, blockId: "player" }
    ] } },
    { id: 1, roomFileName: "right", state: { width: 2, height: 2, objects: [
      { x: 1, y: 0, z: 0, blockId: "player" }
    ] } }
  ] };
  const transition = { fromNodeId: 0, toNodeId: 1, hops: [{
    fromRoomFileName: "left",
    toRoomFileName: "right",
    exit: { x: 1, y: 1 },
    entry: { x: 0, y: 1 }
  }] };
  assert.deepEqual(graphPointForRoomV1(rooms[0], { x: 0, y: 1 }), { x: 0.25, y: 0.75 });
  assert.equal(
    transitionGraphPathV1(analysis, transition, rooms),
    "M0.25 0.75 L0.75 0.75 L1.25 0.75 L1.75 0.25"
  );
});

test("edge witnesses replay through connected-world transitions", async () => {
  const bytes = await readFile(new URL("../engine/v1/voxel_physics.wasm", import.meta.url));
  const engine = await instantiateMazeBenchEngineV1(bytes);
  const blocks = [
    { id: "floor", roleId: "floor", visual: { kind: "floor" } },
    { id: "wall", roleId: "solid", visual: { kind: "cube" } },
    { id: "player", roleId: "player", visual: { kind: "cube" } }
  ];
  const room = (fileName, columnIndex, objects) => ({
    fileName,
    position: [columnIndex ? "B" : "A", "A"],
    columnIndex,
    rowIndex: 0,
    width: 3,
    height: 2,
    objects
  });
  const world = tagSolverObjectsV1({
    blocks,
    rooms: [
      room("a.json", 0, [
        { x: 1, y: 0, z: 0, blockId: "player" },
        { x: 1, y: 0, z: 0, blockId: "floor" },
        { x: 2, y: 0, z: 0, blockId: "floor" }
      ]),
      room("b.json", 1, [
        { x: 1, y: 1, z: 0, blockId: "player" },
        { x: 0, y: 0, z: 0, blockId: "floor" }
      ])
    ]
  });
  const start = world.rooms[0];
  const result = await findRoomTransitionsV1(engine, blocks, world, {
    roomFileName: start.fileName,
    state: engine.createState(start),
    collectedGemIds: []
  }, { maximumNodes: 1000, maximumEdges: 32 });
  const crossing = result.transitions.find((transition) =>
    transition.destinationRoom.fileName === "b.json");
  assert.ok(crossing);
  assert.deepEqual(crossing.solution, ["right", "right"]);
  assert.deepEqual(crossing.hops, [{
    fromRoomFileName: "a.json",
    toRoomFileName: "b.json",
    exit: { x: 2, y: 0, z: 0 },
    entry: { x: 0, y: 0, z: 0 }
  }]);
});
