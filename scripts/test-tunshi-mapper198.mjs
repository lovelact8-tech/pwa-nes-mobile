import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NES, Controller } from 'jsnes';
import { unzipSync } from 'fflate';
import { installRomCompatibility, isKnownTunshi640kRom } from '../src/emulator/rom-compat.js';
import { captureDeterministicState, restoreDeterministicState } from '../src/netplay/state.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultRom = path.join(root, 'public/FC中文游戏/601-800/0733 - 吞食天地2 - 诸葛孔明传 (简) [同能网].zip');
const romPath = path.resolve(process.argv[2] || defaultRom);
const archive = unzipSync(new Uint8Array(fs.readFileSync(romPath)));
const romEntry = Object.entries(archive).find(([name]) => name.toLowerCase().endsWith('.nes'));
if (!romEntry) throw new Error(`压缩包中没有 NES 文件：${romPath}`);

const romBytes = romEntry[1];
const romHash = crypto.createHash('sha256').update(romBytes).digest('hex');
assert.equal(romBytes.length, 655376);
assert.equal(romHash, 'fd08b9144f8624a888a50a7c1d51a592f090d5d34cb4e0ef9f9de99d14186f5a');
assert.equal(isKnownTunshi640kRom(romBytes), true);
const rom = Array.from(romBytes, (byte) => String.fromCharCode(byte)).join('');

function createScenario(name) {
  let outputFrames = 0;
  const nes = new NES({
    emulateSound: false,
    onFrame() { outputFrames++; },
    onAudioSample() {},
  });
  nes.loadROM(rom);
  assert.equal(installRomCompatibility(nes, rom), true, `${name} 未安装兼容层`);
  let expansionRamReads = 0;
  const compatibleLoad = nes.mmap.load;
  nes.mmap.load = (address) => {
    const normalized = address & 0xffff;
    if (normalized >= 0x5000 && normalized <= 0x5fff) expansionRamReads++;
    return compatibleLoad(address);
  };
  return { name, nes, getOutputFrames: () => outputFrames, getExpansionRamReads: () => expansionRamReads };
}

function runFrame(scenario) {
  try {
    scenario.nes.frame();
  } catch (error) {
    const pc = `0x${((scenario.nes.cpu.REG_PC + 1) & 0xffff).toString(16).padStart(4, '0')}`;
    throw new Error(`${scenario.name} CPU 在 ${pc} 崩溃：${error.message || error}`);
  }
  assert.equal(scenario.nes.cpu.crash, false, `${scenario.name} CPU 标记为崩溃`);
}

function runFrames(scenario, count, input = null) {
  for (let frame = 0; frame < count; frame++) {
    input?.(scenario.nes, frame);
    runFrame(scenario);
  }
}

function pressStartAfterTitle(scenario) {
  runFrames(scenario, 600);
  scenario.nes.buttonDown(1, Controller.BUTTON_START);
  runFrames(scenario, 3);
  scenario.nes.buttonUp(1, Controller.BUTTON_START);
}

function verifyExpansionRamRollback(scenario) {
  const state = captureDeterministicState(scenario.nes);
  assert.ok(state.cpu?.mem, '回滚状态缺少 CPU mem');
  assert.ok(state.cpu.mem.length >= 0x6000, '回滚状态未覆盖 $5000-$5FFF');
  const savedValue = state.cpu.mem[0x5ffe];
  scenario.nes.cpu.mem[0x5ffe] = savedValue ^ 0xff;
  restoreDeterministicState(scenario.nes, state);
  assert.equal(scenario.nes.cpu.mem[0x5ffe], savedValue, '扩展 RAM 未从回滚状态恢复');
  assert.equal(scenario.nes.mmap.load(0x5ffe), savedValue, '恢复后兼容读取层失效');
}

const singlePlayer = createScenario('单手柄');
pressStartAfterTitle(singlePlayer);
runFrames(singlePlayer, 1800);
assert.ok(singlePlayer.getExpansionRamReads() > 0, '进入游戏后没有访问 $5000-$5FFF 扩展 RAM');
verifyExpansionRamRollback(singlePlayer);

const dualController = createScenario('双手柄');
pressStartAfterTitle(dualController);
runFrames(dualController, 1800, (nes, frame) => {
  const phase = frame % 180;
  if (phase === 10) nes.buttonDown(1, Controller.BUTTON_RIGHT);
  if (phase === 35) nes.buttonUp(1, Controller.BUTTON_RIGHT);
  if (phase === 45) nes.buttonDown(1, Controller.BUTTON_A);
  if (phase === 49) nes.buttonUp(1, Controller.BUTTON_A);
  if (phase === 80) nes.buttonDown(2, Controller.BUTTON_LEFT);
  if (phase === 110) nes.buttonUp(2, Controller.BUTTON_LEFT);
  if (phase === 120) nes.buttonDown(2, Controller.BUTTON_B);
  if (phase === 124) nes.buttonUp(2, Controller.BUTTON_B);
});
assert.ok(dualController.getExpansionRamReads() > 0, '双手柄场景没有进入扩展 RAM 程序');
verifyExpansionRamRollback(dualController);

console.log(JSON.stringify({
  passed: true,
  sha256: romHash,
  singlePlayer: {
    frames: singlePlayer.getOutputFrames(),
    expansionRamReads: singlePlayer.getExpansionRamReads(),
    programCounter: `0x${((singlePlayer.nes.cpu.REG_PC + 1) & 0xffff).toString(16).padStart(4, '0')}`,
  },
  dualController: {
    frames: dualController.getOutputFrames(),
    expansionRamReads: dualController.getExpansionRamReads(),
    programCounter: `0x${((dualController.nes.cpu.REG_PC + 1) & 0xffff).toString(16).padStart(4, '0')}`,
  },
}, null, 2));
