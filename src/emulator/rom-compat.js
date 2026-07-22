import { isKnownTunshiPostgameRom } from './tunshi-postgame-rom.js';

const TUNSHI_PRG_BANKS = 40;
const TUNSHI_CHR_BANKS = 0;
const TUNSHI_MAPPER = 4;
const TUNSHI_ROM_SIZE = 655376;
const TUNSHI_1M_ROM_SIZE = 1048592;
const TUNSHI_640K_FNV1A = 0x9a9b363e;
const TUNSHI_1M_FNV1A = 0xe57ff021;
const MAPPER198_COMPAT_MARKER_OFFSET = 8;
const MAPPER198_COMPAT_MARKER = Object.freeze([0x4d, 0x31, 0x39, 0x38]); // M198
const EXPANSION_RAM_START = 0x5000;
const EXPANSION_RAM_END = 0x5fff;
const CHR_RAM_BYTES = 0x2000;
const CHR_BANK_BYTES = 0x0400;
const CHR_BANK_COUNT = CHR_RAM_BYTES / CHR_BANK_BYTES;
const EXTENSION_REGISTER_A = 0x5ff0;
const EXTENSION_REGISTER_B = 0x5ff1;
const EXTENSION_UNLOCK_A = 0x4d;
const EXTENSION_UNLOCK_B = 0x98;

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

export function hasMapper198CompatibilityMarker(romData) {
  const prgBanks = byteAt(romData, 4) || 0;
  const expectedLength = 16 + prgBanks * 0x4000;
  return hasExpectedInesLayout(romData, {
    length: expectedLength,
    prgBanks,
  }) && MAPPER198_COMPAT_MARKER.every((value, index) => (
    byteAt(romData, MAPPER198_COMPAT_MARKER_OFFSET + index) === value
  ));
}

export function isMmc3ChrRamExpansionRom(romData) {
  return hasMapper198CompatibilityMarker(romData)
    || isKnownTunshi640kRom(romData)
    || isKnownTunshi1mRom(romData)
    || isKnownTunshiPostgameRom(romData);
}

export const mapper198CompatibilityMarker = MAPPER198_COMPAT_MARKER;

// FCEUX Mapper 198 wiring: values $50-$FF keep only the $40 and low nibble
// lines, while $00-$4F pass through unchanged.
export function normalizeTunshiMapper198PrgBank(bank) {
  const value = bank & 0xff;
  return value >= 0x50 ? value & 0x4f : value;
}

function copyBytes(source, sourceOffset, target, targetOffset, length) {
  for (let index = 0; index < length; index += 1) {
    target[targetOffset + index] = source[sourceOffset + index];
  }
}

function installMapper198ChrRam(nes, mapper, mapperState) {
  if (mapper.__tunshiMapper198ChrRam || !nes?.ppu || typeof mapper.executeCommand !== 'function') return;
  const ppu = nes.ppu;
  const serialized = mapperState?.__tunshiMapper198ChrRam;
  const chrRam = new Uint8Array(CHR_RAM_BYTES);
  const slots = Array.from({ length: CHR_BANK_COUNT }, (_, index) => index);
  const registers = [0, 2, 4, 5, 6, 7];

  if (serialized?.bytes?.length === CHR_RAM_BYTES) chrRam.set(serialized.bytes);
  else copyBytes(ppu.vramMem, 0, chrRam, 0, CHR_RAM_BYTES);
  if (serialized?.slots?.length === CHR_BANK_COUNT) {
    for (let index = 0; index < CHR_BANK_COUNT; index += 1) slots[index] = serialized.slots[index] & 7;
  }
  if (serialized?.registers?.length === 6) {
    for (let index = 0; index < 6; index += 1) registers[index] = serialized.registers[index] & 0xff;
  }

  const flushSlot = (slot) => {
    copyBytes(ppu.vramMem, slot * CHR_BANK_BYTES, chrRam, slots[slot] * CHR_BANK_BYTES, CHR_BANK_BYTES);
  };
  const rebuildSlotTiles = (slot) => {
    const base = slot * CHR_BANK_BYTES;
    for (let offset = 0; offset < CHR_BANK_BYTES; offset += 1) {
      ppu.patternWrite(base + offset, ppu.vramMem[base + offset]);
    }
  };
  const mapBank = (bank, address) => {
    const slot = (address & 0x1fff) >> 10;
    const physicalBank = bank & 7;
    if (slots[slot] === physicalBank) return;
    ppu.triggerRendering();
    flushSlot(slot);
    slots[slot] = physicalBank;
    copyBytes(chrRam, physicalBank * CHR_BANK_BYTES, ppu.vramMem, slot * CHR_BANK_BYTES, CHR_BANK_BYTES);
    rebuildSlotTiles(slot);
  };
  const applyRegister = (command, value) => {
    const inverted = mapper.chrAddressSelect !== 0;
    switch (command) {
      case 0: {
        const address = inverted ? 0x1000 : 0;
        const bank = value & 0xfe;
        mapBank(bank, address);
        mapBank(bank + 1, address + CHR_BANK_BYTES);
        break;
      }
      case 1: {
        const address = inverted ? 0x1800 : 0x0800;
        const bank = value & 0xfe;
        mapBank(bank, address);
        mapBank(bank + 1, address + CHR_BANK_BYTES);
        break;
      }
      case 2:
      case 3:
      case 4:
      case 5: {
        const address = 0x1000 + (command - 2) * CHR_BANK_BYTES;
        mapBank(value, inverted ? address - 0x1000 : address);
        break;
      }
      default:
        break;
    }
  };
  const reapplyRegisters = () => {
    for (let command = 0; command < 6; command += 1) applyRegister(command, registers[command]);
  };

  const originalExecuteCommand = mapper.executeCommand.bind(mapper);
  mapper.executeCommand = (command, value) => {
    if (command >= 0 && command <= 5) {
      registers[command] = value & 0xff;
      applyRegister(command, value);
      return;
    }
    originalExecuteCommand(command, value);
  };

  const originalWrite = mapper.write.bind(mapper);
  mapper.write = (address, value) => {
    const previousChrAddressSelect = mapper.chrAddressSelect;
    originalWrite(address, value);
    if (address >= 0x8000 && (address & 0xe001) === 0x8000
        && mapper.chrAddressSelect !== previousChrAddressSelect) reapplyRegisters();
  };

  const originalToJSON = mapper.toJSON.bind(mapper);
  mapper.toJSON = () => {
    for (let slot = 0; slot < CHR_BANK_COUNT; slot += 1) flushSlot(slot);
    const state = originalToJSON();
    state.__tunshiMapper198ChrRam = {
      bytes: Array.from(chrRam),
      slots: slots.slice(),
      registers: registers.slice(),
    };
    return state;
  };

  mapper.__tunshiMapper198ChrRam = { chrRam, slots, registers };
}

function installMapper198PrgProtocol(mapper, mapperState) {
  if (mapper.__mapper198PrgProtocol || typeof mapper.load8kRomBank !== 'function') return;
  let extensionBanks = Boolean(mapperState?.__mapper198PrgProtocol?.extensionBanks);
  let registerA = 0;
  const rawLoad8kRomBank = mapper.load8kRomBank.bind(mapper);
  mapper.load8kRomBank = (bank, address) => rawLoad8kRomBank(
    extensionBanks ? bank : normalizeTunshiMapper198PrgBank(bank),
    address,
  );

  const originalWrite = mapper.write.bind(mapper);
  mapper.write = (address, value) => {
    const normalizedAddress = address & 0xffff;
    const normalizedValue = value & 0xff;
    originalWrite(address, value);
    if (normalizedAddress === EXTENSION_REGISTER_A) registerA = normalizedValue;
    if (normalizedAddress === EXTENSION_REGISTER_B) {
      if (registerA === EXTENSION_UNLOCK_A && normalizedValue === EXTENSION_UNLOCK_B) {
        extensionBanks = true;
      } else if (registerA === 0 && normalizedValue === 0) {
        extensionBanks = false;
      }
      registerA = 0;
    }
  };

  const originalToJSON = mapper.toJSON.bind(mapper);
  mapper.toJSON = () => {
    const state = originalToJSON();
    state.__mapper198PrgProtocol = { extensionBanks };
    return state;
  };
  mapper.__mapper198PrgProtocol = {
    get extensionBanks() { return extensionBanks; },
  };
}

export function installRomCompatibility(nes, romData, { mapperState } = {}) {
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

  installMapper198ChrRam(nes, mapper, mapperState);

  if (hasMapper198CompatibilityMarker(romData)) {
    installMapper198PrgProtocol(mapper, mapperState);
  }

  if ((isKnownTunshi640kRom(romData)
      || isKnownTunshi1mRom(romData))
      && !mapper.__tunshiMapper198Prg
      && typeof mapper.load8kRomBank === 'function') {
    const originalLoad8kRomBank = mapper.load8kRomBank.bind(mapper);
    mapper.load8kRomBank = (bank, address) => originalLoad8kRomBank(
      normalizeTunshiMapper198PrgBank(bank),
      address,
    );
    mapper.__tunshiMapper198Prg = true;
  }

  if (isKnownTunshiPostgameRom(romData)
      && !hasMapper198CompatibilityMarker(romData)
      && !mapper.__tunshiPostgameBankAlias
      && typeof mapper.load8kRomBank === 'function') {
    const originalLoad8kRomBank = mapper.load8kRomBank.bind(mapper);
    mapper.__tunshiPostgameExtensionBanks = false;
    mapper.__tunshiPostgameRawLoad8kRomBank = originalLoad8kRomBank;
    mapper.load8kRomBank = (bank, address) => originalLoad8kRomBank(
      mapper.__tunshiPostgameExtensionBanks ? bank : normalizeTunshiMapper198PrgBank(bank),
      address,
    );
    mapper.__tunshiPostgameBankAlias = true;
  }
  return true;
}

export function setTunshiPostgameExtensionBanks(nes, enabled) {
  const mapper = nes?.mmap;
  if (!mapper?.__tunshiPostgameBankAlias) return false;
  const next = Boolean(enabled);
  if (mapper.__tunshiPostgameExtensionBanks === next) return true;
  mapper.__tunshiPostgameExtensionBanks = next;
  // MMC3's two fixed slots are physical last banks. They are not values sent
  // through the switchable PRG register, so Mapper 198's $50-$FF alias mask
  // must never be applied to them. Doing so maps a 1/2 MiB ROM's reset/title
  // code to $4E/$4F and causes the familiar gray screen while audio continues.
  const fixedBankAddress = mapper.prgAddressSelect ? 0x8000 : 0xc000;
  const rawLoad8kRomBank = mapper.__tunshiPostgameRawLoad8kRomBank
    || mapper.load8kRomBank.bind(mapper);
  rawLoad8kRomBank(next ? 0xfe : 0x7e, fixedBankAddress);
  rawLoad8kRomBank(next ? 0xff : 0x7f, 0xe000);
  return true;
}
