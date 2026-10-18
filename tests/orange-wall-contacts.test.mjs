import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import * as THREE from "../render/vendor/three.module.min.js";
import { surfaceContactEdges } from "../ui/joined-voxel-surface.mjs";
import { contactShape, worldContactShapes } from "../ui/orange-wall-contacts.mjs";
import { CommandAnimationScene } from "../animations/v1/scene.mjs";
import { createCommandTimeline } from "../animations/v1/timeline.mjs";
import { PlayWorldRenderer } from "../ui/play-world-renderer.mjs";
import { instantiateMazeBenchEngineV1 } from "../engine/current/engine.mjs";
import { decodeVoxelRoom } from "../render/v1/voxel-world-v2.mjs";
import { createPlayWorldContext } from "../ui/play-world-context.mjs";

const segments = positions => Array.from({ length: positions.length / 6 }, (_, i) => positions.slice(i * 6, i * 6 + 6));
const floor = (x = 0, z = 0) => ({ position: [x, -.40625, z], size: [1, .34375, 1] });
const atFloor = positions => segments(positions).filter(p => Math.abs(p[1] + .0625) < 1e-7 && Math.abs(p[4] + .0625) < 1e-7);

test("joined orange walls retain their floor intersection without tile seams at every lowering height", () => {
  for (const height of [-1, -.75, -.5, -.125]) {
    const walls = [0, 1].flatMap(x => [height, height + 1].map(y => ({ position: [x, y, 0] })));
    const edges = atFloor(surfaceContactEdges(walls, [floor(0), floor(1)]));
    assert.equal(edges.length, 6, `six perimeter segments, height ${height}`);
    assert(edges.every(p => !(p[0] === 1 && p[3] === 1)), "no line across the middle of the joined wall");
    assert.equal(edges.reduce((sum, p) => sum + Math.hypot(p[3] - p[0], p[5] - p[2]), 0), 6);
  }
  assert.deepEqual(surfaceContactEdges([{ position: [0, -2, 0] }], [floor()]), [], "fully buried walls add no floor outline");
});

test("orange ramps and elevated support surfaces get their actual cross section", () => {
  for (const direction of ["up", "down", "left", "right"]) {
    const edges = atFloor(surfaceContactEdges([{ position: [0, -.5, 0], direction }], [floor()]));
    assert.equal(edges.length, 4, direction);
    assert(edges.flat().some(value => Math.abs(value - .4375) < 1e-7 || Math.abs(value - .5625) < 1e-7), "cross section follows the sloped face");
  }
  const raised = surfaceContactEdges([{ position: [0, 1.5, 0] }], [{ position: [0, 1, 0] }]);
  assert.equal(segments(raised).filter(p => p[1] === 2 && p[4] === 2).length, 4);
  const orange = { roleId: "orange-wall", visual: { kind: "cube" } };
  assert.equal(contactShape({ x: 0, y: 0, z: 0, engineHidden: true }, orange), null);
  assert.equal(contactShape({ x: 0, y: 0, z: 0 }, { ...orange, visual: { kind: "cube", orangeForm: "hidden" } }), null);
});

test("L×O LLLD keeps contact outlines on the floor through the tween and at rest", async () => {
  const manifestUrl = new URL("../level-data/v2/main-world/world.json", import.meta.url);
  const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
  const definitions = new Map(manifest.blocks.map(block => [block.id, block]));
  const [fileName, position] = Object.entries(manifest.rooms).find(([, value]) => value.join("x") === "LxO");
  const room = { ...decodeVoxelRoom(JSON.parse(await readFile(new URL(fileName, manifestUrl), "utf8"))),
    fileName, position, columnIndex: 0, rowIndex: 0 };
  const makeWorld = createPlayWorldContext({ ...manifest, blockDefinitions: definitions, columns: ["L"], rows: ["O"],
    roomWidth: room.width, roomHeight: room.height, rooms: [room] });
  const engine = await instantiateMazeBenchEngineV1(await readFile(new URL("../engine/current/voxel_physics.wasm", import.meta.url)));
  let state = engine.createState(room), lowering = null;
  for (const letter of "LLLD") {
    const simulation = await engine.simulateCommand(state, letter === "L" ? "left" : "down", definitions);
    const timeline = createCommandTimeline({ state, room, simulation, definitions });
    if (timeline.tracks.some(track => track.block.roleId === "orange-wall" && track.changed)) lowering = timeline;
    state = simulation.final;
  }
  assert(lowering, "sequence lowers the walls");
  const world = makeWorld(room);
  const renderer = Object.create(PlayWorldRenderer.prototype);
  Object.assign(renderer, { world, totalWidth: room.width, totalHeight: room.height, mode: "play", canvas: { dataset: {} },
    target: new THREE.Vector3(), scene: new THREE.Scene(), content: new THREE.Group(), cutawayContent: new THREE.Group(),
    renderer: { shadowMap: { enabled: false } }, cutaway: { height: 1, opacity: 0, followPlayer: false }, yaw: 0 });
  const animation = new CommandAnimationScene(renderer, lowering);
  const buffers = animation.wallContacts.map(contact => contact.mesh.geometry);
  const motion = lowering.tracks.find(track => track.block.roleId === "orange-wall" && track.changed).motion[0];
  for (const time of [.25, .5, .75, 1].map(t => motion.start + t * (motion.end - motion.start))) {
    animation.update(time); animation.beforeRender();
    let floorSegments = 0;
    for (const [index, contact] of animation.wallContacts.entries()) {
      assert.equal(contact.mesh.geometry, buffers[index], "geometry is retained");
      const geometry = contact.mesh.geometry, points = geometry.attributes.position;
      assert(geometry.drawRange.count <= points.count, "preallocated capacity covers all segments");
      for (let i = 0; i < geometry.drawRange.count; i += 6) {
        const y1 = points.getY(i) + contact.root.position.y, y2 = points.getY(i + 1) + contact.root.position.y;
        if (Math.abs(y1 + .0625) < 1e-5 && Math.abs(y2 + .0625) < 1e-5) floorSegments++;
      }
      assert(contact.mesh.material.clippingPlanes?.length, "Truncate clips contact lines too");
    }
    assert(floorSegments > 0, `floor contact during tween at ${time} ms`);
  }
  const finalWorld = { ...world, rooms: [{ ...room, objects: state.objects }] };
  const { walls, supports } = worldContactShapes(finalWorld);
  assert(atFloor(surfaceContactEdges(walls, supports)).length > 0, "settled renderer has the same contact outline");
  animation.dispose();
});
