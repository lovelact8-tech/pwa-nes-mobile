const ROSTER = Object.freeze([
  [0x01, '刘备', '主公'], [0x02, '关羽', '重型输出'], [0x03, '张飞', '前排猛将'],
  [0x04, '关兴', '均衡剑将'], [0x05, '关索', '高速刀将'], [0x06, '张苞', '高速枪将'],
  [0x07, '陈登', '军师'], [0x08, '诸葛亮', '核心军师'], [0x09, '关平', '均衡刀将'],
  [0x0b, '赵云', '高速枪将'], [0x0c, '周仓', '山地斧将'],
  [0x0d, '伊籍', '谋士'], [0x0f, '庞统', '高智军师'], [0x10, '马良', '高智谋士'],
  [0x11, '马谡', '军师'], [0x12, '姜维', '文武双全'], [0x45, '魏延', '山地斧将'],
  [0x46, '黄忠', '远程弓将'], [0x4b, '孟达', '高速剑将'],
  [0x4f, '吴懿', '枪将'], [0x52, '吴兰', '枪将'], [0x53, '雷铜', '枪将'],
  [0x56, '严颜', '老将'], [0x57, '法正', '军师'], [0x66, '蒋琬', '军师'],
  [0x7b, '马超', '高速枪将'], [0x7c, '马岱', '枪将'], [0xe6, '廖化', '山地斧将'],
].map(([id, name, role]) => Object.freeze({ id, name, role })));

const FORMATION_ADDRESS = 0x6078;
const PARTICIPATION_ADDRESS = 0x6615;
const OFFICER_SLOT_BASE = 0x6621;
const TROOPS_SLOT_BASE = 0x662d;
const SLOT_COUNT = 7;
const MAX_ACTIVE = 5;
const EMPTY_SLOT = 0xff;
const ACTIVE_FLAG = 0x80;
const MIN_STARTING_TROOPS = 500;

function isSupported(nes) {
  return Boolean(nes?.mmap?.__tunshiPostgameBankAlias && nes.cpu?.mem);
}

function readTroops(memory, slot) {
  const address = TROOPS_SLOT_BASE + slot * 3;
  return memory[address] | (memory[address + 1] << 8) | (memory[address + 2] << 16);
}

function writeTroops(memory, slot, value) {
  const address = TROOPS_SLOT_BASE + slot * 3;
  const safe = Math.max(1, Math.min(0xffffff, Math.trunc(value)));
  memory[address] = safe & 0xff;
  memory[address + 1] = (safe >>> 8) & 0xff;
  memory[address + 2] = (safe >>> 16) & 0xff;
}

function uniqueKnownIds(ids) {
  const known = new Set(ROSTER.map(({ id }) => id));
  return Array.from(new Set(ids.map(Number))).filter((id) => known.has(id)).slice(0, MAX_ACTIVE);
}

export function supportsTunshiPostgameFormation(nes) {
  return isSupported(nes);
}

export function readTunshiPostgameFormation(nes) {
  if (!isSupported(nes)) return [];
  const memory = nes.cpu.mem;
  const members = [];
  for (let index = 0; index < SLOT_COUNT; index += 1) {
    const slot = memory[FORMATION_ADDRESS + index];
    if (slot === EMPTY_SLOT) break;
    if (slot >= SLOT_COUNT || memory[PARTICIPATION_ADDRESS + slot] !== ACTIVE_FLAG) continue;
    const id = memory[OFFICER_SLOT_BASE + slot];
    const officer = ROSTER.find((candidate) => candidate.id === id);
    if (officer && !members.some((member) => member.id === id)) members.push(officer);
  }
  return members.slice(0, MAX_ACTIVE);
}

/**
 * Applies an active party once. The original game continues to own battles,
 * graphics and saves; unlike the old compatibility shim this never overwrites
 * the party on every frame.
 */
export function setTunshiPostgameFormation(nes, ids) {
  if (!isSupported(nes)) return false;
  const selected = uniqueKnownIds(Array.isArray(ids) ? ids : []);
  if (selected.length < 1) throw new Error('队伍至少需要 1 名武将');

  const memory = nes.cpu.mem;
  const previousTroops = new Map();
  for (let slot = 0; slot < SLOT_COUNT; slot += 1) {
    const id = memory[OFFICER_SLOT_BASE + slot];
    const troops = readTroops(memory, slot);
    if (id && troops > 0) previousTroops.set(id, troops);
  }
  const fallbackTroops = Math.max(MIN_STARTING_TROOPS, ...previousTroops.values());

  for (let index = 0; index < SLOT_COUNT; index += 1) {
    memory[FORMATION_ADDRESS + index] = index < selected.length ? SLOT_COUNT - 1 - index : EMPTY_SLOT;
    memory[PARTICIPATION_ADDRESS + index] = 0;
  }

  selected.forEach((id, index) => {
    const slot = SLOT_COUNT - 1 - index;
    memory[OFFICER_SLOT_BASE + slot] = id;
    memory[PARTICIPATION_ADDRESS + slot] = ACTIVE_FLAG;
    writeTroops(memory, slot, previousTroops.get(id) || fallbackTroops);
  });
  return true;
}

export const tunshiPostgameRoster = ROSTER;
export const tunshiPostgameFormationLimits = Object.freeze({ min: 1, max: MAX_ACTIVE });
export const tunshiPostgameFormationAddresses = Object.freeze({
  formation: FORMATION_ADDRESS,
  participation: PARTICIPATION_ADDRESS,
  officerSlotBase: OFFICER_SLOT_BASE,
  troopsSlotBase: TROOPS_SLOT_BASE,
});
