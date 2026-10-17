import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "../render/vendor/three.module.min.js";
import { V2_WORLD_FORMAT } from "../render/v1/voxel-world-v2.mjs";
import { createPlayWorldContext, playRoomCenter } from "../ui/play-world-context.mjs";
import { PlayWorldRenderer } from "../ui/play-world-renderer.mjs";

function fixture() {
  const blocks = [
    { id: "floor", roleId: "floor", color: "#d6bd94", visual: { kind: "floor" } },
    { id: "player", roleId: "player", color: "#5aa95c", visual: { kind: "cube" } },
    { id: "wall", roleId: "solid", color: "#23262c", visual: { kind: "cube" } }
  ];
  const world = {
    storageFormat: V2_WORLD_FORMAT,
    columns: Array.from({ length: 16 }, (_, i) => String(i)),
    rows: Array.from({ length: 16 }, (_, i) => String(i)),
    roomWidth: 16, roomHeight: 16, blocks,
    blockDefinitions: new Map(blocks.map(block => [block.id, block])),
    rooms: Array.from({ length: 256 }, (_, i) => ({
      fileName: `${i}.json`, width: 16, height: 16,
      columnIndex: i % 16, rowIndex: Math.floor(i / 16),
      objects: [
        { blockId: "floor", x: 0, y: 0, z: 0 },
        { blockId: "player", x: 0, y: 0, z: 0 },
        { blockId: "wall", x: 1, y: 1, z: 3 }
      ]
    }))
  };
  return { world, context: createPlayWorldContext(world) };
}

// Exercise the real geometry/cache code without a WebGL context.
function rendererFixture(world) {
  const renderer = Object.create(PlayWorldRenderer.prototype);
  Object.assign(renderer, {
    canvas: { dataset: {} }, scene: new THREE.Scene(),
    content: new THREE.Group(), cutawayContent: new THREE.Group(),
    placementPreview: new THREE.Group(), target: new THREE.Vector3(),
    cameraMotion: {}, renderer: { shadowMap: { enabled: true } },
    mode: "play", pickVoxels: false,
    cutaway: { height: null, opacity: 0.2, followPlayer: false },
    render() {}, requestModels() {}
  });
  renderer.setWorld(world, { preserveCamera: true });
  return renderer;
}

test("Play includes every room and only the live player, without mutating authored data", () => {
  const { world, context } = fixture();
  const active = world.rooms[135];
  const frame = context(active, { ...active, objects: [{ blockId: "player", x: 7, y: 6, z: 2 }] });
  assert.equal(frame.rooms.length, 256);
  assert.equal(frame.columns.length, 16);
  assert.equal(frame.rows.length, 16);
  assert.equal(frame.rooms.filter(room => room.renderDimmed).length, 255);
  assert.equal(frame.rooms.flatMap(room => room.objects).filter(object => object.blockId === "player").length, 1);
  assert.equal(frame.rooms[135].objects[0].x, 7);
  assert.equal(world.rooms[135].objects[1].x, 0);
  assert.equal(world.rooms[0].objects.length, 3);
  assert.deepEqual(playRoomCenter(frame), { x: -8, z: 8 });
  assert.deepEqual(playRoomCenter(context(world.rooms[0])), { x: -120, z: -120 });
  assert.deepEqual(playRoomCenter(context(world.rooms[255])), { x: 120, z: 120 });
});

test("engine frames and room changes reuse all 256 background meshes", () => {
  const { world, context } = fixture();
  const renderer = rendererFixture(context(world.rooms[135]));
  const original = [...renderer.roomBackgrounds.values()].map(entry => entry.content.children[0]);
  const oldActive = renderer.content.children[0].geometry;
  let disposed = false;
  oldActive.addEventListener("dispose", () => { disposed = true; });
  renderer.setWorld(context(world.rooms[135], {
    ...world.rooms[135], objects: [{ blockId: "player", x: 7, y: 6, z: 0 }]
  }), { preserveCamera: true });
  assert.equal(disposed, true);
  assert.deepEqual([...renderer.roomBackgrounds.values()].map(entry => entry.content.children[0]), original);
  assert.equal(renderer.roomBackgrounds.get("135.json").root.visible, false);
  assert.equal([...renderer.roomBackgrounds.values()].filter(entry => entry.root.visible).length, 255);

  renderer.target.set(-8, 1.2, 8);
  renderer.cameraMotion.centerAnimation = { startX: -10, targetX: -8, startZ: 6, targetZ: 8 };
  renderer.setWorld(context(world.rooms[255]), { preserveCamera: true });
  assert.deepEqual([...renderer.roomBackgrounds.values()].map(entry => entry.content.children[0]), original);
  assert.equal(renderer.roomBackgrounds.get("135.json").root.visible, true);
  assert.equal(renderer.roomBackgrounds.get("255.json").root.visible, false);
  assert.deepEqual(renderer.target.toArray(), [120, 1.2, 120]);
  assert.deepEqual(renderer.cameraMotion.centerAnimation, { startX: 118, targetX: 120, startZ: 118, targetZ: 120 });
  const distantBounds = new THREE.Box3().setFromObject(renderer.roomBackgrounds.get("0.json").root);
  assert.equal(distantBounds.min.x, -128);
  assert.equal(distantBounds.min.z, -128);
  assert.deepEqual(renderer.zoomLimits(), [7, 1000]);
});

test("cutaway invalidates cached geometry and follow-player uses the live height in every room", () => {
  const { world, context } = fixture();
  const renderer = rendererFixture(context(world.rooms[135]));
  const before = renderer.roomBackgrounds.get("0.json").content.children[0];
  let disposed = false;
  before.geometry.addEventListener("dispose", () => { disposed = true; });
  renderer.setCutaway({ followPlayer: true });
  assert.equal(disposed, true);
  assert.equal(renderer.cutawayHeight, 1);
  const cutaway = renderer.roomBackgrounds.get("0.json");
  assert.notEqual(cutaway.content.children[0], before);
  assert.ok(new THREE.Box3().setFromObject(cutaway.content).max.y <= 1);
  assert.ok(cutaway.cutawayContent.children.length > 0);
  renderer.setWorld(context(world.rooms[135], {
    ...world.rooms[135], objects: [{ blockId: "player", x: 0, y: 0, z: 3 }]
  }), { preserveCamera: true });
  assert.equal(renderer.cutawayHeight, 4);
  assert.notEqual(renderer.roomBackgrounds.get("0.json"), cutaway);
  assert.equal(renderer.roomBackgrounds.get("0.json").cutawayContent.children.length, 0);
});
