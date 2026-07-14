import './style.css';
import { NES, Controller } from 'jsnes';
import Peer from 'peerjs';
import { gzipSync, gunzipSync, strFromU8, strToU8, unzipSync } from 'fflate';

const SCREEN_WIDTH = 256;
const SCREEN_HEIGHT = 240;
const FRAMEBUFFER_SIZE = SCREEN_WIDTH * SCREEN_HEIGHT;
const FRAME_MS = 1000 / 60;
const MAX_FRAME_DELTA_MS = FRAME_MS * 3;
const MAX_PEER_QUEUE_SIZE = 32;
// Keep only one frame of buffering. Four frames made the guest visibly trail
// the host even on a LAN; the relay/PeerJS transport already queues packets.
const NET_INPUT_DELAY_FRAMES = 1;
const NET_CLOCK_INTERVAL_MS = 100;
const NETWORK_SYNC_TIMEOUT_MS = 30000;
// Relay guests intentionally run a little behind the host so authoritative
// inputs arrive before the guest reaches their frame. Keep this buffer small:
// Tailscale can begin on DERP and switch to a much faster direct route later.
const DEFAULT_NETWORK_RTT_MS = 250;
const RELAY_JITTER_BUFFER_MS = 80;
const RELAY_MIN_GUEST_BUFFER_FRAMES = 5;
const RELAY_MAX_GUEST_BUFFER_FRAMES = 45;
const GUEST_FAST_CATCHUP_THRESHOLD_FRAMES = 12;
const GUEST_FAST_CATCHUP_MAX_FRAMES = 6;
const LATE_INPUT_RESYNC_COOLDOWN_MS = 5000;

const landing = document.querySelector('#landing');
const game = document.querySelector('#game');
const canvas = document.querySelector('#screen');
const ctx = canvas.getContext('2d');
const imageData = ctx.getImageData(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT);
const frameBuffer32 = new Uint32Array(imageData.data.buffer);

const romInput = document.querySelector('#romInput');
const romInput2 = document.querySelector('#romInput2');
const demoBtn = document.querySelector('#demoBtn');
const libraryBtn = document.querySelector('#libraryBtn');
const menuLibraryBtn = document.querySelector('#menuLibraryBtn');
const libraryDialog = document.querySelector('#libraryDialog');
const librarySearchInput = document.querySelector('#librarySearchInput');
const libraryStatusText = document.querySelector('#libraryStatusText');
const libraryResults = document.querySelector('#libraryResults');
const closeLibraryBtn = document.querySelector('#closeLibraryBtn');
const statusText = document.querySelector('#statusText');
const inviteStatusText = document.querySelector('#inviteStatusText');
const joinRoomForm = document.querySelector('#joinRoomForm');
const joinRoomInput = document.querySelector('#joinRoomInput');
const pauseBtn = document.querySelector('#pauseBtn');
const soundBtn = document.querySelector('#soundBtn');
const settingsBtn = document.querySelector('#settingsBtn');
const menuBtn = document.querySelector('#menuBtn');
const menuDialog = document.querySelector('#menuDialog');
const settingsDialog = document.querySelector('#settingsDialog');
const closeMenuBtn = document.querySelector('#closeMenuBtn');
const resumeBtn = document.querySelector('#resumeBtn');
const resetBtn = document.querySelector('#resetBtn');
const saveStateBtn = document.querySelector('#saveStateBtn');
const loadStateBtn = document.querySelector('#loadStateBtn');
const netHostBtn = document.querySelector('#netHostBtn');
const relayHostBtn = document.querySelector('#relayHostBtn');
const relayAccessRow = document.querySelector('#relayAccessRow');
const relayAccessKey = document.querySelector('#relayAccessKey');
const netCopyBtn = document.querySelector('#netCopyBtn');
const netLeaveBtn = document.querySelector('#netLeaveBtn');
const netLinkInput = document.querySelector('#netLinkInput');
const netStatusText = document.querySelector('#netStatusText');
const netLogBtn = document.querySelector('#netLogBtn');
const netLogOutput = document.querySelector('#netLogOutput');
const layoutEditBtn = document.querySelector('#layoutEditBtn');
const resetLayoutBtn = document.querySelector('#resetLayoutBtn');
const closeSettingsBtn = document.querySelector('#closeSettingsBtn');
const settingsModeText = document.querySelector('#settingsModeText');
const layoutPresetButtons = document.querySelectorAll('[data-layout-scale]');
const controlOpacityInput = document.querySelector('#controlOpacityInput');
const controlOpacityValue = document.querySelector('#controlOpacityValue');
const dpad = document.querySelector('#dpad');
const actionZone = document.querySelector('.rightZone');
const fullscreenBtn = document.querySelector('#fullscreenBtn');

const isStandalone = window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
if (!isStandalone) document.body.classList.add('browser-mode');

let nes = null;
let lastRomData = null;
let lastRomName = '';
let lastRomLibraryPath = '';
let running = false;
let paused = false;
let rafId = 0;
let lastTick = 0;
let frameRemainder = 0;
let dpadPointerId = null;
let actionPointerId = null;
let layoutEditMode = false;
let fallbackFullscreen = false;
let controlOffsets = {};
let selectedControlKey = null;
let selectedControlElement = null;
let scaleTools = null;
const buttonStateByPlayer = { 1: new Set(), 2: new Set() };
const localSourceStates = { keyboard: new Set(), dpad: new Set(), action: new Set() };
let localPlayer = 1;
let remotePlayer = 2;
let networkRole = 'offline';
let networkTransport = 'peer';
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
let lastQueuedLocalButtons = new Set();
let lastNetworkClockAt = 0;
let hostClockFrame = null;
let hostClockReceivedAt = 0;
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
let networkPingId = '';
let networkPingSentAt = 0;
let lastNetworkPingAt = 0;
let lastGuestCatchUpLogAt = 0;
let lastLateInputResyncAt = 0;
const networkLogEntries = [];
const networkLogStartedAt = performance.now();
const NETWORK_STORAGE_KEY = 'pwa-nes-network-room-v1';
const RELAY_URL_STORAGE_KEY = 'pwa-nes-relay-url-v1';
function getRuntimeRelayUrl() {
  try {
    const queryValue = new URLSearchParams(window.location.search).get('relay');
    if (queryValue?.trim()) return queryValue.trim();
    return localStorage.getItem(RELAY_URL_STORAGE_KEY)?.trim() || '';
  } catch (error) {
    return '';
  }
}
const RELAY_SERVER_URL = getRuntimeRelayUrl() || String(import.meta.env.VITE_RELAY_URL || '').trim();

let audioCtx = null;
let scriptNode = null;
let audioEnabled = false;
let audioRead = 0;
let audioWrite = 0;
let audioCount = 0;
let audioL = null;
let audioR = null;

const CONTROL_LAYOUT_STORAGE_KEY = 'pwa-nes-control-layout-v2';
const LEGACY_CONTROL_LAYOUT_STORAGE_KEY = 'pwa-nes-control-layout-v1';
const CONTROL_OPACITY_STORAGE_KEY = 'pwa-nes-control-opacity-v1';
const SAVE_STATE_STORAGE_KEY = 'pwa-nes-save-state-v1';

function setStatus(text) {
  statusText.textContent = text;
}

function getAdjustableControls() {
  return [dpad, ...document.querySelectorAll('[data-btn]')];
}

function getLayoutProfile() {
  return document.body.classList.contains('landscape-mode') || window.matchMedia('(orientation: landscape)').matches
    ? 'landscape'
    : 'portrait';
}

function getBaseControlKey(element) {
  if (element === dpad) return 'dpad';
  return `button-${element.dataset.btn}`;
}

function getControlKey(element) {
  return `${getLayoutProfile()}:${getBaseControlKey(element)}`;
}

function normalizeControlOffset(value = {}) {
  const numberOr = (candidate, fallback) => Number.isFinite(Number(candidate)) ? Number(candidate) : fallback;
  return {
    x: Math.max(-900, Math.min(900, numberOr(value.x, 0))),
    y: Math.max(-900, Math.min(900, numberOr(value.y, 0))),
    scale: Math.max(0.65, Math.min(1.8, numberOr(value.scale, 1))),
  };
}

function readControlOffsets() {
  try {
    const saved = localStorage.getItem(CONTROL_LAYOUT_STORAGE_KEY);
    const parsed = JSON.parse(saved || '{}');
    if (parsed && typeof parsed === 'object') {
      controlOffsets = Object.fromEntries(
        Object.entries(parsed).map(([key, value]) => [key, normalizeControlOffset(value)])
      );
    }
    if (!saved) {
      const legacy = JSON.parse(localStorage.getItem(LEGACY_CONTROL_LAYOUT_STORAGE_KEY) || '{}');
      if (legacy && typeof legacy === 'object') {
        for (const [key, value] of Object.entries(legacy)) {
          controlOffsets[`portrait:${key}`] = normalizeControlOffset(value);
          controlOffsets[`landscape:${key}`] = normalizeControlOffset(value);
        }
        saveControlOffsets();
      }
    }
  } catch (error) {
    controlOffsets = {};
  }
}

function applyControlOpacity(value) {
  const percent = Math.max(45, Math.min(100, Number(value) || 90));
  document.documentElement.style.setProperty('--control-opacity', String(percent / 100));
  controlOpacityInput.value = String(percent);
  controlOpacityValue.textContent = `${percent}%`;
  try {
    localStorage.setItem(CONTROL_OPACITY_STORAGE_KEY, String(percent));
  } catch (error) {
    console.warn(error);
  }
}

function saveControlOffsets() {
  try {
    localStorage.setItem(CONTROL_LAYOUT_STORAGE_KEY, JSON.stringify(controlOffsets));
  } catch (error) {
    console.warn(error);
  }
}

function applyControlOffsets() {
  const scales = [];
  for (const element of getAdjustableControls()) {
    const key = getControlKey(element);
    const offset = normalizeControlOffset(controlOffsets[key]);
    controlOffsets[key] = offset;
    element.style.setProperty('--drag-x', `${offset.x}px`);
    element.style.setProperty('--drag-y', `${offset.y}px`);
    element.style.setProperty('--control-scale', `${offset.scale}`);
    element.classList.toggle('selected-control', key === selectedControlKey);
    scales.push(offset.scale);
  }
  const commonScale = scales.length && scales.every((scale) => scale === scales[0]) ? scales[0] : null;
  layoutPresetButtons.forEach((button) => {
    button.classList.toggle('active', commonScale !== null && Number(button.dataset.layoutScale) === commonScale);
  });
}

function selectControl(element) {
  selectedControlKey = getControlKey(element);
  selectedControlElement = element;
  applyControlOffsets();
  positionScaleTools();
}

function scaleSelectedControl(delta) {
  if (!selectedControlKey) return;
  const offset = controlOffsets[selectedControlKey] || { x: 0, y: 0, scale: 1 };
  const nextScale = Math.min(1.8, Math.max(0.65, (Number(offset.scale) || 1) + delta));
  controlOffsets[selectedControlKey] = { ...offset, scale: Number(nextScale.toFixed(2)) };
  applyControlOffsets();
  saveControlOffsets();
  positionScaleTools();
}

function ensureScaleTools() {
  if (scaleTools) return scaleTools;
  scaleTools = document.createElement('div');
  scaleTools.className = 'scaleTools hidden';
  scaleTools.innerHTML = '<button type="button" data-scale="-">−</button><button type="button" data-scale="+">+</button>';
  document.body.appendChild(scaleTools);
  scaleTools.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  scaleTools.addEventListener('click', (event) => {
    const button = event.target.closest('[data-scale]');
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    scaleSelectedControl(button.dataset.scale === '+' ? 0.1 : -0.1);
  });
  return scaleTools;
}

function hideScaleTools() {
  scaleTools?.classList.add('hidden');
}

function positionScaleTools() {
  if (!layoutEditMode || !selectedControlElement) {
    hideScaleTools();
    return;
  }
  const tools = ensureScaleTools();
  const rect = selectedControlElement.getBoundingClientRect();
  if (isRotatedLandscapeFallback()) {
    tools.style.left = `${Math.min(window.innerWidth - 44, rect.right + 10)}px`;
    tools.style.top = `${Math.max(48, Math.min(window.innerHeight - 48, rect.top + rect.height / 2))}px`;
    tools.classList.add('rotated');
  } else {
    tools.style.left = `${rect.left + rect.width / 2}px`;
    tools.style.top = `${Math.max(8, rect.top - 44)}px`;
    tools.classList.remove('rotated');
  }
  tools.classList.remove('hidden');
}

function setLayoutEditMode(enabled) {
  layoutEditMode = enabled;
  document.body.classList.toggle('layout-editing', enabled);
  layoutEditBtn.textContent = enabled ? '完成调整' : '调整按键位置';
  settingsModeText.textContent = enabled
    ? `正在调整${getLayoutProfile() === 'landscape' ? '横屏' : '竖屏'}布局：拖动按键移动，选中后用 −/+ 或双指缩放，点空白保存。`
    : '横屏与竖屏布局会分别保存，不会互相影响。';
  if (!enabled) {
    selectedControlKey = null;
    selectedControlElement = null;
    hideScaleTools();
  }
  applyControlOffsets();
  releaseAllButtons();
}

function resetControlLayout() {
  controlOffsets = {};
  saveControlOffsets();
  applyControlOffsets();
  layoutPresetButtons.forEach((button) => button.classList.toggle('active', button.dataset.layoutScale === '1'));
}

function applyLayoutScalePreset(scale) {
  const nextScale = Math.min(1.8, Math.max(0.65, Number(scale) || 1));
  for (const element of getAdjustableControls()) {
    const key = getControlKey(element);
    const offset = controlOffsets[key] || { x: 0, y: 0 };
    controlOffsets[key] = { ...offset, scale: nextScale };
  }
  saveControlOffsets();
  applyControlOffsets();
  layoutPresetButtons.forEach((button) => {
    button.classList.toggle('active', Number(button.dataset.layoutScale) === nextScale);
  });
}

function getSaveStateKey() {
  return `${SAVE_STATE_STORAGE_KEY}:${lastRomName || 'default'}`;
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
    pauseBtn.textContent = '暂停';
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
  return [
    'PWA NES 联机诊断日志',
    `time=${new Date().toISOString()}`,
    `page=${location.origin}${location.pathname}`,
    `online=${navigator.onLine}`,
    `role=${networkRole}`,
    `transport=${networkTransport}`,
    `hybrid=${hybridRoom}`,
    `room=${roomHint}`,
    `peerReady=${peerReady}`,
    `peerConnected=${peerConnected}`,
    `relayReady=${relayReady}`,
    `relaySocket=${relaySocket?.readyState ?? 'none'}`,
    `syncPaused=${networkSyncPaused}`,
    `syncPending=${stateRequestInFlight || Boolean(networkSyncId)}`,
    `rttMs=${Math.round(networkRttMs)}`,
    `guestBufferFrames=${getRelayGuestBufferFrames()}`,
    `gameFrame=${gameFrame}`,
    `hostFrame=${hostClockFrame ?? 'none'}`,
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
    if (relayGuestTicket) url.searchParams.set('ticket', relayGuestTicket);
  } else {
    url.searchParams.delete('transport');
    url.searchParams.delete('ticket');
  }
  return url.toString();
}

function refreshInviteLink() {
  if (netLinkInput) netLinkInput.value = getInviteUrl();
}

function getLocalMergedButtons() {
  return new Set([...localSourceStates.keyboard, ...localSourceStates.dpad, ...localSourceStates.action]);
}

function syncButtonVisuals() {
  const activeButtons = new Set([...buttonStateByPlayer[1], ...buttonStateByPlayer[2]]);
  document.querySelectorAll('[data-btn]').forEach((element) => {
    const active = element.dataset.btn === 'AB'
      ? activeButtons.has('A') && activeButtons.has('B')
      : activeButtons.has(element.dataset.btn);
    element.classList.toggle('active', active);
  });
  document.querySelectorAll('.padVisual').forEach((element) => {
    element.classList.remove('active');
  });
  let dpadActive = false;
  for (const name of ['UP', 'DOWN', 'LEFT', 'RIGHT']) {
    if (activeButtons.has(name)) {
      dpadActive = true;
      document.querySelector(`.padVisual.${name.toLowerCase()}`)?.classList.add('active');
    }
  }
  dpad.classList.toggle('active', dpadActive);
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
  localSourceStates.keyboard.clear();
  localSourceStates.dpad.clear();
  localSourceStates.action.clear();
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
  const state = JSON.parse(strFromU8(gunzipSync(base64ToBytes(value))));
  if (!nes?.ppu || !state?.ppu) return state;
  const mirroring = Number(state.ppu.currentMirroring);
  nes.ppu.currentMirroring = -1;
  nes.ppu.setMirroring(mirroring);
  state.ppu.vramMirrorTable = nes.ppu.vramMirrorTable;
  state.ppu.buffer = nes.ppu.buffer;
  state.ppu.bgbuffer = nes.ppu.bgbuffer;
  state.ppu.pixrendered = nes.ppu.pixrendered;
  return state;
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
  if (networkRole === 'host') {
    const delayFrames = getNetworkInputDelayFrames();
    const frame = gameFrame + delayFrames;
    logNetworkEvent('input-send', { role: 'host', player, buttons: nextButtons, frame, delayFrames });
    scheduleNetworkInput(player, nextButtons, frame);
    sendPeerMessage({ type: 'input', player, buttons: nextButtons, frame });
    return;
  }
  logNetworkEvent('input-send', { role: 'guest', player, buttons: nextButtons });
  sendPeerMessage({ type: 'input-request', player, buttons: nextButtons });
}

function getNetworkInputDelayFrames() {
  // The guest carries the latency buffer. Delaying host input by half the RTT
  // made local controls take one or two seconds on overseas relay routes.
  return NET_INPUT_DELAY_FRAMES;
}

function recordNetworkRtt(sampleMs, source = 'ping') {
  const parsedSample = Number(sampleMs);
  if (!Number.isFinite(parsedSample) || parsedSample <= 0) return networkRttMs;
  const sample = Math.max(1, Math.min(5000, parsedSample));
  if (!networkRttMs) {
    networkRttMs = sample;
  } else {
    // A route commonly starts on DERP and then becomes direct. Fall quickly
    // when that happens, but increase slowly for isolated mobile-network
    // spikes so one bad packet cannot add a permanent second of buffering.
    const weight = sample < networkRttMs ? 0.65 : 0.2;
    networkRttMs += (sample - networkRttMs) * weight;
  }
  logNetworkEvent('network-rtt', {
    source,
    sampleMs: Math.round(sample),
    smoothedMs: Math.round(networkRttMs),
    bufferFrames: getRelayGuestBufferFrames(networkRttMs),
  });
  return networkRttMs;
}

function getRelayGuestBufferFrames(rttMs = networkRttMs) {
  if (networkTransport !== 'relay') return 1;
  const rtt = rttMs > 0 ? rttMs : DEFAULT_NETWORK_RTT_MS;
  return Math.max(
    RELAY_MIN_GUEST_BUFFER_FRAMES,
    Math.min(RELAY_MAX_GUEST_BUFFER_FRAMES, Math.ceil((rtt / 2 + RELAY_JITTER_BUFFER_MS) / FRAME_MS)),
  );
}

function scheduleNetworkInput(player, buttons, frame) {
  const requestedFrame = Number(frame) || gameFrame;
  // Inputs are applied immediately before emulating `gameFrame`. Reaching the
  // exact requested frame is therefore still on time; treating equality as
  // late shifted one peer by a frame and permanently forked game outcomes.
  let targetFrame = Math.max(gameFrame, requestedFrame);
  const late = requestedFrame < gameFrame;
  if (late) {
    // Preserve late key-down/key-up transitions instead of mapping every
    // packet to the same frame (where the final key-up used to erase taps).
    const lastQueuedFrame = scheduledNetworkInputs.reduce(
      (latest, input) => input.player === player ? Math.max(latest, input.frame) : latest,
      gameFrame,
    );
    targetFrame = Math.max(targetFrame, lastQueuedFrame + 1);
  } else {
    // A repeated state for the same future frame is safe to replace.
    scheduledNetworkInputs = scheduledNetworkInputs.filter((input) => !(input.player === player && input.frame === targetFrame));
  }
  scheduledNetworkInputs.push({ player, buttons: Array.from(buttons || []), frame: targetFrame });
  scheduledNetworkInputs.sort((a, b) => a.frame - b.frame);
  return { late, requestedFrame, targetFrame };
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
    const encodedState = encodeNetworkState(nes.toJSON());
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
  setNetworkText(reason === 'late-input' ? '检测到网络抖动，正在恢复画面同步...' : '游戏已加载，正在同步 1P 进度...');
  logNetworkEvent('state-request-sent', { syncId, reason });
  sendPeerMessage({ type: 'state-request', syncId });
}

function recoverFromLateNetworkInput(detail) {
  if (networkRole !== 'guest' || stateRequestInFlight || networkSyncId) return;
  const now = performance.now();
  if (lastLateInputResyncAt && now - lastLateInputResyncAt < LATE_INPUT_RESYNC_COOLDOWN_MS) return;
  lastLateInputResyncAt = now;
  logNetworkEvent('late-input-resync', detail);
  window.setTimeout(() => requestInitialStateSync('late-input'), 120);
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
  if (netHostBtn) netHostBtn.textContent = networkRole === 'host' && networkTransport === 'peer' && peerReady ? '直连房间已创建' : '创建直连房间';
  if (relayHostBtn) {
    relayHostBtn.classList.toggle('hidden', !RELAY_SERVER_URL);
    relayHostBtn.textContent = networkRole === 'host' && networkTransport === 'relay' && relayReady ? '跨网房间已创建' : '创建跨网房间';
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
  peerConnection?.close?.();
  peerConnection = null;
  peerPendingMessages = [];
  scheduledNetworkInputs = [];
  hostClockFrame = null;
  lastStateRequestAt = 0;
  clearNetworkSync();
  lastNetworkClockAt = 0;
  networkRttMs = 0;
  networkPingId = '';
  networkPingSentAt = 0;
  lastNetworkPingAt = 0;
  lastGuestCatchUpLogAt = 0;
  lastLateInputResyncAt = 0;
  const waitingText = networkTransport === 'relay' ? '跨网房间已创建，等待加入' : '直连房间已创建，等待加入';
  setNetworkText(finalStatus || (networkRole === 'host' ? waitingText : networkRole === 'guest' ? '已断开联机' : '未联机'));
  updateNetworkButtons();
}

function teardownPeer() {
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
  relayGuestTicket = '';
  relayDataQueue = Promise.resolve();
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
  flushPeerQueue();
  const route = networkTransport === 'relay' ? '私有中继' : 'WebRTC 直连';
  setNetworkText(networkRole === 'host' ? `2P 已连接（${route}）` : `已通过${route}加入，等待游戏同步`);
  updateNetworkButtons();
  if (networkRole === 'host' && lastRomData && !peerRomSent) {
    sendCurrentRomToPeer();
  }
}

function handleNetworkMessage(message) {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'ping' && networkRole === 'host') {
    sendPeerMessage({ type: 'pong', id: message.id, frame: gameFrame });
    return;
  }
  if (message.type === 'pong' && networkRole === 'guest' && message.id === networkPingId) {
    const measuredRtt = Math.max(0, performance.now() - networkPingSentAt);
    networkPingId = '';
    hostClockFrame = Number(message.frame) || hostClockFrame;
    hostClockReceivedAt = performance.now();
    recordNetworkRtt(measuredRtt);
    sendPeerMessage({ type: 'latency-report', rttMs: Math.round(networkRttMs) });
    return;
  }
  if (message.type === 'latency-report' && networkRole === 'host') {
    const reportedRtt = Math.max(0, Math.min(5000, Number(message.rttMs) || 0));
    if (reportedRtt) recordNetworkRtt(reportedRtt, 'guest-report');
    return;
  }
  if (message.type === 'input-request' && networkRole === 'host' && message.player === remotePlayer) {
    const delayFrames = getNetworkInputDelayFrames();
    const frame = gameFrame + delayFrames;
    logNetworkEvent('input-request-received', { player: message.player, buttons: message.buttons || [], frame, delayFrames });
    scheduleNetworkInput(message.player, message.buttons, frame);
    sendPeerMessage({ type: 'input', player: message.player, buttons: message.buttons, frame });
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
    const scheduled = scheduleNetworkInput(message.player, message.buttons, message.frame);
    logNetworkEvent('input-received', {
      player: message.player,
      buttons: message.buttons || [],
      frame: message.frame,
      localFrame: gameFrame,
      targetFrame: scheduled.targetFrame,
      late: scheduled.late,
    });
    if (scheduled.late) recoverFromLateNetworkInput({
      player: message.player,
      requestedFrame: scheduled.requestedFrame,
      localFrame: gameFrame,
      targetFrame: scheduled.targetFrame,
    });
    return;
  }
  if (message.type === 'clock' && networkRole === 'guest') {
    hostClockFrame = Number(message.frame) || 0;
    hostClockReceivedAt = performance.now();
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
      nes.fromJSON(decodeNetworkState(message.data));
      gameFrame = Number(message.frame) || 0;
      scheduledNetworkInputs = [];
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
      scheduledNetworkInputs = [];
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
  logNetworkEvent('relay-ticket-request', { room: `${nextRoomId.slice(0, 4)}…${nextRoomId.slice(-4)}`, accessKey: Boolean(accessKey) });
  const response = await fetch(getRelayTicketUrl(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roomId: nextRoomId, accessKey }),
  });
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
    refreshInviteLink();
    updateNetworkButtons();
    if (message.peerConnected) {
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

function connectRelay(role, nextRoomId, ticket, guestTicket = '') {
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
  teardownPeer();
  networkTransport = 'relay';
  networkRole = role;
  roomId = String(nextRoomId || '').trim() || generateRoomId();
  relayGuestTicket = guestTicket;
  localStorage.removeItem(NETWORK_STORAGE_KEY);
  localPlayer = role === 'host' ? 1 : 2;
  remotePlayer = role === 'host' ? 2 : 1;
  socketUrl.searchParams.set('room', roomId);
  socketUrl.searchParams.set('role', role);
  socketUrl.searchParams.set('ticket', ticket);
  logNetworkEvent('relay-connect-start', { role, room: `${roomId.slice(0, 4)}…${roomId.slice(-4)}`, ticket: Boolean(ticket), host: socketUrl.host });
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

function getFullscreenElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

function requestGameFullscreen() {
  const request = game.requestFullscreen || game.webkitRequestFullscreen;
  if (!request) return Promise.reject(new Error('Fullscreen is not supported'));
  return Promise.resolve(request.call(game));
}

async function lockLandscape() {
  try {
    await screen.orientation?.lock?.('landscape');
    return true;
  } catch (error) {
    return false;
  }
}

function updateFullscreenButton() {
  const active = document.body.classList.contains('landscape-mode');
  fullscreenBtn.textContent = active ? '×' : '⛶';
  fullscreenBtn.setAttribute('aria-label', active ? '退出放大' : '放大横屏');
  fullscreenBtn.title = active ? '退出放大' : '放大横屏';
}

function finishFullscreenTransition() {
  applyControlOffsets();
  positionScaleTools();
  updateFullscreenButton();
}

async function exitGameFullscreen() {
  fallbackFullscreen = false;
  document.body.classList.remove('fullscreen-mode', 'landscape-mode');
  screen.orientation?.unlock?.();
  const exit = document.exitFullscreen || document.webkitExitFullscreen;
  if (getFullscreenElement() && exit) {
    try {
      await Promise.resolve(exit.call(document));
    } catch (error) {
      console.warn(error);
    }
  }
  finishFullscreenTransition();
}

async function toggleGameFullscreen() {
  if (document.body.classList.contains('landscape-mode')) {
    await exitGameFullscreen();
    return;
  }

  try {
    await requestGameFullscreen();
    fallbackFullscreen = false;
  } catch (error) {
    fallbackFullscreen = true;
  }
  document.body.classList.add('fullscreen-mode');
  document.body.classList.add('landscape-mode');

  const locked = await lockLandscape();
  finishFullscreenTransition();
  if (!locked) setStatus('已进入横屏模式');
}

function handleFullscreenChange() {
  if (!getFullscreenElement() && !fallbackFullscreen && document.body.classList.contains('landscape-mode')) {
    document.body.classList.remove('fullscreen-mode', 'landscape-mode');
    screen.orientation?.unlock?.();
  }
  finishFullscreenTransition();
}

function showGame() {
  landing.classList.add('hidden');
  game.classList.remove('hidden');
}

function getSampleRate() {
  return audioCtx?.sampleRate || 44100;
}

function initAudio() {
  if (audioCtx) {
    audioCtx.resume?.();
    audioEnabled = true;
    updateSoundButton();
    return;
  }

  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    setStatus('当前浏览器不支持声音');
    return;
  }

  try {
    audioCtx = new AudioContextClass();
    const capacity = Math.max(16384, Math.ceil(audioCtx.sampleRate * 0.5));
    audioL = new Float32Array(capacity);
    audioR = new Float32Array(capacity);
    audioRead = 0;
    audioWrite = 0;
    audioCount = 0;

    scriptNode = audioCtx.createScriptProcessor(1024, 0, 2);
    scriptNode.onaudioprocess = (event) => {
      const outL = event.outputBuffer.getChannelData(0);
      const outR = event.outputBuffer.getChannelData(1);
      for (let i = 0; i < outL.length; i++) {
        if (audioEnabled && audioCount > 0) {
          outL[i] = audioL[audioRead];
          outR[i] = audioR[audioRead];
          audioRead = (audioRead + 1) % audioL.length;
          audioCount--;
        } else {
          outL[i] = 0;
          outR[i] = 0;
        }
      }
    };
    scriptNode.connect(audioCtx.destination);
    audioCtx.resume?.();
    audioEnabled = true;
    updateSoundButton();
  } catch (error) {
    console.warn(error);
    setStatus('声音启动失败，可继续无声游玩');
  }
}

function clearAudioBuffer() {
  audioRead = 0;
  audioWrite = 0;
  audioCount = 0;
}

function updateSoundButton() {
  if (!audioCtx) {
    soundBtn.textContent = '开声';
  } else {
    soundBtn.textContent = audioEnabled ? '有声' : '静音';
  }
}

function pushAudioSample(left, right) {
  if (!audioCtx || !audioL) return;
  // Keep latency bounded after a slow frame or an iOS audio interruption.
  const maxBufferedSamples = Math.ceil(audioCtx.sampleRate * 0.12);
  while (audioCount > maxBufferedSamples) {
    audioRead = (audioRead + 1) % audioL.length;
    audioCount--;
  }
  if (audioCount >= audioL.length - 1) {
    audioRead = (audioRead + 1) % audioL.length;
    audioCount--;
  }
  audioL[audioWrite] = left;
  audioR[audioWrite] = right;
  audioWrite = (audioWrite + 1) % audioL.length;
  audioCount++;
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
    sampleRate: getSampleRate(),
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
    stopLoop();
    releaseAllButtons();
    clearAudioBuffer();
    nes = createNES();
    nes.loadROM(romData);
    gameFrame = 0;
    scheduledNetworkInputs = [];
    lastQueuedLocalButtons = new Set();
    hostClockFrame = null;
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
    pauseBtn.textContent = '暂停';
    setStatus(`正在玩：${name}`);
    if (networkRole === 'host' && peerConnected && lastRomData) {
      sendCurrentRomToPeer();
    }
    startLoop();
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

function stopLoop() {
  running = false;
  cancelAnimationFrame(rafId);
  rafId = 0;
}

function loop(timestamp) {
  if (!running || !nes) return;

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
    const transitEstimate = networkRttMs > 0 ? networkRttMs / 2 : 0;
    const estimatedHostFrame = hostClockFrame + (transitEstimate + timestamp - hostClockReceivedAt) / FRAME_MS;
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
    applyScheduledNetworkInputs();
    nes.frame();
    gameFrame++;
    elapsed -= FRAME_MS;
    frames++;
  }

  frameRemainder = elapsed;
  lastTick = timestamp;
  if (networkRole === 'host' && peerConnected && timestamp - lastNetworkClockAt >= NET_CLOCK_INTERVAL_MS) {
    lastNetworkClockAt = timestamp;
    sendPeerMessage({ type: 'clock', frame: gameFrame });
  }
  if (networkPingId && performance.now() - networkPingSentAt > 5000) {
    logNetworkEvent('network-ping-timeout');
    networkPingId = '';
  }
  const pingInterval = networkRttMs ? 2000 : 750;
  if (networkRole === 'guest' && peerConnected && !networkPingId && timestamp - lastNetworkPingAt >= pingInterval) {
    lastNetworkPingAt = timestamp;
    networkPingSentAt = performance.now();
    networkPingId = `${Math.round(networkPingSentAt).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    sendPeerMessage({ type: 'ping', id: networkPingId });
  }
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
    pauseBtn.textContent = '暂停';
    setStatus(lastRomName ? `正在玩：${lastRomName}` : '继续');
    startLoop();
  } else {
    stopLoop();
    paused = true;
    pauseBtn.textContent = '继续';
    setStatus('已暂停');
  }
});

soundBtn.addEventListener('click', () => {
  if (!audioCtx) {
    initAudio();
  } else {
    audioEnabled = !audioEnabled;
    clearAudioBuffer();
    audioCtx.resume?.();
    updateSoundButton();
  }
});

function closeSettings() {
  settingsDialog.removeAttribute('open');
  document.body.classList.remove('settings-open');
}

function closeDialogFromBackdrop(event) {
  const dialog = event.currentTarget;
  if (event.target !== dialog) return;
  const rect = dialog.getBoundingClientRect();
  const inside = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
  if (!inside) dialog.close();
}

settingsBtn.addEventListener('click', () => {
  releaseAllButtons({ broadcast: true });
  settingsDialog.setAttribute('open', '');
  document.body.classList.add('settings-open');
});
closeSettingsBtn.addEventListener('click', closeSettings);
document.addEventListener('click', (event) => {
  if (!settingsDialog.hasAttribute('open')) return;
  if (event.target.closest?.('#settingsDialog, #settingsBtn')) return;
  event.preventDefault();
  event.stopPropagation();
  closeSettings();
}, true);
layoutEditBtn.addEventListener('click', () => {
  const nextMode = !layoutEditMode;
  setLayoutEditMode(nextMode);
  if (nextMode) {
    closeSettings();
  }
});
resetLayoutBtn.addEventListener('click', resetControlLayout);
layoutPresetButtons.forEach((button) => {
  button.addEventListener('click', () => applyLayoutScalePreset(button.dataset.layoutScale));
});
controlOpacityInput.addEventListener('input', () => applyControlOpacity(controlOpacityInput.value));
menuDialog.addEventListener('click', closeDialogFromBackdrop);
libraryDialog.addEventListener('click', closeDialogFromBackdrop);
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && settingsDialog.hasAttribute('open')) closeSettings();
});
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
document.addEventListener('fullscreenchange', handleFullscreenChange);
document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
document.addEventListener('gesturestart', (event) => {
  if (game.contains(event.target)) event.preventDefault();
}, { passive: false });
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

const keyboardMap = {
  ArrowUp: 'UP', ArrowDown: 'DOWN', ArrowLeft: 'LEFT', ArrowRight: 'RIGHT',
  z: 'A', Z: 'A', x: 'B', X: 'B', Enter: 'START', Shift: 'SELECT',
};

function syncLocalPlayerState() {
  if (suppressNetworkBroadcast) {
    setPlayerButtons(localPlayer, getLocalMergedButtons(), { broadcast: false });
    return;
  }
  const next = getLocalMergedButtons();
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
  localSourceStates.keyboard.clear();
  localSourceStates.dpad.clear();
  localSourceStates.action.clear();
  setPlayerButtons(1, new Set(), { broadcast: false });
  setPlayerButtons(2, new Set(), { broadcast: false });
  suppressNetworkBroadcast = false;
  actionPointerId = null;
  dpadPointerId = null;
  syncButtonVisuals();
}

function getActionButton(name) {
  return document.querySelector(`[data-btn="${name}"]`);
}

function getActionButtonsFromPoint(point) {
  const next = new Set();
  const touchRadius = Math.max(16, point.radiusX || 0, point.radiusY || 0, (point.width || 0) / 2, (point.height || 0) / 2);
  const aButton = getActionButton('A');
  const bButton = getActionButton('B');

  if (aButton && bButton) {
    const aRect = aButton.getBoundingClientRect();
    const bRect = bButton.getBoundingClientRect();
    const middleX = (aRect.left + aRect.width / 2 + bRect.left + bRect.width / 2) / 2;
    const middleY = (aRect.top + aRect.height / 2 + bRect.top + bRect.height / 2) / 2;
    const buttonRadius = Math.min(aRect.width, aRect.height, bRect.width, bRect.height) / 2;
    const comboRadius = Math.max(16, Math.min(24, buttonRadius * 0.46));
    const comboDistance = Math.hypot(point.clientX - middleX, point.clientY - middleY);
    if (comboDistance <= comboRadius + Math.min(3, touchRadius * 0.12)) {
      return new Set(['A', 'B']);
    }
  }

  for (const name of ['A', 'B']) {
    const button = getActionButton(name);
    if (!button) continue;
    const rect = button.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const buttonRadius = Math.max(rect.width, rect.height) / 2;
    const distance = Math.hypot(point.clientX - cx, point.clientY - cy);
    if (distance <= buttonRadius + touchRadius * 0.2) next.add(name);
  }

  return next;
}

function isRotatedLandscapeFallback() {
  return document.body.classList.contains('landscape-mode') && window.matchMedia('(orientation: portrait)').matches;
}

function setActionButtons(next) {
  localSourceStates.action = new Set(next);
  syncLocalPlayerState();
}

function bindActionZone() {
  if (!actionZone) return;

  const start = (event, point, pointerId = null) => {
    if (layoutEditMode) return;
    const next = getActionButtonsFromPoint(point);
    const isCombo = next.has('A') && next.has('B');
    if (event.target.closest('[data-btn]') && !isCombo) return;
    if (!next.size) return;
    event.preventDefault();
    event.stopPropagation();
    actionPointerId = pointerId;
    if (pointerId !== null) actionZone.setPointerCapture?.(pointerId);
    setActionButtons(next);
  };

  const move = (event, point, pointerId = null) => {
    if (actionPointerId === null || (pointerId !== null && pointerId !== actionPointerId)) return;
    event.preventDefault();
    event.stopPropagation();
    setActionButtons(getActionButtonsFromPoint(point));
  };

  const end = (event, pointerId = null) => {
    if (actionPointerId === null || (pointerId !== null && pointerId !== actionPointerId)) return;
    event.preventDefault();
    event.stopPropagation();
    setActionButtons(new Set());
    actionPointerId = null;
  };

  actionZone.addEventListener('pointerdown', (event) => start(event, event, event.pointerId), true);
  actionZone.addEventListener('pointermove', (event) => move(event, event, event.pointerId), true);
  actionZone.addEventListener('pointerup', (event) => end(event, event.pointerId), true);
  actionZone.addEventListener('pointercancel', (event) => end(event, event.pointerId), true);

  actionZone.addEventListener('touchstart', (event) => {
    const touch = event.changedTouches[0];
    if (touch) start(event, touch, touch.identifier);
  }, { passive: false, capture: true });
  actionZone.addEventListener('touchmove', (event) => {
    const touch = Array.from(event.changedTouches).find((item) => item.identifier === actionPointerId);
    if (touch) move(event, touch, touch.identifier);
  }, { passive: false, capture: true });
  const endTouch = (event) => {
    const touch = Array.from(event.changedTouches).find((item) => item.identifier === actionPointerId);
    if (touch) end(event, touch.identifier);
  };
  actionZone.addEventListener('touchend', endTouch, { passive: false, capture: true });
  actionZone.addEventListener('touchcancel', endTouch, { passive: false, capture: true });
}

function bindTouchButton(button) {
  const name = button.dataset.btn;
  if (!name) return;
  const names = name === 'AB' ? ['A', 'B'] : [name];
  let pointerId = null;

  button.addEventListener('pointerdown', (event) => {
    if (layoutEditMode) return;
    event.preventDefault();
    pointerId = event.pointerId;
    button.setPointerCapture?.(pointerId);
    names.forEach((buttonName) => localSourceStates.action.add(buttonName));
    syncLocalPlayerState();
  });

  const up = (event) => {
    if (pointerId !== null && event.pointerId !== pointerId) return;
    event.preventDefault();
    names.forEach((buttonName) => localSourceStates.action.delete(buttonName));
    syncLocalPlayerState();
    pointerId = null;
  };

  button.addEventListener('pointerup', up);
  button.addEventListener('pointercancel', up);
}

document.querySelectorAll('[data-btn]').forEach(bindTouchButton);
bindActionZone();

function bindDraggableControl(element) {
  let drag = null;
  let pinch = null;

  const getTouchDistance = (touches) => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);

  const startDrag = (event, point, pointerId = null) => {
    if (!layoutEditMode) return;
    event.preventDefault();
    event.stopPropagation();
    selectControl(element);
    const key = getControlKey(element);
    const offset = controlOffsets[key] || { x: 0, y: 0 };
    drag = {
      pointerId,
      key,
      startX: point.clientX,
      startY: point.clientY,
      baseX: Number(offset.x) || 0,
      baseY: Number(offset.y) || 0,
      baseScale: Number(offset.scale) || 1,
    };
    if (pointerId !== null) element.setPointerCapture?.(pointerId);
    element.classList.add('dragging');
  };

  const moveDrag = (event, point, pointerId = null) => {
    if (!drag || (pointerId !== null && drag.pointerId !== pointerId)) return;
    event.preventDefault();
    event.stopPropagation();
    const dx = point.clientX - drag.startX;
    const dy = point.clientY - drag.startY;
    const rawX = isRotatedLandscapeFallback() ? drag.baseX + dy : drag.baseX + dx;
    const rawY = isRotatedLandscapeFallback() ? drag.baseY - dx : drag.baseY + dy;
    const maxX = Math.max(80, window.innerWidth * 0.42);
    const maxY = Math.max(80, window.innerHeight * 0.42);
    const nextX = Math.max(-maxX, Math.min(maxX, rawX));
    const nextY = Math.max(-maxY, Math.min(maxY, rawY));
    controlOffsets[drag.key] = {
      x: Math.round(nextX),
      y: Math.round(nextY),
      scale: drag.baseScale,
    };
    applyControlOffsets();
    positionScaleTools();
  };

  const endDrag = (event, pointerId = null) => {
    if (!drag || (pointerId !== null && drag.pointerId !== pointerId)) return;
    event.preventDefault();
    event.stopPropagation();
    element.classList.remove('dragging');
    drag = null;
    saveControlOffsets();
    positionScaleTools();
  };

  element.addEventListener('pointerdown', (event) => {
    startDrag(event, event, event.pointerId);
  });

  element.addEventListener('pointermove', (event) => {
    moveDrag(event, event, event.pointerId);
  });

  element.addEventListener('touchstart', (event) => {
    if (!layoutEditMode) return;
    if (event.touches.length >= 2) {
      event.preventDefault();
      event.stopPropagation();
      const key = getControlKey(element);
      const offset = controlOffsets[key] || { x: 0, y: 0, scale: 1 };
      pinch = {
        key,
        startDistance: getTouchDistance(event.touches),
        baseScale: Number(offset.scale) || 1,
      };
      drag = null;
      element.classList.add('dragging');
      return;
    }
    const touch = event.changedTouches[0];
    if (touch) startDrag(event, touch, touch.identifier);
  }, { passive: false });

  element.addEventListener('touchmove', (event) => {
    if (pinch && event.touches.length >= 2) {
      event.preventDefault();
      event.stopPropagation();
      const offset = controlOffsets[pinch.key] || { x: 0, y: 0, scale: 1 };
      const nextScale = Math.min(1.8, Math.max(0.65, pinch.baseScale * (getTouchDistance(event.touches) / pinch.startDistance)));
      controlOffsets[pinch.key] = { ...offset, scale: Number(nextScale.toFixed(3)) };
      applyControlOffsets();
      positionScaleTools();
      return;
    }
    const touch = Array.from(event.changedTouches).find((item) => drag && item.identifier === drag.pointerId);
    if (touch) moveDrag(event, touch, touch.identifier);
  }, { passive: false });

  const endTouchDrag = (event) => {
    if (pinch && event.touches.length < 2) {
      event.preventDefault();
      event.stopPropagation();
      element.classList.remove('dragging');
      pinch = null;
      saveControlOffsets();
      return;
    }
    const touch = Array.from(event.changedTouches).find((item) => drag && item.identifier === drag.pointerId);
    if (touch) endDrag(event, touch.identifier);
  };

  element.addEventListener('pointerup', endDrag);
  element.addEventListener('pointercancel', endDrag);
  element.addEventListener('touchend', endTouchDrag, { passive: false });
  element.addEventListener('touchcancel', endTouchDrag, { passive: false });
}

getAdjustableControls().forEach(bindDraggableControl);
window.addEventListener('resize', () => {
  applyControlOffsets();
  positionScaleTools();
});
window.addEventListener('orientationchange', () => window.setTimeout(() => {
  applyControlOffsets();
  positionScaleTools();
}, 80));
game.addEventListener('pointerdown', (event) => {
  if (!layoutEditMode) return;
  if (event.target.closest('#dpad, [data-btn], dialog, .topHud')) return;
  event.preventDefault();
  saveControlOffsets();
  document.body.classList.remove('settings-open');
  setLayoutEditMode(false);
}, true);

function setDpadDirections(next) {
  localSourceStates.dpad = new Set(next);
  syncLocalPlayerState();
}

function updateDpadFromPointer(event) {
  const rect = dpad.getBoundingClientRect();
  const cx = rect.width / 2;
  const cy = rect.height / 2;
  let localX = event.clientX - rect.left;
  let localY = event.clientY - rect.top;
  if (isRotatedLandscapeFallback()) {
    const sx = localX - cx;
    const sy = localY - cy;
    localX = cx + sy;
    localY = cy - sx;
  }
  const dx = (localX - cx) / cx;
  const dy = (localY - cy) / cy;
  const next = new Set();
  const distance = Math.hypot(dx, dy);
  const deadZone = 0.28;
  const diagonalThreshold = 0.48;
  if (distance < deadZone) {
    setDpadDirections(next);
    return;
  }
  const nx = dx / distance;
  const ny = dy / distance;
  if (nx < -diagonalThreshold) next.add('LEFT');
  if (nx > diagonalThreshold) next.add('RIGHT');
  if (ny < -diagonalThreshold) next.add('UP');
  if (ny > diagonalThreshold) next.add('DOWN');
  setDpadDirections(next);
}

dpad.addEventListener('pointerdown', (event) => {
  if (layoutEditMode) return;
  event.preventDefault();
  dpadPointerId = event.pointerId;
  dpad.setPointerCapture?.(dpadPointerId);
  updateDpadFromPointer(event);
});

dpad.addEventListener('pointermove', (event) => {
  if (event.pointerId !== dpadPointerId) return;
  event.preventDefault();
  updateDpadFromPointer(event);
});

function releaseDpad(event) {
  if (event.pointerId !== dpadPointerId) return;
  event.preventDefault();
  localSourceStates.dpad.clear();
  syncLocalPlayerState();
  dpadPointerId = null;
}

dpad.addEventListener('pointerup', releaseDpad);
dpad.addEventListener('pointercancel', releaseDpad);

window.addEventListener('keydown', (event) => {
  if (layoutEditMode) return;
  const name = keyboardMap[event.key];
  if (!name) return;
  event.preventDefault();
  localSourceStates.keyboard.add(name);
  syncLocalPlayerState();
});
window.addEventListener('keyup', (event) => {
  if (layoutEditMode) return;
  const name = keyboardMap[event.key];
  if (!name) return;
  event.preventDefault();
  localSourceStates.keyboard.delete(name);
  syncLocalPlayerState();
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (running) {
      stopLoop();
      paused = true;
      pauseBtn.textContent = '继续';
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
readControlOffsets();
applyControlOffsets();
applyControlOpacity(localStorage.getItem(CONTROL_OPACITY_STORAGE_KEY) || 90);
updateSoundButton();
updateFullscreenButton();
logNetworkEvent('app-start', { relayConfigured: Boolean(RELAY_SERVER_URL), online: navigator.onLine });
restoreNetworkRoom();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(console.warn);
  });
}
