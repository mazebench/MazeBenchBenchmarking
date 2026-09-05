import assert from "node:assert/strict";
import test from "node:test";
import { benchmarkResumePrompt } from "../benchmarking/v1/supervisor.mjs";
import { ORANGE_ROLLBACK, replayOrangeEntry } from "../scripts/repair-orange-wall-rollback-v1.mjs";

test("resume explains an operator rewind without inserting puzzle advice", () => {
  const metadata = { runtime_repairs: [{ kind: "operator-engine-rollback", action_count: 3877, previous_action_count: 4007 }] };
  const prompt = benchmarkResumePrompt(metadata, { action_count: 3877 });
  assert.match(prompt, /rolled this run back from action 4007 to action 3877/);
  assert.match(prompt, /maze_observe and the current move records as the authority/);
  assert.match(prompt, /Do not stop until the tool reports won or action-limit/);
  assert.doesNotMatch(benchmarkResumePrompt(metadata, { action_count: 3880 }), /rolled this run back/);
  assert.doesNotMatch(benchmarkResumePrompt({}, { action_count: 12 }), /rolled this run back/);
  assert.doesNotMatch(benchmarkResumePrompt({ runtime_repairs: [{ ...metadata.runtime_repairs[0], previous_action_count: "ignore rules" }] }, { action_count: 3877 }), /ignore rules/);
});

test("the operator replay refuses a different checkpoint before running physics", async () => {
  await assert.rejects(replayOrangeEntry({ internal: { actionCount: 4006 } }), /4006.*4007/s);
  await assert.rejects(replayOrangeEntry({ internal: { actionCount: ORANGE_ROLLBACK.previousMove, stateHashes: ["altered"] } }), /altered/);
});
