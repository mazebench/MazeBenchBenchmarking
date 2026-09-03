import { engineRoleIdForObject } from "../../engine/v1/adapter.mjs";

export const ROOM_BFS_START_POSITION_V1 = Object.freeze(["H", "I"]);
export const ROOM_BFS_DIRECTIONS_V1 = Object.freeze(["up", "right", "down", "left"]);
export const ROOM_BFS_META_STRATEGIES_V1 = Object.freeze([
  "breadth",
  "depth",
  "super-astar",
  "row-astar"
]);

const yieldToBrowser = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs));

function definitionsMap(definitions) {
  return definitions instanceof Map
    ? definitions
    : new Map((definitions || []).map((definition) => [definition.id, definition]));
}

function prepareState(state, definitions) {
  const dynamic = [];
  const fixed = [];
  for (const object of state.objects) {
    const roleId = engineRoleIdForObject(object, definitions);
    const target = roleId === "floor" || roleId === "ice" || roleId === "solid" ||
      roleId === "goal" || roleId.startsWith("ice-slope-") ? fixed : dynamic;
    target.push({ ...object });
  }
  return {
    state: { width: state.width, height: state.height, objects: [...dynamic, ...fixed] },
    dynamicVoxelCount: dynamic.length
  };
}

function now() {
  return globalThis.performance?.now?.() ?? Date.now();
}

export async function runRoomBfsV1(engine, world, options = {}) {
  const definitions = definitionsMap(world.blockDefinitions || world.blocks);
  const startPosition = options.startPosition || ROOM_BFS_START_POSITION_V1;
  const startRoom = world.rooms.find((candidate) =>
    candidate.position?.[0] === startPosition[0] &&
    candidate.position?.[1] === startPosition[1]);
  if (!startRoom) throw new Error(`BFS starter room ${startPosition.join("×")} is missing.`);
  if (typeof engine.exports.room_bfs_begin !== "function") {
    throw new Error("The World Solver accelerator does not include room BFS.");
  }
  const metaStrategy = ROOM_BFS_META_STRATEGIES_V1.includes(options.metaStrategy)
    ? options.metaStrategy
    : "breadth";
  const mode = metaStrategy === "depth"
    ? "dfs-meta"
    : metaStrategy === "super-astar"
      ? "super-astar"
      : metaStrategy === "row-astar" ? "row-astar" : "bfs";
  const heuristicWeight = Math.max(1, Math.min(
    16,
    Math.floor(Number(options.heuristicWeight) || 3)
  ));
  if (metaStrategy === "super-astar" &&
      (typeof engine.exports.super_astar_begin !== "function" ||
       typeof engine.exports.super_astar_run !== "function")) {
    throw new Error("The World Solver accelerator does not include Super A*.");
  }
  if (metaStrategy === "row-astar" &&
      (typeof engine.exports.row_astar_begin !== "function" ||
       typeof engine.exports.row_astar_run !== "function")) {
    throw new Error("The World Solver accelerator does not include Row A*.");
  }
  const chunkSize = Math.max(1, Math.floor(Number(options.chunkSize) || 512));
  const progressDelayMs = options.progressDelayMs === undefined
    ? 0
    : Math.max(0, Number(options.progressDelayMs) || 0);
  const maximumRooms = Math.max(1, Math.floor(Number(options.maximumRooms) || world.rooms.length));
  const worldWidth = world.columns?.length
    ? world.columns.length * world.roomWidth
    : startRoom.width;
  const worldHeight = world.rows?.length
    ? world.rows.length * world.roomHeight
    : startRoom.height;
  const fallbackPlayer = startRoom.objects.find((object) =>
    engineRoleIdForObject(object, definitions) === "player");
  if (!fallbackPlayer) throw new Error("Place a player in H×I before running World BFS.");

  const roomAt = new Map(world.rooms.map((room) => [
    `${room.columnIndex},${room.rowIndex}`,
    room
  ]));
  let nextSequence = 0;
  const makeFrame = (room, entry, depth = 0) => ({
    room,
    entry,
    depth,
    sequence: nextSequence++,
    slices: 0,
    lastGemCount: 0,
    authoredGoals: room.objects.filter((object) =>
      engineRoleIdForObject(object, definitions) === "goal").length,
    snapshot: null,
    sentVisited: new Uint8Array(room.width * room.height),
    sentEdges: 0,
    edgeCursor: 0,
    searchStatus: "open"
  });
  const queue = [];
  const stack = [];
  const portfolio = [];
  let active = makeFrame(startRoom, null);
  const discovered = new Map([[startRoom.fileName, startRoom]]);
  let pendingRooms = [startRoom];
  let pendingRoomUpdates = [{
    fileName: startRoom.fileName,
    position: startRoom.position,
    columnIndex: startRoom.columnIndex,
    rowIndex: startRoom.rowIndex,
    searchStatus: "open"
  }];
  const globalExitCells = new Set();
  let completedRooms = 0;
  const completed = {
    states: 0,
    expanded: 0,
    transitions: 0,
    edgeStates: 0,
    gems: 0
  };
  const startedAt = now();
  let computeMs = 0;
  let searchSlices = 0;

  const worldCell = (room, localCell) => {
    const x = room.columnIndex * room.width + localCell % room.width;
    const y = room.rowIndex * room.height + Math.floor(localCell / room.width);
    return y * worldWidth + x;
  };

  const stateForEntry = (room, entry) => {
    const state = engine.createState(room);
    if (!entry) return state;
    state.objects = state.objects.filter((object) =>
      engineRoleIdForObject(object, definitions) !== "player");
    state.objects.push({
      ...fallbackPlayer,
      x: entry.cell % room.width,
      y: Math.floor(entry.cell / room.width),
      z: entry.engineZ - 1
    });
    return state;
  };

  const liveCounters = () => ({
    states: engine.exports.room_bfs_states(),
    expanded: engine.exports.room_bfs_expanded(),
    transitions: engine.exports.room_bfs_transitions(),
    edgeStates: engine.exports.room_bfs_edge_count(),
    gems: engine.exports.room_bfs_collected_goals()
  });

  const addCounters = (target, source) => {
    for (const key of Object.keys(target)) target[key] += source[key] || 0;
  };

  const totals = () => {
    const result = { ...completed };
    for (const frame of [...stack, ...queue, ...portfolio]) {
      if (frame.snapshot) addCounters(result, frame.snapshot.counters);
    }
    if (active) addCounters(result, liveCounters());
    return result;
  };

  const capture = (frame) => {
    const stateCount = engine.exports.room_bfs_global_states();
    const stateWords = engine.exports.room_bfs_state_words();
    const stateBuffer = engine.exports.room_bfs_state_buffer();
    const states = new Uint16Array(
      engine.exports.memory.buffer,
      stateBuffer,
      stateCount * stateWords
    ).slice();
    const visited = new Uint32Array(8);
    for (let index = 0; index < visited.length; index += 1) {
      visited[index] = engine.exports.room_bfs_visited_word(index) >>> 0;
    }
    const edges = [];
    for (let index = 0; index < engine.exports.room_bfs_edge_count(); index += 1) {
      edges.push([
        engine.exports.room_bfs_edge_cell(index),
        engine.exports.room_bfs_edge_direction(index),
        engine.exports.room_bfs_edge_z(index)
      ]);
    }
    frame.snapshot = {
      stateCount,
      stateWords,
      states,
      head: engine.exports.room_bfs_head(),
      expanded: engine.exports.room_bfs_expanded(),
      localStates: engine.exports.room_bfs_states(),
      transitions: engine.exports.room_bfs_transitions(),
      fullPhysicsTransitions: engine.exports.room_bfs_full_physics_transitions(),
      generated: engine.exports.room_bfs_generated(),
      transpositions: engine.exports.room_bfs_transpositions(),
      latestCell: engine.exports.room_bfs_latest_cell(),
      collectedGoalsLow: engine.exports.room_bfs_collected_goals_low(),
      collectedGoalsHigh: engine.exports.room_bfs_collected_goals_high(),
      visited,
      edges,
      rowTargets: metaStrategy === "row-astar"
        ? Array.from({ length: engine.exports.row_astar_target_count() }, (_, index) => [
            engine.exports.row_astar_target_x(index),
            engine.exports.row_astar_target_y(index),
            engine.exports.row_astar_target_z(index),
            engine.exports.row_astar_target_visited(index)
          ])
        : [],
      rows: metaStrategy === "row-astar"
        ? Array.from({ length: engine.exports.row_astar_row_count() }, (_, index) =>
            engine.exports.row_astar_row(index))
        : [],
      counters: liveCounters()
    };
  };

  const boundaryMask = (frame) => {
    const { columnIndex, rowIndex } = frame.room;
    const neighbors = [
      [columnIndex, rowIndex - 1],
      [columnIndex + 1, rowIndex],
      [columnIndex, rowIndex + 1],
      [columnIndex - 1, rowIndex]
    ];
    return neighbors.reduce((mask, [column, row], direction) => {
      const room = roomAt.get(`${column},${row}`);
      return room && !discovered.has(room.fileName)
        ? mask | (1 << direction)
        : mask;
    }, 0);
  };

  const begin = (frame) => {
    const prepared = prepareState(stateForEntry(frame.room, frame.entry), definitions);
    engine.writeState(prepared.state, definitions);
    const started = metaStrategy === "super-astar"
      ? engine.exports.super_astar_begin(
          prepared.state.objects.length,
          prepared.state.width,
          prepared.state.height,
          prepared.dynamicVoxelCount,
          boundaryMask(frame),
          heuristicWeight
        )
      : metaStrategy === "row-astar"
        ? engine.exports.row_astar_begin(
            prepared.state.objects.length,
            prepared.state.width,
            prepared.state.height,
            prepared.dynamicVoxelCount,
            heuristicWeight
          )
      : engine.exports.room_bfs_begin(
          prepared.state.objects.length,
          prepared.state.width,
          prepared.state.height,
          prepared.dynamicVoxelCount
        );
    if (started !== 1) {
      throw new Error(`The exact BFS could not compile room ${frame.room.position.join("×")}.`);
    }
    if (!frame.snapshot) return "room-start";
    const snapshot = frame.snapshot;
    if (snapshot.stateWords !== engine.exports.room_bfs_state_words() ||
        snapshot.stateCount > engine.exports.room_bfs_state_capacity()) {
      throw new Error(`The suspended BFS for ${frame.room.position.join("×")} is incompatible.`);
    }
    new Uint16Array(
      engine.exports.memory.buffer,
      engine.exports.room_bfs_state_buffer(),
      snapshot.states.length
    ).set(snapshot.states);
    if (metaStrategy === "row-astar") {
      if (engine.exports.row_astar_restore_reset() !== 1) {
        throw new Error(`The Row A* landscape for ${frame.room.position.join("×")} could not reset.`);
      }
      for (const [x, y, z, visited] of snapshot.rowTargets) {
        if (engine.exports.row_astar_restore_target(x, y, z, visited) !== 1) {
          throw new Error(`The Row A* landscape for ${frame.room.position.join("×")} could not resume.`);
        }
      }
      for (const row of snapshot.rows) {
        if (engine.exports.row_astar_restore_row(row) !== 1) {
          throw new Error(`The Row A* rows for ${frame.room.position.join("×")} could not resume.`);
        }
      }
    }
    if (engine.exports.room_bfs_restore(
      snapshot.stateCount,
      snapshot.head,
      snapshot.expanded,
      snapshot.localStates,
      snapshot.transitions,
      snapshot.fullPhysicsTransitions,
      snapshot.generated,
      snapshot.transpositions,
      snapshot.latestCell,
      snapshot.collectedGoalsLow,
      snapshot.collectedGoalsHigh
    ) !== 1) {
      throw new Error(`The suspended BFS for ${frame.room.position.join("×")} could not resume.`);
    }
    for (let index = 0; index < snapshot.visited.length; index += 1) {
      engine.exports.room_bfs_restore_visited_word(index, snapshot.visited[index]);
    }
    for (const [cell, direction, z] of snapshot.edges) {
      engine.exports.room_bfs_restore_edge(cell, direction, z);
    }
    frame.snapshot = null;
    return "room-resume";
  };

  const neighborForEdge = (frame, edge) => {
    const room = frame.room;
    const direction = engine.exports.room_bfs_edge_direction(edge);
    const localCell = engine.exports.room_bfs_edge_cell(edge);
    const localX = localCell % room.width;
    const localY = Math.floor(localCell / room.width);
    const nextColumn = room.columnIndex + (direction === 1 ? 1 : direction === 3 ? -1 : 0);
    const nextRow = room.rowIndex + (direction === 2 ? 1 : direction === 0 ? -1 : 0);
    const nextRoom = roomAt.get(`${nextColumn},${nextRow}`);
    if (!nextRoom || discovered.has(nextRoom.fileName)) return null;
    const entryCell = direction === 1
      ? localY * nextRoom.width
      : direction === 3
        ? localY * nextRoom.width + nextRoom.width - 1
        : direction === 2
          ? localX
          : (nextRoom.height - 1) * nextRoom.width + localX;
    discovered.set(nextRoom.fileName, nextRoom);
    pendingRooms.push(nextRoom);
    const next = makeFrame(nextRoom, {
      cell: entryCell,
      engineZ: engine.exports.room_bfs_edge_z(edge)
    }, frame.depth + 1);
    pendingRoomUpdates.push({
      fileName: nextRoom.fileName,
      position: nextRoom.position,
      columnIndex: nextRoom.columnIndex,
      rowIndex: nextRoom.rowIndex,
      searchStatus: next.searchStatus
    });
    return next;
  };

  const discoverNeighbors = (frame, stopAfterFirst) => {
    const found = [];
    const edgeCount = engine.exports.room_bfs_edge_count();
    while (frame.edgeCursor < edgeCount) {
      const next = neighborForEdge(frame, frame.edgeCursor++);
      if (!next) continue;
      found.push(next);
      if (stopAfterFirst) break;
    }
    return found;
  };

  const finishActive = () => {
    addCounters(completed, liveCounters());
    completedRooms += 1;
  };

  const portfolioScore = (frame) => {
    const remainingGoals = metaStrategy === "row-astar"
      ? 0
      : Math.max(0, frame.authoredGoals - frame.lastGemCount);
    return frame.slices + frame.depth * 2 - Math.min(2, remainingGoals) * 0.75;
  };

  const comparePortfolioFrames = (left, right) =>
    portfolioScore(left) - portfolioScore(right) ||
    left.depth - right.depth ||
    left.sequence - right.sequence;

  const enqueuePortfolio = (...frames) => {
    portfolio.push(...frames);
    portfolio.sort(comparePortfolioFrames);
  };

  const takePortfolio = () => portfolio.shift() || null;

  let lastMessage = null;
  const report = (type, statusCode = 0) => {
      const room = active.room;
      if ((statusCode === 1 || statusCode === 4) &&
          active.searchStatus !== "searched") {
        active.searchStatus = "searched";
        pendingRoomUpdates.push({
          fileName: room.fileName,
          position: room.position,
          columnIndex: room.columnIndex,
          rowIndex: room.rowIndex,
          searchStatus: active.searchStatus
        });
      }
      const visitedCells = [];
      for (let wordIndex = 0; wordIndex < Math.ceil(active.sentVisited.length / 32); wordIndex += 1) {
        const word = engine.exports.room_bfs_visited_word(wordIndex) >>> 0;
        for (let bit = 0; bit < 32; bit += 1) {
          const cell = wordIndex * 32 + bit;
          if (cell >= active.sentVisited.length || active.sentVisited[cell] ||
              (word & (1 << bit)) === 0) continue;
          active.sentVisited[cell] = 1;
          visitedCells.push(worldCell(room, cell));
        }
      }
      const exitStates = [];
      const edgeCount = engine.exports.room_bfs_edge_count();
      for (; active.sentEdges < edgeCount; active.sentEdges += 1) {
        const localCell = engine.exports.room_bfs_edge_cell(active.sentEdges);
        const cell = worldCell(room, localCell);
        globalExitCells.add(cell);
        exitStates.push({
          cell,
          direction: ROOM_BFS_DIRECTIONS_V1[
            engine.exports.room_bfs_edge_direction(active.sentEdges)
          ]
        });
      }
      const current = liveCounters();
      const total = totals();
      const elapsedMs = now() - startedAt;
      lastMessage = {
        type,
        mode,
        metaStrategy,
        width: worldWidth,
        height: worldHeight,
        roomWidth: room.width,
        roomHeight: room.height,
        visitedCells,
        exitStates,
        trail: active.searchStatus === "searched"
          ? []
          : [worldCell(room, engine.exports.room_bfs_latest_cell())],
        trailReplaces: true,
        reachedRooms: pendingRooms.map((reached) => ({
          fileName: reached.fileName,
          position: reached.position,
          columnIndex: reached.columnIndex,
          rowIndex: reached.rowIndex
        })),
        roomUpdates: pendingRoomUpdates,
        stats: {
          states: total.states,
          statesPerSecond: computeMs > 0
            ? total.states * 1000 / computeMs
            : 0,
          actionsPerSecond: computeMs > 0
            ? total.transitions * 1000 / computeMs
            : 0,
          expanded: total.expanded,
          transitions: total.transitions,
          edgeStates: total.edgeStates,
          exitCells: globalExitCells.size,
          stateCapacity: engine.exports.room_bfs_state_capacity(),
          rooms: discovered.size,
          processedRooms: completedRooms,
          gems: total.gems,
          roomStates: current.states,
          activeSearches: 1 + stack.length + queue.length + portfolio.length,
          searchSlices,
          heuristicWeight: ["super-astar", "row-astar"].includes(metaStrategy)
            ? heuristicWeight
            : 0,
          opportunities: Math.max(0, discovered.size - 1) + total.gems,
          rowTargets: metaStrategy === "row-astar"
            ? engine.exports.row_astar_active_targets()
            : 0,
          rowVisited: metaStrategy === "row-astar"
            ? engine.exports.row_astar_visited_targets()
            : 0,
          rowsDiscovered: metaStrategy === "row-astar"
            ? engine.exports.row_astar_row_count()
            : 0,
          rowCoverageComplete: metaStrategy === "row-astar"
            ? engine.exports.row_astar_coverage_complete()
            : 0,
          currentRoom: room.position?.join("×") || room.fileName,
          elapsedMs,
          computeMs,
          statusCode
        }
      };
      pendingRooms = [];
      pendingRoomUpdates = [];
      options.onProgress?.(lastMessage);
      return lastMessage;
  };

  let firstRoom = true;
  while (active && completedRooms < maximumRooms) {
    const beginType = begin(active);
    report(firstRoom ? "ready" : beginType);
    firstRoom = false;
    let switched = false;
    while (!switched) {
      if (options.isCancelled?.()) throw new DOMException("World BFS stopped.", "AbortError");

      if (metaStrategy === "depth") {
        const [next] = discoverNeighbors(active, true);
        if (next) {
          capture(active);
          report("room-suspend");
          stack.push(active);
          active = next;
          switched = true;
          break;
        }
      }

      const computeStartedAt = now();
      const status = metaStrategy === "depth"
        ? engine.exports.room_bfs_run_until_edge(chunkSize)
        : metaStrategy === "super-astar"
          ? engine.exports.super_astar_run(chunkSize)
          : metaStrategy === "row-astar"
            ? engine.exports.row_astar_run(chunkSize)
          : engine.exports.room_bfs_run(chunkSize);
      computeMs += now() - computeStartedAt;
      if (["super-astar", "row-astar"].includes(metaStrategy)) searchSlices += 1;
      if (status < 0) {
        throw new Error(`Native room BFS failed in ${active.room.position.join("×")} (${status}).`);
      }
      if (status === 2) {
        report("limit-hit", status);
        throw new Error(
          `${active.room.position.join("×")} hit its ${engine.exports.room_bfs_state_capacity().toLocaleString()} global-board-state arena; totals are not exact.`
        );
      }
      report("progress", status);
      if (["super-astar", "row-astar"].includes(metaStrategy)) {
        const neighbors = discoverNeighbors(active, false);
        active.lastGemCount = engine.exports.room_bfs_collected_goals();
        active.slices += 1;
        if (status === 1 || status === 4) {
          report("room-complete", status);
          finishActive();
          enqueuePortfolio(...neighbors);
          active = takePortfolio();
          switched = true;
          break;
        }
        enqueuePortfolio(...neighbors);
        const shouldSwitch = neighbors.length > 0 ||
          (portfolio[0] && comparePortfolioFrames(portfolio[0], active) < 0);
        if (shouldSwitch) {
          capture(active);
          report("search-yield", status);
          enqueuePortfolio(active);
          active = takePortfolio();
          switched = true;
          break;
        }
        await yieldToBrowser(progressDelayMs);
        continue;
      }
      if (metaStrategy === "depth") {
        const [next] = discoverNeighbors(active, true);
        if (next && status !== 1) {
          capture(active);
          report("room-suspend");
          stack.push(active);
          active = next;
          switched = true;
          break;
        }
        if (next) {
          const siblings = [next, ...discoverNeighbors(active, false)];
          report("room-complete", 1);
          finishActive();
          for (let index = siblings.length - 1; index >= 1; index -= 1) {
            stack.push(siblings[index]);
          }
          active = siblings[0];
          switched = true;
          break;
        }
      }
      if (status === 1) {
        const neighbors = discoverNeighbors(active, false);
        report("room-complete", 1);
        finishActive();
        if (metaStrategy === "breadth") {
          queue.push(...neighbors);
          active = queue.shift() || null;
        } else {
          for (let index = neighbors.length - 1; index >= 0; index -= 1) {
            stack.push(neighbors[index]);
          }
          active = stack.pop() || null;
        }
        switched = true;
        break;
      }
      await yieldToBrowser(progressDelayMs);
    }
    await yieldToBrowser(progressDelayMs);
  }

  const final = {
    ...(lastMessage || {}),
    type: "complete",
    visitedCells: [],
    exitStates: [],
    trail: [],
    reachedRooms: pendingRooms.map((room) => ({
      fileName: room.fileName,
      position: room.position,
      columnIndex: room.columnIndex,
      rowIndex: room.rowIndex
    })),
    roomUpdates: pendingRoomUpdates,
    stats: {
      ...(lastMessage?.stats || {}),
      states: completed.states,
      statesPerSecond: computeMs > 0 ? completed.states * 1000 / computeMs : 0,
      expanded: completed.expanded,
      transitions: completed.transitions,
      actionsPerSecond: computeMs > 0
        ? completed.transitions * 1000 / computeMs
        : 0,
      edgeStates: completed.edgeStates,
      rooms: discovered.size,
      processedRooms: completedRooms,
      gems: completed.gems,
      activeSearches: (active ? 1 : 0) + stack.length + queue.length + portfolio.length,
      searchSlices,
      heuristicWeight: ["super-astar", "row-astar"].includes(metaStrategy)
        ? heuristicWeight
        : 0,
      opportunities: Math.max(0, discovered.size - 1) + completed.gems,
      currentRoom: active?.room.position.join("×") || "Complete"
    }
  };
  options.onProgress?.(final);
  return final.stats;
}
