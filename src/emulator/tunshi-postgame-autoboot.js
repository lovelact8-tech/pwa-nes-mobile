import { bootTunshiPostgameEpilogue } from './tunshi-postgame-boot.js';
import { isKnownTunshiPostgameRom } from './tunshi-postgame-rom.js';

export const TUNSHI_POSTGAME_CHECKPOINT_PATH = 'compat/tunshi-postgame-checkpoint.json';

let checkpointPromise = null;

function checkpointUrl() {
  const base = import.meta.env?.BASE_URL || '/';
  return `${base}${TUNSHI_POSTGAME_CHECKPOINT_PATH}`;
}

function assertCheckpoint(state) {
  const nextPc = (((state?.cpu?.REG_PC ?? -2) + 1) & 0xffff);
  if (!state?.cpu?.mem || !state?.ppu || !state?.mmap || nextPc !== 0xf386) {
    throw new Error('汉室新章直达检查点无效或版本不匹配');
  }
  return state;
}

export async function loadTunshiPostgameCheckpoint({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('当前环境无法读取汉室新章直达检查点');
  if (!checkpointPromise) {
    checkpointPromise = Promise.resolve(fetchImpl(checkpointUrl(), { cache: 'no-cache' }))
      .then((response) => {
        if (!response?.ok) throw new Error(`汉室新章直达检查点下载失败：${response?.status || '网络错误'}`);
        return response.json();
      })
      .then(assertCheckpoint)
      .catch((error) => {
        checkpointPromise = null;
        throw error;
      });
  }
  return checkpointPromise;
}

export async function autoBootTunshiPostgame(nes, romData, runtime, options = {}) {
  if (!runtime || !isKnownTunshiPostgameRom(romData)) return null;
  const checkpoint = await loadTunshiPostgameCheckpoint(options);
  return bootTunshiPostgameEpilogue(nes, romData, runtime, checkpoint);
}
