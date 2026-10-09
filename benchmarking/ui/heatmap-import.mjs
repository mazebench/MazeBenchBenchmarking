// Convert the older leaderboard's exact [worldX, worldY, visits] cells.
// These are comparison snapshots, never resumable benchmark records.
export function importLeaderboardHeatmap(payload, { origin, importedAt, sourceKey }) {
  const { run, heatmap } = payload || {};
  if (!run?.id || !run.model_name || !/^level_[A-P]x[A-P]$/i.test(run.level_id || "") || heatmap?.room_size !== 16) {
    throw new Error("Expected a Main World leaderboard heatmap with 16-tile rooms.");
  }
  if (!Array.isArray(heatmap.cells) || !heatmap.cells.length) throw new Error("No recorded heatmap cells.");
  const cells = new Map();
  for (const cell of heatmap.cells) {
    if (!Array.isArray(cell) || cell.length !== 3) throw new Error("Invalid heatmap cell.");
    const [x, y, count] = cell;
    if (![x, y].every(n => Number.isInteger(n) && n >= 0 && n < 256) || !Number.isSafeInteger(count) || count <= 0) {
      throw new Error("Invalid heatmap coordinates or visit count.");
    }
    const key = `${x},${y}`;
    cells.set(key, (cells.get(key) || 0) + count);
  }
  const total = [...cells.values()].reduce((sum, count) => sum + count, 0);
  if (!Number.isSafeInteger(total) || total !== heatmap.total_visits || cells.size !== heatmap.unique_cells) {
    throw new Error("Heatmap totals do not match the recorded cells.");
  }
  const sourceOrigin = new URL(origin).origin;
  const sourceUrl = new URL(run.url, sourceOrigin);
  if (sourceUrl.origin !== sourceOrigin || !["http:", "https:"].includes(sourceUrl.protocol)) throw new Error("Invalid source run URL.");
  const id = `import-${sourceKey}-${encodeURIComponent(run.id)}`;
  const source = { origin: sourceOrigin, run_id: run.id, url: sourceUrl.href, imported_at: importedAt,
    tool_use: run.tool_use || "unknown", visits: "action-endpoints" };
  const metadata = { id, model: run.model_name, provider: run.provider === "claude" ? "claude-code" : run.provider,
    created_at: run.created_at, status: run.status, observation_mode: run.mode === "text" ? "ascii" : run.mode,
    world: "main-world", action_count: run.turns, rooms_visited: run.room_count, gems_collected: run.gem_count, source };
  const points = [...cells].map(([key, count]) => {
    const [worldX, worldY] = key.split(",").map(Number);
    return { worldX, worldY, count };
  });
  return { metadata, report: { action_count: run.turns, heatmap: { points, total, trackedActions: 0 }, source } };
}

export function comparisonCondition(run) {
  return run?.source ? `Tools: ${run.source.tool_use}` : run?.tools_enabled ? "Python on" : "Python off";
}
