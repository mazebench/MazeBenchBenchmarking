import { engineRoleIdForObject } from "../../engine/v1/adapter.mjs";

const DIRECTIONS = Object.freeze({
  up: { column: 0, row: -1 },
  right: { column: 1, row: 0 },
  down: { column: 0, row: 1 },
  left: { column: -1, row: 0 }
});

const ORIENTATION_DIRECTIONS = Object.freeze({
  up: "up",
  north: "up",
  right: "right",
  east: "right",
  down: "down",
  south: "down",
  left: "left",
  west: "left"
});

function cellKey(columnIndex, rowIndex) {
  return `${columnIndex},${rowIndex}`;
}

function roomKey(room) {
  return cellKey(room.columnIndex, room.rowIndex);
}

function cloneState(state) {
  return {
    width: state.width,
    height: state.height,
    objects: state.objects.map((object) => ({ ...object }))
  };
}

function isInside(state, object) {
  return object.x >= 0 && object.y >= 0 &&
    object.x < state.width && object.y < state.height;
}

function shiftedObject(object, offsetX, offsetY) {
  return { ...object, x: object.x + offsetX, y: object.y + offsetY };
}

function directionFromDelta(dx, dy) {
  if (dx === 0 && dy < 0) return "up";
  if (dx > 0 && dy === 0) return "right";
  if (dx === 0 && dy > 0) return "down";
  if (dx < 0 && dy === 0) return "left";
  return null;
}

export class ConnectedWorldSessionV1 {
  constructor(engine, definitions, rooms) {
    this.engine = engine;
    this.definitions = definitions;
    this.definitionMap = definitions instanceof Map
      ? definitions
      : new Map((definitions || []).map((definition) => [definition.id, definition]));
    this.rooms = rooms || [];
    this.roomsByCell = new Map(this.rooms.map((room) => [roomKey(room), room]));
    this.roomWidth = this.rooms[0]?.width || 0;
    this.roomHeight = this.rooms[0]?.height || 0;
    this.solidBlockId = [...this.definitionMap.values()].find((definition) =>
      engineRoleIdForObject({ blockId: definition.id }, this.definitionMap) === "solid")?.id;
  }

  isPlayer(object) {
    return engineRoleIdForObject(object, this.definitionMap) === "player";
  }

  activePlayer(state) {
    const players = state.objects.filter((object) => isInside(state, object) && this.isPlayer(object));
    return players.length === 1 ? players[0] : null;
  }

  neighbor(room, direction) {
    const delta = DIRECTIONS[direction];
    if (!delta || !Number.isInteger(room?.columnIndex) || !Number.isInteger(room?.rowIndex)) return null;
    return this.roomsByCell.get(cellKey(
      room.columnIndex + delta.column,
      room.rowIndex + delta.row
    )) || null;
  }

  freshRoomState(room) {
    const state = this.engine.createState(room);
    return {
      ...state,
      objects: state.objects.filter((object) => !this.isPlayer(object))
    };
  }

  buildLayout(visited) {
    const entries = [...visited.values()];
    const minColumn = Math.min(...entries.map(({ room }) => room.columnIndex));
    const maxColumn = Math.max(...entries.map(({ room }) => room.columnIndex));
    const minRow = Math.min(...entries.map(({ room }) => room.rowIndex));
    const maxRow = Math.max(...entries.map(({ room }) => room.rowIndex));
    const placements = entries.map(({ room, state }) => ({
      room,
      state,
      offsetX: (room.columnIndex - minColumn) * this.roomWidth,
      offsetY: (room.rowIndex - minRow) * this.roomHeight
    }));
    const width = (maxColumn - minColumn + 1) * this.roomWidth;
    const height = (maxRow - minRow + 1) * this.roomHeight;
    const objects = placements.flatMap(({ state, offsetX, offsetY }, roomIndex) =>
      state.objects
        .filter((object) => isInside(state, object))
        .map((object) => {
          const shifted = shiftedObject(object, offsetX, offsetY);
          const role = engineRoleIdForObject(object, this.definitionMap);
          // Combining geometry must not combine the rooms' control circuits.
          // The C++ engine keeps this scope through every intermediate tick.
          if (placements.length > 1 && (role === "orange-button" || role === "orange-wall")) {
            shifted.connectedWorldOrangeScope = roomIndex + 1;
          }
          return shifted;
        }));

    const zValues = objects.map((object) => Number(object.z)).filter(Number.isFinite);
    const minimumZ = Math.min(0, ...zValues) - 2;
    const maximumZ = Math.max(0, ...zValues) + 2;
    const boundaryKeys = new Set();
    const boundaryObjects = [];
    const addBoundaryColumn = (x, y) => {
      for (let z = minimumZ; z <= maximumZ; z += 1) {
        const key = `${x},${y},${z}`;
        if (boundaryKeys.has(key)) continue;
        boundaryKeys.add(key);
        boundaryObjects.push({
          x,
          y,
          z,
          blockId: this.solidBlockId,
          connectedWorldBoundary: true
        });
      }
    };

    placements.forEach(({ room, offsetX, offsetY }) => {
      Object.entries(DIRECTIONS).forEach(([direction, delta]) => {
        const neighborColumn = room.columnIndex + delta.column;
        const neighborRow = room.rowIndex + delta.row;
        const insideBounds = neighborColumn >= minColumn && neighborColumn <= maxColumn &&
          neighborRow >= minRow && neighborRow <= maxRow;
        if (!insideBounds || visited.has(cellKey(neighborColumn, neighborRow))) return;
        if (!this.solidBlockId) {
          throw new Error("Connected world needs a solid block definition for unvisited room boundaries.");
        }
        if (direction === "up" || direction === "down") {
          const y = direction === "up" ? offsetY - 1 : offsetY + this.roomHeight;
          for (let x = offsetX; x < offsetX + this.roomWidth; x += 1) addBoundaryColumn(x, y);
        } else {
          const x = direction === "left" ? offsetX - 1 : offsetX + this.roomWidth;
          for (let y = offsetY; y < offsetY + this.roomHeight; y += 1) addBoundaryColumn(x, y);
        }
      });
    });

    return {
      state: { width, height, objects: [...objects, ...boundaryObjects] },
      placements,
      minColumn,
      minRow
    };
  }

  placementForObject(object, layout) {
    return layout.placements.find(({ offsetX, offsetY }) =>
      object.x >= offsetX && object.y >= offsetY &&
      object.x < offsetX + this.roomWidth &&
      object.y < offsetY + this.roomHeight) || null;
  }

  playerPlacement(state, layout) {
    const player = this.activePlayer(state);
    if (!player) return null;
    const placement = this.placementForObject(player, layout);
    return placement ? { player, placement } : null;
  }

  projectState(state, placement) {
    const { offsetX, offsetY } = placement;
    return {
      width: this.roomWidth,
      height: this.roomHeight,
      objects: state.objects
        .filter((object) => !object.connectedWorldBoundary &&
          object.x >= offsetX && object.y >= offsetY &&
          object.x < offsetX + this.roomWidth &&
          object.y < offsetY + this.roomHeight)
        .map(({ connectedWorldOrangeScope, ...object }) => ({ ...object, x: object.x - offsetX, y: object.y - offsetY }))
    };
  }

  lastMovementDirection(simulation, layout) {
    const positions = [layout.state, ...simulation.frames]
      .map((state) => this.activePlayer(state))
      .filter(Boolean);
    for (let index = positions.length - 1; index > 0; index -= 1) {
      const current = positions[index];
      const previous = positions[index - 1];
      const direction = directionFromDelta(current.x - previous.x, current.y - previous.y);
      if (direction) return direction;
    }
    return null;
  }

  playerIsOnIce(state, player) {
    return state.objects.some((object) => {
      if (object === player || object.x !== player.x || object.y !== player.y) return false;
      const roleId = engineRoleIdForObject(object, this.definitionMap);
      return (roleId === "ice" || roleId.startsWith("ice-slope-")) &&
        (object.z === player.z || object.z === player.z - 1);
    });
  }

  traceHasPunch(simulation, direction) {
    return simulation.frames.some((state) => state.objects.some((object) => {
      const definition = this.definitionMap.get(object.blockId);
      if (definition?.roleId !== "puncher" && definition?.visual?.kind !== "puncher") return false;
      const sprung = object.stateId === 1 || object.engineGenericId % 2 === 1;
      return sprung && ORIENTATION_DIRECTIONS[String(object.orientation).toLowerCase()] === direction;
    }));
  }

  isAtRoomEdge(player, placement, direction) {
    if (direction === "up") return player.y === placement.offsetY;
    if (direction === "right") return player.x === placement.offsetX + this.roomWidth - 1;
    if (direction === "down") return player.y === placement.offsetY + this.roomHeight - 1;
    if (direction === "left") return player.x === placement.offsetX;
    return false;
  }

  exitIntent(simulation, layout, requestedDirection) {
    const located = this.playerPlacement(simulation.final, layout);
    if (!located) return null;
    const { player, placement } = located;
    const movementDirection = this.lastMovementDirection(simulation, layout);
    if (movementDirection && this.isAtRoomEdge(player, placement, movementDirection) &&
        (this.playerIsOnIce(simulation.final, player) ||
         this.traceHasPunch(simulation, movementDirection))) {
      return { direction: movementDirection, placement };
    }

    const initial = this.playerPlacement(layout.state, layout);
    if (!movementDirection && initial &&
        initial.player.x === player.x && initial.player.y === player.y &&
        initial.placement.room === placement.room &&
        this.isAtRoomEdge(player, placement, requestedDirection)) {
      return { direction: requestedDirection, placement };
    }
    return null;
  }

  projectSimulation(simulation, layout, fallbackRoom) {
    let activePlacement = this.playerPlacement(layout.state, layout)?.placement ||
      layout.placements.find(({ room }) => room === fallbackRoom) || layout.placements[0];
    const animationFrames = simulation.frames.map((state) => {
      activePlacement = this.playerPlacement(state, layout)?.placement || activePlacement;
      return {
        room: activePlacement.room,
        state: this.projectState(state, activePlacement)
      };
    });
    activePlacement = this.playerPlacement(simulation.final, layout)?.placement || activePlacement;
    const connectedRooms = new Set(animationFrames.map(({ room }) => room.fileName));
    connectedRooms.add(activePlacement.room.fileName);
    return {
      ...simulation,
      room: activePlacement.room,
      final: this.projectState(simulation.final, activePlacement),
      frames: animationFrames.map(({ state }) => state),
      animationFrames,
      connectedRooms: [...connectedRooms]
    };
  }

  async simulateCommand(state, room, requestedDirection) {
    const direction = String(requestedDirection).toLowerCase();
    if (!DIRECTIONS[direction] || !this.activePlayer(state)) {
      return this.engine.simulateCommand(state, direction, this.definitions);
    }

    const visited = new Map([[roomKey(room), { room, state: cloneState(state) }]]);
    let lastAddedKey = null;
    let fallback = null;
    for (let expansion = 0; expansion <= this.rooms.length; expansion += 1) {
      const layout = this.buildLayout(visited);
      const simulation = await this.engine.simulateCommand(
        layout.state,
        direction,
        this.definitions
      );
      const projected = this.projectSimulation(simulation, layout, room);
      const enteredRooms = new Set(projected.connectedRooms);
      const addedRoom = lastAddedKey ? visited.get(lastAddedKey)?.room : null;
      if (addedRoom && !enteredRooms.has(addedRoom.fileName) && fallback) {
        return this.projectSimulation(fallback.simulation, fallback.layout, room);
      }

      const exit = this.exitIntent(simulation, layout, direction);
      if (!exit || simulation.cycle) return projected;
      const nextRoom = this.neighbor(exit.placement.room, exit.direction);
      if (!nextRoom || visited.has(roomKey(nextRoom))) return projected;

      fallback = { simulation, layout };
      lastAddedKey = roomKey(nextRoom);
      visited.set(lastAddedKey, {
        room: nextRoom,
        state: this.freshRoomState(nextRoom)
      });
    }
    throw new Error("Connected world crossed too many rooms in one command.");
  }
}
