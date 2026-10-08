import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const wasm = await readFile(new URL('../../apps/web/public/physics/voxel_physics.wasm', import.meta.url));
const voxel = (id, x, y, z, role, value = -1) => ({ id, x, y, z, role, value });
const floor = () => Array.from({ length: 35 }, (_, i) => voxel(`floor-${i}`, i % 7, Math.floor(i / 7), 0, 'floor'));
const byId = (frame, id) => frame.find(v => v.id === id);
const walls = frame => frame.filter(v => v.role === 'orange-wall');
const reorder = (voxels, order) => order === 'reversed' ? [...voxels].reverse()
  : order === 'interleaved' ? [...voxels.filter((_, i) => i % 2), ...voxels.filter((_, i) => i % 2 === 0)] : voxels;

async function engineForTest() {
  const { instance: { exports: engine } } = await WebAssembly.instantiate(wasm, {});
  const role = name => {
    const bytes = new TextEncoder().encode(name);
    new Uint8Array(engine.memory.buffer, engine.role_buffer(), bytes.length).set(bytes);
    return engine.role_code(bytes.length);
  };
  return (voxels, direction) => {
    const buffer = new Int32Array(engine.memory.buffer, engine.voxel_buffer(), voxels.length * 5);
    const write = () => voxels.forEach((v, i) => buffer.set([v.x, v.y, v.z, role(v.role), v.value], i * 5));
    const read = () => voxels.map((v, i) => ({ ...v, x: buffer[i * 5], y: buffer[i * 5 + 1], z: buffer[i * 5 + 2], value: buffer[i * 5 + 4] }));
    write();
    engine.reset_command();
    const frames = [];
    let lastTick = 0;
    for (let i = 0; i < 100; i++) {
      const status = engine.step_command_tick(voxels.length, 7, 5, direction);
      assert(status >= 0, `invalid tick status ${status}`);
      if (engine.command_tick() > lastTick) {
        frames.push(read());
        lastTick = engine.command_tick();
      }
      if (status === 0) {
        const final = read();
        write();
        assert.equal(engine.simulate_turn(voxels.length, 7, 5, direction), 0);
        assert.deepEqual(read(), final, 'fast command and animated ticks must agree');
        return { frames, final };
      }
    }
    assert.fail('orange wall command did not finish');
  };
}

for (const order of ['original', 'reversed', 'interleaved']) {
  for (const height of [2, 3]) {
    test(`height-${height} orange wall moves a wide stacked rider atomically (${order})`, async () => {
      const run = await engineForTest();
      let scene = [voxel('player', 0, 2, 1, 'player'), voxel('button', 0, 1, 1, 'orange-button', 0), ...floor()];
      for (let x = 2; x <= 3; x++) {
        for (let z = 1; z <= height; z++) scene.push(voxel(`wall-${x}-${z}`, x, 2, z, 'orange-wall', 0));
        scene.push(voxel(`body-${x}`, x, 2, height + 1, 'weightless-pushable', 17));
      }
      scene.push(voxel('passenger', 3, 2, height + 2, 'pushable'));
      scene = reorder(scene, order);
      for (const [direction, depth] of [[0, 1], [2, 0], [0, 1], [2, 0]]) {
        const { frames, final } = run(scene, direction);
        assert.equal(frames.length, 2, 'input and a single simultaneous actuator tick');
        assert(walls(final).every(v => v.value === depth), 'every connected wall voxel must advance');
        assert(walls(final).every(v => v.z === Number(v.id.split('-').at(-1))), 'raised anchors stay fixed');
        for (const x of [2, 3]) assert.equal(byId(final, `body-${x}`).z, height + 1 - depth);
        assert.equal(byId(final, 'passenger').z, height + 2 - depth);
        scene = final;
      }
    });
  }

  for (const rising of [false, true]) {
    test(`pushing a wide block onto a ${rising ? 'rising' : 'lowering'} tall wall (${order})`, async () => {
      const run = await engineForTest();
      const depth = rising ? 1 : 0;
      const bodyZ = 3 - depth;
      const scene = [voxel('player', 0, 1, bodyZ, 'player'),
        voxel('button', rising ? 0 : 2, 1, bodyZ, 'orange-button', 0), ...floor()];
      for (let y = 1; y <= 2; y++) {
        scene.push(voxel(`body-${y}`, 1, y, bodyZ, 'weightless-pushable', 17));
        for (let x = 0; x <= 1; x++) scene.push(voxel(`ledge-${x}-${y}`, x, y, bodyZ - 1, 'solid'));
        for (let z = 1; z <= 2; z++) scene.push(voxel(`wall-${y}-${z}`, 2, y, z, 'orange-wall', depth));
      }
      const { frames, final } = run(reorder(scene, order), 1);
      assert.equal(frames.length, 2);
      assert(walls(final).every(v => v.value === (rising ? 0 : 1)));
      for (const y of [1, 2]) {
        assert.equal(byId(final, `body-${y}`).x, 2);
        assert.equal(byId(final, `body-${y}`).z, rising ? 3 : 2);
      }
      assert.equal(byId(final, 'player').x, 1);
      assert.equal(byId(final, 'player').z, bodyZ);
    });
  }

  for (const ceiling of [false, true]) {
    test(`a player riding a block on a rising wall ${ceiling ? 'stops at a ceiling' : 'moves once'} (${order})`, async () => {
      const run = await engineForTest();
      const scene = [voxel('player', 2, 2, 3, 'player'), voxel('button', 2, 2, 3, 'orange-button', 0), ...floor()];
      for (let x = 2; x <= 3; x++) {
        for (let z = 1; z <= 2; z++) scene.push(voxel(`wall-${x}-${z}`, x, 2, z, 'orange-wall', 1));
        scene.push(voxel(`body-${x}`, x, 2, 2, 'weightless-pushable', 17));
      }
      if (ceiling) scene.push(voxel('ceiling', 3, 2, 4, 'solid'));
      const { frames, final } = run(reorder(scene, order), 1);
      for (const frame of frames) {
        assert.equal(new Set(walls(frame).map(v => v.value)).size, 1, 'a blocked wall must never partially extend');
        if (ceiling) assert(byId(frame, 'player').z < 4, 'the rider must never enter the ceiling');
      }
      assert(walls(final).every(v => v.value === (ceiling ? 1 : 0)));
      assert.equal(byId(final, 'player').z, ceiling ? 3 : 4);
      for (const x of [2, 3]) assert.equal(byId(final, `body-${x}`).z, ceiling ? 2 : 3);
    });
  }
}
