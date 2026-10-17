import { WorldContextRenderer } from "./world-context-renderer.mjs";

export class PlayWorldRenderer extends WorldContextRenderer {
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
