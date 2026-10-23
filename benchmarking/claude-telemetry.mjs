import { estimateRequests } from "./token-pricing.mjs";
// Read-only display adapter for Claude Code's stream-json protocol.
const number = value => Number.isFinite(value) && value >= 0 ? value : 0;
const keys = ["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens"];
const empty = () => Object.fromEntries(keys.map(key => [key, 0]));
function usage(value = {}) {
  const cached = number(value.cache_read_input_tokens), writes = number(value.cache_creation_input_tokens);
  return { input_tokens: number(value.input_tokens) + cached + writes, cached_input_tokens: cached,
    cache_write_input_tokens: writes, cache_write_long_input_tokens: number(value.cache_creation?.ephemeral_1h_input_tokens), output_tokens: number(value.output_tokens) };
}
export const createClaudeTimeline = () => ({ requests: new Map(), turns: new Map(), active: new Map(), samples: [], compactions: [], context_window: null });

export function consumeClaudeEvent(timeline, event) {
  const timestamp = Date.parse(event._received_at);
  if (!Number.isFinite(timestamp)) return;
  const turn = event._turn_id || event.session_id;
  const inner = event.type === "stream_event" ? event.event : null;
  if (inner?.type === "message_start") {
    const message = inner.message;
    timeline.active.set(turn, message.id);
    timeline.requests.set(message.id, { response_id: message.id, turn, timestamp, usage: usage(message.usage) });
  } else if (inner?.type === "message_delta") {
    const record = timeline.requests.get(timeline.active.get(turn));
    if (record && Number.isFinite(inner.usage?.output_tokens)) record.usage.output_tokens = inner.usage.output_tokens;
  } else if (event.type === "assistant" && event.message?.id && !timeline.requests.has(event.message.id)) {
    timeline.requests.set(event.message.id, { response_id: event.message.id, turn, timestamp, usage: usage(event.message.usage) });
  } else if (event.type === "system" && event.subtype === "compact_boundary") {
    timeline.compactions.push({ timestamp, before_tokens: event.compact_metadata?.pre_tokens ?? timeline.samples.at(-1)?.tokens ?? null, after_tokens: null });
  } else if (event.type === "result") {
    timeline.turns.set(turn, { usage: usage(event.usage), cost: Number.isFinite(event.total_cost_usd) ? event.total_cost_usd : null });
    const model = Object.values(event.modelUsage || {})[0];
    if (model?.contextWindow) timeline.context_window = model.contextWindow;
  }
  const record = timeline.requests.get(timeline.active.get(turn)) || [...timeline.requests.values()].at(-1);
  if (record && (inner?.type === "message_stop" || event.type === "assistant")) {
    const tokens = record.usage.input_tokens + record.usage.output_tokens;
    if (timeline.samples.at(-1)?.response_id === record.response_id) timeline.samples.pop();
    timeline.samples.push({ timestamp, tokens, response_id: record.response_id });
    const compact = timeline.compactions.at(-1);
    if (compact && compact.after_tokens === null && timestamp > compact.timestamp) compact.after_tokens = tokens;
    if (timeline.samples.length > 5000) timeline.samples = timeline.samples.filter((_, index) => index % 2 === 0 || index === timeline.samples.length - 1);
  }
}

export function claudeTelemetry(timeline, model) {
  const totals = empty();
  for (const { usage } of timeline.turns.values()) for (const key of keys) totals[key] += usage[key];
  for (const record of timeline.requests.values()) if (!timeline.turns.has(record.turn)) for (const key of keys) totals[key] += record.usage[key];
  totals.total_tokens = totals.input_tokens + totals.output_tokens;
  const costs = [...timeline.turns.values()].map(turn => turn.cost).filter(value => value !== null);
  const latest = timeline.samples.at(-1);
  return { available: Boolean(latest), totals: timeline.requests.size || timeline.turns.size ? totals : null,
    total_tokens: totals.total_tokens, current_tokens: latest?.tokens ?? null, updated_at: latest?.timestamp ?? null,
    context_window: timeline.context_window, compaction_threshold: null,
    samples: timeline.samples, compactions: timeline.compactions,
    api_estimate: (() => {
      // Completed-turn totals/costs include hidden compaction requests. Keep them
      // authoritative and add only requests from turns still in progress.
      const active = [...timeline.requests.values()].filter(r => !timeline.turns.has(r.turn));
      const estimate = estimateRequests(active, model);
      const complete = [...timeline.turns.values()];
      if (complete.length && complete.every(t => t.cost !== null) && (!active.length || estimate.usd !== null)) {
        estimate.usd = complete.reduce((sum, t) => sum + t.cost, 0) + (estimate.usd || 0);
        estimate.basis = "Reported API-equivalent costs for completed turns plus estimated active responses. Cached input is counted once. This is not a subscription charge.";
      } else if (complete.length) {
        estimate.usd = null;
        estimate.basis += " Completed-turn cost was not reported.";
      }
      estimate.request_count = timeline.requests.size;
      return estimate;
    })(),
    reason: "Waiting for Claude Code token telemetry." };
}
