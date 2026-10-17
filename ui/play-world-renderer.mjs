import { WorldContextRenderer } from "./world-context-renderer.mjs";
import { createCommandTimeline, ROOM_TRANSITION_MS, sampleSegments } from "../animations/v1/timeline.mjs";
import { playTimeline } from "../animations/v1/player.mjs";
import { CAMERA_CENTER_DURATION_MS } from "../render/v1/camera-transitions.mjs";
import { CommandAnimationScene } from "../animations/v1/scene.mjs";
import { addAnimatedGem, collectAnimatedGems, updateAnimatedGems } from "../animations/v1/gems.mjs";

export class PlayWorldRenderer extends WorldContextRenderer {
  constructor(canvas, world, options) {
    super(canvas, world, options);
    this.gemMotionPreference = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)");
    this.gemMotionPreference?.addEventListener("change", () => this.render());
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) this.render();
    });
  }

  addGemAsset(content, record, dimensions) {
    addAnimatedGem(content, record, dimensions);
  }

  buildBackground(room) {
    const entry = super.buildBackground(room);
    entry.gems = collectAnimatedGems(entry.content);
    return entry;
  }

  rebuild() {
    this.renderSuspended = (this.renderSuspended || 0) + 1;
    let urls;
    try {
      urls = super.rebuild();
      this.gems = collectAnimatedGems(this.content, this.cutawayContent);
    } finally { this.renderSuspended--; }
    this.render();
    return urls;
  }

  setGemMotionEnabled(enabled) {
    this.gemMotionEnabled = enabled;
    this.render();
  }

  render() {
    if (this.renderSuspended) return;
    super.render();
    // Reuse the camera's display loop. Command tweens already draw each frame.
    if (this.gemMotionEnabled && !this.gemMotionPreference?.matches &&
        !globalThis.document?.hidden && !this.commandAnimation) this.scheduleCameraFrame();
  }

  setWorld(world, options = {}) {
    const changeRoom = options.animateCamera && options.preserveCamera && !options.preserveCameraPosition &&
      this.world?.contextActiveRoom.fileName !== world.contextActiveRoom.fileName &&
      !globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (!changeRoom || !this.target) return super.setWorld(world, options);
    const startX = this.target.x, startZ = this.target.z;
    this.renderSuspended = (this.renderSuspended || 0) + 1;
    try {
      super.setWorld(world, { ...options, preserveRoomLighting: true });
      this.roomLighting?.select(world.contextActiveRoom, ROOM_TRANSITION_MS);
      const pending = this.cameraMotion.centerAnimation;
      this.cameraMotion.centerAnimation = {
        startMs: performance.now(), roomStartMs: performance.now(), startX, startZ,
        targetX: pending?.targetX ?? this.target.x,
        targetZ: pending?.targetZ ?? this.target.z
      };
      this.target.x = startX;
      this.target.z = startZ;
    } finally { this.renderSuspended--; }
    this.scheduleCameraFrame();
    this.render();
  }

  runCameraFrame(now) {
    const animation = this.cameraMotion.centerAnimation;
    if (animation?.roomStartMs !== undefined) {
      // The signed base camera retains its historical duration. Adapt only
      // human room transitions to the shorter presentation clock.
      animation.startMs = now - (now - animation.roomStartMs) * CAMERA_CENTER_DURATION_MS / ROOM_TRANSITION_MS;
    }
    super.runCameraFrame(now);
  }

  finishRoomTransition() {
    const pending = this.cameraMotion.centerAnimation;
    if (pending?.roomStartMs !== undefined) {
      this.target.x = pending.targetX;
      this.target.z = pending.targetZ;
      this.cameraMotion.centerAnimation = null;
    }
    this.roomLighting?.select(this.world.contextActiveRoom);
    this.render();
  }

  async animateCommand(command, { finish = () => false } = {}) {
    if (command.signal?.aborted) return false;
    if (globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return {};
    const timeline = createCommandTimeline({ ...command, definitions: this.world.blockDefinitions });
    if (!timeline.duration) return {};
    if (timeline.camera.length) {
      const pending = this.cameraMotion.centerAnimation;
      if (pending) {
        const remaining = [pending.targetX - this.target.x, pending.targetZ - this.target.z];
        timeline.camera.forEach((segment, index) => {
          segment.to = segment.to.map((value, axis) => value + remaining[axis]);
          segment.from = sampleSegments(timeline.camera.slice(0, index), [0, 0], segment.start, { alwaysEase: true });
        });
      }
      this.cameraMotion.centerAnimation = null;
    }
    const scene = new CommandAnimationScene(this, timeline);
    this.commandAnimation = scene;
    let disposed = false;
    const cleanup = restoreCamera => {
      if (disposed) return;
      disposed = true;
      scene.dispose({ restoreCamera });
      if (this.commandAnimation === scene) this.commandAnimation = null;
    };
    const abort = () => cleanup(true);
    command.signal?.addEventListener("abort", abort, { once: true });
    let complete = false;
    try {
      complete = await playTimeline(timeline, time => {
        scene.update(time);
        this.render();
      }, { signal: command.signal, finish });
      return complete ? { preserveCameraPosition: !command.simulation.cycle } : false;
    } finally {
      command.signal?.removeEventListener("abort", abort);
      cleanup(!complete || Boolean(command.simulation.cycle));
    }
  }

  updateCamera() {
    const now = performance.now();
    const enabled = Boolean(this.gemMotionEnabled && !this.gemMotionPreference?.matches);
    updateAnimatedGems(this.gems, now, enabled);
    for (const entry of this.roomBackgrounds?.values() || []) {
      // Ghosts are created lazily when upper-tile visibility first becomes nonzero.
      const ghost = entry.cutawayContent.children[0];
      if (entry.gemGhost !== ghost) {
        entry.gemGhost = ghost;
        entry.ghostGems = collectAnimatedGems(ghost);
      }
      updateAnimatedGems(entry.gems, now, enabled);
      updateAnimatedGems(entry.ghostGems, now, enabled);
    }
    updateAnimatedGems(this.commandAnimation?.gems, now, enabled);
    if (this.renderer.shadowMap.enabled && (this.gems?.length || this.commandAnimation?.gems.length)) {
      this.renderer.shadowMap.needsUpdate = true;
    }
    super.updateCamera();
    this.commandAnimation?.beforeRender();
  }

  setGamepadCameraInput({ tilt = 0, zoom = 0 }) {
    if (this.gamepadTilt === tilt && this.gamepadZoom === zoom) return;
    this.gamepadTilt = tilt;
    this.gamepadZoom = zoom;
    if (zoom) this.cameraMotion.zoomAnimation = null;
    this.recomputeContinuousDirections();
  }

  recomputeContinuousDirections() {
    super.recomputeContinuousDirections();
    const motion = this.cameraMotion;
    // Combine independent input sources so releasing a trigger cannot release a key.
    motion.tiltDirection = Math.max(-1, Math.min(1, motion.tiltDirection + (this.gamepadTilt || 0)));
    motion.zoomDirection = Math.max(-1, Math.min(1, motion.zoomDirection + (this.gamepadZoom || 0)));
    if (motion.tiltDirection || motion.zoomDirection) this.scheduleCameraFrame();
  }

  cancelCameraMotion() {
    this.gamepadTilt = this.gamepadZoom = 0;
    super.cancelCameraMotion();
  }
}
