import test from 'node:test';
import assert from 'node:assert/strict';
import { runCardValues } from '../benchmarking/ui/run-library.mjs';

test('the current Codex owner receives launches and controls without dropping mode or speed', async t => {
  const previousWindow = globalThis.window, previousLocation = globalThis.location;
  t.after(() => { globalThis.window = previousWindow; globalThis.location = previousLocation; });
  const calls = [];
  globalThis.location = { hostname: 'localhost' };
  globalThis.window = { fetch: async (url, options) => {
    calls.push({ url, options });
    assert(url.startsWith('http://localhost:8088/'));
    return Response.json(url.endsWith('/status') ? { version: 2, current_codex_owner: true } : { ok: true });
  } };
  const { benchmarkFetch } = await import('../benchmarking/ui/benchmark-api.mjs?current-codex-routing');
  for (const observation_mode of ['ascii', 'vision']) for (const tools_enabled of [false, true]) {
    const options = { method: 'POST', body: JSON.stringify({ provider: 'codex', model: 'gpt-6.1-terra', observation_mode, tools_enabled, service_tier: 'fast' }) };
    await benchmarkFetch('/api/benchmark/v1/runs', options);
    assert.equal(calls.at(-1).options, options);
  }
  await benchmarkFetch('/api/benchmark/v1/runs/run-existing/pause', { method: 'POST' });
  assert.equal(calls.at(-1).url, 'http://localhost:8088/api/benchmark/v1/runs/run-existing/pause');
  assert.equal(calls.filter(c => c.url.endsWith('/status')).length, 1);
});

test('vision launches use only the image owner and fail closed when it is offline', async t => {
  const previousWindow = globalThis.window, previousLocation = globalThis.location;
  t.after(() => { globalThis.window = previousWindow; globalThis.location = previousLocation; });
  for (const online of [false, true]) {
    const calls = [];
    globalThis.location = { hostname: 'localhost' };
    globalThis.window = { fetch: async (url, options) => {
      calls.push({ url, options });
      if (url === 'http://localhost:8082/api/benchmark/vision/status') {
        if (!online) throw new Error('Connection refused');
        return Response.json({ observation_mode: 'vision' });
      }
      if (url.includes('/capabilities/status')) return Response.json({ version: 2 });
      assert(url.startsWith('http://localhost:8082/'), 'No launch may reach the ASCII or generic capability owner');
      return Response.json({ observation_mode: 'vision' });
    } };
    const { benchmarkFetch } = await import(`../benchmarking/ui/benchmark-api.mjs?vision-routing-test=${online}`);
    for (const suffix of ['runs', 'pairs']) {
      const options = { method: 'POST', body: JSON.stringify({ observation_mode: 'vision', tools_enabled: false }) };
      if (online) {
        const response = await benchmarkFetch('/api/benchmark/v1/' + suffix, options);
        assert.equal((await response.json()).observation_mode, 'vision');
        assert.equal(calls.at(-1).options, options);
      } else {
        await assert.rejects(() => benchmarkFetch('/api/benchmark/v1/' + suffix, options), /Vision runner is unavailable/);
        assert.equal(calls.filter(call => call.options?.method === 'POST').length, 0);
      }
    }
  }
});

test('browser routes reads and controls to the owning companion across recovery upgrades', async t => {
  const previousWindow = globalThis.window, previousLocation = globalThis.location;
  t.after(() => { globalThis.window = previousWindow; globalThis.location = previousLocation; });
  for (const version of [2, 3]) {
    const calls = [];
    const run = { id: 'run-fixture', model: 'deepseek/deepseek-v4.1-flash-1017', provider: 'prime-agent',
      status: 'running', runner_active: true, harness: 'prime-inference-direct-v1', coding_mode: 'off', tools_enabled: false,
      auto_recovery: { managed: true, enabled: true, state: 'watching' } };
    globalThis.location = { hostname: 'localhost' };
    globalThis.window = { fetch: async (url, options) => {
      calls.push({ url, options });
      if(url.startsWith('http://localhost:8084/'))throw new Error('Catalog upgrade not installed');
      assert(url.startsWith('http://localhost:8083/'), 'Do not silently query the non-owning server');
      return Response.json(url.endsWith('/status') ? { available: true, version, prime_auto_recovery: true } : { runs: [run] });
    } };
    const { benchmarkFetch } = await import(`../benchmarking/ui/benchmark-api.mjs?routing-test=${version}`);
    const response = await benchmarkFetch('/api/benchmark/v1/runs?view=library');
    const [result] = (await response.json()).runs, card = runCardValues(result);
    assert.equal(card.statusTone, 'green'); assert.equal(card.tools, '(tools off)');
    const options = { method: 'POST', body: '{}' };
    await benchmarkFetch('/api/benchmark/v1/runs/run-fixture/pause', options);
    const probes = calls.filter(call => call.url.endsWith('/status'));
    assert.equal(new Set(probes.map(call => call.url)).size, probes.length, 'Availability probes are shared by reads and controls');
    assert.equal(calls.at(-1).url, 'http://localhost:8083/api/benchmark/v1/runs/run-fixture/pause');
    assert.equal(calls.at(-1).options, options);
  }
});
