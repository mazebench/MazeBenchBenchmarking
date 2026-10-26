import { createServer } from 'node:http';
import { access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { trustedVisionRequest } from './vision/server.mjs';
import { PlaybackReplay } from './playback-replay.mjs';
import { ReportReader } from './report-reader.mjs';
import { gzipSync } from 'node:zlib';
import { PricingService } from './pricing-service.mjs';
import { RunLibrary } from './run-library.mjs';
import { setImmediate as yieldToIO } from 'node:timers/promises';

export function createPlaybackServer(root, options = {}) {
  const port = options.port ?? 8085, mainPort = options.mainPort || 8080;
  const recordsRoot = options.recordsRoot || process.env.MAZEBENCH_VISION_RECORDS_ROOT || path.join(os.homedir(), 'records/mazebench-vision');
  const recordsRoots = options.recordsRoots || [recordsRoot, process.env.MAZEBENCH_RECORDS_ROOT || path.join(os.homedir(),'records/mazebench-benchmark'),path.join(os.homedir(),'records/mazebench-prime-benchmark')];
  const replays = options.replays || new PlaybackReplay(root);
  const reports = options.reports || new ReportReader();
  const pricing = options.pricing || new PricingService();
  const library = options.library || new RunLibrary();
  const server = createServer(async (req, res) => {
    const reply = (status, value, type = 'application/json') => {
      if (res.destroyed) return;
      let data = Buffer.from(JSON.stringify(value));
      if (data.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) { data = gzipSync(data); res.setHeader('Content-Encoding', 'gzip'); }
      res.writeHead(status, { 'Content-Type': type, 'Content-Length': data.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(data);
    };
    if (!trustedVisionRequest(req, server.address()?.port || port, mainPort)) return reply(403, { error: 'Only trusted localhost requests are accepted.' });
    if (req.headers.origin) { res.setHeader('Access-Control-Allow-Origin', req.headers.origin); res.setHeader('Vary', 'Origin'); }
    if (req.method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS'); return reply(204, ''); }
    if (req.method !== 'GET') return reply(405, { error: 'Playback is read-only.' });
    const url = new URL(req.url, 'http://' + req.headers.host);
    if (url.pathname === '/api/benchmark/playback/status') return reply(200, { available: true, token_pricing: true });
    if (url.pathname === '/api/benchmark/playback/library') {
      const controller = new AbortController();
      res.once('close', () => controller.abort());
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.flushHeaders();
      try {
        for await (const event of library.stream(recordsRoots, controller.signal)) {
          if (res.destroyed) return;
          res.write(JSON.stringify(event) + '\n');
          // Flush each real completion before the next synchronous verification.
          await yieldToIO();
        }
      } catch (error) { if (!res.destroyed) res.write(JSON.stringify({ type: 'error', error: error.message }) + '\n'); }
      if (!res.destroyed) res.end();
      return;
    }
    if (url.pathname === '/api/benchmark/v1/pricing') {
      try { return reply(200, await pricing.refresh(url.searchParams.get('force') === '1')); }
      catch (error) { return reply(503, { error: error.message }); }
    }
    // Read-only reports can be updated independently of processes owning agents.
    const match = /^\/api\/benchmark\/playback\/runs\/(run-[\dTZ-]+-[a-f0-9]{6})\/(movie|chunk)$/.exec(url.pathname)
      || /^\/api\/benchmark\/v1\/runs\/(run-[\dTZ-]+-[a-f0-9]{6})\/(tokens)$/.exec(url.pathname);
    if (!match) return reply(404, { error: 'Unknown playback path.' });
    try {
      let directory = path.join(recordsRoot, match[1]);
      if (!options.replays) {
        directory = null;
        for (const root of recordsRoots) { const candidate=path.join(root,match[1]);try{await access(path.join(candidate,'run.json'));directory=candidate;break;}catch(error){if(error.code!=='ENOENT')throw error;} }
        if (!directory) return reply(404,{error:'Run not found.'});
      }
      return reply(200, match[2] === 'tokens' ? await reports.read(directory, 'tokens')
        : match[2]==='chunk' ? await replays.chunk(directory,Object.fromEntries(url.searchParams)) : await replays.movie(directory));
    } catch (error) { reply(400, { error: error.message }); }
  });
  server.on('close', () => { reports.close(); pricing.close(); });
  server.on('listening', () => { if (options.refreshPricing ?? (!options.replays && !options.reports)) pricing.start(); });
  return { server, replays, reports, pricing };
}
if (process.argv[1] === import.meta.filename) {
  const port = Number(process.env.MAZEBENCH_PLAYBACK_PORT || 8085);
  const { server, replays } = createPlaybackServer(path.resolve(import.meta.dirname, '..'), { port });
  server.listen(port, '127.0.0.1', () => console.log(`MazeBench tween replay ready on localhost:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { server.close(); server.closeAllConnections(); await replays.close(); process.exit(); });
}
