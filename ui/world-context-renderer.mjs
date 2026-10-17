// Browser-only cached full-world renderer for Play and the editor. Keep the historical v1 renderer
// unchanged: its bytes are included in signed benchmark runtime manifests.
import * as THREE from "../render/vendor/three.module.min.js";
import { NumberedMazeRenderer } from "./numbered-maze-renderer.mjs";
import { BackgroundTruncation } from "./background-truncation.mjs";
import { prepareBrowserModels } from "./browser-world.mjs";
import { cutawayMaxHeight } from "../render/v1/cutaway.mjs";
import { clearPlacementPreview } from "../render/v1/placement-preview-v2.mjs";
import { playRoomCenter } from "./play-world-context.mjs";

export class WorldContextRenderer extends NumberedMazeRenderer {
  // The base constructor calls these overrides, so initialize caches lazily.
  setWorld(world, options = {}) {
    this.renderSuspended = (this.renderSuspended || 0) + 1;
    try {
      const previousCenter = this.world && playRoomCenter(this.world);
      const center = playRoomCenter(world);
      if (previousCenter && options.preserveCamera) {
        const dx = center.x - previousCenter.x;
        const dz = center.z - previousCenter.z;
        this.target.x += dx;
        this.target.z += dz;
        const animation = this.cameraMotion.centerAnimation;
        if (animation) {
          animation.startX += dx;
          animation.targetX += dx;
          animation.startZ += dz;
          animation.targetZ += dz;
        }
      }
      clearPlacementPreview(this.placementPreview);
      this.canvas.dataset.placementPreview = "";
      this.world = world;
      this.roomHeights ||= new WeakMap();
      this.backgroundMaxHeight = 1;
      for (const room of world.contextRooms) {
        if (!this.roomHeights.has(room)) this.roomHeights.set(room, cutawayMaxHeight({ ...world, rooms: [room] }));
        this.backgroundMaxHeight = Math.max(this.backgroundMaxHeight, this.roomHeights.get(room));
      }
      const active = world.rooms.find(room => !room.renderDimmed);
      this.cutawayMaxHeight = Math.max(this.backgroundMaxHeight,
        cutawayMaxHeight({ ...world, rooms: [active] }));
      this.totalWidth = world.columns.length * world.roomWidth;
      this.totalHeight = world.rows.length * world.roomHeight;
      this.canvas.dataset.contextRoomCount = String(world.rooms.length - 1);
      this.canvas.dataset.activeRoom = world.contextActiveRoom.fileName;
      this.configureShadows();
      this.setSelection(null);
      this.requestModels(this.rebuild());
      if (!options.preserveCamera) this.resetView();
      this.onCutawayChange?.();
    } finally {
      this.renderSuspended--;
    }
    this.render();
  }

  get cutawayHeight() {
    return this.sceneCutawayHeight !== undefined ? this.sceneCutawayHeight : super.cutawayHeight;
  }

  setCutaway(settings) {
    // Clearing the selection and rebuilding both request a render in the base
    // renderer. Present the finished update once, especially at world zoom.
    this.renderSuspended = (this.renderSuspended || 0) + 1;
    try { super.setCutaway(settings); }
    finally { this.renderSuspended--; }
    this.render();
  }

  clearBackground() {
    this.backgroundJob?.resolve(false);
    this.backgroundJob = null;
    for (const entry of this.roomBackgrounds?.values() || []) this.backgroundTruncation?.disposeEntry(entry);
    this.backgroundTruncation?.dispose();
    this.backgroundTruncation = new BackgroundTruncation();
    this.roomBackgrounds = new Map();
    this.backgroundRoot?.clear();
    this.backgroundMarkers = [];
  }

  rebuild() {
    if (!this.backgroundRoot) {
      this.backgroundRoot = new THREE.Group();
      this.backgroundRoot.matrixAutoUpdate = false;
      this.scene.matrixAutoUpdate = false;
      this.scene.add(this.backgroundRoot);
    }
    const world = this.world;
    const content = this.content;
    const cutawayContent = this.cutawayContent;
    const height = this.cutawayHeight;
    if (this.backgroundSource !== world.contextRooms) {
      this.clearBackground();
      this.backgroundSource = world.contextRooms;
    }
    this.renderer.localClippingEnabled = true;
    const urls = new Set();
    this.renderSuspended = (this.renderSuspended || 0) + 1;
    const previousPicking = this.pickVoxels;
    try {
      const cutChanged = this.backgroundTruncation.set(height, this.cutaway.opacity);
      let backgroundChanged = cutChanged;
      for (const room of world.contextRooms) {
        let entry = this.roomBackgrounds.get(room.fileName);
        const active = room.fileName === world.contextActiveRoom.fileName;
        let prepared = false;
        // Edited active rooms rebuild their small foreground immediately. Their
        // hidden background snapshot only needs refreshing when we leave.
        if (entry && entry.room !== room && !active) {
          entry = this.buildBackground(room);
          prepared = true;
          backgroundChanged = true;
        }
        if (!entry) continue; // Initial background construction is spread across frames.
        entry.root.visible = !active;
        if (prepared || cutChanged) this.backgroundTruncation.update(entry);
        entry.modelUrls.forEach(url => urls.add(url));
      }
      if (backgroundChanged) {
        this.backgroundMarkers = [];
        this.backgroundRoot.traverse(object => {
          if (object.userData.liftMarker) this.backgroundMarkers.push(object);
        });
      }
      this.content = content;
      this.cutawayContent = cutawayContent;
      this.world = { ...world, rooms: world.rooms.filter(room => !room.renderDimmed) };
      this.sceneCutawayHeight = height;
      this.pickVoxels = previousPicking;
      super.rebuild().forEach(url => urls.add(url));
      this.canvas.dataset.cachedRoomCount = String(this.roomBackgrounds.size);
    } finally {
      this.world = world;
      this.content = content;
      this.cutawayContent = cutawayContent;
      this.sceneCutawayHeight = undefined;
      this.pickVoxels = previousPicking;
      this.renderSuspended--;
    }
    this.queueBackgrounds();
    this.render();
    return urls;
  }

  buildBackground(room) {
    const previous = {
      world: this.world, content: this.content, cutawayContent: this.cutawayContent,
      sceneCutawayHeight: this.sceneCutawayHeight, pickVoxels: this.pickVoxels,
      pickMeshes: this.pickMeshes, cellTops: this.cellTops
    };
    const dataset = { ...this.canvas.dataset };
    const shadowUpdate = this.renderer.shadowMap.needsUpdate;
    const old = this.roomBackgrounds.get(room.fileName);
    if (old) this.backgroundTruncation.disposeEntry(old);
    const entry = { room, root: new THREE.Group(), content: new THREE.Group(), cutawayContent: new THREE.Group() };
    entry.root.add(entry.content, entry.cutawayContent);
    this.renderSuspended = (this.renderSuspended || 0) + 1;
    try {
      this.world = { ...previous.world, rooms: [room] };
      this.content = entry.content;
      this.cutawayContent = entry.cutawayContent;
      this.sceneCutawayHeight = null;
      this.pickVoxels = false;
      entry.modelUrls = super.rebuild();
      entry.root.traverse(object => {
        object.layers.set(0);
        object.castShadow = false;
        object.receiveShadow = false;
      });
      this.backgroundTruncation.prepare(entry, this.world, { totalWidth: this.totalWidth, totalHeight: this.totalHeight });
      this.backgroundTruncation.update(entry);
      entry.root.updateMatrixWorld(true);
      entry.root.traverse(object => { object.matrixAutoUpdate = Boolean(object.userData.liftMarker); });
      entry.root.visible = room.fileName !== previous.world.contextActiveRoom.fileName;
      this.roomBackgrounds.set(room.fileName, entry);
      this.backgroundRoot.add(entry.root);
    } finally {
      Object.assign(this, previous);
      Object.assign(this.canvas.dataset, dataset);
      this.renderer.shadowMap.needsUpdate = shadowUpdate;
      this.renderSuspended--;
    }
    return entry;
  }

  queueBackgrounds() {
    const active = this.world.contextActiveRoom;
    const distance = room => Math.max(Math.abs(room.columnIndex - active.columnIndex), Math.abs(room.rowIndex - active.rowIndex));
    const rooms = this.world.contextRooms.filter(room => !this.roomBackgrounds.has(room.fileName))
      .sort((a, b) => distance(a) - distance(b));
    if (this.backgroundJob) {
      this.backgroundJob.rooms = rooms;
      return;
    }
    if (!rooms.length) return;
    const job = { rooms };
    this.backgroundReady = new Promise(resolve => { job.resolve = resolve; });
    this.backgroundJob = job;
    const schedule = globalThis.requestAnimationFrame || (callback => setTimeout(callback, 0));
    const step = () => {
      if (this.backgroundJob !== job) return;
      const start = performance.now(), urls = new Set();
      do {
        const room = job.rooms.shift();
        if (room) this.buildBackground(room).modelUrls.forEach(url => urls.add(url));
      } while (job.rooms.length && performance.now() - start < 6);
      this.backgroundMarkers = [];
      this.backgroundRoot.traverse(object => {
        if (object.userData.liftMarker) this.backgroundMarkers.push(object);
      });
      this.canvas.dataset.cachedRoomCount = String(this.roomBackgrounds.size);
      this.requestModels(urls);
      this.render();
      if (job.rooms.length) schedule(step);
      else {
        this.backgroundJob = null;
        job.resolve(true);
      }
    };
    schedule(step);
  }

  requestModels(urls) {
    this.requestedModels ||= new Set();
    const pending = [...urls].filter(url => !this.requestedModels.has(url));
    if (!pending.length) return;
    pending.forEach(url => this.requestedModels.add(url));
    prepareBrowserModels(pending).then(changed => {
      if (!changed) return;
      // Normally preloaded before startup. New authored model URLs can still
      // replace their fallbacks without blocking on a synchronous world build.
      this.clearBackground();
      this.rebuild();
    });
  }

  configureShadows() {
    if (!this.keyLight?.castShadow) return;
    const center = playRoomCenter(this.world);
    this.keyLight.position.set(center.x + 5, 18, center.z - 5);
    this.keyLight.target.position.set(center.x, 0, center.z);
    const span = Math.max(this.world.roomWidth, this.world.roomHeight) * 1.5;
    const camera = this.keyLight.shadow.camera;
    Object.assign(camera, { left: -span, right: span, top: span, bottom: -span, near: 1, far: span * 3 });
    camera.updateProjectionMatrix();
  }

  updateCamera() {
    super.updateCamera();
    for (const marker of this.backgroundMarkers || []) marker.rotation.y = this.yaw;
  }

  renderThickOutlines() {
    if (!this.backgroundRoot) return super.renderThickOutlines();
    this.backgroundRoot.visible = false;
    try { super.renderThickOutlines(); }
    finally { this.backgroundRoot.visible = true; }
  }

  render() {
    if (!this.renderSuspended) super.render();
  }

  zoomLimits() { return [7, 1000]; }

  centerBoard() {
    super.centerBoard();
    const center = playRoomCenter(this.world);
    this.cameraMotion.centerAnimation.targetX = center.x;
    this.cameraMotion.centerAnimation.targetZ = center.z;
  }

  resetView() {
    this.renderSuspended = (this.renderSuspended || 0) + 1;
    try {
      super.resetView();
      const center = playRoomCenter(this.world);
      this.target.x = center.x;
      this.target.z = center.z;
    } finally { this.renderSuspended--; }
    this.render();
  }
}
