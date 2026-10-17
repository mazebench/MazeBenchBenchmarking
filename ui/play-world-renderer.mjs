// Browser-only full-world Play renderer. Keep the historical v1 renderer
// unchanged: its bytes are included in signed benchmark runtime manifests.
import * as THREE from "../render/vendor/three.module.min.js";
import { JoinedMazeRenderer } from "./joined-maze-renderer.mjs";
import { loadAssetModels } from "../render/v1/asset-renderers.mjs";
import { cutawayMaxHeight } from "../render/v1/cutaway.mjs";
import { clearPlacementPreview } from "../render/v1/placement-preview-v2.mjs";
import { disposeGeneratedChildren } from "../render/v1/polycube-mesh.mjs";
import { playRoomCenter } from "./play-world-context.mjs";

export class PlayWorldRenderer extends JoinedMazeRenderer {
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
      if (this.heightSource !== world.contextRooms) {
        this.heightSource = world.contextRooms;
        this.backgroundMaxHeight = cutawayMaxHeight({ ...world, rooms: world.contextRooms });
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

  clearBackground() {
    for (const entry of this.roomBackgrounds?.values() || []) {
      disposeGeneratedChildren(entry.content);
      disposeGeneratedChildren(entry.cutawayContent);
    }
    this.roomBackgrounds = new Map();
    this.backgroundRoot?.clear();
    this.backgroundMarkers = [];
  }

  rebuild() {
    if (!this.backgroundRoot) {
      this.backgroundRoot = new THREE.Group();
      this.scene.add(this.backgroundRoot);
    }
    const world = this.world;
    const content = this.content;
    const cutawayContent = this.cutawayContent;
    const height = this.cutawayHeight;
    const key = `${height}:${height === null ? 0 : this.cutaway.opacity}`;
    if (this.backgroundSource !== world.contextRooms || this.backgroundCutawayKey !== key) {
      this.clearBackground();
      this.backgroundSource = world.contextRooms;
      this.backgroundCutawayKey = key;
    }
    const urls = new Set();
    this.renderSuspended = (this.renderSuspended || 0) + 1;
    this.sceneCutawayHeight = height;
    try {
      for (const room of world.contextRooms) {
        let entry = this.roomBackgrounds.get(room.fileName);
        if (!entry) {
          entry = { root: new THREE.Group(), content: new THREE.Group(), cutawayContent: new THREE.Group() };
          entry.root.add(entry.content, entry.cutawayContent);
          this.world = { ...world, rooms: [room] };
          this.content = entry.content;
          this.cutawayContent = entry.cutawayContent;
          entry.modelUrls = super.rebuild();
          entry.root.traverse(object => {
            // Backgrounds draw once; reserve shadows and thick outlines for
            // the live room, even when the whole map is in the camera frustum.
            object.layers.set(0);
            object.castShadow = false;
            object.receiveShadow = false;
            if (object.userData.liftMarker) this.backgroundMarkers.push(object);
          });
          this.roomBackgrounds.set(room.fileName, entry);
          this.backgroundRoot.add(entry.root);
        }
        entry.root.visible = room.fileName !== world.contextActiveRoom.fileName;
        entry.modelUrls.forEach(url => urls.add(url));
      }
      this.content = content;
      this.cutawayContent = cutawayContent;
      this.world = { ...world, rooms: world.rooms.filter(room => !room.renderDimmed) };
      super.rebuild().forEach(url => urls.add(url));
      this.canvas.dataset.cachedRoomCount = String(this.roomBackgrounds.size);
    } finally {
      this.world = world;
      this.content = content;
      this.cutawayContent = cutawayContent;
      this.sceneCutawayHeight = undefined;
      this.renderSuspended--;
    }
    this.render();
    return urls;
  }

  requestModels(urls) {
    this.requestedModels ||= new Set();
    const pending = [...urls].filter(url => !this.requestedModels.has(url));
    if (!pending.length) return;
    pending.forEach(url => this.requestedModels.add(url));
    loadAssetModels(pending).then(() => {
      // Replace fallback geometry once after models load, never each tick.
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
