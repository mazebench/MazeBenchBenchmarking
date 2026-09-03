import { loadMazeBenchEngineV1 } from "../../engine/v1/engine.mjs";
import { loadMainWorldV2 } from "../../render/v1/voxel-world-v2.mjs";
import {
  createWorldAnalysisV1,
  invalidateStaleRoomsV1,
  roomRevisionV1,
  stateFingerprintV1,
  WORLD_SOLVER_FORMAT_V1,
  worldAnalysisStatsV1
} from "./analysis.mjs";
import { findRoomTransitionsV1, tagSolverObjectsV1 } from "./runtime.mjs";

let cancelled = false;

function post(type, payload = {}) {
  self.postMessage({ type, ...payload });
}

async function savedAnalysis() {
  const response = await fetch("/api/world-solver/v1");
  if (!response.ok) return null;
  const value = await response.json();
  return value?.format === WORLD_SOLVER_FORMAT_V1 ? value : null;
}

async function saveAnalysis(analysis) {
  const response = await fetch("/api/world-solver/v1", {
    method: "PUT",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(analysis)
  });
  if (!response.ok) throw new Error((await response.json()).error || "Could not save world analysis.");
  return await savedAnalysis();
}

function revisionsFor(world) {
  return Object.fromEntries(world.rooms.map((room) => [room.fileName, roomRevisionV1(room)]));
}

function nextId(entries) {
  return Math.max(-1, ...entries.map((entry) => entry.id)) + 1;
}

async function runWorld(message) {
  const [engine, loadedWorld] = await Promise.all([loadMazeBenchEngineV1(), loadMainWorldV2()]);
  const world = tagSolverObjectsV1(loadedWorld);
  const revisions = revisionsFor(loadedWorld);
  const startRoom = world.rooms.find((room) => room.fileName === message.startRoomFileName) || world.rooms[0];
  let analysis = message.resume === false ? null : await savedAnalysis();
  if (!analysis || analysis.startRoomFileName !== startRoom.fileName) {
    analysis = createWorldAnalysisV1(startRoom, engine.createState(startRoom), revisions);
  } else {
    analysis = invalidateStaleRoomsV1(analysis, revisions).analysis;
    if (!analysis.nodes.length) {
      analysis = createWorldAnalysisV1(startRoom, engine.createState(startRoom), revisions);
    }
  }

  const maximumStates = Math.max(1, Number(message.maximumStates) || 512);
  const maximumStatesPerRoom = Math.max(1, Number(message.maximumStatesPerRoom) || 32);
  const options = {
    maximumNodes: Math.max(1, Number(message.maximumNodes) || 12_000),
    maximumEdges: Math.max(1, Number(message.maximumEdges) || 512),
    isCancelled: () => cancelled
  };
  const fingerprints = new Map(analysis.nodes.map((node) => [
    stateFingerprintV1(node.roomFileName, node.state, node.collectedGemIds), node
  ]));
  let nodeId = nextId(analysis.nodes);
  let transitionId = nextId(analysis.transitions);
  let omittedStates = analysis.omittedStates || 0;

  for (;;) {
    if (cancelled) throw new DOMException("World solver cancelled.", "AbortError");
    const node = analysis.nodes.find((candidate) => !candidate.analyzed ||
      (candidate.searchStatus === "limit-hit" && candidate.searchMaximumNodes < options.maximumNodes));
    if (!node) break;
    post("progress", {
      message: `Searching ${node.roomFileName} entry ${node.id}…`,
      stats: worldAnalysisStatsV1(analysis)
    });
    const result = await findRoomTransitionsV1(engine, world.blocks, world, node, options);
    node.analyzed = true;
    node.searchStatus = result.search.status;
    node.searchMaximumNodes = options.maximumNodes;
    for (const outcome of result.transitions) {
      const key = stateFingerprintV1(
        outcome.destinationRoom.fileName,
        outcome.destinationState,
        outcome.collectedGemIds
      );
      let destination = fingerprints.get(key);
      const roomCount = analysis.nodes.filter((candidate) =>
        candidate.roomFileName === outcome.destinationRoom.fileName).length;
      if (!destination && (analysis.nodes.length >= maximumStates || roomCount >= maximumStatesPerRoom)) {
        omittedStates += 1;
        continue;
      }
      const id = transitionId++;
      if (!destination) {
        destination = {
          id: nodeId++,
          parentId: node.id,
          incomingTransitionId: id,
          roomFileName: outcome.destinationRoom.fileName,
          state: outcome.destinationState,
          collectedGemIds: outcome.collectedGemIds,
          analyzed: false
        };
        analysis.nodes.push(destination);
        fingerprints.set(key, destination);
      }
      const duplicate = analysis.transitions.some((transition) =>
        transition.fromNodeId === node.id && transition.toNodeId === destination.id &&
        JSON.stringify(transition.hops) === JSON.stringify(outcome.hops));
      if (duplicate) continue;
      analysis.transitions.push({
        id,
        fromNodeId: node.id,
        toNodeId: destination.id,
        solution: outcome.solution,
        hops: outcome.hops,
        roomDependencies: outcome.roomDependencies,
        collectedGemIds: outcome.collectedGemIds
      });
    }
    analysis.omittedStates = omittedStates;
    analysis.updatedAt = new Date().toISOString();
  }
  analysis.complete = analysis.nodes.every((node) => node.analyzed && node.searchStatus === "solved") &&
    analysis.nodes.length < maximumStates && omittedStates === 0;
  analysis.updatedAt = new Date().toISOString();
  analysis = await saveAnalysis(analysis) || analysis;
  post("complete", { analysis, stats: worldAnalysisStatsV1(analysis) });
}

async function runRoom(message) {
  const [engine, loadedWorld] = await Promise.all([loadMazeBenchEngineV1(), loadMainWorldV2()]);
  const tagged = tagSolverObjectsV1(loadedWorld, message.room);
  const room = tagged.rooms.find((candidate) => candidate.fileName === message.room.fileName);
  const starts = [{
    id: "authored",
    roomFileName: room.fileName,
    state: engine.createState(room),
    collectedGemIds: []
  }];
  if (message.includeSavedEntries) {
    const saved = await savedAnalysis();
    if (saved?.roomRevisions?.[room.fileName] === roomRevisionV1(message.room)) {
      starts.push(...saved.nodes.filter((node) => node.roomFileName === room.fileName));
    }
  }
  const unique = new Map(starts.map((node) => [
    stateFingerprintV1(node.roomFileName, node.state, node.collectedGemIds), node
  ]));
  const results = [];
  for (const node of unique.values()) {
    if (cancelled) throw new DOMException("Edge finder cancelled.", "AbortError");
    post("progress", { message: `Searching entry ${node.id} in ${room.fileName}…` });
    const found = await findRoomTransitionsV1(engine, tagged.blocks, tagged, node, message);
    results.push({
      startId: node.id,
      search: found.search,
      transitions: found.transitions.map((transition) => ({
        ...transition,
        destinationRoom: {
          fileName: transition.destinationRoom.fileName,
          position: transition.destinationRoom.position
        }
      }))
    });
  }
  post("complete", { results });
}

self.addEventListener("message", async (event) => {
  const message = event.data || {};
  if (message.type === "cancel") {
    cancelled = true;
    return;
  }
  cancelled = false;
  try {
    if (message.scope === "room") await runRoom(message);
    else await runWorld(message);
  } catch (error) {
    if (error?.name === "AbortError") post("cancelled");
    else post("error", { error: error?.message || "World solver failed." });
  }
});
