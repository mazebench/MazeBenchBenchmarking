import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { signCheckpoint } from "./integrity.mjs";
import { readCheckpointJson, writeCheckpointJson } from "./checkpoint-json.mjs";
import { NOVELTY_VERSION, noveltyStateHash } from "./novelty.mjs";
import { safeDirectory } from "./safe-files.mjs";
import { moveRecordIndex, readMoveRecord, stageMoveAnimation } from "./move-animation.mjs";

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

const MOVEMENT_ACTIONS = new Set(["up", "right", "down", "left"]);
const CAMERA_ACTIONS = new Set([
  "camera up",
  "camera right",
  "camera down",
  "camera left"
]);

function clone(value) {
  return structuredClone(value);
}

function now() {
  return new Date().toISOString();
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
    player: action.player,
    ...(action.animation ? { animation: action.animation } : {})
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
  // Each run loads its own authored world and engine. Reusing a process-wide
  // promise would let a new manifest describe edited files while the starting
  // state still came from an earlier world's cached assets.
  return (async () => {
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

export class BenchmarkGameRuntime {
  constructor(projectRoot, runDirectory, assets, internal) {
    this.projectRoot = projectRoot;
    this.runDirectory = runDirectory;
    this.recordsDirectory = path.join(runDirectory, "records");
    this.moveHistoryDirectory = path.join(this.recordsDirectory, "move_history");
    this.displayHistoryDirectory = path.join(runDirectory, "display-history");
    this.assets = assets;
    this.internal = internal;
    this.noveltySeen = new Set(internal.noveltyHashes || []);
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
      noveltyVersion: NOVELTY_VERSION,
      noveltyHashes: [],
      positions: [],
      deaths: 0,
      resets: 0,
      undos: 0,
      cameraActions: 0,
      blockedActions: 0
    };
    internal.stateHashes.push(stateHash(internal));
    internal.noveltyHashes.push(noveltyStateHash(internal.roomFile, internal.state, assets.definitions));
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
      readCheckpointJson(runDirectory)
    ]);
    if (internal.version !== BENCHMARK_RUNTIME_VERSION) {
      throw new Error(`Unsupported benchmark runtime version ${internal.version}.`);
    }
    if (internal.noveltyVersion !== NOVELTY_VERSION || internal.noveltyHashes?.length !== internal.actionCount + 1) {
      throw new Error("This checkpoint needs the audited terrain-free novelty recalculation before resuming.");
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
    if (this.persistenceError) throw this.persistenceError;
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
    return moveRecordIndex(this.internal.actions);
  }

  async readRecord(requested) {
    if (this.persistenceError) throw this.persistenceError;
    try {
      return readMoveRecord(this.runDirectory, this.internal.actions, this.internal.actionCount, requested);
    } catch (error) {
      if (error?.code === "ENOENT") throw new Error("Record does not exist yet.");
      throw error;
    }
  }

  assertPlayable() {
    if (this.persistenceError) throw this.persistenceError;
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
    const beforeCamera = { yaw: this.internal.yaw, pitch: this.internal.pitch };
    let animationFrames = [];
    let animationCycle = null;
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
      animationFrames = frames;
      animationCycle = simulation.cycle || null;
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
    const noveltyHash = noveltyStateHash(this.internal.roomFile, this.internal.state, this.assets.definitions);
    const novel = !this.noveltySeen.has(noveltyHash);
    this.noveltySeen.add(noveltyHash);
    this.internal.noveltyHashes.push(noveltyHash);
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
    const camera = { yaw: this.internal.yaw, pitch: this.internal.pitch };
    const lastFrame = animationFrames.at(-1);
    if (!lastFrame || lastFrame.room.fileName !== afterRoom.fileName ||
        !engineStatesEqualV1(lastFrame.state, this.internal.state, this.assets.definitions)) {
      animationFrames.push({ room: afterRoom, state: this.internal.state });
    }
    animationFrames = [
      { room: beforeRoom, state: beforeState, camera: beforeCamera },
      ...animationFrames.map(frame => ({ ...frame, camera }))
    ];
    await this.persist({ writeSnapshot: true, animationFrames, animationCycle });
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
      novelty_version: NOVELTY_VERSION,
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

  async persist({ writeSnapshot = false, animationFrames = null, animationCycle = null } = {}) {
    if (this.persistenceError) throw this.persistenceError;
    let staging;
    try {
      staging = await mkdtemp(path.join(this.runDirectory, ".checkpoint-"));
      // Prepare every artifact before publishing any of them. A serialization
      // or disk-write failure cannot advance the summary past the saved board.
      const artifacts = [];
      const json = async (relative, value) => {
        const file = path.join(staging, relative);
        await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        await writeCheckpointJson(file, value);
        artifacts.push(relative);
      };
      const text = async (relative, value) => {
        const file = path.join(staging, relative);
        await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        await writeFile(file, value, { flag: "wx", mode: 0o600 });
        artifacts.push(relative);
      };
      if (animationFrames) {
        this.internal.actions.at(-1).animation = await stageMoveAnimation({
          action: this.internal.actions.at(-1), frames: animationFrames, cycle: animationCycle, writeText: text,
          render: async ({ room, state, camera }) => ({
            room: roomLabel(room), camera,
            level: (await renderAsciiFrameV1(this.assets.engine.roomFromState(state, room), this.assets.blocks, camera)).text
          })
        });
      }
      const observation = await this.renderObservation({ includeColor: true });
      const summary = this.summary();
      await json("game-state.json", this.internal);
      await json("summary.json", summary);
      await json("display.json", {
        observation_revision: observation.observation_revision,
        room: observation.room,
        level: observation.level,
        colored_level: observation.colored_level,
        ascii_legend: observation.ascii_legend
      });
      await text("records/current_board.txt", `${observation.level}\n`);
      await json("records/current_state.json", {
        ...observation, level: undefined, colored_level: undefined, records: undefined
      });
      await text("records/moves.txt", this.internal.actions.map(action => action.action).join("\n") +
        (this.internal.actions.length ? "\n" : ""));
      await text("records/history.jsonl", this.internal.actions.map(action => JSON.stringify(publicAction(action))).join("\n") +
        (this.internal.actions.length ? "\n" : ""));
      if (writeSnapshot) {
        const index = this.internal.actionCount;
        const header = index === 0
          ? `# move 0 · initial · ${observation.room}`
          : `# move ${index} · ${this.internal.actions.at(-1).action} · ${observation.room}`;
        await text(`records/move_history/move_${index}.txt`, `${header}\n${observation.level}\n`);
        await json(`display-history/move_${index}.json`, {
          observation_revision: observation.observation_revision,
          room: observation.room,
          level: observation.level,
          colored_level: observation.colored_level
        });
      }
      const signed = await signCheckpoint(this.runDirectory, { artifactsDirectory: staging });
      // The signature is published last. A process crash during these renames
      // remains detectable by the existing fail-closed integrity check.
      for (const relative of artifacts) {
        if (path.dirname(relative) !== ".") safeDirectory(this.runDirectory, path.dirname(relative), { create: true });
        await rename(path.join(staging, relative), path.join(this.runDirectory, relative));
      }
      if (signed) await rename(path.join(staging, "checkpoint.json"), path.join(this.runDirectory, "checkpoint.json"));
    } catch (error) {
      // Never serve or continue the in-memory action after an unsuccessful save.
      // Reopening requires the normal checkpoint and capability verification.
      this.persistenceError = new Error(`Benchmark save failed; reopen the last verified checkpoint: ${error.message}`, { cause: error });
      throw this.persistenceError;
    } finally {
      if (staging) await rm(staging, { recursive: true, force: true });
    }
  }
}
