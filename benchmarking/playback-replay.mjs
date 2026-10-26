// Read-only presentation derivatives; no engine replay or agent observation is
// generated here. Every animated pose is authenticated against recorded frames.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { VisionRuntime } from './vision/runtime.mjs';
import { verifyVisionIntegrity } from './vision/policy.mjs';
import { verifyJournal } from './storage/journal.mjs';
import { V2_WORLD_FORMAT } from '../render/v1/voxel-world-v2.mjs';
import { compileRecordedReplay } from './recorded-replay.mjs';

export class PlaybackReplay {
  constructor(root) { this.root = root; this.cache = new Map(); this.loading = new Map(); }
  async movie(directory) {
    const head = verifyJournal(directory), epoch = `${head.generation}:${head.historyEpoch || head.generation}`;
    const count = head.display.observation_revision;
    const cached = this.cache.get(directory);
    if (cached?.epoch === epoch && cached.action_count >= count) return cached;
    if (this.loading.has(directory)) return this.loading.get(directory);
    const task = (async () => {
      const metadata = JSON.parse(await readFile(path.join(directory, 'run.json'), 'utf8'));
      await verifyVisionIntegrity(this.root, directory, metadata);
      const runtime = await VisionRuntime.open(this.root, directory), assets = runtime.assets;
      const rooms = assets.rooms.map(room => assets.liveWorld?.room(room.fileName, 0) || room);
      const world = { storageFormat: V2_WORLD_FORMAT, columns: [...new Set(rooms.map(room => room.position[0]))].sort(), rows: [...new Set(rooms.map(room => room.position[1]))].sort(),
        roomWidth: assets.roomWidth, roomHeight: assets.roomHeight, rooms, blocks: assets.blocks };
      const movie = await compileRecordedReplay(world, runtime.internal.actionCount, async move => {
        const set = runtime.frameSet(move);
        const index = JSON.parse((await runtime.readRecord(set.animation.index_record)).content);
        const frames = [];
        for (const record of index.frames) {
          const { frame } = await runtime.readRecord(record.record);
          frames.push({ room: record.room, objects: frame.room.objects });
        }
        return { action: move ? set : { action: 'initial', totalGems: 0 }, frames, cycle: index.cycle };
      }, action => {
        const before = assets.rooms.find(room => room.position.join('x') === action.roomBefore);
        return before && assets.liveWorld ? [assets.liveWorld.room(before.fileName, action.roomRevisionBefore ?? 0)] : rooms;
      });
      const after = verifyJournal(directory);
      if (`${after.generation}:${after.historyEpoch || after.generation}` !== epoch) throw new Error('Replay history changed. Reload the player.');
      const value = { epoch, action_count: runtime.internal.actionCount, world, movie };
      this.cache.delete(directory); this.cache.set(directory, value);
      while (this.cache.size > 2) this.cache.delete(this.cache.keys().next().value);
      return value;
    })();
    this.loading.set(directory, task);
    try { return await task; } finally { this.loading.delete(directory); }
  }
  async close() { await Promise.allSettled(this.loading.values()); this.cache.clear(); }
}
