import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Controller, NES } from 'jsnes';
import { unzipSync } from 'fflate';
import {
  hasMapper198CompatibilityMarker,
  installRomCompatibility,
} from '../src/emulator/rom-compat.js';
import { isKnownTunshiPostgameRom } from '../src/emulator/tunshi-postgame-rom.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultPath = path.join(
  root,
  'public/FC中文游戏/汉室新章/吞食天地2-汉室新章-v0.5-独立卡带版.zip',
);
const inputPath = path.resolve(process.argv[2] || defaultPath);
const input = new Uint8Array(fs.readFileSync(inputPath));
const entry = inputPath.toLowerCase().endsWith('.nes')
  ? [path.basename(inputPath), input]
  : Object.entries(unzipSync(input)).find(([name]) => name.toLowerCase().endsWith('.nes'));
assert.ok(entry, '独立卡带包中没有 NES 文件');
const [name, rom] = entry;
assert.equal(hasMapper198CompatibilityMarker(rom), true, '独立卡带缺少 M198 硬件标记');
assert.equal(isKnownTunshiPostgameRom(rom), false, '独立卡带错误依赖了网页专用剧情运行时');

let latestFrame = new Uint32Array(256 * 240);
const nes = new NES({
  emulateSound: false,
  onFrame(frame) { latestFrame = Uint32Array.from(frame); },
});
nes.loadROM(rom);
assert.equal(installRomCompatibility(nes, rom), true);

let openedAt = null;
let closedAt = null;
for (let frame = 0; frame < 13_800; frame += 1) {
  if (frame === 1_200) nes.buttonDown(1, Controller.BUTTON_START);
  if (frame === 1_204) nes.buttonUp(1, Controller.BUTTON_START);
  if (frame >= 1_500 && frame < 12_000 && frame % 90 === 0) {
    nes.buttonDown(1, Controller.BUTTON_A);
  }
  if (frame >= 1_504 && frame < 12_004 && (frame - 4) % 90 === 0) {
    nes.buttonUp(1, Controller.BUTTON_A);
  }
  if (frame >= 12_000 && frame % 180 === 20) nes.buttonDown(1, Controller.BUTTON_RIGHT);
  if (frame >= 12_000 && frame % 180 === 55) nes.buttonUp(1, Controller.BUTTON_RIGHT);
  if (frame >= 12_000 && frame % 180 === 80) nes.buttonDown(1, Controller.BUTTON_A);
  if (frame >= 12_000 && frame % 180 === 84) nes.buttonUp(1, Controller.BUTTON_A);
  assert.doesNotThrow(() => nes.frame(), `独立卡带第 ${frame} 帧崩溃`);
  assert.equal(nes.cpu.crash, false, `独立卡带第 ${frame} 帧 CPU 崩溃`);
  const extension = Boolean(nes.mmap.__mapper198PrgProtocol?.extensionBanks);
  if (extension && openedAt === null) openedAt = frame;
  if (!extension && openedAt !== null && closedAt === null) closedAt = frame;
}

assert.ok(openedAt !== null && openedAt <= 1_205, 'START 后没有由 ROM 打开原生扩展 bank');
assert.ok(closedAt !== null && closedAt > openedAt, '序章结束后 ROM 没有恢复普通 Mapper 198 模式');
assert.ok(new Set(latestFrame).size >= 3, '独立卡带最终画面异常');
console.log(JSON.stringify({
  passed: true,
  name,
  frames: 13_800,
  openedAt,
  closedAt,
  finalPc: `0x${((nes.cpu.REG_PC + 1) & 0xffff).toString(16).padStart(4, '0')}`,
  colors: new Set(latestFrame).size,
  webCheckpointRequired: false,
}, null, 2));
