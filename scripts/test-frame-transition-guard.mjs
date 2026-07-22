import assert from 'node:assert/strict';
import {
  createFrameTransitionGuard,
  isNearBlackFrame,
} from '../src/emulator/frame-transition-guard.js';

function solid(color, length = 64) {
  const frame = new Uint32Array(length);
  frame.fill(color);
  return frame;
}

function firstChannel(frame) {
  return frame[0] & 0xff;
}

const white = solid(0xffffff);
const black = solid(0x000000);
const dimNoise = solid(0x080808);
assert.equal(isNearBlackFrame(black, { sampleStride: 1 }), true);
assert.equal(isNearBlackFrame(dimNoise, { sampleStride: 1 }), true);
assert.equal(isNearBlackFrame(white, { sampleStride: 1 }), false);

// A normal ROM never enables this private-ROM presentation guard.
const disabled = createFrameTransitionGuard({ enabled: false, sampleStride: 1 });
assert.equal(disabled.process(black).frame, black);
assert.equal(disabled.process(black).guarded, false);

// Ordinary gameplay is returned byte-for-byte and by reference.
const normal = createFrameTransitionGuard({ enabled: true, sampleStride: 1 });
const ordinary = solid(0x563412);
const ordinaryResult = normal.process(ordinary);
assert.equal(ordinaryResult.frame, ordinary);
assert.equal(ordinaryResult.guarded, false);
assert.deepEqual(ordinaryResult.frame, ordinary);

// The stock battle transition alternates black and partially prepared PPU
// frames. None of those black frames may reach the canvas.
const alternating = createFrameTransitionGuard({
  enabled: true,
  sampleStride: 1,
  stableReleaseFrames: 3,
});
const oldScene = solid(0x0000ff);
const partialScene = solid(0x00ff00);
alternating.process(oldScene);
for (let index = 0; index < 8; index += 1) {
  const darkResult = alternating.process(black);
  assert.equal(darkResult.guarded, true);
  assert.equal(isNearBlackFrame(darkResult.frame, { sampleStride: 1 }), false);
  assert.deepEqual(darkResult.frame, oldScene);

  const partialResult = alternating.process(partialScene);
  assert.equal(partialResult.guarded, true);
  assert.deepEqual(partialResult.frame, oldScene);
}

// After a blackout, keep the first few stable frames hidden to absorb 1–2-frame
// render residue before fade-in begins.
const settle = createFrameTransitionGuard({
  enabled: true,
  sampleStride: 1,
  stableReleaseFrames: 2,
  settleFramesAfterDark: 2,
  fadeInFrames: 2,
});
const settleBase = solid(0x0000ff);
settle.process(settleBase);
settle.process(black);
const settleFirst = settle.process(partialScene);
assert.equal(settleFirst.guarded, true);
assert.deepEqual(settleFirst.frame, settleBase);
const settleSecond = settle.process(partialScene);
assert.equal(settleSecond.guarded, true);
assert.deepEqual(settleSecond.frame, settleBase);

// A real sustained blackout is not frozen forever: it holds briefly and then
// fades down monotonically to black.
const sustained = createFrameTransitionGuard({
  enabled: true,
  sampleStride: 1,
  holdDarkFrames: 2,
  fadeOutFrames: 3,
  stableReleaseFrames: 2,
  fadeInFrames: 4,
});
sustained.process(white);
const levels = [];
for (let index = 0; index < 6; index += 1) {
  levels.push(firstChannel(sustained.process(black).frame));
}
assert.deepEqual(levels.slice(0, 2), [255, 255]);
for (let index = 1; index < levels.length; index += 1) {
  assert.ok(levels[index] <= levels[index - 1], 'fade-out must be monotonic');
}
assert.equal(levels.at(-1), 0);

// Once the new scene is stable it fades in and returns to the zero-copy normal
// path. The emulator-provided frames themselves are never modified.
const newScene = solid(0xff0000);
const newSceneBefore = Uint32Array.from(newScene);
let recovered = null;
for (let index = 0; index < 12; index += 1) {
  recovered = sustained.process(newScene);
  if (!recovered.guarded && recovered.phase === 'normal') break;
}
assert.equal(recovered.guarded, false);
assert.equal(recovered.phase, 'normal');
assert.equal(recovered.frame, newScene);
assert.deepEqual(newScene, newSceneBefore);

console.log('Frame transition guard tests passed');
