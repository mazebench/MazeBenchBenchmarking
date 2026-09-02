// Camera motion values and easing copied from MazeBenchEngineUnitTest's
// MazeBenchCanvas so renderer v1 has the same keyboard feel without React.

export const CAMERA_TILT_MAX_SPEED = Math.PI * 0.72;
export const CAMERA_TILT_ACCEL = Math.PI * 3.4;
export const CAMERA_TILT_DECEL = Math.PI * 4.2;
export const CAMERA_YAW_DURATION_MS = 400;
export const CAMERA_ZOOM_DURATION_MS = 320;
export const CAMERA_MIN_ABOVE_PITCH = 0.18;
export const CAMERA_MAX_PITCH = 1.48;

export function clampCameraPitch(pitch, allowUnder = false) {
  const minimum = allowUnder ? -CAMERA_MAX_PITCH : CAMERA_MIN_ABOVE_PITCH;
  return Math.max(minimum, Math.min(CAMERA_MAX_PITCH, pitch));
}

export function easeInOutQuad(progress) {
  const value = Math.max(0, Math.min(1, progress));
  return value < 0.5
    ? 2 * value * value
    : 1 - Math.pow(-2 * value + 2, 2) / 2;
}

export function easeToward(current, target, maxDelta) {
  if (current < target) return Math.min(target, current + maxDelta);
  if (current > target) return Math.max(target, current - maxDelta);
  return current;
}

export function yawTransitionAt(animation, now) {
  const progress = Math.min(1, (now - animation.startMs) / CAMERA_YAW_DURATION_MS);
  return {
    complete: progress >= 1,
    yaw: animation.startYaw +
      (animation.targetYaw - animation.startYaw) * easeInOutQuad(progress)
  };
}

export function zoomTransitionAt(animation, now) {
  const progress = Math.min(1, (now - animation.startMs) / CAMERA_ZOOM_DURATION_MS);
  if (progress >= 1) return { complete: true, distance: animation.targetDistance };
  const eased = easeInOutQuad(progress);
  const start = Math.max(0.001, animation.startDistance);
  const target = Math.max(0.001, animation.targetDistance);
  return {
    complete: false,
    distance: Math.exp(Math.log(start) + (Math.log(target) - Math.log(start)) * eased)
  };
}
