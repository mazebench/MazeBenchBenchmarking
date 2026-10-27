import { requestApiCost } from './token-pricing.mjs';

const count = value => Number.isFinite(value) && value >= 0;

// Presentation-only checkpoints. Never interpolate billing totals over moves:
// each usage record is joined to the last retained action at its timestamp.
export function comparisonSeries(summary, records, metadata = {}, priceOptions = {}) {
  const actions = (summary.actions || []).filter(a => Number.isSafeInteger(a.index) && a.index > 0);
  if (!actions.length && summary.action_count > 0) return { progress: [], performance: [], coverage: 'Retained move history is unavailable.' };
  const first = actions[0];
  const initialGems = first && count(first.totalGems) && count(first.gemsCollected)
    ? Math.max(0, first.totalGems - first.gemsCollected) : actions.length ? null : summary.gems_collected || 0;
  const initial = { moves: 0, gems: initialGems, rooms: 1 };
  const progress = [initial];
  for (const a of actions) {
    const point = { moves: a.index, gems: count(a.totalGems) ? a.totalGems : null,
      rooms: count(a.roomsVisited) ? a.roomsVisited : null };
    if (point.gems !== progress.at(-1).gems || point.rooms !== progress.at(-1).rooms || a === actions.at(-1)) progress.push(point);
  }
  const timed = actions.map(a => ({ ...a, timestamp: Date.parse(a.at) })).filter(a => Number.isFinite(a.timestamp)).sort((a,b) => a.timestamp-b.timestamp);
  const usage = records.filter(r => Number.isFinite(r.timestamp) && count((r.usage || r).input_tokens) && count((r.usage || r).output_tokens)).sort((a,b) => a.timestamp-b.timestamp);
  const performance = usage.length ? [{ ...initial, responses: 0, input_tokens_uncached: 0, total_tokens: 0, cost_usd: 0 }] : [];
  let responses = 0, input = 0, total = 0, cost = 0, cursor = 0, action;
  const tiers = [...metadata.service_tier_history || []].sort((a,b) => Date.parse(a.at)-Date.parse(b.at));
  for (const record of usage) {
    while (cursor < timed.length && timed[cursor].timestamp <= record.timestamp) action = timed[cursor++];
    const u = record.usage || record;
    let tier = metadata.service_tier || 'standard';
    for (const change of tiers) if (Date.parse(change.at) <= record.timestamp) tier = change.service_tier || 'standard';
    const dollars = count(u.cost_usd) ? u.cost_usd : requestApiCost(record.model || metadata.model, u,
      { ...priceOptions, timestamp: record.timestamp, service_tier: record.service_tier || tier });
    responses++; input += Math.max(0, u.input_tokens - (u.cached_input_tokens || 0)); total += u.input_tokens + u.output_tokens;
    cost = cost === null || dollars === null ? null : cost + dollars;
    performance.push({ moves: action?.index ?? 0, gems: action?.totalGems ?? initialGems, rooms: action?.roomsVisited ?? 1,
      responses, input_tokens_uncached: input, total_tokens: total, cost_usd: cost });
  }
  // Score changes after the final response use the same recorded spend, e.g. a
  // batch of moves executed by that response. No invented token increments.
  if (performance.length && progress.at(-1).moves > performance.at(-1).moves) performance.push({ ...performance.at(-1), ...progress.at(-1) });
  if (cost === null) for (const point of performance) point.cost_usd = null;
  return { progress, performance, unavailable: usage.length && cost === null ? { cost_usd: 'API price unavailable' } : {}, coverage: 'Recorded responses, including retries. Unreported usage is excluded.' };
}
