import assert from 'node:assert/strict';
import {
  installTunshiPostgameRuntime,
  isKnownTunshiPostgameRom,
  tunshiPostgameAddresses,
} from '../src/emulator/tunshi-postgame-runtime.js';

const HEADER_SIZE = 16;
const BANK_8K = 0x2000;
const ROM_SIZE = HEADER_SIZE + 0x80 * 0x4000;
const PRE_ENDING_SIGNATURE = [0xa9, 0x2a, 0x20, 0xe3, 0xc6, 0x4c, 0x03, 0xba];
const POSTGAME_SIGNATURE = [
  0xa2, 0x00, 0xbd, 0x00, 0xa0, 0x9d, 0x00,
  0x7f, 0xe8, 0xd0, 0xf7, 0x4c, 0x00, 0x7f,
];
const DRIVER_SIGNATURE = [0x20, 0x85, 0xd2, 0x00, 0x56];
const COMPLETION_MARKER = [0x48, 0x53, 0x58, 0x5a, 0xa5, 0x5a];

function bankOffset(bank, address) {
  return HEADER_SIZE + bank * BANK_8K + (address & 0x1fff);
}

function makePostgameRom() {
  const rom = new Uint8Array(ROM_SIZE);
  rom.set([0x4e, 0x45, 0x53, 0x1a, 0x80, 0x00, 0x40, 0x00]);
  rom.set(PRE_ENDING_SIGNATURE, bankOffset(0xff, tunshiPostgameAddresses.preEnding));
  rom.set(POSTGAME_SIGNATURE, bankOffset(0x81, tunshiPostgameAddresses.postgame));
  rom.set(DRIVER_SIGNATURE, bankOffset(0x81, 0xa000));
  return rom;
}

function setPc(cpu, address) {
  cpu.REG_PC = (address - 1) & 0xffff;
  cpu.REG_PC_NEW = cpu.REG_PC;
}

function makeCpu(executed) {
  const originalEmulate = function emulate() {
    executed.push((this.REG_PC + 1) & 0xffff);
    return 2;
  };
  const cpu = {
    mem: new Uint8Array(0x10000),
    REG_PC: 0,
    REG_PC_NEW: 0,
    emulate: originalEmulate,
    originalEmulate,
  };
  cpu.mem.set(PRE_ENDING_SIGNATURE, tunshiPostgameAddresses.preEnding);
  cpu.mem.set(POSTGAME_SIGNATURE, tunshiPostgameAddresses.postgame);
  return cpu;
}

function cloneState(nes) {
  return {
    pc: nes.cpu.REG_PC,
    pcNew: nes.cpu.REG_PC_NEW,
    mem: Array.from(nes.cpu.mem),
  };
}

const rom = makePostgameRom();
assert.equal(isKnownTunshiPostgameRom(rom), true);
assert.equal(isKnownTunshiPostgameRom(rom.buffer), true);
assert.equal(isKnownTunshiPostgameRom(String.fromCharCode(...rom.subarray(0, 64))), false);

const wrongHeader = rom.slice();
wrongHeader[4] = 0x40;
assert.equal(isKnownTunshiPostgameRom(wrongHeader), false);
const wrongFingerprint = rom.slice();
wrongFingerprint[bankOffset(0x81, tunshiPostgameAddresses.postgame)] ^= 0xff;
assert.equal(isKnownTunshiPostgameRom(wrongFingerprint), false);

const ignoredCpu = makeCpu([]);
const ignoredEmulate = ignoredCpu.emulate;
assert.equal(installTunshiPostgameRuntime({ cpu: ignoredCpu }, wrongFingerprint), null);
assert.equal(ignoredCpu.emulate, ignoredEmulate, '普通 ROM 不应安装 CPU 钩子');

const executed = [];
let fromJsonCalls = 0;
const nes = {
  cpu: makeCpu(executed),
  fromJSON(state) {
    fromJsonCalls += 1;
    this.cpu = makeCpu(executed);
    this.cpu.mem.set(state.mem);
    this.cpu.REG_PC = state.pc;
    this.cpu.REG_PC_NEW = state.pcNew;
  },
};

let captures = 0;
let restores = 0;
const events = [];
const controller = installTunshiPostgameRuntime(nes, rom, {
  captureState(target) {
    captures += 1;
    return cloneState(target);
  },
  restoreState(target, state) {
    restores += 1;
    target.fromJSON(state);
  },
  onEvent(event) {
    events.push(event.type);
  },
});
assert.ok(controller);
assert.equal(installTunshiPostgameRuntime(nes, rom), controller, '重复安装应返回同一控制器');

setPc(nes.cpu, tunshiPostgameAddresses.preEnding);
nes.cpu.emulate();
assert.equal(captures, 1);
assert.equal(controller.phase, 'credits');
assert.equal(controller.hasCheckpoint, true);
const creditsRuntimeState = controller.exportState({ includeCheckpoint: true });

setPc(nes.cpu, tunshiPostgameAddresses.postgame);
nes.cpu.emulate();
assert.equal(controller.phase, 'epilogue');
assert.equal(restores, 0, 'CPU 指令钩子内禁止恢复状态');

nes.cpu.mem.set(COMPLETION_MARKER.slice(0, -1), tunshiPostgameAddresses.completionMarker);
assert.equal(controller.afterFrame(), false, '不完整标记不能提前恢复');
assert.equal(restores, 0);
nes.cpu.mem[0x0089] = 0xff;
nes.cpu.mem[0x0084] = 0xff;
nes.cpu.mem.set(COMPLETION_MARKER, tunshiPostgameAddresses.completionMarker);
assert.equal(controller.afterFrame(), true, '帧结束后应识别有校验字节的完成标记');
assert.equal(restores, 1);
assert.equal(fromJsonCalls, 1);
assert.equal(controller.completed, true);
assert.equal(controller.phase, 'completed');
assert.equal(controller.hasCheckpoint, false);
assert.equal((nes.cpu.REG_PC + 1) & 0xffff, tunshiPostgameAddresses.continue);
assert.equal(nes.cpu.mem[0x0089], 0, '续篇结束后应退出脚本场景');
assert.equal(nes.cpu.mem[0x0084] & 0x08, 0, '续篇结束后应解除菜单/对话锁');

// fromJSON() replaced the CPU. The runtime wrapper must have been reattached.
nes.cpu.emulate();
assert.equal(executed.at(-1), tunshiPostgameAddresses.continue);

setPc(nes.cpu, tunshiPostgameAddresses.preEnding);
nes.cpu.emulate();
assert.equal(executed.at(-1), tunshiPostgameAddresses.continue, '重复结局应直接回到主循环');
assert.equal(captures, 1, '重复结局不应覆盖原检查点');
assert.deepEqual(controller.stats, { captureCount: 1, restoreCount: 1, retriggerCount: 1 });
assert.equal(controller.afterFrame(), false);
assert.ok(events.includes('checkpoint-captured'));
assert.ok(events.includes('continued'));
assert.ok(events.includes('retrigger-skipped'));

const metadata = controller.exportState();
assert.deepEqual(metadata, { version: 1, phase: 'completed', completed: true });
nes.cpu.mem.set(COMPLETION_MARKER, tunshiPostgameAddresses.completionMarker);
assert.equal(controller.resetForLoadedState(), true);
assert.equal(controller.phase, 'armed');
assert.equal(controller.completed, false);
assert.equal(controller.hasCheckpoint, false);
assert.deepEqual(
  Array.from(nes.cpu.mem.slice(
    tunshiPostgameAddresses.completionMarker,
    tunshiPostgameAddresses.completionMarker + COMPLETION_MARKER.length,
  )),
  new Array(COMPLETION_MARKER.length).fill(0),
  '读取存档时应清除旧的完成标记',
);

setPc(nes.cpu, tunshiPostgameAddresses.preEnding);
nes.cpu.emulate();
assert.equal(controller.phase, 'credits');
assert.equal(controller.hasCheckpoint, true);
assert.equal(captures, 2, '读取旧档后必须允许重新捕获大结局检查点');
assert.equal(controller.rearm(), true);
assert.equal(controller.phase, 'armed');
assert.equal(controller.hasCheckpoint, false, '手动 rearm 应丢弃片尾中的旧检查点');
assert.equal(controller.afterFrame(), false);
assert.ok(events.includes('rearmed'));

controller.importState(metadata);
assert.equal(controller.phase, 'completed');

// Rollback/state sync can call fromJSON hundreds of times. Every replaced CPU
// must be unwrapped immediately so the runtime does not retain its 64KB RAM.
for (let index = 0; index < 500; index++) {
  const previousCpu = nes.cpu;
  const previousWrapper = previousCpu.emulate;
  const state = cloneState(nes);
  nes.fromJSON(state);
  assert.notEqual(previousWrapper, previousCpu.originalEmulate);
  assert.equal(previousCpu.emulate, previousCpu.originalEmulate, `旧 CPU ${index} 的 hook 应已解除`);
  assert.notEqual(nes.cpu.emulate, nes.cpu.originalEmulate, `当前 CPU ${index} 应只挂当前 hook`);
}

const activeEmulate = nes.cpu.emulate;
controller.dispose();
assert.notEqual(nes.cpu.emulate, activeEmulate);
assert.equal(nes.cpu.emulate, nes.cpu.originalEmulate);
assert.equal(controller.active, false);

const throwingExecuted = [];
const throwingNes = {
  cpu: makeCpu(throwingExecuted),
  fromJSON() {
    this.cpu = makeCpu(throwingExecuted);
    throw new Error('broken state');
  },
};
const throwingController = installTunshiPostgameRuntime(throwingNes, rom, {
  captureState: cloneState,
  restoreState() {},
});
const cpuBeforeThrow = throwingNes.cpu;
assert.throws(() => throwingNes.fromJSON({}), /broken state/);
assert.equal(cpuBeforeThrow.emulate, cpuBeforeThrow.originalEmulate, '异常恢复也必须释放旧 CPU hook');
assert.notEqual(throwingNes.cpu.emulate, throwingNes.cpu.originalEmulate, '异常后的当前 CPU 必须重新挂 hook');
throwingController.dispose();
assert.equal(throwingNes.cpu.emulate, throwingNes.cpu.originalEmulate);

// A 2P joining while the host is already in the credits must receive the
// pre-ending checkpoint atomically with the current NES state. Importing that
// runtime metadata lets the guest finish the marker and restore identically.
const guestExecuted = [];
const guestNes = {
  cpu: makeCpu(guestExecuted),
  fromJSON(state) {
    this.cpu = makeCpu(guestExecuted);
    this.cpu.mem.set(state.mem);
    this.cpu.REG_PC = state.pc;
    this.cpu.REG_PC_NEW = state.pcNew;
  },
};
let guestRestores = 0;
const guestController = installTunshiPostgameRuntime(guestNes, rom, {
  captureState: cloneState,
  restoreState(target, state) {
    guestRestores += 1;
    target.fromJSON(state);
  },
});
guestController.importState(JSON.parse(JSON.stringify(creditsRuntimeState)));
assert.equal(guestController.phase, 'credits');
assert.equal(guestController.hasCheckpoint, true);
guestNes.cpu.mem.set(DRIVER_SIGNATURE, tunshiPostgameAddresses.ramPostgame);
setPc(guestNes.cpu, tunshiPostgameAddresses.ramPostgame);
guestNes.cpu.emulate();
assert.equal(guestController.phase, 'epilogue', '稳定布局的 $7F00 RAM 剧情驱动必须被运行时识别');
guestNes.cpu.mem.set(COMPLETION_MARKER, tunshiPostgameAddresses.completionMarker);
assert.equal(guestController.afterFrame(), true);
assert.equal(guestRestores, 1);
assert.equal(guestController.completed, true);
assert.equal((guestNes.cpu.REG_PC + 1) & 0xffff, tunshiPostgameAddresses.continue);
guestController.dispose();

console.log('✓ 吞食天地2通关运行时：精确ROM隔离、$BE00/$7F00双入口、结局前检查点、帧间恢复、500次CPU换代无历史引用、继续游戏与防重复触发');
