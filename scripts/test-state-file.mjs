import assert from 'node:assert/strict';
import {
  assertStateRomMatches,
  createStateEnvelope,
  parseStateFileText,
  parseStatePayload,
  PWA_STATE_FORMAT,
  PWA_STATE_VERSION,
  readStateFile,
  stateFileRequiredSections,
} from '../src/storage/state-file.js';

function makeState() {
  return Object.fromEntries(stateFileRequiredSections.map((section) => [section, { section }]));
}

const rawState = makeState();
assert.deepEqual(parseStateFileText(JSON.stringify(rawState)), {
  state: rawState,
  gameFrame: 0,
  postgameRuntime: null,
  rom: null,
  wrapped: false,
});

const wrappedState = makeState();
const postgameRuntime = { version: 1, phase: 'credits', completed: false, checkpoint: makeState() };
const envelope = createStateEnvelope({
  state: wrappedState,
  gameFrame: 1234.9,
  postgameRuntime,
  rom: {
    filename: 'private.nes',
    bytes: 1081360,
    sha256: 'a'.repeat(64),
  },
});
assert.equal(envelope.format, PWA_STATE_FORMAT);
assert.equal(envelope.version, PWA_STATE_VERSION);
assert.deepEqual(parseStateFileText(`\uFEFF${JSON.stringify(envelope)}`), {
  state: wrappedState,
  gameFrame: 1234,
  postgameRuntime,
  rom: {
    filename: 'private.nes',
    bytes: 1081360,
    sha256: 'a'.repeat(64),
  },
  wrapped: true,
});
const parsedEnvelope = parseStatePayload(envelope);
assert.equal(assertStateRomMatches(parsedEnvelope, {
  bytes: 1081360,
  sha256: 'a'.repeat(64),
}), true);
assert.throws(() => assertStateRomMatches(parsedEnvelope, {
  bytes: 1081361,
  sha256: 'a'.repeat(64),
}), /ROM 大小/);
assert.throws(() => assertStateRomMatches(parsedEnvelope, {
  bytes: 1081360,
  sha256: 'b'.repeat(64),
}), /SHA-256/);
assert.equal(assertStateRomMatches(parseStatePayload(rawState), {
  bytes: 1081360,
  sha256: 'a'.repeat(64),
}), false, '旧 raw state 应保持可解析，但明确标记为未校验');

const fileResult = await readStateFile({
  async text() {
    return JSON.stringify({ state: makeState(), gameFrame: 88 });
  },
});
assert.equal(fileResult.gameFrame, 88);
assert.equal(fileResult.wrapped, true);
assert.deepEqual(Object.keys(fileResult.state).sort(), [...stateFileRequiredSections].sort());

assert.throws(() => parseStateFileText(''), /存档文件为空/);
assert.throws(() => parseStateFileText('{broken'), /不是有效的 JSON/);
assert.throws(() => parseStateFileText(JSON.stringify({ cpu: {} })), /缺少必要数据/);
assert.throws(
  () => parseStateFileText(JSON.stringify({ state: makeState(), gameFrame: -1 })),
  /gameFrame 必须是非负数字/,
);
assert.throws(
  () => parseStateFileText(JSON.stringify({ state: makeState(), rom: { sha256: 'broken' } })),
  /ROM SHA-256 无效/,
);
assert.throws(
  () => parseStateFileText(JSON.stringify({ state: makeState(), postgameRuntime: { checkpoint: {} } })),
  /存档缺少必要数据/,
);
assert.throws(
  () => parseStateFileText(JSON.stringify({
    state: makeState(),
    postgameRuntime: { phase: 'credits', completed: false },
  })),
  /片尾存档缺少大结局前检查点/,
);
await assert.rejects(() => readStateFile(null), /没有选择存档文件/);

console.log('✓ JSON 存档导入模块：raw/版本化封装、runtime 原子元数据、ROM SHA/长度与损坏文件校验');
