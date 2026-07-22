import assert from 'node:assert/strict';
import {
  getEffectivePlaybackSpeed,
  getPlaybackFrameLimit,
  normalizePlaybackSpeed,
  PLAYBACK_SPEEDS,
} from '../src/emulator/playback-speed.js';
import { mapGamepadToNesButtons } from '../src/input/gamepad.js';

assert.deepEqual(PLAYBACK_SPEEDS, [1, 2, 4, 6, 8]);
for (const speed of PLAYBACK_SPEEDS) assert.equal(normalizePlaybackSpeed(String(speed)), speed);
assert.equal(normalizePlaybackSpeed(3), 1);
assert.equal(getEffectivePlaybackSpeed(8, false), 8);
assert.equal(getEffectivePlaybackSpeed(8, true), 1);
assert.equal(getPlaybackFrameLimit(1), 3);
assert.equal(getPlaybackFrameLimit(8), 24);

const buttons = Array.from({ length: 16 }, () => ({ pressed: false, value: 0 }));
buttons[0] = { pressed: true, value: 1 };
buttons[1] = { pressed: true, value: 1 };
buttons[5] = { pressed: true, value: 1 };
buttons[8] = { pressed: true, value: 1 };
buttons[9] = { pressed: true, value: 1 };
buttons[12] = { pressed: true, value: 1 };
const mapped = mapGamepadToNesButtons({ buttons, axes: [-0.8, 0.9] });
assert.deepEqual(
  [...mapped].sort(),
  ['A', 'B', 'DOWN', 'LEFT', 'SELECT', 'START', 'TURBO_A', 'UP'].sort(),
);

const neutral = mapGamepadToNesButtons({ buttons: [], axes: [0.1, -0.1] });
assert.equal(neutral.size, 0);

console.log('✓ 加速档位、联机速度锁和标准蓝牙手柄映射');
