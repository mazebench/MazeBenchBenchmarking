import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function loadEngine() {
  const bytes = await readFile(new URL("../../apps/web/public/physics/voxel_physics.wasm", import.meta.url));
  const { instance } = await WebAssembly.instantiate(bytes, {});
  return instance.exports;
}

function roleCode(engine, roleId) {
  const bytes = new TextEncoder().encode(roleId);
  assert.ok(bytes.length <= engine.role_buffer_capacity());
  new Uint8Array(engine.memory.buffer, engine.role_buffer(), bytes.length).set(bytes);
  return engine.role_code(bytes.length);
}

function simulate(engine, voxels, direction, width = 5, height = 5) {
  assert.equal(engine.physics_abi_version(), 4);
  const stride = engine.voxel_stride();
  assert.equal(stride, 5);
  const buffer = new Int32Array(engine.memory.buffer, engine.voxel_buffer(), voxels.length * stride);
  voxels.forEach((voxel, index) => {
    buffer.set([voxel.x, voxel.y, voxel.z, roleCode(engine, voxel.roleId), voxel.genericId ?? -1], index * stride);
  });
  assert.equal(engine.simulate_turn(voxels.length, width, height, direction), 0);
  return voxels.map((voxel, index) => ({
    ...voxel,
    x: buffer[index * stride],
    y: buffer[index * stride + 1],
    z: buffer[index * stride + 2],
    ...(voxel.genericId === undefined
      ? {}
      : { genericId: buffer[index * stride + 4] }),
  }));
}

test("the C++ engine pushes a pushable role and preserves negative Z", async () => {
  const engine = await loadEngine();
  const result = simulate(engine, [
    { x: 2, y: 2, z: -7, roleId: "player" },
    { x: 2, y: 1, z: -7, roleId: "pushable" },
    { x: 2, y: 2, z: -8, roleId: "floor" },
    { x: 2, y: 1, z: -8, roleId: "floor" },
    { x: 2, y: 0, z: -8, roleId: "floor" },
  ], 0);

  assert.deepEqual(result.slice(0, 2), [
    { x: 2, y: 1, z: -7, roleId: "player" },
    { x: 2, y: 0, z: -7, roleId: "pushable" },
  ]);
});

test("custom roles are stable engine keys and block movement until C++ implements them", async () => {
  const engine = await loadEngine();
  assert.equal(roleCode(engine, "ice"), roleCode(engine, "ice"));
  assert.notEqual(roleCode(engine, "ice"), roleCode(engine, "player"));

  const result = simulate(engine, [
    { x: 1, y: 2, z: 1, roleId: "player" },
    { x: 1, y: 1, z: 1, roleId: "ice" },
    { x: 1, y: 2, z: 0, roleId: "floor" },
  ], 0);
  assert.deepEqual(result.slice(0, 2).map(({ x, y, z }) => ({ x, y, z })), [
    { x: 1, y: 2, z: 1 },
    { x: 1, y: 1, z: 1 },
  ]);
});

test("the C++ engine enforces room boundaries in every direction", async () => {
  const engine = await loadEngine();
  const cases = [
    [{ x: 2, y: 0, z: 1, roleId: "player" }, 0],
    [{ x: 4, y: 2, z: 1, roleId: "player" }, 1],
    [{ x: 2, y: 4, z: 1, roleId: "player" }, 2],
    [{ x: 0, y: 2, z: 1, roleId: "player" }, 3],
  ];
  for (const [player, direction] of cases) {
    const result = simulate(engine, [
      player,
      { x: player.x, y: player.y, z: 0, roleId: "floor" },
    ], direction);
    assert.deepEqual(result[0], player);
  }
});

test("the C++ WebAssembly engine executes MazeBench-style Ice slides", async () => {
  const engine = await loadEngine();
  const result = simulate(engine, [
    { x: 2, y: 4, z: 1, roleId: "player" },
    { x: 2, y: 4, z: 0, roleId: "floor" },
    { x: 2, y: 3, z: 0, roleId: "ice" },
    { x: 2, y: 2, z: 0, roleId: "ice" },
    { x: 2, y: 1, z: 0, roleId: "ice" },
    { x: 2, y: 0, z: 0, roleId: "solid" },
  ], 0);
  assert.deepEqual(result[0], { x: 2, y: 0, z: 1, roleId: "player" });
});

test("WebAssembly preserves the player lift state transition", async () => {
  const engine = await loadEngine();
  const result = simulate(engine, [
    { x: 1, y: 2, z: 1, roleId: "player" },
    { x: 1, y: 1, z: 1, roleId: "player-lift", genericId: 0 },
    { x: 1, y: 2, z: 0, roleId: "floor" },
    { x: 1, y: 1, z: 0, roleId: "floor" },
  ], 0, 3, 3);
  assert.deepEqual(result.slice(0, 2), [
    { x: 1, y: 1, z: 2, roleId: "player" },
    { x: 1, y: 1, z: 1, roleId: "player-lift", genericId: 1 },
  ]);
});

test("WebAssembly exposes orange button entry before its linked wall tick", async () => {
  const engine = await loadEngine();
  const voxels = [
    { x: 1, y: 2, z: 1, roleId: "player", genericId: -1 },
    { x: 1, y: 1, z: 1, roleId: "orange-button", genericId: 0 },
    { x: 2, y: 1, z: 1, roleId: "orange-wall", genericId: 0 },
    { x: 1, y: 2, z: 0, roleId: "floor", genericId: -1 },
    { x: 1, y: 1, z: 0, roleId: "floor", genericId: -1 },
    { x: 2, y: 1, z: 0, roleId: "floor", genericId: -1 },
  ];
  const stride = engine.voxel_stride();
  const buffer = new Int32Array(
    engine.memory.buffer,
    engine.voxel_buffer(),
    voxels.length * stride,
  );
  voxels.forEach((voxel, index) => buffer.set([
    voxel.x,
    voxel.y,
    voxel.z,
    roleCode(engine, voxel.roleId),
    voxel.genericId,
  ], index * stride));

  engine.reset_command();
  assert.equal(engine.step_command_tick(voxels.length, 3, 3, 0), 1);
  assert.deepEqual([buffer[1], buffer[stride + 4], buffer[stride * 2 + 4]], [1, 0, 0]);
  assert.equal(engine.step_command_tick(voxels.length, 3, 3, 0), 0);
  assert.deepEqual([buffer[stride + 4], buffer[stride * 2 + 4]], [0, 1]);
});

test("WebAssembly exposes one resumable frame per C++ tick", async () => {
  const engine = await loadEngine();
  const voxels = [
    { x: 2, y: 4, z: 1, roleId: "player" },
    { x: 2, y: 4, z: 0, roleId: "floor" },
    { x: 2, y: 3, z: 0, roleId: "ice" },
    { x: 2, y: 2, z: 0, roleId: "ice" },
    { x: 2, y: 1, z: 0, roleId: "ice" },
    { x: 2, y: 0, z: 0, roleId: "solid" },
  ];
  const stride = engine.voxel_stride();
  const buffer = new Int32Array(engine.memory.buffer, engine.voxel_buffer(), voxels.length * stride);
  voxels.forEach((voxel, index) => buffer.set([
    voxel.x, voxel.y, voxel.z, roleCode(engine, voxel.roleId), -1,
  ], index * stride));

  assert.ok(engine.motion_state_size() > 0);
  assert.ok(engine.motion_state_buffer() > 0);
  engine.reset_command();
  const playerRows = [];
  for (;;) {
    const status = engine.step_command_tick(voxels.length, 5, 5, 0);
    if (engine.command_tick() > playerRows.length) playerRows.push(buffer[1]);
    if (status === 0) break;
    assert.equal(status, 1);
  }
  assert.deepEqual(playerRows, [3, 2, 1, 0]);
});

test("WebAssembly settles airborne entities before applying the command", async () => {
  const engine = await loadEngine();
  const voxels = [
    { x: 1, y: 2, z: 3, roleId: "player" },
    { x: 1, y: 2, z: 0, roleId: "floor" },
    { x: 1, y: 1, z: 0, roleId: "floor" },
  ];
  const stride = engine.voxel_stride();
  const buffer = new Int32Array(engine.memory.buffer, engine.voxel_buffer(), voxels.length * stride);
  voxels.forEach((voxel, index) => buffer.set([
    voxel.x, voxel.y, voxel.z, roleCode(engine, voxel.roleId), -1,
  ], index * stride));

  engine.reset_command();
  const frames = [];
  for (;;) {
    const status = engine.step_command_tick(voxels.length, 3, 3, 0);
    frames.push({ y: buffer[1], z: buffer[2] });
    if (status === 0) break;
    assert.equal(status, 1);
  }
  assert.deepEqual(frames, [
    { y: 2, z: 2 },
    { y: 2, z: 1 },
    { y: 1, z: 1 },
  ]);
});

test("WebAssembly exact search targets collection of a literal gem", async () => {
  const engine = await loadEngine();
  const voxels = [
    { x: 1, y: 2, z: 1, roleId: "player" },
    { x: 1, y: 2, z: 0, roleId: "floor" },
    { x: 1, y: 1, z: 0, roleId: "floor" },
    { x: 1, y: 0, z: 0, roleId: "floor" },
    { x: 1, y: 0, z: 1, roleId: "goal" },
  ];
  const stride = engine.voxel_stride();
  const buffer = new Int32Array(engine.memory.buffer, engine.voxel_buffer(), voxels.length * stride);
  voxels.forEach((voxel, index) => buffer.set([
    voxel.x, voxel.y, voxel.z, roleCode(engine, voxel.roleId), -1,
  ], index * stride));

  assert.ok(engine.search_node_capacity() >= 1000);
  assert.ok(engine.search_voxel_capacity() >= 4096);
  assert.equal(engine.search_solve(voxels.length, 3, 3, 1000), 1);
  assert.equal(engine.search_moves(), 2);
  assert.equal(engine.search_solution_length(), 2);
  assert.deepEqual([engine.search_solution_step(0), engine.search_solution_step(1)], [0, 0]);
});

test("WebAssembly enumerates reachable room edges without requiring gems", async () => {
  const engine = await loadEngine();
  const voxels = [{ x: 1, y: 1, z: 1, roleId: "player" }];
  for (let y = 0; y < 3; y += 1) {
    for (let x = 0; x < 3; x += 1) {
      voxels.push({ x, y, z: 0, roleId: "floor" });
    }
  }
  const stride = engine.voxel_stride();
  const buffer = new Int32Array(
    engine.memory.buffer,
    engine.voxel_buffer(),
    voxels.length * stride,
  );
  voxels.forEach((voxel, index) => buffer.set([
    voxel.x, voxel.y, voxel.z, roleCode(engine, voxel.roleId), -1,
  ], index * stride));

  assert.equal(engine.search_edges(voxels.length, 3, 3, 1000), 1);
  assert.equal(engine.search_edge_count(), 12);
  assert.equal(engine.search_edge_solution(0, voxels.length, 3, 3), 1);
  assert.ok(engine.search_solution_length() >= 2);
  assert.equal(
    engine.search_solution_step(engine.search_solution_length() - 1),
    0,
  );
});

test("WebAssembly distinguishes a capped route from an optimal proof", async () => {
  const engine = await loadEngine();
  const voxels = [];
  for (let y = 0; y < 5; y += 1) {
    for (let x = 0; x < 5; x += 1) {
      voxels.push({ x, y, z: 0, roleId: "floor" });
    }
  }
  for (let x = 0; x < 5; x += 1) {
    voxels.push({ x, y: 0, z: 1, roleId: "wall" });
    voxels.push({ x, y: 4, z: 1, roleId: "wall" });
  }
  for (let y = 1; y < 4; y += 1) {
    voxels.push({ x: 0, y, z: 1, roleId: "wall" });
    voxels.push({ x: 4, y, z: 1, roleId: "wall" });
  }
  voxels.push(
    { x: 1, y: 2, z: 1, roleId: "weightless-pushable", genericId: 0 },
    { x: 2, y: 2, z: 1, roleId: "weightless-pushable", genericId: 0 },
    { x: 1, y: 3, z: 1, roleId: "player" },
    { x: 1, y: 1, z: 1, roleId: "goal" },
  );
  const stride = engine.voxel_stride();
  const buffer = new Int32Array(
    engine.memory.buffer,
    engine.voxel_buffer(),
    voxels.length * stride,
  );
  const write = () => voxels.forEach((voxel, index) => buffer.set([
    voxel.x,
    voxel.y,
    voxel.z,
    roleCode(engine, voxel.roleId),
    voxel.genericId ?? -1,
  ], index * stride));

  write();
  assert.equal(engine.search_solve(voxels.length, 5, 5, 5), 3);
  assert.equal(engine.search_moves(), 6);
  write();
  assert.equal(engine.search_solve(voxels.length, 5, 5, 10000), 1);
  assert.equal(engine.search_moves(), 6);
});
