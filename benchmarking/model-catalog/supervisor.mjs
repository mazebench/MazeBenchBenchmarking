import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { BenchmarkSupervisor as Native } from '../kimi/supervisor.mjs';
import { BenchmarkSupervisor as Any } from '../all-code/supervisor.mjs';
import { BenchmarkSupervisor as Kimi } from '../kimi-v2/supervisor.mjs';
import { BenchmarkSupervisor as KimiAny } from '../kimi-code-v3/supervisor.mjs';
import { BenchmarkSupervisor as Antigravity } from '../antigravity-v2/supervisor.mjs';
import { BenchmarkSupervisor as AntigravityAny } from '../antigravity-code-v3/supervisor.mjs';
import { BenchmarkSupervisor as Claude } from '../slotski-v2/supervisor.mjs';
import { BenchmarkSupervisor as ClaudeAny } from '../code-v2/supervisor.mjs';
import { codingMode } from '../coding-mode.mjs';
import { ModelCatalog } from './service.mjs';

// Existing processes keep their active maps and signed runtimes. This owner
// handles only new launches, with a private durable routing marker per run.
export class CatalogSupervisor {
  constructor(root, options = {}) {
    this.catalog = options.catalog || new ModelCatalog();
    this.base = new Native(root, options); this.active = this.base.active;
    this.projectRoot = root; this.recordsRoot = this.base.recordsRoot;
    this.ownerRoot = options.ownerRoot || path.join(os.homedir(), '.mazebench/catalog-owner');
    this.runtimes = { native: this.base, any: new Any(root, options), kimi: new Kimi(root, options), kimiAny: new KimiAny(root, options),
      agy: new Antigravity(root, options), agyAny: new AntigravityAny(root, options), claude: new Claude(root, options), claudeAny: new ClaudeAny(root, options) };
    for (const runtime of Object.values(this.runtimes)) {
      runtime.active = this.active;
      runtime.models = () => this.catalog.all();
      for (const [method, provider] of [['inspectKimi', 'kimi-code'], ['inspectAntigravity', 'antigravity'], ['inspectMuse', 'muse-code']]) {
        if (!runtime[method]) continue;
        const inspect = runtime[method].bind(runtime);
        runtime[method] = async (options = {}) => {
          const [status, entry] = await Promise.all([inspect(options), this.catalog.provider(provider, options)]);
          const authenticated = provider === "antigravity" ? status.authenticated : !entry.stale;
          return { ...status, models: entry.models, authenticated, launch_ready: status.tested && authenticated && !entry.stale, error: entry.error || (!status.tested || !authenticated ? status.error : null) };
        };
      }
      const validate = runtime.validateSpec.bind(runtime);
      runtime.validateSpec = async (spec = {}) => {
        const model = await this.catalog.selection(spec);
        const mode = codingMode(spec);
        if (spec.provider === 'grok-build') {
          if ((spec.world || 'main-world') !== 'main-world' || (spec.observation_mode || 'ascii') !== 'ascii') throw new Error('Grok Build supports Main World ASCII.');
          return { provider: spec.provider, world: 'main-world', observationMode: 'ascii', model: model.id,
            effort: spec.effort || model.default_effort, serviceTier: null, toolsEnabled: mode !== 'off',
            startRoom: String(spec.start_room || 'HxI'), actionLimit: spec.action_limit === null || String(spec.action_limit).toLowerCase() === 'unlimited' ? null : Math.max(1, Math.min(1_000_000, Math.floor(Number(spec.action_limit) || 100))),
            pairId: spec.pair_id ? String(spec.pair_id).slice(0, 100) : null };
        }
        return validate({ ...spec, tools_enabled: mode !== 'off' });
      };
    }
    // The dashboard and record readers use the same standard supervisor API.
    for (const method of ['pause', 'stop', 'get', 'resume', 'delete', 'record', 'displayFrame', 'listInterviews', 'createInterview']) {
      this[method] = async (id, ...args) => (await this.forRun(id))[method](id, ...args);
    }
  }
  runDirectory(id) { return this.base.runDirectory(id); }
  initialize() { return this.base.initialize(); }
  owns(directory) { return existsSync(path.join(this.ownerRoot, path.basename(directory) + '.json')); }
  choose(spec) {
    const any = codingMode(spec) === 'any';
    if (spec.provider === 'kimi-code') return this.runtimes[any ? 'kimiAny' : 'kimi'];
    if (spec.provider === 'antigravity') return this.runtimes[any ? 'agyAny' : 'agy'];
    if (spec.provider === 'claude-code') return this.runtimes[any ? 'claudeAny' : 'claude'];
    return any && spec.provider !== 'codex' ? this.runtimes.any : this.base;
  }
  async forRun(id) { return this.choose(JSON.parse(await readFile(path.join(this.runDirectory(id), 'run.json'), 'utf8'))); }
  async validateSpec(spec) { return this.choose(spec).validateSpec(spec); }
  async launch(spec) {
    await this.catalog.selection(spec, { force: true });
    const run = await this.choose(spec).launch(spec);
    mkdirSync(this.ownerRoot, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(this.ownerRoot, run.id + '.json'), JSON.stringify({ version: 1, id: run.id }), { flag: 'wx', mode: 0o600 });
    return run;
  }
}
