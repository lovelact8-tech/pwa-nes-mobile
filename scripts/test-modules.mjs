import assert from 'node:assert/strict';
import {
  installRomCompatibility,
  isKnownTunshi640kRom,
  isMmc3ChrRamExpansionRom,
} from '../src/emulator/rom-compat.js';
import {
  isKnownTunshiPostgameRom,
  TUNSHI_POSTGAME_ENTRY,
  TUNSHI_POSTGAME_ENTRY_SIGNATURE,
  TUNSHI_POSTGAME_PRE_ENDING_ENTRY,
  TUNSHI_POSTGAME_PRE_ENDING_SIGNATURE,
} from '../src/emulator/tunshi-postgame-rom.js';

const HEADER_SIZE = 16;
const BANK_8K_SIZE = 0x2000;

function makeHeader({ length = 655376, prg = 40, chr = 0, mapper = 4 } = {}) {
  const rom = new Uint8Array(length);
  rom.set([0x4e, 0x45, 0x53, 0x1a, prg, chr, (mapper & 0x0f) << 4, mapper & 0xf0]);
  return rom;
}

function bankOffset(bank, address) {
  return HEADER_SIZE + bank * BANK_8K_SIZE + (address & 0x1fff);
}

function makePostgameRom() {
  const rom = makeHeader({ length: 1081360, prg: 66 });
  rom.set(
    TUNSHI_POSTGAME_PRE_ENDING_SIGNATURE,
    bankOffset(0x83, TUNSHI_POSTGAME_PRE_ENDING_ENTRY),
  );
  rom.set(
    TUNSHI_POSTGAME_ENTRY_SIGNATURE,
    bankOffset(0x81, TUNSHI_POSTGAME_ENTRY),
  );
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
const unrelated66BankRom = makeHeader({ length: 1081360, prg: 66 });
assert.equal(isKnownTunshiPostgameRom(unrelated66BankRom), false);
assert.equal(isMmc3ChrRamExpansionRom(unrelated66BankRom), false);
const postgameRom = makePostgameRom();
assert.equal(isKnownTunshiPostgameRom(postgameRom), true);
assert.equal(isMmc3ChrRamExpansionRom(postgameRom), true);
const damagedPostgameRom = postgameRom.slice();
damagedPostgameRom[bankOffset(0x81, TUNSHI_POSTGAME_ENTRY)] ^= 0xff;
assert.equal(isKnownTunshiPostgameRom(damagedPostgameRom), false);
assert.equal(isMmc3ChrRamExpansionRom(damagedPostgameRom), false);
assert.equal(isMmc3ChrRamExpansionRom(makeHeader({ length: 1048591, prg: 64 })), false);
assert.equal(isMmc3ChrRamExpansionRom(makeHeader({ length: 1048592, prg: 64, chr: 1 })), false);
assert.equal(isMmc3ChrRamExpansionRom(makeHeader({ length: 1048592, prg: 64, mapper: 5 })), false);

const normalMapper = { load: (address) => address ^ 0x55aa };
const normalNes = { mmap: normalMapper, cpu: { mem: new Uint8Array(0x10000) } };
const normalLoad = normalMapper.load;
assert.equal(installRomCompatibility(normalNes, makeHeader({ mapper: 5 })), false);
assert.equal(normalMapper.load, normalLoad, '普通 Mapper 不应被包装');

const unrelated66Mapper = { load: (address) => address ^ 0x1234 };
const unrelated66Nes = { mmap: unrelated66Mapper, cpu: { mem: new Uint8Array(0x10000) } };
const unrelated66Load = unrelated66Mapper.load;
assert.equal(installRomCompatibility(unrelated66Nes, unrelated66BankRom), false);
assert.equal(unrelated66Mapper.load, unrelated66Load, '无私有指纹的 66-bank ROM 不应被包装');

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

const postgameMapper = { load: (address) => address ^ 0x55aa };
const postgameNes = { mmap: postgameMapper, cpu: { mem: new Uint8Array(0x10000) } };
postgameNes.cpu.mem[0x5000] = 0x66;
assert.equal(installRomCompatibility(postgameNes, postgameRom), true);
assert.equal(postgameMapper.load(0x5000), 0x66);

console.log('✓ ROM 兼容模块：严格隔离私有 66-bank 指纹、扩展 RAM 读取、普通 Mapper 隔离和幂等安装');
