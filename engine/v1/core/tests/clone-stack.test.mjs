import assert from 'node:assert/strict';
import test from 'node:test';
import {rotateVoxelsClockwise, rotateWorldClockwise} from '../../apps/web/app/worldBounds.mjs';
import {project, simulateFrames, simulateFinal, frameDifference} from './helpers/project-engine.mjs';

for (const id of ['test-665', 'test-666']) {
  test(`${id}: stacked clones follow the carrier once per tick regardless of storage or group IDs`, () => {
    const fixture = project.tests.find(t=>t.id===id);
    assert(fixture, `Missing authored regression ${id}`);
    for (const relabel of [false,true]) for (let rotation=0; rotation<4; ++rotation) {
      const world = rotateWorldClockwise(fixture.world,rotation);
      const transform = frame => rotateVoxelsClockwise(frame.voxels,fixture.world,rotation).map(v=>
        relabel && v.blockId==='clone' ? {...v,genericId:71-v.genericId*17,groupId:71-v.genericId*17} : v);
      const original = transform(fixture.start);
      const expected = [...fixture.intermediate,fixture.expected].map(transform);
      for (const order of ['authored','reversed','interleaved']) {
        const start = order==='reversed' ? [...original].reverse() : order==='interleaved'
          ? [...original.filter((_,i)=>i%2),...original.filter((_,i)=>!(i%2))] : original;
        const context = `${rotation*90}°, ${order}, relabel=${relabel}`;
        const frames = simulateFrames(start,rotation,world);
        assert.equal(frames.cycle,null,context);
        assert.equal(frames.length,expected.length,context);
        for (const [i,frame] of expected.entries()) assert.deepEqual(
          frameDifference(frame,frames[i],world),{missing:[],unexpected:[]},`${context}, tick ${i+1}`);
        assert.deepEqual(frameDifference(expected.at(-1),simulateFinal(start,rotation,world),world),
          {missing:[],unexpected:[]},`${context}, final-state API`);
      }
    }
  });
}
