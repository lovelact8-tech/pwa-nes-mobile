import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NES, Controller } from 'jsnes';
import { unzipSync } from 'fflate';
import { installRomCompatibility } from '../src/emulator/rom-compat.js';
import { bootTunshiPostgameEpilogue } from '../src/emulator/tunshi-postgame-boot.js';
import { installTunshiPostgameRuntime } from '../src/emulator/tunshi-postgame-runtime.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const archivePath = path.join(root, 'public/FC中文游戏/汉室新章/吞食天地2-汉室新章-v0.4-原版人物自由编队版.zip');
const checkpointPath = path.join(root, 'public/compat/tunshi-postgame-checkpoint.json');
const archive = new Uint8Array(fs.readFileSync(archivePath));
const romEntry = Object.entries(unzipSync(archive)).find(([name]) => name.toLowerCase().endsWith('.nes'));
assert.ok(romEntry, '体验包缺少 NES 文件');
const romBytes = romEntry[1];
const rom = Array.from(romBytes, (byte) => String.fromCharCode(byte)).join('');
const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));

let latestFrame = new Uint32Array(256 * 240);
let outputFrames = 0;
const nes = new NES({
  emulateSound: false,
  onFrame(frame) {
    latestFrame = Uint32Array.from(frame);
    outputFrames += 1;
  },
  onAudioSample() {},
});
nes.loadROM(rom);
assert.equal(installRomCompatibility(nes, rom), true, '未安装 Mapper 198 兼容层');
const runtime = installTunshiPostgameRuntime(nes, rom);
assert.ok(runtime, '未安装汉室新章运行时');
const boot = bootTunshiPostgameEpilogue(nes, rom, runtime, checkpoint);
assert.equal(boot.entry, 0x7f00, '直达入口错误');

let blankFrames = 0;
let completedAt = -1;
for (let frame = 0; frame < 5_000; frame += 1) {
  if (frame % 35 === 12) nes.buttonDown(1, Controller.BUTTON_A);
  if (frame % 35 === 16) nes.buttonUp(1, Controller.BUTTON_A);
  nes.frame();
  runtime.afterFrame();
  if (new Set(latestFrame).size <= 1) blankFrames += 1;
  if (runtime.completed) {
    completedAt = frame;
    break;
  }
}

assert.equal(blankFrames, 0, '确认后出现了纯色/灰屏帧');
assert.ok(completedAt >= 0, '按 A 后未能完成续篇序章并返回可操作地图');
assert.equal(runtime.stats.restoreCount, 1, '续篇结束后没有原子恢复检查点');

nes.buttonDown(1, Controller.BUTTON_RIGHT);
for (let frame = 0; frame < 1_800; frame += 1) nes.frame();
nes.buttonUp(1, Controller.BUTTON_RIGHT);
assert.equal(nes.cpu.crash, false, '续篇结束后继续操作发生 CPU 崩溃');
assert.ok(new Set(latestFrame).size > 1, '续篇结束后的地图画面无效');

console.log(JSON.stringify({
  passed: true,
  rom: romEntry[0],
  completedAt,
  blankFrames,
  outputFrames,
  finalPc: `0x${((nes.cpu.REG_PC + 1) & 0xffff).toString(16).padStart(4, '0')}`,
}, null, 2));
