export const WORLD_SOLVER_FORMAT_V1 = "mazebench-world-solver-v1";

const RUNTIME_KEYS = new Set([
  "connectedWorldBoundary",
  "renderDimmed",
  "solverObjectId"
]);

function canonical(value, omitRuntime = false) {
  if (Array.isArray(value)) return value.map((entry) => canonical(entry, omitRuntime));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort()
    .filter((key) => !(omitRuntime && RUNTIME_KEYS.has(key)))
    .map((key) => [key, canonical(value[key], omitRuntime)]));
}

function compactHash(source) {
  let left = 2166136261;
  let right = 2246822507;
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    left = Math.imul(left ^ code, 16777619);
    right = Math.imul(right ^ code, 3266489909);
  }
  return [left, right].map((value) => (value >>> 0).toString(16).padStart(8, "0")).join("");
}

export function roomRevisionV1(room) {
  return compactHash(JSON.stringify(canonical({
    width: room.width,
    height: room.height,
    objects: room.objects
  }, true)));
}

export function stateFingerprintV1(roomFileName, state, collectedGemIds = []) {
  return JSON.stringify(canonical({
    roomFileName,
    width: state.width,
    height: state.height,
    objects: state.objects,
    collectedGemIds: [...collectedGemIds].sort()
  }));
}

export function createWorldAnalysisV1(startRoom, state, roomRevisions) {
  return {
    format: WORLD_SOLVER_FORMAT_V1,
    version: 1,
    startRoomFileName: startRoom.fileName,
    roomRevisions: { ...roomRevisions },
    nodes: [{
      id: 0,
      parentId: null,
      incomingTransitionId: null,
      roomFileName: startRoom.fileName,
      state,
      collectedGemIds: [],
      analyzed: false
    }],
    transitions: [],
    complete: false,
    updatedAt: new Date().toISOString()
  };
}

export function invalidateAnalysisForRoomV1(analysis, roomFileName) {
  if (!analysis || analysis.format !== WORLD_SOLVER_FORMAT_V1) {
    return { analysis, invalidatedNodes: 0, invalidatedTransitions: 0 };
  }
  const invalidNodes = new Set(analysis.nodes
    .filter((node) => node.roomFileName === roomFileName)
    .map((node) => node.id));
  const invalidTransitions = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const transition of analysis.transitions) {
      if (invalidTransitions.has(transition.id)) continue;
      if (invalidNodes.has(transition.fromNodeId) ||
          transition.roomDependencies?.includes(roomFileName)) {
        invalidTransitions.add(transition.id);
        if (!invalidNodes.has(transition.toNodeId)) {
          invalidNodes.add(transition.toNodeId);
          changed = true;
        }
      }
    }
    for (const node of analysis.nodes) {
      if (node.parentId !== null && invalidNodes.has(node.parentId) &&
          !invalidNodes.has(node.id)) {
        invalidNodes.add(node.id);
        changed = true;
      }
    }
  }

  const removedFrom = new Set(analysis.transitions
    .filter((transition) => invalidTransitions.has(transition.id) ||
      invalidNodes.has(transition.fromNodeId) || invalidNodes.has(transition.toNodeId))
    .map((transition) => transition.fromNodeId));
  const nodes = analysis.nodes
    .filter((node) => !invalidNodes.has(node.id))
    .map((node) => removedFrom.has(node.id) ? { ...node, analyzed: false } : node);
  const validNodeIds = new Set(nodes.map((node) => node.id));
  const transitions = analysis.transitions.filter((transition) =>
    !invalidTransitions.has(transition.id) &&
    validNodeIds.has(transition.fromNodeId) && validNodeIds.has(transition.toNodeId));
  const roomRevisions = { ...analysis.roomRevisions };
  delete roomRevisions[roomFileName];
  return {
    analysis: {
      ...analysis,
      roomRevisions,
      nodes,
      transitions,
      complete: false,
      updatedAt: new Date().toISOString()
    },
    invalidatedNodes: analysis.nodes.length - nodes.length,
    invalidatedTransitions: analysis.transitions.length - transitions.length
  };
}

export function invalidateStaleRoomsV1(analysis, roomRevisions) {
  let next = analysis;
  let invalidatedNodes = 0;
  let invalidatedTransitions = 0;
  for (const [fileName, revision] of Object.entries(roomRevisions)) {
    if (next?.roomRevisions?.[fileName] === revision) continue;
    const invalidation = invalidateAnalysisForRoomV1(next, fileName);
    next = invalidation.analysis;
    invalidatedNodes += invalidation.invalidatedNodes;
    invalidatedTransitions += invalidation.invalidatedTransitions;
  }
  if (next) next.roomRevisions = { ...roomRevisions };
  return { analysis: next, invalidatedNodes, invalidatedTransitions };
}

export function worldAnalysisStatsV1(analysis) {
  const nodes = analysis?.nodes || [];
  const transitions = analysis?.transitions || [];
  const rooms = new Set(nodes.map((node) => node.roomFileName));
  const gems = new Set(nodes.flatMap((node) => node.collectedGemIds || []));
  return {
    rooms: rooms.size,
    entryStates: Math.max(0, nodes.length - 1),
    transitions: transitions.length,
    analyzedStates: nodes.filter((node) => node.analyzed).length,
    pendingStates: nodes.filter((node) => !node.analyzed).length,
    reachableGems: gems.size,
    bestRouteGems: Math.max(0, ...nodes.map((node) => node.collectedGemIds?.length || 0))
  };
}

export function masterRouteForNodeV1(analysis, nodeId) {
  const nodes = new Map((analysis?.nodes || []).map((node) => [node.id, node]));
  const transitions = new Map((analysis?.transitions || []).map((edge) => [edge.id, edge]));
  const parts = [];
  let node = nodes.get(nodeId);
  while (node?.incomingTransitionId !== null && node?.incomingTransitionId !== undefined) {
    const transition = transitions.get(node.incomingTransitionId);
    if (!transition) break;
    parts.push(transition.solution || []);
    node = nodes.get(node.parentId);
  }
  return parts.reverse().flat();
}
