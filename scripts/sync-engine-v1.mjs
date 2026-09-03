#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const coreTarget = path.join(repositoryRoot, "engine", "v1", "core");
const wasmTarget = path.join(repositoryRoot, "engine", "v1", "voxel_physics.wasm");
const manifestTarget = path.join(repositoryRoot, "engine", "v1", "upstream.json");
const provenanceTarget = path.join(repositoryRoot, "engine", "v1", "upstream.mjs");
const defaultSource = path.resolve(repositoryRoot, "..", "MazeBenchEngineUnitTest");

function usage() {
  console.log(`Usage: node scripts/sync-engine-v1.mjs [options]

Options:
  --source <path>       MazeBenchEngineUnitTest checkout (default: sibling repo)
  --check               Verify that the vendored engine matches the source
  --skip-source-tests   Skip rebuilding and testing UnitTesting before a sync
  --help                Show this help

The source checkout must be committed and clean. A normal sync rebuilds the
WASM, runs the native and JavaScript engine suites in UnitTesting, copies only
Git-tracked engine files, records hashes/provenance, and runs this repository's
integration tests.`);
}

function parseArguments(values) {
  const options = {
    check: false,
    skipSourceTests: false,
    source: process.env.MAZEBENCH_UNIT_TEST_REPO
      ? path.resolve(process.env.MAZEBENCH_UNIT_TEST_REPO)
      : defaultSource
  };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--check") options.check = true;
    else if (value === "--skip-source-tests") options.skipSourceTests = true;
    else if (value === "--source") {
      const source = values[index + 1];
      if (!source) throw new Error("--source needs a repository path.");
      options.source = path.resolve(source);
      index += 1;
    } else if (value === "--help" || value === "-h") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${value}`);
    }
  }
  if (options.check && options.skipSourceTests) {
    throw new Error("--skip-source-tests has no effect with --check; remove it.");
  }
  return options;
}

function command(commandName, arguments_, cwd, options = {}) {
  return execFileSync(commandName, arguments_, {
    cwd,
    encoding: Object.hasOwn(options, "encoding") ? options.encoding : "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
    env: options.env ?? process.env
  });
}

async function sha256(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function listFiles(directory, prefix = "") {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === ".DS_Store") continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...await listFiles(path.join(directory, entry.name), relative));
    else if (entry.isFile()) result.push(relative);
  }
  return result.sort();
}

function managedPath(root, relative) {
  if (!relative || path.isAbsolute(relative)) throw new Error(`Unsafe managed path: ${relative}`);
  const resolved = path.resolve(root, relative);
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Managed path escapes its root: ${relative}`);
  }
  return resolved;
}

function trackedEngineFiles(sourceRoot) {
  const output = command("git", ["ls-files", "-s", "-z", "--", "engine"], sourceRoot, {
    encoding: null
  });
  return output.toString("utf8").split("\0").filter(Boolean).map((record) => {
    const match = record.match(/^(\d+) [0-9a-f]+ \d+\tengine\/(.+)$/);
    if (!match) throw new Error(`Could not parse tracked engine file: ${record}`);
    return { mode: match[1], path: match[2] };
  }).sort((left, right) => left.path.localeCompare(right.path));
}

async function sourceManifest(sourceRoot) {
  const sourceCommit = command("git", ["rev-parse", "HEAD"], sourceRoot).trim();
  const sourceTree = command("git", ["rev-parse", "HEAD:engine"], sourceRoot).trim();
  let sourceRepository = "MazeBenchEngineUnitTest";
  try {
    sourceRepository = command("git", ["remote", "get-url", "origin"], sourceRoot).trim();
  } catch {
    // A local checkout without a remote still has an unambiguous commit/tree.
  }
  const files = [];
  for (const tracked of trackedEngineFiles(sourceRoot)) {
    const sourcePath = managedPath(path.join(sourceRoot, "engine"), tracked.path);
    files.push({ ...tracked, sha256: await sha256(sourcePath) });
  }
  const wasmSource = path.join(sourceRoot, "apps", "web", "public", "physics", "voxel_physics.wasm");
  return {
    schemaVersion: 1,
    sourceRepository,
    sourceCommit,
    sourceTree,
    abiVersion: 4,
    voxelStride: 5,
    wasm: {
      sourcePath: "apps/web/public/physics/voxel_physics.wasm",
      sha256: await sha256(wasmSource),
      bytes: (await stat(wasmSource)).size
    },
    files
  };
}

async function verifyWasm(sourceRoot, manifest) {
  const wasmSource = path.join(sourceRoot, manifest.wasm.sourcePath);
  const bytes = await readFile(wasmSource);
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const requiredExports = [
    "memory",
    "physics_abi_version",
    "voxel_stride",
    "voxel_capacity",
    "voxel_buffer",
    "role_buffer_capacity",
    "role_buffer",
    "role_code",
    "motion_state_buffer",
    "motion_state_size",
    "reset_command",
    "step_command_tick",
    "command_tick",
    "command_cycle_detected",
    "command_cycle_start_tick",
    "command_cycle_repeat_tick",
    "simulate_turn",
    "search_solve",
    "search_edges",
    "search_edge_count",
    "search_edge_solution",
    "search_solution_length",
    "search_solution_step"
  ];
  const missing = requiredExports.filter((name) => !(name in instance.exports));
  if (missing.length) throw new Error(`Updated WASM is missing required ABI exports: ${missing.join(", ")}`);
  const abiVersion = instance.exports.physics_abi_version();
  const voxelStride = instance.exports.voxel_stride();
  if (abiVersion !== manifest.abiVersion || voxelStride !== manifest.voxelStride) {
    throw new Error(
      `Engine ABI changed (expected ABI ${manifest.abiVersion}/stride ${manifest.voxelStride}, ` +
      `received ABI ${abiVersion}/stride ${voxelStride}). Create a new adapter/version before syncing.`
    );
  }
}

function requireCleanSource(sourceRoot) {
  const status = command("git", ["status", "--porcelain"], sourceRoot).trim();
  if (status) {
    throw new Error(
      `UnitTesting must be committed and clean before syncing. Current changes:\n${status}`
    );
  }
}

function runSourceTests(sourceRoot) {
  console.log("Building UnitTesting WASM...");
  command("npm", ["run", "build:physics"], sourceRoot, { stdio: "inherit" });
  requireCleanSource(sourceRoot);

  console.log("Running UnitTesting native engine tests...");
  command("npm", ["run", "test:physics"], sourceRoot, { stdio: "inherit" });

  console.log("Running UnitTesting JavaScript/WASM engine tests...");
  const testDirectory = path.join(sourceRoot, "engine", "tests");
  return readdir(testDirectory).then((entries) => {
    const tests = entries.filter((entry) => entry.endsWith(".test.mjs")).sort()
      .map((entry) => path.join("engine", "tests", entry));
    command(process.execPath, ["--test", ...tests], sourceRoot, { stdio: "inherit" });
  });
}

async function verifyManagedTarget(manifest, { compareSource = true } = {}) {
  const failures = [];
  const targetFiles = await listFiles(coreTarget);
  const expectedPaths = new Set(manifest.files.map((entry) => entry.path));
  for (const targetFile of targetFiles) {
    if (!expectedPaths.has(targetFile)) failures.push(`unexpected core file: ${targetFile}`);
  }
  for (const entry of manifest.files) {
    const targetPath = managedPath(coreTarget, entry.path);
    try {
      const targetHash = await sha256(targetPath);
      if (targetHash !== entry.sha256) failures.push(`different core file: ${entry.path}`);
    } catch (error) {
      if (error?.code === "ENOENT") failures.push(`missing core file: ${entry.path}`);
      else throw error;
    }
  }
  try {
    const targetWasmHash = await sha256(wasmTarget);
    if (targetWasmHash !== manifest.wasm.sha256) failures.push("different WASM binary");
  } catch (error) {
    if (error?.code === "ENOENT") failures.push("missing WASM binary");
    else throw error;
  }
  if (compareSource) {
    const recorded = await readJsonIfPresent(manifestTarget);
    if (!recorded) failures.push("missing engine/v1/upstream.json");
    else if (JSON.stringify(recorded) !== JSON.stringify(manifest)) {
      failures.push("recorded provenance does not match UnitTesting HEAD");
    }
  }
  return failures;
}

async function protectLocalEngineChanges(previousManifest) {
  if (!previousManifest) return;
  const failures = await verifyManagedTarget(previousManifest, { compareSource: false });
  if (failures.length) {
    throw new Error(
      `Refusing to overwrite locally modified vendored engine files:\n- ${failures.join("\n- ")}`
    );
  }
}

async function syncFiles(sourceRoot, manifest, previousManifest) {
  await mkdir(coreTarget, { recursive: true });
  const nextPaths = new Set(manifest.files.map((entry) => entry.path));
  for (const previous of previousManifest?.files ?? []) {
    if (nextPaths.has(previous.path)) continue;
    await rm(managedPath(coreTarget, previous.path), { force: true });
  }
  for (const entry of manifest.files) {
    const sourcePath = managedPath(path.join(sourceRoot, "engine"), entry.path);
    const targetPath = managedPath(coreTarget, entry.path);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await copyFile(sourcePath, targetPath);
    await chmod(targetPath, entry.mode === "100755" ? 0o755 : 0o644);
  }
  const wasmSource = path.join(sourceRoot, manifest.wasm.sourcePath);
  await copyFile(wasmSource, wasmTarget);
  await chmod(wasmTarget, 0o755);
}

async function writeProvenance(manifest) {
  await writeFile(manifestTarget, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const generated = `// Generated by scripts/sync-engine-v1.mjs. Do not edit by hand.\n` +
    `export const ENGINE_SOURCE_REPOSITORY = ${JSON.stringify(manifest.sourceRepository)};\n` +
    `export const ENGINE_SOURCE_COMMIT = ${JSON.stringify(manifest.sourceCommit)};\n` +
    `export const ENGINE_SOURCE_TREE = ${JSON.stringify(manifest.sourceTree)};\n` +
    `export const ENGINE_WASM_SHA256 = ${JSON.stringify(manifest.wasm.sha256)};\n`;
  await writeFile(provenanceTarget, generated, "utf8");
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const sourceRoot = options.source;
  await stat(path.join(sourceRoot, "engine", "CMakeLists.txt"));
  await stat(path.join(sourceRoot, "apps", "web", "public", "physics", "voxel_physics.wasm"));
  requireCleanSource(sourceRoot);

  if (!options.check && !options.skipSourceTests) await runSourceTests(sourceRoot);

  const manifest = await sourceManifest(sourceRoot);
  await verifyWasm(sourceRoot, manifest);

  if (options.check) {
    const failures = await verifyManagedTarget(manifest);
    if (failures.length) {
      throw new Error(`Engine v1 is out of sync:\n- ${failures.join("\n- ")}`);
    }
    console.log(`Engine v1 matches UnitTesting ${manifest.sourceCommit.slice(0, 12)} (${manifest.wasm.sha256}).`);
    return;
  }

  const previousManifest = await readJsonIfPresent(manifestTarget);
  await protectLocalEngineChanges(previousManifest);
  await syncFiles(sourceRoot, manifest, previousManifest);
  await writeProvenance(manifest);

  const failures = await verifyManagedTarget(manifest);
  if (failures.length) throw new Error(`Post-sync verification failed:\n- ${failures.join("\n- ")}`);

  console.log("Building the project-owned random-agent accelerator...");
  command("sh", ["scripts/build-random-agent-v1.sh"], repositoryRoot, {
    stdio: "inherit",
    env: { ...process.env, MAZEBENCH_UNIT_TEST_REPO: sourceRoot }
  });
  console.log("Building the project-owned command-state solver accelerator...");
  command("sh", ["scripts/build-editor-solver-v1.sh"], repositoryRoot, {
    stdio: "inherit",
    env: { ...process.env, MAZEBENCH_UNIT_TEST_REPO: sourceRoot }
  });
  console.log("Running MazeBenchBenchmarking integration tests...");
  command(process.execPath, [
    "--test",
    "tests/engine-v1.test.mjs",
    "tests/world-solver-v1.test.mjs"
  ], repositoryRoot, { stdio: "inherit" });
  console.log(
    `Synced engine v1 from UnitTesting ${manifest.sourceCommit.slice(0, 12)} ` +
    `(${manifest.files.length} core files, WASM ${manifest.wasm.sha256}).`
  );
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exitCode = 1;
});
