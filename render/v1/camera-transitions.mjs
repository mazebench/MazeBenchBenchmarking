// Camera motion values and easing copied from MazeBenchEngineUnitTest's
// MazeBenchCanvas so renderer v1 has the same keyboard feel without React.

export const CAMERA_TILT_MAX_SPEED = Math.PI * 0.72;
export const CAMERA_TILT_ACCEL = Math.PI * 3.4;
export const CAMERA_TILT_DECEL = Math.PI * 4.2;
export const CAMERA_YAW_DURATION_MS = 400;

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
