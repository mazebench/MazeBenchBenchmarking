// Display-only adapter. Never imported into the agent's frozen runtime.
import { createClaudeTimeline, consumeClaudeEvent, claudeTelemetry } from "./claude-telemetry.mjs";
export const createAntigravityTimeline = createClaudeTimeline;
export function consumeAntigravityEvent(timeline, event) {
  const step = event.step_update;
  if (step?.state !== "DONE" || step.step_type !== "agent_response" || !step.usage) return;
  const id = step.conversation_id + ":" + step.step_index;
  if (timeline.requests.has(id)) return; // Resume may replay older steps.
  const usage = step.usage;
  consumeClaudeEvent(timeline, { type: "assistant", _received_at: event._received_at, _turn_id: step.conversation_id,
    message: { id, usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens,
      cache_read_input_tokens: usage.cache_read_tokens } } });
  // result.usage is conversation-cumulative; never add it to per-step totals.
}
export function antigravityTelemetry(timeline) {
  const value = claudeTelemetry(timeline);
  value.api_estimate.basis = "Antigravity's reported response token counts. Google subscription usage is not an API charge; no dollar estimate is available. Automatic compaction threshold and context-window size are not reported.";
  value.reason = "Waiting for Gemini token telemetry.";
  return value;
}

