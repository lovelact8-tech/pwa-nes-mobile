const INES_HEADER_SIZE = 16;
const BANK_8K_SIZE = 0x2000;
const POSTGAME_PRG_16K_BANKS = 0x42;
const POSTGAME_ROM_SIZE = INES_HEADER_SIZE + POSTGAME_PRG_16K_BANKS * 0x4000;
const MAPPER_MMC3 = 4;

export const TUNSHI_POSTGAME_PRE_ENDING_ENTRY = 0xf386;
export const TUNSHI_POSTGAME_ENTRY = 0xbe00;
export const TUNSHI_POSTGAME_PRE_ENDING_SIGNATURE = Object.freeze([
  0xa9, 0x2a, 0x20, 0xe3, 0xc6, 0x4c, 0x03, 0xba,
]);
export const TUNSHI_POSTGAME_ENTRY_SIGNATURE = Object.freeze([
  0x20, 0x85, 0xd2, 0x00, 0x56,
]);

const NEW_CODE_BANK = 0x81;
const NEW_FIXED_BANK = 0x83;

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

/**
 * Recognises only the private 66-bank postgame build. Header checks alone are
 * intentionally insufficient: two code fingerprints keep unrelated MMC3
 * hacks isolated from both mapper compatibility and runtime behaviour.
 */
export function isKnownTunshiPostgameRom(romData) {
  const length = romData?.byteLength ?? romData?.length ?? 0;
  if (length !== POSTGAME_ROM_SIZE) return false;
  if (!bytesAt(romData, 0, [0x4e, 0x45, 0x53, 0x1a])) return false;
  if (byteAt(romData, 4) !== POSTGAME_PRG_16K_BANKS
    || byteAt(romData, 5) !== 0
    || mapperFromHeader(romData) !== MAPPER_MMC3) return false;

  return bytesAt(
    romData,
    bankFileOffset(NEW_FIXED_BANK, TUNSHI_POSTGAME_PRE_ENDING_ENTRY),
    TUNSHI_POSTGAME_PRE_ENDING_SIGNATURE,
  ) && bytesAt(
    romData,
    bankFileOffset(NEW_CODE_BANK, TUNSHI_POSTGAME_ENTRY),
    TUNSHI_POSTGAME_ENTRY_SIGNATURE,
  );
}
