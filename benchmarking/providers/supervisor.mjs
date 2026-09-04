// Provider extension. The v1 Codex runtime remains byte-for-byte frozen so
// existing, attested Codex runs can continue while new providers are added.
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { BenchmarkSupervisor as CodexSupervisor, buildBenchmarkPrompt } from "../v1/supervisor.mjs";
import { BenchmarkGameRuntime } from "../v1/runtime.mjs";
import { createRunIntegrity, CAPABILITY_POLICY_VERSION } from "../v1/integrity.mjs";
import { preflightPythonSandbox } from "../v1/python-sandbox.mjs";
import { CLAUDE_PROVIDER, CLAUDE_POLICY, CLAUDE_MODELS, claudeInstallationStatus, digest, providerRuntimeHashes, verifyClaudeIntegrity } from "./claude-policy.mjs";
import { runClaudeTurn, atomicJson, readJson } from "./claude-runner.mjs";

const now = () => new Date().toISOString();
const makeId = () => `run-${now().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
const providerOf = metadata => metadata.provider || "codex";

export class BenchmarkSupervisor extends CodexSupervisor {
  constructor(projectRoot, options = {}) {
    super(projectRoot, options);
    this.claudeBin = options.claudeBin || process.env.MAZEBENCH_CLAUDE_BIN || "claude";
  }

  async providers(options = {}) {
    const [codex, claude] = await Promise.all([super.status(options), Promise.resolve().then(() => claudeInstallationStatus(this.claudeBin))]);
    return { codex, [CLAUDE_PROVIDER]: claude };
  }

  async models() {
    const catalog = await super.models();
    return { ...catalog, models: [...catalog.models.map(model => ({ ...model, provider: "codex" })), ...CLAUDE_MODELS] };
  }

  async validateSpec(spec = {}) {
    const provider = String(spec.provider || "codex");
    if (!["codex", CLAUDE_PROVIDER].includes(provider)) throw new Error("Unknown benchmark agent provider.");
    const catalog = await this.models();
    const model = String(spec.model || (provider === CLAUDE_PROVIDER ? CLAUDE_MODELS[0].id : catalog.default_model));
    if (!catalog.models.some(entry => entry.id === model && entry.provider === provider)) throw new Error(`Model ${model} is not available through ${provider}.`);
    const options = await super.validateSpec({ ...spec, model });
    return { ...options, provider };
  }

  async launch(spec = {}) {
    if ((spec.provider || "codex") === "codex") return super.launch(spec);
    const options = await this.validateSpec(spec);
    const installation = claudeInstallationStatus(this.claudeBin);
    if (!installation.available || !installation.tested || !installation.authenticated) throw new Error(installation.error || "Claude Code is unavailable.");
    await this.initialize();
    const id = makeId(), directory = this.runDirectory(id);
    await Promise.all(["agent-cwd", "sandbox-state"].map(name => mkdir(path.join(directory, name), { recursive: true, mode: 0o700 })));
    const base = await readFile(path.join(this.projectRoot, "benchmarking/v1/EVAL-PROMPT.md"), "utf8");
    const prompt = buildBenchmarkPrompt(base, options);
    const configuration = {
      provider: CLAUDE_PROVIDER, claude_policy: CLAUDE_POLICY,
      claude_executable: installation.executable, claude_version: installation.version,
      claude_sha256: digest(await readFile(installation.executable)), provider_runtime: await providerRuntimeHashes(this.projectRoot),
      model: options.model, effort: options.effort, tools_enabled: options.toolsEnabled,
      action_limit: options.actionLimit, start_room: options.startRoom, effective_prompt_sha256: digest(prompt)
    };
    const metadata = {
      schema_version: 1, id, provider: CLAUDE_PROVIDER, pair_id: options.pairId, created_at: now(), updated_at: now(), status: "preparing",
      model: options.model, effort: options.effort, tools_enabled: options.toolsEnabled, action_limit: options.actionLimit, start_room: options.startRoom,
      effective_prompt_sha256: configuration.effective_prompt_sha256, prompt_sha256: digest(base),
      claude_session_id: null, continuation_count: 0, error: null, stopped_at: null, completed_at: null,
      capability_policy: { version: CAPABILITY_POLICY_VERSION, name: CLAUDE_POLICY, claude_version: installation.version, tools: options.toolsEnabled ? "maze-and-isolated-python" : "maze-only" },
      isolation: { mode: "no-python" }
    };
    metadata.integrity = await createRunIntegrity(this.projectRoot, directory, configuration);
    await writeFile(path.join(directory, "prompt.md"), prompt, { mode: 0o600 });
    await atomicJson(path.join(directory, "run.json"), metadata);
    try {
      await BenchmarkGameRuntime.create(this.projectRoot, directory, { startRoom: options.startRoom, actionLimit: options.actionLimit });
      if (options.toolsEnabled) {
        metadata.isolation = this.pythonPreflight(directory);
        await atomicJson(path.join(directory, "sandbox-preflight.json"), metadata.isolation);
      }
      metadata.status = "queued";
      await atomicJson(path.join(directory, "run.json"), metadata);
      this.startClaude(id, directory, prompt);
    } catch (error) {
      metadata.status = "failed"; metadata.error = error.message; metadata.completed_at = now();
      await atomicJson(path.join(directory, "run.json"), metadata);
      throw error;
    }
    return this.get(id);
  }

  pythonPreflight(directory) {
    return preflightPythonSandbox({ projectRoot: this.projectRoot, runDirectory: directory,
      workspace: path.join(directory, "workspace"), stateDirectory: path.join(directory, "sandbox-state") });
  }

  async verifyRunCapabilityBoundary(metadata, directory) {
    if (providerOf(metadata) !== CLAUDE_PROVIDER) return super.verifyRunCapabilityBoundary(metadata, directory);
    if (existsSync(path.join(directory, "integrity-violation.json"))) throw new Error("This run was invalidated and cannot resume.");
    const frozen = await verifyClaudeIntegrity(this.projectRoot, directory, metadata);
    if (metadata.tools_enabled) this.pythonPreflight(directory);
    return frozen;
  }

  startClaude(id, directory, prompt) {
    const control = { child: null, stopRequested: false, pauseRequested: false, threadId: null };
    this.active.set(id, control);
    this.claudeLoop(id, directory, prompt, control).catch(async error => {
      const metadata = await readJson(path.join(directory, "run.json"));
      metadata.status = "failed"; metadata.error = error.message; metadata.updated_at = now(); metadata.completed_at = now();
      await atomicJson(path.join(directory, "run.json"), metadata);
    }).finally(() => this.active.delete(id));
  }

  async claudeLoop(id, directory, prompt, control) {
    const metadataPath = path.join(directory, "run.json");
    while (!control.stopRequested && !control.pauseRequested) {
      let metadata = await readJson(metadataPath);
      const frozen = await this.verifyRunCapabilityBoundary(metadata, directory);
      metadata.status = metadata.claude_session_id ? "continuing" : "running"; metadata.updated_at = now();
      await atomicJson(metadataPath, metadata);
      if (control.stopRequested || control.pauseRequested) break;
      const before = (await readJson(path.join(directory, "summary.json"))).action_count;
      const turn = await runClaudeTurn({ projectRoot: this.projectRoot, directory, metadata, frozen, prompt, control,
        onSession: async session => {
          const current = await readJson(metadataPath);
          if (current.claude_session_id === session) return;
          current.claude_session_id = session; current.updated_at = now(); await atomicJson(metadataPath, current);
        } });
      metadata = await readJson(metadataPath);
      if (turn.boundaryError) throw new Error(turn.boundaryError);
      await verifyClaudeIntegrity(this.projectRoot, directory, metadata);
      const summary = await readJson(path.join(directory, "summary.json"));
      if (control.pauseRequested || control.stopRequested) break;
      // Validate successful transport before accepting a terminal game score.
      if (turn.code !== 0 || turn.result?.is_error || !turn.result) throw new Error(turn.error || `Claude Code exited with status ${turn.code}.`);
      if (["won", "action-limit"].includes(summary.game_status)) {
        metadata.status = "completed"; metadata.completed_at = now(); metadata.updated_at = now();
        await atomicJson(metadataPath, metadata); return;
      }
      if (!metadata.claude_session_id) throw new Error("Claude did not report a resumable session.");
      metadata.continuation_count += 1;
      metadata.last_turn_actions = summary.action_count - before;
      metadata.updated_at = now();
      await atomicJson(metadataPath, metadata);
      prompt = `Continue the same MazeBench benchmark. Call maze_observe to re-anchor, then keep acting until won or action-limit. You have ${summary.action_count} accepted actions recorded.`;
    }
    const metadata = await readJson(metadataPath);
    metadata.status = control.pauseRequested ? "paused" : "stopped"; metadata.updated_at = now();
    metadata[control.pauseRequested ? "paused_at" : "stopped_at"] = now();
    await atomicJson(metadataPath, metadata);
  }

  async resume(id) {
    const directory = this.runDirectory(id);
    const metadata = await readJson(path.join(directory, "run.json"));
    if (providerOf(metadata) !== CLAUDE_PROVIDER) return super.resume(id);
    if (this.active.has(id)) throw new Error("This benchmark is already running.");
    if (!["paused", "stopped", "failed"].includes(metadata.status)) throw new Error("This benchmark cannot be resumed.");
    await this.verifyRunCapabilityBoundary(metadata, directory);
    if (!metadata.claude_session_id) throw new Error("This benchmark has no resumable Claude session.");
    const summary = await readJson(path.join(directory, "summary.json"));
    if (["won", "action-limit"].includes(summary.game_status)) throw new Error("This benchmark has reached its terminal game state.");
    metadata.status = "queued"; metadata.error = null; metadata.completed_at = null; metadata.stopped_at = null; metadata.paused_at = null;
    metadata.resumed_at = now(); metadata.updated_at = now();
    await atomicJson(path.join(directory, "run.json"), metadata);
    this.startClaude(id, directory, `Resume the same MazeBench benchmark. Call maze_observe to re-anchor, then keep acting until won or action-limit. You have ${summary.action_count} accepted actions recorded.`);
    return this.get(id);
  }

  async get(id, options) {
    const run = await super.get(id, options);
    if (providerOf(run) === CLAUDE_PROVIDER) {
      run.capability_boundary_verified = run.capability_policy?.name === CLAUDE_POLICY && run.integrity?.version === CAPABILITY_POLICY_VERSION && !existsSync(path.join(this.runDirectory(id), "integrity-violation.json"));
      run.compaction_recoverable = run.status === "failed" && run.capability_boundary_verified && Boolean(run.claude_session_id);
    }
    return run;
  }

  async listInterviews(id) {
    const metadata = await readJson(path.join(this.runDirectory(id), "run.json"));
    if (providerOf(metadata) !== CLAUDE_PROVIDER) return super.listInterviews(id);
    return { schema_version: 2, run_id: id, available: false, chats: [], reason: "Claude Code interviews are not implemented." };
  }
  async createInterview(id) {
    const metadata = await readJson(path.join(this.runDirectory(id), "run.json"));
    if (providerOf(metadata) === CLAUDE_PROVIDER) throw new Error("Claude Code interviews are not implemented.");
    return super.createInterview(id);
  }
}
