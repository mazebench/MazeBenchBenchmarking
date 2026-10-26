import { BenchmarkGameRuntime, loadBenchmarkAssets } from './v1/runtime.mjs';
import { verifyRunIntegrity, verifyCheckpoint } from './v1/integrity.mjs';
import { readCheckpointJson } from './v1/checkpoint-json.mjs';
import { readWorldRevision } from './storage/live-world.mjs';

// Execute the signed command history in a private, memory-only runtime. Each
// result must match the authenticated state hash before its frames are exposed.
class ReadOnlyReplayRuntime extends BenchmarkGameRuntime {
  async renderObservation() { return {}; }
  async persist({animationFrames, animationCycle} = {}) {
    this.captured = {cycle: animationCycle, frames: animationFrames.map(frame => ({
      room: frame.room.position.join('x'), camera: frame.camera,
      objects: this.assets.engine.roomFromState(frame.state,frame.room).objects
    }))};
  }
}

export async function openAsciiReplay(root, directory, metadata) {
  await verifyRunIntegrity(root, directory, metadata.integrity); verifyCheckpoint(directory);
  const saved = await readCheckpointJson(directory), assets = await loadBenchmarkAssets(root, directory);
  const live = assets.liveWorld;
  if (live) { live.head = live.base; live.refresh = () => live.head; assets.rooms = live.rooms();
    assets.roomsByFile = new Map(assets.rooms.map(room=>[room.fileName,room]));
    assets.roomsByLabel = new Map(assets.rooms.map(room=>[room.position.join('x').toUpperCase(),room])); }
  const start = assets.roomsByLabel.get(String(metadata.start_room || 'HxI').replace(/[×X]/g,'x').toUpperCase());
  if (!start) throw new Error('The recorded starting room is unavailable.');
  const state = assets.engine.createState(start);
  const internal = {version:1,actionCount:0,actionLimit:null,createdAt:saved.createdAt,updatedAt:saved.createdAt,
    roomFile:start.fileName,state,roomEntryState:structuredClone(state),history:[],actions:[],yaw:0,pitch:1,
    gemsCollected:[],visitedRooms:[start.fileName],roomEntryStates:{[start.fileName]:structuredClone(state)},
    stateHashes:[],noveltyHashes:[],positions:[],deaths:0,resets:0,undos:0,cameraActions:0,blockedActions:0,
    ...(live ? {roomRevision:0,worldRevision:0,roomEntryRevisions:{[start.fileName]:0}} : {})};
  const runtime = new ReadOnlyReplayRuntime(root,directory,assets,internal);
  return { runtime, saved,
    async readMove(move) {
      if (!move) return {action:{action:'initial',totalGems:0},frames:[{room:start.position.join('x'),camera:{yaw:0,pitch:1},objects:assets.engine.roomFromState(state,start).objects}]};
      const expected = this.saved.actions[move-1];
      if (!expected || move !== runtime.internal.actionCount+1) throw new Error('Replay history is not sequential.');
      if (live) live.head = readWorldRevision(directory,expected.worldRevision ?? 0);
      await runtime.apply(expected.action);
      const actual = runtime.internal.actions.at(-1);
      if (!expected.stateHash || actual.stateHash !== expected.stateHash) throw new Error(`3D reconstruction differs from the saved state at move ${move}. Original ASCII records remain available.`);
      return {action:expected,...runtime.captured};
    }
  };
}
