import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = new URL("../../MazeBenchEngineUnitTest/apps/web/public/mazebench-runtime/joined-voxel-surface.mjs", import.meta.url);
test("browser surface and mounted-label kernel matches the canonical UnitTesting renderer", async t => {
  let canonical;
  try { canonical = await readFile(source); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    t.skip("Sibling UnitTesting checkout is unavailable; use scripts/sync-rendering.mjs --check --source PATH.");
    return;
  }
  assert.deepEqual(await readFile(new URL("../ui/joined-voxel-surface.mjs", import.meta.url)), canonical,
    "Run node scripts/sync-rendering.mjs after updating the shared renderer kernel.");
});
