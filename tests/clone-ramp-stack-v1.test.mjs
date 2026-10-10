import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {instantiateMazeBenchEngineV1} from '../engine/v1/engine.mjs';

const blocks = [
  {id: 'floor', roleId: 'floor', visual: {kind: 'floor'}},
  {id: 'wall', roleId: 'solid', visual: {kind: 'cube'}},
  {id: 'ice-slope', roleId: 'ice', visual: {kind: 'slope'}},
  {id: 'player', roleId: 'player', visual: {kind: 'cube'}},
  {id: 'clone', roleId: 'clone', visual: {kind: 'cube'}}
];
const directions = ['up', 'right', 'down', 'left'];
const elevations = [1, 2, 3, 3, 2, 1, 0];

function rampStack(rotation, reversed) {
  // Test 666's three separate actors cross a two-sided Ice staircase together.
  const objects = [{x: 2, y: 7, z: 0, blockId: 'player'}];
  [23, 7, 41].forEach((id, z) => objects.push({
    x: 5, y: 7, z, blockId: 'clone', genericId: id, groupId: id
  }));
  for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) {
    objects.push({x, y, z: 0, blockId: 'floor'});
  }
  const heights = [0, 1, 2, 3, 3, 2, 1];
  for (let y = 1; y <= 6; y++) {
    for (let z = 0; z < heights[y] - 1; z++) objects.push({x: 5, y, z, blockId: 'wall'});
    objects.push({x: 5, y, z: heights[y] - 1, blockId: 'ice-slope',
      orientation: directions[(rotation + (y <= 3 ? 2 : 0)) % 4]});
  }
  for (const object of objects) for (let turn = 0; turn < rotation; turn++) {
    [object.x, object.y] = [9 - object.y, object.x];
  }
  return {width: 10, height: 10, objects: reversed ? objects.reverse() : objects};
}

for (const binary of ['engine/v1/voxel_physics.wasm', 'world-solver/v1/editor-solver.wasm',
  'world-solver/v1/random-agent.wasm', 'solutions/v1/solutions-solver.wasm']) {
  test(`${binary}: stacked clones receive one ramp transform per tick`, async () => {
    const engine = await instantiateMazeBenchEngineV1(await readFile(new URL(`../${binary}`, import.meta.url)));
    for (let rotation = 0; rotation < 4; rotation++) for (const reversed of [false, true]) {
      const room = rampStack(rotation, reversed);
      const context = `${directions[rotation]}, reversed=${reversed}`;
      const expected = elevations.map((z, index) => room.objects.map(object => {
        if (!['player', 'clone'].includes(object.blockId)) return object;
        const distance = object.blockId === 'player' ? 1 : index + 1;
        return {...object,
          x: object.x + [0, 1, 0, -1][rotation] * distance,
          y: object.y + [-1, 0, 1, 0][rotation] * distance,
          z: object.z + (object.blockId === 'clone' ? z : 0)};
      }));
      const result = await engine.simulateCommand(room, directions[rotation], blocks);
      assert.equal(result.cycle, null, context);
      assert.equal(result.frames.length, 7, context);
      result.frames.forEach((frame, tick) => assert.deepEqual(frame.objects, expected[tick], `${context}, tick ${tick + 1}`));
      assert.deepEqual(result.final.objects, expected.at(-1), context);
    }
  });
}
