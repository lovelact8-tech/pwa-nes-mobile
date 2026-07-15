const RENDER_ONLY_PPU_KEYS = new Set([
  'buffer',
  'bgbuffer',
  'pixrendered',
  'vramMirrorTable',
  // jsnes rebuilds these scanline/tile caches while drawing. Silent rollback
  // deliberately skips drawing, so they can differ without changing any
  // CPU-visible PPU register, VRAM, sprite RAM, or future game result.
  'attrib',
  'scantile',
  'curNt',
  'lastRenderedScanline',
  'validTileData',
  'scanlineAlreadyRendered',
]);

// These fields only control conversion from the deterministic APU channels to
// device audio samples. They legitimately differ between a 44.1 kHz Mac and a
// 48 kHz iPhone, but cannot affect CPU, mapper, PPU, or controller execution.
const PAPU_OUTPUT_KEYS = new Set([
  'sampleRate',
  'startedPlaying',
  'recordOutput',
  'sampleTimer',
  'sampleTimerMax',
  'sampleCount',
  'triValue',
  'smpSquare1',
  'smpSquare2',
  'smpTriangle',
  'smpDmc',
  'accCount',
  'prevSampleL',
  'prevSampleR',
  'smpAccumL',
  'smpAccumR',
  'masterVolume',
  'stereoPosLSquare1',
  'stereoPosLSquare2',
  'stereoPosLTriangle',
  'stereoPosLNoise',
  'stereoPosLDMC',
  'stereoPosRSquare1',
  'stereoPosRSquare2',
  'stereoPosRTriangle',
  'stereoPosRNoise',
  'stereoPosRDMC',
  'extraCycles',
  'maxSample',
  'minSample',
  'panning',
]);

function withoutKeys(value = {}, omittedKeys) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !omittedKeys.has(key)));
}

function deterministicPapuView(papu = {}) {
  const view = withoutKeys(papu, PAPU_OUTPUT_KEYS);
  // Noise integrates its instantaneous output between host audio samples.
  // Sampling phase is device-local, while the shift register, timer, length,
  // and envelope fields remain deterministic and are still verified.
  if (view.noise) view.noise = withoutKeys(view.noise, new Set(['accValue', 'accCount']));
  return view;
}

export function captureDeterministicState(nes) {
  const ppu = nes.ppu;
  const omitted = {
    buffer: ppu.buffer,
    bgbuffer: ppu.bgbuffer,
    pixrendered: ppu.pixrendered,
    vramMirrorTable: ppu.vramMirrorTable,
  };
  ppu.buffer = [];
  ppu.bgbuffer = [];
  ppu.pixrendered = [];
  ppu.vramMirrorTable = [];
  try {
    return nes.toJSON();
  } finally {
    Object.assign(ppu, omitted);
  }
}

function resetLocalAudioOutput(nes, localAudio) {
  if (!localAudio || !nes.papu) return;
  const papu = nes.papu;
  papu.sampleRate = localAudio.sampleRate;
  papu.sampleTimerMax = Math.floor((1024 * 1789772.5) / localAudio.sampleRate);
  papu.sampleTimer = 0;
  papu.extraCycles = 0;
  papu.sampleCount = 0;
  papu.accCount = 0;
  papu.prevSampleL = 0;
  papu.prevSampleR = 0;
  papu.smpAccumL = 0;
  papu.smpAccumR = 0;
  if (papu.noise) {
    papu.noise.accValue = papu.noise.sampleValue || 0;
    papu.noise.accCount = 1;
  }
  papu.masterVolume = localAudio.masterVolume;
  papu.setPanning(localAudio.panning);
  papu.setMasterVolume(localAudio.masterVolume);
}

export function restoreDeterministicState(nes, state, { preserveLocalAudio = false } = {}) {
  const localAudio = preserveLocalAudio && nes.papu ? {
    sampleRate: nes.opts?.sampleRate || nes.papu.sampleRate || 48000,
    masterVolume: nes.papu.masterVolume,
    panning: Array.from(nes.papu.panning || [80, 170, 100, 150, 128]),
  } : null;
  const ppuState = state.ppu;
  if (!ppuState) {
    nes.fromJSON(state);
    resetLocalAudioOutput(nes, localAudio);
    return;
  }
  const omitted = {
    buffer: ppuState.buffer,
    bgbuffer: ppuState.bgbuffer,
    pixrendered: ppuState.pixrendered,
    vramMirrorTable: ppuState.vramMirrorTable,
  };
  ppuState.buffer = nes.ppu.buffer;
  ppuState.bgbuffer = nes.ppu.bgbuffer;
  ppuState.pixrendered = nes.ppu.pixrendered;
  nes.ppu.currentMirroring = -1;
  nes.ppu.setMirroring(Number(ppuState.currentMirroring));
  ppuState.vramMirrorTable = nes.ppu.vramMirrorTable;
  try {
    nes.fromJSON(state);
    resetLocalAudioOutput(nes, localAudio);
  } finally {
    // A saved snapshot must never keep references to mutable live render data.
    Object.assign(ppuState, omitted);
  }
}

export function deterministicStateView(state) {
  return {
    cpu: state.cpu,
    mmap: state.mmap,
    ppu: withoutKeys(state.ppu, RENDER_ONLY_PPU_KEYS),
    // APU frame IRQ and DMC IRQ state can affect CPU execution, so channel and
    // IRQ state stays in the hash. Device-only audio sampling fields do not.
    papu: deterministicPapuView(state.papu),
    controllers: state.controllers,
  };
}

export function hashDeterministicState(state) {
  const text = JSON.stringify(deterministicStateView(state));
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
