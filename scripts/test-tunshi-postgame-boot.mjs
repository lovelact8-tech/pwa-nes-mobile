import assert from 'node:assert/strict';
import { bootTunshiPostgameEpilogue } from '../src/emulator/tunshi-postgame-boot.js';
import {
  TUNSHI_POSTGAME_ENTRY,
  TUNSHI_POSTGAME_ENTRY_SIGNATURE,
  TUNSHI_POSTGAME_DRIVER_SOURCE,
  TUNSHI_POSTGAME_DRIVER_SIGNATURE,
  TUNSHI_POSTGAME_PRE_ENDING_ENTRY,
  TUNSHI_POSTGAME_PRE_ENDING_SIGNATURE,
} from '../src/emulator/tunshi-postgame-rom.js';

const HEADER_SIZE = 16;
const BANK_8K = 0x2000;
const ROM = new Uint8Array(HEADER_SIZE + 0x80 * 0x4000);
ROM.set([0x4e, 0x45, 0x53, 0x1a, 0x80, 0x00, 0x40, 0x00]);

function bankOffset(bank, address) {
  return HEADER_SIZE + bank * BANK_8K + (address & 0x1fff);
}

ROM.set(
  TUNSHI_POSTGAME_PRE_ENDING_SIGNATURE,
  bankOffset(0xff, TUNSHI_POSTGAME_PRE_ENDING_ENTRY),
);
ROM.set(
  TUNSHI_POSTGAME_ENTRY_SIGNATURE,
  bankOffset(0x81, TUNSHI_POSTGAME_ENTRY),
);
ROM.set(TUNSHI_POSTGAME_DRIVER_SIGNATURE, bankOffset(0x81, TUNSHI_POSTGAME_DRIVER_SOURCE));

function makeNes() {
  const mem = new Uint8Array(0x10000);
  return {
    cpu: {
      mem,
      REG_PC: TUNSHI_POSTGAME_PRE_ENDING_ENTRY - 1,
      REG_PC_NEW: TUNSHI_POSTGAME_PRE_ENDING_ENTRY - 1,
      nmiRaised: true,
      nmiPending: true,
      nmiImmediate: true,
      irqRequested: true,
    },
    mmap: {
      prgAddressSelect: 1,
      prgAddressChanged: true,
      load8kRomBank(bank, address) {
        mem.set(ROM.subarray(
          HEADER_SIZE + bank * BANK_8K,
          HEADER_SIZE + (bank + 1) * BANK_8K,
        ), address);
      },
    },
  };
}

function makeRuntime() {
  return {
    refreshCount: 0,
    imported: null,
    refresh() { this.refreshCount += 1; },
    importState(state) { this.imported = state; },
  };
}

const sourceState = { label: 'verified-ending-boundary' };
const nes = makeNes();
const runtime = makeRuntime();
const result = bootTunshiPostgameEpilogue(nes, ROM, runtime, sourceState, {
  restoreState(target, state) {
    assert.equal(state, sourceState);
    target.cpu.REG_PC = TUNSHI_POSTGAME_PRE_ENDING_ENTRY - 1;
    target.cpu.REG_PC_NEW = target.cpu.REG_PC;
  },
  captureState(target) {
    return {
      pc: target.cpu.REG_PC,
      fixedSignature: Array.from(target.cpu.mem.slice(0xf386, 0xf38e)),
    };
  },
});

assert.equal(result.mode, 'epilogue');
assert.equal(result.layout, 'stable-128');
assert.equal(result.entry, 0x7f00);
assert.equal(result.sourceEntry, TUNSHI_POSTGAME_DRIVER_SOURCE);
assert.equal(result.bootstrapEntry, TUNSHI_POSTGAME_ENTRY);
assert.equal(runtime.refreshCount, 1);
assert.equal(runtime.imported.phase, 'epilogue');
assert.equal(runtime.imported.completed, false);
assert.deepEqual(runtime.imported.checkpoint.fixedSignature, TUNSHI_POSTGAME_PRE_ENDING_SIGNATURE);
assert.equal((nes.cpu.REG_PC + 1) & 0xffff, 0x7f00);
assert.deepEqual(
  Array.from(nes.cpu.mem.slice(0x7f00, 0x7f05)),
  TUNSHI_POSTGAME_DRIVER_SIGNATURE,
);
assert.equal(nes.mmap.prgAddressSelect, 0);
assert.equal(nes.mmap.prgAddressChanged, false);
assert.equal(nes.cpu.nmiRaised, false);
assert.equal(nes.cpu.nmiPending, false);
assert.equal(nes.cpu.nmiImmediate, false);
assert.equal(nes.cpu.irqRequested, false);

const wrongPcNes = makeNes();
wrongPcNes.cpu.REG_PC = 0x8122;
wrongPcNes.cpu.REG_PC_NEW = 0x8122;
assert.throws(() => bootTunshiPostgameEpilogue(
  wrongPcNes,
  ROM,
  makeRuntime(),
  sourceState,
  { restoreState() {}, captureState() {} },
), /期望 \$F386/);

const occupiedScratchNes = makeNes();
occupiedScratchNes.cpu.mem[0x7f42] = 1;
assert.throws(() => bootTunshiPostgameEpilogue(
  occupiedScratchNes,
  ROM,
  makeRuntime(),
  sourceState,
  {
    restoreState(target) {
      target.cpu.REG_PC = TUNSHI_POSTGAME_PRE_ENDING_ENTRY - 1;
      target.cpu.REG_PC_NEW = target.cpu.REG_PC;
    },
    captureState() { return {}; },
  },
), /\$7F00-\$7FFF 已被存档占用/);

const unrelated = ROM.slice();
unrelated[bankOffset(0x81, TUNSHI_POSTGAME_ENTRY)] ^= 0xff;
assert.throws(() => bootTunshiPostgameEpilogue(
  makeNes(),
  unrelated,
  makeRuntime(),
  sourceState,
  { restoreState() {}, captureState() {} },
), /已校验/);

console.log('✓ 汉室新章直达启动：校验完整检查点、跳过原版片尾、复制驱动到$7F00并清理中断');
