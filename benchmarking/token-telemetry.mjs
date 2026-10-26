import { createPrimeTimeline, consumePrimeEvent, primeTelemetry } from "./prime-telemetry.mjs";
// Read-only dashboard telemetry. Never imported by the benchmark agent or MCP.
import { constants } from "node:fs";
import { open, readdir, lstat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { safeReadFile, safeDirectory } from "./v1/safe-files.mjs";
import { createClaudeTimeline, consumeClaudeEvent, claudeTelemetry } from "./claude-telemetry.mjs";
import { createAntigravityTimeline, consumeAntigravityEvent, antigravityTelemetry } from "./antigravity-telemetry.mjs";
import { findMuseSession, museRunHomes, createMuseTimeline, consumeMuseEvent, museTelemetry } from "./muse-telemetry.mjs";

const finite = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
export { requestApiCost } from "./token-pricing.mjs";
import { estimateRequests } from "./token-pricing.mjs";
import { kimiRunHomes, findKimiSession, createKimiTimeline, consumeKimiEvent, kimiTelemetry } from "./kimi-telemetry.mjs";

export function modelTokenLimits(model = {}) {
  const window = model.context_window ?? model.max_context_window;
  const defaultTrigger = finite(window) ? Math.floor(window * 0.9) : null;
  const configured = finite(model.auto_compact_token_limit) ? model.auto_compact_token_limit : null;
  // Codex 0.153.3: protocol/src/openai_models.rs::auto_compact_token_limit.
  return {
    compaction_threshold: defaultTrigger === null ? configured : configured === null ? defaultTrigger : Math.min(defaultTrigger, configured),
    context_window: finite(window) ? Math.floor(window * (model.effective_context_window_percent ?? 95) / 100) : null
  };
}

export function createTokenTimeline() {
  return { samples: [], compactions: [], context_window: null, total_tokens: null, usage_records: new Map() };
}

function recordUsage(timeline, record, timestamp) {
  if (!record?.response_id || !finite(record.usage?.input_tokens) || !finite(record.usage?.output_tokens)) return;
  const usage = Object.fromEntries(["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "cache_write_long_input_tokens", "output_tokens"].map(key => [key, finite(record.usage[key]) ? record.usage[key] : 0]));
  usage.timestamp = timeline.usage_records.get(record.response_id)?.timestamp ?? timestamp;
  if (record.service_tier) usage.service_tier = record.service_tier;
  timeline.usage_records.set(record.response_id, usage);
  if (finite(record.thread_token_usage?.total_tokens)) timeline.total_tokens = record.thread_token_usage.total_tokens;
}

export function tokenBilling(timeline, model, metadata = {}) {
  const totals = { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  for (const usage of timeline.usage_records.values()) {
    for (const key of Object.keys(totals)) if (key in usage) totals[key] += usage[key];
  }
  totals.total_tokens = totals.input_tokens + totals.output_tokens;
  const history = [...metadata.service_tier_history || []].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const records = [...timeline.usage_records.values()].map(usage => {
    let tier = metadata.service_tier || 'standard';
    for (const change of history) if (Date.parse(change.at) <= usage.timestamp) tier = change.service_tier || 'standard';
    return { ...usage, service_tier: usage.service_tier || tier };
  });
  return { totals: timeline.usage_records.size ? totals : null,
    api_estimate: estimateRequests(records, model, { service_tier: metadata.service_tier || 'standard' }) };
}

export function consumeTokenEvent(timeline, event) {
  const timestamp = Date.parse(event.timestamp);
  if (!Number.isFinite(timestamp)) return;
  const payload = event.payload || {};
  if (event.type === "compacted") {
    timeline.compactions.push({ timestamp, before_tokens: timeline.samples.at(-1)?.tokens ?? null, after_tokens: null });
    recordUsage(timeline, payload.latest_token_usage_record, timestamp);
  } else if (event.type === "token_usage_record") {
    recordUsage(timeline, payload, timestamp);
  } else if (event.type === "event_msg" && payload.type === "token_count") {
    const info = payload.info;
    const tokens = info?.last_token_usage?.total_tokens;
    if (!finite(tokens)) return;
    if (finite(info.model_context_window)) timeline.context_window = info.model_context_window;
    timeline.samples.push({ timestamp, tokens });
    const compaction = timeline.compactions.at(-1);
    if (compaction && compaction.after_tokens === null && timestamp >= compaction.timestamp) compaction.after_tokens = tokens;
    // Bound very long runs while retaining their peaks, drops and full time span.
    if (timeline.samples.length > 5000) {
      const samples = timeline.samples;
      const reduced = [samples[0]];
      for (let i = 1; i < samples.length - 1; i += 4) {
        const group = samples.slice(i, Math.min(i + 4, samples.length - 1));
        const min = group.reduce((a, b) => a.tokens < b.tokens ? a : b);
        const max = group.reduce((a, b) => a.tokens > b.tokens ? a : b);
        reduced.push(...[...new Set([min, max])].sort((a, b) => a.timestamp - b.timestamp));
      }
      reduced.push(samples.at(-1));
      timeline.samples = reduced;
    }
  }
}

export class TokenTelemetry {
  constructor({ codexHome = path.join(os.homedir(), ".codex"), museHomes = museRunHomes(), kimiHomes = kimiRunHomes() } = {}) {
    this.codexHome = codexHome;
    this.museHomes = museHomes;
    this.kimiHomes = kimiHomes;
    this.cache = new Map();
    this.pending = new Map();
  }

  async findRollout(metadata) {
    const id = metadata.codex_thread_id;
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id || "")) return null;
    const created = Date.parse(metadata.created_at);
    if (!Number.isFinite(created)) return null;
    for (const delta of [0, -1, 1]) {
      const date = new Date(created + delta * 86400000).toISOString().slice(0, 10).replaceAll("-", "/");
      const relative = `sessions/${date}`;
      try {
        // A missing UTC-day folder is normal when rollouts use local dates.
        // Check existence separately: safeDirectory intentionally treats missing
        // directories like invalid paths. Keep its link checks before reading.
        await lstat(path.join(this.codexHome, relative));
        const directory = safeDirectory(this.codexHome, relative);
        const names = await readdir(directory);
        const name = names.find(name => name.startsWith("rollout-") && name.endsWith(`-${id}.jsonl`));
        if (name) return path.join(directory, name);
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    return null;
  }

  async read(runDirectory) {
    if (this.pending.has(runDirectory)) return this.pending.get(runDirectory);
    const operation = this.readTimeline(runDirectory);
    this.pending.set(runDirectory, operation);
    try { return await operation; }
    finally { this.pending.delete(runDirectory); }
  }

  async readTimeline(runDirectory) {
    const metadata = JSON.parse(safeReadFile(runDirectory, "run.json"));
    const isPrime = metadata.provider === "prime-agent";
    const isKimi = metadata.provider === "kimi-code";
    const isAntigravity = metadata.provider === "antigravity";
    const isMuse = metadata.provider === "muse-code";
    const isMessagesProvider = ["claude-code", "grok-build", "antigravity"].includes(metadata.provider);
    let model;
    try {
      const catalog = JSON.parse(safeReadFile(runDirectory, "sandbox-state/direct-model-catalog.json"));
      model = catalog.models?.find(model => model.slug === metadata.model);
    } catch { /* Legacy records may not have a frozen model catalog. */ }
    const limits = modelTokenLimits(model);
    let cached = this.cache.get(runDirectory);
    const messagesFile = isAntigravity ? "antigravity-events.jsonl" : metadata.provider === "grok-build" ? "grok-events.jsonl" : "claude-events.jsonl";
    const file = cached?.file || (isPrime ? path.join(runDirectory, "agent-events.jsonl") : isKimi ? findKimiSession(metadata, runDirectory, this.kimiHomes) : isMuse ? await findMuseSession(metadata, this.museHomes) : isMessagesProvider ? path.join(runDirectory, messagesFile) : await this.findRollout(metadata));
    if (isKimi && !file) return kimiTelemetry(createKimiTimeline(), metadata);
    if (isMuse && !file) return museTelemetry(createMuseTimeline());
    if (!file) return { available: false, ...limits, samples: [], compactions: [], reason: `Waiting for ${metadata.provider === "grok-build" ? "Grok Build" : "Codex"} token telemetry.` };
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (!handle && isPrime) return primeTelemetry(createPrimeTimeline(), metadata);
    if (!handle) return { available: false, compaction_threshold: null, samples: [], compactions: [] };
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1) throw new Error("Invalid token telemetry file.");
      if (!cached || cached.inode !== stat.ino || stat.size < cached.offset) {
        cached = { file, inode: stat.ino, offset: 0, partial: "", decoder: new StringDecoder("utf8"), timeline: isPrime ? createPrimeTimeline() : isKimi ? createKimiTimeline() : isMuse ? createMuseTimeline() : isAntigravity ? createAntigravityTimeline() : isMessagesProvider ? createClaudeTimeline() : createTokenTimeline() };
        this.cache.set(runDirectory, cached);
        if (this.cache.size > 12) this.cache.delete(this.cache.keys().next().value);
      }
      const buffer = Buffer.alloc(256 * 1024);
      // Snapshot the current file size; leave incomplete final JSON for the next poll.
      while (cached.offset < stat.size) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, stat.size - cached.offset), cached.offset);
        if (!bytesRead) break;
        cached.offset += bytesRead;
        const text = cached.partial + cached.decoder.write(buffer.subarray(0, bytesRead));
        const lines = text.split("\n");
        cached.partial = lines.pop();
        for (const line of lines) {
          try { (isPrime ? consumePrimeEvent : isKimi ? consumeKimiEvent : isMuse ? consumeMuseEvent : isAntigravity ? consumeAntigravityEvent : isMessagesProvider ? consumeClaudeEvent : consumeTokenEvent)(cached.timeline, JSON.parse(line)); }
          catch { /* A damaged or unrecognized event is not token evidence. */ }
        }
      }
    } finally { await handle.close(); }
    const timeline = cached.timeline;
    if (isPrime) return primeTelemetry(timeline, metadata);
    if (isKimi) return kimiTelemetry(timeline, metadata);
    if (isMuse) return museTelemetry(timeline, metadata.model);
    if (isAntigravity) return antigravityTelemetry(timeline, metadata.model);
    if (isMessagesProvider) {
      const telemetry = claudeTelemetry(timeline, metadata.model);
      return telemetry;
    }
    const latest = timeline.samples.at(-1);
    return {
      available: Boolean(latest), ...limits,
      context_window: timeline.context_window ?? limits.context_window,
      current_tokens: latest?.tokens ?? null, updated_at: latest?.timestamp ?? null,
      total_tokens: timeline.total_tokens,
      ...tokenBilling(timeline, metadata.model, metadata),
      samples: timeline.samples, compactions: timeline.compactions
    };
  }
}
