import {
  captureDeterministicState,
  restoreDeterministicState,
} from '../netplay/state.js';
import { setTunshiPostgameExtensionBanks } from './rom-compat.js';
import {
  getTunshiPostgameRomLayout,
  isKnownTunshiPostgameRom,
  TUNSHI_POSTGAME_ENTRY,
  TUNSHI_POSTGAME_PRE_ENDING_ENTRY,
  TUNSHI_POSTGAME_PRE_ENDING_SIGNATURE,
} from './tunshi-postgame-rom.js';

const POSTGAME_FIXED_SWITCH_ENTRY = 0xf38e;

function mappedBytesMatch(nes, address, expected) {
  const memory = nes?.cpu?.mem;
  if (!memory) return false;
  return expected.every((value, index) => memory[(address + index) & 0xffff] === value);
}

function setNextProgramCounter(nes, address) {
  const registerValue = (address - 1) & 0xffff;
  nes.cpu.REG_PC = registerValue;
  nes.cpu.REG_PC_NEW = registerValue;
}

function clearPendingInterrupts(nes) {
  nes.cpu.nmiRaised = false;
  nes.cpu.nmiPending = false;
  nes.cpu.nmiImmediate = false;
  nes.cpu.irqRequested = false;
}

/**
 * Starts the private epilogue from a complete, known-good emulator checkpoint.
 *
 * A ROM reset redirect alone is unsafe: the stock ending and dialogue engines
 * expect initialized CPU RAM, save RAM, PPU memory, palettes and MMC3 state.
 * Restoring all deterministic state first gives the scene the exact rendering
 * context it had at the end of the original campaign and prevents corrupt
 * portraits, stale sprites and entry flashes.
 *
 * The checkpoint is captured again after completing its pending frame. The
 * postgame runtime owns that clean snapshot and restores it when the prologue
 * ends, after which it resumes the normal overworld loop.
 */
export function bootTunshiPostgameEpilogue(nes, romData, runtime, sourceState, {
  restoreState = restoreDeterministicState,
  captureState = captureDeterministicState,
} = {}) {
  if (!nes?.cpu || !nes?.mmap || !runtime || !sourceState) {
    throw new Error('缺少汉室新章直达启动所需的 NES、运行时或检查点');
  }
  const layout = getTunshiPostgameRomLayout(romData);
  if (!isKnownTunshiPostgameRom(romData) || !layout) {
    throw new Error('直达启动只允许用于已校验的汉室新章 ROM');
  }

  restoreState(nes, sourceState, { preserveLocalAudio: true });
  runtime.refresh();

  // The build tool emits an instruction-boundary checkpoint at $F386. Running
  // even one frame before redirecting would start the old credits and leave a
  // half-consumed return stack, so reject arbitrary/mid-frame save states.
  const restoredPc = ((nes.cpu.REG_PC ?? -2) + 1) & 0xffff;
  if (restoredPc !== TUNSHI_POSTGAME_PRE_ENDING_ENTRY) {
    throw new Error(`续篇检查点入口错误：期望 $F386，实际 $${restoredPc.toString(16).padStart(4, '0').toUpperCase()}`);
  }

  // The supplied state must come from the verified end-of-campaign boundary.
  // Check its fixed-bank entry before replacing the switchable bank layout.
  nes.mmap.prgAddressSelect = 0;
  nes.mmap.prgAddressChanged = false;
  nes.mmap.load8kRomBank(layout.fixedCBank, 0xc000);
  nes.mmap.load8kRomBank(layout.fixedEBank, 0xe000);
  if (!mappedBytesMatch(
    nes,
    TUNSHI_POSTGAME_PRE_ENDING_ENTRY,
    TUNSHI_POSTGAME_PRE_ENDING_SIGNATURE,
  )) {
    throw new Error('结局检查点与汉室新章固定代码不匹配');
  }

  if (layout.bootStrategy === 'ram-copy') {
    const scratchEnd = layout.ramEntry + layout.driverCopyBytes;
    const scratchPage = nes.cpu.mem.subarray(layout.ramEntry, scratchEnd);
    if (scratchPage.length !== layout.driverCopyBytes
      || scratchPage.some((value) => value !== 0)) {
      throw new Error('续篇临时运行页 $7F00-$7FFF 已被存档占用，拒绝覆盖');
    }
  }

  const continuationCheckpoint = captureState(nes);
  runtime.importState({
    version: 1,
    phase: 'epilogue',
    completed: false,
    checkpoint: continuationCheckpoint,
  });

  // Skip the original credits completely. The new text/code pair is mapped
  // explicitly. The final in-place layout copies its short driver to writable
  // temporary $7F00 save-RAM page because the stock text/NMI routines replace
  // the switchable $A000 bank and actively use $5000-$5FFF as executable RAM.
  setTunshiPostgameExtensionBanks(nes, true);
  nes.mmap.load8kRomBank(layout.textBank, 0x8000);
  nes.mmap.load8kRomBank(layout.codeBank, 0xa000);
  if (!mappedBytesMatch(nes, layout.romEntry, layout.romEntrySignature)) {
    throw new Error('汉室新章剧情入口损坏，已停止直达启动');
  }
  clearPendingInterrupts(nes);

  let runtimeEntry = TUNSHI_POSTGAME_ENTRY;
  if (layout.bootStrategy === 'ram-copy') {
    if (!mappedBytesMatch(nes, layout.driverSource, layout.driverSignature)) {
      throw new Error('汉室新章剧情驱动损坏，已停止直达启动');
    }
    const source = nes.cpu.mem.slice(
      layout.driverSource,
      layout.driverSource + layout.driverCopyBytes,
    );
    // Direct memory copy is intentional: Mapper0.write() would report 256
    // transient driver bytes as battery-save changes. The checkpoint restores
    // this page atomically when the prologue completes.
    nes.cpu.mem.set(source, layout.ramEntry);
    runtimeEntry = layout.ramEntry;
  } else if (layout.bootStrategy === 'fixed-switch') {
    // Legacy expanded builds need the game's own bank-switch routine to update
    // its bank bookkeeping before the first dialogue. They are retained only
    // for local migration; the in-place layout above is the production path.
    runtimeEntry = POSTGAME_FIXED_SWITCH_ENTRY;
  } else {
    throw new Error(`不支持的汉室新章启动布局：${layout.bootStrategy}`);
  }
  setNextProgramCounter(nes, runtimeEntry);

  return {
    mode: 'epilogue',
    layout: layout.id,
    entry: runtimeEntry,
    sourceEntry: layout.driverSource,
    bootstrapEntry: layout.romEntry,
    checkpoint: continuationCheckpoint,
  };
}

export const tunshiPostgameBootAddresses = Object.freeze({
  preEnding: TUNSHI_POSTGAME_PRE_ENDING_ENTRY,
  epilogue: TUNSHI_POSTGAME_ENTRY,
  ramEpilogue: 0x7f00,
});
