// node scripts/import-comparison-heatmaps.mjs [http://localhost:3000/]
// Copies only starred leaderboard heatmaps, with their original metadata.
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { importLeaderboardHeatmap } from "../benchmarking/ui/heatmap-import.mjs";

const origin = new URL(process.argv[2] || "http://localhost:3000/").origin;
const sourceKey = createHash("sha256").update(origin).digest("hex").slice(0, 12);
const directory = new URL("../benchmarking/imports/", import.meta.url);
const importedAt = new Date().toISOString();
async function get(path) {
  const response = await fetch(new URL(path, origin), { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}
async function save(name, value) {
  const file = new URL(name, directory), temp = new URL(`${name}.${process.pid}.tmp`, directory);
  await writeFile(temp, `${JSON.stringify(value)}\n`);
  await rename(temp, file);
}
const summaries = [];
for (let page = 1; ; page++) {
  const value = await get(`/api/agent/runs?starred=1&page_size=100&sort=newest&page=${page}`);
  if (!Array.isArray(value.runs)) throw new Error("Source did not return a run list.");
  summaries.push(...value.runs);
  if (page >= (value.pages || 1)) break;
}
await mkdir(directory, { recursive: true });
let previous = { runs: [] };
try { previous = JSON.parse(await readFile(new URL("index.json", directory), "utf8")); }
catch (error) { if (error.code !== "ENOENT") throw error; }
const imported = new Map(previous.runs.map(run => [run.id, run]));
let count = 0;
// Keep source work bounded; older reports can reconstruct missing positions.
for (let offset = 0; offset < summaries.length; offset += 3) {
  const batch = await Promise.allSettled(summaries.slice(offset, offset + 3).map(async summary => {
    const payload = await get(`/api/leaderboard/runs/${encodeURIComponent(summary.id)}`);
    const { metadata, report } = importLeaderboardHeatmap(payload, { origin, importedAt, sourceKey });
    await save(`${metadata.id}.json`, report);
    imported.set(metadata.id, metadata);
    count++;
    console.log(`${metadata.model}: ${report.heatmap.points.length} tiles, ${report.heatmap.total} visits`);
  }));
  for (const result of batch) if (result.status === "rejected") console.error(`Skipped: ${result.reason.message}`);
}
await save("index.json", { version: 1, runs: [...imported.values()] });
console.log(`Imported ${count}/${summaries.length} heatmaps into ${fileURLToPath(directory)}`);
if (count < summaries.length) process.exitCode = 1;
