// Lightweight layered compositor adapted from MazeBenchEngine's ASCII
// observation renderer. It preserves the five pitch levels and 4×4 tiles.

import {
  ACTOR_GLYPHS,
  BLACK_ICE_SLOPE_DIRECTION_GLYPHS,
  BLOCK_ASSET_GLYPHS,
  CLONE_GLYPHS,
  ICE_SLOPE_DIRECTION_GLYPHS,
  ORANGE_BUTTON_GLYPHS,
  ORANGE_ICE_SLOPE_DIRECTION_GLYPHS,
  PLAYER_LIFT_GLYPHS,
  PUNCHER_DIRECTION_GLYPHS,
  TERRAIN_GLYPHS,
  UNKNOWN_GLYPHS,
  WEIGHTLESS_BOX_GLYPHS,
  createDynamicGlyphCatalog,
  hiddenAsciiGlyphMap,
  hiddenGlyph,
  glyphPair
} from "./glyph-contract.mjs";

export const ASCII_TILE_SIZE = 4;
export const ASCII_MAX_PITCH = 4;

const DIRECTIONS = Object.freeze(["up", "right", "down", "left"]);
const ORIENTATION_ALIASES = Object.freeze({
  north: "up",
  east: "right",
  south: "down",
  west: "left",
  front: "up",
  back: "down"
});

function definitionMap(definitions) {
  return definitions instanceof Map
    ? definitions
    : new Map((definitions || []).map((definition) => [definition.id, definition]));
}

export function normalizeAsciiYaw(value) {
  const yaw = Number.isInteger(value) ? value : 0;
  return ((yaw % 4) + 4) % 4;
}

export function normalizeAsciiPitch(value) {
  const pitch = Number.isFinite(Number(value)) ? Math.round(Number(value)) : 0;
  return Math.max(0, Math.min(ASCII_MAX_PITCH, pitch));
}

export function normalizeObjectDirection(object) {
  const candidate = String(object?.orientation || object?.direction || "").toLowerCase();
  const direction = ORIENTATION_ALIASES[candidate] || candidate;
  if (DIRECTIONS.includes(direction)) return direction;
  const variant = Number.isInteger(object?.variantId) ? object.variantId : 0;
  return DIRECTIONS[((variant % 4) + 4) % 4];
}

export function cameraRelativeDirection(direction, yaw = 0) {
  const index = DIRECTIONS.indexOf(direction);
  return DIRECTIONS[((Math.max(0, index) + normalizeAsciiYaw(yaw)) % 4 + 4) % 4];
}

function displayDimensions(room, yaw) {
  return yaw % 2 === 0
    ? { width: room.width, height: room.height }
    : { width: room.height, height: room.width };
}

function worldCoordinatesForDisplay(room, yaw, x, y) {
  switch (yaw) {
    case 1: return { x: y, y: room.height - 1 - x };
    case 2: return { x: room.width - 1 - x, y: room.height - 1 - y };
    case 3: return { x: room.width - 1 - y, y: x };
    default: return { x, y };
  }
}

function genericId(object) {
  return Number.isInteger(object.groupId)
    ? object.groupId
    : Number.isInteger(object.genericId) ? object.genericId : 0;
}

function cloneVariant(object) {
  return `c${genericId(object)}`;
}

function weightlessVariant(object) {
  return `M${genericId(object)}`;
}

function dynamicIdentity(object, direction = normalizeObjectDirection(object)) {
  if (object.blockId === "clone") return `clone_${cloneVariant(object)}`;
  if (object.blockId === "clone-slope") return `ramped_clone_${cloneVariant(object)}_${direction}`;
  if (object.blockId === "weightless-box") return `weightless_push_box_${weightlessVariant(object)}`;
  return `ramped_weightless_push_box_${weightlessVariant(object)}_${direction}`;
}

export function dynamicIdentitySetsForRoom(room) {
  const cloneIdentities = new Set();
  const weightlessIdentities = new Set();
  (room?.objects || []).forEach((object) => {
    if (object.blockId === "clone") {
      if (!CLONE_GLYPHS[cloneVariant(object)]) cloneIdentities.add(dynamicIdentity(object));
    } else if (object.blockId === "weightless-box") {
      if (!WEIGHTLESS_BOX_GLYPHS[weightlessVariant(object)]) {
        weightlessIdentities.add(dynamicIdentity(object));
      }
    } else if (object.blockId === "clone-slope" || object.blockId === "weightless-slope") {
      const target = object.blockId === "clone-slope" ? cloneIdentities : weightlessIdentities;
      DIRECTIONS.forEach((direction) => target.add(dynamicIdentity(object, direction)));
    }
  });
  return { cloneIdentities, weightlessIdentities };
}

export function glyphCatalogForRoom(room) {
  const identities = dynamicIdentitySetsForRoom(room);
  return createDynamicGlyphCatalog({
    cloneIdentities: [...identities.cloneIdentities],
    weightlessIdentities: [...identities.weightlessIdentities]
  });
}

export function glyphForObject(object, definition, yaw = 0, catalog = null) {
  const screenDirection = cameraRelativeDirection(normalizeObjectDirection(object), yaw);
  switch (object.blockId) {
    case "floor": return TERRAIN_GLYPHS.floor;
    case "ice-floor": return TERRAIN_GLYPHS.ice;
    case "exit": return TERRAIN_GLYPHS.exit;
    case "wall": return TERRAIN_GLYPHS.wall;
    case "ice-block": return TERRAIN_GLYPHS.ice_block;
    case "ice-slope": return ICE_SLOPE_DIRECTION_GLYPHS[screenDirection];
    case "wall-slope": return BLACK_ICE_SLOPE_DIRECTION_GLYPHS[screenDirection];
    case "orange-slope": return ORANGE_ICE_SLOPE_DIRECTION_GLYPHS[screenDirection];
    case "player": return ACTOR_GLYPHS.player;
    case "gem": return ACTOR_GLYPHS.gem;
    case "gate": return TERRAIN_GLYPHS.player_gate;
    case "lift": {
      const lift = PLAYER_LIFT_GLYPHS.player_lift;
      return glyphPair(object.stateId === 1 ? lift.raisedTop : lift.loweredTop, lift.side);
    }
    case "orange-wall": return TERRAIN_GLYPHS.orange_wall;
    case "orange-button": return ORANGE_BUTTON_GLYPHS.orange_button;
    case "puncher": return PUNCHER_DIRECTION_GLYPHS[screenDirection] || ACTOR_GLYPHS.puncher;
    case "crate": return ACTOR_GLYPHS.box;
    case "floating-floor": return ACTOR_GLYPHS.floating_floor;
    case "clone": return CLONE_GLYPHS[cloneVariant(object)] ||
      catalog?.pairFor("clone", dynamicIdentity(object)) || ACTOR_GLYPHS.clone;
    case "clone-slope": return catalog?.pairFor("clone", dynamicIdentity(object, screenDirection)) ||
      ACTOR_GLYPHS.clone;
    case "weightless-box": return WEIGHTLESS_BOX_GLYPHS[weightlessVariant(object)] ||
      catalog?.pairFor("weightless_box", dynamicIdentity(object)) || ACTOR_GLYPHS.weightless_box;
    case "weightless-slope": return catalog?.pairFor(
      "weightless_box",
      dynamicIdentity(object, screenDirection)
    ) || ACTOR_GLYPHS.weightless_box;
    case "t1": case "t2": case "t3": case "t4":
    case "st1": case "st3": case "st4": return TERRAIN_GLYPHS.tree;
    case "sh": return TERRAIN_GLYPHS.shrub;
    case "b1": return BLOCK_ASSET_GLYPHS[1];
    case "b2": return BLOCK_ASSET_GLYPHS[2];
    case "b3": return BLOCK_ASSET_GLYPHS[3];
    case "b4": return BLOCK_ASSET_GLYPHS[4];
    default: return definition?.category === "actor" ? UNKNOWN_GLYPHS.actor : UNKNOWN_GLYPHS.terrain;
  }
}

function observationColor(object, definition) {
  if (["floor", "exit", "orange-button", "floating-floor"].includes(object.blockId)) return "#d6bd94";
  if (["ice-floor", "ice-block", "ice-slope"].includes(object.blockId)) return "#a9d6f4";
  if (["wall", "wall-slope"].includes(object.blockId)) return "#23262c";
  if (["orange-wall", "orange-slope"].includes(object.blockId)) return "#b85f16";
  if (object.blockId === "gate") return "#c75652";
  if (object.blockId === "lift") return "#8a63d2";
  if (object.blockId === "sh") return "#476b35";
  if (["t1", "t2", "t3", "t4", "st1", "st3", "st4"].includes(object.blockId)) return "#2f7d3f";
  if (["b1", "b2", "b3", "b4"].includes(object.blockId)) return "#5b2f14";
  if (object.blockId === "crate") return "#2a2d33";
  if (["clone", "clone-slope"].includes(object.blockId)) return "#b59a2a";
  if (object.blockId === "gem") return "#6cd7ff";
  if (object.blockId === "player") return "#5aa95c";
  if (object.blockId === "puncher") return "#ef4444";
  if (["weightless-box", "weightless-slope"].includes(object.blockId)) return "#315991";
  return definition?.color || "#d6bd94";
}

function visibleTop(object, definition) {
  const base = Number(object.z) || 0;
  const kind = definition?.visual?.kind;
  if (kind === "floor" || kind === "exit") return base;
  if (kind === "model") return base + Math.max(1, Number(definition.visual.height) || 1);
  if (kind === "lift" && object.stateId !== 1) return base + 0.2;
  return base + 1;
}

function visibilityPriority(object, definition) {
  if (object.blockId === "player") return 100;
  if (object.blockId === "gem") return 90;
  if (object.blockId === "puncher") return 80;
  if (object.blockId === "orange-button") return 70;
  if (definition?.category === "actor") return 60;
  if (["floor", "ice-floor", "exit"].includes(object.blockId)) return 10;
  return 30;
}

function topObjectsByCell(room, definitions) {
  const cells = new Map();
  (room.objects || []).forEach((object, index) => {
    if (object.engineHidden || object.x < 0 || object.y < 0 || object.x >= room.width || object.y >= room.height) return;
    const definition = definitions.get(object.blockId);
    const candidate = {
      definition,
      index,
      object,
      priority: visibilityPriority(object, definition),
      top: visibleTop(object, definition)
    };
    const key = `${object.x},${object.y}`;
    const current = cells.get(key);
    if (!current || candidate.top > current.top ||
        (candidate.top === current.top && candidate.priority > current.priority) ||
        (candidate.top === current.top && candidate.priority === current.priority && index > current.index)) {
      cells.set(key, candidate);
    }
  });
  return cells;
}

function dynamicLegend(catalog, mapping) {
  const entries = [];
  for (const [family, pairs] of [["clone", catalog.clones], ["block", catalog.weightless]]) {
    pairs.forEach((pair, name) => entries.push({
      color: family === "clone" ? "#b59a2a" : "#315991",
      glyph: hiddenGlyph(pair.top, mapping),
      name
    }));
  }
  return entries.sort((left, right) => left.name.localeCompare(right.name));
}

const EMPTY_PIXEL = Object.freeze({ color: "#050608", glyph: " ", name: "empty" });

function objectRecord(object, definition, yaw, catalog, index) {
  const pair = glyphForObject(object, definition, yaw, catalog);
  const bottom = Number.isFinite(Number(object.z)) ? Math.floor(Number(object.z)) : 0;
  const kind = definition?.visual?.kind;
  const surfaceOnly = object.blockId === "orange-button" ||
    (object.blockId === "lift" && object.stateId !== 1);
  const height = kind === "model"
    ? Math.max(1, Math.floor(Number(definition.visual.height) || 1))
    : 1;
  const top = kind === "floor" || kind === "exit" || surfaceOnly
    ? bottom
    : bottom + height;
  const color = observationColor(object, definition);
  return {
    bottom,
    category: definition?.category === "actor" ? "actor" : "terrain",
    index,
    object,
    side: { color, glyph: pair.side, name: object.blockId },
    surfaceOnly,
    top,
    topPixel: { color, glyph: pair.top, name: object.blockId }
  };
}

function sceneCells(room, definitions, yaw, catalog) {
  const cells = new Map();
  (room.objects || []).forEach((object, index) => {
    if (object.engineHidden || object.x < 0 || object.y < 0 || object.x >= room.width || object.y >= room.height) return;
    const definition = definitions.get(object.blockId);
    const record = objectRecord(object, definition, yaw, catalog, index);
    const display = (() => {
      switch (yaw) {
        case 1: return { x: room.height - 1 - object.y, y: object.x };
        case 2: return { x: room.width - 1 - object.x, y: room.height - 1 - object.y };
        case 3: return { x: object.y, y: room.width - 1 - object.x };
        default: return { x: object.x, y: object.y };
      }
    })();
    const key = `${display.x},${display.y}`;
    if (!cells.has(key)) cells.set(key, { actors: [], terrain: [] });
    cells.get(key)[record.category === "actor" ? "actors" : "terrain"].push(record);
  });
  cells.forEach((cell) => {
    cell.terrain.sort((left, right) => left.bottom - right.bottom || left.top - right.top || left.index - right.index);
    cell.actors.sort((left, right) => left.bottom - right.bottom || left.index - right.index);
  });
  return cells;
}

function blankCanvas(width, height) {
  return Array.from({ length: height }, () => Array.from({ length: width }, () => EMPTY_PIXEL));
}

function drawRect(canvas, left, top, width, height, pixel, onlyBlank = false) {
  if (width <= 0 || height <= 0) return;
  for (let y = top; y < top + height; y += 1) {
    for (let x = left; x < left + width; x += 1) {
      if (!canvas[y]?.[x] || (onlyBlank && canvas[y][x].glyph !== " ")) continue;
      canvas[y][x] = pixel;
    }
  }
}

function trimPixelCanvas(canvas) {
  let top = canvas.length;
  let bottom = -1;
  let left = canvas[0]?.length || 0;
  let right = -1;
  canvas.forEach((row, y) => row.forEach((pixel, x) => {
    if (pixel.glyph === " ") return;
    top = Math.min(top, y);
    bottom = Math.max(bottom, y);
    left = Math.min(left, x);
    right = Math.max(right, x);
  }));
  if (bottom < top || right < left) return [[EMPTY_PIXEL]];
  return canvas.slice(top, bottom + 1).map((row) => row.slice(left, right + 1));
}

function expandedTopPixels(cells) {
  return cells.flatMap((row) => Array.from({ length: ASCII_TILE_SIZE }, () =>
    row.flatMap((cell) => Array.from({ length: ASCII_TILE_SIZE }, () => cell))));
}

function highestTerrain(cell) {
  return Math.max(-1, ...(cell?.terrain || []).map((record) => record.top));
}

function layeredPixels(room, definitions, yaw, pitch, catalog) {
  const dimensions = displayDimensions(room, yaw);
  const scene = sceneCells(room, definitions, yaw, catalog);
  const topRows = ASCII_TILE_SIZE - pitch;
  const sideRows = pitch;
  const rowStep = Math.max(1, topRows);
  const maxHeight = Math.max(0, ...[...scene.values()].flatMap((cell) =>
    [...cell.terrain, ...cell.actors].map((record) => record.top)));
  const topMargin = maxHeight * sideRows + 1;
  const width = dimensions.width * ASCII_TILE_SIZE;
  const height = topMargin + dimensions.height * rowStep + ASCII_TILE_SIZE + Math.max(1, sideRows) + 2;
  const canvas = blankCanvas(width, height);

  for (let displayY = 0; displayY < dimensions.height; displayY += 1) {
    const baseY = topMargin + displayY * rowStep;
    for (let level = 0; level <= maxHeight; level += 1) {
      for (let displayX = 0; displayX < dimensions.width; displayX += 1) {
        const cell = scene.get(`${displayX},${displayY}`);
        if (!cell) continue;
        const screenX = displayX * ASCII_TILE_SIZE;
        const frontHeight = highestTerrain(scene.get(`${displayX},${displayY + 1}`));
        cell.terrain.forEach((record) => {
          if (record.top === level) {
            drawRect(
              canvas,
              screenX,
              baseY - record.top * sideRows,
              ASCII_TILE_SIZE,
              topRows,
              record.topPixel
            );
          }
        });
        cell.terrain.forEach((record) => {
          if (sideRows <= 0 || record.surfaceOnly) return;
          if (record.top > record.bottom) {
            if (level < record.bottom || level >= record.top || frontHeight >= level + 1) return;
            const exposedBottom = Math.max(level, frontHeight);
            drawRect(
              canvas,
              screenX,
              baseY - (level + 1) * sideRows + topRows,
              ASCII_TILE_SIZE,
              (level + 1 - exposedBottom) * sideRows,
              record.side
            );
          } else if (record.top === level && frontHeight < record.top) {
            const exposedBottom = Math.max(record.top - 1, frontHeight);
            drawRect(
              canvas,
              screenX,
              baseY - record.top * sideRows + topRows,
              ASCII_TILE_SIZE,
              (record.top - exposedBottom) * sideRows,
              record.side
            );
          }
        });
      }

      const actors = [];
      for (let displayX = 0; displayX < dimensions.width; displayX += 1) {
        (scene.get(`${displayX},${displayY}`)?.actors || []).forEach((record) =>
          actors.push({ ...record, displayX }));
      }
      actors.forEach((record) => {
        const screenX = record.displayX * ASCII_TILE_SIZE;
        const topY = baseY - record.top * sideRows;
        if (record.top === level) {
          drawRect(canvas, screenX, topY, ASCII_TILE_SIZE, topRows, record.topPixel);
        }
        if (!record.surfaceOnly && record.bottom === level) {
          drawRect(canvas, screenX, topY + topRows, ASCII_TILE_SIZE, sideRows, record.side);
        }
      });
    }
  }
  return trimPixelCanvas(canvas);
}

function sidePixels(room, definitions, yaw, catalog) {
  const dimensions = displayDimensions(room, yaw);
  const scene = sceneCells(room, definitions, yaw, catalog);
  const maxHeight = Math.max(1, ...[...scene.values()].flatMap((cell) =>
    [...cell.terrain, ...cell.actors].map((record) => record.top)));
  const baseline = maxHeight * ASCII_TILE_SIZE;
  const canvas = blankCanvas(dimensions.width * ASCII_TILE_SIZE, baseline + 1);
  for (let displayY = dimensions.height - 1; displayY >= 0; displayY -= 1) {
    for (let displayX = 0; displayX < dimensions.width; displayX += 1) {
      const cell = scene.get(`${displayX},${displayY}`);
      if (!cell) continue;
      const screenX = displayX * ASCII_TILE_SIZE;
      cell.terrain.forEach((record) => {
        if (record.surfaceOnly) return;
        const rows = record.top > record.bottom
          ? (record.top - record.bottom) * ASCII_TILE_SIZE
          : 1;
        const top = record.top > record.bottom
          ? baseline - record.top * ASCII_TILE_SIZE
          : baseline - record.top * ASCII_TILE_SIZE;
        drawRect(canvas, screenX, top, ASCII_TILE_SIZE, rows, record.side, true);
      });
      cell.actors.forEach((record) => {
        if (record.surfaceOnly) return;
        drawRect(
          canvas,
          screenX,
          baseline - record.top * ASCII_TILE_SIZE,
          ASCII_TILE_SIZE,
          Math.max(1, (record.top - record.bottom) * ASCII_TILE_SIZE),
          record.side,
          true
        );
      });
    }
  }
  return trimPixelCanvas(canvas);
}

function remapPixels(pixels, mapping) {
  if (!mapping) return pixels;
  return pixels.map((row) => row.map((pixel) => ({
    ...pixel,
    glyph: hiddenGlyph(pixel.glyph, mapping)
  })));
}

export async function renderAsciiFrameV1(room, definitions, options = {}) {
  const blocks = definitionMap(definitions);
  const yaw = normalizeAsciiYaw(options.yaw);
  const pitch = normalizeAsciiPitch(options.pitch);
  const catalog = options.catalog || glyphCatalogForRoom(room);
  const mapping = options.hideNames ? await hiddenAsciiGlyphMap(options.hideNamesSeed || "1") : null;
  const dimensions = displayDimensions(room, yaw);
  const topObjects = topObjectsByCell(room, blocks);
  const cells = [];

  for (let displayY = 0; displayY < dimensions.height; displayY += 1) {
    const row = [];
    for (let displayX = 0; displayX < dimensions.width; displayX += 1) {
      const world = worldCoordinatesForDisplay(room, yaw, displayX, displayY);
      const visible = topObjects.get(`${world.x},${world.y}`);
      if (!visible) {
        row.push({ glyph: TERRAIN_GLYPHS.empty.top, color: "#050608", name: "empty" });
        continue;
      }
      const pair = glyphForObject(visible.object, visible.definition, yaw, catalog);
      row.push({
        glyph: pair.top,
        color: observationColor(visible.object, visible.definition),
        name: visible.object.blockId
      });
    }
    cells.push(row);
  }

  const canonicalPixels = pitch === 0
    ? expandedTopPixels(cells)
    : pitch === ASCII_MAX_PITCH
      ? sidePixels(room, blocks, yaw, catalog)
      : layeredPixels(room, blocks, yaw, pitch, catalog);
  const pixels = remapPixels(canonicalPixels, mapping);
  const renderedCells = remapPixels(cells, mapping);
  const rows = pixels.map((row) => row.map((pixel) => pixel.glyph).join(""));
  return {
    catalog,
    cells: renderedCells,
    legend: options.hideNames ? [] : dynamicLegend(catalog, mapping),
    rows,
    pixels,
    pitch,
    text: rows.join("\n"),
    width: pixels[0]?.length || 0,
    height: pixels.length
  };
}
