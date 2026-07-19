import assert from 'node:assert/strict';
import {
  installRomCompatibility,
  isKnownTunshi640kRom,
  isMmc3ChrRamExpansionRom,
} from '../src/emulator/rom-compat.js';

function makeHeader({ length = 655376, prg = 40, chr = 0, mapper = 4 } = {}) {
  const rom = new Uint8Array(length);
  rom.set([0x4e, 0x45, 0x53, 0x1a, prg, chr, (mapper & 0x0f) << 4, mapper & 0xf0]);
  return rom;
}

const knownRom = makeHeader();
assert.equal(isKnownTunshi640kRom(knownRom), true);
assert.equal(isMmc3ChrRamExpansionRom(knownRom), true);
assert.equal(isKnownTunshi640kRom(makeHeader({ length: 655375 })), false);
assert.equal(isKnownTunshi640kRom(makeHeader({ prg: 39 })), false);
assert.equal(isKnownTunshi640kRom(makeHeader({ chr: 1 })), false);
assert.equal(isKnownTunshi640kRom(makeHeader({ mapper: 5 })), false);
assert.equal(isMmc3ChrRamExpansionRom(makeHeader({ length: 1048592, prg: 64 })), true);
assert.equal(isMmc3ChrRamExpansionRom(makeHeader({ length: 1048591, prg: 64 })), false);
assert.equal(isMmc3ChrRamExpansionRom(makeHeader({ length: 1048592, prg: 64, chr: 1 })), false);
assert.equal(isMmc3ChrRamExpansionRom(makeHeader({ length: 1048592, prg: 64, mapper: 5 })), false);

const normalMapper = { load: (address) => address ^ 0x55aa };
const normalNes = { mmap: normalMapper, cpu: { mem: new Uint8Array(0x10000) } };
const normalLoad = normalMapper.load;
assert.equal(installRomCompatibility(normalNes, makeHeader({ mapper: 5 })), false);
assert.equal(normalMapper.load, normalLoad, '普通 Mapper 不应被包装');

const mapper = { load: (address) => address ^ 0x55aa };
const nes = { mmap: mapper, cpu: { mem: new Uint8Array(0x10000) } };
nes.cpu.mem[0x5000] = 0x42;
nes.cpu.mem[0x5fff] = 0x99;
assert.equal(installRomCompatibility(nes, knownRom), true);
assert.equal(mapper.load(0x5000), 0x42);
assert.equal(mapper.load(0x5fff), 0x99);
assert.equal(mapper.load(0x6000), 0x6000 ^ 0x55aa);
const installedLoad = mapper.load;
assert.equal(installRomCompatibility(nes, knownRom), true);
assert.equal(mapper.load, installedLoad, '重复安装不应叠加包装');

console.log('✓ ROM 兼容模块：大容量 MMC3 CHR-RAM 检测、扩展 RAM 读取、普通 Mapper 隔离和幂等安装');
