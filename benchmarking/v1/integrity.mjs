import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, readSync } from "node:fs";
import { readdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { safeDirectory, safeOpenFile, safeReadFile } from "./safe-files.mjs";

export const CAPABILITY_POLICY_VERSION = 4;
export const CAPABILITY_POLICY_NAME = "os-isolated-v4";
const RUNTIME_ROOTS = ["benchmarking/v1", "engine/v1", "play/v1", "render/v1", "render-ascii/v1", "level-data/v2/main-world"];
const digest = value => createHash("sha256").update(value).digest("hex");

async function runtimeFiles(projectRoot) {
  const files = [];
  async function walk(relative) {
    for (const entry of await readdir(path.join(projectRoot, relative), { withFileTypes: true })) {
      const name = `${relative}/${entry.name}`;
      if (name === "engine/v1/core") continue; // compiled WASM is authoritative at runtime
      if (entry.isSymbolicLink()) throw new Error(`Runtime assets cannot be symbolic links: ${name}`);
      if (entry.isDirectory()) await walk(name);
      else if (/\.(mjs|wasm|json|py)$/.test(entry.name) || name.endsWith("/EVAL-PROMPT.md")) files.push(name);
    }
  }
  for (const root of RUNTIME_ROOTS) await walk(root);
  return files.sort();
}

export async function createRunIntegrity(projectRoot, runDirectory, configuration) {
  const files = await runtimeFiles(projectRoot);
  const hashes = Object.fromEntries(await Promise.all(files.map(async file => [file, digest(await readFile(path.join(projectRoot, file)))])));
  const manifest = { version: CAPABILITY_POLICY_VERSION, configuration, files: hashes };
  const encoded = `${JSON.stringify(manifest)}\n`;
  safeDirectory(runDirectory, "sandbox-state", { create: true });
  await writeFile(path.join(runDirectory, "sandbox-state", "integrity-key"), randomBytes(32), { flag: "wx", mode: 0o600 });
  await writeFile(path.join(runDirectory, "integrity.json"), encoded, { flag: "wx", mode: 0o600 });
  return { version: CAPABILITY_POLICY_VERSION, manifest_sha256: digest(encoded), asset_count: files.length };
}

export async function verifyRunIntegrity(projectRoot, runDirectory, expected = null) {
  const encoded = safeReadFile(runDirectory, "integrity.json");
  if (expected?.manifest_sha256 && digest(encoded) !== expected.manifest_sha256) throw new Error("Run integrity manifest changed; refusing execution.");
  const manifest = JSON.parse(encoded);
  if (manifest.version !== CAPABILITY_POLICY_VERSION || !manifest.configuration || !manifest.files) throw new Error("Missing current run integrity policy.");
  const files = await runtimeFiles(projectRoot);
  if (JSON.stringify(files) !== JSON.stringify(Object.keys(manifest.files))) throw new Error("Runtime asset inventory changed; start a new run.");
  for (const file of files) {
    if (digest(safeReadFile(projectRoot, file, null)) !== manifest.files[file]) {
      throw new Error(`Benchmark runtime changed (${file}); start a new run.`);
    }
  }
  return manifest;
}

function checkpointDigest(runDirectory, artifactsDirectory = runDirectory) {
  const key = safeReadFile(runDirectory, "sandbox-state/integrity-key", null);
  const hmac = createHmac("sha256", key);
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  for (const file of ["game-state.json", "summary.json"]) {
    if (file === "summary.json") hmac.update("\nSUMMARY\n");
    const fd = safeOpenFile(artifactsDirectory, file);
    try {
      let count;
      while ((count = readSync(fd, buffer, 0, buffer.length, null))) hmac.update(buffer.subarray(0, count));
    } finally { closeSync(fd); }
  }
  return hmac.digest("hex");
}

export async function signCheckpoint(runDirectory, { artifactsDirectory = runDirectory } = {}) {
  // Standalone engine/UI fixtures have no key. Production MCP requires a
  // manifest and key before it can open a run.
  try { safeReadFile(runDirectory, "integrity.json"); }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
  const file = path.join(artifactsDirectory, "checkpoint.json");
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ version: CAPABILITY_POLICY_VERSION, hmac: checkpointDigest(runDirectory, artifactsDirectory) }), { mode: 0o600 });
  await rename(temporary, file);
  return true;
}

export function verifyCheckpoint(runDirectory) {
  const checkpoint = JSON.parse(safeReadFile(runDirectory, "checkpoint.json"));
  const expected = Buffer.from(checkpointDigest(runDirectory), "hex");
  const actual = Buffer.from(String(checkpoint.hmac || ""), "hex");
  if (checkpoint.version !== CAPABILITY_POLICY_VERSION || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("Benchmark state or score was modified outside the engine; refusing execution.");
  }
}

export function assertRunConfiguration(metadata, manifest) {
  for (const key of ["model", "effort", "tools_enabled", "action_limit", "start_room", "effective_prompt_sha256"]) {
    if (metadata[key] !== manifest.configuration[key]) throw new Error(`Run configuration changed (${key}); start a new run.`);
  }
}
