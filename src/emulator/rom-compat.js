const INES_HEADER_SIZE = 16;
const TUNSHI_PRG_BANKS = 40;
const TUNSHI_CHR_BANKS = 0;
const TUNSHI_MAPPER = 4;
const TUNSHI_ROM_SIZE = 655376;
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

export function installRomCompatibility(nes, romData) {
  if (!isKnownTunshi640kRom(romData)) return false;

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
