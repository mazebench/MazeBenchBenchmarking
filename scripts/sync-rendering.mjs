#!/usr/bin/env node
// Browser geometry only. This deliberately does not invoke the engine sync.
import { readFile, copyFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let source = resolve(root, "../MazeBenchEngineUnitTest");
let check = false;
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === "--check") check = true;
  else if (arg === "--source" && process.argv[i + 1]) source = resolve(process.argv[++i]);
  else throw new Error(`Unknown or incomplete argument: ${arg}`);
}
const upstream = resolve(source, "apps/web/public/mazebench-runtime/joined-voxel-surface.mjs");
const target = resolve(root, "ui/joined-voxel-surface.mjs");
if (check) {
  const [a, b] = await Promise.all([readFile(upstream), readFile(target)]);
  if (!a.equals(b)) throw new Error("Rendering kernel drift: run node scripts/sync-rendering.mjs and the rendering tests.");
  console.log("Shared rendering kernel matches UnitTesting byte-for-byte.");
} else {
  await copyFile(upstream, target);
  console.log("Updated shared rendering kernel from UnitTesting. Run the rendering tests before using it.");
}
