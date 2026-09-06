import assert from "node:assert/strict";
import test from "node:test";
import { rotateVoxelsClockwise, rotateWorldClockwise } from "../../apps/web/app/worldBounds.mjs";
import { simulateFrames, simulateFinal, frameDifference } from "./helpers/project-engine.mjs";

const world = { width: 6, height: 6, floorLayer: 0 };
const box = (x, y, z, genericId) => ({ x, y, z, genericId, blockId: "weightless-pushbox-1826" });

for (const remoteSlope of [false, true]) {
  for (const sharesPlayer of [false, true]) {
    for (const startsOnIce of [false, true]) {
      test(`stack carry: remote ramp=${remoteSlope}, player foothold=${sharesPlayer}, initial Ice=${startsOnIce}`, () => {
        const terrain = Array.from({ length: 36 }, (_, i) => ({ x: i % 6, y: Math.floor(i / 6), z: 0,
          ...(remoteSlope && i === 35 ? { blockId: "ice-slope", orientation: "up" } : { blockId: "floor" }) }));
        const dynamic = [{ x: 0, y: 5, z: 2, blockId: "player" }];
        for (let x = 0; x < 2; ++x) {
          for (let y = 1; y <= 4; ++y) {
            terrain.push({ x, y, z: 1, blockId: startsOnIce && y >= 2 ? "ice-9679" : "wall" });
            if (y < 2) continue;
            // A hole under the upper slab exposes the difference between
            // riding a carrier and acquiring independent slide momentum.
            if (x !== 0 || y !== 3) dynamic.push(box(x, y, 2, 17));
            dynamic.push(box(x, y, 3, 39));
          }
        }
        terrain.push({ x: 0, y: 5, z: 1, blockId: "wall" });
        if (sharesPlayer) dynamic.push(box(0, 5, 3, 39));
        const start = [...terrain, ...dynamic];
        const expected = [...terrain, ...dynamic.map(v => ({ ...v, y: v.y - 1 }))];
        for (let rotation = 0; rotation < 4; ++rotation) {
          const bounds = rotateWorldClockwise(world, rotation);
          const reference = rotateVoxelsClockwise(expected, world, rotation);
          for (const order of ["normal", "reverse", "interleaved"]) {
            let input = rotateVoxelsClockwise(start, world, rotation);
            if (order === "reverse") input.reverse();
            if (order === "interleaved") input = [...input.filter((_, i) => i % 2), ...input.filter((_, i) => !(i % 2))];
            const context = `${rotation * 90}°, ${order}`;
            const frames = simulateFrames(input, rotation, bounds);
            assert.equal(frames.length, 1, `${context}: no missing or extra carry tick`);
            assert.deepEqual(frameDifference(reference, frames[0], bounds), { missing: [], unexpected: [] }, context);
            assert.deepEqual(frameDifference(reference, simulateFinal(input, rotation, bounds), bounds),
              { missing: [], unexpected: [] }, `${context}: final-state API`);
          }
        }
      });
    }
  }
}
