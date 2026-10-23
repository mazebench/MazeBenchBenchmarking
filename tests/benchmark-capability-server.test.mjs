import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createCapabilityServer } from '../benchmarking/capability-server.mjs';
import { POLICY } from '../benchmarking/all-code/policy.mjs';
test('companion preserves existing run owner and dispatches new Any language runs separately', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'maze-capabilities-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const existing = 'run-2026-10-23T00-00-00-000Z-aaaaaa', added = 'run-2026-10-23T00-00-00-000Z-bbbbbb';
  const calls = [], launches = [], stops = [];
  for (const [id, policy] of [[existing, 'old'], [added, POLICY]]) {
    await mkdir(path.join(root, id));
    await writeFile(path.join(root, id, 'integrity.json'), JSON.stringify({ configuration: { code_policy: policy } }));
    await writeFile(path.join(root, id, 'run.json'), JSON.stringify({ id, status: 'running', coding_mode: policy === POLICY ? 'any' : 'off' }));
  }
  const upstream = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    calls.push({ path: req.url, method: req.method, body });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url.startsWith('/api/benchmark/v1/runs?') ? { runs: [
      { id: existing, status: 'running', runner_active: true, action_count: 42 },
      { id: added, status: 'interrupted', runner_active: false, action_count: 9 }
    ] } : { owner: 'original', body: body ? JSON.parse(body) : null }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const supervisor = { active: new Map([[added, {}]]), runDirectory: id => path.join(root, id),
    launch: async spec => { launches.push(spec); return { owner: 'new', ...spec }; },
    stop: async id => { stops.push(id); return { owner: 'new' }; } };
  const { server, reports } = createCapabilityServer(process.cwd(), { port: 0, mainPort: upstream.address().port, supervisor });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); server.close(); await reports.close(); });
  const base = `http://127.0.0.1:${server.address().port}`, prefix = '/api/benchmark/v1';
  const get = async url => { const r = await fetch(base + url); assert.equal(r.status, 200); return r.json(); };
  const post = async (url, body = {}) => { const r = await fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); assert(r.ok); return r.json(); };
  const list = await get(prefix + '/runs?view=library');
  assert.equal(list.runs[0].runner_active, true); assert.equal(list.runs[0].action_count, 42);
  assert.equal(list.runs[1].runner_active, true); assert.equal(list.runs[1].status, 'running');
  assert.equal((await post(prefix + '/runs', { provider: 'kimi-code', coding_mode: 'any' })).owner, 'new');
  assert.equal((await post(prefix + '/runs', { provider: 'kimi-code', coding_mode: 'python' })).owner, 'original');
  assert.equal((await post(prefix + '/runs', { provider: 'codex', coding_mode: 'any' })).owner, 'original');
  await post(prefix + '/runs/' + existing + '/stop'); await post(prefix + '/runs/' + added + '/stop');
  assert.deepEqual(stops, [added]); assert.equal(launches.length, 1);
  assert(calls.some(c => c.path === prefix + '/runs/' + existing + '/stop'));
  assert(!calls.some(c => c.path === prefix + '/runs/' + added + '/stop'));
  assert.equal((await fetch(base + '/api/benchmark/capabilities/status', { headers: { origin: 'https://other.example' } })).status, 403);
});
