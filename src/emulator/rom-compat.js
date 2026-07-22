import { isKnownTunshiPostgameRom } from './tunshi-postgame-rom.js';

const INES_HEADER_SIZE = 16;
const TUNSHI_PRG_BANKS = 40;
const TUNSHI_CHR_BANKS = 0;
const TUNSHI_MAPPER = 4;
const TUNSHI_ROM_SIZE = 655376;
const TUNSHI_1M_ROM_SIZE = 1048592;
// Full-file FNV-1a fingerprints are synchronous and inexpensive at ROM-load
// time. They keep the Mapper-198 expansion-RAM readback patch away from every
// unrelated Mapper 4/CHR-RAM game that merely shares the same header layout.
// SHA-256 remains the release/build authority; these values are runtime gates.
const TUNSHI_640K_FNV1A = 0x9a9b363e;
const TUNSHI_1M_FNV1A = 0xe57ff021;
const EXPANSION_RAM_START = 0x5000;
const EXPANSION_RAM_END = 0x5fff;
const POSTGAME_TEXT_BANK = 0x80;
const POSTGAME_CODE_BANK = 0x81;

function byteAt(romData, offset) {
  if (typeof romData === 'string') return romData.charCodeAt(offset) & 0xff;
  if (romData instanceof ArrayBuffer) return new Uint8Array(romData)[offset];
  if (ArrayBuffer.isView(romData)) {
    return new Uint8Array(romData.buffer, romData.byteOffset, romData.byteLength)[offset];
  }
  return undefined;
}

function fnv1a32(romData) {
  const length = romData?.byteLength ?? romData?.length ?? 0;
  let hash = 0x811c9dc5;
  for (let index = 0; index < length; index += 1) {
    hash ^= byteAt(romData, index) || 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function hasExpectedInesLayout(romData, { length, prgBanks }) {
  const actualLength = romData?.byteLength ?? romData?.length ?? 0;
  if (actualLength !== length) return false;
  if (byteAt(romData, 0) !== 0x4e || byteAt(romData, 1) !== 0x45
      || byteAt(romData, 2) !== 0x53 || byteAt(romData, 3) !== 0x1a) return false;
  const mapper = (byteAt(romData, 6) >> 4) | (byteAt(romData, 7) & 0xf0);
  return byteAt(romData, 4) === prgBanks
    && byteAt(romData, 5) === TUNSHI_CHR_BANKS
    && mapper === TUNSHI_MAPPER;
}

export function isKnownTunshi640kRom(romData) {
  return hasExpectedInesLayout(romData, {
    length: TUNSHI_ROM_SIZE,
    prgBanks: TUNSHI_PRG_BANKS,
  }) && fnv1a32(romData) === TUNSHI_640K_FNV1A;
}

export function isKnownTunshi1mRom(romData) {
  return hasExpectedInesLayout(romData, {
    length: TUNSHI_1M_ROM_SIZE,
    prgBanks: 64,
  }) && fnv1a32(romData) === TUNSHI_1M_FNV1A;
}

export function isMmc3ChrRamExpansionRom(romData) {
  return isKnownTunshi640kRom(romData)
    || isKnownTunshi1mRom(romData)
    || isKnownTunshiPostgameRom(romData);
}

export function normalizeTunshiMapper198PrgBank(bank) {
  return bank & (bank >= 0x40 ? 0x4f : 0x3f);
}

export function installRomCompatibility(nes, romData) {
  if (!isMmc3ChrRamExpansionRom(romData)) return false;

  const mapper = nes?.mmap;
  if (!mapper) return false;

  if (!mapper.__tunshiMapper198Ram) {
    const originalLoad = mapper.load.bind(mapper);
    mapper.load = (address) => {
      const normalized = address & 0xffff;
      if (normalized >= EXPANSION_RAM_START && normalized <= EXPANSION_RAM_END) {
        return nes.cpu.mem[normalized];
      }
      return originalLoad(address);
    };
    mapper.__tunshiMapper198Ram = true;
  }

  // Real Mapper 198 does not apply ordinary modulo banking to its unusual
  // 640 KiB two-chip PRG layout. Values below $40 select $00-$3F; values
  // $40-$FF retain only the lines wired by the second chip ($40-$4F).
  // Without this mask jsnes may fetch valid-but-unrelated bytes, so the game
  // can keep running while battle miniatures and scripted scenes are corrupt.
  if (isKnownTunshi640kRom(romData)
      && !mapper.__tunshiMapper198Prg
      && typeof mapper.load8kRomBank === 'function') {
    const originalLoad8kRomBank = mapper.load8kRomBank.bind(mapper);
    mapper.load8kRomBank = (bank, address) => originalLoad8kRomBank(
      normalizeTunshiMapper198PrgBank(bank),
      address,
    );
    mapper.__tunshiMapper198Prg = true;
  }

  // The 1 MiB translation treats PRG bank values $80/$81 as high-bit aliases
  // of $00/$01 while uploading battle CHR-RAM graphics. The private sequel
  // stores its epilogue text/driver in physical $80/$81, so those banks may be
  // exposed only while the epilogue is executing. Outside that short window,
  // preserve the stock alias behaviour or party/enemy miniatures read text and
  // code bytes as graphics and appear as coloured fragments.
  if (isKnownTunshiPostgameRom(romData)
      && !mapper.__tunshiPostgameBankAlias
      && typeof mapper.load8kRomBank === 'function') {
    const originalLoad8kRomBank = mapper.load8kRomBank.bind(mapper);
    mapper.__tunshiPostgameExtensionBanks = false;
    mapper.load8kRomBank = (bank, address) => {
      const physicalBank = !mapper.__tunshiPostgameExtensionBanks
        && (bank === POSTGAME_TEXT_BANK || bank === POSTGAME_CODE_BANK)
        ? bank & 0x7f
        : bank;
      return originalLoad8kRomBank(physicalBank, address);
    };
    mapper.__tunshiPostgameBankAlias = true;
  }
  return true;
}

export function setTunshiPostgameExtensionBanks(nes, enabled) {
  const mapper = nes?.mmap;
  if (!mapper?.__tunshiPostgameBankAlias) return false;
  mapper.__tunshiPostgameExtensionBanks = Boolean(enabled);
  return true;
}
