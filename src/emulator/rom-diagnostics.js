const MAX_EVENTS = 200;

function byteLengthOf(data) {
  return data?.byteLength ?? data?.length ?? 0;
}

function byteAt(data, offset) {
  if (typeof data === 'string') return data.charCodeAt(offset) & 0xff;
  if (data instanceof ArrayBuffer) return new Uint8Array(data)[offset];
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)[offset];
  }
  return undefined;
}

function toBytes(data) {
  if (typeof data === 'string') {
    const bytes = new Uint8Array(data.length);
    for (let index = 0; index < data.length; index += 1) bytes[index] = data.charCodeAt(index) & 0xff;
    return bytes;
  }
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new Uint8Array();
}

function hex(value, width = 2) {
  if (!Number.isFinite(value)) return 'unknown';
  return `$${(value >>> 0).toString(16).toUpperCase().padStart(width, '0')}`;
}

function fnv1a32(data) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < byteLengthOf(data); index += 1) {
    hash ^= byteAt(data, index) || 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function inspectInesRom(romData) {
  const length = byteLengthOf(romData);
  const validMagic = length >= 16
    && byteAt(romData, 0) === 0x4e
    && byteAt(romData, 1) === 0x45
    && byteAt(romData, 2) === 0x53
    && byteAt(romData, 3) === 0x1a;
  if (!validMagic) {
    return {
      length,
      validMagic: false,
      format: 'unknown',
      fnv1a32: fnv1a32(romData),
    };
  }

  const flags6 = byteAt(romData, 6) || 0;
  const flags7 = byteAt(romData, 7) || 0;
  const nes2 = (flags7 & 0x0c) === 0x08;
  const prgBanks = byteAt(romData, 4) || 0;
  const chrBanks = byteAt(romData, 5) || 0;
  const trainer = Boolean(flags6 & 0x04);
  const expectedBytes = 16 + (trainer ? 512 : 0) + prgBanks * 0x4000 + chrBanks * 0x2000;
  return {
    length,
    validMagic: true,
    format: nes2 ? 'NES 2.0' : 'iNES',
    prgBanks,
    prgBytes: prgBanks * 0x4000,
    chrBanks,
    chrBytes: chrBanks * 0x2000,
    mapper: (flags6 >> 4) | (flags7 & 0xf0),
    submapper: nes2 ? ((byteAt(romData, 8) || 0) >> 4) : null,
    battery: Boolean(flags6 & 0x02),
    trainer,
    mirroring: flags6 & 0x08 ? 'four-screen' : flags6 & 0x01 ? 'vertical' : 'horizontal',
    expectedBytes,
    trailingBytes: length - expectedBytes,
    fnv1a32: fnv1a32(romData),
  };
}

async function sha256(data) {
  if (!globalThis.crypto?.subtle) return 'unavailable';
  const digest = await globalThis.crypto.subtle.digest('SHA-256', toBytes(data));
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
}

function safeDetail(detail = {}) {
  const safe = {};
  for (const [key, value] of Object.entries(detail)) {
    if (/romData|bytes|ticket|access|token|secret/i.test(key)) continue;
    if (value === undefined) continue;
    safe[key] = typeof value === 'string' && value.length > 300 ? `${value.slice(0, 300)}…` : value;
  }
  return safe;
}

function cpuSnapshot(nes) {
  const cpu = nes?.cpu;
  if (!cpu) return {};
  return {
    pc: hex(((cpu.REG_PC ?? 0) + 1) & 0xffff, 4),
    a: hex(cpu.REG_ACC, 2),
    x: hex(cpu.REG_X, 2),
    y: hex(cpu.REG_Y, 2),
    sp: hex(cpu.REG_SP, 2),
    cpuCrash: Boolean(cpu.crash),
    nesCrashed: Boolean(nes?.crashed),
  };
}

export function createRomDiagnostics({ output = null } = {}) {
  let startedAt = performance.now();
  let romName = 'none';
  let romSource = 'none';
  let header = inspectInesRom('');
  let sha = 'none';
  let shaPromise = Promise.resolve('none');
  let currentNes = null;
  let currentFrame = 0;
  let lastStatus = '';
  let firstFrameSeen = false;
  let sessionId = 0;
  const recentFrameSamples = [];
  const events = [];

  const render = () => {
    if (output) output.textContent = events.join('\n');
  };

  const event = (name, detail = {}) => {
    const elapsed = ((performance.now() - startedAt) / 1000).toFixed(3);
    const sanitized = safeDetail(detail);
    const suffix = Object.keys(sanitized).length ? ` ${JSON.stringify(sanitized)}` : '';
    const line = `[+${elapsed}s] ${name}${suffix}`;
    events.push(line);
    if (events.length > MAX_EVENTS) events.shift();
    render();
    console.info(`[NES ROM] ${name}`, sanitized);
  };

  const start = ({ name = 'NES 游戏', data, source = 'unknown' }) => {
    sessionId += 1;
    const startedSessionId = sessionId;
    startedAt = performance.now();
    romName = String(name || 'NES 游戏');
    romSource = source;
    header = inspectInesRom(data);
    sha = 'calculating';
    currentNes = null;
    currentFrame = 0;
    lastStatus = '';
    firstFrameSeen = false;
    recentFrameSamples.length = 0;
    events.length = 0;
    event('rom-open', {
      name: romName,
      source: romSource,
      length: header.length,
      format: header.format,
      mapper: header.mapper ?? 'unknown',
      prgBanks: header.prgBanks ?? 'unknown',
      chrBanks: header.chrBanks ?? 'unknown',
      fnv1a32: header.fnv1a32,
    });
    shaPromise = sha256(data).then((value) => {
      if (sessionId !== startedSessionId) return value;
      sha = value;
      event('rom-sha256-ready', { sha256: value });
      return value;
    }).catch((error) => {
      if (sessionId !== startedSessionId) return 'superseded';
      sha = 'failed';
      event('rom-sha256-error', { message: error?.message || String(error) });
      return sha;
    });
  };

  const attach = (nes, detail = {}) => {
    currentNes = nes;
    event('rom-loaded', {
      mapperObject: nes?.mmap?.constructor?.name || 'unknown',
      ...detail,
    });
  };

  const frame = (nes, frameNumber) => {
    currentNes = nes || currentNes;
    currentFrame = frameNumber;
    if (!firstFrameSeen) {
      firstFrameSeen = true;
      event('first-frame', { frame: frameNumber, ...cpuSnapshot(currentNes) });
    }
    if (frameNumber % 60 === 0) {
      recentFrameSamples.push({ frame: frameNumber, pc: cpuSnapshot(currentNes).pc });
      if (recentFrameSamples.length > 24) recentFrameSamples.shift();
    }
  };

  const status = (text) => {
    const normalized = String(text || '');
    if (!normalized || normalized === lastStatus) return;
    lastStatus = normalized;
    event('status', { text: normalized });
  };

  const error = (errorValue, detail = {}) => {
    const message = errorValue?.message || String(errorValue || 'unknown error');
    event('emulator-error', {
      frame: currentFrame,
      message,
      stack: errorValue?.stack?.split('\n').slice(0, 4).join(' | ') || '',
      ...cpuSnapshot(currentNes),
      ...detail,
    });
  };

  const getLog = () => [
    'PWA NES ROM 兼容诊断日志',
    `time=${new Date().toISOString()}`,
    `page=${typeof location === 'undefined' ? 'node' : `${location.origin}${location.pathname}`}`,
    `romName=${romName}`,
    `romSource=${romSource}`,
    `romSize=${header.length}`,
    `sha256=${sha}`,
    `fnv1a32=${header.fnv1a32}`,
    `format=${header.format}`,
    `validInes=${header.validMagic}`,
    `mapper=${header.mapper ?? 'unknown'}`,
    `submapper=${header.submapper ?? 'none'}`,
    `prgBanks=${header.prgBanks ?? 'unknown'}`,
    `chrBanks=${header.chrBanks ?? 'unknown'}`,
    `battery=${header.battery ?? 'unknown'}`,
    `trainer=${header.trainer ?? 'unknown'}`,
    `mirroring=${header.mirroring ?? 'unknown'}`,
    `expectedBytes=${header.expectedBytes ?? 'unknown'}`,
    `trailingBytes=${header.trailingBytes ?? 'unknown'}`,
    `gameFrame=${currentFrame}`,
    `mapperObject=${currentNes?.mmap?.constructor?.name || 'none'}`,
    `compatMapper198=${Boolean(currentNes?.mmap?.__tunshiMapper198Ram)}`,
    `compatChrRam=${Boolean(currentNes?.mmap?.__tunshiMapper198ChrRam)}`,
    `recentFramePC=${recentFrameSamples.map((sample) => `${sample.frame}:${sample.pc}`).join(',') || 'none'}`,
    ...Object.entries(cpuSnapshot(currentNes)).map(([key, value]) => `${key}=${value}`),
    `userAgent=${typeof navigator === 'undefined' ? 'node' : navigator.userAgent}`,
    '',
    ...events,
  ].join('\n');

  return {
    start,
    attach,
    frame,
    status,
    event,
    error,
    getLog,
    waitForHash: () => shaPromise,
  };
}
