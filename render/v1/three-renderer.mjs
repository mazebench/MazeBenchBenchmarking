// Renderer v1 scene/controller. Geometry and piece definitions deliberately
// live in small sibling modules so alternate renderer versions can replace
// one concern without copying a monolith.

import * as THREE from "../vendor/three.module.min.js";
import { addGemAsset, addTerrainAsset, assetReady, loadAssetModels } from "./asset-renderers.mjs";
import { actorPieceDefinition, terrainPieceDefinition } from "./piece-definitions.mjs";
import {
  FLOOR_DROP,
  FLOOR_THICKNESS,
  disposeGeneratedChildren,
  edgeGeometryFromFaces,
  edgeMaterial,
  floorFaces,
  geometryFromFaces,
  renderMaterial,
  voxelFaces,
  voxelKey,
  cachedGeometry
} from "./polycube-mesh.mjs";
import { addSpecialPiece } from "./special-piece-renderers.mjs";
import { MAZE_COLORS, parseCellState } from "./world-renderer.mjs";

const CARDINAL_STEP = Math.PI * 0.5;
const DEFAULT_HEADING = 0;
const DEFAULT_PITCH = 0.72;
const PITCH_STEP = THREE.MathUtils.degToRad(6);
const MIN_PITCH = 0.18;
const MAX_PITCH = 1.48;
const DRAG_HEADING_THRESHOLD = 48;
const HEADING_DIRECTIONS = Object.freeze([
  { near: "down", far: "up" },
  { near: "right", far: "left" },
  { near: "up", far: "down" },
  { near: "left", far: "right" }
]);

function isEditableTarget(target) {
  return target instanceof HTMLElement
    && (target.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName));
}

function groupEntry(groups, key, settings) {
  if (!groups.has(key)) groups.set(key, { ...settings, voxels: [], voxelKeys: new Set() });
  return groups.get(key);
}

export class ThreeMazeRendererV1 {
  constructor(canvas, world, options = {}) {
    this.canvas = canvas;
    this.mode = options.mode || "world";
    this.onInspect = options.onInspect || null;
    this.onSelect = options.onSelect || null;
    this.onPaint = options.onPaint || null;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(MAZE_COLORS.empty);
    this.camera = new THREE.PerspectiveCamera(34, 1, 0.05, 1600);
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();
    this.groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this.target = new THREE.Vector3();
    this.heading = DEFAULT_HEADING;
    this.yaw = this.heading * CARDINAL_STEP;
    this.pitch = DEFAULT_PITCH;
    this.distance = 30;
    this.content = new THREE.Group();
    this.scene.add(this.content);
    this.pickMeshes = [];
    this.cellTops = new Map();
    this.pointer = null;
    this.painting = false;
    this.lastPaintKey = "";
    this.modelLoadGeneration = 0;
    this.installScene();
    this.installEvents();
    this.setWorld(world);
    this.resize();
  }

  installScene() {
    this.scene.add(new THREE.AmbientLight("#ffffff", 1.45));
    const key = new THREE.DirectionalLight("#ffffff", 1.2);
    key.position.set(5, 18, -5);
    key.target.position.set(0, 0, 0);
    this.scene.add(key, key.target);
  }

  installEvents() {
    this.canvas.addEventListener("contextmenu", (event) => event.preventDefault());
    this.canvas.addEventListener("wheel", (event) => {
      event.preventDefault();
      this.zoomBy(event.deltaY < 0 ? 0.88 : 1 / 0.88);
    }, { passive: false });
    this.canvas.addEventListener("pointerdown", (event) => {
      this.canvas.setPointerCapture(event.pointerId);
      if (this.mode === "editor" && event.button === 0 && !event.altKey) {
        this.painting = true;
        this.lastPaintKey = "";
        this.paintAt(event, true);
        return;
      }
      this.pointer = { x: event.clientX, y: event.clientY, moved: false, headingDrag: 0 };
    });
    this.canvas.addEventListener("pointermove", (event) => {
      if (this.painting) return this.paintAt(event, false);
      if (this.pointer) {
        const dx = event.clientX - this.pointer.x;
        const dy = event.clientY - this.pointer.y;
        this.pointer.moved ||= Math.abs(dx) + Math.abs(dy) > 3;
        this.pointer.x = event.clientX;
        this.pointer.y = event.clientY;
        this.pointer.headingDrag += dx;
        while (Math.abs(this.pointer.headingDrag) >= DRAG_HEADING_THRESHOLD) {
          this.rotateCardinal(this.pointer.headingDrag > 0 ? -1 : 1, false);
          this.pointer.headingDrag += this.pointer.headingDrag > 0
            ? -DRAG_HEADING_THRESHOLD
            : DRAG_HEADING_THRESHOLD;
        }
        this.pitch = Math.max(MIN_PITCH, Math.min(MAX_PITCH, this.pitch + dy * 0.004));
        return this.render();
      }
      this.onInspect?.(this.hitTest(event));
    });
    const finishPointer = (event) => {
      if (this.painting) {
        this.painting = false;
        this.lastPaintKey = "";
        return;
      }
      if (this.pointer && !this.pointer.moved) this.onSelect?.(this.hitTest(event));
      this.pointer = null;
    };
    this.canvas.addEventListener("pointerup", finishPointer);
    this.canvas.addEventListener("pointercancel", finishPointer);
    window.addEventListener("keydown", (event) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || isEditableTarget(event.target)) return;
      const key = event.key.toLowerCase();
      if (!["w", "a", "s", "d"].includes(key)) return;
      event.preventDefault();
      if (key === "a") this.rotateCardinal(-1);
      if (key === "d") this.rotateCardinal(1);
      if (key === "w") this.tiltCamera(PITCH_STEP);
      if (key === "s") this.tiltCamera(-PITCH_STEP);
    });
  }

  rotateCardinal(direction, render = true) {
    this.heading = (this.heading + direction + 4) % 4;
    this.yaw = this.heading * CARDINAL_STEP;
    if (render) this.render();
  }

  tiltCamera(amount) {
    this.pitch = Math.max(MIN_PITCH, Math.min(MAX_PITCH, this.pitch + amount));
    this.render();
  }

  cameraDirections() {
    return HEADING_DIRECTIONS[this.heading];
  }

  paintAt(event, start) {
    const hit = this.hitTest(event);
    if (!hit) return;
    const key = `${hit.room.fileName}:${hit.cellX}:${hit.cellY}`;
    if (key === this.lastPaintKey) return;
    this.lastPaintKey = key;
    this.onPaint?.(hit, { start });
  }

  setWorld(world, options = {}) {
    this.world = world;
    this.totalWidth = this.mode === "editor" ? world.roomWidth : world.columns.length * world.roomWidth;
    this.totalHeight = this.mode === "editor" ? world.roomHeight : world.rows.length * world.roomHeight;
    this.setSelection(null);
    const modelUrls = this.rebuild();
    this.requestModels(modelUrls);
    if (!options.preserveCamera) this.resetView();
  }

  setRoom(room, options = {}) {
    this.setWorld({
      columns: [room.position[0]],
      rows: [room.position[1]],
      roomWidth: room.cells[0]?.length || 16,
      roomHeight: room.cells.length || 16,
      rooms: [{ ...room, columnIndex: 0, rowIndex: 0 }]
    }, options);
  }

  requestModels(urls) {
    const generation = ++this.modelLoadGeneration;
    if (!urls.size) return;
    loadAssetModels(urls).then(() => {
      if (generation !== this.modelLoadGeneration) return;
      this.rebuild();
      this.render();
    });
  }

  collectScene() {
    const floorGroups = new Map();
    const cubeGroups = new Map();
    const occupied = new Set();
    const specialPieces = [];
    const terrainAssets = [];
    const gems = [];
    const modelUrls = new Set();
    const editorGridCells = [];
    const cellMetadata = [];
    this.cellTops = new Map();

    const recordTop = (x, z, top) => {
      const key = `${x},${z}`;
      this.cellTops.set(key, Math.max(this.cellTops.get(key) ?? -Infinity, top));
    };
    const addVoxelColumn = (groupKey, settings, x, z, bottom, height) => {
      const group = groupEntry(cubeGroups, groupKey, settings);
      for (let offset = 0; offset < height; offset += 1) {
        const voxel = { x, z, y: bottom + offset };
        const key = voxelKey(voxel.x, voxel.z, voxel.y);
        if (!group.voxelKeys.has(key)) {
          group.voxels.push(voxel);
          group.voxelKeys.add(key);
        }
        occupied.add(key);
      }
      recordTop(x, z, bottom + height);
    };

    this.world.rooms.forEach((room) => {
      room.cells.forEach((row, cellY) => row.forEach((rawCell, cellX) => {
        const x = room.columnIndex * this.world.roomWidth + cellX;
        const z = room.rowIndex * this.world.roomHeight + cellY;
        const state = parseCellState(rawCell);
        cellMetadata.push({ x, z, room, cellX, cellY, cell: rawCell });

        state.layers.forEach((layer) => {
          const definition = terrainPieceDefinition(layer);
          recordTop(x, z, definition.top);
          if (definition.kind === "floor") {
            const key = `floor:${layer.type}:${definition.color}`;
            if (!floorGroups.has(key)) floorGroups.set(key, { color: definition.color, cells: [] });
            const floor = { x, z, bottom: definition.bottom, top: definition.top };
            floorGroups.get(key).cells.push(floor);
            if (definition.editorGrid) editorGridCells.push(floor);
            if (definition.exitMarker) {
              specialPieces.push({
                x,
                z,
                source: layer,
                definition: { kind: "exit_marker", bottom: definition.top + 0.02, top: definition.top + 0.36 }
              });
              recordTop(x, z, definition.top + 0.36);
            }
            return;
          }
          if (definition.kind === "terrain_asset") {
            modelUrls.add(layer.modelUrl);
            if (assetReady(layer.modelUrl)) {
              terrainAssets.push({ x, z, localX: cellX, localZ: cellY, source: layer, definition });
            } else {
              addVoxelColumn(
                `asset-fallback:${layer.type}:${definition.color}`,
                { color: definition.color },
                x,
                z,
                definition.bottom,
                definition.fallbackHeight
              );
            }
            return;
          }
          if (definition.kind === "cube") {
            addVoxelColumn(
              `terrain:${layer.type}:${layer.styleKey || ""}:${definition.color}`,
              { color: definition.color },
              x,
              z,
              definition.bottom,
              definition.height
            );
            return;
          }
          specialPieces.push({ x, z, source: layer, definition });
        });

        state.actors.forEach((actor) => {
          const definition = actorPieceDefinition(actor);
          recordTop(x, z, definition.top);
          if (definition.kind === "gem_asset") {
            modelUrls.add(actor.modelUrl);
            gems.push({ x, z, source: actor, definition });
            return;
          }
          if (definition.kind === "cube") {
            const identity = actor.groupId || actor.type;
            addVoxelColumn(
              `actor:${actor.type}:${identity}:${definition.color}`,
              { color: definition.color },
              x,
              z,
              definition.bottom,
              definition.height
            );
            return;
          }
          specialPieces.push({ x, z, source: actor, definition });
        });
      }));
    });

    return {
      cellMetadata,
      cubeGroups,
      editorGridCells,
      floorGroups,
      gems,
      modelUrls,
      occupied,
      specialPieces,
      terrainAssets
    };
  }

  addFloorGroups(groups) {
    const halfWidth = this.totalWidth / 2;
    const halfHeight = this.totalHeight / 2;
    groups.forEach((group) => {
      const geometry = geometryFromFaces(floorFaces(group.cells, halfWidth, halfHeight));
      const mesh = new THREE.Mesh(geometry, renderMaterial(group.color));
      mesh.receiveShadow = true;
      this.content.add(mesh);
    });
  }

  addCubeGroups(groups, occupied) {
    const halfWidth = this.totalWidth / 2;
    const halfHeight = this.totalHeight / 2;
    groups.forEach((group) => {
      const faces = voxelFaces(group.voxels, occupied, halfWidth, halfHeight);
      if (!faces.length) return;
      const geometry = geometryFromFaces(faces);
      const mesh = new THREE.Mesh(geometry, renderMaterial(group.color));
      mesh.receiveShadow = true;
      this.content.add(mesh);
      const edges = new THREE.LineSegments(edgeGeometryFromFaces(faces), edgeMaterial());
      edges.renderOrder = 10;
      this.content.add(edges);
    });
  }

  addEditorGrid(cells) {
    if (this.mode !== "editor") return;
    const positions = [];
    const seen = new Set();
    const add = (from, to, y) => {
      const key = `${y}:${[from.join(","), to.join(",")].sort().join(":")}`;
      if (seen.has(key)) return;
      seen.add(key);
      positions.push(
        from[0] - this.totalWidth / 2, y + 0.006, from[1] - this.totalHeight / 2,
        to[0] - this.totalWidth / 2, y + 0.006, to[1] - this.totalHeight / 2
      );
    };
    cells.forEach((cell) => {
      add([cell.x, cell.z], [cell.x + 1, cell.z], cell.top);
      add([cell.x + 1, cell.z], [cell.x + 1, cell.z + 1], cell.top);
      add([cell.x + 1, cell.z + 1], [cell.x, cell.z + 1], cell.top);
      add([cell.x, cell.z + 1], [cell.x, cell.z], cell.top);
    });
    if (!positions.length) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    this.content.add(new THREE.LineSegments(geometry, edgeMaterial(0x715c3d, 0.34)));
  }

  addEditorPickMesh(metadata) {
    if (this.mode !== "editor" || !metadata.length) return;
    const geometry = cachedGeometry("editor-pick-box", () => new THREE.BoxGeometry(1, 1, 1));
    const pickMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      colorWrite: false,
      depthWrite: false,
      opacity: 0,
      transparent: true
    });
    const mesh = new THREE.InstancedMesh(geometry, pickMaterial, metadata.length);
    mesh.userData.transientMaterial = true;
    const dummy = new THREE.Object3D();
    metadata.forEach((record, index) => {
      const bottom = -FLOOR_DROP - FLOOR_THICKNESS;
      const top = Math.max(0.02, this.cellTops.get(`${record.x},${record.z}`) ?? 0.02);
      dummy.position.set(
        record.x - this.totalWidth / 2 + 0.5,
        (bottom + top) / 2,
        record.z - this.totalHeight / 2 + 0.5
      );
      dummy.scale.set(1, top - bottom, 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.userData.instances = metadata;
    this.content.add(mesh);
    this.pickMeshes.push(mesh);
  }

  rebuild() {
    disposeGeneratedChildren(this.content);
    this.pickMeshes = [];
    const data = this.collectScene();
    const dimensions = { totalWidth: this.totalWidth, totalHeight: this.totalHeight };
    this.addFloorGroups(data.floorGroups);
    this.addCubeGroups(data.cubeGroups, data.occupied);
    data.terrainAssets.forEach((record) => addTerrainAsset(this.content, record, dimensions));
    data.gems.forEach((record) => addGemAsset(this.content, record, dimensions));
    data.specialPieces.forEach((record) => addSpecialPiece(this.content, record, dimensions));
    this.addEditorGrid(data.editorGridCells);
    this.addEditorPickMesh(data.cellMetadata);
    this.render();
    return data.modelUrls;
  }

  resize() {
    const width = Math.max(1, this.canvas.clientWidth);
    const height = Math.max(1, this.canvas.clientHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.render();
  }

  fitDistance() {
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const vertical = (this.totalHeight / 2) / Math.tan(fov / 2);
    const horizontal = (this.totalWidth / 2) / (Math.tan(fov / 2) * Math.max(this.camera.aspect, 0.1));
    return Math.max(vertical, horizontal, Math.max(this.totalWidth, this.totalHeight) * 1.15) * 1.18;
  }

  updateCamera() {
    const horizontal = Math.cos(this.pitch) * this.distance;
    this.camera.position.set(
      this.target.x + Math.sin(this.yaw) * horizontal,
      this.target.y + Math.sin(this.pitch) * this.distance,
      this.target.z + Math.cos(this.yaw) * horizontal
    );
    this.camera.lookAt(this.target);
    this.canvas.dataset.cameraHeading = String(this.heading * 90);
    this.canvas.dataset.cameraPitch = String(Math.round(THREE.MathUtils.radToDeg(this.pitch)));
    this.content.traverse((object) => {
      if (object.userData.liftMarker) object.rotation.y = this.yaw;
    });
  }

  render() {
    this.updateCamera();
    this.renderer.render(this.scene, this.camera);
  }

  zoomBy(factor) {
    const limits = this.mode === "world" ? [22, 1000] : [7, 110];
    this.distance = Math.max(limits[0], Math.min(limits[1], this.distance * factor));
    this.render();
  }

  resetView() {
    this.target.set(0, this.mode === "world" ? 1.5 : 1.2, 0);
    this.heading = DEFAULT_HEADING;
    this.yaw = this.heading * CARDINAL_STEP;
    this.pitch = DEFAULT_PITCH;
    this.distance = this.fitDistance();
    this.render();
  }

  focusRoom(room) {
    if (!room || this.mode !== "world") return;
    this.target.set(
      room.columnIndex * this.world.roomWidth - this.totalWidth / 2 + this.world.roomWidth / 2,
      1.5,
      room.rowIndex * this.world.roomHeight - this.totalHeight / 2 + this.world.roomHeight / 2
    );
    this.distance = 33;
    this.render();
  }

  hitTest(event) {
    const bounds = this.canvas.getBoundingClientRect();
    this.mouse.set(
      ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
      -((event.clientY - bounds.top) / bounds.height) * 2 + 1
    );
    this.raycaster.setFromCamera(this.mouse, this.camera);
    if (this.mode === "editor") {
      const intersections = this.raycaster.intersectObjects(this.pickMeshes, false);
      const intersection = intersections.find((entry) => Number.isInteger(entry.instanceId));
      const metadata = intersection?.object?.userData?.instances?.[intersection.instanceId];
      if (metadata) return metadata;
    }
    const point = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.groundPlane, point)) return null;
    const globalX = Math.floor(point.x + this.totalWidth / 2);
    const globalY = Math.floor(point.z + this.totalHeight / 2);
    if (globalX < 0 || globalY < 0 || globalX >= this.totalWidth || globalY >= this.totalHeight) return null;
    const columnIndex = this.mode === "editor" ? 0 : Math.floor(globalX / this.world.roomWidth);
    const rowIndex = this.mode === "editor" ? 0 : Math.floor(globalY / this.world.roomHeight);
    const room = this.world.rooms.find((candidate) =>
      candidate.columnIndex === columnIndex && candidate.rowIndex === rowIndex);
    if (!room) return null;
    const cellX = globalX % this.world.roomWidth;
    const cellY = globalY % this.world.roomHeight;
    return { room, cellX, cellY, cell: room.cells[cellY]?.[cellX] ?? "" };
  }

  selectRoom(room) {
    this.setSelection(room ? { room } : null);
  }

  selectCell(room, cellX, cellY) {
    this.setSelection({ room, cellX, cellY });
  }

  setSelection(selection) {
    if (this.selection) {
      this.scene.remove(this.selection);
      this.selection.geometry.dispose();
      this.selection.material.dispose();
      this.selection = null;
    }
    if (!selection?.room) return this.render();
    const isCell = Number.isInteger(selection.cellX) && Number.isInteger(selection.cellY);
    const width = isCell ? 1 : this.world.roomWidth;
    const depth = isCell ? 1 : this.world.roomHeight;
    const baseX = selection.room.columnIndex * this.world.roomWidth - this.totalWidth / 2;
    const baseZ = selection.room.rowIndex * this.world.roomHeight - this.totalHeight / 2;
    const geometry = new THREE.BoxGeometry(width, 0.04, depth);
    const selectionMaterial = new THREE.MeshBasicMaterial({ color: MAZE_COLORS.gem, wireframe: true });
    this.selection = new THREE.Mesh(geometry, selectionMaterial);
    const globalX = selection.room.columnIndex * this.world.roomWidth + (selection.cellX || 0);
    const globalZ = selection.room.rowIndex * this.world.roomHeight + (selection.cellY || 0);
    const top = isCell ? Math.max(0.02, this.cellTops.get(`${globalX},${globalZ}`) ?? 0.02) : 0.02;
    this.selection.position.set(
      baseX + (isCell ? selection.cellX + 0.5 : width / 2),
      top + 0.025,
      baseZ + (isCell ? selection.cellY + 0.5 : depth / 2)
    );
    this.scene.add(this.selection);
    this.render();
  }
}
