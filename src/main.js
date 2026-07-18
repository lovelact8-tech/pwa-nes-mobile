import './style.css';
import { NES, Controller } from 'jsnes';
import Peer from 'peerjs';
import { gzipSync, gunzipSync, strFromU8, strToU8, unzipSync } from 'fflate';
import { ui } from './ui/dom.js';
import { hydrateIcons } from './ui/icons.js';
import { setButtonIcon, setButtonLabel } from './ui/buttons.js';
import { createDialogController } from './ui/dialogs.js';
import { createFullscreenController } from './ui/fullscreen.js';
import { createControlLayoutController } from './input/control-layout.js';
import { createInputController } from './input/controller.js';
import { registerServiceWorker } from './pwa/register.js';
import {
  captureDeterministicState,
  restoreDeterministicState,
  hashDeterministicState,
  hashDeterministicComponents,
} from './netplay/state.js';
import { inputPayload, messageButtons } from './netplay/input.js';
import { getGuestInputLateness, getGuestInputPlan } from './netplay/latency-policy.js';
import { SCREEN_WIDTH, SCREEN_HEIGHT, FRAMEBUFFER_SIZE, FRAME_MS, MAX_FRAME_DELTA_MS } from './emulator/constants.js';
import { installRomCompatibility } from './emulator/rom-compat.js';
import { createAudioController } from './emulator/audio.js';
import { getRuntimeRelayUrl } from './netplay/relay-url.js';
import { createAuthoritativeStreamSession } from './netplay/authoritative-stream.js';
import {
  MAX_PEER_QUEUE_SIZE, NET_INPUT_DELAY_FRAMES, GUEST_INPUT_MIN_LEAD_FRAMES,
  GUEST_INPUT_MAX_LEAD_FRAMES, GUEST_INPUT_MAX_SAFETY_FRAMES, GUEST_INPUT_SAFETY_DECAY_MS,
  NET_CLOCK_INTERVAL_MS, NETWORK_PING_IDLE_MS, NETWORK_PING_BOOTSTRAP_MS, NETWORK_PING_TIMEOUT_MS,
  NETWORK_BOOTSTRAP_PING_TIMEOUT_MS,
  NETWORK_SYNC_TIMEOUT_MS, DEFAULT_NETWORK_RTT_MS,
  RELAY_MIN_JITTER_BUFFER_MS, RELAY_MAX_JITTER_BUFFER_MS, RELAY_MIN_GUEST_BUFFER_FRAMES,
  RELAY_MAX_GUEST_BUFFER_FRAMES, HOST_CLOCK_STALE_MS, GUEST_FAST_CATCHUP_THRESHOLD_FRAMES,
  GUEST_FAST_CATCHUP_MAX_FRAMES, LATE_INPUT_RESYNC_COOLDOWN_MS, ROLLBACK_SNAPSHOT_INTERVAL_FRAMES,
  ROLLBACK_WINDOW_FRAMES, ROLLBACK_MAX_SNAPSHOTS, NETWORK_STATE_CHECK_INTERVAL_FRAMES,
} from './netplay/constants.js';
import {
  NETWORK_STORAGE_KEY, NET_MODE_STORAGE_KEY, CLOUD_ACCESS_KEY_STORAGE_KEY,
  CLOUD_AUTO_BACKUP_STORAGE_KEY, CLOUD_DEVICE_ID_STORAGE_KEY, SAVE_STATE_STORAGE_KEY,
} from './storage/keys.js';

hydrateIcons();
const {
  landing, game, canvas, remoteStreamVideo, remoteStreamAudio, romInput, romInput2, demoBtn,
  libraryBtn, menuLibraryBtn, libraryDialog, librarySearchInput, libraryStatusText, libraryResults,
  closeLibraryBtn, statusText, inviteStatusText, joinRoomForm, joinRoomInput, pauseBtn, soundBtn,
  settingsBtn, menuBtn, menuDialog, settingsDialog, closeMenuBtn, resumeBtn, resetBtn, saveStateBtn,
  loadStateBtn, netHostBtn, relayHostBtn, relayAccessRow, relayAccessKey, netCopyBtn, netLeaveBtn,
  netLinkInput, netStatusText, netLogBtn, netLogOutput, cloudAccessKey, cloudRememberKey,
  cloudAutoBackup, cloudSaveBtn, cloudManageBtn, cloudFavoriteBtn, cloudStatusText, cloudDialog,
  cloudDialogStatus, cloudSaveList, closeCloudBtn, layoutEditBtn, resetLayoutBtn, closeSettingsBtn,
  settingsModeText, layoutPresetButtons, controlOpacityInput, controlOpacityValue, dpad, actionZone,
  fullscreenBtn, netPerformanceHud, netModeSelect,
} = ui;
const ctx = canvas.getContext('2d');
const imageData = ctx.getImageData(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT);
const frameBuffer32 = new Uint32Array(imageData.data.buffer);
const dialogController = createDialogController({
  settingsDialog,
  dismissibleDialogs: [menuDialog, libraryDialog, cloudDialog],
});

const isStandalone = window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
if (!isStandalone) document.body.classList.add('browser-mode');

let nes = null;
let lastRomData = null;
let lastRomName = '';
let lastRomLibraryPath = '';
let lastGameId = '';
let currentCloudFavorite = false;
let cloudPlayTimer = 0;
let running = false;
let paused = false;
let rafId = 0;
let lastTick = 0;
let frameRemainder = 0;
const buttonStateByPlayer = { 1: new Set(), 2: new Set() };
let controllerInput = null;
let localPlayer = 1;
let remotePlayer = 2;
let networkRole = 'offline';
let networkTransport = 'peer';
let networkPlayMode = 'rollback';
let roomId = '';
let peer = null;
let peerConnection = null;
let peerReady = false;
let peerConnected = false;
let relaySocket = null;
let relayReady = false;
let relayPendingRomName = '';
let relayPendingRomEncoding = '';
let relayPendingState = null;
let relayGuestTicket = '';
let relaySessionTicket = '';
let relayReconnectTimer = 0;
let relayReconnectAttempts = 0;
let relayTurnConfig = null;
let relayDataQueue = Promise.resolve();
let hybridRoom = false;
let hybridFallbackTimer = 0;
let hybridFallbackStarted = false;
let peerPendingMessages = [];
let peerRomSent = false;
let pendingPeerRomData = null;
let suppressNetworkBroadcast = false;
let gameLibrary = null;
let gameFrame = 0;
let scheduledNetworkInputs = [];
let networkInputHistory = [];
let rollbackSnapshots = [];
let localInputSequence = 0;
let authoritativeInputOrder = 0;
let networkEventOrder = 0;
let rollbackInProgress = false;
let rollbackCount = 0;
let rollbackFrames = 0;
let pendingStateChecks = new Map();
let lastStateCheckFrame = -1;
let pendingRollbackFrame = null;
let pendingRollbackReason = '';
let lastQueuedLocalButtons = new Set();
let lastNetworkClockAt = 0;
let hostClockFrame = null;
let hostClockReceivedAt = 0;
let networkTransportStalled = false;
let guestInputSafetyFrames = 0;
let guestLastLateInputAt = 0;
let lastInputAckSampleAt = 0;
let lastStateRequestAt = 0;
let networkSyncPaused = false;
let networkSyncId = '';
let networkSyncTimeout = 0;
let networkSyncProbeId = '';
let networkSyncProbeSentAt = 0;
let networkSyncProbeTimeout = 0;
let stateRequestInFlight = false;
let suppressEmulatorOutput = false;
let networkRttMs = 0;
let networkRttJitterMs = 0;
let networkPingId = '';
let networkPingSentAt = 0;
let lastNetworkPingAt = 0;
let networkPingTimeoutCount = 0;
let lastGuestCatchUpLogAt = 0;
let lastLateInputResyncAt = 0;
let performanceHudLastAt = 0;
let performanceHudFrames = 0;
let performanceHudFps = 0;
let stateCheckStatus = '等待';
let stateCheckFrame = 0;
let stateMismatchCount = 0;
const networkLogEntries = [];
const networkLogStartedAt = performance.now();
const RELAY_SERVER_URL = getRuntimeRelayUrl();
const audio = createAudioController({
  onStatus: setStatus,
  onChange: updateSoundButton,
  getSourceSampleRate: () => nes?.papu?.sampleRate,
});
const initAudio = () => audio.init();
const clearAudioBuffer = () => audio.clear();
const pushAudioSample = (left, right) => audio.pushSample(left, right);
const streamSession = createAuthoritativeStreamSession({
  canvas,
  remoteVideo: remoteStreamVideo,
  remoteAudio: remoteStreamAudio,
  audio,
  getTurnConfig: () => relayTurnConfig,
  getRole: () => networkRole,
  isEnabled: isAuthoritativeStreamMode,
  isPeerConnected: () => peerConnected,
  getLocalButtons: getLocalMergedButtons,
  getRunning: () => running,
  hasNes: () => Boolean(nes),
  setRunning: (value) => { running = value; },
  stopLoop,
  startLoop,
  showGame,
  setPlayerButtons,
  sendMessage: sendPeerMessage,
  setStatus: setNetworkText,
  log: logNetworkEvent,
  updateHud: updatePerformanceHud,
  updateSound: updateSoundButton,
});


function setStatus(text) {
  statusText.textContent = text;
}

const controlLayout = createControlLayoutController({
  dpad,
  game,
  layoutEditBtn,
  layoutPresetButtons,
  controlOpacityInput,
  controlOpacityValue,
  settingsModeText,
  releaseAllButtons: (...args) => releaseAllButtons(...args),
});
const applyControlOffsets = controlLayout.apply;
const applyControlOpacity = controlLayout.applyOpacity;
const applyLayoutScalePreset = controlLayout.applyScalePreset;
const positionScaleTools = controlLayout.positionTools;
const resetControlLayout = controlLayout.reset;
const setLayoutEditMode = controlLayout.setEditMode;


function getSaveStateKey() {
  return `${SAVE_STATE_STORAGE_KEY}:${lastRomName || 'default'}`;
}

function getCloudApiUrl(pathname) {
  const url = normalizeRelayUrl(RELAY_SERVER_URL);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = pathname;
  url.search = '';
  return url;
}

function getCloudAccessKey() {
  return String(cloudAccessKey?.value || '').trim();
}

function getCloudDeviceId() {
  try {
    let deviceId = localStorage.getItem(CLOUD_DEVICE_ID_STORAGE_KEY) || '';
    if (!deviceId) {
      deviceId = typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      localStorage.setItem(CLOUD_DEVICE_ID_STORAGE_KEY, deviceId);
    }
    return deviceId;
  } catch (error) {
    return 'private-device';
  }
}

async function getCurrentGameId() {
  if (lastGameId) return lastGameId;
  if (!lastRomData) throw new Error('请先加载游戏');
  const digest = await crypto.subtle.digest('SHA-256', binaryStringToArrayBuffer(lastRomData));
  lastGameId = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return lastGameId;
}

async function cloudFetch(pathname, options = {}) {
  if (!RELAY_SERVER_URL) throw new Error('私人云服务器尚未配置');
  const accessKey = getCloudAccessKey();
  if (!accessKey) throw new Error('请先输入私人云访问码');
  const response = await fetch(getCloudApiUrl(pathname), {
    ...options,
    headers: {
      authorization: `Bearer ${accessKey}`,
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `私人云请求失败：${response.status}`);
  return result;
}

function updateCloudFavoriteButton() {
  setButtonLabel(cloudFavoriteBtn, currentCloudFavorite ? '已收藏当前游戏' : '收藏当前游戏');
  cloudFavoriteBtn.classList.toggle('active', currentCloudFavorite);
}

async function updateCloudLibraryActivity(value = {}) {
  if (!lastRomData || !getCloudAccessKey()) return null;
  const gameId = await getCurrentGameId();
  const result = await cloudFetch(`/api/library/${gameId}`, {
    method: 'PUT',
    body: JSON.stringify({ romName: lastRomName || 'NES 游戏', ...value }),
  });
  currentCloudFavorite = Boolean(result.favorite);
  updateCloudFavoriteButton();
  return result;
}

async function uploadCloudSave({ label = '手动存档', quiet = false } = {}) {
  if (!nes) throw new Error('请先加载游戏');
  if (!quiet) cloudStatusText.textContent = '正在上传云存档...';
  const gameId = await getCurrentGameId();
  const data = encodeNetworkState(nes.toJSON());
  const result = await cloudFetch('/api/saves', {
    method: 'POST',
    body: JSON.stringify({
      gameId,
      romName: lastRomName || 'NES 游戏',
      label,
      data,
      gameFrame,
      deviceId: getCloudDeviceId(),
    }),
  });
  cloudStatusText.textContent = `云存档已上传：${new Date(result.createdAt).toLocaleString('zh-CN')}`;
  return result;
}

async function loadCloudSave(id) {
  cloudDialogStatus.textContent = '正在下载并恢复云存档...';
  const save = await cloudFetch(`/api/saves/${id}`);
  releaseAllButtons();
  nes.fromJSON(decodeNetworkState(save.data));
  gameFrame = Math.max(0, Number(save.gameFrame) || 0);
  resetRollbackState({ capture: networkRole !== 'offline' && peerConnected });
  showGame();
  running = true;
  paused = false;
  setButtonIcon(pauseBtn, 'pause', '暂停');
  startLoop();
  cloudDialog.close();
  menuDialog.close();
  setStatus(`已恢复云存档：${save.label}`);
  cloudStatusText.textContent = `已恢复：${new Date(save.createdAt).toLocaleString('zh-CN')}`;
  if (networkRole === 'host' && peerConnected) sendPeerSnapshot();
}

function renderCloudSaves(saves) {
  cloudSaveList.replaceChildren();
  if (!saves.length) {
    cloudDialogStatus.textContent = '当前游戏还没有云存档';
    return;
  }
  cloudDialogStatus.textContent = `共 ${saves.length} 个版本，最多保留 20 个`;
  for (const save of saves) {
    const card = document.createElement('article');
    card.className = 'cloudSaveCard';
    const title = document.createElement('strong');
    title.textContent = save.label || '云存档';
    const meta = document.createElement('div');
    meta.className = 'cloudSaveMeta';
    meta.textContent = `${new Date(save.createdAt).toLocaleString('zh-CN')} · 帧 ${save.gameFrame || 0} · ${Math.max(1, Math.round((save.encodedBytes || 0) / 1024))}KB`;
    const actions = document.createElement('div');
    actions.className = 'cloudSaveActions';
    const restoreButton = document.createElement('button');
    restoreButton.textContent = '恢复此版本';
    restoreButton.addEventListener('click', () => loadCloudSave(save.id).catch((error) => {
      cloudDialogStatus.textContent = error.message || '恢复失败';
    }));
    const deleteButton = document.createElement('button');
    deleteButton.className = 'deleteCloudSave';
    deleteButton.textContent = '删除';
    deleteButton.addEventListener('click', async () => {
      if (!confirm(`确定删除“${save.label || '云存档'}”吗？`)) return;
      try {
        await cloudFetch(`/api/saves/${save.id}`, { method: 'DELETE' });
        card.remove();
        if (!cloudSaveList.children.length) cloudDialogStatus.textContent = '当前游戏还没有云存档';
      } catch (error) {
        cloudDialogStatus.textContent = error.message || '删除失败';
      }
    });
    actions.append(restoreButton, deleteButton);
    card.append(title, meta, actions);
    cloudSaveList.append(card);
  }
}

async function openCloudManager() {
  if (!nes) throw new Error('请先加载游戏');
  menuDialog.close();
  cloudDialog.showModal();
  cloudDialogStatus.textContent = '正在读取云存档...';
  cloudSaveList.replaceChildren();
  const gameId = await getCurrentGameId();
  const result = await cloudFetch(`/api/saves?gameId=${encodeURIComponent(gameId)}`);
  renderCloudSaves(result.saves || []);
}

function saveGameState() {
  if (!nes) {
    alert('请先加载游戏');
    return;
  }
  try {
    localStorage.setItem(getSaveStateKey(), JSON.stringify(nes.toJSON()));
    setStatus('游戏已保存');
    menuDialog.close();
    if (cloudAutoBackup?.checked && getCloudAccessKey()) {
      uploadCloudSave({ label: '自动备份', quiet: true }).catch((error) => {
        cloudStatusText.textContent = `本地已保存，云备份失败：${error.message || '请重试'}`;
      });
    }
  } catch (error) {
    console.error(error);
    alert('保存失败，可能是浏览器存储空间不足。');
  }
}

function loadGameState() {
  if (!nes) {
    alert('请先加载对应游戏');
    return;
  }
  try {
    const raw = localStorage.getItem(getSaveStateKey());
    if (!raw) {
      alert('没有找到当前游戏的存档');
      return;
    }
    releaseAllButtons();
    nes.fromJSON(JSON.parse(raw));
    showGame();
    running = true;
    paused = false;
    setButtonIcon(pauseBtn, 'pause', '暂停');
    setStatus('游戏已加载');
    menuDialog.close();
    if (networkRole === 'host' && peerConnected) sendPeerSnapshot();
    startLoop();
  } catch (error) {
    console.error(error);
    alert('加载失败，存档可能已损坏。');
  }
}

function getSafeNetworkDetail(detail = {}) {
  const safe = {};
  for (const [key, value] of Object.entries(detail)) {
    if (/ticket|access|token|secret/i.test(key)) {
      safe[key] = value ? '[present]' : '[missing]';
      continue;
    }
    safe[key] = value;
  }
  return safe;
}

function logNetworkEvent(event, detail = {}) {
  const elapsed = ((performance.now() - networkLogStartedAt) / 1000).toFixed(3);
  const safeDetail = getSafeNetworkDetail(detail);
  const suffix = Object.keys(safeDetail).length ? ` ${JSON.stringify(safeDetail)}` : '';
  const line = `[+${elapsed}s] ${event}${suffix}`;
  networkLogEntries.push(line);
  if (networkLogEntries.length > 240) networkLogEntries.shift();
  if (netLogOutput) netLogOutput.textContent = networkLogEntries.join('\n');
  console.info(`[NES NET] ${event}`, safeDetail);
}

function getNetworkDiagnosticLog() {
  const roomHint = roomId ? `${roomId.slice(0, 4)}…${roomId.slice(-4)}` : 'none';
  const streamStatus = streamSession.getStatus();
  return [
    'PWA NES 联机诊断日志',
    `time=${new Date().toISOString()}`,
    `page=${location.origin}${location.pathname}`,
    `online=${navigator.onLine}`,
    `role=${networkRole}`,
    `transport=${networkTransport}`,
    `playMode=${networkPlayMode}`,
    `hybrid=${hybridRoom}`,
    `room=${roomHint}`,
    `peerReady=${peerReady}`,
    `peerConnected=${peerConnected}`,
    `relayReady=${relayReady}`,
    `relaySocket=${relaySocket?.readyState ?? 'none'}`,
    `streamPeer=${streamStatus.peer}`,
    `streamIce=${streamStatus.ice}`,
    `streamInput=${streamStatus.input}`,
    `streamVideo=${remoteStreamVideo?.readyState ?? 'none'}`,
    `streamStats=${streamStatus.stats ? JSON.stringify(streamStatus.stats) : 'none'}`,
    `syncPaused=${networkSyncPaused}`,
    `syncPending=${stateRequestInFlight || Boolean(networkSyncId)}`,
    `rttMs=${Math.round(networkRttMs)}`,
    `rttJitterMs=${Math.round(networkRttJitterMs)}`,
    `guestBufferFrames=${getRelayGuestBufferFrames()}`,
    `rollbackCount=${rollbackCount}`,
    `rollbackFrames=${rollbackFrames}`,
    `rollbackSnapshots=${rollbackSnapshots.length}`,
    `stateCheck=${stateCheckStatus}`,
    `stateCheckFrame=${stateCheckFrame}`,
    `stateMismatchCount=${stateMismatchCount}`,
    `gameFrame=${gameFrame}`,
    `hostFrame=${hostClockFrame ?? 'none'}`,
    `hostClockAgeMs=${hostClockReceivedAt ? Math.round(performance.now() - hostClockReceivedAt) : 'none'}`,
    `transportStalled=${networkTransportStalled}`,
    `inputSafetyFrames=${guestInputSafetyFrames}`,
    `userAgent=${navigator.userAgent}`,
    '',
    ...networkLogEntries,
  ].join('\n');
}

function setNetworkText(text) {
  logNetworkEvent('status', { text });
  if (netStatusText) netStatusText.textContent = text;
  if (inviteStatusText && (networkRole === 'guest' || new URLSearchParams(window.location.search).has('room'))) {
    inviteStatusText.textContent = text;
    inviteStatusText.classList.remove('hidden');
  }
}

function getPreferredNetworkPlayMode() {
  const queryMode = new URLSearchParams(window.location.search).get('netmode');
  if (queryMode === 'stream' || queryMode === 'rollback') return queryMode;
  const selected = netModeSelect?.value;
  if (selected === 'stream' || selected === 'rollback') return selected;
  try {
    return localStorage.getItem(NET_MODE_STORAGE_KEY) === 'stream' ? 'stream' : 'rollback';
  } catch (error) {
    return 'rollback';
  }
}

function updatePerformanceHud(timestamp = performance.now()) {
  if (!netPerformanceHud) return;
  const active = networkRole !== 'offline' && peerConnected;
  netPerformanceHud.classList.toggle('hidden', !active);
  if (!active) return;
  if (!performanceHudLastAt) performanceHudLastAt = timestamp;
  const elapsed = timestamp - performanceHudLastAt;
  if (elapsed >= 500) {
    performanceHudFps = Math.round(performanceHudFrames * 1000 / elapsed);
    performanceHudFrames = 0;
    performanceHudLastAt = timestamp;
  }
  const streamMode = isAuthoritativeStreamMode();
  const streamStatus = streamSession.getStatus();
  const fps = streamMode ? Number(streamStatus.stats?.fps) || 0 : performanceHudFps;
  const rtt = streamMode ? Number(streamStatus.stats?.rttMs) || 0 : Math.round(networkRttMs);
  const buffer = streamMode ? Number(streamStatus.stats?.playoutMs) || 0 : getRelayGuestBufferFrames();
  const bufferLabel = streamMode ? `${buffer}ms` : `${buffer}f`;
  const sync = streamMode ? streamStatus.peer || '连接中' : `${stateCheckStatus}@${stateCheckFrame || '-'}`;
  netPerformanceHud.textContent = `${streamMode ? '串流' : '回滚'}  FPS ${fps || '--'}  RTT ${rtt || '--'}ms  缓冲 ${bufferLabel}  回滚 ${rollbackCount}/${rollbackFrames}f  同步 ${sync}`;
  const unhealthy = (fps > 0 && fps < 48) || rtt > 350 || stateCheckStatus === '差异';
  const warning = !unhealthy && ((fps > 0 && fps < 56) || rtt > 180 || (!streamMode && getRelayGuestBufferFrames() > 8));
  netPerformanceHud.classList.toggle('bad', unhealthy);
  netPerformanceHud.classList.toggle('warn', warning);
  netPerformanceHud.classList.toggle('good', !unhealthy && !warning);
}

function isAuthoritativeStreamMode() {
  return networkPlayMode === 'stream' && networkTransport === 'relay';
}

const sendStreamInput = (...args) => streamSession.sendInput(...args);
const applyStreamRemoteInput = (...args) => streamSession.applyRemoteInput(...args);
const startHostAuthoritativeStream = (...args) => streamSession.startHost(...args);
const acceptHostStreamOffer = (...args) => streamSession.acceptOffer(...args);
const acceptGuestStreamAnswer = (...args) => streamSession.acceptAnswer(...args);
const addStreamIceCandidate = (...args) => streamSession.addIce(...args);
const teardownStreamSession = (...args) => streamSession.teardown(...args);
const unlockRemoteStreamAudio = (...args) => streamSession.unlockAudio(...args);

function getInviteUrl() {
  if (!roomId) return '';
  const url = new URL(window.location.href);
  url.searchParams.set('room', roomId);
  url.searchParams.delete('host');
  if (hybridRoom) {
    url.searchParams.set('transport', 'hybrid');
    if (relayGuestTicket) url.searchParams.set('ticket', relayGuestTicket);
  } else if (networkTransport === 'relay') {
    url.searchParams.set('transport', 'relay');
    url.searchParams.set('netmode', networkPlayMode);
    if (relayGuestTicket) url.searchParams.set('ticket', relayGuestTicket);
  } else {
    url.searchParams.delete('transport');
    url.searchParams.delete('ticket');
    url.searchParams.delete('netmode');
  }
  return url.toString();
}

function refreshInviteLink() {
  if (netLinkInput) netLinkInput.value = getInviteUrl();
}

function getLocalMergedButtons() {
  return controllerInput?.getButtons() || new Set();
}

function syncButtonVisuals() {
  controllerInput?.syncVisuals();
}

function setPlayerButtons(player, nextButtons, { broadcast = false } = {}) {
  const current = buttonStateByPlayer[player];
  const next = nextButtons instanceof Set ? nextButtons : new Set(nextButtons || []);
  let changed = false;

  for (const name of Array.from(current)) {
    if (next.has(name)) continue;
    current.delete(name);
    const code = buttonMap[name];
    if (code !== undefined && nes) nes.buttonUp(player, code);
    changed = true;
  }

  for (const name of next) {
    if (current.has(name)) continue;
    current.add(name);
    const code = buttonMap[name];
    if (code !== undefined && nes) nes.buttonDown(player, code);
    changed = true;
  }

  if (changed) syncButtonVisuals();
  if (broadcast) sendPeerButtons(player, next);
}

function applyButtonState(player, name, pressed, { broadcast = false } = {}) {
  const next = new Set(buttonStateByPlayer[player]);
  if (pressed) next.add(name);
  else next.delete(name);
  setPlayerButtons(player, next, { broadcast });
}

function updateLocalPlayerState({ broadcast = true } = {}) {
  setPlayerButtons(localPlayer, getLocalMergedButtons(), { broadcast });
}

function clearLocalSourceStates() {
  controllerInput?.clear({ notifyChange: false });
  updateLocalPlayerState({ broadcast: false });
}

function applyRemoteButtons(buttons) {
  setPlayerButtons(remotePlayer, new Set(buttons || []));
}

function isTransportOpen() {
  if (networkTransport === 'relay') {
    return relaySocket?.readyState === WebSocket.OPEN && peerConnected;
  }
  return Boolean(peerConnection?.open);
}

function binaryStringToArrayBuffer(value) {
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  const text = String(value || '');
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index++) bytes[index] = text.charCodeAt(index) & 0xff;
  return bytes.buffer;
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(String(value || ''));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function encodeNetworkState(state) {
  // These PPU arrays are either deterministic lookup tables or temporary
  // render targets. Rebuilding/reusing them on the guest cuts a typical
  // compressed snapshot from about 100 KB to about 40 KB without removing
  // CPU, mapper, controller, VRAM, sprite, or audio state.
  delete state.ppu?.vramMirrorTable;
  delete state.ppu?.buffer;
  delete state.ppu?.bgbuffer;
  delete state.ppu?.pixrendered;
  return bytesToBase64(gzipSync(strToU8(JSON.stringify(state)), { level: 9 }));
}

function decodeNetworkState(value) {
  return JSON.parse(strFromU8(gunzipSync(base64ToBytes(value))));
}

function sendTransportMessage(message) {
  if (networkTransport === 'relay') {
    if (message.type === 'rom') {
      const rawBytes = new Uint8Array(binaryStringToArrayBuffer(message.data));
      const compressedBytes = gzipSync(rawBytes, { level: 6 });
      const useCompressed = compressedBytes.length < rawBytes.length;
      const payload = useCompressed ? compressedBytes : rawBytes;
      logNetworkEvent('relay-rom-send', { rawBytes: rawBytes.length, wireBytes: payload.length, encoding: useCompressed ? 'gzip' : 'raw' });
      relaySocket.send(JSON.stringify({ __nes: 'rom', name: message.name || 'NES 游戏', encoding: useCompressed ? 'gzip' : 'raw' }));
      relaySocket.send(payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength));
      return;
    }
    if (message.type === 'state-gzip') {
      const payload = base64ToBytes(message.data);
      logNetworkEvent('relay-state-send', { syncId: message.syncId || 'none', wireBytes: payload.length, frame: message.frame });
      relaySocket.send(JSON.stringify({
        __nes: 'state-gzip',
        syncId: message.syncId || '',
        frame: Number(message.frame) || 0,
      }));
      relaySocket.send(payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength));
      return;
    }
    relaySocket.send(JSON.stringify(message));
    return;
  }
  peerConnection.send(message);
}

function sendPeerMessage(message) {
  if (!isTransportOpen()) {
    if (message.type === 'state' || message.type === 'clock') {
      peerPendingMessages = peerPendingMessages.filter((pending) => pending.type !== message.type);
    }
    if (message.type === 'input' || message.type === 'input-request') {
      peerPendingMessages = peerPendingMessages.filter((pending) => !(pending.type === message.type && pending.player === message.player));
    }
    peerPendingMessages.push(message);
    if (peerPendingMessages.length > MAX_PEER_QUEUE_SIZE) peerPendingMessages.shift();
    return;
  }
  try {
    sendTransportMessage(message);
  } catch (error) {
    console.warn(error);
  }
}

function flushPeerQueue() {
  if (!isTransportOpen()) return;
  while (peerPendingMessages.length) {
    try {
      sendTransportMessage(peerPendingMessages.shift());
    } catch (error) {
      console.warn(error);
      break;
    }
  }
}

function sendPeerButtons(player, buttons) {
  if (networkRole === 'offline') return;
  const nextButtons = Array.from(buttons || []);
  if (isAuthoritativeStreamMode()) {
    if (networkRole === 'host') {
      // 1P is the only emulator in stream mode, so local input is applied
      // immediately and never waits for a network frame.
      setPlayerButtons(player, new Set(nextButtons), { broadcast: false });
    } else {
      sendStreamInput(new Set(nextButtons));
    }
    return;
  }
  const id = `${networkRole === 'host' ? 'h' : 'g'}-${++localInputSequence}`;
  if (networkRole === 'host') {
    const delayFrames = getNetworkInputDelayFrames();
    const frame = gameFrame + delayFrames;
    const order = ++authoritativeInputOrder;
    logNetworkEvent('input-send', { role: 'host', player, buttons: nextButtons, frame, delayFrames, id });
    scheduleNetworkInput(player, nextButtons, frame, { id, order });
    sendPeerMessage({ type: 'input', player, ...inputPayload(nextButtons), frame, id, order });
    return;
  }
  // Target a near-future frame on the authoritative host clock. Rollback is a
  // jitter safety net, not the normal path: rewinding on every rapid 2P edge
  // stalls video and audio on both devices.
  const estimatedHostFrame = getEstimatedHostFrame();
  const inputPlan = getGuestInputPlan({
    gameFrame,
    estimatedHostFrame,
    rttMs: networkRttMs,
    jitterMs: networkRttJitterMs,
    safetyFrames: guestInputSafetyFrames,
    transportStalled: networkTransportStalled,
  });
  const { frame, leadFrames, transitFrames, rollback: lowLatencyRollback } = inputPlan;
  const order = ++networkEventOrder;
  // While the host clock is unavailable, retain immediate touch feedback but
  // do not advance a speculative game timeline. The host still receives the
  // input and its authoritative snapshot is applied when delivery resumes.
  if (!networkTransportStalled) scheduleNetworkInput(player, nextButtons, frame, { id, order });
  logNetworkEvent('input-send', {
    role: 'guest',
    player,
    buttons: nextButtons,
    frame,
    localFrame: gameFrame,
    estimatedHostFrame: Math.round(estimatedHostFrame),
    leadFrames,
    mode: inputPlan.mode,
    id,
    predicted: !networkTransportStalled,
  });
  sendPeerMessage({
    type: 'input-request',
    player,
    ...inputPayload(nextButtons),
    frame,
    id,
    lowLatencyRollback,
    clientSentAt: Math.round(performance.now()),
  });
}

function getNetworkInputDelayFrames() {
  // The guest carries the latency buffer. Delaying host input by half the RTT
  // made local controls take one or two seconds on overseas relay routes.
  return NET_INPUT_DELAY_FRAMES;
}

function getEstimatedHostFrame(now = performance.now()) {
  if (hostClockFrame === null) return gameFrame + getRelayGuestBufferFrames();
  const transitEstimate = networkRttMs > 0 ? networkRttMs / 2 : 0;
  // Never invent seconds of host progress from an old clock sample. The loop
  // freezes the guest and performs a state sync when delivery resumes.
  const clockAge = Math.max(0, Math.min(HOST_CLOCK_STALE_MS, now - hostClockReceivedAt));
  return hostClockFrame + (transitEstimate + clockAge) / FRAME_MS;
}

function acceptHostClock(frame, source = 'clock') {
  const recoveredFromStall = networkTransportStalled;
  const nextFrame = Number(frame);
  if (Number.isFinite(nextFrame)) hostClockFrame = Math.max(0, nextFrame);
  hostClockReceivedAt = performance.now();
  if (!recoveredFromStall) return;
  networkTransportStalled = false;
  // A pong is also an authoritative host-frame sample. Handling recovery only
  // for clock packets left the guest marked as stalled even after ping proved
  // the relay route was healthy again.
  networkRttMs = 0;
  networkRttJitterMs = 0;
  networkPingId = '';
  logNetworkEvent('network-transport-recovered', { source, hostFrame: hostClockFrame, localFrame: gameFrame });
  requestInitialStateSync('reconnect');
}

function recordNetworkRtt(sampleMs, source = 'ping') {
  const parsedSample = Number(sampleMs);
  if (!Number.isFinite(parsedSample) || parsedSample <= 0) return networkRttMs;
  const sample = Math.max(1, Math.min(5000, parsedSample));
  if (!networkRttMs) {
    networkRttMs = sample;
    networkRttJitterMs = 4;
  } else {
    const previousRtt = networkRttMs;
    const routeBecameFaster = sample < previousRtt * 0.6;
    const deviation = Math.abs(sample - previousRtt);
    if (routeBecameFaster) {
      // DERP often hands over to a direct Tailscale path. Do not keep the old
      // route's large variation as artificial input delay after that switch.
      networkRttJitterMs = Math.min(networkRttJitterMs || 4, 4);
    } else {
      const jitterWeight = deviation < networkRttJitterMs ? 0.45 : 0.25;
      networkRttJitterMs += (deviation - networkRttJitterMs) * jitterWeight;
    }
    // A route commonly starts on DERP and then becomes direct. Fall quickly
    // when that happens, but increase slowly for isolated mobile-network
    // spikes so one bad packet cannot add a permanent second of buffering.
    const weight = routeBecameFaster ? 0.8 : sample < networkRttMs ? 0.65 : 0.2;
    networkRttMs += (sample - networkRttMs) * weight;
  }
  logNetworkEvent('network-rtt', {
    source,
    sampleMs: Math.round(sample),
    smoothedMs: Math.round(networkRttMs),
    jitterMs: Math.round(networkRttJitterMs),
    jitterBufferMs: getRelayJitterBufferMs(),
    bufferFrames: getRelayGuestBufferFrames(networkRttMs),
  });
  return networkRttMs;
}

function getRelayJitterBufferMs() {
  if (!networkRttMs) return 24;
  return Math.max(
    RELAY_MIN_JITTER_BUFFER_MS,
    Math.min(RELAY_MAX_JITTER_BUFFER_MS, Math.round(8 + networkRttJitterMs * 1.25)),
  );
}

function getRelayGuestBufferFrames(rttMs = networkRttMs) {
  if (networkTransport !== 'relay') return 1;
  const rtt = rttMs > 0 ? rttMs : DEFAULT_NETWORK_RTT_MS;
  return Math.max(
    RELAY_MIN_GUEST_BUFFER_FRAMES,
    // Rollback covers a one-frame miss, so do not turn a healthy 30–40ms
    // Tailscale route into two artificial playback frames plus input lead.
    Math.min(RELAY_MAX_GUEST_BUFFER_FRAMES, Math.ceil((rtt / 2 + getRelayJitterBufferMs()) / FRAME_MS) - 1),
  );
}

function compareNetworkInputs(left, right) {
  return left.frame - right.frame || left.order - right.order || String(left.id).localeCompare(String(right.id));
}

function rebuildScheduledNetworkInputs(fromFrame = gameFrame) {
  scheduledNetworkInputs = networkInputHistory
    .filter((input) => input.frame >= fromFrame)
    .map((input) => ({ ...input, buttons: [...input.buttons] }))
    .sort(compareNetworkInputs);
}

function resetRollbackState({ capture = false, preserveInputsFromFrame = null } = {}) {
  const preservedInputs = Number.isFinite(preserveInputsFromFrame)
    ? networkInputHistory.filter((input) => input.frame >= preserveInputsFromFrame)
    : [];
  scheduledNetworkInputs = [];
  networkInputHistory = preservedInputs;
  rollbackSnapshots = [];
  rollbackInProgress = false;
  rollbackCount = 0;
  rollbackFrames = 0;
  pendingStateChecks = new Map();
  lastStateCheckFrame = -1;
  pendingRollbackFrame = null;
  pendingRollbackReason = '';
  stateCheckStatus = '等待';
  stateCheckFrame = 0;
  stateMismatchCount = 0;
  if (capture) captureRollbackSnapshot(true);
  rebuildScheduledNetworkInputs(gameFrame);
}

function hashRollbackState(state) {
  return hashDeterministicState(state);
}

function compareRollbackStateCheck(snapshot, expectedHash, expectedComponents = null) {
  const actualHash = snapshot.hash || (snapshot.hash = hashRollbackState(snapshot.state));
  const match = actualHash === expectedHash;
  const details = {
    frame: snapshot.frame,
    expectedHash,
    actualHash,
  };
  if (!match && expectedComponents) {
    const actualComponents = hashDeterministicComponents(snapshot.state);
    details.componentDiffs = Object.keys(expectedComponents).filter(
      (name) => expectedComponents[name] !== actualComponents[name],
    );
    details.expectedComponents = expectedComponents;
    details.actualComponents = actualComponents;
  }
  logNetworkEvent(match ? 'state-check-ok' : 'state-check-mismatch', details);
  pendingStateChecks.delete(snapshot.frame);
  stateCheckStatus = match ? '一致' : '差异';
  stateCheckFrame = snapshot.frame;
  if (!match) stateMismatchCount++;
  if (!match && networkRole === 'guest' && !stateRequestInFlight && !networkSyncId) {
    requestInitialStateSync('desync');
  }
}

function processRollbackStateCheck(snapshot) {
  if (rollbackInProgress || snapshot.frame <= 0) return;
  if (networkRole === 'host') {
    // Only verify a frame after it has left the rollback window. A newer 2P
    // input may legitimately rewrite recent host history.
    const stableSnapshot = rollbackSnapshots.find((candidate) => (
      candidate.frame > lastStateCheckFrame
      && candidate.frame % NETWORK_STATE_CHECK_INTERVAL_FRAMES === 0
      && candidate.frame <= gameFrame - ROLLBACK_WINDOW_FRAMES
    ));
    if (!stableSnapshot) return;
    lastStateCheckFrame = stableSnapshot.frame;
    const hash = stableSnapshot.hash || (stableSnapshot.hash = hashRollbackState(stableSnapshot.state));
    const components = hashDeterministicComponents(stableSnapshot.state);
    sendPeerMessage({ type: 'state-check', frame: stableSnapshot.frame, hash, components });
    logNetworkEvent('state-check-send', { frame: stableSnapshot.frame, hash, components });
    return;
  }
  if (networkRole === 'guest' && pendingStateChecks.has(snapshot.frame)) {
    const pending = pendingStateChecks.get(snapshot.frame);
    compareRollbackStateCheck(snapshot, pending.hash, pending.components);
  }
}

function captureRollbackState() {
  return captureDeterministicState(nes);
}

function restoreRollbackState(state) {
  restoreDeterministicState(nes, state);
}

function captureRollbackSnapshot(force = false) {
  if (!nes || networkRole === 'offline' || !peerConnected) return null;
  if (!force && gameFrame % ROLLBACK_SNAPSHOT_INTERVAL_FRAMES !== 0) return null;
  const existing = rollbackSnapshots.find((snapshot) => snapshot.frame === gameFrame);
  if (existing) return existing;
  const snapshot = {
    frame: gameFrame,
    state: captureRollbackState(),
    buttons: {
      1: Array.from(buttonStateByPlayer[1]),
      2: Array.from(buttonStateByPlayer[2]),
    },
  };
  rollbackSnapshots.push(snapshot);
  rollbackSnapshots.sort((left, right) => left.frame - right.frame);
  if (rollbackSnapshots.length > ROLLBACK_MAX_SNAPSHOTS) rollbackSnapshots.shift();
  const oldestFrame = rollbackSnapshots[0]?.frame ?? Math.max(0, gameFrame - ROLLBACK_WINDOW_FRAMES);
  networkInputHistory = networkInputHistory.filter((input) => input.frame >= oldestFrame);
  processRollbackStateCheck(snapshot);
  return snapshot;
}

function restoreRollbackButtons(snapshot) {
  for (const player of [1, 2]) {
    buttonStateByPlayer[player].clear();
    for (const button of snapshot.buttons[player] || []) buttonStateByPlayer[player].add(button);
  }
}

function syncButtonSetsFromNes() {
  if (!nes?.controllers) return;
  for (const player of [1, 2]) {
    const controller = nes.controllers[player];
    buttonStateByPlayer[player].clear();
    for (const [name, code] of Object.entries(buttonMap)) {
      const pressed = name === 'TURBO_A'
        ? controller.turboA
        : name === 'TURBO_B'
          ? controller.turboB
          : controller.state[code] === 0x41;
      if (pressed) buttonStateByPlayer[player].add(name);
    }
  }
}

function rollbackNetworkToFrame(targetFrame, reason = 'late-input') {
  if (!nes || rollbackInProgress || targetFrame >= gameFrame) return false;
  const endFrame = gameFrame;
  const snapshot = [...rollbackSnapshots].reverse().find((candidate) => candidate.frame <= targetFrame);
  if (!snapshot) return false;
  const startedAt = performance.now();
  const previousSuppressOutput = suppressEmulatorOutput;
  rollbackInProgress = true;
  suppressEmulatorOutput = true;
  try {
    rollbackSnapshots = rollbackSnapshots.filter((candidate) => candidate.frame <= snapshot.frame);
    restoreRollbackState(snapshot.state);
    gameFrame = snapshot.frame;
    restoreRollbackButtons(snapshot);
    rebuildScheduledNetworkInputs(gameFrame);
    while (gameFrame < endFrame) {
      captureRollbackSnapshot();
      applyScheduledNetworkInputs();
      nes.frame();
      gameFrame++;
    }
  } catch (error) {
    console.warn('回滚重算失败', error);
    logNetworkEvent('rollback-error', { name: error?.name || 'Error', message: error?.message || String(error) });
    return false;
  } finally {
    rollbackInProgress = false;
    suppressEmulatorOutput = previousSuppressOutput;
    syncButtonVisuals();
  }
  logNetworkEvent('rollback-complete', {
    reason,
    fromFrame: endFrame,
    snapshotFrame: snapshot.frame,
    targetFrame,
    replayedFrames: endFrame - snapshot.frame,
    durationMs: Math.round(performance.now() - startedAt),
  });
  rollbackCount++;
  rollbackFrames += endFrame - snapshot.frame;
  return true;
}

function queueNetworkRollback(targetFrame, reason) {
  pendingRollbackFrame = pendingRollbackFrame === null
    ? targetFrame
    : Math.min(pendingRollbackFrame, targetFrame);
  pendingRollbackReason = pendingRollbackReason || reason;
}

function flushPendingNetworkRollback() {
  if (pendingRollbackFrame === null) return true;
  const targetFrame = pendingRollbackFrame;
  const reason = pendingRollbackReason || 'batched-input';
  pendingRollbackFrame = null;
  pendingRollbackReason = '';
  const rolledBack = rollbackNetworkToFrame(targetFrame, reason);
  if (!rolledBack && targetFrame < gameFrame && networkRole === 'guest') {
    recoverFromLateNetworkInput({ requestedFrame: targetFrame, localFrame: gameFrame, reason: 'rollback-window-miss' });
  }
  return rolledBack;
}

function buttonsMatch(left, right) {
  return left.length === right.length && left.every((button, index) => button === right[index]);
}

function scheduleNetworkInput(player, buttons, frame, {
  id = '',
  order = 0,
  allowRollback = true,
  deferRollback = false,
} = {}) {
  const requestedFrame = Math.max(0, Math.floor(Number(frame) || 0));
  const normalizedButtons = Array.from(buttons || []).sort();
  const inputId = String(id || `legacy-${++networkEventOrder}`);
  const normalizedOrder = Math.max(1, Math.floor(Number(order) || ++networkEventOrder));
  let rollbackFrame = requestedFrame;
  let corrected = false;
  const existing = networkInputHistory.find((input) => input.id === inputId);
  if (existing) {
    rollbackFrame = Math.min(existing.frame, requestedFrame);
    corrected = existing.frame !== requestedFrame
      || existing.player !== player
      || !buttonsMatch(existing.buttons, normalizedButtons);
    existing.player = player;
    existing.buttons = normalizedButtons;
    existing.frame = requestedFrame;
    existing.order = normalizedOrder;
  } else {
    networkInputHistory.push({ id: inputId, player, buttons: normalizedButtons, frame: requestedFrame, order: normalizedOrder });
  }
  networkInputHistory.sort(compareNetworkInputs);
  rebuildScheduledNetworkInputs(gameFrame);
  // A matching authoritative echo only confirms an already-predicted 2P
  // event. Rewinding for that duplicate made both devices stutter on taps.
  const timelineChanged = !existing || corrected;
  const late = timelineChanged && rollbackFrame < gameFrame;
  const rollbackReason = corrected ? 'input-correction' : 'late-input';
  const rollbackQueued = late && allowRollback && deferRollback;
  if (rollbackQueued) queueNetworkRollback(rollbackFrame, rollbackReason);
  const rolledBack = late && allowRollback && !deferRollback && rollbackNetworkToFrame(rollbackFrame, rollbackReason);
  return {
    late,
    rolledBack,
    rollbackQueued,
    corrected,
    duplicate: Boolean(existing) && !corrected,
    requestedFrame,
    targetFrame: requestedFrame,
    id: inputId,
  };
}

function applyScheduledNetworkInputs() {
  while (scheduledNetworkInputs.length && scheduledNetworkInputs[0].frame <= gameFrame) {
    const input = scheduledNetworkInputs.shift();
    setPlayerButtons(input.player, new Set(input.buttons), { broadcast: false });
  }
}

function sendPeerSnapshot(syncId = '') {
  if (networkRole !== 'host' || !nes || !peerConnected) return;
  try {
    const encodedState = encodeNetworkState(captureDeterministicState(nes));
    logNetworkEvent('state-send', { syncId: syncId || 'none', base64Bytes: encodedState.length, frame: gameFrame });
    sendPeerMessage({
      type: 'state-gzip',
      data: encodedState,
      frame: gameFrame,
      syncId,
    });
  } catch (error) {
    console.warn(error);
  }
}

function clearNetworkSync() {
  clearTimeout(networkSyncTimeout);
  clearTimeout(networkSyncProbeTimeout);
  networkSyncTimeout = 0;
  networkSyncProbeTimeout = 0;
  networkSyncId = '';
  networkSyncProbeId = '';
  networkSyncProbeSentAt = 0;
  networkSyncPaused = false;
  stateRequestInFlight = false;
}

function startHostStateSync(syncId) {
  if (!syncId || networkSyncId) return;
  networkSyncId = syncId;
  sendPeerSnapshot(syncId);
  networkSyncTimeout = window.setTimeout(() => {
    if (networkSyncId !== syncId) return;
    logNetworkEvent('state-sync-timeout', { syncId, frame: gameFrame });
    sendPeerMessage({ type: 'sync-start', syncId, frame: gameFrame });
    clearNetworkSync();
  }, NETWORK_SYNC_TIMEOUT_MS);
}

function requestInitialStateSync(reason = 'initial') {
  if (networkRole !== 'guest' || stateRequestInFlight) return;
  const syncId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  networkSyncId = syncId;
  networkSyncPaused = true;
  stateRequestInFlight = true;
  lastStateRequestAt = performance.now();
  const statusText = reason === 'late-input'
    ? '检测到网络抖动，正在恢复画面同步...'
    : reason === 'desync'
      ? '检测到状态差异，正在恢复权威进度...'
      : reason === 'reconnect'
        ? '网络已恢复，正在重新同步 1P 进度...'
        : '游戏已加载，正在同步 1P 进度...';
  setNetworkText(statusText);
  logNetworkEvent('state-request-sent', { syncId, reason });
  sendPeerMessage({ type: 'state-request', syncId });
}

function recoverFromLateNetworkInput(detail) {
  if (networkRole !== 'guest' || stateRequestInFlight || networkSyncId) return;
  const now = performance.now();
  if (lastLateInputResyncAt && now - lastLateInputResyncAt < LATE_INPUT_RESYNC_COOLDOWN_MS) return;
  lastLateInputResyncAt = now;
  logNetworkEvent('late-input-resync', detail);
  // Continuing even a few frames after a late input can permanently fork a
  // deterministic NES game. Freeze immediately and recover from the host.
  requestInitialStateSync('late-input');
}

function fastForwardNetworkToFrame(targetFrame) {
  if (!nes) return;
  const target = Math.max(gameFrame, Number(targetFrame) || gameFrame);
  const requestedFrames = target - gameFrame;
  const maxFastForwardFrames = 1800;
  const finalTarget = gameFrame + Math.min(requestedFrames, maxFastForwardFrames);
  const startedAt = performance.now();
  suppressEmulatorOutput = true;
  try {
    while (gameFrame < finalTarget) {
      captureRollbackSnapshot();
      applyScheduledNetworkInputs();
      nes.frame();
      gameFrame++;
    }
  } finally {
    suppressEmulatorOutput = false;
    clearAudioBuffer();
  }
  logNetworkEvent('sync-fast-forward', {
    requestedFrames,
    appliedFrames: finalTarget - (target - requestedFrames),
    durationMs: Math.round(performance.now() - startedAt),
    targetFrame: target,
    finalFrame: gameFrame,
  });
}

function finishGuestStateSync(targetFrame, detail = {}) {
  logNetworkEvent('sync-final-target', { targetFrame, ...detail });
  fastForwardNetworkToFrame(targetFrame);
  clearNetworkSync();
  lastTick = 0;
  frameRemainder = 0;
  setNetworkText(`同步完成（${networkTransport === 'relay' ? '私有中继' : 'WebRTC 直连'}）`);
}

function applyPeerRom(romData, name = 'NES 游戏') {
  pendingPeerRomData = romData;
  lastRomData = romData;
  lastRomName = name;
  lastRomLibraryPath = '';
  startRom(romData, name);
}

function sendCurrentRomToPeer({ forceBinary = false } = {}) {
  if (networkRole !== 'host' || !lastRomData) return;
  if (!forceBinary && lastRomLibraryPath) {
    sendPeerMessage({ type: 'rom-library', name: lastRomName, path: lastRomLibraryPath });
  } else {
    sendPeerMessage({ type: 'rom', name: lastRomName, data: lastRomData });
  }
  peerRomSent = true;
}

async function applyPeerLibraryRom(message) {
  const path = String(message.path || '');
  if (!path || path.includes('..') || path.includes('://') || !/\.zip$/i.test(path)) {
    throw new Error('游戏库路径无效');
  }
  const response = await fetch(`${import.meta.env.BASE_URL}${path}`);
  if (!response.ok) throw new Error(`游戏下载失败：${response.status}`);
  const files = unzipSync(new Uint8Array(await response.arrayBuffer()));
  const romEntry = Object.entries(files).find(([name]) => name.toLowerCase().endsWith('.nes'));
  if (!romEntry) throw new Error('压缩包中没有找到 .nes 文件');
  const [, bytes] = romEntry;
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const romData = arrayBufferToBinary(buffer);
  logNetworkEvent('library-rom-received', { name: message.name || 'NES 游戏', bytes: bytes.length });
  applyPeerRom(romData, message.name || 'NES 游戏');
  peerRomSent = true;
  requestInitialStateSync();
}

function updateNetworkButtons() {
  const active = networkRole !== 'offline';
  if (netHostBtn) setButtonLabel(netHostBtn, networkRole === 'host' && networkTransport === 'peer' && peerReady ? '直连房间已创建' : '创建直连房间');
  if (relayHostBtn) {
    relayHostBtn.classList.toggle('hidden', !RELAY_SERVER_URL);
    setButtonLabel(relayHostBtn, networkRole === 'host' && networkTransport === 'relay' && relayReady ? '跨网房间已创建' : '创建跨网房间');
    relayHostBtn.disabled = active || !RELAY_SERVER_URL;
    relayHostBtn.title = RELAY_SERVER_URL ? '使用私人公网中继建立跨网房间' : '公网中继尚未部署';
  }
  relayAccessRow?.classList.toggle('hidden', !RELAY_SERVER_URL || active);
  if (netHostBtn) netHostBtn.disabled = active;
  if (netLeaveBtn) netLeaveBtn.disabled = !active;
  if (netCopyBtn) netCopyBtn.disabled = !roomId || (networkTransport === 'relay' ? !relayReady : !peerReady);
}

function teardownPeerConnection(finalStatus = '') {
  peerConnected = false;
  peerRomSent = false;
  if (networkRole === 'host') setPlayerButtons(2, new Set(), { broadcast: false });
  teardownStreamSession();
  peerConnection?.close?.();
  peerConnection = null;
  peerPendingMessages = [];
  resetRollbackState();
  hostClockFrame = null;
  hostClockReceivedAt = 0;
  networkTransportStalled = false;
  guestInputSafetyFrames = 0;
  guestLastLateInputAt = 0;
  lastInputAckSampleAt = 0;
  lastStateRequestAt = 0;
  clearNetworkSync();
  lastNetworkClockAt = 0;
  networkRttMs = 0;
  networkRttJitterMs = 0;
  networkPingId = '';
  networkPingSentAt = 0;
  lastNetworkPingAt = 0;
  networkPingTimeoutCount = 0;
  lastGuestCatchUpLogAt = 0;
  lastLateInputResyncAt = 0;
  performanceHudLastAt = 0;
  performanceHudFrames = 0;
  performanceHudFps = 0;
  netPerformanceHud?.classList.add('hidden');
  const waitingText = networkTransport === 'relay' ? '跨网房间已创建，等待加入' : '直连房间已创建，等待加入';
  setNetworkText(finalStatus || (networkRole === 'host' ? waitingText : networkRole === 'guest' ? '已断开联机' : '未联机'));
  updateNetworkButtons();
}

function teardownPeer({ preserveRelaySession = false } = {}) {
  clearTimeout(hybridFallbackTimer);
  hybridFallbackTimer = 0;
  hybridFallbackStarted = false;
  teardownPeerConnection();
  peer?.destroy?.();
  peer = null;
  peerReady = false;
  if (relaySocket) {
    relaySocket.onclose = null;
    relaySocket.onerror = null;
    relaySocket.close();
  }
  relaySocket = null;
  relayReady = false;
  relayPendingRomName = '';
  relayPendingRomEncoding = '';
  relayPendingState = null;
  relayTurnConfig = null;
  relayGuestTicket = '';
  if (!preserveRelaySession) {
    clearTimeout(relayReconnectTimer);
    relayReconnectTimer = 0;
    relaySessionTicket = '';
    relayReconnectAttempts = 0;
  }
  relayDataQueue = Promise.resolve();
  networkPlayMode = 'rollback';
}

function closeRelaySocketSilently() {
  const socket = relaySocket;
  relaySocket = null;
  relayReady = false;
  if (!socket) return;
  socket.onclose = null;
  socket.onerror = null;
  socket.close();
}

function reconnectRelayGuest(reason = 'connection-lost') {
  if (networkRole !== 'guest' || networkTransport !== 'relay' || !roomId || !relaySessionTicket) return false;
  if (relayReconnectTimer || relayReconnectAttempts >= 3) {
    if (relayReconnectAttempts >= 3) setNetworkText('自动重连失败，请重新打开邀请链接');
    return false;
  }
  const reconnectRoom = roomId;
  const reconnectTicket = relaySessionTicket;
  const attempt = ++relayReconnectAttempts;
  logNetworkEvent('relay-reconnect-scheduled', { reason, attempt });
  closeRelaySocketSilently();
  teardownPeerConnection(`连接中断，正在自动重连（${attempt}/3）...`);
  relayReconnectTimer = window.setTimeout(() => {
    relayReconnectTimer = 0;
    connectRelay('guest', reconnectRoom, reconnectTicket, '', { reconnect: true, attempt });
  }, Math.min(1800, 300 * attempt));
  return true;
}

function cancelPendingDirectConnection() {
  if (networkTransport !== 'relay' || !peerConnection || peerConnection.open) return;
  const connection = peerConnection;
  peerConnection = null;
  clearTimeout(connection.__nesTimeoutId);
  connection.__nesTimeoutId = 0;
  connection.__nesIgnore = true;
  connection.close();
  logNetworkEvent('pending-direct-cancelled-after-relay');
}

function markNetworkConnected() {
  if (peerConnected) return;
  peerConnected = true;
  networkHeartbeatTick();
  resetRollbackState({ capture: !isAuthoritativeStreamMode() && Boolean(nes) });
  flushPeerQueue();
  const route = networkTransport === 'relay' ? '私有中继' : 'WebRTC 直连';
  setNetworkText(isAuthoritativeStreamMode()
    ? networkRole === 'host' ? '2P 已连接，正在建立 1P 权威画面...' : '已加入房间，等待 1P 权威画面'
    : networkRole === 'host' ? `2P 已连接（${route}）` : `已通过${route}加入，等待游戏同步`);
  updateNetworkButtons();
  if (isAuthoritativeStreamMode()) {
    if (networkRole === 'host') startHostAuthoritativeStream().catch((error) => {
      console.warn(error);
      logNetworkEvent('stream-host-start-error', { name: error?.name || 'Error', message: error?.message || String(error) });
      setNetworkText('1P 权威画面启动失败，请重新创建房间');
    });
  } else if (networkRole === 'host' && lastRomData && !peerRomSent) {
    sendCurrentRomToPeer();
  } else if (networkRole === 'guest') {
    // Do not rely solely on the host's peer-connected notification. Mobile
    // WebSockets can finish opening after a stale guest has just been
    // replaced, leaving the new page connected but waiting forever for ROM.
    logNetworkEvent('rom-request-sent');
    sendPeerMessage({ type: 'rom-request' });
  }
}

function handleNetworkMessage(message) {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'stream-offer') {
    acceptHostStreamOffer(message).catch((error) => {
      console.warn(error);
      logNetworkEvent('stream-offer-error', { name: error?.name || 'Error', message: error?.message || String(error) });
      setNetworkText('接收 1P 权威画面失败，请重新加入');
    });
    return;
  }
  if (message.type === 'stream-answer') {
    acceptGuestStreamAnswer(message).catch((error) => {
      console.warn(error);
      logNetworkEvent('stream-answer-error', { name: error?.name || 'Error', message: error?.message || String(error) });
    });
    return;
  }
  if (message.type === 'stream-ice') {
    addStreamIceCandidate(message);
    return;
  }
  if (message.type === 'stream-input') {
    applyStreamRemoteInput(message);
    return;
  }
  if (message.type === 'stream-ready' && networkRole === 'host' && isAuthoritativeStreamMode()) {
    setNetworkText(message.muted ? '2P 画面已同步，等待 2P 点手柄开启声音' : '2P 已同步到 1P 权威画面');
    logNetworkEvent('stream-ready', { muted: Boolean(message.muted) });
    return;
  }
  if (message.type === 'ping' && networkRole === 'host') {
    sendPeerMessage({ type: 'pong', id: message.id, frame: gameFrame });
    return;
  }
  if (message.type === 'pong' && networkRole === 'guest' && message.id === networkPingId) {
    const measuredRtt = Math.max(0, performance.now() - networkPingSentAt);
    networkPingId = '';
    acceptHostClock(message.frame, 'pong');
    recordNetworkRtt(measuredRtt);
    sendPeerMessage({ type: 'latency-report', rttMs: Math.round(networkRttMs) });
    return;
  }
  if (message.type === 'latency-report' && networkRole === 'host') {
    const reportedRtt = Math.max(0, Math.min(5000, Number(message.rttMs) || 0));
    if (reportedRtt) recordNetworkRtt(reportedRtt, 'guest-report');
    return;
  }
  if (message.type === 'state-check' && networkRole === 'guest') {
    const frame = Math.max(0, Math.floor(Number(message.frame) || 0));
    const expectedHash = String(message.hash || '');
    const expectedComponents = message.components && typeof message.components === 'object'
      ? message.components
      : null;
    const snapshot = rollbackSnapshots.find((candidate) => candidate.frame === frame);
    if (snapshot) compareRollbackStateCheck(snapshot, expectedHash, expectedComponents);
    else {
      pendingStateChecks.set(frame, { hash: expectedHash, components: expectedComponents });
      for (const pendingFrame of pendingStateChecks.keys()) {
        if (pendingFrame < gameFrame - ROLLBACK_WINDOW_FRAMES) pendingStateChecks.delete(pendingFrame);
      }
    }
    return;
  }
  if (message.type === 'input-request' && networkRole === 'host' && message.player === remotePlayer) {
    const buttons = messageButtons(message);
    const delayFrames = getNetworkInputDelayFrames();
    const requestedFrame = Math.max(0, Math.floor(Number(message.frame) || gameFrame));
    const oldestRollbackFrame = rollbackSnapshots[0]?.frame ?? gameFrame;
    const frame = requestedFrame >= oldestRollbackFrame && requestedFrame <= gameFrame + GUEST_INPUT_MAX_LEAD_FRAMES + 2
      ? requestedFrame
      : gameFrame + delayFrames;
    const id = String(message.id || `g-legacy-${++networkEventOrder}`);
    const order = ++authoritativeInputOrder;
    const scheduled = scheduleNetworkInput(message.player, buttons, frame, { id, order, deferRollback: true });
    const inputLateness = getGuestInputLateness({
      requestedFrame: frame,
      hostFrame: gameFrame,
      rollbackEnabled: Boolean(message.lowLatencyRollback),
    });
    logNetworkEvent('input-request-received', {
      player: message.player,
      buttons,
      requestedFrame,
      frame,
      id,
      rolledBack: scheduled.rolledBack,
      rollbackQueued: scheduled.rollbackQueued,
      correctedFrame: frame !== requestedFrame,
      latenessFrames: inputLateness.latenessFrames,
      excessiveLate: inputLateness.tooLate,
    });
    sendPeerMessage({
      type: 'input',
      player: message.player,
      ...inputPayload(buttons),
      frame,
      id,
      order,
      hostLate: inputLateness.tooLate,
      lowLatencyRollback: Boolean(message.lowLatencyRollback),
      clientSentAt: Number(message.clientSentAt) || 0,
    });
    return;
  }
  if (message.type === 'state-request' && networkRole === 'host') {
    logNetworkEvent('state-request-received', { syncId: message.syncId || 'legacy' });
    if (message.syncId) startHostStateSync(message.syncId);
    else sendPeerSnapshot();
    return;
  }
  if (message.type === 'state-applied' && networkRole === 'host' && message.syncId === networkSyncId) {
    logNetworkEvent('state-applied-ack', { syncId: message.syncId, frame: gameFrame });
    sendPeerMessage({ type: 'sync-start', syncId: networkSyncId, frame: gameFrame });
    clearNetworkSync();
    setNetworkText(`2P 同步完成（${networkTransport === 'relay' ? '私有中继' : 'WebRTC 直连'}）`);
    return;
  }
  if (message.type === 'sync-frame-request' && networkRole === 'host') {
    sendPeerMessage({
      type: 'sync-frame',
      syncId: message.syncId || '',
      probeId: message.probeId || '',
      frame: gameFrame,
    });
    return;
  }
  if (message.type === 'sync-start' && networkRole === 'guest' && message.syncId === networkSyncId) {
    logNetworkEvent('sync-start-received', { syncId: message.syncId, frame: message.frame });
    networkSyncProbeId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    networkSyncProbeSentAt = performance.now();
    setNetworkText('进度已接收，正在校准双方画面...');
    sendPeerMessage({ type: 'sync-frame-request', syncId: networkSyncId, probeId: networkSyncProbeId });
    const fallbackFrame = Number(message.frame) || gameFrame;
    networkSyncProbeTimeout = window.setTimeout(() => {
      if (!networkSyncId || !networkSyncProbeId) return;
      logNetworkEvent('sync-frame-probe-timeout', { probeId: networkSyncProbeId });
      finishGuestStateSync(fallbackFrame, { fallback: true });
    }, 5000);
    return;
  }
  if (message.type === 'sync-frame' && networkRole === 'guest'
    && message.syncId === networkSyncId && message.probeId === networkSyncProbeId) {
    const probeRtt = Math.max(0, performance.now() - networkSyncProbeSentAt);
    recordNetworkRtt(probeRtt, 'sync-probe');
    const transitFrames = Math.max(0, Math.round((probeRtt / 2) / FRAME_MS));
    const bufferFrames = getRelayGuestBufferFrames();
    const targetFrame = Math.max(gameFrame, (Number(message.frame) || gameFrame) + transitFrames - bufferFrames);
    sendPeerMessage({ type: 'latency-report', rttMs: Math.round(networkRttMs) });
    finishGuestStateSync(targetFrame, {
      probeRttMs: Math.round(probeRtt),
      transitFrames,
      bufferFrames,
    });
    return;
  }
  if (message.type === 'input' && networkRole === 'guest') {
    const buttons = messageButtons(message);
    if (message.player === 2 && String(message.id || '').startsWith('g-')) {
      const now = performance.now();
      const clientSentAt = Number(message.clientSentAt) || 0;
      const inputAckRtt = clientSentAt > 0 ? now - clientSentAt : 0;
      if (inputAckRtt > 0 && inputAckRtt <= 5000 && now - lastInputAckSampleAt >= 500) {
        lastInputAckSampleAt = now;
        recordNetworkRtt(inputAckRtt, 'input-ack');
      }
      if (message.hostLate) {
        const previousSafetyFrames = guestInputSafetyFrames;
        guestInputSafetyFrames = Math.min(GUEST_INPUT_MAX_SAFETY_FRAMES, guestInputSafetyFrames + 1);
        guestLastLateInputAt = now;
        if (guestInputSafetyFrames !== previousSafetyFrames) {
          logNetworkEvent('guest-input-safety-increased', {
            safetyFrames: guestInputSafetyFrames,
            rttMs: Math.round(networkRttMs),
          });
        }
      } else if (guestInputSafetyFrames > 0
        && guestLastLateInputAt
        && now - guestLastLateInputAt >= GUEST_INPUT_SAFETY_DECAY_MS) {
        guestInputSafetyFrames--;
        guestLastLateInputAt = now;
        logNetworkEvent('guest-input-safety-decreased', { safetyFrames: guestInputSafetyFrames });
      }
    }
    const scheduled = scheduleNetworkInput(message.player, buttons, message.frame, {
      id: message.id,
      order: message.order,
      deferRollback: true,
    });
    logNetworkEvent('input-received', {
      player: message.player,
      buttons,
      frame: message.frame,
      localFrame: gameFrame,
      targetFrame: scheduled.targetFrame,
      late: scheduled.late,
      rolledBack: scheduled.rolledBack,
      rollbackQueued: scheduled.rollbackQueued,
      corrected: scheduled.corrected,
      duplicate: scheduled.duplicate,
      id: scheduled.id,
    });
    if (scheduled.late && !scheduled.rolledBack && !scheduled.rollbackQueued) recoverFromLateNetworkInput({
      player: message.player,
      requestedFrame: scheduled.requestedFrame,
      localFrame: gameFrame,
      targetFrame: scheduled.targetFrame,
    });
    return;
  }
  if (message.type === 'clock' && networkRole === 'guest') {
    acceptHostClock(message.frame, 'clock');
    return;
  }
  if (message.type === 'rom-library' && networkRole === 'guest') {
    logNetworkEvent('library-rom-fetch-start', { name: message.name || 'NES 游戏' });
    setNetworkText('正在从游戏库快速加载游戏...');
    applyPeerLibraryRom(message).catch((error) => {
      console.warn(error);
      logNetworkEvent('library-rom-fetch-error', { message: error?.message || String(error) });
      setNetworkText('游戏库加载失败，正在改用中继传输...');
      sendPeerMessage({ type: 'rom-fallback-request' });
    });
    return;
  }
  if (message.type === 'rom-fallback-request' && networkRole === 'host') {
    logNetworkEvent('relay-rom-fallback-requested');
    sendCurrentRomToPeer({ forceBinary: true });
    return;
  }
  if (message.type === 'rom-request' && networkRole === 'host') {
    logNetworkEvent('rom-request-received', { alreadySent: peerRomSent, hasRom: Boolean(lastRomData) });
    if (!peerRomSent) sendCurrentRomToPeer();
    return;
  }
  if (message.type === 'rom' && networkRole === 'guest') {
    logNetworkEvent('rom-received', { name: message.name || 'NES 游戏', bytes: String(message.data || '').length });
    applyPeerRom(message.data, message.name || 'NES 游戏');
    peerRomSent = true;
    requestInitialStateSync();
    return;
  }
  if (message.type === 'state-gzip' && nes && networkRole === 'guest') {
    if (networkSyncId && message.syncId && message.syncId !== networkSyncId) return;
    try {
      logNetworkEvent('state-received', { syncId: message.syncId || 'none', base64Bytes: String(message.data || '').length, frame: message.frame });
      suppressNetworkBroadcast = true;
      restoreDeterministicState(nes, decodeNetworkState(message.data), { preserveLocalAudio: true });
      gameFrame = Number(message.frame) || 0;
      syncButtonSetsFromNes();
      resetRollbackState({ capture: true, preserveInputsFromFrame: gameFrame });
      networkSyncPaused = true;
      syncButtonVisuals();
      sendPeerMessage({ type: 'state-applied', syncId: message.syncId || networkSyncId });
      logNetworkEvent('state-applied-sent', { syncId: message.syncId || networkSyncId, frame: gameFrame });
      setNetworkText('进度已接收，正在同时开始...');
    } catch (error) {
      console.warn(error);
      logNetworkEvent('state-apply-error', { name: error?.name || 'Error', message: error?.message || String(error) });
      clearNetworkSync();
      setNetworkText('同步状态读取失败，请重新加入房间');
    } finally {
      suppressNetworkBroadcast = false;
    }
    return;
  }
  if (message.type === 'state' && nes && networkRole === 'guest') {
    try {
      suppressNetworkBroadcast = true;
      nes.fromJSON(message.state);
      gameFrame = Number(message.frame) || 0;
      syncButtonSetsFromNes();
      resetRollbackState({ capture: true, preserveInputsFromFrame: gameFrame });
      syncButtonVisuals();
    } catch (error) {
      console.warn(error);
    } finally {
      suppressNetworkBroadcast = false;
    }
  }
}

function configurePeerConnection(connection, { onOpen, onFailure } = {}) {
  logNetworkEvent('peer-connection-created', { peer: connection?.peer || 'unknown' });
  peerConnection = connection;
  const connectionTimeout = window.setTimeout(() => {
    if (!connection.open) setNetworkText('连接超时：请确认 1P 房间仍然开启，并检查双方网络');
  }, 12000);
  connection.__nesTimeoutId = connectionTimeout;
  connection.on('open', () => {
    clearTimeout(connectionTimeout);
    connection.__nesTimeoutId = 0;
    logNetworkEvent('peer-connection-open');
    if (onOpen?.() === false) {
      connection.__nesIgnore = true;
      connection.close();
      return;
    }
    markNetworkConnected();
  });
  connection.on('data', handleNetworkMessage);
  connection.on('close', () => {
    clearTimeout(connectionTimeout);
    connection.__nesTimeoutId = 0;
    logNetworkEvent('peer-connection-close', { ignored: Boolean(connection.__nesIgnore) });
    if (connection.__nesIgnore) return;
    teardownPeerConnection();
    onFailure?.();
  });
  connection.on('error', (error) => {
    clearTimeout(connectionTimeout);
    connection.__nesTimeoutId = 0;
    logNetworkEvent('peer-connection-error', { type: error?.type || '', message: error?.message || String(error) });
    if (connection.__nesIgnore) return;
    console.warn(error);
    teardownPeerConnection(getPeerErrorText('联机连接', error));
    onFailure?.();
  });
}

function generateRoomId() {
  try {
    if (typeof crypto?.randomUUID === 'function') {
      return crypto.randomUUID().replaceAll('-', '').slice(0, 24);
    }
    if (typeof crypto?.getRandomValues === 'function') {
      const bytes = new Uint8Array(12);
      crypto.getRandomValues(bytes);
      return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    }
  } catch (error) {
    console.warn(error);
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function getPeerErrorText(action, error) {
  const type = error?.type || '';
  if (type === 'unavailable-id') return '房间号已占用，请重新创建';
  if (type === 'peer-unavailable') return '房间不存在或已断开';
  if (type === 'network' || type === 'server-error' || type === 'socket-error') {
    return '联机服务器连接失败，请检查网络';
  }
  return `${action}失败，请重试`;
}

function createPeerRoom(nextRoomId) {
  if (typeof Peer !== 'function') {
    setNetworkText('联机库未加载');
    return;
  }
  nextRoomId ||= generateRoomId();
  teardownPeer();
  hybridRoom = false;
  roomId = nextRoomId;
  networkTransport = 'peer';
  localStorage.setItem(NETWORK_STORAGE_KEY, JSON.stringify({ role: 'host', roomId, transport: 'peer' }));
  networkRole = 'host';
  localPlayer = 1;
  remotePlayer = 2;
  peer = new Peer(roomId);
  setNetworkText('正在创建房间...');
  updateNetworkButtons();
  peer.on('open', () => {
    peerReady = true;
    refreshInviteLink();
    setNetworkText('房间已创建，等待加入');
    updateNetworkButtons();
    if (lastRomData) {
      sendCurrentRomToPeer();
    }
  });
  peer.on('connection', (connection) => {
    if (peerConnection?.open) {
      connection.close();
      setNetworkText('已有 2P 连接，如需更换请先断开联机');
      return;
    }
    configurePeerConnection(connection);
  });
  peer.on('error', (error) => {
    console.warn(error);
    teardownPeerConnection(getPeerErrorText('创建房间', error));
  });
}

function startHybridHostPeer(nextRoomId) {
  if (typeof Peer !== 'function') return;
  logNetworkEvent('hybrid-host-direct-register', { room: `${nextRoomId.slice(0, 4)}…${nextRoomId.slice(-4)}` });
  peer = new Peer(nextRoomId);
  peer.on('open', () => {
    logNetworkEvent('hybrid-host-direct-ready');
    peerReady = true;
    refreshInviteLink();
    updateNetworkButtons();
  });
  peer.on('connection', (connection) => {
    logNetworkEvent('hybrid-host-direct-incoming');
    if (peerConnected) {
      connection.close();
      return;
    }
    configurePeerConnection(connection, {
      onOpen: () => {
        if (peerConnected && networkTransport === 'relay') return false;
        networkTransport = 'peer';
        // Direct connection succeeded; keep the private relay from carrying
        // game traffic or accepting a second guest.
        closeRelaySocketSilently();
      },
    });
  });
  peer.on('error', (error) => {
    // The relay stays available, so a direct-host registration failure is not
    // fatal for a cross-network room.
    console.warn('直连候选不可用，将继续等待中继加入', error);
    logNetworkEvent('hybrid-host-direct-error', { type: error?.type || '', message: error?.message || String(error) });
  });
}

function joinPeerRoom(nextRoomId) {
  if (typeof Peer !== 'function') {
    setNetworkText('联机库未加载');
    return;
  }
  nextRoomId = String(nextRoomId || '').trim();
  if (!nextRoomId) return;
  teardownPeer();
  hybridRoom = false;
  roomId = nextRoomId;
  networkTransport = 'peer';
  localStorage.setItem(NETWORK_STORAGE_KEY, JSON.stringify({ role: 'guest', roomId, transport: 'peer' }));
  networkRole = 'guest';
  localPlayer = 2;
  remotePlayer = 1;
  peer = new Peer();
  setNetworkText('正在加入房间...');
  updateNetworkButtons();
  peer.on('open', () => {
    peerReady = true;
    const connection = peer.connect(roomId, { reliable: true });
    configurePeerConnection(connection);
  });
  peer.on('error', (error) => {
    console.warn(error);
    teardownPeerConnection(getPeerErrorText('加入房间', error));
  });
  peer.on('disconnected', () => {
    if (!peerConnected) setNetworkText('联机服务器已断开，请刷新页面重试');
  });
}

function normalizeRelayUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('公网中继尚未配置');
  const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
  if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.protocol === 'http:') url.protocol = 'ws:';
  const localHost = ['localhost', '127.0.0.1'].includes(url.hostname);
  if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && localHost)) {
    throw new Error('公网中继必须使用 HTTPS/WSS');
  }
  url.pathname = '/relay';
  url.search = '';
  url.hash = '';
  return url;
}

function getRelayTicketUrl() {
  const url = normalizeRelayUrl(RELAY_SERVER_URL);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = '/ticket';
  return url;
}

async function requestRelayTickets(nextRoomId, accessKey) {
  const ticketUrl = getRelayTicketUrl();
  logNetworkEvent('relay-ticket-request', {
    room: `${nextRoomId.slice(0, 4)}…${nextRoomId.slice(-4)}`,
    accessKey: Boolean(accessKey),
    host: ticketUrl.hostname,
  });
  let response;
  try {
    response = await fetch(ticketUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId: nextRoomId, accessKey }),
    });
  } catch (error) {
    logNetworkEvent('relay-ticket-fetch-error', {
      host: ticketUrl.hostname,
      name: error?.name || 'Error',
      message: error?.message || String(error),
    });
    throw new Error(`无法访问私人中继 ${ticketUrl.hostname}，请确认当前网络支持 IPv6，且家中 TCP 443 服务在线`);
  }
  const result = await response.json().catch(() => ({}));
  logNetworkEvent('relay-ticket-response', { status: response.status, ok: response.ok, hostToken: Boolean(result.hostToken), guestToken: Boolean(result.guestToken), error: result.error || '' });
  if (!response.ok || !result.hostToken || !result.guestToken) {
    throw new Error(result.error || '私人访问码验证失败');
  }
  return result;
}

function handleRelayControl(message) {
  if (!message.__relay) return false;
  logNetworkEvent('relay-control', { type: message.__relay, peerConnected: Boolean(message.peerConnected) });
  if (message.__relay === 'ready') {
    relayReady = true;
    relayTurnConfig = message.turn?.urls && message.turn?.username && message.turn?.credential
      ? {
          urls: Array.isArray(message.turn.urls) ? message.turn.urls : [message.turn.urls],
          username: String(message.turn.username),
          credential: String(message.turn.credential),
        }
      : null;
    logNetworkEvent('relay-turn-config', { configured: Boolean(relayTurnConfig), urls: relayTurnConfig?.urls?.length || 0 });
    refreshInviteLink();
    updateNetworkButtons();
    if (message.peerConnected) {
      relayReconnectAttempts = 0;
      networkPingTimeoutCount = 0;
      cancelPendingDirectConnection();
      markNetworkConnected();
    }
    else setNetworkText(networkRole === 'host' ? '跨网房间已创建，等待 2P 加入' : '已连接中继，等待 1P');
    return true;
  }
  if (message.__relay === 'peer-connected') {
    cancelPendingDirectConnection();
    markNetworkConnected();
    return true;
  }
  if (message.__relay === 'peer-left') {
    teardownPeerConnection(networkRole === 'host' ? '2P 已离开，等待重新加入' : '1P 已离开房间');
    return true;
  }
  return true;
}

async function handleRelayData(data) {
  networkPingTimeoutCount = 0;
  if (data instanceof Blob) {
    logNetworkEvent('relay-binary-blob', { bytes: data.size });
    data = await data.arrayBuffer();
  } else if (ArrayBuffer.isView(data)) {
    data = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  }
  if (data instanceof ArrayBuffer) {
    logNetworkEvent('relay-binary-received', {
      bytes: data.byteLength,
      pendingRom: Boolean(relayPendingRomName),
      pendingState: Boolean(relayPendingState),
    });
    if (relayPendingState) {
      const pendingState = relayPendingState;
      relayPendingState = null;
      logNetworkEvent('relay-state-received', {
        syncId: pendingState.syncId || 'none',
        wireBytes: data.byteLength,
        frame: pendingState.frame,
      });
      handleNetworkMessage({
        type: 'state-gzip',
        data: bytesToBase64(new Uint8Array(data)),
        syncId: pendingState.syncId,
        frame: pendingState.frame,
      });
      return;
    }
    if (!relayPendingRomName) {
      logNetworkEvent('relay-binary-unexpected', { bytes: data.byteLength });
      return;
    }
    const name = relayPendingRomName;
    const encoding = relayPendingRomEncoding;
    relayPendingRomName = '';
    relayPendingRomEncoding = '';
    const wireBytes = new Uint8Array(data);
    const romBytes = encoding === 'gzip' ? gunzipSync(wireBytes) : wireBytes;
    logNetworkEvent('relay-rom-decoded', { encoding: encoding || 'raw', wireBytes: wireBytes.length, romBytes: romBytes.length });
    handleNetworkMessage({ type: 'rom', name, data: arrayBufferToBinary(romBytes) });
    return;
  }
  if (typeof data !== 'string') return;
  try {
    const message = JSON.parse(data);
    if (handleRelayControl(message)) return;
    if (message.__nes === 'rom') {
      relayPendingRomName = message.name || 'NES 游戏';
      relayPendingRomEncoding = message.encoding || 'raw';
      logNetworkEvent('relay-rom-header', { name: relayPendingRomName, encoding: relayPendingRomEncoding });
      return;
    }
    if (message.__nes === 'state-gzip') {
      relayPendingState = {
        syncId: String(message.syncId || ''),
        frame: Number(message.frame) || 0,
      };
      logNetworkEvent('relay-state-header', relayPendingState);
      return;
    }
    handleNetworkMessage(message);
  } catch (error) {
    console.warn('无法读取公网中继消息', error);
    logNetworkEvent('relay-json-error', { name: error?.name || 'Error', message: error?.message || String(error), textBytes: data.length });
  }
}

function connectRelay(role, nextRoomId, ticket, guestTicket = '', { reconnect = false, attempt = 0 } = {}) {
  let socketUrl;
  try {
    socketUrl = normalizeRelayUrl(RELAY_SERVER_URL);
  } catch (error) {
    setNetworkText(error.message || '公网中继地址无效');
    return;
  }
  if (!ticket) {
    logNetworkEvent('relay-connect-rejected', { role, ticket: false });
    setNetworkText('邀请票据无效，请让 1P 重新创建跨网房间');
    return;
  }
  teardownPeer({ preserveRelaySession: reconnect });
  networkTransport = 'relay';
  networkPlayMode = getPreferredNetworkPlayMode();
  if (netModeSelect) netModeSelect.value = networkPlayMode;
  networkRole = role;
  roomId = String(nextRoomId || '').trim() || generateRoomId();
  relayGuestTicket = guestTicket;
  relaySessionTicket = ticket;
  localStorage.removeItem(NETWORK_STORAGE_KEY);
  localPlayer = role === 'host' ? 1 : 2;
  remotePlayer = role === 'host' ? 2 : 1;
  socketUrl.searchParams.set('room', roomId);
  socketUrl.searchParams.set('role', role);
  socketUrl.searchParams.set('ticket', ticket);
  logNetworkEvent(reconnect ? 'relay-reconnect-start' : 'relay-connect-start', {
    role,
    room: `${roomId.slice(0, 4)}…${roomId.slice(-4)}`,
    ticket: Boolean(ticket),
    host: socketUrl.host,
    ...(reconnect ? { attempt } : {}),
  });
  relaySocket = new WebSocket(socketUrl);
  relaySocket.binaryType = 'arraybuffer';
  setNetworkText(role === 'host' ? '正在创建跨网房间...' : '正在加入跨网房间...');
  refreshInviteLink();
  updateNetworkButtons();
  relaySocket.onmessage = (event) => {
    relayDataQueue = relayDataQueue
      .then(() => handleRelayData(event.data))
      .catch((error) => {
        console.warn(error);
        logNetworkEvent('relay-data-error', { name: error?.name || 'Error', message: error?.message || String(error) });
      });
  };
  relaySocket.onopen = () => logNetworkEvent('relay-websocket-open', { role });
  relaySocket.onerror = () => {
    logNetworkEvent('relay-websocket-error', { role, readyState: relaySocket?.readyState });
    setNetworkText('公网中继连接失败，请确认服务器在线');
  };
  relaySocket.onclose = (event) => {
    logNetworkEvent('relay-websocket-close', { role, code: event.code, reason: event.reason || '', clean: event.wasClean });
    relayReady = false;
    if (role === 'guest' && event.code !== 4008 && reconnectRelayGuest(`close-${event.code}`)) return;
    const reason = event.reason ? `：${event.reason}` : '';
    teardownPeerConnection(`公网中继已断开${reason}`);
  };
}

async function createRelayRoom(nextRoomId) {
  const accessKey = relayAccessKey?.value || '';
  if (!accessKey) {
    setNetworkText('请先输入私人联机访问码');
    relayAccessKey?.focus();
    return;
  }
  const nextRoom = nextRoomId || generateRoomId();
  setNetworkText('正在验证私人访问码...');
  try {
    const tickets = await requestRelayTickets(nextRoom, accessKey);
    if (relayAccessKey) relayAccessKey.value = '';
    connectRelay('host', nextRoom, tickets.hostToken, tickets.guestToken);
  } catch (error) {
    console.warn(error);
    setNetworkText(error.message || '无法创建私人跨网房间');
  }
}

async function createHybridRoom(nextRoomId) {
  const accessKey = relayAccessKey?.value || '';
  if (!accessKey) {
    setNetworkText('请先输入私人联机访问码');
    relayAccessKey?.focus();
    return;
  }
  const nextRoom = nextRoomId || generateRoomId();
  setNetworkText('正在创建跨网房间...');
  try {
    const tickets = await requestRelayTickets(nextRoom, accessKey);
    if (relayAccessKey) relayAccessKey.value = '';
    connectRelay('host', nextRoom, tickets.hostToken, tickets.guestToken);
    // Local games already have a dedicated WebRTC room button. Cross-network
    // invitations go straight to the private relay so guests do not spend five
    // seconds attempting a connection that commonly fails across carrier NAT.
    hybridRoom = false;
    refreshInviteLink();
    updateNetworkButtons();
  } catch (error) {
    console.warn(error);
    setNetworkText(error.message || '无法创建跨网房间');
  }
}

function joinHybridRoom(nextRoomId, ticket) {
  if (!ticket) {
    setNetworkText('跨网邀请链接不完整，请让 1P 重新复制链接');
    return;
  }
  // Previously copied hybrid links remain valid, but now skip the obsolete
  // direct-first wait and enter the private relay immediately.
  logNetworkEvent('hybrid-link-upgraded-to-relay', { ticket: Boolean(ticket) });
  hybridRoom = false;
  joinRelayRoom(nextRoomId, ticket);
}

function joinRelayRoom(nextRoomId, ticket) {
  if (nextRoomId) connectRelay('guest', nextRoomId, ticket);
}

function getRoomIdFromInput(value) {
  const input = String(value || '').trim();
  if (!input) return '';
  let candidate = input;
  try {
    const url = new URL(input, window.location.href);
    const roomFromUrl = url.searchParams.get('room');
    if (roomFromUrl) candidate = roomFromUrl;
    else if (input.includes('://') || input.includes('?')) return '';
  } catch (error) {
    return '';
  }
  candidate = candidate.trim();
  return /^[a-zA-Z0-9_-]{6,128}$/.test(candidate) ? candidate : '';
}

function getTransportFromInput(value) {
  try {
    const url = new URL(String(value || '').trim(), window.location.href);
    const transport = url.searchParams.get('transport');
    if (transport === 'hybrid') return 'hybrid';
    // A relay ticket is authoritative. This prevents a copied/truncated
    // transport parameter from silently falling back to direct WebRTC.
    return transport === 'relay' || url.searchParams.has('ticket') ? 'relay' : 'peer';
  } catch (error) {
    return 'peer';
  }
}

function getRelayTicketFromInput(value) {
  try {
    const url = new URL(String(value || '').trim(), window.location.href);
    return String(url.searchParams.get('ticket') || '').trim();
  } catch (error) {
    return '';
  }
}

function enterGuestRoom(nextRoomId, transport = 'peer', ticket = '') {
  const url = new URL(window.location.href);
  url.searchParams.set('room', nextRoomId);
  url.searchParams.delete('host');
  if (transport === 'relay' || transport === 'hybrid') {
    url.searchParams.set('transport', transport);
    if (ticket) url.searchParams.set('ticket', ticket);
  } else {
    url.searchParams.delete('transport');
    url.searchParams.delete('ticket');
  }
  window.history.replaceState({}, '', url);
  ensureDemoScreen();
  setStatus('正在连接 1P 房间...');
  if (transport === 'hybrid') joinHybridRoom(nextRoomId, ticket);
  else if (transport === 'relay') joinRelayRoom(nextRoomId, ticket);
  else joinPeerRoom(nextRoomId);
}

function restoreNetworkRoom() {
  const params = new URLSearchParams(window.location.search);
  const nextRoom = params.get('room');
  if (nextRoom) {
    const validRoom = getRoomIdFromInput(nextRoom);
    if (validRoom) enterGuestRoom(
      validRoom,
      params.get('transport') === 'hybrid' ? 'hybrid' : params.get('transport') === 'relay' ? 'relay' : 'peer',
      params.get('ticket') || '',
    );
    else {
      inviteStatusText.textContent = '房间链接无效，请让 1P 重新复制邀请链接';
      inviteStatusText.classList.remove('hidden');
    }
    return;
  }
  try {
    const saved = JSON.parse(localStorage.getItem(NETWORK_STORAGE_KEY) || 'null');
    if (saved?.role === 'host' && saved.roomId && saved.transport !== 'relay') {
      createPeerRoom(saved.roomId);
      return;
    }
  } catch (error) {
    console.warn(error);
  }
  updateNetworkButtons();
}

function updateFullscreenButton() {
  const active = document.body.classList.contains('landscape-mode');
  setButtonIcon(fullscreenBtn, active ? 'close' : 'expand', active ? '退出横屏' : '放大横屏');
  fullscreenBtn.setAttribute('aria-label', active ? '退出放大' : '放大横屏');
  fullscreenBtn.title = active ? '退出放大' : '放大横屏';
}

function finishFullscreenTransition() {
  applyControlOffsets();
  positionScaleTools();
  updateFullscreenButton();
}
const fullscreen = createFullscreenController({
  game,
  onStatus: setStatus,
  onTransition: finishFullscreenTransition,
});
const toggleGameFullscreen = () => fullscreen.toggle();

function showGame() {
  landing.classList.add('hidden');
  game.classList.remove('hidden');
}

function updateSoundButton() {
  if (isAuthoritativeStreamMode() && networkRole === 'guest' && !remoteStreamVideo.classList.contains('hidden')) {
    setButtonIcon(soundBtn, 'volume', remoteStreamAudio.muted || remoteStreamAudio.paused ? '开启声音' : '声音已开启');
    return;
  }
  if (!audio.getContext()) {
    setButtonIcon(soundBtn, 'volume', '开启声音');
  } else {
    setButtonIcon(soundBtn, 'volume', audio.isEnabled() ? '声音已开启' : '声音已关闭');
  }
}

function arrayBufferToBinary(buffer) {
  const bytes = new Uint8Array(buffer);
  let result = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    result += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return result;
}

function createNES() {
  return new NES({
    sampleRate: audio.getSampleRate(),
    onFrame(frameBuffer24) {
      if (suppressEmulatorOutput) return;
      for (let i = 0; i < FRAMEBUFFER_SIZE; i++) {
        frameBuffer32[i] = 0xff000000 | frameBuffer24[i];
      }
      ctx.putImageData(imageData, 0, 0);
    },
    onAudioSample(left, right) {
      if (suppressEmulatorOutput) return;
      pushAudioSample(left, right);
    },
  });
}

async function loadFile(file) {
  if (!file) return;
  if (!file.name.toLowerCase().endsWith('.nes')) {
    alert('请选择 .nes 文件');
    return;
  }
  initAudio();
  const buffer = await file.arrayBuffer();
  const romData = arrayBufferToBinary(buffer);
  lastRomData = romData;
  lastRomName = file.name;
  lastRomLibraryPath = '';
  startRom(romData, file.name);
}

function normalizeGameSearch(text) {
  return String(text || '').normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/\s+/g, ' ').trim();
}

function renderGameLibrary() {
  if (!gameLibrary) return;
  const query = normalizeGameSearch(librarySearchInput.value);
  const matches = gameLibrary.filter((game) => !query || game.search.includes(query));
  const visible = matches.slice(0, 120);
  libraryStatusText.textContent = matches.length > visible.length
    ? `找到 ${matches.length} 个游戏，显示前 ${visible.length} 个，请继续输入名称缩小范围`
    : `找到 ${matches.length} 个游戏`;
  libraryResults.replaceChildren();
  for (const game of visible) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'libraryGameBtn';
    button.textContent = game.name;
    button.addEventListener('click', () => loadLibraryGame(game));
    libraryResults.appendChild(button);
  }
}

async function ensureGameLibrary() {
  if (gameLibrary) return;
  libraryStatusText.textContent = '正在读取游戏目录...';
  const response = await fetch(`${import.meta.env.BASE_URL}games.json`, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`游戏目录加载失败：${response.status}`);
  const games = await response.json();
  gameLibrary = games.map((game) => ({ ...game, search: normalizeGameSearch(game.name) }));
}

async function openGameLibrary() {
  menuDialog.open && menuDialog.close();
  libraryDialog.showModal();
  try {
    await ensureGameLibrary();
    renderGameLibrary();
    librarySearchInput.focus();
  } catch (error) {
    console.error(error);
    libraryStatusText.textContent = '游戏目录加载失败，请刷新页面重试';
  }
}

async function loadLibraryGame(game) {
  libraryStatusText.textContent = `正在下载：${game.name}`;
  libraryResults.querySelectorAll('button').forEach((button) => { button.disabled = true; });
  try {
    initAudio();
    const response = await fetch(`${import.meta.env.BASE_URL}${game.path}`);
    if (!response.ok) throw new Error(`游戏下载失败：${response.status}`);
    const files = unzipSync(new Uint8Array(await response.arrayBuffer()));
    const romEntry = Object.entries(files).find(([name]) => name.toLowerCase().endsWith('.nes'));
    if (!romEntry) throw new Error('压缩包中没有找到 .nes 文件');
    const [, bytes] = romEntry;
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const displayName = `${game.name}.nes`;
    lastRomData = arrayBufferToBinary(buffer);
    lastRomName = displayName;
    lastRomLibraryPath = game.path;
    libraryDialog.close();
    startRom(lastRomData, displayName);
  } catch (error) {
    console.error(error);
    libraryStatusText.textContent = `加载失败：${error.message || '请重试'}`;
    libraryResults.querySelectorAll('button').forEach((button) => { button.disabled = false; });
  }
}

function startRom(romData, name = 'NES 游戏') {
  try {
    lastGameId = '';
    currentCloudFavorite = false;
    updateCloudFavoriteButton();
    stopLoop();
    releaseAllButtons();
    clearAudioBuffer();
    nes = createNES();
    nes.loadROM(romData);
    installRomCompatibility(nes, romData);
    gameFrame = 0;
    resetRollbackState({ capture: true });
    lastQueuedLocalButtons = new Set();
    hostClockFrame = null;
    hostClockReceivedAt = 0;
    networkTransportStalled = false;
    guestInputSafetyFrames = 0;
    guestLastLateInputAt = 0;
    lastInputAckSampleAt = 0;
    lastStateRequestAt = 0;
    for (const player of [1, 2]) {
      for (const buttonName of buttonStateByPlayer[player]) {
        const code = buttonMap[buttonName];
        if (code !== undefined) nes.buttonDown(player, code);
      }
    }
    showGame();
    running = true;
    paused = false;
    setButtonIcon(pauseBtn, 'pause', '暂停');
    setStatus(`正在玩：${name}`);
    if (networkRole === 'host' && peerConnected && lastRomData && !isAuthoritativeStreamMode()) {
      sendCurrentRomToPeer();
    }
    startLoop();
    updateCloudLibraryActivity({ incrementPlay: true }).catch(() => {});
  } catch (error) {
    console.error(error);
    alert('加载失败：请确认这是标准 iNES 格式的 .nes 文件。');
  }
}

function startLoop() {
  cancelAnimationFrame(rafId);
  lastTick = 0;
  frameRemainder = 0;
  lastNetworkClockAt = 0;
  rafId = requestAnimationFrame(loop);
}

function networkHeartbeatTick() {
  if (isAuthoritativeStreamMode() || !peerConnected || networkRole === 'offline') return;
  const now = performance.now();
  if (networkRole === 'host') {
    if (now - lastNetworkClockAt < NET_CLOCK_INTERVAL_MS) return;
    lastNetworkClockAt = now;
    // This heartbeat must not depend on requestAnimationFrame. Browser UI,
    // background transitions and a slow render frame may pause RAF even while
    // the WebSocket and game session are still healthy.
    sendPeerMessage({ type: 'clock', frame: gameFrame, running, paused });
    return;
  }
  if (networkRole !== 'guest') return;
  const pingTimeoutMs = hostClockFrame === null
    ? NETWORK_BOOTSTRAP_PING_TIMEOUT_MS
    : NETWORK_PING_TIMEOUT_MS;
  if (networkPingId && now - networkPingSentAt > pingTimeoutMs) {
    logNetworkEvent('network-ping-timeout');
    networkPingId = '';
    networkPingTimeoutCount++;
    // With no clock sample at all, the apparent connection is half-open: a
    // healthy relay always answers ping even while ROM/state data is loading.
    if ((hostClockFrame === null || networkTransportStalled || networkPingTimeoutCount >= 3)
      && reconnectRelayGuest('ping-timeout')) return;
  }
  const pingInterval = networkRttMs ? NETWORK_PING_IDLE_MS : NETWORK_PING_BOOTSTRAP_MS;
  if (networkPingId || now - lastNetworkPingAt < pingInterval) return;
  lastNetworkPingAt = now;
  networkPingSentAt = now;
  networkPingId = `${Math.round(now).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  sendPeerMessage({ type: 'ping', id: networkPingId });
}

window.setInterval(networkHeartbeatTick, NET_CLOCK_INTERVAL_MS);

function stopLoop() {
  running = false;
  cancelAnimationFrame(rafId);
  rafId = 0;
}

function loop(timestamp) {
  if (!running || !nes) return;

  if (!isAuthoritativeStreamMode()) flushPendingNetworkRollback();

  if (!isAuthoritativeStreamMode()
    && networkRole === 'guest'
    && peerConnected
    && hostClockFrame !== null
    && hostClockReceivedAt
    && timestamp - hostClockReceivedAt > HOST_CLOCK_STALE_MS) {
    if (!networkTransportStalled) {
      networkTransportStalled = true;
      logNetworkEvent('network-transport-stalled', {
        clockAgeMs: Math.round(timestamp - hostClockReceivedAt),
        hostFrame: hostClockFrame,
        localFrame: gameFrame,
      });
      setNetworkText('网络暂时中断，已冻结画面以防双方进度分叉...');
    }
    lastTick = timestamp;
    frameRemainder = 0;
    updatePerformanceHud(timestamp);
    rafId = requestAnimationFrame(loop);
    return;
  }

  if (networkSyncPaused) {
    lastTick = timestamp;
    frameRemainder = 0;
    rafId = requestAnimationFrame(loop);
    return;
  }

  if (!lastTick) lastTick = timestamp;
  const delta = Math.min(timestamp - lastTick, MAX_FRAME_DELTA_MS);
  let elapsed = delta + frameRemainder;
  let frames = 0;

  let guestFrameDifference = 0;
  if (networkRole === 'guest' && peerConnected && hostClockFrame !== null) {
    const estimatedHostFrame = getEstimatedHostFrame(timestamp);
    const bufferFrames = getRelayGuestBufferFrames();
    const frameDifference = estimatedHostFrame - bufferFrames - gameFrame;
    guestFrameDifference = frameDifference;
    // Keep the guest behind the host's timeline. Small drift is corrected
    // gently, while a large lead is paused quickly; otherwise a delayed relay
    // burst can leave the guest dozens of frames ahead and make every input
    // arrive late.
    const correction = frameDifference < -8
      ? -1
      : frameDifference > 8
        ? 0.35
        : Math.max(-0.12, Math.min(0.12, frameDifference * 0.025));
    elapsed = Math.max(0, elapsed + correction * FRAME_MS);
  }

  if (guestFrameDifference > GUEST_FAST_CATCHUP_THRESHOLD_FRAMES) {
    const catchUpFrames = Math.min(
      GUEST_FAST_CATCHUP_MAX_FRAMES,
      Math.max(1, Math.floor(guestFrameDifference - GUEST_FAST_CATCHUP_THRESHOLD_FRAMES / 2)),
    );
    suppressEmulatorOutput = true;
    try {
      for (let index = 0; index < catchUpFrames; index++) {
        captureRollbackSnapshot();
        applyScheduledNetworkInputs();
        nes.frame();
        gameFrame++;
      }
    } finally {
      suppressEmulatorOutput = false;
      clearAudioBuffer();
    }
    if (timestamp - lastGuestCatchUpLogAt >= 1000) {
      lastGuestCatchUpLogAt = timestamp;
      logNetworkEvent('guest-fast-catchup', {
        frames: catchUpFrames,
        frameDifference: Math.round(guestFrameDifference),
        bufferFrames: getRelayGuestBufferFrames(),
      });
    }
  }

  while (elapsed >= FRAME_MS && frames < 3) {
    if (!isAuthoritativeStreamMode()) {
      captureRollbackSnapshot();
      applyScheduledNetworkInputs();
    }
    nes.frame();
    gameFrame++;
    performanceHudFrames++;
    elapsed -= FRAME_MS;
    frames++;
  }

  frameRemainder = elapsed;
  updatePerformanceHud(timestamp);
  lastTick = timestamp;
  rafId = requestAnimationFrame(loop);
}

function ensureDemoScreen() {
  showGame();
  ctx.fillStyle = '#003070';
  ctx.fillRect(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT);
  ctx.fillStyle = '#ffffff';
  ctx.font = '16px sans-serif';
  ctx.fillText('NES 手柄测试', 74, 100);
  ctx.font = '12px sans-serif';
  ctx.fillText('请选择 .nes 文件开始游戏', 58, 130);
}

romInput.addEventListener('change', (e) => loadFile(e.target.files?.[0]));
romInput2.addEventListener('change', (e) => {
  menuDialog.close();
  loadFile(e.target.files?.[0]);
});
libraryBtn.addEventListener('click', openGameLibrary);
menuLibraryBtn.addEventListener('click', openGameLibrary);
joinRoomForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const nextRoom = getRoomIdFromInput(joinRoomInput.value);
  if (!nextRoom) {
    inviteStatusText.textContent = '链接无效：请粘贴包含 room 参数的完整邀请链接';
    inviteStatusText.classList.remove('hidden');
    joinRoomInput.focus();
    return;
  }
  const transport = getTransportFromInput(joinRoomInput.value);
  const ticket = getRelayTicketFromInput(joinRoomInput.value);
  if ((transport === 'relay' || transport === 'hybrid') && !ticket) {
    inviteStatusText.textContent = '跨网邀请链接不完整：请让 1P 重新复制完整链接';
    inviteStatusText.classList.remove('hidden');
    return;
  }
  enterGuestRoom(
    nextRoom,
    transport,
    ticket,
  );
});
librarySearchInput.addEventListener('input', renderGameLibrary);
closeLibraryBtn.addEventListener('click', () => libraryDialog.close());

demoBtn.addEventListener('click', () => {
  initAudio();
  ensureDemoScreen();
  setStatus('手柄测试模式');
});

pauseBtn.addEventListener('click', () => {
  if (!nes) return;
  if (paused) {
    running = true;
    paused = false;
    setButtonIcon(pauseBtn, 'pause', '暂停');
    setStatus(lastRomName ? `正在玩：${lastRomName}` : '继续');
    startLoop();
  } else {
    stopLoop();
    paused = true;
    setButtonIcon(pauseBtn, 'play', '继续');
    setStatus('已暂停');
  }
});

soundBtn.addEventListener('click', () => {
  if (isAuthoritativeStreamMode() && networkRole === 'guest' && !remoteStreamVideo.classList.contains('hidden')) {
    remoteStreamAudio.muted = !remoteStreamAudio.muted;
    if (!remoteStreamAudio.muted) remoteStreamAudio.play().catch(() => {});
    updateSoundButton();
    return;
  }
  audio.toggle();
});

settingsBtn.addEventListener('click', () => {
  releaseAllButtons({ broadcast: true });
  dialogController.openSettings();
});
closeSettingsBtn.addEventListener('click', dialogController.closeSettings);
layoutEditBtn.addEventListener('click', () => {
  const nextMode = !controlLayout.isEditing();
  setLayoutEditMode(nextMode);
  if (nextMode) {
    dialogController.closeSettings();
  }
});
resetLayoutBtn.addEventListener('click', resetControlLayout);
layoutPresetButtons.forEach((button) => {
  button.addEventListener('click', () => applyLayoutScalePreset(button.dataset.layoutScale));
});
controlOpacityInput.addEventListener('input', () => applyControlOpacity(controlOpacityInput.value));
menuBtn.addEventListener('click', () => {
  releaseAllButtons({ broadcast: true });
  menuDialog.showModal();
});
closeMenuBtn.addEventListener('click', () => menuDialog.close());
resumeBtn.addEventListener('click', () => menuDialog.close());
resetBtn.addEventListener('click', () => {
  menuDialog.close();
  if (lastRomData) startRom(lastRomData, lastRomName);
});
saveStateBtn.addEventListener('click', saveGameState);
loadStateBtn.addEventListener('click', loadGameState);
cloudSaveBtn.addEventListener('click', () => {
  uploadCloudSave().then(() => menuDialog.close()).catch((error) => {
    cloudStatusText.textContent = error.message || '云存档上传失败';
    if (!getCloudAccessKey()) cloudAccessKey.focus();
  });
});
cloudManageBtn.addEventListener('click', () => {
  openCloudManager().catch((error) => {
    cloudStatusText.textContent = error.message || '无法读取云存档';
    cloudDialog.close();
    if (!getCloudAccessKey()) cloudAccessKey.focus();
  });
});
cloudFavoriteBtn.addEventListener('click', () => {
  if (!nes) {
    cloudStatusText.textContent = '请先加载游戏';
    return;
  }
  const nextFavorite = !currentCloudFavorite;
  updateCloudLibraryActivity({ favorite: nextFavorite }).then(() => {
    cloudStatusText.textContent = nextFavorite ? '已收藏当前游戏' : '已取消收藏';
  }).catch((error) => {
    cloudStatusText.textContent = error.message || '收藏状态同步失败';
    if (!getCloudAccessKey()) cloudAccessKey.focus();
  });
});
closeCloudBtn.addEventListener('click', () => cloudDialog.close());
netHostBtn.addEventListener('click', () => {
  createPeerRoom();
  refreshInviteLink();
});
relayHostBtn.addEventListener('click', () => createHybridRoom());
netCopyBtn.addEventListener('click', async () => {
  const url = getInviteUrl();
  if (!url) return;
  try {
    await navigator.clipboard.writeText(url);
    setNetworkText('邀请链接已复制');
  } catch (error) {
    console.warn(error);
    netLinkInput?.select();
    document.execCommand('copy');
    setNetworkText('邀请链接已复制');
  }
});
netLogBtn.addEventListener('click', async () => {
  logNetworkEvent('diagnostic-log-copy');
  const log = getNetworkDiagnosticLog();
  try {
    await navigator.clipboard.writeText(log);
    setNetworkText('联机诊断日志已复制');
  } catch (error) {
    console.warn(error);
    const textarea = document.createElement('textarea');
    textarea.value = log;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
    setNetworkText('联机诊断日志已复制');
  }
});
netLeaveBtn.addEventListener('click', () => {
  teardownPeer();
  hybridRoom = false;
  roomId = '';
  networkRole = 'offline';
  networkTransport = 'peer';
  localStorage.removeItem(NETWORK_STORAGE_KEY);
  setNetworkText('未联机');
  refreshInviteLink();
  updateNetworkButtons();
});
fullscreenBtn.addEventListener('click', (event) => {
  event.preventDefault();
  event.stopPropagation();
  toggleGameFullscreen();
});
document.addEventListener('gesturestart', (event) => {
  if (game.contains(event.target)) event.preventDefault();
}, { passive: false });
game.addEventListener('pointerdown', unlockRemoteStreamAudio, { passive: true });
document.addEventListener('dblclick', (event) => {
  if (game.contains(event.target)) event.preventDefault();
}, { passive: false });

let lastGameTouchEnd = 0;
document.addEventListener('touchend', (event) => {
  if (!game.contains(event.target)) return;
  const now = Date.now();
  if (now - lastGameTouchEnd < 360) event.preventDefault();
  lastGameTouchEnd = now;
}, { passive: false });

const buttonMap = {
  A: Controller.BUTTON_A,
  B: Controller.BUTTON_B,
  SELECT: Controller.BUTTON_SELECT,
  START: Controller.BUTTON_START,
  UP: Controller.BUTTON_UP,
  DOWN: Controller.BUTTON_DOWN,
  LEFT: Controller.BUTTON_LEFT,
  RIGHT: Controller.BUTTON_RIGHT,
  TURBO_A: Controller.BUTTON_TURBO_A,
  TURBO_B: Controller.BUTTON_TURBO_B,
};

function syncLocalPlayerState() {
  const next = getLocalMergedButtons();
  syncButtonVisuals();
  if (suppressNetworkBroadcast) {
    setPlayerButtons(localPlayer, next, { broadcast: false });
    return;
  }
  if (networkRole === 'offline') {
    setPlayerButtons(localPlayer, next, { broadcast: false });
    return;
  }
  const unchanged = next.size === lastQueuedLocalButtons.size && Array.from(next).every((button) => lastQueuedLocalButtons.has(button));
  if (unchanged) return;
  lastQueuedLocalButtons = new Set(next);
  sendPeerButtons(localPlayer, next);
}

function releaseAllButtons({ broadcast = false } = {}) {
  if (broadcast && networkRole !== 'offline') {
    sendPeerButtons(localPlayer, new Set());
  }
  suppressNetworkBroadcast = true;
  controllerInput?.clear({ notifyChange: false });
  setPlayerButtons(1, new Set(), { broadcast: false });
  setPlayerButtons(2, new Set(), { broadcast: false });
  suppressNetworkBroadcast = false;
  syncButtonVisuals();
}

controllerInput = createInputController({
  actionZone,
  dpad,
  layout: controlLayout,
  onChange: syncLocalPlayerState,
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (running) {
      stopLoop();
      paused = true;
      setButtonIcon(pauseBtn, 'play', '继续');
    }
    clearAudioBuffer();
    releaseAllButtons({ broadcast: true });
  }
});

document.addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('blur', () => {
  clearAudioBuffer();
  releaseAllButtons({ broadcast: true });
});
window.addEventListener('pagehide', () => releaseAllButtons({ broadcast: true }));
try {
  cloudAccessKey.value = localStorage.getItem(CLOUD_ACCESS_KEY_STORAGE_KEY) || '';
  cloudRememberKey.checked = Boolean(cloudAccessKey.value);
  cloudAutoBackup.checked = localStorage.getItem(CLOUD_AUTO_BACKUP_STORAGE_KEY) !== '0';
} catch (error) {
  cloudRememberKey.checked = false;
}
cloudAccessKey.addEventListener('change', () => {
  try {
    if (cloudRememberKey.checked && getCloudAccessKey()) localStorage.setItem(CLOUD_ACCESS_KEY_STORAGE_KEY, getCloudAccessKey());
    else localStorage.removeItem(CLOUD_ACCESS_KEY_STORAGE_KEY);
  } catch (error) { /* ignore private mode */ }
  cloudStatusText.textContent = getCloudAccessKey() ? '访问码已设置，可上传或管理云存档' : '尚未连接私人云';
});
cloudRememberKey.addEventListener('change', () => {
  try {
    if (cloudRememberKey.checked && getCloudAccessKey()) localStorage.setItem(CLOUD_ACCESS_KEY_STORAGE_KEY, getCloudAccessKey());
    else localStorage.removeItem(CLOUD_ACCESS_KEY_STORAGE_KEY);
  } catch (error) { /* ignore private mode */ }
});
cloudAutoBackup.addEventListener('change', () => {
  try { localStorage.setItem(CLOUD_AUTO_BACKUP_STORAGE_KEY, cloudAutoBackup.checked ? '1' : '0'); } catch (error) { /* ignore private mode */ }
});
if (getCloudAccessKey()) cloudStatusText.textContent = '访问码已保存，可使用私人云存档';
updateCloudFavoriteButton();
clearInterval(cloudPlayTimer);
cloudPlayTimer = window.setInterval(() => {
  if (running && !paused && nes && getCloudAccessKey()) {
    updateCloudLibraryActivity({ addPlaySeconds: 300 }).catch(() => {});
  }
}, 300_000);
if (netModeSelect) {
  try {
    netModeSelect.value = localStorage.getItem(NET_MODE_STORAGE_KEY) === 'stream' ? 'stream' : 'rollback';
  } catch (error) {
    netModeSelect.value = 'rollback';
  }
  networkPlayMode = netModeSelect.value;
  netModeSelect.addEventListener('change', () => {
    const value = netModeSelect.value === 'stream' ? 'stream' : 'rollback';
    try { localStorage.setItem(NET_MODE_STORAGE_KEY, value); } catch (error) { /* private mode */ }
    if (networkRole === 'offline') networkPlayMode = value;
  });
}
updateSoundButton();
updateFullscreenButton();
logNetworkEvent('app-start', { relayConfigured: Boolean(RELAY_SERVER_URL), online: navigator.onLine });
restoreNetworkRoom();

registerServiceWorker();
