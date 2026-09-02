import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  cellObjectSelectionKey,
  eraseOneObjectAtCell,
  objectPaintsInsideClickedBody,
  objectIsSurface,
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
  CAMERA_CENTER_DURATION_MS,
  CAMERA_PAN_ACCEL_MULTIPLIER,
  CAMERA_TILT_ACCEL,
  CAMERA_TILT_DECEL,
  CAMERA_TILT_MAX_SPEED,
  CAMERA_YAW_DURATION_MS,
  CAMERA_ZOOM_ACCEL,
  CAMERA_ZOOM_DURATION_MS,
  CAMERA_ZOOM_MAX_LOG_SPEED,
  cameraRelativePanVector,
  centerTransitionAt,
  clampCameraPitch,
  easeInOutQuad,
  easeToward,
  panSpeedForDistance,
  yawTransitionAt,
  zoomDistanceAtVelocity,
  zoomTransitionAt
} from "../render/v1/camera-transitions.mjs";
import {
  voxelPieceDefinition,
  voxelRenderSource
} from "../render/v1/voxel-scene-v2.mjs";
import {
  puncherDirectionVector,
  slopeGeometry
} from "../render/v1/special-piece-renderers.mjs";

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

test("editor camera pitch can orbit below while other views stay above", () => {
  assert.ok(clampCameraPitch(-0.8, true) < 0);
  assert.ok(clampCameraPitch(-0.8, false) > 0);
  assert.ok(clampCameraPitch(-Math.PI, true) > -Math.PI / 2);
});

test("held zoom and arrow pan controls accelerate continuously in camera space", () => {
  assert.deepEqual(cameraRelativePanVector(0, 1, 0), { x: 1, z: 0 });
  assert.deepEqual(cameraRelativePanVector(0, 0, 1), { x: 0, z: -1 });
  const quarterTurnRight = cameraRelativePanVector(Math.PI / 2, 1, 0);
  assert.ok(Math.abs(quarterTurnRight.x) < 1e-12);
  assert.equal(quarterTurnRight.z, -1);
  const diagonal = cameraRelativePanVector(0, 1, 1);
  assert.ok(Math.abs(Math.hypot(diagonal.x, diagonal.z) - 1) < 1e-12);

  const panSpeed = panSpeedForDistance(30);
  assert.ok(panSpeed > 5);
  assert.ok(easeToward(0, panSpeed, panSpeed * CAMERA_PAN_ACCEL_MULTIPLIER / 60) > 0);

  const zoomVelocity = easeToward(
    0,
    -CAMERA_ZOOM_MAX_LOG_SPEED,
    CAMERA_ZOOM_ACCEL / 60
  );
  assert.ok(zoomDistanceAtVelocity(30, zoomVelocity, 1 / 60, [7, 110]) < 30);
  assert.equal(zoomDistanceAtVelocity(7, -1, 1, [7, 110]), 7);
  assert.equal(zoomDistanceAtVelocity(110, 1, 1, [7, 110]), 110);
});

test("slash centering eases the board target back to the origin", () => {
  const animation = {
    startMs: 100,
    startX: 24,
    startZ: -12,
    targetX: 0,
    targetZ: 0
  };
  assert.deepEqual(centerTransitionAt(animation, 100 + CAMERA_CENTER_DURATION_MS / 2), {
    complete: false,
    x: 12,
    z: -6
  });
  assert.deepEqual(centerTransitionAt(animation, 100 + CAMERA_CENTER_DURATION_MS), {
    complete: true,
    x: 0,
    z: 0
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

  const puncher = voxelPlacementForTool("pr", coordinate, hit, { near: "down", far: "up" });
  assert.equal(puncher.orientation, "east");
  assert.equal(puncher.variantId, 2);
});

test("punchers point out from horizontal, top, and bottom highlighted faces", () => {
  const coordinate = { x: 3, y: 4, z: 2 };
  const camera = { near: "left", far: "right" };
  const top = voxelPlacementForTool("pr", coordinate, {
    dx: 0, dy: 0, dz: 1, face: "top"
  }, camera);
  const bottom = voxelPlacementForTool("pr", coordinate, {
    dx: 0, dy: 0, dz: -1, face: "bottom-face"
  }, camera);
  assert.equal(top.orientation, "top");
  assert.equal(top.variantId, 0);
  assert.equal(bottom.orientation, "bottom");
  assert.equal(bottom.variantId, 5);
  assert.deepEqual(puncherDirectionVector("top").toArray(), [0, 1, 0]);
  assert.deepEqual(puncherDirectionVector("bottom").toArray(), [0, -1, 0]);
  assert.deepEqual(puncherDirectionVector("west").toArray(), [-1, 0, 0]);
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

test("floor surfaces survive solid placement and can be replaced independently", () => {
  const floor = { x: 2, y: 2, z: 0, blockId: "floor" };
  const block = { x: 2, y: 2, z: 0, blockId: "weightless-box", genericId: 4, groupId: 4 };
  assert.equal(objectIsSurface(definitions.get("floor")), true);
  assert.equal(objectIsSurface(definitions.get("weightless-box")), false);

  const placed = placeObjectInCell([floor], block, definitions);
  assert.deepEqual(placed.objects, [floor, block]);

  const ice = { x: 2, y: 2, z: 0, blockId: "ice-floor" };
  const resurfaced = placeObjectInCell(placed.objects, ice, definitions);
  assert.deepEqual(resurfaced.objects, [block, ice]);

  const erased = eraseOneObjectAtCell(
    placed.objects,
    { x: 2, y: 2, z: 0 },
    cellObjectSelectionKey(block)
  );
  assert.deepEqual(erased.objects, [floor]);
});

test("every directional slope is a closed five-surface wedge", () => {
  for (const direction of ["right", "left", "up", "down"]) {
    const geometry = slopeGeometry(direction);
    const positions = geometry.getAttribute("position");
    const normals = geometry.getAttribute("normal");
    assert.equal(positions.count, 24, `${direction} slope should contain eight triangles`);
    const uniqueNormals = new Set();
    for (let index = 0; index < normals.count; index += 1) {
      uniqueNormals.add([
        normals.getX(index),
        normals.getY(index),
        normals.getZ(index)
      ].map((value) => Math.round(value * 1000)).join(","));
    }
    assert.equal(uniqueNormals.size, 5, `${direction} slope should expose ramp, end, sides, and underside`);
    assert.equal(geometry.boundingBox.min.y, 0);
    assert.equal(geometry.boundingBox.max.y, 1);
  }
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
