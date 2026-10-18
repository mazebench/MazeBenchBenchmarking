import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { parseReplay, resolveRoom } from "../replays/v1/import.mjs";
import { compileReplay, locateReplay, replayCamera, unpackTimeline } from "../replays/v1/movie.mjs";
import { createCommandTimeline, sampleTrack, sampleTimelinePlayer } from "../animations/v1/timeline.mjs";
import { instantiateMazeBenchEngineV1 } from "../engine/current/engine.mjs";
import { V2_BLOCK_CATALOG } from "../render/v1/voxel-world-v2.mjs";
import { SolutionsModel } from "../solutions/v1/model.mjs";
import { compileFullSolution } from "../solutions/v1/full-solution.mjs";

const cell = (blockId, x, y = 1, z = 0) => ({ blockId, x, y, z });
const floor = () => Array.from({ length: 32 }, (_, i) => cell("floor", i % 8, Math.floor(i / 8)));
const room = (objects, columnIndex = 0) => ({ fileName: `${columnIndex}.json`, position: [columnIndex ? "I" : "H", "I"],
  columnIndex, rowIndex: 0, width: 8, height: 4, objects });
const world = rooms => ({ blocks: V2_BLOCK_CATALOG, blockDefinitions: new Map(V2_BLOCK_CATALOG.map(block => [block.id, block])),
  columns: rooms.map(r => r.position[0]), rows: ["I"], roomWidth: 8, roomHeight: 4, rooms });
const engine = await instantiateMazeBenchEngineV1(await readFile(new URL("../engine/current/voxel_physics.wasm", import.meta.url)));

test("replay imports raw UDLR, full direction names and explicit room commands without mining prose", () => {
  const parsed = parseReplay("\uFEFF# exported moves\nStart room: l×o\nRRD, left; room HxI\nUp down LR");
  assert.equal(parsed.start, "LxO");
  assert.deepEqual(parsed.commands, ["right", "right", "down", "left"].map(direction => ({ type: "move", direction }))
    .concat({ type: "room", room: "HxI" }, ...["up", "down", "left", "right"].map(direction => ({ type: "move", direction }))));
  assert.equal(parseReplay("UDLR").start, "HxI");
  assert.equal(parseReplay("UDLR", { start: "LxO" }).start, "LxO");
  for (const text of ["", "hello world", "room", "R!D", "{bad json}", '{"description":"UDLR"}']) assert.throws(() => parseReplay(text), undefined, text);
});

test("JSON respects its start and supports verbose action records and wrapped full Solutions exports", () => {
  const parsed = parseReplay(JSON.stringify({ startRoom: "LxO", actions: [
    { type: "move", direction: "right" }, { type: "room", room: "HxI" }, { command: "DDLL" }
  ] }), { start: "AxA" });
  assert.equal(parsed.start, "LxO");
  assert.equal(parsed.commands.length, 6);
  const full = parseReplay(JSON.stringify({ startRoom: "other.json", fullSolution: {
    format: "mazebench-full-solution-v1", start: "HxI", commands: ["up", "room LxO", "left"], complete: false
  } }));
  assert.equal(full.start, "HxI");
  assert.equal(full.commands[1].room, "LxO");
  assert.match(full.notice, /partial/);
  assert(parseReplay(JSON.stringify({ format: "mazebench-solutions-v1", startRoom: "0.json", routes: [] })).saved);
  assert.throws(() => parseReplay('{"commands":[{"type":"room"}]}'), /no room/);
  assert.throws(() => resolveRoom(world([room([])]), "AxZ"), /does not exist/);
});

test("scrubbing samples actual engine tweens identically in both directions and preserves stationary layouts", async () => {
  const source = world([room([...floor(), cell("player", 2)])]);
  const movie = await compileReplay(engine, source, parseReplay("RLRLRLRL"));
  assert.equal(movie.clips.length, 8);
  assert.equal(movie.duration, 800);
  const pose = time => {
    const location = locateReplay(movie, time), timeline = unpackTimeline(movie, location.clip, source);
    return sampleTrack(timeline.tracks.find(track => track.block.roleId === "player"), location.local);
  };
  assert.equal(pose(25).x, 2.125);
  assert.equal(pose(50).x, 2.5);
  assert.equal(pose(75).x, 2.875);
  const before = pose(50);
  for (const time of [800, 400, 799, 0, 50]) pose(time);
  assert.deepEqual(pose(50), before);
  assert(movie.layouts.length <= 2, "unchanged floor layout is shared across the entire sequence");
  assert(movie.templates.length <= 64, "does not retain all room objects per action");
  assert.equal(locateReplay(movie, -100).time, 0);
  assert.equal(locateReplay(movie, Infinity).time, 800);
  assert.equal(locateReplay(movie, 100).index, 1);
  assert.equal(locateReplay(movie, 800).local, 100);
});

test("room commands restore the authored player, preserve collected gems, and tween the camera", async () => {
  const source = world([room([...floor(), cell("player", 2), cell("gem", 3)]), room([...floor(), cell("player", 5)], 1)]);
  const movie = await compileReplay(engine, source, parseReplay("R room IxI room HxI R"));
  assert.equal(movie.gems.length, 1);
  assert.equal(movie.clips.at(-1).gemsAfter, 1, "a gem is never collected twice after room reset");
  const jump = movie.clips[1];
  assert.equal(jump.duration, 250);
  assert.deepEqual(replayCamera(jump, 0), [-4, 0]);
  assert.deepEqual(replayCamera(jump, 125), [0, 0]);
  assert.deepEqual(replayCamera(jump, 250), [4, 0]);
  const transition = unpackTimeline(movie, jump, source);
  assert.equal(sampleTimelinePlayer(transition, 0).x, 3);
  assert.equal(sampleTimelinePlayer(transition, 250).x, 13);
  assert.equal(sampleTimelinePlayer(transition, 0).x, 3, "backward scrubbing restores the departing player for Truncate");
  const reset = unpackTimeline(movie, movie.clips[2], source);
  const players = reset.tracks.filter(track => track.block.roleId === "player").map(track => sampleTrack(track, 250));
  assert.deepEqual(players.filter(player => player.opacity > 0).map(player => player.x), [2]);
  assert.equal(reset.tracks.filter(track => track.block.roleId === "goal" && track.initialOpacity).length, 0);
});

test("explicit room resets tween displaced boxes home, including a jump back to the same room", async () => {
  const source = world([room([...floor(), cell("player", 2), cell("crate", 3)]), room([...floor(), cell("player", 5)], 1)]);
  for (const command of ["room HxI", "room IxI"]) {
    const movie = await compileReplay(engine, source, parseReplay(`R ${command}`));
    const clip = movie.clips[1], timeline = unpackTimeline(movie, clip, source);
    const box = timeline.tracks.find(track => track.object.blockId === "crate");
    assert.equal(sampleTrack(box, 0).x, 4);
    assert.equal(sampleTrack(box, 125).x, 3.5);
    assert.equal(sampleTrack(box, 250).x, 3);
  }
});

test("connected room crossings include slide tweens and keep the exact final player pose when seeking", async () => {
  const source = world([room([...floor(), cell("player", 6), cell("ice-floor", 7)]),
    room([...floor(), cell("ice-floor", 0), cell("player", 4)], 1)]);
  const movie = await compileReplay(engine, source, parseReplay("R"));
  const clip = movie.clips[0], timeline = unpackTimeline(movie, clip, source);
  const player = timeline.tracks.find(track => track.block.roleId === "player");
  assert.equal(clip.to, "1.json");
  assert.deepEqual(clip.rooms, ["0.json", "1.json"]);
  assert(player.motion.some(segment => segment.distance >= 2));
  assert.equal(sampleTrack(player, 0).x, 6);
  assert.equal(sampleTrack(player, clip.duration).x, 9);
  assert.equal(replayCamera(clip, clip.duration)[0], 4);
  assert.deepEqual(source.rooms[0].objects.find(o => o.blockId === "player"), cell("player", 6), "simulation never mutates authored input");
});

test("the real Solutions export replays its verified full command list", async () => {
  const source = world([room([...floor(), cell("player", 2), cell("gem", 4)])]);
  const model = new SolutionsModel(engine, source, "test");
  await model.move("right"); await model.move("right");
  const fullSolution = await compileFullSolution(model);
  const imported = parseReplay(JSON.stringify({ ...model.export(), fullSolution }));
  const movie = await compileReplay(engine, source, imported);
  assert.equal(movie.clips.length, fullSolution.commands.length);
  assert.equal(movie.gems.length, fullSolution.gems.length);
  assert.equal(movie.startRoom, "0.json");
  const restored = new SolutionsModel(engine, source, "test");
  await restored.importJSON(JSON.stringify(model.export()));
  const reconstructed = await compileFullSolution(restored);
  assert.deepEqual(reconstructed.commands, fullSolution.commands, "route-only exports compile to the same movie");
});

test("invalid room starts and cancellation never yield an apparently complete movie", async () => {
  const source = world([room([...floor(), cell("player", 2)]), room(floor(), 1)]);
  await assert.rejects(compileReplay(engine, source, parseReplay("room IxI")), /no player start/);
  await assert.rejects(compileReplay(engine, source, parseReplay("R"), { cancelled: () => true }), /cancelled/);
});

test("compact replay curves retain the shared lift and passenger interpolation", async () => {
  // A real lifted passenger sequence exercises both actor and plate transforms.
  const source = world([room([...floor(), cell("player", 1), { ...cell("lift", 2), orientation: "top", stateId: 0 }])]);
  const initial = engine.createState(source.rooms[0]);
  const simulation = await engine.simulateCommand(initial, "right", source.blockDefinitions);
  const expected = createCommandTimeline({ state: initial, room: source.rooms[0], simulation, definitions: source.blockDefinitions });
  const movie = await compileReplay(engine, source, parseReplay("R"));
  const actual = unpackTimeline(movie, movie.clips[0], source);
  for (const blockId of ["player", "lift"]) for (const at of [0, 25, 50, 75, 100]) {
    assert.deepEqual(sampleTrack(actual.tracks.find(track => track.object.blockId === blockId), at),
      sampleTrack(expected.tracks.find(track => track.object.blockId === blockId), at));
  }
});
