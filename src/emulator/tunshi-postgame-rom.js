const INES_HEADER_SIZE = 16;
const BANK_8K_SIZE = 0x2000;
const MAPPER_MMC3 = 4;

export const TUNSHI_POSTGAME_PRE_ENDING_ENTRY = 0xf386;
export const TUNSHI_POSTGAME_ENTRY = 0xbe00;
export const TUNSHI_POSTGAME_DRIVER_SOURCE = 0xa000;
export const TUNSHI_POSTGAME_PRE_ENDING_SIGNATURE = Object.freeze([
  0xa9, 0x2a, 0x20, 0xe3, 0xc6, 0x4c, 0x03, 0xba,
]);
export const TUNSHI_POSTGAME_ENTRY_SIGNATURE = Object.freeze([
  0xa2, 0x00, 0xbd, 0x00, 0xa0, 0x9d, 0x00,
  0x7f, 0xe8, 0xd0, 0xf7, 0x4c, 0x00, 0x7f,
]);
export const TUNSHI_POSTGAME_DRIVER_SIGNATURE = Object.freeze([
  0x20, 0x85, 0xd2, 0x00, 0x56,
]);

const POSTGAME_LAYOUTS = Object.freeze([
  // v0.2+: use a power-of-two MMC3 bank count. The game writes high bank
  // values such as $FE/$FF. Every upper bank except the extension pair mirrors
  // its original 7-bit counterpart, preserving the stock alias behaviour.
  Object.freeze({
    id: 'stable-128',
    prg16kBanks: 0x80,
    textBank: 0x80,
    codeBank: 0x81,
    fixedCBank: 0xfe,
    fixedEBank: 0xff,
    romEntry: TUNSHI_POSTGAME_ENTRY,
    romEntrySignature: TUNSHI_POSTGAME_ENTRY_SIGNATURE,
    driverSource: TUNSHI_POSTGAME_DRIVER_SOURCE,
    driverSignature: TUNSHI_POSTGAME_DRIVER_SIGNATURE,
    bootStrategy: 'ram-copy',
    ramEntry: 0x7f00,
    driverCopyBytes: 0x100,
  }),
  // Keep the first private prototype recognisable so old local saves can be
  // diagnosed and migrated, but new builds must use stable-128.
  Object.freeze({
    id: 'legacy-66',
    prg16kBanks: 0x42,
    textBank: 0x80,
    codeBank: 0x81,
    fixedCBank: 0x82,
    fixedEBank: 0x83,
    romEntry: TUNSHI_POSTGAME_ENTRY,
    romEntrySignature: TUNSHI_POSTGAME_DRIVER_SIGNATURE,
    driverSource: TUNSHI_POSTGAME_ENTRY,
    driverSignature: TUNSHI_POSTGAME_DRIVER_SIGNATURE,
    bootStrategy: 'fixed-switch',
  }),
]);

function byteAt(romData, offset) {
  if (typeof romData === 'string') return romData.charCodeAt(offset) & 0xff;
  if (romData instanceof ArrayBuffer) return new Uint8Array(romData)[offset];
  if (ArrayBuffer.isView(romData)) {
    return new Uint8Array(romData.buffer, romData.byteOffset, romData.byteLength)[offset];
  }
  return undefined;
}

function bytesAt(romData, offset, expected) {
  return expected.every((value, index) => byteAt(romData, offset + index) === value);
}

function bankFileOffset(bank8k, cpuAddress) {
  return INES_HEADER_SIZE + bank8k * BANK_8K_SIZE + (cpuAddress & 0x1fff);
}

function mapperFromHeader(romData) {
  return ((byteAt(romData, 6) || 0) >> 4) | ((byteAt(romData, 7) || 0) & 0xf0);
}

export function getTunshiPostgameRomLayout(romData) {
  const length = romData?.byteLength ?? romData?.length ?? 0;
  if (!bytesAt(romData, 0, [0x4e, 0x45, 0x53, 0x1a])) return null;
  if (byteAt(romData, 5) !== 0 || mapperFromHeader(romData) !== MAPPER_MMC3) return null;

  const layout = POSTGAME_LAYOUTS.find((candidate) => (
    byteAt(romData, 4) === candidate.prg16kBanks
    && length === INES_HEADER_SIZE + candidate.prg16kBanks * 0x4000
  ));
  if (!layout) return null;

  return bytesAt(
    romData,
    bankFileOffset(layout.fixedEBank, TUNSHI_POSTGAME_PRE_ENDING_ENTRY),
    TUNSHI_POSTGAME_PRE_ENDING_SIGNATURE,
  ) && bytesAt(
    romData,
    bankFileOffset(layout.codeBank, layout.romEntry),
    layout.romEntrySignature,
  ) && bytesAt(
    romData,
    bankFileOffset(layout.codeBank, layout.driverSource),
    layout.driverSignature,
  ) ? layout : null;
}

/**
 * Recognises only the private postgame builds. Header checks alone are
 * intentionally insufficient: two code fingerprints keep unrelated MMC3
 * hacks isolated from mapper compatibility and runtime behaviour.
 */
export function isKnownTunshiPostgameRom(romData) {
  return getTunshiPostgameRomLayout(romData)?.id === 'stable-128';
}

export function isLegacyTunshiPostgameRom(romData) {
  return getTunshiPostgameRomLayout(romData)?.id === 'legacy-66';
}

export const tunshiPostgameRomLayouts = POSTGAME_LAYOUTS;
