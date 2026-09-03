import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_CODE_BYTES = 256_000;
const MAX_OUTPUT_BYTES = 256_000;
const MAX_TIMEOUT_SECONDS = 60;
const PYTHON_BOOTSTRAP_PATH = path.join(import.meta.dirname, "python-bootstrap.py");

const CPU_PATTERN = /\u001eMAZEBENCH_CPU_TIME_NS=(\d+)\u001e/g;

function resolvedExecutable(command, label) {
  const value = String(command || "").trim();
  if (!value) throw new Error(`${label} executable is required.`);
  if (value.includes(path.sep)) {
    const absolute = path.resolve(value);
    if (!existsSync(absolute)) throw new Error(`${label} executable does not exist.`);
    return absolute;
  }
  const probe = spawnSync("which", [value], { encoding: "utf8" });
  const found = String(probe.stdout || "").trim().split(/\r?\n/, 1)[0];
  if (probe.status !== 0 || !found) throw new Error(`${label} executable was not found on PATH.`);
  return path.resolve(found);
}

function findPython(requested = "") {
  for (const candidate of [requested, "/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3", "python3"]) {
    if (!String(candidate || "").trim()) continue;
    try {
      return resolvedExecutable(candidate, "Python");
    } catch {
      // Try the next standalone interpreter.
    }
  }
  throw new Error("No standalone Python 3 interpreter is available.");
}

function canonical(candidate) {
  const absolute = path.resolve(String(candidate));
  try {
    return realpathSync(absolute);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    const parent = path.dirname(absolute);
    return parent === absolute ? absolute : path.join(canonical(parent), path.basename(absolute));
  }
}

function isWithin(candidate, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function inlinePermissions(entries) {
  return `{${Object.entries(entries)
    .map(([entry, access]) => `${tomlString(entry)}=${tomlString(access)}`)
    .join(",")}}`;
}

function runtimeRoots(pythonBin) {
  const roots = [];
  for (const candidate of [path.resolve(pythonBin), realpathSync(pythonBin)]) {
    if (candidate.startsWith("/opt/homebrew/")) roots.push("/opt/homebrew");
    else if (candidate.startsWith("/usr/local/")) roots.push("/usr/local");
    else if (candidate.startsWith("/Library/Frameworks/")) roots.push("/Library/Frameworks");
    else if (!candidate.startsWith("/usr/") && !candidate.startsWith("/System/")) roots.push(path.dirname(candidate));
  }
  return [...new Set(roots)];
}

function bounded(value, maximum = Math.floor(MAX_OUTPUT_BYTES / 2)) {
  const bytes = Buffer.from(String(value || ""), "utf8");
  if (bytes.length <= maximum) return { text: bytes.toString("utf8"), truncated: false };
  return { text: bytes.subarray(0, maximum).toString("utf8"), truncated: true };
}

function sandboxConfig(options = {}) {
  const workspace = canonical(options.workspace);
  const stateDirectory = canonical(options.stateDirectory);
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  mkdirSync(path.join(workspace, ".tmp"), { recursive: true, mode: 0o700 });
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(path.join(stateDirectory, "codex-home"), { recursive: true, mode: 0o700 });
  const projectRoot = canonical(options.projectRoot);
  const runDirectory = canonical(options.runDirectory);
  if (!isWithin(workspace, runDirectory)) throw new Error("Python workspace must be run-scoped.");
  const codexBin = resolvedExecutable(options.codexBin || "codex", "Codex");
  const pythonBin = findPython(options.pythonBin);
  return { workspace, stateDirectory, projectRoot, runDirectory, codexBin, pythonBin };
}

function sandboxCommand(options = {}) {
  const config = sandboxConfig(options);
  const timeoutSeconds = Math.max(1, Math.min(MAX_TIMEOUT_SECONDS, Number(options.timeoutSeconds) || 10));
  const permissions = { ":minimal": "read" };
  for (const root of runtimeRoots(config.pythonBin)) permissions[root] = "read";
  permissions[os.homedir()] = "deny";
  permissions[config.projectRoot] = "deny";
  permissions[config.runDirectory] = "deny";
  permissions[config.workspace] = "write";
  permissions[config.stateDirectory] = "deny";
  permissions[PYTHON_BOOTSTRAP_PATH] = "read";
  return {
    config,
    argv: [
      "sandbox",
      "-C", config.workspace,
      "-P", "mazebench_python",
      "-c", `permissions.mazebench_python.filesystem=${inlinePermissions(permissions)}`,
      "-c", "permissions.mazebench_python.network.enabled=false",
      config.pythonBin,
      "-I",
      "-B",
      PYTHON_BOOTSTRAP_PATH,
      String(timeoutSeconds + 1),
      "1024",
      "32",
      String(options.scriptPath || "<mazebench-python>")
    ]
  };
}

export function normalizePythonScriptPath(value) {
  const normalized = String(value || "").trim().replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || normalized.includes("..") || !normalized.endsWith(".py")) {
    throw new Error("script_path must be a relative .py file inside /workspace.");
  }
  if (!/^[A-Za-z0-9_./-]+$/.test(normalized)) {
    throw new Error("script_path contains unsupported characters.");
  }
  return normalized;
}

export function runSandboxedPython(code, options = {}) {
  const source = String(code || "");
  if (!source.trim()) throw new Error("Python code is required.");
  if (Buffer.byteLength(source, "utf8") > MAX_CODE_BYTES) {
    throw new Error(`Python code exceeds ${MAX_CODE_BYTES} bytes.`);
  }
  const scriptPath = normalizePythonScriptPath(options.scriptPath);
  const timeoutSeconds = Number(options.timeoutSeconds) || 10;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > MAX_TIMEOUT_SECONDS) {
    throw new Error(`timeout_seconds must be between 1 and ${MAX_TIMEOUT_SECONDS}.`);
  }
  const { config, argv } = sandboxCommand({ ...options, timeoutSeconds, scriptPath });
  const destination = path.resolve(config.workspace, scriptPath);
  if (!destination.startsWith(`${config.workspace}${path.sep}`)) throw new Error("Invalid script_path.");
  mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  writeFileSync(destination, source, { encoding: "utf8", mode: 0o600 });
  chmodSync(destination, 0o600);
  const result = spawnSync(config.codexBin, argv, {
    cwd: config.workspace,
    env: {
      CODEX_HOME: path.join(config.stateDirectory, "codex-home"),
      HOME: config.workspace,
      TMPDIR: path.join(config.workspace, ".tmp"),
      PATH: [...new Set([path.dirname(config.codexBin), path.dirname(config.pythonBin), "/usr/bin", "/bin"])].join(path.delimiter),
      LANG: "C",
      LC_ALL: "C",
      PYTHONIOENCODING: "utf-8",
      PYTHONDONTWRITEBYTECODE: "1"
    },
    encoding: "utf8",
    timeout: (timeoutSeconds + 5) * 1000,
    maxBuffer: MAX_OUTPUT_BYTES * 2,
    killSignal: "SIGKILL"
  });
  const stdout = bounded(result.stdout);
  let cpuTimeMs = null;
  const stderrSource = String(result.stderr || "").replace(CPU_PATTERN, (_marker, nanoseconds) => {
    cpuTimeMs = Number(nanoseconds) / 1_000_000;
    return "";
  });
  const stderr = bounded(stderrSource);
  const timedOut = result.error?.code === "ETIMEDOUT";
  return {
    script_path: scriptPath,
    exit_code: Number.isInteger(result.status) ? result.status : null,
    stdout: stdout.text,
    stderr: stderr.text || (result.error && !timedOut ? String(result.error.message || result.error) : ""),
    cpu_time_ms: Number.isFinite(cpuTimeMs) ? cpuTimeMs : null,
    timed_out: timedOut,
    output_truncated: stdout.truncated || stderr.truncated || result.error?.code === "ENOBUFS"
  };
}

export function preflightPythonSandbox(options = {}) {
  const config = sandboxConfig(options);
  const privateCanary = path.join(config.runDirectory, "private-canary.txt");
  const hostCanary = path.join(os.tmpdir(), `mazebench-host-canary-${process.pid}-${Date.now()}.txt`);
  const symlink = path.join(config.workspace, ".escape-canary");
  const token = `${process.pid}:${Date.now()}`;
  writeFileSync(privateCanary, token, { mode: 0o600 });
  writeFileSync(hostCanary, token, { mode: 0o600 });
  try {
    rmSync(symlink, { force: true });
    symlinkSync(privateCanary, symlink);
    const source = `
import json, socket, subprocess
from pathlib import Path
r = {}
for name, target in [("private", Path(${JSON.stringify(privateCanary)})), ("host", Path(${JSON.stringify(hostCanary)})), ("symlink", Path(${JSON.stringify(symlink)}))]:
    try: target.read_text(); r[name] = False
    except PermissionError: r[name] = True
    except Exception: r[name] = False
try: socket.create_connection(("127.0.0.1", 9), timeout=.2); r["network"] = False
except PermissionError: r["network"] = True
except Exception: r["network"] = False
try: subprocess.run(["/bin/sh", "-c", "echo escaped"]); r["subprocess"] = False
except PermissionError: r["subprocess"] = True
except Exception: r["subprocess"] = False
p=Path("preflight-write.txt"); p.write_text("ok"); r["write"] = p.read_text() == "ok"
print("MAZEBENCH_PREFLIGHT=" + json.dumps(r, sort_keys=True))
`;
    const result = runSandboxedPython(source, {
      ...options,
      workspace: config.workspace,
      stateDirectory: config.stateDirectory,
      projectRoot: config.projectRoot,
      runDirectory: config.runDirectory,
      scriptPath: "preflight.py",
      timeoutSeconds: 5
    });
    const marker = result.stdout.split(/\r?\n/).find((line) => line.startsWith("MAZEBENCH_PREFLIGHT="));
    const checks = marker ? JSON.parse(marker.slice("MAZEBENCH_PREFLIGHT=".length)) : null;
    const verified = result.exit_code === 0 && checks &&
      checks.private && checks.host && checks.symlink && checks.network && checks.subprocess && checks.write;
    if (!verified) {
      throw new Error(`Python isolation preflight failed: ${JSON.stringify(checks)} ${result.stderr}`.trim());
    }
    return { verified: true, verified_at: new Date().toISOString(), checks };
  } finally {
    rmSync(symlink, { force: true });
    rmSync(path.join(config.workspace, "preflight-write.txt"), { force: true });
    rmSync(path.join(config.workspace, "preflight.py"), { force: true });
    rmSync(privateCanary, { force: true });
    rmSync(hostCanary, { force: true });
  }
}

export function workspaceInventory(workspace) {
  const root = canonical(workspace);
  const results = [];
  const walk = (directory, prefix = "") => {
    let names = [];
    try {
      names = readdirSync(directory);
    } catch {
      return;
    }
    for (const name of names) {
      if (name === ".tmp" || name.startsWith(".escape")) continue;
      const absolute = path.join(directory, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      let details;
      try {
        details = statSync(absolute);
      } catch {
        continue;
      }
      if (!details) continue;
      if (details.isDirectory()) walk(absolute, relative);
      else if (details.isFile()) results.push({ path: relative, bytes: details.size });
      if (results.length >= 500) return;
    }
  };
  walk(root);
  return results;
}
