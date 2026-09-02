import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  objectPaintsInsideClickedBody,
  placeObjectInCell
} from "../render/v1/cell-objects-v2.mjs";
import {
  resolveEditorPaintTargetV2,
  voxelPlacementForTool
} from "../editor/v1/face-placement-v2.mjs";
import {
  decodeVoxelRoom,
  encodeVoxelRoom,
  V2_BLOCK_CATALOG,
  V2_ROOM_FORMAT,
  V2_WORLD_FORMAT
} from "../render/v1/voxel-world-v2.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const definitions = new Map(V2_BLOCK_CATALOG.map((block) => [block.id, block]));

test("v2 rooms preserve stacked, overlapping, and oriented objects", () => {
  const objects = [
    { x: 3, y: 4, z: 0, blockId: "floor" },
    { x: 3, y: 4, z: 0, blockId: "orange-button", orientation: "east", variantId: 2 },
    { x: 3, y: 4, z: 1, blockId: "wall" },
    { x: 3, y: 4, z: 2, blockId: "clone", genericId: 7, groupId: 7 }
  ];
  const encoded = encodeVoxelRoom({ width: 16, height: 16, objects });
  assert.equal(encoded.storageFormat, V2_ROOM_FORMAT);
  assert.deepEqual(decodeVoxelRoom(encoded).objects, objects);
});

test("side-face placement uses the adjacent 3D cell and records the face orientation", () => {
  const hit = {
    kind: "terrain",
    sourceX: 5,
    sourceY: 6,
    sourceZ: 2,
    paintX: 6,
    paintY: 6,
    paintZ: 2,
    dx: 1,
    dy: 0,
    dz: 0,
    face: "side-face"
  };
  const button = definitions.get("orange-button");
  const coordinate = resolveEditorPaintTargetV2(hit, {
    selectedCanShare: objectPaintsInsideClickedBody(button)
  });
  assert.deepEqual(coordinate, { x: 6, y: 6, z: 2 });
  assert.deepEqual(
    voxelPlacementForTool("o", coordinate, hit, { near: "down", far: "up" }),
    { x: 6, y: 6, z: 2, blockId: "orange-button", orientation: "east", variantId: 2 }
  );
  const lift = voxelPlacementForTool("L", coordinate, hit, { near: "down", far: "up" });
  assert.equal(lift.orientation, "east");
  assert.equal(lift.stateId, 1);
});

test("shareable face objects coexist with solid objects at one coordinate", () => {
  const floor = { x: 2, y: 2, z: 0, blockId: "floor" };
  const button = { x: 2, y: 2, z: 0, blockId: "orange-button", orientation: "top" };
  const buttonResult = placeObjectInCell([floor], button, definitions);
  assert.equal(buttonResult.changed, true);
  assert.deepEqual(buttonResult.objects, [floor, button]);

  const puncher = { x: 2, y: 2, z: 0, blockId: "puncher", orientation: "right" };
  const puncherResult = placeObjectInCell(buttonResult.objects, puncher, definitions);
  assert.equal(puncherResult.changed, true);
  assert.deepEqual(puncherResult.objects, [floor, button, puncher]);
  assert.equal(objectPaintsInsideClickedBody(definitions.get("puncher")), true);
});

test("the generated main world contains 256 valid v2 rooms", async () => {
  const root = path.join(repositoryRoot, "level-data", "v2", "main-world");
  const manifest = JSON.parse(await readFile(path.join(root, "world.json"), "utf8"));
  assert.equal(manifest.storageFormat, V2_WORLD_FORMAT);
  assert.equal(Object.keys(manifest.rooms).length, 256);
  const files = (await readdir(root)).filter((fileName) => fileName.endsWith(".json") && fileName !== "world.json");
  assert.equal(files.length, 256);
  for (const fileName of files) {
    const room = decodeVoxelRoom(JSON.parse(await readFile(path.join(root, fileName), "utf8")));
    assert.equal(room.width, 16);
    assert.equal(room.height, 16);
    assert.ok(room.objects.every((object) => definitions.has(object.blockId)));
  }
});
