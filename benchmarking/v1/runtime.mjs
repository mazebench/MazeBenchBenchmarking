import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  countActiveRoleV1,
  engineRoleIdForObject,
  engineStatesEqualV1
} from "../../engine/v1/adapter.mjs";
import { instantiateMazeBenchEngineV1 } from "../../engine/v1/engine.mjs";
import { ConnectedWorldSessionV1 } from "../../play/v1/connected-world-session.mjs";
import { cameraRelativeMoveDirection } from "../../play/v1/camera-relative-input.mjs";
import { renderAsciiFrameV1 } from "../../render-ascii/v1/ascii-scene.mjs";
import {
  V2_WORLD_FORMAT,
  decodeVoxelRoom
} from "../../render/v1/voxel-world-v2.mjs";

export const BENCHMARK_RUNTIME_VERSION = 1;
export const GAME_WON_GEM_COUNT = 100;
export const DEFAULT_START_ROOM = "HxI";

const RECORD_NAMES = new Set([
  "current_board.txt",
  "current_state.json",
  "moves.txt",
  "history.jsonl"
]);
const MOVEMENT_ACTIONS = new Set(["up", "right", "down", "left"]);
const CAMERA_ACTIONS = new Set([
  "camera up",
  "camera right",
  "camera down",
  "camera left"
]);

let assetsPromise = null;

function clone(value) {
  return structuredClone(value);
}

function now() {
  return new Date().toISOString();
}

async function atomicJson(filePath, value) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, filePath);
}

async function atomicText(filePath, value) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, String(value), "utf8");
  await rename(temporary, filePath);
}

function roomLabel(room) {
  return room.position.join("x");
}

function roomLookupKey(value) {
  return String(value || "")
    .trim()
    .replace(/[×X]/g, "x")
    .toUpperCase();
}

function stateObjectsForHash(state) {
  return state.objects.map((object) => ({
    blockId: object.blockId,
    x: object.x,
    y: object.y,
    z: object.z,
    genericId: object.genericId ?? object.engineGenericId ?? null,
    groupId: object.groupId ?? null,
    stateId: object.stateId ?? null,
    mechanismDepth: object.mechanismDepth ?? null,
    orientation: object.orientation ?? null
  }));
}

function stateHash(state) {
  return createHash("sha256").update(JSON.stringify({
    roomFile: state.roomFile,
    objects: stateObjectsForHash(state.state),
    gemsCollected: [...state.gemsCollected].sort()
  })).digest("hex");
}

function playerIn(state, definitions) {
  return state.objects.find((object) =>
    object.x >= 0 && object.y >= 0 &&
    object.x < state.width && object.y < state.height &&
    engineRoleIdForObject(object, definitions) === "player") || null;
}

function activeGemCoordinateKeys(room, state, definitions) {
  const keys = new Set();
  for (const object of state.objects) {
    if (object.x < 0 || object.y < 0 || object.x >= state.width || object.y >= state.height) continue;
    if (engineRoleIdForObject(object, definitions) !== "goal") continue;
    keys.add(`${room.fileName}:${object.x}:${object.y}:${object.z}`);
  }
  return keys;
}

function authoredGemCoordinateKeys(room, definitions) {
  return room.objects
    .filter((object) => engineRoleIdForObject(object, definitions) === "goal")
    .map((object) => `${room.fileName}:${object.x}:${object.y}:${object.z}`);
}

function publicAction(action) {
  return {
    index: action.index,
    action: action.action,
    at: action.at,
    roomBefore: action.roomBefore,
    roomAfter: action.roomAfter,
    stateChanged: action.stateChanged,
    moved: action.moved,
    blocked: action.blocked,
    died: action.died,
    gemsCollected: action.gemsCollected,
    totalGems: action.totalGems,
    roomsVisited: action.roomsVisited,
    novel: action.novel,
    stateHash: action.stateHash,
    player: action.player
  };
}

function positionFor(room, player, roomWidth, roomHeight) {
  if (!player) return null;
  return {
    room: roomLabel(room),
    localX: player.x,
    localY: player.y,
    z: player.z,
    worldX: room.columnIndex * roomWidth + player.x,
    worldY: room.rowIndex * roomHeight + player.y
  };
}

function compactColorRows(pixels) {
  return pixels.map((row) => {
    const segments = [];
    for (const pixel of row) {
      const color = /^#[0-9a-f]{6}$/i.test(String(pixel.color || ""))
        ? pixel.color
        : "#e9eef2";
      const previous = segments.at(-1);
      if (previous?.color === color) previous.text += pixel.glyph;
      else segments.push({ text: pixel.glyph, color });
    }
    return segments;
  });
}

function normalizeActionText(value) {
  const raw = String(value || "").trim();
  const lower = raw.toLowerCase().replace(/\s+/g, " ");
  const movementAliases = { u: "up", r: "right", d: "down", l: "left" };
  if (movementAliases[lower]) return movementAliases[lower];
  if (MOVEMENT_ACTIONS.has(lower) || CAMERA_ACTIONS.has(lower) || lower === "undo" || lower === "reset") {
    return lower;
  }
  const roomMatch = lower.match(/^(?:go to )?(?:room|level)\s+([a-p])\s*(?:x|×|\s)\s*([a-p])$/i);
  if (roomMatch) return `room ${roomMatch[1].toUpperCase()}x${roomMatch[2].toUpperCase()}`;
  throw new Error(`Unknown action "${raw}".`);
}

export function normalizeBenchmarkAction(value) {
  return normalizeActionText(value);
}

export function expandBenchmarkSequence(input) {
  if (Array.isArray(input)) return input.map(normalizeActionText);
  const source = String(input || "").trim();
  if (!source) throw new Error("sequence must not be empty.");
  if (/^[UDRLudrl\s,]+$/.test(source)) {
    return [...source.replace(/[\s,]/g, "")].map(normalizeActionText);
  }
  return source.split(/[\n,]+/).map((entry) => normalizeActionText(entry));
}

export async function loadBenchmarkAssets(projectRoot) {
  if (!assetsPromise) {
    assetsPromise = (async () => {
      const levelRoot = path.join(projectRoot, "level-data", "v2", "main-world");
      const manifest = JSON.parse(await readFile(path.join(levelRoot, "world.json"), "utf8"));
      if (manifest.storageFormat !== V2_WORLD_FORMAT || !manifest.rooms) {
        throw new Error("Invalid MazeBench voxel world v2 manifest.");
      }
      const entries = Object.entries(manifest.rooms);
      const columns = [...new Set(entries.map(([, position]) => position[0]))].sort();
      const rows = [...new Set(entries.map(([, position]) => position[1]))].sort();
      const columnIndexes = new Map(columns.map((value, index) => [value, index]));
      const rowIndexes = new Map(rows.map((value, index) => [value, index]));
      const rooms = await Promise.all(entries.map(async ([fileName, position]) => ({
        ...decodeVoxelRoom(JSON.parse(await readFile(path.join(levelRoot, fileName), "utf8"))),
        fileName,
        legacyFileName: `${fileName.replace(/\.json$/i, "")}.txt`,
        position,
        columnIndex: columnIndexes.get(position[0]),
        rowIndex: rowIndexes.get(position[1])
      })));
      const wasm = await readFile(path.join(projectRoot, "engine", "v1", "voxel_physics.wasm"));
      const engine = await instantiateMazeBenchEngineV1(wasm);
      const blocks = manifest.blocks || [];
      return {
        engine,
        blocks,
        definitions: new Map(blocks.map((block) => [block.id, block])),
        rooms,
        roomsByFile: new Map(rooms.map((room) => [room.fileName, room])),
        roomsByLabel: new Map(rooms.map((room) => [roomLookupKey(roomLabel(room)), room])),
        roomWidth: rooms[0]?.width || 16,
        roomHeight: rooms[0]?.height || 16,
        connectedWorld: new ConnectedWorldSessionV1(engine, blocks, rooms)
      };
    })();
  }
  return assetsPromise;
}

export class BenchmarkGameRuntime {
  constructor(projectRoot, runDirectory, assets, internal) {
    this.projectRoot = projectRoot;
    this.runDirectory = runDirectory;
    this.recordsDirectory = path.join(runDirectory, "records");
    this.moveHistoryDirectory = path.join(this.recordsDirectory, "move_history");
    this.displayHistoryDirectory = path.join(runDirectory, "display-history");
    this.assets = assets;
    this.internal = internal;
  }

  static async create(projectRoot, runDirectory, options = {}) {
    const assets = await loadBenchmarkAssets(projectRoot);
    const requestedRoom = roomLookupKey(options.startRoom || DEFAULT_START_ROOM);
    const room = assets.roomsByLabel.get(requestedRoom);
    if (!room) throw new Error(`Unknown starting room ${options.startRoom || DEFAULT_START_ROOM}.`);
    const limit = options.actionLimit === null
      ? null
      : Math.max(1, Math.min(1_000_000, Math.floor(Number(options.actionLimit) || 100)));
    const startingState = assets.engine.createState(room);
    const player = playerIn(startingState, assets.definitions);
    if (!player) throw new Error(`Starting room ${roomLabel(room)} has no active player.`);
    const createdAt = now();
    const internal = {
      version: BENCHMARK_RUNTIME_VERSION,
      createdAt,
      updatedAt: createdAt,
      actionLimit: limit,
      actionCount: 0,
      roomFile: room.fileName,
      state: startingState,
      roomEntryState: clone(startingState),
      history: [],
      actions: [],
      yaw: 0,
      pitch: 1,
      gemsCollected: [],
      visitedRooms: [room.fileName],
      roomEntryStates: { [room.fileName]: clone(startingState) },
      stateHashes: [],
      positions: [],
      deaths: 0,
      resets: 0,
      undos: 0,
      cameraActions: 0,
      blockedActions: 0
    };
    internal.stateHashes.push(stateHash(internal));
    internal.positions.push(positionFor(room, player, assets.roomWidth, assets.roomHeight));
    await mkdir(path.join(runDirectory, "workspace"), { recursive: true, mode: 0o700 });
    await mkdir(path.join(runDirectory, "sandbox-state"), { recursive: true, mode: 0o700 });
    await mkdir(path.join(runDirectory, "records", "move_history"), { recursive: true, mode: 0o700 });
    await mkdir(path.join(runDirectory, "display-history"), { recursive: true, mode: 0o700 });
    const runtime = new BenchmarkGameRuntime(projectRoot, runDirectory, assets, internal);
    await runtime.persist({ writeSnapshot: true });
    return runtime;
  }

  static async open(projectRoot, runDirectory) {
    const [assets, internal] = await Promise.all([
      loadBenchmarkAssets(projectRoot),
      readFile(path.join(runDirectory, "game-state.json"), "utf8").then(JSON.parse)
    ]);
    if (internal.version !== BENCHMARK_RUNTIME_VERSION) {
      throw new Error(`Unsupported benchmark runtime version ${internal.version}.`);
    }
    return new BenchmarkGameRuntime(projectRoot, runDirectory, assets, internal);
  }

  get room() {
    const room = this.assets.roomsByFile.get(this.internal.roomFile);
    if (!room) throw new Error(`Benchmark state references unknown room ${this.internal.roomFile}.`);
    return room;
  }

  status() {
    if (this.internal.gemsCollected.length >= GAME_WON_GEM_COUNT) return "won";
    if (this.internal.actionLimit !== null && this.internal.actionCount >= this.internal.actionLimit) {
      return "action-limit";
    }
    return playerIn(this.internal.state, this.assets.definitions) ? "playing" : "dead";
  }

  collectMissingGems(room, state) {
    const active = activeGemCoordinateKeys(room, state, this.assets.definitions);
    const collected = new Set(this.internal.gemsCollected);
    for (const key of authoredGemCoordinateKeys(room, this.assets.definitions)) {
      if (!active.has(key)) collected.add(key);
    }
    this.internal.gemsCollected = [...collected].sort();
  }

  async renderObservation(options = {}) {
    const room = this.room;
    const renderedRoom = this.assets.engine.roomFromState(this.internal.state, room);
    const frame = await renderAsciiFrameV1(renderedRoom, this.assets.blocks, {
      yaw: this.internal.yaw,
      pitch: this.internal.pitch
    });
    const player = playerIn(this.internal.state, this.assets.definitions);
    const position = positionFor(room, player, this.assets.roomWidth, this.assets.roomHeight);
    const novelty = this.internal.actions.length
      ? this.internal.actions.at(-1).novel
      : true;
    return {
      schema_version: 1,
      observation_revision: this.internal.actionCount,
      game_status: this.status(),
      room: roomLabel(room),
      player: position,
      gems_collected: this.internal.gemsCollected.length,
      gems_total: GAME_WON_GEM_COUNT,
      gems_remaining_in_room: countActiveRoleV1(this.internal.state, this.assets.definitions, "goal"),
      rooms_visited: this.internal.visitedRooms.length,
      visited_rooms: this.internal.visitedRooms
        .map((fileName) => roomLabel(this.assets.roomsByFile.get(fileName)))
        .sort(),
      action_count: this.internal.actionCount,
      action_limit: this.internal.actionLimit,
      actions_remaining: this.internal.actionLimit === null
        ? null
        : Math.max(0, this.internal.actionLimit - this.internal.actionCount),
      camera: { yaw: this.internal.yaw, pitch: this.internal.pitch },
      novel_state: novelty,
      state_hash: this.internal.stateHashes.at(-1),
      level: frame.text,
      ...(options.includeColor ? { colored_level: compactColorRows(frame.pixels) } : {}),
      ascii_legend: frame.legend,
      recent_actions: this.internal.actions.slice(-12).map(publicAction),
      records: {
        read_with: "maze_observe({record: <relative path>})",
        files: this.recordIndex()
      },
      allowed_actions: [
        "up", "down", "left", "right", "undo", "reset",
        "camera up", "camera down", "camera left", "camera right",
        "room HxI (visited rooms only)"
      ]
    };
  }

  recordIndex() {
    return [
      "current_board.txt",
      "current_state.json",
      "moves.txt",
      "history.jsonl",
      ...this.internal.actions.map((action) => `move_history/move_${action.index}.txt`)
    ];
  }

  async readRecord(requested) {
    const record = String(requested || "").trim().replaceAll("\\", "/");
    const allowed = RECORD_NAMES.has(record) || /^move_history\/move_(?:0|[1-9]\d*)\.txt$/.test(record);
    if (!allowed || record.includes("..") || path.isAbsolute(record)) {
      throw new Error("Unknown benchmark record. Use a path from the records index.");
    }
    const filePath = path.resolve(this.recordsDirectory, record);
    if (!filePath.startsWith(`${this.recordsDirectory}${path.sep}`)) {
      throw new Error("Record paths must remain inside the read-only records directory.");
    }
    try {
      return { record, content: await readFile(filePath, "utf8") };
    } catch (error) {
      if (error?.code === "ENOENT") throw new Error(`Record ${record} does not exist yet.`);
      throw error;
    }
  }

  assertPlayable() {
    const status = this.status();
    if (status === "won") throw new Error("The maze is already won.");
    if (status === "action-limit") throw new Error("The action limit is exhausted.");
  }

  snapshotForUndo() {
    return {
      roomFile: this.internal.roomFile,
      state: clone(this.internal.state),
      roomEntryState: clone(this.internal.roomEntryState)
    };
  }

  noteVisited(room, state) {
    if (!this.internal.visitedRooms.includes(room.fileName)) this.internal.visitedRooms.push(room.fileName);
    if (!this.internal.roomEntryStates[room.fileName]) {
      this.internal.roomEntryStates[room.fileName] = clone(state);
    }
  }

  async apply(actionValue) {
    this.assertPlayable();
    const action = normalizeActionText(actionValue);
    const beforeRoom = this.room;
    const beforeState = clone(this.internal.state);
    const beforePlayer = playerIn(beforeState, this.assets.definitions);
    const undoSnapshot = this.snapshotForUndo();
    let changed = false;

    if (MOVEMENT_ACTIONS.has(action)) {
      const worldDirection = cameraRelativeMoveDirection(action, this.internal.yaw);
      const simulation = await this.assets.connectedWorld.simulateCommand(
        this.internal.state,
        beforeRoom,
        worldDirection
      );
      const frames = simulation.animationFrames?.length
        ? simulation.animationFrames
        : [{ room: simulation.room || beforeRoom, state: simulation.final }];
      for (const frame of frames) {
        this.noteVisited(frame.room, frame.state);
        this.collectMissingGems(frame.room, frame.state);
      }
      const afterRoom = simulation.room || beforeRoom;
      this.internal.roomFile = afterRoom.fileName;
      this.internal.state = simulation.final;
      this.noteVisited(afterRoom, simulation.final);
      this.collectMissingGems(afterRoom, simulation.final);
      changed = afterRoom.fileName !== beforeRoom.fileName ||
        !engineStatesEqualV1(beforeState, simulation.final, this.assets.definitions);
      if (changed) this.internal.history.push(undoSnapshot);
      if (afterRoom.fileName !== beforeRoom.fileName) {
        this.internal.roomEntryState = clone(simulation.final);
        this.internal.roomEntryStates[afterRoom.fileName] = clone(simulation.final);
      }
    } else if (action === "undo") {
      const snapshot = this.internal.history.pop();
      if (snapshot) {
        this.internal.roomFile = snapshot.roomFile;
        this.internal.state = clone(snapshot.state);
        this.internal.roomEntryState = clone(snapshot.roomEntryState);
        changed = true;
      }
      this.internal.undos += 1;
    } else if (action === "reset") {
      changed = !engineStatesEqualV1(
        this.internal.state,
        this.internal.roomEntryState,
        this.assets.definitions
      );
      if (changed) this.internal.history.push(undoSnapshot);
      this.internal.state = clone(this.internal.roomEntryState);
      this.internal.resets += 1;
    } else if (action.startsWith("room ")) {
      const requested = roomLookupKey(action.slice(5));
      const destination = this.assets.roomsByLabel.get(requested);
      if (!destination || !this.internal.visitedRooms.includes(destination.fileName)) {
        throw new Error(`Room ${action.slice(5)} has not been visited.`);
      }
      if (destination.fileName !== beforeRoom.fileName) {
        this.internal.history.push(undoSnapshot);
        this.internal.roomFile = destination.fileName;
        this.internal.state = clone(this.internal.roomEntryStates[destination.fileName]);
        this.internal.roomEntryState = clone(this.internal.roomEntryStates[destination.fileName]);
        changed = true;
      }
    } else if (CAMERA_ACTIONS.has(action)) {
      if (action === "camera left") this.internal.yaw = (this.internal.yaw + 3) % 4;
      else if (action === "camera right") this.internal.yaw = (this.internal.yaw + 1) % 4;
      else if (action === "camera up") this.internal.pitch = Math.max(0, this.internal.pitch - 1);
      else this.internal.pitch = Math.min(4, this.internal.pitch + 1);
      this.internal.cameraActions += 1;
    }

    const afterRoom = this.room;
    const afterPlayer = playerIn(this.internal.state, this.assets.definitions);
    const beforePosition = positionFor(beforeRoom, beforePlayer, this.assets.roomWidth, this.assets.roomHeight);
    const afterPosition = positionFor(afterRoom, afterPlayer, this.assets.roomWidth, this.assets.roomHeight);
    const moved = Boolean(beforePosition && afterPosition && (
      beforePosition.worldX !== afterPosition.worldX ||
      beforePosition.worldY !== afterPosition.worldY ||
      beforePosition.z !== afterPosition.z
    ));
    const blocked = MOVEMENT_ACTIONS.has(action) && !moved;
    if (blocked) this.internal.blockedActions += 1;
    const died = !afterPlayer;
    if (died && beforePlayer) this.internal.deaths += 1;

    this.internal.actionCount += 1;
    this.internal.updatedAt = now();
    const hash = stateHash(this.internal);
    const novel = !this.internal.stateHashes.includes(hash);
    this.internal.stateHashes.push(hash);
    this.internal.positions.push(afterPosition);
    const record = {
      index: this.internal.actionCount,
      action,
      at: this.internal.updatedAt,
      roomBefore: roomLabel(beforeRoom),
      roomAfter: roomLabel(afterRoom),
      stateChanged: changed,
      moved,
      blocked,
      died,
      gemsCollected: Math.max(0, this.internal.gemsCollected.length - (this.internal.actions.at(-1)?.totalGems || 0)),
      totalGems: this.internal.gemsCollected.length,
      roomsVisited: this.internal.visitedRooms.length,
      novel,
      stateHash: hash,
      player: afterPosition
    };
    this.internal.actions.push(record);
    await this.persist({ writeSnapshot: true });
    return { action: publicAction(record), observation: await this.renderObservation() };
  }

  async applySequence(actions) {
    const results = [];
    for (const action of actions) {
      if (["won", "action-limit"].includes(this.status())) break;
      const result = await this.apply(action);
      results.push(result);
      if (result.observation.game_status === "dead") break;
    }
    return {
      requested_count: actions.length,
      completed_count: results.length,
      stopped_early: results.length < actions.length,
      steps: results.map((result) => ({
        action: result.action,
        status: {
          game_status: result.observation.game_status,
          room: result.observation.room,
          gems_collected: result.observation.gems_collected,
          action_count: result.observation.action_count,
          novel_state: result.observation.novel_state
        }
      })),
      final_observation: results.at(-1)?.observation || await this.renderObservation()
    };
  }

  summary() {
    const visits = new Map();
    for (const position of this.internal.positions.filter(Boolean)) {
      const key = `${position.worldX},${position.worldY}`;
      visits.set(key, (visits.get(key) || 0) + 1);
    }
    const novelActions = this.internal.actions.filter((action) => action.novel).length;
    return {
      schema_version: 1,
      updated_at: this.internal.updatedAt,
      game_status: this.status(),
      action_count: this.internal.actionCount,
      action_limit: this.internal.actionLimit,
      room: roomLabel(this.room),
      gems_collected: this.internal.gemsCollected.length,
      gems_total: GAME_WON_GEM_COUNT,
      rooms_visited: this.internal.visitedRooms.length,
      unique_cells: visits.size,
      novelty_rate: this.internal.actionCount ? novelActions / this.internal.actionCount : 1,
      blocked_actions: this.internal.blockedActions,
      deaths: this.internal.deaths,
      resets: this.internal.resets,
      undos: this.internal.undos,
      camera_actions: this.internal.cameraActions,
      positions: this.internal.positions,
      novelty: [true, ...this.internal.actions.map((action) => action.novel)],
      actions: this.internal.actions.map(publicAction)
    };
  }

  async persist({ writeSnapshot = false } = {}) {
    const observation = await this.renderObservation({ includeColor: true });
    const summary = this.summary();
    await Promise.all([
      atomicJson(path.join(this.runDirectory, "game-state.json"), this.internal),
      atomicJson(path.join(this.runDirectory, "summary.json"), summary),
      atomicJson(path.join(this.runDirectory, "display.json"), {
        observation_revision: observation.observation_revision,
        room: observation.room,
        level: observation.level,
        colored_level: observation.colored_level,
        ascii_legend: observation.ascii_legend
      }),
      atomicText(path.join(this.recordsDirectory, "current_board.txt"), `${observation.level}\n`),
      atomicJson(path.join(this.recordsDirectory, "current_state.json"), {
        ...observation,
        level: undefined,
        colored_level: undefined,
        records: undefined
      }),
      atomicText(
        path.join(this.recordsDirectory, "moves.txt"),
        this.internal.actions.map((action) => action.action).join("\n") +
          (this.internal.actions.length ? "\n" : "")
      ),
      atomicText(
        path.join(this.recordsDirectory, "history.jsonl"),
        this.internal.actions.map((action) => JSON.stringify(publicAction(action))).join("\n") +
          (this.internal.actions.length ? "\n" : "")
      )
    ]);
    if (writeSnapshot) {
      const index = this.internal.actionCount;
      const header = index === 0
        ? `# move 0 · initial · ${observation.room}`
        : `# move ${index} · ${this.internal.actions.at(-1).action} · ${observation.room}`;
      await Promise.all([
        atomicText(
          path.join(this.moveHistoryDirectory, `move_${index}.txt`),
          `${header}\n${observation.level}\n`
        ),
        atomicJson(path.join(this.displayHistoryDirectory, `move_${index}.json`), {
          observation_revision: observation.observation_revision,
          room: observation.room,
          level: observation.level,
          colored_level: observation.colored_level
        })
      ]);
    }
  }
}
