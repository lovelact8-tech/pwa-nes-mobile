import assert from 'node:assert/strict';
import {
  installRomCompatibility,
  isKnownTunshi1mRom,
  isKnownTunshi640kRom,
  isMmc3ChrRamExpansionRom,
  normalizeTunshiMapper198PrgBank,
  setTunshiPostgameExtensionBanks,
} from '../src/emulator/rom-compat.js';
import {
  isKnownTunshiPostgameRom,
  isLegacyTunshiPostgameRom,
  TUNSHI_POSTGAME_ENTRY,
  TUNSHI_POSTGAME_ENTRY_SIGNATURE,
  TUNSHI_POSTGAME_DRIVER_SOURCE,
  TUNSHI_POSTGAME_DRIVER_SIGNATURE,
  TUNSHI_POSTGAME_PRE_ENDING_ENTRY,
  TUNSHI_POSTGAME_PRE_ENDING_SIGNATURE,
} from '../src/emulator/tunshi-postgame-rom.js';
import {
  readTunshiPostgameFormation,
  setTunshiPostgameFormation,
  supportsTunshiPostgameFormation,
  tunshiPostgameRoster,
} from '../src/emulator/tunshi-postgame-formation.js';

const HEADER_SIZE = 16;
const BANK_8K_SIZE = 0x2000;

assert.equal(normalizeTunshiMapper198PrgBank(0x00), 0x00);
assert.equal(normalizeTunshiMapper198PrgBank(0x3f), 0x3f);
assert.equal(normalizeTunshiMapper198PrgBank(0x40), 0x40);
assert.equal(normalizeTunshiMapper198PrgBank(0x4f), 0x4f);
assert.equal(normalizeTunshiMapper198PrgBank(0x56), 0x46);
assert.equal(normalizeTunshiMapper198PrgBank(0x86), 0x06);
assert.equal(normalizeTunshiMapper198PrgBank(0xc6), 0x46);

function makeHeader({ length = 655376, prg = 40, chr = 0, mapper = 4 } = {}) {
  const rom = new Uint8Array(length);
  rom.set([0x4e, 0x45, 0x53, 0x1a, prg, chr, (mapper & 0x0f) << 4, mapper & 0xf0]);
  return rom;
}

function bankOffset(bank, address) {
  return HEADER_SIZE + bank * BANK_8K_SIZE + (address & 0x1fff);
}

function makePostgameRom({ prg = 128, fixedBank = 0xff, codeBank = 0x81 } = {}) {
  const rom = makeHeader({ length: 16 + prg * 0x4000, prg });
  rom.set(
    TUNSHI_POSTGAME_PRE_ENDING_SIGNATURE,
    bankOffset(fixedBank, TUNSHI_POSTGAME_PRE_ENDING_ENTRY),
  );
  if (prg === 66) {
    rom.set(TUNSHI_POSTGAME_DRIVER_SIGNATURE, bankOffset(codeBank, TUNSHI_POSTGAME_ENTRY));
  } else {
    rom.set(TUNSHI_POSTGAME_ENTRY_SIGNATURE, bankOffset(codeBank, TUNSHI_POSTGAME_ENTRY));
    rom.set(TUNSHI_POSTGAME_DRIVER_SIGNATURE, bankOffset(codeBank, TUNSHI_POSTGAME_DRIVER_SOURCE));
  }
  return rom;
}

const headerOnly640k = makeHeader();
assert.equal(isKnownTunshi640kRom(headerOnly640k), false, '仅头信息相同不能启用私人兼容层');
assert.equal(isMmc3ChrRamExpansionRom(headerOnly640k), false);
assert.equal(isKnownTunshi1mRom(makeHeader({ length: 1048592, prg: 64 })), false);
assert.equal(isKnownTunshi640kRom(makeHeader({ length: 655375 })), false);
assert.equal(isKnownTunshi640kRom(makeHeader({ prg: 39 })), false);
assert.equal(isKnownTunshi640kRom(makeHeader({ chr: 1 })), false);
assert.equal(isKnownTunshi640kRom(makeHeader({ mapper: 5 })), false);
assert.equal(isMmc3ChrRamExpansionRom(makeHeader({ length: 1048592, prg: 64 })), false);
const unrelated66BankRom = makeHeader({ length: 1081360, prg: 66 });
assert.equal(isKnownTunshiPostgameRom(unrelated66BankRom), false);
assert.equal(isMmc3ChrRamExpansionRom(unrelated66BankRom), false);
const postgameRom = makePostgameRom();
assert.equal(isKnownTunshiPostgameRom(postgameRom), true);
assert.equal(isMmc3ChrRamExpansionRom(postgameRom), true);
const legacyPostgameRom = makePostgameRom({
  prg: 66,
  fixedBank: 0x83,
  codeBank: 0x81,
});
assert.equal(isKnownTunshiPostgameRom(legacyPostgameRom), false, '旧66-bank原型不能继续运行');
assert.equal(isLegacyTunshiPostgameRom(legacyPostgameRom), true, '旧66-bank原型只用于提示升级');
assert.equal(isMmc3ChrRamExpansionRom(legacyPostgameRom), false);
assert.equal(isKnownTunshiPostgameRom(makePostgameRom()), true, '128-bank镜像布局是当前稳定构建');
const unrelated128BankRom = makeHeader({ length: 16 + 128 * 0x4000, prg: 128 });
assert.equal(isKnownTunshiPostgameRom(unrelated128BankRom), false);
assert.equal(isMmc3ChrRamExpansionRom(unrelated128BankRom), false);
const damagedPostgameRom = postgameRom.slice();
damagedPostgameRom[bankOffset(0x81, TUNSHI_POSTGAME_ENTRY)] ^= 0xff;
assert.equal(isKnownTunshiPostgameRom(damagedPostgameRom), false);
assert.equal(
  isMmc3ChrRamExpansionRom(damagedPostgameRom),
  false,
  '损坏私人指纹的128-bank ROM 不能获得扩展兼容层',
);
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

const partyNes = {
  mmap: { __tunshiPostgameBankAlias: true },
  cpu: { mem: new Uint8Array(0x10000) },
};
partyNes.cpu.mem.set([0xf4, 0x01, 0x00], 0x663f);
const selectedParty = [0x08, 0x12, 0x04, 0x06, 0x0b];
assert.equal(supportsTunshiPostgameFormation(partyNes), true);
assert.equal(setTunshiPostgameFormation(partyNes, selectedParty), true);
assert.deepEqual(Array.from(partyNes.cpu.mem.slice(0x6078, 0x607f)), [6, 5, 4, 3, 2, 255, 255]);
assert.deepEqual(Array.from(partyNes.cpu.mem.slice(0x6615, 0x661c)), [0, 0, 128, 128, 128, 128, 128]);
assert.deepEqual(Array.from({ length: 5 }, (_, index) => partyNes.cpu.mem[0x6627 - index]), selectedParty);
assert.deepEqual(readTunshiPostgameFormation(partyNes).map(({ id }) => id), selectedParty);
assert.equal(partyNes.cpu.mem[0x6633], 0xf4, '新增第五人必须获得可用兵力');
assert.equal(tunshiPostgameRoster.some(({ id, name }) => id === 0x7b && name === '马超'), true);
assert.throws(() => setTunshiPostgameFormation(partyNes, []), /至少/);
assert.equal(setTunshiPostgameFormation({ mmap: {}, cpu: partyNes.cpu }, selectedParty), false, '普通 ROM 不应改写队伍');

const bankLoads = [];
const postgameMapper = {
  load: (address) => address ^ 0x55aa,
  load8kRomBank(bank, address) { bankLoads.push({ bank, address }); },
};
const postgameNes = { mmap: postgameMapper, cpu: { mem: new Uint8Array(0x10000) } };
postgameNes.cpu.mem[0x5000] = 0x66;
postgameNes.cpu.mem[0x5fff] = 0x99;
assert.equal(installRomCompatibility(postgameNes, postgameRom), true);
assert.equal(postgameMapper.load(0x5000), 0x66);
assert.equal(postgameMapper.load(0x5fff), 0x99);
assert.equal(postgameMapper.load(0x6000), 0x6000 ^ 0x55aa);
assert.deepEqual(bankLoads, [
  { bank: 0x4e, address: 0xc000 },
  { bank: 0x4f, address: 0xe000 },
], '冷启动必须立即替换 jsnes 预先装入的错误固定 bank');
bankLoads.length = 0;
postgameMapper.load8kRomBank(0x80, 0x8000);
postgameMapper.load8kRomBank(0x81, 0xa000);
postgameMapper.load8kRomBank(0x82, 0xc000);
postgameMapper.load8kRomBank(0x86, 0x8000);
postgameMapper.load8kRomBank(0xfe, 0xe000);
assert.deepEqual(bankLoads, [
  { bank: 0x00, address: 0x8000 },
  { bank: 0x01, address: 0xa000 },
  { bank: 0x02, address: 0xc000 },
  { bank: 0x06, address: 0x8000 },
  { bank: 0x4e, address: 0xe000 },
], '普通游戏阶段必须恢复完整 Mapper 198 双芯片 bank 线路');
assert.equal(setTunshiPostgameExtensionBanks(postgameNes, true), true);
postgameMapper.load8kRomBank(0x80, 0x8000);
postgameMapper.load8kRomBank(0x81, 0xa000);
assert.deepEqual(bankLoads.slice(-2), [
  { bank: 0x80, address: 0x8000 },
  { bank: 0x81, address: 0xa000 },
], '续篇阶段必须允许读取物理扩展 bank $80/$81');
assert.equal(setTunshiPostgameExtensionBanks(postgameNes, false), true);
const installedLoad = postgameMapper.load;
const installedLoad8k = postgameMapper.load8kRomBank;
assert.equal(installRomCompatibility(postgameNes, postgameRom), true);
assert.equal(postgameMapper.load, installedLoad, '重复安装不应叠加包装');
assert.equal(postgameMapper.load8kRomBank, installedLoad8k, 'PRG bank 包装也必须幂等');

console.log('✓ ROM 兼容模块：严格隔离稳定 128-bank/旧 66-bank 指纹、扩展 RAM 读取、普通 Mapper 隔离和幂等安装');
