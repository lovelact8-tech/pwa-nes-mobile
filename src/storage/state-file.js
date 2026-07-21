const REQUIRED_STATE_SECTIONS = Object.freeze([
  'cpu',
  'mmap',
  'ppu',
  'papu',
  'controllers',
]);

export const PWA_STATE_FORMAT = 'pwa-nes-mobile-state';
export const PWA_STATE_VERSION = 2;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertJsnesState(state) {
  if (!isRecord(state)) throw new Error('存档内容不是有效的 jsnes 状态对象');
  const missing = REQUIRED_STATE_SECTIONS.filter((section) => !isRecord(state[section]));
  if (missing.length) throw new Error(`存档缺少必要数据：${missing.join('、')}`);
  return state;
}

function normalizePostgameRuntime(value) {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw new Error('存档的续篇运行状态无效');
  const phase = String(value.phase || 'armed');
  if (!['armed', 'credits', 'epilogue', 'completed'].includes(phase)) {
    throw new Error('存档的续篇阶段无效');
  }
  if (value.checkpoint !== undefined && value.checkpoint !== null) {
    assertJsnesState(value.checkpoint);
  }
  if (['credits', 'epilogue'].includes(phase) && !value.checkpoint) {
    throw new Error('片尾存档缺少大结局前检查点');
  }
  return {
    version: Number(value.version) || 1,
    phase,
    completed: Boolean(value.completed),
    ...(value.checkpoint ? { checkpoint: value.checkpoint } : {}),
  };
}

function normalizeRomIdentity(payload) {
  if (!isRecord(payload)) return null;
  const source = isRecord(payload.rom) ? payload.rom : payload;
  const sha256 = source.sha256 ?? payload.romSha256;
  const bytes = source.bytes ?? source.length ?? payload.romLength;
  if (sha256 === undefined && bytes === undefined) return null;

  const normalized = {};
  if (sha256 !== undefined) {
    const value = String(sha256).trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(value)) throw new Error('存档中的 ROM SHA-256 无效');
    normalized.sha256 = value;
  }
  if (bytes !== undefined) {
    const value = Number(bytes);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('存档中的 ROM 文件长度无效');
    normalized.bytes = value;
  }
  if (source.filename) normalized.filename = String(source.filename);
  return normalized;
}

function normalizeGameFrame(value) {
  if (value === undefined || value === null) return 0;
  if (!Number.isFinite(value) || value < 0) throw new Error('存档的 gameFrame 必须是非负数字');
  return Math.floor(value);
}

/**
 * Accepts either a raw NES#toJSON() object or the portable wrapper used by
 * deterministic/netplay tools: { state, gameFrame }.
 */
export function parseStatePayload(payload) {
  const wrapped = isRecord(payload) && Object.hasOwn(payload, 'state');
  const state = assertJsnesState(wrapped ? payload.state : payload);
  const gameFrame = normalizeGameFrame(wrapped ? payload.gameFrame : 0);
  const postgameRuntime = normalizePostgameRuntime(wrapped ? payload.postgameRuntime : null);
  const rom = wrapped ? normalizeRomIdentity(payload) : null;
  return {
    state,
    gameFrame,
    postgameRuntime,
    rom,
    wrapped,
  };
}

export function createStateEnvelope({
  state,
  gameFrame = 0,
  postgameRuntime = null,
  rom = null,
} = {}) {
  const envelope = {
    format: PWA_STATE_FORMAT,
    version: PWA_STATE_VERSION,
    state: assertJsnesState(state),
    gameFrame: normalizeGameFrame(gameFrame),
  };
  const normalizedRuntime = normalizePostgameRuntime(postgameRuntime);
  const normalizedRom = normalizeRomIdentity(rom ? { rom } : null);
  if (normalizedRuntime) envelope.postgameRuntime = normalizedRuntime;
  if (normalizedRom) envelope.rom = normalizedRom;
  return envelope;
}

export function parseStateFileText(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('存档文件为空');

  let payload;
  try {
    payload = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('存档不是有效的 JSON 文件');
  }

  return parseStatePayload(payload);
}

export function assertStateRomMatches(imported, {
  sha256 = '',
  bytes = 0,
} = {}) {
  const identity = imported?.rom;
  if (!identity) return false;
  if (identity.bytes && Number(bytes) !== identity.bytes) {
    throw new Error(`存档对应的 ROM 大小为 ${identity.bytes} 字节，当前 ROM 不匹配`);
  }
  if (identity.sha256 && String(sha256).toLowerCase() !== identity.sha256) {
    throw new Error('存档对应的 ROM SHA-256 与当前游戏不匹配');
  }
  return true;
}

export async function readStateFile(file) {
  if (!file || typeof file.text !== 'function') throw new Error('没有选择存档文件');
  return parseStateFileText(await file.text());
}

export const stateFileRequiredSections = REQUIRED_STATE_SECTIONS;
