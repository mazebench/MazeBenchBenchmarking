export const X_AXES = {
  moves: 'Moves', responses: 'Responses',
  input_tokens_uncached: 'Uncached input tokens', total_tokens: 'Total tokens',
  cost_usd: 'Estimated API cost (USD)'
};

const count = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
export function progressSeries(entry, axis, metric) {
  if (!Object.hasOwn(X_AXES, axis) || !['gems','rooms'].includes(metric)) return {points:[], estimated:false};
  const exactMoves = axis === 'moves' && Array.isArray(entry.series?.progress) && entry.series.progress.length > 0;
  const source = exactMoves ? entry.series.progress : entry.series?.performance;
  const points = [];
  for (const sample of source || []) {
    if (!count(sample[axis]) || !count(sample[metric])) continue;
    const point = {x:sample[axis], y:sample[metric]};
    if (points.length && point.x < points.at(-1).x) return {points:[], estimated:false};
    points.push(point);
  }
  // Join recorded score changes with straight lines, as in the benchmark comparison.
  const compact = points.filter((point,index) => index === 0 || index === points.length-1 || point.y !== points[index-1].y);
  return {points:compact, estimated:!exactMoves && entry.series?.performance_estimated === true,
    checkpoints:!exactMoves};
}

export function linearPath(points, x, y) {
  return points.map((p,i) => `${i ? 'L' : 'M'}${x(p.x)},${y(p.y)}`).join('');
}
