import { createServer } from 'node:http';
import { access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { trustedVisionRequest } from './vision/server.mjs';
import { PlaybackReplay } from './playback-replay.mjs';
import { gzipSync } from 'node:zlib';

export function createPlaybackServer(root, options = {}) {
  const port = options.port ?? 8085, mainPort = options.mainPort || 8080;
  const recordsRoot = options.recordsRoot || process.env.MAZEBENCH_VISION_RECORDS_ROOT || path.join(os.homedir(), 'records/mazebench-vision');
  const recordsRoots = options.recordsRoots || [recordsRoot, process.env.MAZEBENCH_RECORDS_ROOT || path.join(os.homedir(),'records/mazebench-benchmark'),path.join(os.homedir(),'records/mazebench-prime-benchmark')];
  const replays = options.replays || new PlaybackReplay(root);
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
    if (url.pathname === '/api/benchmark/playback/status') return reply(200, { available: true });
    const match = /^\/api\/benchmark\/playback\/runs\/(run-[\dTZ-]+-[a-f0-9]{6})\/(movie)$/.exec(url.pathname);
    if (!match) return reply(404, { error: 'Unknown playback path.' });
    try {
      let directory = path.join(recordsRoot, match[1]);
      if (!options.replays) {
        directory = null;
        for (const root of recordsRoots) { const candidate=path.join(root,match[1]);try{await access(path.join(candidate,'run.json'));directory=candidate;break;}catch(error){if(error.code!=='ENOENT')throw error;} }
        if (!directory) return reply(404,{error:'Run not found.'});
      }
      return reply(200, await replays.movie(directory));
    } catch (error) { reply(400, { error: error.message }); }
  });
  return { server, replays };
}
if (process.argv[1] === import.meta.filename) {
  const port = Number(process.env.MAZEBENCH_PLAYBACK_PORT || 8085);
  const { server, replays } = createPlaybackServer(path.resolve(import.meta.dirname, '..'), { port });
  server.listen(port, '127.0.0.1', () => console.log(`MazeBench tween replay ready on localhost:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { server.close(); server.closeAllConnections(); await replays.close(); process.exit(); });
}
