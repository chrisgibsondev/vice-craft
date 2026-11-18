/** Swimming: players float to the surface and can climb out onto seawalls and docks. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stepPlayer, B, DT } from '../packages/shared/src/index.ts';

// sea x < 0 (water y 10..20, surface y 21), wall at x >= 0 whose walkable top is `top`
const world = (top: number) => ({ getBlock: (x: number, y: number) => x >= 0 ? (y < top ? B.STONE : B.AIR) : (y < 10 ? B.STONE : y <= 20 ? B.WATER : B.AIR) });
const swim = (top: number, mx: number, frames = 300) => {
  const p = { x: -2.5, y: 11, z: 0.5, vx: 0, vy: 0, vz: 0, onGround: false, inWater: true };
  for (let i = 0; i < frames; i++) stepPlayer(p, { mx, mz: 0, yaw: 0, jump: false, sprint: false }, DT, world(top) as never);
  return p;
};

test('swim: a swimmer who stops swimming floats up with the head out of the water', () => {
  const p = swim(22, 0);
  assert.ok(p.y > 19.4 && p.y < 20, `treads water at the surface (y ${p.y.toFixed(2)})`);
});

test('swim: climbs out onto walls 1, 2 and 3 blocks above the water', () => {
  for (const top of [22, 23, 24]) {
    const p = swim(top, 1);
    assert.ok(p.x > 0 && p.y === top, `out onto a wall with top ${top} (x ${p.x.toFixed(2)}, y ${p.y})`);
  }
});

test('swim: a 4-block wall still keeps the swimmer in', () => {
  const p = swim(25, 1);
  assert.ok(p.x < 0, 'stays in the water');
});
