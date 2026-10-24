// Read-only audit: node scripts/catalogue-run-versions.mjs <records-root> <output.json>
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { RunLibrary } from '../benchmarking/run-library.mjs';
import { readRunVersion } from '../benchmarking/run-version.mjs';
const [root, output, ...additionalRoots] = process.argv.slice(2);
if (!root || !output) throw new Error('Usage: <records-root> <output.json>');
const library = new RunLibrary(), runs = [];
for (const recordsRoot of [root, ...additionalRoots]) for (const id of (await readdir(recordsRoot)).filter(id => /^run-[\w-]+$/.test(id)).sort()) {
  const directory = path.join(recordsRoot, id);
  const metadata = JSON.parse(await readFile(path.join(directory, 'run.json'), 'utf8'));
  const {summary} = await library.snapshot(directory);
  runs.push({id,model:metadata.model,provider:metadata.provider || "codex",observation_mode:metadata.observation_mode || "ascii",world:metadata.world || "main-world",actions:summary.action_count,benchmark_version:readRunVersion(directory,metadata,summary)});
}
await writeFile(output, JSON.stringify({schema_version:1,generated_at:new Date().toISOString(),runs},null,2)+'\n');
const counts = {};
for (const {benchmark_version:v} of runs) counts[v.label] = (counts[v.label] || 0) + 1;
console.log(JSON.stringify({runs:runs.length,counts}));
