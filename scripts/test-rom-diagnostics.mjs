import assert from 'node:assert/strict';
import { createRomDiagnostics, inspectInesRom } from '../src/emulator/rom-diagnostics.js';

const rom = new Uint8Array(16 + 2 * 0x4000 + 0x2000);
rom.set([0x4e, 0x45, 0x53, 0x1a, 2, 1, 0x43, 0x00]);
const header = inspectInesRom(rom);

assert.equal(header.validMagic, true);
assert.equal(header.format, 'iNES');
assert.equal(header.mapper, 4);
assert.equal(header.prgBanks, 2);
assert.equal(header.chrBanks, 1);
assert.equal(header.battery, true);
assert.equal(header.trainer, false);
assert.equal(header.mirroring, 'vertical');
assert.equal(header.trailingBytes, 0);

const invalid = inspectInesRom(new Uint8Array([1, 2, 3]));
assert.equal(invalid.validMagic, false);
assert.equal(invalid.length, 3);

const diagnostics = createRomDiagnostics();
diagnostics.start({ name: '测试游戏.nes', data: rom, source: 'test' });
const nes = {
  crashed: false,
  mmap: { constructor: { name: 'Mapper4' }, __tunshiMapper198Ram: true },
  cpu: {
    REG_PC: 0x51fe,
    REG_ACC: 0x12,
    REG_X: 0x34,
    REG_Y: 0x56,
    REG_SP: 0x01ff,
    crash: false,
  },
};
diagnostics.attach(nes, { compatibilityInstalled: true });
diagnostics.frame(nes, 1800);
diagnostics.error(new Error('Game crashed, invalid opcode at address $51ff'), { phase: 'frame' });
await diagnostics.waitForHash();
const log = diagnostics.getLog();

assert.match(log, /PWA NES ROM 兼容诊断日志/);
assert.match(log, /romName=测试游戏\.nes/);
assert.match(log, /mapper=4/);
assert.match(log, /gameFrame=1800/);
assert.match(log, /pc=\$51FF/);
assert.match(log, /invalid opcode at address \$51ff/);
assert.match(log, /compatMapper198=true/);
assert.doesNotMatch(log, /romData/);
assert.match(log, /sha256=[0-9a-f]{64}/);

console.log('ROM diagnostics tests passed');
