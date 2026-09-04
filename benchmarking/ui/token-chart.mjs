const chart = document.getElementById("token-chart");
const current = document.getElementById("token-current");
const detail = document.getElementById("token-detail");
const tooltip = document.getElementById("token-tooltip");
const id = new URLSearchParams(location.search).get("id");
const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const short = value => value >= 1000 ? `${(value / 1000).toFixed(value >= 100000 ? 0 : 1)}k` : String(Math.round(value));
const clock = value => new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const left = 62, right = 1070, top = 22, bottom = 185;
let data = null;
let busy = false;

function elapsed(ms) {
  const minutes = Math.max(0, ms) / 60000;
  return minutes < 1 ? `${Math.round(minutes * 60)}s` : `${Math.round(minutes)}m`;
}

function render(value) {
  data = value;
  const totals = value.totals;
  for (const [id, key] of [["token-total-input", "input_tokens"], ["token-total-cached", "cached_input_tokens"], ["token-total-output", "output_tokens"]]) {
    document.getElementById(id).textContent = totals ? number.format(totals[key]) : "—";
  }
  document.getElementById("token-cache-rate").textContent = totals?.input_tokens ? `${Math.round(totals.cached_input_tokens / totals.input_tokens * 100)}% of input cached` : "—";
  const pricing = value.api_estimate;
  document.getElementById("token-api-cost").textContent = pricing?.usd != null ? `≈ $${pricing.usd.toFixed(2)}` : "Unavailable";
  const rates = pricing?.rates_per_million;
  document.getElementById("token-pricing-detail").textContent = rates
    ? `${pricing.basis} Rates checked ${pricing.pricing_date}: $${rates.input} input, $${rates.cached_input} cached input, $${rates.cache_writes} cache writes, and $${rates.output} output per million tokens. Requests over 272,000 input tokens use 2× input/cache rates and 1.5× output rates. ${pricing.request_count} reported responses counted, with duplicate records removed. Unreported usage and non-token fees are excluded.`
    : "No verified API price or detailed usage is available for this record.";
  if (!value.available || !value.samples.length) {
    current.textContent = "Waiting for token data";
    chart.innerHTML = '<text x="550" y="110" text-anchor="middle" class="token-empty">Token usage appears after the first model response.</text>';
    detail.textContent = "Updates after each model response.";
    return;
  }
  const samples = value.samples;
  const start = samples[0].timestamp;
  const end = Math.max(start + 1000, samples.at(-1).timestamp);
  const max = Math.max(1, value.context_window || 0, value.compaction_threshold || 0, ...samples.map(s => s.tokens)) * 1.08;
  const x = time => left + (time - start) / (end - start) * (right - left);
  const y = tokens => bottom - tokens / max * (bottom - top);
  // Hold each reported value until the next report; a compaction is a drop,
  // not a gradual decrease during the time spent waiting for its response.
  const points = samples.flatMap((sample, index) => [
    ...(index ? [`${x(sample.timestamp).toFixed(1)},${y(samples[index - 1].tokens).toFixed(1)}`] : []),
    `${x(sample.timestamp).toFixed(1)},${y(sample.tokens).toFixed(1)}`
  ]).join(" ");
  const grid = Array.from({ length: 5 }, (_, index) => {
    const tokens = index * max / 4;
    return `<line x1="${left}" x2="${right}" y1="${y(tokens)}" y2="${y(tokens)}" class="token-grid"/><text x="${left - 10}" y="${y(tokens) + 4}" text-anchor="end" class="token-axis">${short(tokens)}</text>`;
  }).join("");
  const ticks = Array.from({ length: 6 }, (_, index) => {
    const time = start + index / 5 * (end - start);
    return `<text x="${x(time)}" y="205" text-anchor="middle" class="token-axis">${elapsed(time - start)}</text>`;
  }).join("");
  const threshold = value.compaction_threshold;
  const trigger = threshold === null ? "" : `<rect x="${left}" y="${top}" width="${right - left}" height="${Math.max(0, y(threshold) - top)}" class="token-warning-band"/><line x1="${left}" x2="${right}" y1="${y(threshold)}" y2="${y(threshold)}" class="token-trigger-line"/><text x="${right}" y="${y(threshold) - 7}" text-anchor="end" class="token-trigger-text">Compact at ${number.format(threshold)}</text>`;
  const markers = value.compactions.map((event, index) => {
    const px = x(event.timestamp);
    if (px < left || px > right) return "";
    return `<line x1="${px}" x2="${px}" y1="${top}" y2="${bottom}" class="token-compaction-line"/><circle cx="${px}" cy="${y(event.after_tokens ?? 0)}" r="4" class="token-compaction-dot"><title>Compaction ${index + 1}: ${event.before_tokens ?? "unknown"} → ${event.after_tokens ?? "pending"} tokens</title></circle>`;
  }).join("");
  chart.innerHTML = `<defs><linearGradient id="token-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="#62d9ef" stop-opacity="0.2"/><stop offset="100%" stop-color="#62d9ef" stop-opacity="0.01"/></linearGradient></defs>${grid}${trigger}<polygon points="${left},${bottom} ${points} ${x(samples.at(-1).timestamp)},${bottom}" fill="url(#token-fill)"/><polyline points="${points}" class="token-series"/>${markers}<circle cx="${x(samples.at(-1).timestamp)}" cy="${y(value.current_tokens)}" r="4" class="token-current-dot"/>${ticks}<text x="550" y="224" text-anchor="middle" class="token-axis">Elapsed since first token report</text><line id="token-crosshair" y1="${top}" y2="${bottom}" class="token-crosshair" visibility="hidden"/>`;
  current.textContent = threshold === null
    ? `${number.format(value.current_tokens)} context tokens`
    : `${number.format(value.current_tokens)} / ${number.format(threshold)} · ${Math.round(value.current_tokens / threshold * 100)}% of trigger`;
  current.classList.toggle("near-compaction", threshold !== null && value.current_tokens >= threshold * 0.85);
  const count = value.compactions.length;
  detail.textContent = `${count} compaction${count === 1 ? "" : "s"} · Last reported ${clock(value.updated_at)}`;
  chart.setAttribute("aria-label", `${current.textContent}. ${detail.textContent}. Context tokens over elapsed run time.`);
}

chart.addEventListener("pointermove", event => {
  if (!data?.samples?.length) return;
  const bounds = chart.getBoundingClientRect();
  const px = (event.clientX - bounds.left) / bounds.width * 1100;
  const start = data.samples[0].timestamp;
  const end = Math.max(start + 1000, data.samples.at(-1).timestamp);
  const time = start + Math.max(0, Math.min(1, (px - left) / (right - left))) * (end - start);
  const sample = data.samples.reduce((best, value) => Math.abs(value.timestamp - time) < Math.abs(best.timestamp - time) ? value : best);
  tooltip.textContent = `${clock(sample.timestamp)} · ${number.format(sample.tokens)} context tokens`;
  tooltip.hidden = false;
  tooltip.style.left = `${Math.max(8, Math.min(bounds.width - 250, event.clientX - bounds.left + 12))}px`;
  const cursor = chart.querySelector("#token-crosshair");
  const cx = left + (sample.timestamp - start) / (end - start) * (right - left);
  cursor.setAttribute("x1", cx);
  cursor.setAttribute("x2", cx);
  cursor.setAttribute("visibility", "visible");
});
chart.addEventListener("pointerleave", () => {
  tooltip.hidden = true;
  chart.querySelector("#token-crosshair")?.setAttribute("visibility", "hidden");
});

async function refresh() {
  if (busy || !id || document.hidden) return;
  busy = true;
  try {
    const response = await fetch(`/api/benchmark/v1/runs/${encodeURIComponent(id)}/tokens`);
    if (!response.ok) throw new Error("Token telemetry unavailable");
    render(await response.json());
  } catch {
    detail.textContent = "Token telemetry unavailable · retrying…";
  } finally { busy = false; }
}
document.addEventListener("visibilitychange", refresh);
await refresh();
setInterval(refresh, 3000);
