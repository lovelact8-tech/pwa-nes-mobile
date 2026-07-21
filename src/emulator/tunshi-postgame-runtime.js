import {
  captureDeterministicState,
  restoreDeterministicState,
} from '../netplay/state.js';
import {
  isKnownTunshiPostgameRom,
  TUNSHI_POSTGAME_ENTRY,
  TUNSHI_POSTGAME_ENTRY_SIGNATURE,
  TUNSHI_POSTGAME_PRE_ENDING_ENTRY,
  TUNSHI_POSTGAME_PRE_ENDING_SIGNATURE,
} from './tunshi-postgame-rom.js';

export { isKnownTunshiPostgameRom } from './tunshi-postgame-rom.js';

const PRE_ENDING_ENTRY = TUNSHI_POSTGAME_PRE_ENDING_ENTRY;
const POSTGAME_ENTRY = TUNSHI_POSTGAME_ENTRY;
const CONTINUE_ENTRY = 0xf43f;
const COMPLETION_MARKER_ADDRESS = 0x07f8;
const COMPLETION_MARKER = [0x48, 0x53, 0x58, 0x5a, 0xa5, 0x5a]; // HSXZ + guard

const PRE_ENDING_SIGNATURE = TUNSHI_POSTGAME_PRE_ENDING_SIGNATURE;
const POSTGAME_SIGNATURE = TUNSHI_POSTGAME_ENTRY_SIGNATURE;
const RUNTIME_SLOT = Symbol('tunshiPostgameRuntime');

function currentProgramCounter(nes) {
  return ((nes?.cpu?.REG_PC ?? -2) + 1) & 0xffff;
}

function setNextProgramCounter(nes, address) {
  const registerValue = (address - 1) & 0xffff;
  nes.cpu.REG_PC = registerValue;
  nes.cpu.REG_PC_NEW = registerValue;
}

function mappedBytesMatch(nes, address, expected) {
  const memory = nes?.cpu?.mem;
  if (!memory) return false;
  return expected.every((value, index) => memory[(address + index) & 0xffff] === value);
}

function defaultCaptureState(nes) {
  return captureDeterministicState(nes);
}

function defaultRestoreState(nes, state) {
  restoreDeterministicState(nes, state, { preserveLocalAudio: true });
}

/**
 * Installs an instruction-boundary watcher for the private postgame ROM.
 *
 * A frame-level watcher cannot reliably observe $F386 or $BE00 because both
 * addresses normally execute between two requestAnimationFrame callbacks.
 * Wrapping cpu.emulate observes the exact instruction boundary without
 * changing jsnes timing or the number of emulated CPU cycles. Restoration is
 * deliberately deferred to afterFrame(): nes.fromJSON() must never replace
 * CPU/PPU objects in the middle of jsnes' frame-local execution loop.
 */
export function installTunshiPostgameRuntime(nes, romData, {
  captureState = defaultCaptureState,
  restoreState = defaultRestoreState,
  onEvent = null,
} = {}) {
  if (!nes?.cpu || !isKnownTunshiPostgameRom(romData)) return null;
  if (nes[RUNTIME_SLOT]) return nes[RUNTIME_SLOT];

  let phase = 'armed';
  let checkpoint = null;
  let completed = false;
  let captureCount = 0;
  let restoreCount = 0;
  let retriggerCount = 0;
  let disposed = false;
  let currentCpuHook = null;

  function emit(type, detail = {}) {
    if (typeof onEvent !== 'function') return;
    try {
      onEvent({ type, phase, completed, ...detail });
    } catch (error) {
      console.warn('吞食天地2通关运行时事件处理失败', error);
    }
  }

  function setPhase(nextPhase, reason) {
    const previousPhase = phase;
    phase = nextPhase;
    emit('phase-change', { previousPhase, reason });
  }

  function clearStaleCompletionMarker() {
    if (!mappedBytesMatch(nes, COMPLETION_MARKER_ADDRESS, COMPLETION_MARKER)) return;
    nes.cpu.mem.fill(
      0,
      COMPLETION_MARKER_ADDRESS,
      COMPLETION_MARKER_ADDRESS + COMPLETION_MARKER.length,
    );
  }

  function rearm(reason = 'manual-rearm') {
    if (disposed) return false;
    checkpoint = null;
    completed = false;
    clearStaleCompletionMarker();
    setPhase('armed', reason);
    attachCpu(nes.cpu);
    emit('rearmed', { reason });
    return true;
  }

  function hasPreEndingSignature() {
    return mappedBytesMatch(nes, PRE_ENDING_ENTRY, PRE_ENDING_SIGNATURE);
  }

  function hasPostgameSignature() {
    return mappedBytesMatch(nes, POSTGAME_ENTRY, POSTGAME_SIGNATURE);
  }

  function detachCpuHook() {
    const record = currentCpuHook;
    currentCpuHook = null;
    if (record && record.cpu?.emulate === record.wrapper) record.cpu.emulate = record.original;
  }

  function attachCpu(cpu = nes.cpu) {
    if (!cpu || typeof cpu.emulate !== 'function') return;
    if (currentCpuHook?.cpu === cpu && cpu.emulate === currentCpuHook.wrapper) return;

    // NES#fromJSON() replaces the CPU object. Retaining every historical CPU
    // here would also retain each 64KB memory array across long rollback
    // sessions, so only the currently live CPU may stay referenced.
    detachCpuHook();

    const original = cpu.emulate;
    const wrapper = function postgameAwareEmulate(...args) {
      beforeInstruction();
      return original.apply(cpu, args);
    };
    currentCpuHook = { cpu, original, wrapper };
    cpu.emulate = wrapper;
  }

  function restoreCheckpointAndContinue() {
    if (!checkpoint || phase === 'restoring') return;
    const savedCheckpoint = checkpoint;
    setPhase('restoring', 'postgame-complete');
    try {
      restoreState(nes, savedCheckpoint);
      attachCpu(nes.cpu);
      // The restored snapshot was captured immediately before the stock
      // credits entry. Clear the scripted-scene/menu locks just like ordinary
      // event tails do before returning to the overworld loop.
      if (nes.cpu?.mem) {
        nes.cpu.mem[0x0089] = 0;
        nes.cpu.mem[0x0084] &= 0xf7;
      }
      setNextProgramCounter(nes, CONTINUE_ENTRY);
      checkpoint = null;
      completed = true;
      restoreCount += 1;
      setPhase('completed', 'checkpoint-restored');
      emit('continued', { address: CONTINUE_ENTRY });
    } catch (error) {
      checkpoint = savedCheckpoint;
      setPhase('epilogue', 'restore-failed');
      emit('restore-error', { message: error?.message || String(error) });
      throw error;
    }
  }

  function beforeInstruction() {
    if (disposed || !nes.cpu) return;
    const pc = currentProgramCounter(nes);

    if (pc === PRE_ENDING_ENTRY && hasPreEndingSignature()) {
      if (completed) {
        retriggerCount += 1;
        setNextProgramCounter(nes, CONTINUE_ENTRY);
        emit('retrigger-skipped', { address: CONTINUE_ENTRY });
        return;
      }
      if (phase === 'armed') {
        checkpoint = captureState(nes);
        captureCount += 1;
        setPhase('credits', 'pre-ending-checkpoint');
        emit('checkpoint-captured', { address: PRE_ENDING_ENTRY });
      }
    }

    if ((phase === 'credits' || phase === 'epilogue')
      && pc === POSTGAME_ENTRY
      && hasPostgameSignature()) {
      if (phase !== 'epilogue') setPhase('epilogue', 'postgame-entry');
      return;
    }

  }

  const originalFromJSON = nes.fromJSON;
  const wrappedFromJSON = typeof originalFromJSON === 'function'
    ? function postgameAwareFromJSON(...args) {
      // Drop the old CPU before jsnes reset() allocates the replacement. The
      // finally path also keeps the runtime usable if a malformed state throws
      // after reset has already replaced part of the live emulator.
      detachCpuHook();
      try {
        return originalFromJSON.apply(this, args);
      } finally {
        attachCpu(this.cpu);
      }
    }
    : null;
  if (wrappedFromJSON) nes.fromJSON = wrappedFromJSON;

  const controller = {
    get active() { return !disposed; },
    get phase() { return phase; },
    get completed() { return completed; },
    get hasCheckpoint() { return Boolean(checkpoint); },
    get stats() {
      return { captureCount, restoreCount, retriggerCount };
    },
    refresh() {
      attachCpu(nes.cpu);
    },
    rearm() {
      return rearm('manual-rearm');
    },
    resetForLoadedState() {
      return rearm('loaded-state');
    },
    afterFrame() {
      if (disposed || !checkpoint || !['credits', 'epilogue'].includes(phase)) return false;
      const markerComplete = mappedBytesMatch(nes, COMPLETION_MARKER_ADDRESS, COMPLETION_MARKER);
      // The guarded RAM marker is authoritative. $F43F remains a compatibility
      // fallback for an early prototype that did not yet write the marker.
      const legacyPcComplete = phase === 'epilogue' && currentProgramCounter(nes) === CONTINUE_ENTRY;
      if (!markerComplete && !legacyPcComplete) return false;
      restoreCheckpointAndContinue();
      return true;
    },
    exportState({ includeCheckpoint = false } = {}) {
      return {
        version: 1,
        phase,
        completed,
        ...(includeCheckpoint && checkpoint ? { checkpoint } : {}),
      };
    },
    importState(state = {}) {
      completed = Boolean(state.completed);
      checkpoint = state.checkpoint || null;
      if (completed) phase = 'completed';
      else if (checkpoint && ['credits', 'epilogue'].includes(state.phase)) phase = state.phase;
      else phase = 'armed';
      attachCpu(nes.cpu);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      detachCpuHook();
      if (wrappedFromJSON && nes.fromJSON === wrappedFromJSON) nes.fromJSON = originalFromJSON;
      checkpoint = null;
      delete nes[RUNTIME_SLOT];
    },
  };

  nes[RUNTIME_SLOT] = controller;
  attachCpu(nes.cpu);
  emit('installed');
  return controller;
}

export const tunshiPostgameAddresses = Object.freeze({
  preEnding: PRE_ENDING_ENTRY,
  postgame: POSTGAME_ENTRY,
  continue: CONTINUE_ENTRY,
  completionMarker: COMPLETION_MARKER_ADDRESS,
});
