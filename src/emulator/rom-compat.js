import { isKnownTunshiPostgameRom } from './tunshi-postgame-rom.js';

const INES_HEADER_SIZE = 16;
const TUNSHI_PRG_BANKS = 40;
const TUNSHI_CHR_BANKS = 0;
const TUNSHI_MAPPER = 4;
const TUNSHI_ROM_SIZE = 655376;
// 40 = original 640KB translation and 64 = user's 1MB revision. The private
// 66-bank postgame build is accepted separately only after its two code
// fingerprints match; an unrelated 66-bank Mapper 4 ROM must stay untouched.
const MMC3_CHR_RAM_PRG_BANKS = new Set([40, 64]);
const TUNSHI_POSTGAME_PRG_BANKS = 66;
const EXPANSION_RAM_START = 0x5000;
const EXPANSION_RAM_END = 0x5fff;

function byteAt(romData, offset) {
  if (typeof romData === 'string') return romData.charCodeAt(offset) & 0xff;
  if (romData instanceof ArrayBuffer) return new Uint8Array(romData)[offset];
  if (ArrayBuffer.isView(romData)) {
    return new Uint8Array(romData.buffer, romData.byteOffset, romData.byteLength)[offset];
  }
  return undefined;
}

export function isKnownTunshi640kRom(romData) {
  const length = romData?.byteLength ?? romData?.length ?? 0;
  if (length !== TUNSHI_ROM_SIZE) return false;
  if (byteAt(romData, 0) !== 0x4e || byteAt(romData, 1) !== 0x45
      || byteAt(romData, 2) !== 0x53 || byteAt(romData, 3) !== 0x1a) return false;

  const prgBanks = byteAt(romData, 4);
  const chrBanks = byteAt(romData, 5);
  const mapper = (byteAt(romData, 6) >> 4) | (byteAt(romData, 7) & 0xf0);
  return length === INES_HEADER_SIZE + TUNSHI_PRG_BANKS * 16 * 1024
    && prgBanks === TUNSHI_PRG_BANKS
    && chrBanks === TUNSHI_CHR_BANKS
    && mapper === TUNSHI_MAPPER;
}

export function isMmc3ChrRamExpansionRom(romData) {
  const length = romData?.byteLength ?? romData?.length ?? 0;
  if (byteAt(romData, 0) !== 0x4e || byteAt(romData, 1) !== 0x45
      || byteAt(romData, 2) !== 0x53 || byteAt(romData, 3) !== 0x1a) return false;

  const prgBanks = byteAt(romData, 4);
  const chrBanks = byteAt(romData, 5);
  const mapper = (byteAt(romData, 6) >> 4) | (byteAt(romData, 7) & 0xf0);
  const hasTrainer = Boolean(byteAt(romData, 6) & 0x04);
  const expectedLength = INES_HEADER_SIZE
    + (hasTrainer ? 512 : 0)
    + prgBanks * 16 * 1024
    + chrBanks * 8 * 1024;

  const knownPrgLayout = MMC3_CHR_RAM_PRG_BANKS.has(prgBanks)
    || (prgBanks === TUNSHI_POSTGAME_PRG_BANKS && isKnownTunshiPostgameRom(romData));

  return mapper === TUNSHI_MAPPER
    && chrBanks === TUNSHI_CHR_BANKS
    && knownPrgLayout
    && length === expectedLength;
}

export function installRomCompatibility(nes, romData) {
  if (!isMmc3ChrRamExpansionRom(romData)) return false;

  const mapper = nes?.mmap;
  if (!mapper) return false;
  if (mapper.__tunshiMapper198Ram) return true;

  const originalLoad = mapper.load.bind(mapper);
  mapper.load = (address) => {
    const normalized = address & 0xffff;
    if (normalized >= EXPANSION_RAM_START && normalized <= EXPANSION_RAM_END) {
      return nes.cpu.mem[normalized];
    }
    return originalLoad(address);
  };
  mapper.__tunshiMapper198Ram = true;
  return true;
}
