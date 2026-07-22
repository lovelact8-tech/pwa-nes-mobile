import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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
  'public/FC中文游戏/汉室新章/吞食天地2-汉室新章-v1.3-原版宫殿序幕与编队所修正版.zip',
);
const inputPath = path.resolve(process.argv[2] || defaultPath);
const input = new Uint8Array(fs.readFileSync(inputPath));
const entry = inputPath.toLowerCase().endsWith('.nes')
  ? [path.basename(inputPath), input]
  : Object.entries(unzipSync(input)).find(([name]) => name.toLowerCase().endsWith('.nes'));
assert.ok(entry, '汉室新章卡带包中没有 NES 文件');
const [name, rom] = entry;
assert.equal(hasMapper198CompatibilityMarker(rom), true, '汉室新章卡带缺少 M198 硬件标记');
assert.equal(isKnownTunshiPostgameRom(rom), false, '汉室新章卡带错误依赖了网页专用剧情运行时');

// The mobile UI labels its face button as “A 确定”. The cartridge title must
// route both A and START through the same native prologue bootstrap.
let confirmationFrame = new Uint32Array(256 * 240);
const confirmNes = new NES({
  emulateSound: false,
  onFrame(frame) { confirmationFrame = Uint32Array.from(frame); },
});
confirmNes.loadROM(rom);
installRomCompatibility(confirmNes, rom);
let aConfirmationOpenedAt = null;
for (let frame = 0; frame < 1_230; frame += 1) {
  if (frame === 1_200) confirmNes.buttonDown(1, Controller.BUTTON_A);
  if (frame === 1_204) confirmNes.buttonUp(1, Controller.BUTTON_A);
  confirmNes.frame();
  if (confirmNes.mmap.__mapper198PrgProtocol?.extensionBanks && aConfirmationOpenedAt === null) {
    aConfirmationOpenedAt = frame;
  }
}
assert.ok(aConfirmationOpenedAt !== null && aConfirmationOpenedAt <= 1_205, 'A 确定没有进入原生序幕');
const confirmationFrameSha256 = crypto.createHash('sha256')
  .update(Buffer.from(confirmationFrame.buffer))
  .digest('hex');
assert.equal(
  confirmationFrameSha256,
  'a7326ad92ec350b70be5ec53307dc445f87e5cda7e707dfad909a8d28f21478e',
  'A/START 后没有先进入原版式洛阳宫殿序幕场景',
);

let latestFrame = new Uint32Array(256 * 240);
const nes = new NES({
  emulateSound: false,
  onFrame(frame) { latestFrame = Uint32Array.from(frame); },
});
nes.loadROM(rom);
assert.equal(installRomCompatibility(nes, rom), true);

let openedAt = null;
let closedAt = null;
let formationSignSha256 = null;
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
  assert.doesNotThrow(() => nes.frame(), `汉室新章卡带第 ${frame} 帧崩溃`);
  assert.equal(nes.cpu.crash, false, `汉室新章卡带第 ${frame} 帧 CPU 崩溃`);
  const extension = Boolean(nes.mmap.__mapper198PrgProtocol?.extensionBanks);
  if (extension && openedAt === null) openedAt = frame;
  if (!extension && openedAt !== null && closedAt === null) {
    closedAt = frame;
    const signTiles = Buffer.concat([0xe0, 0xe1, 0xe2, 0xe3].map((tile) => (
      Buffer.from(nes.ppu.vramMem.slice(tile * 16, tile * 16 + 16))
    )));
    formationSignSha256 = crypto.createHash('sha256').update(signTiles).digest('hex');
  }
}

assert.ok(openedAt !== null && openedAt <= 1_205, 'START 后没有由 ROM 打开原生扩展 bank');
assert.ok(closedAt !== null && closedAt > openedAt, '序章结束后 ROM 没有恢复普通 Mapper 198 模式');
assert.equal(
  formationSignSha256,
  'a29c2c8451250374fb1c6443396b3b7d00cab735beae856ce96bfd68e42bb948',
  '序幕结束后没有恢复“编”字编队所牌匾',
);
assert.deepEqual(
  Array.from(nes.cpu.mem.slice(0x6078, 0x607f)),
  [6, 5, 4, 255, 255, 255, 255],
  '结局续章没有恢复孔明、姜维、赵云三人出战队伍',
);
assert.ok(new Set(latestFrame).size >= 3, '汉室新章卡带最终画面异常');
console.log(JSON.stringify({
  passed: true,
  name,
  frames: 13_800,
  aConfirmationOpenedAt,
  confirmationFrameSha256,
  openedAt,
  closedAt,
  formationSignSha256,
  finalPc: `0x${((nes.cpu.REG_PC + 1) & 0xffff).toString(16).padStart(4, '0')}`,
  colors: new Set(latestFrame).size,
  webCheckpointRequired: false,
}, null, 2));
