// Storage-v2 <-> MazeBenchEngineUnitTest's compact C++ ABI.
// The engine stores five int32 values per object: x, y, z, role hash, metadata.

export const ENGINE_V1_ABI = 4;
export const ENGINE_V1_VOXEL_STRIDE = 5;
export const ENGINE_V1_DIRECTIONS = Object.freeze(["up", "right", "down", "left"]);

const SLOPE_DIRECTIONS = ENGINE_V1_DIRECTIONS;
const LIFT_ORIENTATIONS = ["top", "north", "east", "south", "west"];
const BUTTON_ORIENTATIONS = [...LIFT_ORIENTATIONS, "bottom"];
const GENERIC_ROLES = new Set(["weightless-pushable", "clone"]);

function definitionMap(definitions) {
  return definitions instanceof Map
    ? definitions
    : new Map((definitions || []).map((definition) => [definition.id, definition]));
}

function normalizedIndex(value, length) {
  const number = Number.isFinite(Number(value)) ? Math.floor(Number(value)) : 0;
  return ((number % length) + length) % length;
}

function normalizeSlopeDirection(object) {
  const aliases = { north: "up", east: "right", south: "down", west: "left" };
  const candidate = String(object.orientation || "").toLowerCase();
  const direction = aliases[candidate] || candidate;
  return SLOPE_DIRECTIONS.includes(direction)
    ? direction
    : SLOPE_DIRECTIONS[normalizedIndex(object.variantId, 4)];
}

function normalizeLiftOrientation(object) {
  const aliases = { up: "top", front: "north", right: "east", back: "south", left: "west" };
  const candidate = String(object.orientation || "").toLowerCase();
  const orientation = aliases[candidate] || candidate;
  return LIFT_ORIENTATIONS.includes(orientation)
    ? orientation
    : LIFT_ORIENTATIONS[normalizedIndex(object.variantId, LIFT_ORIENTATIONS.length)];
}

function normalizeButtonOrientation(object) {
  const candidate = String(object.orientation || "").toLowerCase();
  const aliases = {
    up: "top", front: "north", right: "east", back: "south", left: "west",
    down: "bottom", ceiling: "bottom"
  };
  const orientation = aliases[candidate] || candidate;
  return BUTTON_ORIENTATIONS.includes(orientation)
    ? orientation
    : BUTTON_ORIENTATIONS[normalizedIndex(object.variantId, BUTTON_ORIENTATIONS.length)];
}

function slopeRoleId(baseRoleId, direction) {
  if (baseRoleId === "weightless-pushable") return `blue-box-slope-${direction}`;
  if (baseRoleId === "clone") return `yellow-clone-slope-${direction}`;
  return `ice-slope-${direction}`;
}

export function engineRoleIdForObject(object, definitions) {
  const block = definitionMap(definitions).get(object.blockId);
  if (!block) return "solid";
  if (block.visual?.kind === "slope") {
    return slopeRoleId(block.roleId, normalizeSlopeDirection(object));
  }
  // Storage v2 treats floor/exit z=0 as a surface. Exit markers still need
  // ordinary support physics, not a full blocking cube at the player's z.
  if (block.visual?.kind === "exit") return "floor";
  return block.roleId || "solid";
}

function engineZForObject(object, block) {
  return block?.visual?.kind === "floor" || block?.visual?.kind === "exit"
    ? object.z - 1
    : object.roleId === "orange-wall"
      ? object.z + Math.max(0, Math.floor(Number(object.mechanismDepth) || 0))
      : object.z;
}

function visualZForObject(engineZ, object, block, engineGenericId) {
  if (block?.visual?.kind === "floor" || block?.visual?.kind === "exit") return engineZ + 1;
  if (block?.roleId === "orange-wall") return engineZ - Math.max(0, engineGenericId);
  return engineZ;
}

function encodedLiftId(object) {
  if (Number.isInteger(object.engineGenericId)) return object.engineGenericId;
  const orientation = LIFT_ORIENTATIONS.indexOf(normalizeLiftOrientation(object));
  const raised = object.stateId === 1 || (Number.isInteger(object.genericId) && object.genericId % 2 === 1);
  return Math.max(0, orientation) * 2 + (raised ? 1 : 0);
}

function encodedButtonId(object) {
  if (Number.isInteger(object.engineGenericId)) return object.engineGenericId;
  const orientation = BUTTON_ORIENTATIONS.indexOf(normalizeButtonOrientation(object));
  return Math.max(0, orientation) * 2;
}

export function engineGenericIdForObject(object, definitions) {
  const block = definitionMap(definitions).get(object.blockId);
  if (!block) return -1;
  if (block.roleId === "player-lift") return encodedLiftId(object);
  if (block.roleId === "orange-button") return encodedButtonId(object);
  if (block.roleId === "orange-wall") {
    return Math.max(0, Math.floor(Number(object.mechanismDepth ?? object.stateId) || 0));
  }
  if (GENERIC_ROLES.has(block.roleId)) {
    return Number.isInteger(object.groupId)
      ? object.groupId
      : Number.isInteger(object.genericId) ? object.genericId : 0;
  }
  return Number.isInteger(object.genericId) ? object.genericId : -1;
}

export function createEngineStateV1(room) {
  return {
    width: room.width,
    height: room.height,
    objects: (room.objects || []).map((object) => ({ ...object }))
  };
}

export function writeEngineStateV1(state, definitions, roleCode, buffer, stride) {
  const blocks = definitionMap(definitions);
  state.objects.forEach((object, index) => {
    const block = blocks.get(object.blockId);
    const offset = index * stride;
    buffer[offset] = object.x;
    buffer[offset + 1] = object.y;
    buffer[offset + 2] = block?.roleId === "orange-wall"
      ? object.z + Math.max(0, Math.floor(Number(object.mechanismDepth) || 0))
      : engineZForObject(object, block);
    buffer[offset + 3] = roleCode(engineRoleIdForObject(object, blocks));
    buffer[offset + 4] = engineGenericIdForObject(object, blocks);
  });
}

export function readEngineStateV1(template, definitions, buffer, stride) {
  const blocks = definitionMap(definitions);
  const objects = template.objects.map((object, index) => {
    const block = blocks.get(object.blockId);
    const offset = index * stride;
    const engineGenericId = buffer[offset + 4];
    const next = {
      ...object,
      x: buffer[offset],
      y: buffer[offset + 1],
      z: visualZForObject(buffer[offset + 2], object, block, engineGenericId)
    };
    if (block?.roleId === "player-lift") {
      const id = Math.max(0, Math.min(9, engineGenericId));
      next.engineGenericId = id;
      next.genericId = id;
      next.groupId = id;
      next.orientation = LIFT_ORIENTATIONS[Math.floor(id / 2)];
      next.variantId = Math.floor(id / 2);
      next.stateId = id % 2;
    } else if (block?.roleId === "orange-button") {
      const id = Math.max(0, Math.min(11, engineGenericId));
      next.engineGenericId = id;
      next.orientation = BUTTON_ORIENTATIONS[Math.floor(id / 2)];
      next.variantId = Math.floor(id / 2);
      next.engineHidden = (id & 1) === 1;
    } else if (block?.roleId === "orange-wall") {
      next.mechanismDepth = Math.max(0, engineGenericId);
      next.stateId = 1;
    } else if (GENERIC_ROLES.has(block?.roleId)) {
      next.genericId = engineGenericId;
      next.groupId = engineGenericId;
    }
    return next;
  });
  return { width: template.width, height: template.height, objects };
}

export function activeEngineObjectsV1(state) {
  return state.objects
    .filter((object) => object.x >= 0 && object.y >= 0 &&
      object.x < state.width && object.y < state.height && !object.engineHidden)
    .map(({ engineGenericId, engineHidden, ...object }) => ({ ...object }));
}

export function roomFromEngineStateV1(state, room) {
  return {
    ...room,
    width: state.width,
    height: state.height,
    objects: activeEngineObjectsV1(state)
  };
}

export function countActiveRoleV1(state, definitions, roleId) {
  const blocks = definitionMap(definitions);
  return state.objects.filter((object) =>
    object.x >= 0 && object.y >= 0 && object.x < state.width && object.y < state.height &&
    blocks.get(object.blockId)?.roleId === roleId).length;
}

export function normalizeEngineDirectionV1(direction) {
  if (Number.isInteger(direction) && direction >= 0 && direction < 4) return direction;
  const index = ENGINE_V1_DIRECTIONS.indexOf(String(direction).toLowerCase());
  if (index < 0) throw new Error(`Unknown engine direction: ${direction}`);
  return index;
}

