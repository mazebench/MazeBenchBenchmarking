import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { signCheckpoint, verifyCheckpoint } from "../../benchmarking/v1/integrity.mjs";
import { safeReadFile } from "../../benchmarking/v1/safe-files.mjs";
import { parseIceLevel, slideIce, iceSolved, goalsCovered, iceAscii, normalizeIceAction, validatePlayers } from "./engine.mjs";

const clone = value => structuredClone(value);
const now = () => new Date().toISOString();
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const terminal = status => ["won", "action-limit"].includes(status);
const records = ["current_board.txt", "current_state.json", "moves.txt", "history.jsonl"];
async function atomic(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, value, { mode: 0o600 }); await rename(temp, file);
}
export function expandIceSequence(input) {
  const actions = Array.isArray(input) ? input : /^[udrl\s,]+$/i.test(String(input)) ? [...input.replace(/[\s,]/g, "")] : String(input).split(/[\n,]+/);
  if (!actions.length || actions.length > 1000 || actions.some(action => typeof action !== "string")) throw new Error("Supply 1–1000 Ice Maze actions.");
  return actions.map(normalizeIceAction);
}
export class IceBenchmarkRuntime {
  constructor(projectRoot, runDirectory, world, internal) {
    this.projectRoot = projectRoot; this.runDirectory = runDirectory; this.world = world; this.internal = internal;
    this.levels = world.levels.map(parseIceLevel);
    if (internal.version !== "ice-maze-v1" || !this.levels[internal.levelIndex]) throw new Error("Invalid Ice Maze checkpoint.");
    validatePlayers(this.level, internal.players);
  }
  static async assets(root) { return JSON.parse(await readFile(path.join(root, "level-data/ice-maze/v1/world.json"), "utf8")); }
  static async create(root, directory, { actionLimit = 100 } = {}) {
    const world = await this.assets(root), first = parseIceLevel(world.levels[0]);
    const internal = { version: "ice-maze-v1", levelIndex: 0, players: first.players, history: [], completedLevels: [],
      actionCount: 0, actionLimit, actions: [], stateHashes: [], positions: [], blockedActions: 0, resets: 0, undos: 0, updatedAt: now() };
    const runtime = new this(root, directory, world, internal);
    for (const name of ["workspace", "sandbox-state", "records/move_history", "display-history"]) await mkdir(path.join(directory, name), { recursive: true, mode: 0o700 });
    internal.stateHashes.push(runtime.stateHash()); internal.positions.push(...runtime.positions());
    await runtime.persist(); return runtime;
  }
  static async open(root, directory) {
    verifyCheckpoint(directory);
    return new this(root, directory, await this.assets(root), JSON.parse(safeReadFile(directory, "game-state.json")));
  }
  get level() { return this.levels[this.internal.levelIndex]; }
  get room() { return `Level ${this.internal.levelIndex + 1}`; }
  stateHash() { return hash([this.internal.levelIndex, this.internal.players.map(p => [p.x, p.y]).sort(), this.internal.completedLevels]); }
  positions() {
    return this.internal.players.map((p, i) => ({ room: this.room, level: this.internal.levelIndex + 1, player: i + 1, localX: p.x, localY: p.y, z: 0,
      worldX: this.internal.levelIndex % 6 * 12 + p.x, worldY: Math.floor(this.internal.levelIndex / 6) * 12 + p.y }));
  }
  status() {
    if (this.internal.completedLevels.length === this.levels.length) return "won";
    if (this.internal.actionLimit !== null && this.internal.actionCount >= this.internal.actionLimit) return "action-limit";
    return iceSolved(this.level, this.internal.players) ? "level-complete" : "playing";
  }
  recordIndex() { return [...records, "move_history/move_0.txt", ...this.internal.actions.map(a => `move_history/move_${a.index}.txt`)]; }
  async readRecord(value) {
    if (typeof value !== "string" || !this.recordIndex().includes(value)) throw new Error("Unknown benchmark record. Use a path from the records index.");
    return { record: value, content: safeReadFile(path.join(this.runDirectory, "records"), value) };
  }
  async renderObservation({ includeColor = false } = {}) {
    const s = this.internal, level = iceAscii(this.level, s.players);
    const colors = { "#": "#647c90", ".": "#addced", o: "#ffbd70", P: "#46d89b", "@": "#46d89b" };
    return { schema_version: 1, world: "ice-maze", topology: "sequential", observation_revision: s.actionCount, game_status: this.status(), room: this.room,
      level_number: s.levelIndex + 1, levels_total: this.levels.length, levels_solved: s.completedLevels.length, completed_levels: [...s.completedLevels],
      players: s.players.map((p, i) => ({ player: i + 1, ...p })), goals: clone(this.level.goals), goals_covered: goalsCovered(this.level, s.players), goals_total: this.level.goals.length,
      action_count: s.actionCount, action_limit: s.actionLimit, actions_remaining: s.actionLimit === null ? null : Math.max(0, s.actionLimit - s.actionCount),
      state_hash: s.stateHashes.at(-1), novel_state: s.actions.at(-1)?.novel ?? true, level,
      ...(includeColor ? { colored_level: level.split("\n").map(row => [...row].map(text => ({ text, color: colors[text] }))) } : {}),
      ascii_legend: "# wall · . slippery ice · o slippery goal · P player · @ player on goal. Coordinates are zero-based, x right and y down. Every direction moves all players together until blocked. Goals never stop players.",
      recent_actions: s.actions.slice(-12), records: { read_with: "maze_observe({record: <relative path>})", files: this.recordIndex() },
      allowed_actions: terminal(this.status()) ? [] : this.status() === "level-complete" ? ["next"] : ["up", "right", "down", "left", "undo", "reset"] };
  }
  async apply(input) {
    const action = normalizeIceAction(input), s = this.internal, beforeStatus = this.status();
    if (terminal(beforeStatus)) throw new Error("This benchmark has reached its terminal state.");
    if (beforeStatus === "level-complete" && action !== "next") throw new Error("Level complete. Use next to begin the next numbered level.");
    if (action === "next" && beforeStatus !== "level-complete") throw new Error("Cover every goal before advancing. Levels cannot be skipped.");
    const before = this.stateHash(), roomBefore = this.room, playersBefore = clone(s.players);
    if (action === "next") { s.levelIndex++; s.players = clone(this.level.players); s.history = []; }
    else if (action === "undo") { if (s.history.length) s.players = s.history.pop(); s.undos++; }
    else if (action === "reset") { s.players = clone(this.level.players); s.history = []; s.resets++; }
    else { const slide = slideIce(this.level, s.players, action); if (slide.changed) { s.history.push(clone(s.players)); s.players = slide.players; } }
    if (iceSolved(this.level, s.players) && !s.completedLevels.includes(s.levelIndex + 1)) s.completedLevels.push(s.levelIndex + 1);
    const after = this.stateHash(), novel = !s.stateHashes.includes(after), changed = before !== after;
    const blocked = ["up", "right", "down", "left"].includes(action) && !changed;
    if (blocked) s.blockedActions++;
    s.actionCount++; s.updatedAt = now(); s.stateHashes.push(after); s.positions.push(...this.positions());
    const record = { index: s.actionCount, action, at: s.updatedAt, roomBefore, roomAfter: this.room, level: s.levelIndex + 1,
      stateChanged: changed, moved: JSON.stringify(playersBefore) !== JSON.stringify(s.players), blocked, died: false, novel, stateHash: after,
      players: clone(s.players), player: this.positions()[0], levelsSolved: s.completedLevels.length, goalsCovered: goalsCovered(this.level, s.players) };
    s.actions.push(record); await this.persist();
    return { action: record, observation: await this.renderObservation() };
  }
  async applySequence(input) {
    const actions = expandIceSequence(input), steps = [];
    for (const action of actions) {
      if (terminal(this.status()) || (steps.length && this.status() === "level-complete")) break;
      const result = await this.apply(action); steps.push({ action: result.action, status: { game_status: result.observation.game_status, level_number: result.observation.level_number, levels_solved: result.observation.levels_solved, action_count: result.observation.action_count } });
      // A sequence cannot spill into the next puzzle, even if it contains next.
      if (this.status() === "level-complete" || action === "next") break;
    }
    return { requested_count: actions.length, completed_count: steps.length, stopped_early: steps.length < actions.length, steps, final_observation: await this.renderObservation() };
  }
  summary() {
    const s = this.internal;
    return { schema_version: 1, world: "ice-maze", updated_at: s.updatedAt, game_status: this.status(), action_count: s.actionCount, action_limit: s.actionLimit,
      room: this.room, level_number: s.levelIndex + 1, levels_total: this.levels.length, levels_solved: s.completedLevels.length,
      goals_covered: goalsCovered(this.level, s.players), goals_total: this.level.goals.length,
      unique_cells: new Set(s.positions.map(p => `${p.worldX},${p.worldY}`)).size, novelty_rate: s.actionCount ? s.actions.filter(a => a.novel).length / s.actionCount : 1,
      blocked_actions: s.blockedActions, resets: s.resets, undos: s.undos, deaths: 0, camera_actions: 0, positions: s.positions, novelty: [true, ...s.actions.map(a => a.novel)], actions: s.actions };
  }
  async persist() {
    const o = await this.renderObservation({ includeColor: true }), s = this.internal;
    const display = { observation_revision: o.observation_revision, room: o.room, world: "ice-maze", level: o.level, colored_level: o.colored_level, ascii_legend: o.ascii_legend };
    const files = { "game-state.json": JSON.stringify(s), "summary.json": JSON.stringify(this.summary()), "display.json": JSON.stringify(display),
      "records/current_board.txt": o.level + "\n", "records/current_state.json": JSON.stringify({ ...o, level: undefined, colored_level: undefined, records: undefined }),
      "records/moves.txt": s.actions.map(a => a.action).join("\n") + "\n", "records/history.jsonl": s.actions.map(a => JSON.stringify(a)).join("\n") + "\n",
      [`records/move_history/move_${s.actionCount}.txt`]: `# move ${s.actionCount} · ${s.actions.at(-1)?.action || "initial"} · ${o.room}\n${o.level}\n`,
      [`display-history/move_${s.actionCount}.json`]: JSON.stringify(display) };
    await Promise.all(Object.entries(files).map(([name, value]) => atomic(path.join(this.runDirectory, name), value)));
    await signCheckpoint(this.runDirectory);
  }
}
