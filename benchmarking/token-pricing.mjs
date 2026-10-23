// Dashboard-only API-equivalent estimates. Input is inclusive of cache reads/writes.
// Rates verified 2026-10-23; never used to bill or configure an agent.
const sources = {
  openai: 'https://developers.openai.com/api/docs/pricing',
  kimi: 'https://platform.kimi.ai/docs/pricing/chat',
  claude: 'https://platform.claude.com/docs/en/about-claude/pricing',
  gemini: 'https://ai.google.dev/gemini-api/docs/pricing',
  grok: 'https://docs.x.ai/developers/pricing',
  muse: 'https://dev.meta.ai/docs/pricing-rate-limits'
};
const catalog = new Map();
function add(ids, source, rates, extra = {}) {
  for (const id of ids.split(',')) catalog.set(id, { source: sources[source], rates, ...extra });
}
const openaiLong = { threshold: 272000, input_multiplier: 2, output_multiplier: 1.5 };
add('gpt-6-astra', 'openai', [10, 1, 12.5, 50, 25], { long: openaiLong });
add('gpt-6.1-sol', 'openai', [2, .1, 2.5, 10, 5], { long: openaiLong });
add('gpt-6-sol', 'openai', [2, .2, 2.5, 10, 5], { long: openaiLong });
add('gpt-6-luna', 'openai', [.1, .01, .125, .5, .25], { long: openaiLong });
add('gpt-5.6,gpt-5.6-sol', 'openai', [4, .4, 5, 20, 10], { long: openaiLong });
add('gpt-5.6-terra', 'openai', [2, .2, 2.5, 12, 5], { long: openaiLong });
add('gpt-5.6-luna', 'openai', [.2, .02, .25, 1.2, .5], { long: openaiLong });
add('k3.1-pro,kimi-k3.1-pro', 'kimi', [2, .2, 2, 10, 4]);
add('k3.1-pro-highspeed,kimi-k3.1-pro-highspeed', 'kimi', [4, .2, 4, 20, 8]);
add('kimi-k3', 'kimi', [3, .3, 3, 15, 6]);
add('claude-fable-5.1,claude-mythos-5.1', 'claude', [10, .25, 12.5, 50, 20]);
add('claude-fable-5,claude-mythos-5', 'claude', [10, 1, 12.5, 50, 20]);
add('claude-opus-5.5', 'claude', [4, .2, 5, 20, 8]);
add('claude-sonnet-5', 'claude', [2, .2, 2.5, 10, 4]);
add('claude-haiku-5.5', 'claude', [.1, .01, .125, .5, .2], { long: { threshold: 100000, input_multiplier: 5, output_multiplier: 5 } });
add('claude-sonnet-5.5', 'claude', [2, .1, 2.5, 10, 4]);
add('claude-opus-5,claude-opus-4.8,claude-opus-4.7,claude-opus-4.6,claude-opus-4.5', 'claude', [5, .5, 6.25, 25, 10]);
add('gemini-4-argon', 'gemini', [2, .1, 2, 10], { changes: [{ at: Date.parse('2026-12-01'), rates: [4, .2, 4, 20] }] });
add('gemini-3.8-flash', 'gemini', [.75, .075, .75, 3.75], { changes: [{ at: Date.parse('2027-01-01'), rates: [1.5, .15, 1.5, 7.5] }] });
add('grok-4.7,grok-4.6', 'grok', [2, .5, 2, 6], { long: { threshold: 199999, input_multiplier: 2, output_multiplier: 2 } });
add('muse-spark-1.1,muse-spark-1.2,muse-spark-1.3', 'muse', [1.25, .15, 1.25, 4.25]);
add('muse-spark-1.2-contributor,muse-spark-1.3-contributor', 'muse', [.1, .002, .1, .2]);
add('muse-wonder-1.0', 'muse', [4, .2, 4, 20]);

export function pricingFor(model, timestamp = Date.now()) {
  const id = String(model || '').replace(/^(claude-[a-z]+-)([45])-([0-9]+)$/, "$1$2.$3").replace(/^gemini-(.*)-(low|medium|high)$/, 'gemini-$1');
  const value = catalog.get(id);
  if (!value) return null;
  let rates = value.rates;
  for (const change of value.changes || []) if (timestamp >= change.at) rates = change.rates;
  return { ...value, rates, model: id };
}
const count = value => Number.isFinite(value) && value >= 0 ? value : 0;
export function requestApiCost(model, usage, options = {}) {
  const price = options.price || pricingFor(model, options.timestamp);
  if (!price || !Number.isFinite(usage?.input_tokens) || !Number.isFinite(usage?.output_tokens)) return null;
  const [input, cachedRate, writeRate, output, longWriteRate = writeRate] = price.rates;
  const cached = Math.min(usage.input_tokens, count(usage.cached_input_tokens));
  const writes = Math.min(usage.input_tokens - cached, count(usage.cache_write_input_tokens));
  const longWrites = Math.min(writes, count(usage.cache_write_long_input_tokens));
  if (cached && cachedRate == null || writes && writeRate == null) return null;
  const long = price.long && usage.input_tokens > price.long.threshold;
  return ((usage.input_tokens - cached - writes) * input + cached * (cachedRate || 0) +
    (writes - longWrites) * (writeRate || 0) + longWrites * (longWriteRate || 0)) * (long ? price.long.input_multiplier : 1) / 1e6 +
    usage.output_tokens * output * (long ? price.long.output_multiplier : 1) / 1e6;
}
export function estimateRequests(records, model, options = {}) {
  const rows = [...records], price = options.price || pricingFor(model, options.timestamp);
  let usd = rows.length ? 0 : null, unpriced = 0;
  for (const record of rows) {
    const cost = requestApiCost(record.model || model, record.usage || record, { ...options, timestamp: record.timestamp ?? options.timestamp });
    if (cost === null) unpriced++; else usd += cost;
  }
  const rates = price?.rates;
  return { usd: unpriced ? null : usd, currency: 'USD', model, pricing_date: '2026-10-23',
    source: price?.source || null, request_count: rows.length, unpriced_requests: unpriced,
    rates_per_million: rates ? { input: rates[0], cached_input: rates[1], cache_writes: rates[2], output: rates[3], long_cache_writes: rates[4] ?? rates[2] } : null,
    long_context: price?.long || null,
    basis: 'Standard API-equivalent token estimate, including reported cache reads and writes. Subscription charges, sandbox fees and unreported usage are excluded.' +
      (unpriced ? ' A verified price is missing for some usage; no complete dollar estimate is available.' : '') };
}
