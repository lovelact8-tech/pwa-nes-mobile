import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NES, Controller } from 'jsnes';
import { unzipSync } from 'fflate';
import {
  captureDeterministicState,
  restoreDeterministicState,
  hashDeterministicState,
} from '../src/netplay/state.js';
import { decodeInputMask, encodeInputMask, messageButtons } from '../src/netplay/input.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultRom = path.join(root, 'public/FC中文游戏/201-400/0310 - 国夫君的热血足球联盟 (简) [惊风&空气].zip');
const romPath = path.resolve(process.argv[2] || defaultRom);
const archive = unzipSync(new Uint8Array(fs.readFileSync(romPath)));
const romEntry = Object.entries(archive).find(([name]) => name.toLowerCase().endsWith('.nes'));
if (!romEntry) throw new Error(`压缩包中没有NES文件：${romPath}`);
const rom = Array.from(romEntry[1], (byte) => String.fromCharCode(byte)).join('');

function hashPixels(pixels) {
  let hash = 2166136261;
  for (let index = 0; index < pixels.length; index += 17) {
    hash ^= pixels[index] >>> 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function createEmulator(sampleRate = 48000) {
  let frameHash = '';
  const nes = new NES({
    onFrame(buffer) { frameHash = hashPixels(buffer); },
    onAudioSample() {},
    sampleRate,
  });
  nes.loadROM(rom);
  return { nes, getFrameHash: () => frameHash };
}

const buttonCodes = {
  A: Controller.BUTTON_A,
  B: Controller.BUTTON_B,
  SELECT: Controller.BUTTON_SELECT,
  START: Controller.BUTTON_START,
  UP: Controller.BUTTON_UP,
  DOWN: Controller.BUTTON_DOWN,
  LEFT: Controller.BUTTON_LEFT,
  RIGHT: Controller.BUTTON_RIGHT,
};

function targetButtons(frame, player, includeLateInput = true) {
  const result = new Set();
  if (player === 1) {
    if (frame >= 24 && frame < 27) result.add('START');
    if (frame >= 75 && frame < 185) result.add('RIGHT');
    if (frame >= 112 && frame < 116) result.add('A');
    if (frame >= 360 && frame < 430) result.add('DOWN');
    if (frame >= 390 && frame < 397) result.add('B');
  } else {
    if (frame >= 90 && frame < 165) result.add('LEFT');
    if (frame >= 205 && frame < 275) result.add('UP');
    if (includeLateInput && frame >= 250 && frame < 255) result.add('B');
    if (frame >= 420 && frame < 426) result.add('A');
  }
  return result;
}

function applyFrameInputs(nes, frame, includeLateInput = true) {
  for (const player of [1, 2]) {
    const target = targetButtons(frame, player, includeLateInput);
    for (const [name, code] of Object.entries(buttonCodes)) {
      if (target.has(name)) nes.buttonDown(player, code);
      else nes.buttonUp(player, code);
    }
  }
}

function advance(emulator, fromFrame, toFrame, includeLateInput = true) {
  for (let frame = fromFrame; frame < toFrame; frame++) {
    applyFrameInputs(emulator.nes, frame, includeLateInput);
    emulator.nes.frame();
  }
}

function stateHash(emulator) {
  return hashDeterministicState(captureDeterministicState(emulator.nes));
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}不一致：${actual} != ${expected}`);
}

function assertNotEqual(actual, expected, label) {
  if (actual === expected) throw new Error(`${label}未检测出差异：${actual}`);
}

const baselineA = createEmulator();
const baselineB = createEmulator();
for (let frame = 0; frame < 720; frame++) {
  applyFrameInputs(baselineA.nes, frame);
  applyFrameInputs(baselineB.nes, frame);
  baselineA.nes.frame();
  baselineB.nes.frame();
  if ((frame + 1) % 60 === 0) {
    assertEqual(stateHash(baselineA), stateHash(baselineB), `双模拟器第${frame + 1}帧状态`);
    assertEqual(baselineA.getFrameHash(), baselineB.getFrameHash(), `双模拟器第${frame + 1}帧画面`);
  }
}
console.log('✓ 双模拟器相同输入：720帧一致');

const sampleRateA = createEmulator(44100);
const sampleRateB = createEmulator(48000);
advance(sampleRateA, 0, 720);
advance(sampleRateB, 0, 720);
assertEqual(stateHash(sampleRateA), stateHash(sampleRateB), '跨设备采样率的逻辑状态');
assertEqual(sampleRateA.getFrameHash(), sampleRateB.getFrameHash(), '跨设备采样率的画面');
console.log('✓ 44.1/48 kHz设备：逻辑状态与画面一致');

const hashSource = captureDeterministicState(sampleRateA.nes);
const renderCacheVariant = structuredClone(hashSource);
renderCacheVariant.ppu.attrib = Array.from({ length: 32 }, (_, index) => index * 7);
renderCacheVariant.ppu.scantile = Array.from({ length: 32 }, (_, index) => index * 11);
renderCacheVariant.ppu.curNt = 3;
renderCacheVariant.ppu.lastRenderedScanline = 117;
renderCacheVariant.ppu.validTileData = !renderCacheVariant.ppu.validTileData;
renderCacheVariant.ppu.scanlineAlreadyRendered = !renderCacheVariant.ppu.scanlineAlreadyRendered;
assertEqual(hashDeterministicState(renderCacheVariant), hashDeterministicState(hashSource), 'PPU渲染缓存');
const logicVariant = structuredClone(hashSource);
logicVariant.cpu.REG_ACC ^= 1;
assertNotEqual(hashDeterministicState(logicVariant), hashDeterministicState(hashSource), 'CPU逻辑状态');
console.log('✓ 状态校验：忽略渲染缓存，但能识别CPU逻辑分叉');

const source = createEmulator();
advance(source, 0, 240);
const snapshot = captureDeterministicState(source.nes);
const restored = createEmulator();
restoreDeterministicState(restored.nes, snapshot);
advance(source, 240, 600);
advance(restored, 240, 600);
assertEqual(stateHash(restored), stateHash(source), '快照恢复后的状态');
assertEqual(restored.getFrameHash(), source.getFrameHash(), '快照恢复后的画面');
console.log('✓ 精简快照恢复：继续运行360帧一致');

const authoritative = createEmulator();
advance(authoritative, 0, 320, true);
const delayed = createEmulator();
advance(delayed, 0, 248, false);
const rollbackSnapshot = captureDeterministicState(delayed.nes);
advance(delayed, 248, 320, false);
restoreDeterministicState(delayed.nes, rollbackSnapshot);
advance(delayed, 248, 320, true);
assertEqual(stateHash(delayed), stateHash(authoritative), '迟到输入回滚后的状态');
assertEqual(delayed.getFrameHash(), authoritative.getFrameHash(), '迟到输入回滚后的画面');
console.log('✓ 迟到输入回滚：重算72帧后与权威时间线一致');

const buttonSet = ['RIGHT', 'A', 'START'];
const buttonMask = encodeInputMask(buttonSet);
assertEqual(JSON.stringify(decodeInputMask(buttonMask).sort()), JSON.stringify(buttonSet.sort()), '输入位掩码');
assertEqual(JSON.stringify(messageButtons({ mask: buttonMask }).sort()), JSON.stringify(buttonSet.sort()), '输入消息解码');
console.log('✓ 紧凑输入协议：8个按键位可逆');
console.log(`通过：${path.basename(romPath)}`);
