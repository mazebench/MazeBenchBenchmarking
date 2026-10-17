import { WorldContextRenderer } from "./world-context-renderer.mjs";
import { createCommandTimeline, ROOM_TRANSITION_MS, sampleSegments } from "../animations/v1/timeline.mjs";
import { playTimeline } from "../animations/v1/player.mjs";
import { CAMERA_CENTER_DURATION_MS } from "../render/v1/camera-transitions.mjs";
import { CommandAnimationScene } from "../animations/v1/scene.mjs";

export class PlayWorldRenderer extends WorldContextRenderer {
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
