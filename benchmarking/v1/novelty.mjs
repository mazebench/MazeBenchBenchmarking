import { createHash } from "node:crypto";
import { engineRoleIdForObject, writeEngineStateV1 } from "../../engine/v1/adapter.mjs";

export const NOVELTY_VERSION = 1;

// Analytics identity is intentionally separate from the complete game-state
// hash and signed checkpoint. Gem objects, global collection progress, camera,
// and object-array order do not distinguish board configurations.
export function noveltyStateHash(roomFile, state, definitions) {
  const buffer = new Int32Array(state.objects.length * 5);
  writeEngineStateV1(state, definitions, () => 0, buffer, 5);
  const objects = [];
  for (const [index, object] of state.objects.entries()) {
    const role = engineRoleIdForObject(object, definitions);
    if (role === "goal") continue;
    const offset = index * 5;
    objects.push(JSON.stringify([
      object.blockId, role, buffer[offset], buffer[offset + 1],
      buffer[offset + 2], buffer[offset + 4]
    ]));
  }
  objects.sort();
  return createHash("sha256").update(JSON.stringify({ roomFile, width: state.width, height: state.height, objects })).digest("hex");
}
