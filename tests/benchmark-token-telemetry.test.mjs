import assert from "node:assert/strict";
import { appendFile, mkdtemp, mkdir, writeFile, rm, symlink, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { modelTokenLimits, createTokenTimeline, consumeTokenEvent, TokenTelemetry, requestApiCost, tokenBilling } from "../benchmarking/token-telemetry.mjs";

const sample = (tokens, timestamp = "2026-09-04T19:30:00Z") => ({ timestamp, type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { total_tokens: tokens }, total_token_usage: { total_tokens: 9_000_000 }, model_context_window: 258400 } } });

test("rollout discovery skips absent date folders and still rejects directory links", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "mazebench-rollout-test-"));
  try {
    const metadata = { codex_thread_id: "01a06de5-cf11-7883-9f85-b1197dd668f5", created_at: "2026-09-04T01:00:00Z" };
    const telemetry = new TokenTelemetry({ codexHome: home });
    assert.equal(await telemetry.findRollout(metadata), null);
    const previous = path.join(home, "sessions/2026/09/03");
    await mkdir(previous, { recursive: true });
    const file = path.join(previous, `rollout-local-${metadata.codex_thread_id}.jsonl`);
    await writeFile(file, "");
    assert.equal(await telemetry.findRollout(metadata), await realpath(file));
    await symlink(previous, path.join(home, "sessions/2026/09/04"), "dir");
    await assert.rejects(telemetry.findRollout(metadata), /symbolic links/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("API estimates count cached tokens once, price each request's context tier and include compaction once", () => {
  const usage = { input_tokens: 200000, cached_input_tokens: 150000, output_tokens: 10000, reasoning_output_tokens: 8000 };
  assert(Math.abs(requestApiCost("gpt-6-astra", usage) - 1.15) < 1e-9);
  assert(Math.abs(requestApiCost("gpt-6-astra", { input_tokens: 1e6, cached_input_tokens: 600000, cache_write_input_tokens: 100000, output_tokens: 20000 }) - 11.2) < 1e-9);
  assert.equal(requestApiCost("unknown-model", usage), null);
  const timeline = createTokenTimeline();
  const payload = { response_id: "one", usage };
  consumeTokenEvent(timeline, { type: "token_usage_record", timestamp: "2026-09-04T19:30:00Z", payload });
  consumeTokenEvent(timeline, { type: "compacted", timestamp: "2026-09-04T19:31:00Z", payload: { latest_token_usage_record: payload } });
  consumeTokenEvent(timeline, { type: "token_usage_record", timestamp: "2026-09-04T19:32:00Z", payload: { response_id: "two", usage } });
  const billing = tokenBilling(timeline, "gpt-6-astra");
  assert.equal(billing.totals.input_tokens, 400000);
  assert.equal(billing.totals.cached_input_tokens, 300000);
  assert.equal(billing.totals.output_tokens, 20000);
  assert.equal(billing.totals.total_tokens, 420000);
  assert.equal(billing.api_estimate.request_count, 2);
  assert(Math.abs(billing.api_estimate.usd - 2.3) < 1e-9); // Combined input must not trigger the long tier.
});

test("context chart uses the last model context and Codex's actual compaction threshold", () => {
  assert.deepEqual(modelTokenLimits({ context_window: 272000, effective_context_window_percent: 95 }), { compaction_threshold: 244800, context_window: 258400 });
  assert.equal(modelTokenLimits({ context_window: 272000, auto_compact_token_limit: 100000 }).compaction_threshold, 100000);
  assert.equal(modelTokenLimits({ context_window: 272000, auto_compact_token_limit: 999999 }).compaction_threshold, 244800);
  assert.deepEqual(modelTokenLimits(), { compaction_threshold: null, context_window: null });
  const timeline = createTokenTimeline();
  consumeTokenEvent(timeline, sample(253433));
  consumeTokenEvent(timeline, { timestamp: "2026-09-04T19:31:00Z", type: "compacted", payload: { replacement_history: [{ secret: "never expose" }] } });
  consumeTokenEvent(timeline, sample(9749, "2026-09-04T19:31:01Z"));
  assert.deepEqual(timeline.samples.map(value => value.tokens), [253433, 9749]);
  assert.equal(timeline.compactions[0].before_tokens, 253433);
  assert.equal(timeline.compactions[0].after_tokens, 9749);
  assert(!JSON.stringify(timeline).includes("secret"));
});

test("live token telemetry reads appended events once, tolerates partial lines and never returns transcript content", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mazebench-token-test-"));
  try {
    const run = path.join(root, "run");
    const home = path.join(root, "codex");
    const id = "01a06de5-cf11-7883-9f85-b1197dd668f5";
    const sessions = path.join(home, "sessions/2026/09/04");
    await mkdir(sessions, { recursive: true });
    await mkdir(path.join(run, "sandbox-state"), { recursive: true });
    await writeFile(path.join(run, "run.json"), JSON.stringify({ model: "gpt-6-astra", codex_thread_id: id, created_at: "2026-09-04T19:29:31Z" }));
    await writeFile(path.join(run, "sandbox-state/direct-model-catalog.json"), JSON.stringify({ models: [{ slug: "gpt-6-astra", context_window: 272000 }] }));
    const file = path.join(sessions, `rollout-2026-09-04T13-29-32-${id}.jsonl`);
    const second = JSON.stringify(sample(200, "2026-09-04T19:31:00Z"));
    await writeFile(file, `${JSON.stringify(sample(100))}\n${second.slice(0, 50)}`);
    const telemetry = new TokenTelemetry({ codexHome: home });
    const first = await telemetry.read(run);
    assert.equal(first.current_tokens, 100);
    assert.equal(first.compaction_threshold, 244800);
    await appendFile(file, `${second.slice(50)}\n${JSON.stringify({ timestamp: "2026-09-04T19:32:00Z", type: "response_item", payload: { text: "private-transcript" } })}\n`);
    const results = await Promise.all([telemetry.read(run), telemetry.read(run)]);
    for (const result of results) {
      assert.equal(result.current_tokens, 200);
      assert.equal(result.samples.length, 2);
      assert(!JSON.stringify(result).includes("private-transcript"));
    }
    await writeFile(file, `${JSON.stringify(sample(50))}\n`);
    assert.equal((await telemetry.read(run)).samples.length, 1);
    assert.equal((await telemetry.read(run)).current_tokens, 50);
  } finally { await rm(root, { recursive: true, force: true }); }
});
