import { engineRoleIdForObject } from "../../engine/v1/adapter.mjs";
import { ConnectedWorldSessionV1 } from "../../play/v1/connected-world-session.mjs";
import { stateFingerprintV1 } from "./analysis.mjs";

function cloneState(state) {
  return { width: state.width, height: state.height, objects: state.objects.map((object) => ({ ...object })) };
}

export function tagSolverObjectsV1(world, overrideRoom = null) {
  const rooms = world.rooms.map((room) => {
    const source = room.fileName === overrideRoom?.fileName ? overrideRoom : room;
    return {
      ...room,
      width: source.width,
      height: source.height,
      objects: source.objects.map((object, index) => ({
        ...object,
        solverObjectId: `${room.fileName}:${index}`
      }))
    };
  });
  return { ...world, rooms };
}

function roleIs(object, definitions, roleId) {
  return engineRoleIdForObject(object, definitions) === roleId;
}

function activePlayer(state, definitions) {
  return state.objects.find((object) => object.x >= 0 && object.y >= 0 &&
    object.x < state.width && object.y < state.height && roleIs(object, definitions, "player")) || null;
}

function activeGoals(state, definitions) {
  return new Set(state.objects.filter((object) => object.x >= 0 && object.y >= 0 &&
    object.x < state.width && object.y < state.height && roleIs(object, definitions, "goal"))
    .map((object) => object.solverObjectId));
}

function playerMarker(player) {
  return player ? { x: player.x, y: player.y, z: player.z } : null;
}

function collectFrameGoals(activeByRoom, collected, room, state, definitions) {
  const current = activeGoals(state, definitions);
  const previous = activeByRoom.get(room.fileName) || activeGoals(room, definitions);
  for (const id of previous) if (!current.has(id)) collected.add(id);
  activeByRoom.set(room.fileName, current);
}

async function replayWitness(engine, definitions, connected, startRoom, startState, inheritedGems, solution) {
  let room = startRoom;
  let state = cloneState(startState);
  let lastPlayer = activePlayer(state, definitions);
  const collected = new Set(inheritedGems);
  const activeByRoom = new Map([[room.fileName, activeGoals(state, definitions)]]);
  for (let step = 0; step < solution.length; step += 1) {
    const simulation = await connected.simulateCommand(state, room, solution[step]);
    const trace = simulation.animationFrames?.length
      ? [...simulation.animationFrames]
      : [{ room: simulation.room || room, state: simulation.final }];
    if (trace.at(-1)?.room?.fileName !== simulation.room?.fileName ||
        trace.at(-1)?.state !== simulation.final) {
      trace.push({ room: simulation.room || room, state: simulation.final });
    }
    const hops = [];
    let traceRoom = room;
    for (const frame of trace) {
      collectFrameGoals(activeByRoom, collected, frame.room, frame.state, definitions);
      const player = activePlayer(frame.state, definitions);
      if (frame.room.fileName !== traceRoom.fileName) {
        hops.push({
          fromRoomFileName: traceRoom.fileName,
          toRoomFileName: frame.room.fileName,
          exit: playerMarker(lastPlayer),
          entry: playerMarker(player)
        });
      }
      traceRoom = frame.room;
      if (player) lastPlayer = player;
    }
    state = simulation.final;
    if (simulation.room.fileName !== room.fileName) {
      return {
        solution: solution.slice(0, step + 1),
        destinationRoom: simulation.room,
        destinationState: state,
        collectedGemIds: [...collected].sort(),
        roomDependencies: [...new Set([startRoom.fileName, ...simulation.connectedRooms])],
        hops
      };
    }
    room = simulation.room;
  }
  return null;
}

export async function findRoomTransitionsV1(engine, definitions, world, node, options = {}) {
  const room = world.rooms.find((candidate) => candidate.fileName === node.roomFileName);
  if (!room) throw new Error(`Unknown solver room: ${node.roomFileName}`);
  const search = engine.findEdges(node.state, definitions, options);
  const connected = new ConnectedWorldSessionV1(engine, definitions, world.rooms);
  const outcomes = new Map();
  for (let index = 0; index < search.edges.length; index += 1) {
    if (options.isCancelled?.()) throw new DOMException("Edge search cancelled.", "AbortError");
    const outcome = await replayWitness(
      engine,
      definitions,
      connected,
      room,
      node.state,
      node.collectedGemIds || [],
      search.edges[index].solution
    );
    options.onProgress?.(index + 1, search.edges.length);
    if (!outcome?.hops.length) continue;
    const seamKey = outcome.hops.map((hop) => JSON.stringify(hop)).join("|");
    const key = `${stateFingerprintV1(
      outcome.destinationRoom.fileName,
      outcome.destinationState,
      outcome.collectedGemIds
    )}\n${seamKey}`;
    const previous = outcomes.get(key);
    if (!previous || outcome.solution.length < previous.solution.length) outcomes.set(key, outcome);
  }
  return {
    search: { ...search, edges: undefined },
    transitions: [...outcomes.values()]
  };
}
