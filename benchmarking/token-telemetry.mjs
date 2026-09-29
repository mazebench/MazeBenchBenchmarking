// Read-only dashboard telemetry. Never imported by the benchmark agent or MCP.
import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { safeReadFile, safeDirectory } from "./v1/safe-files.mjs";
import { createClaudeTimeline, consumeClaudeEvent, claudeTelemetry } from "./claude-telemetry.mjs";

const finite = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
const PRICING_SOURCE = "https://developers.openai.com/api/docs/pricing";
// Standard USD / 1M tokens, verified against the official table on 2026-09-04.
const PRICES = {
  "gpt-6-astra": [10, 1, 12.5, 50],
  "gpt-5.6-sol": [4, 0.4, 5, 20],
  "gpt-5.6": [4, 0.4, 5, 20],
  "gpt-5.6-terra": [2, 0.2, 2.5, 12],
  "gpt-5.6-luna": [0.2, 0.02, 0.25, 1.2]
};

export function requestApiCost(model, usage) {
  const rates = PRICES[model];
  if (!rates || !finite(usage.input_tokens) || !finite(usage.output_tokens)) return null;
  const cached = Math.min(usage.input_tokens, usage.cached_input_tokens || 0);
  const writes = Math.min(usage.input_tokens - cached, usage.cache_write_input_tokens || 0);
  const fresh = usage.input_tokens - cached - writes;
  const long = usage.input_tokens > 272000;
  return ((fresh * rates[0] + cached * rates[1] + writes * rates[2]) * (long ? 2 : 1) + usage.output_tokens * rates[3] * (long ? 1.5 : 1)) / 1e6;
}

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

function recordUsage(timeline, record) {
  if (!record?.response_id || !finite(record.usage?.input_tokens) || !finite(record.usage?.output_tokens)) return;
  const usage = Object.fromEntries(["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens"].map(key => [key, finite(record.usage[key]) ? record.usage[key] : 0]));
  timeline.usage_records.set(record.response_id, usage);
  if (finite(record.thread_token_usage?.total_tokens)) timeline.total_tokens = record.thread_token_usage.total_tokens;
}

export function tokenBilling(timeline, model) {
  const totals = { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  let estimate = PRICES[model] ? 0 : null;
  for (const usage of timeline.usage_records.values()) {
    for (const key of Object.keys(usage)) totals[key] += usage[key];
    if (estimate !== null) estimate += requestApiCost(model, usage);
  }
  totals.total_tokens = totals.input_tokens + totals.output_tokens;
  const rates = PRICES[model];
  return {
    totals: timeline.usage_records.size ? totals : null,
    api_estimate: {
      usd: timeline.usage_records.size ? estimate : null, currency: "USD", model,
      pricing_date: "2026-09-04", source: PRICING_SOURCE,
      rates_per_million: rates ? { input: rates[0], cached_input: rates[1], cache_writes: rates[2], output: rates[3] } : null,
      request_count: timeline.usage_records.size,
      basis: "Standard API-equivalent token cost, including reported compaction usage and per-request long-context pricing. Not a ChatGPT subscription charge."
    }
  };
}

export function consumeTokenEvent(timeline, event) {
  const timestamp = Date.parse(event.timestamp);
  if (!Number.isFinite(timestamp)) return;
  const payload = event.payload || {};
  if (event.type === "compacted") {
    timeline.compactions.push({ timestamp, before_tokens: timeline.samples.at(-1)?.tokens ?? null, after_tokens: null });
    recordUsage(timeline, payload.latest_token_usage_record);
  } else if (event.type === "token_usage_record") {
    recordUsage(timeline, payload);
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
  constructor({ codexHome = path.join(os.homedir(), ".codex") } = {}) {
    this.codexHome = codexHome;
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
    const isMessagesProvider = ["claude-code", "grok-build"].includes(metadata.provider);
    let model;
    try {
      const catalog = JSON.parse(safeReadFile(runDirectory, "sandbox-state/direct-model-catalog.json"));
      model = catalog.models?.find(model => model.slug === metadata.model);
    } catch { /* Legacy records may not have a frozen model catalog. */ }
    const limits = modelTokenLimits(model);
    let cached = this.cache.get(runDirectory);
    const messagesFile = metadata.provider === "grok-build" ? "grok-events.jsonl" : "claude-events.jsonl";
    const file = cached?.file || (isMessagesProvider ? path.join(runDirectory, messagesFile) : await this.findRollout(metadata));
    if (!file) return { available: false, ...limits, samples: [], compactions: [], reason: `Waiting for ${metadata.provider === "grok-build" ? "Grok Build" : "Codex"} token telemetry.` };
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (!handle) return { available: false, compaction_threshold: null, samples: [], compactions: [] };
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1) throw new Error("Invalid token telemetry file.");
      if (!cached || cached.inode !== stat.ino || stat.size < cached.offset) {
        cached = { file, inode: stat.ino, offset: 0, partial: "", decoder: new StringDecoder("utf8"), timeline: isMessagesProvider ? createClaudeTimeline() : createTokenTimeline() };
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
          try { (isMessagesProvider ? consumeClaudeEvent : consumeTokenEvent)(cached.timeline, JSON.parse(line)); }
          catch { /* A damaged or unrecognized event is not token evidence. */ }
        }
      }
    } finally { await handle.close(); }
    const timeline = cached.timeline;
    if (isMessagesProvider) {
      const telemetry = claudeTelemetry(timeline);
      if (metadata.provider === "grok-build") {
        telemetry.api_estimate.basis = "Grok Build's reported API-equivalent cost for completed turns. Active-turn cost is pending; this is not a grok.com subscription charge. Context tokens update after model responses; Grok Build's automatic compaction threshold is not reported.";
        telemetry.reason = "Waiting for Grok Build token telemetry.";
      }
      return telemetry;
    }
    const latest = timeline.samples.at(-1);
    return {
      available: Boolean(latest), ...limits,
      context_window: timeline.context_window ?? limits.context_window,
      current_tokens: latest?.tokens ?? null, updated_at: latest?.timestamp ?? null,
      total_tokens: timeline.total_tokens,
      ...tokenBilling(timeline, metadata.model),
      samples: timeline.samples, compactions: timeline.compactions
    };
  }
}
