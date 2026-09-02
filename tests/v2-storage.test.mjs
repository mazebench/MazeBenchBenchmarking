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
import {
  CAMERA_TILT_ACCEL,
  CAMERA_TILT_DECEL,
  CAMERA_TILT_MAX_SPEED,
  CAMERA_YAW_DURATION_MS,
  CAMERA_ZOOM_DURATION_MS,
  easeInOutQuad,
  easeToward,
  yawTransitionAt,
  zoomTransitionAt
} from "../render/v1/camera-transitions.mjs";
import {
  voxelPieceDefinition,
  voxelRenderSource
} from "../render/v1/voxel-scene-v2.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const definitions = new Map(V2_BLOCK_CATALOG.map((block) => [block.id, block]));

test("camera quarter turns ease smoothly and finish on the exact cardinal angle", () => {
  assert.equal(easeInOutQuad(0), 0);
  assert.equal(easeInOutQuad(0.5), 0.5);
  assert.equal(easeInOutQuad(1), 1);
  const animation = { startMs: 100, startYaw: 0, targetYaw: Math.PI / 2 };
  const midpoint = yawTransitionAt(animation, 100 + CAMERA_YAW_DURATION_MS / 2);
  assert.equal(midpoint.complete, false);
  assert.equal(midpoint.yaw, Math.PI / 4);
  assert.deepEqual(yawTransitionAt(animation, 100 + CAMERA_YAW_DURATION_MS), {
    complete: true,
    yaw: Math.PI / 2
  });

  const accelerating = easeToward(0, CAMERA_TILT_MAX_SPEED, CAMERA_TILT_ACCEL / 60);
  assert.ok(accelerating > 0 && accelerating < CAMERA_TILT_MAX_SPEED);
  assert.ok(easeToward(accelerating, 0, CAMERA_TILT_DECEL / 60) < accelerating);

  const zoom = { startMs: 200, startDistance: 100, targetDistance: 25 };
  const zoomMidpoint = zoomTransitionAt(zoom, 200 + CAMERA_ZOOM_DURATION_MS / 2);
  assert.equal(zoomMidpoint.complete, false);
  assert.ok(Math.abs(zoomMidpoint.distance - 50) < 1e-9);
  assert.deepEqual(zoomTransitionAt(zoom, 200 + CAMERA_ZOOM_DURATION_MS), {
    complete: true,
    distance: 25
  });
});

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

test("placement previews use the real oriented button and slope definitions", () => {
  const button = definitions.get("orange-button");
  const buttonObject = { x: 6, y: 6, z: 2, blockId: button.id, orientation: "east" };
  assert.deepEqual(voxelPieceDefinition(buttonObject, button), {
    kind: "orange_button",
    bottom: 2,
    top: 3,
    color: button.color,
    orientation: "east"
  });

  const slope = definitions.get("ice-slope");
  const slopeObject = { x: 4, y: 5, z: 3, blockId: slope.id, orientation: "up" };
  assert.equal(voxelPieceDefinition(slopeObject, slope).kind, "slope");
  assert.equal(voxelRenderSource(slopeObject, slope).direction, "up");
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
