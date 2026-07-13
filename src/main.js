import './style.css';
import { NES, Controller } from 'jsnes';
import Peer from 'peerjs';
import { unzipSync } from 'fflate';

const SCREEN_WIDTH = 256;
const SCREEN_HEIGHT = 240;
const FRAMEBUFFER_SIZE = SCREEN_WIDTH * SCREEN_HEIGHT;
const FRAME_MS = 1000 / 60;
const MAX_FRAME_DELTA_MS = FRAME_MS * 3;
const MAX_PEER_QUEUE_SIZE = 32;
const NET_INPUT_DELAY_FRAMES = 4;
const NET_CLOCK_INTERVAL_MS = 500;

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
const netCopyBtn = document.querySelector('#netCopyBtn');
const netLeaveBtn = document.querySelector('#netLeaveBtn');
const netLinkInput = document.querySelector('#netLinkInput');
const netStatusText = document.querySelector('#netStatusText');
const layoutEditBtn = document.querySelector('#layoutEditBtn');
const resetLayoutBtn = document.querySelector('#resetLayoutBtn');
const closeSettingsBtn = document.querySelector('#closeSettingsBtn');
const settingsModeText = document.querySelector('#settingsModeText');
const layoutPresetButtons = document.querySelectorAll('[data-layout-scale]');
const dpad = document.querySelector('#dpad');
const actionZone = document.querySelector('.rightZone');
const fullscreenBtn = document.querySelector('#fullscreenBtn');

const isStandalone = window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
if (!isStandalone) document.body.classList.add('browser-mode');

let nes = null;
let lastRomData = null;
let lastRomName = '';
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
let roomId = '';
let peer = null;
let peerConnection = null;
let peerReady = false;
let peerConnected = false;
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
const NETWORK_STORAGE_KEY = 'pwa-nes-network-room-v1';

let audioCtx = null;
let scriptNode = null;
let audioEnabled = false;
let audioRead = 0;
let audioWrite = 0;
let audioCount = 0;
let audioL = null;
let audioR = null;

const CONTROL_LAYOUT_STORAGE_KEY = 'pwa-nes-control-layout-v1';
const SAVE_STATE_STORAGE_KEY = 'pwa-nes-save-state-v1';

function setStatus(text) {
  statusText.textContent = text;
}

function getAdjustableControls() {
  return [dpad, ...document.querySelectorAll('[data-btn]')];
}

function getControlKey(element) {
  if (element === dpad) return 'dpad';
  return `button-${element.dataset.btn}`;
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
    const parsed = JSON.parse(localStorage.getItem(CONTROL_LAYOUT_STORAGE_KEY) || '{}');
    if (parsed && typeof parsed === 'object') {
      controlOffsets = Object.fromEntries(
        Object.entries(parsed).map(([key, value]) => [key, normalizeControlOffset(value)])
      );
    }
  } catch (error) {
    controlOffsets = {};
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
  for (const element of getAdjustableControls()) {
    const key = getControlKey(element);
    const offset = normalizeControlOffset(controlOffsets[key]);
    controlOffsets[key] = offset;
    element.style.setProperty('--drag-x', `${offset.x}px`);
    element.style.setProperty('--drag-y', `${offset.y}px`);
    element.style.setProperty('--control-scale', `${offset.scale}`);
    element.classList.toggle('selected-control', key === selectedControlKey);
  }
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
    tools.style.left = `${Math.min(window.innerWidth - 8, rect.right + 44)}px`;
    tools.style.top = `${rect.top + rect.height / 2}px`;
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
  settingsModeText.textContent = enabled ? '正在调整：拖动按键移动；选中后点上方 −/+ 或双指缩放；点空白自动保存。' : '可调整方向键、A/B、连发和 SELECT/START 的位置与大小；设置会自动保存。';
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

function setNetworkText(text) {
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
    element.classList.toggle('active', activeButtons.has(element.dataset.btn));
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

function sendPeerMessage(message) {
  if (!peerConnection?.open) {
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
    peerConnection.send(message);
  } catch (error) {
    console.warn(error);
  }
}

function flushPeerQueue() {
  if (!peerConnection?.open) return;
  while (peerPendingMessages.length) {
    try {
      peerConnection.send(peerPendingMessages.shift());
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
    const frame = gameFrame + NET_INPUT_DELAY_FRAMES;
    scheduleNetworkInput(player, nextButtons, frame);
    sendPeerMessage({ type: 'input', player, buttons: nextButtons, frame });
    return;
  }
  sendPeerMessage({ type: 'input-request', player, buttons: nextButtons });
}

function scheduleNetworkInput(player, buttons, frame) {
  const targetFrame = Math.max(gameFrame, Number(frame) || gameFrame);
  scheduledNetworkInputs = scheduledNetworkInputs.filter((input) => !(input.player === player && input.frame === targetFrame));
  scheduledNetworkInputs.push({ player, buttons: Array.from(buttons || []), frame: targetFrame });
  scheduledNetworkInputs.sort((a, b) => a.frame - b.frame);
}

function applyScheduledNetworkInputs() {
  while (scheduledNetworkInputs.length && scheduledNetworkInputs[0].frame <= gameFrame) {
    const input = scheduledNetworkInputs.shift();
    setPlayerButtons(input.player, new Set(input.buttons), { broadcast: false });
  }
}

function sendPeerSnapshot() {
  if (networkRole !== 'host' || !nes || !peerConnected) return;
  try {
    sendPeerMessage({ type: 'state', state: nes.toJSON(), frame: gameFrame });
  } catch (error) {
    console.warn(error);
  }
}

function applyPeerRom(romData, name = 'NES 游戏') {
  pendingPeerRomData = romData;
  lastRomData = romData;
  lastRomName = name;
  startRom(romData, name);
}

function updateNetworkButtons() {
  const active = networkRole !== 'offline';
  if (netHostBtn) netHostBtn.textContent = networkRole === 'host' && peerReady ? '直连房间已创建' : '创建直连房间';
  if (netLeaveBtn) netLeaveBtn.disabled = !active;
  if (netCopyBtn) netCopyBtn.disabled = !roomId || !peerReady;
}

function teardownPeerConnection(finalStatus = '') {
  peerConnected = false;
  peerRomSent = false;
  peerConnection?.close?.();
  peerConnection = null;
  peerPendingMessages = [];
  scheduledNetworkInputs = [];
  hostClockFrame = null;
  lastNetworkClockAt = 0;
  setNetworkText(finalStatus || (networkRole === 'host' ? '房间已创建，等待加入' : networkRole === 'guest' ? '已断开联机' : '未联机'));
  updateNetworkButtons();
}

function teardownPeer() {
  teardownPeerConnection();
  peer?.destroy?.();
  peer = null;
  peerReady = false;
}

function markNetworkConnected() {
  if (peerConnected) return;
  peerConnected = true;
  flushPeerQueue();
  setNetworkText(networkRole === 'host' ? '2P 已连接' : '已加入房间，等待 1P 选择游戏');
  updateNetworkButtons();
  if (networkRole === 'host' && lastRomData && !peerRomSent) {
    sendPeerMessage({ type: 'rom', name: lastRomName, data: lastRomData });
    peerRomSent = true;
    sendPeerSnapshot();
  }
}

function handleNetworkMessage(message) {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'input-request' && networkRole === 'host' && message.player === remotePlayer) {
    const frame = gameFrame + NET_INPUT_DELAY_FRAMES;
    scheduleNetworkInput(message.player, message.buttons, frame);
    sendPeerMessage({ type: 'input', player: message.player, buttons: message.buttons, frame });
    return;
  }
  if (message.type === 'input' && networkRole === 'guest') {
    scheduleNetworkInput(message.player, message.buttons, message.frame);
    return;
  }
  if (message.type === 'clock' && networkRole === 'guest') {
    hostClockFrame = Number(message.frame) || 0;
    hostClockReceivedAt = performance.now();
    return;
  }
  if (message.type === 'rom' && networkRole === 'guest') {
    applyPeerRom(message.data, message.name || 'NES 游戏');
    peerRomSent = true;
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

function configurePeerConnection(connection) {
  peerConnection = connection;
  const connectionTimeout = window.setTimeout(() => {
    if (!connection.open) setNetworkText('连接超时：请确认 1P 房间仍然开启，并检查双方网络');
  }, 12000);
  connection.on('open', () => {
    clearTimeout(connectionTimeout);
    markNetworkConnected();
  });
  connection.on('data', handleNetworkMessage);
  connection.on('close', () => {
    clearTimeout(connectionTimeout);
    teardownPeerConnection();
  });
  connection.on('error', (error) => {
    clearTimeout(connectionTimeout);
    console.warn(error);
    teardownPeerConnection(getPeerErrorText('联机连接', error));
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
  roomId = nextRoomId;
  localStorage.setItem(NETWORK_STORAGE_KEY, JSON.stringify({ role: 'host', roomId }));
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
      sendPeerMessage({ type: 'rom', name: lastRomName, data: lastRomData });
      peerRomSent = true;
    }
  });
  peer.on('connection', (connection) => {
    configurePeerConnection(connection);
  });
  peer.on('error', (error) => {
    console.warn(error);
    teardownPeerConnection(getPeerErrorText('创建房间', error));
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
  roomId = nextRoomId;
  localStorage.setItem(NETWORK_STORAGE_KEY, JSON.stringify({ role: 'guest', roomId }));
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

function restoreNetworkRoom() {
  const params = new URLSearchParams(window.location.search);
  const nextRoom = params.get('room');
  if (nextRoom) {
    joinPeerRoom(nextRoom);
    return;
  }
  try {
    const saved = JSON.parse(localStorage.getItem(NETWORK_STORAGE_KEY) || 'null');
    if (saved?.role === 'host' && saved.roomId) {
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

async function toggleGameFullscreen() {
  if (document.body.classList.contains('landscape-mode')) {
    fallbackFullscreen = false;
    document.body.classList.remove('fullscreen-mode');
    document.body.classList.remove('landscape-mode');
    screen.orientation?.unlock?.();
    updateFullscreenButton();
    return;
  }

  fallbackFullscreen = true;
  document.body.classList.add('fullscreen-mode');
  document.body.classList.add('landscape-mode');

  const locked = await lockLandscape();
  updateFullscreenButton();
  if (!locked) setStatus('已进入横屏模式');
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
      for (let i = 0; i < FRAMEBUFFER_SIZE; i++) {
        frameBuffer32[i] = 0xff000000 | frameBuffer24[i];
      }
      ctx.putImageData(imageData, 0, 0);
    },
    onAudioSample(left, right) {
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
      sendPeerMessage({ type: 'rom', name, data: lastRomData });
      peerRomSent = true;
      sendPeerSnapshot();
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

  if (!lastTick) lastTick = timestamp;
  const delta = Math.min(timestamp - lastTick, MAX_FRAME_DELTA_MS);
  let elapsed = delta + frameRemainder;
  let frames = 0;

  if (networkRole === 'guest' && peerConnected && hostClockFrame !== null) {
    const estimatedHostFrame = hostClockFrame + (timestamp - hostClockReceivedAt) / FRAME_MS;
    const frameDifference = estimatedHostFrame - gameFrame;
    if (frameDifference > 1.5) elapsed += Math.min(2, Math.floor(frameDifference)) * FRAME_MS;
    if (frameDifference < -1.5) elapsed = Math.max(0, elapsed - FRAME_MS);
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

settingsBtn.addEventListener('click', () => {
  settingsDialog.setAttribute('open', '');
  document.body.classList.add('settings-open');
});
closeSettingsBtn.addEventListener('click', () => {
  settingsDialog.removeAttribute('open');
  document.body.classList.remove('settings-open');
});
layoutEditBtn.addEventListener('click', () => {
  const nextMode = !layoutEditMode;
  setLayoutEditMode(nextMode);
  if (nextMode) {
    settingsDialog.removeAttribute('open');
    document.body.classList.remove('settings-open');
  }
});
resetLayoutBtn.addEventListener('click', resetControlLayout);
layoutPresetButtons.forEach((button) => {
  button.addEventListener('click', () => applyLayoutScalePreset(button.dataset.layoutScale));
});
menuBtn.addEventListener('click', () => menuDialog.showModal());
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
netLeaveBtn.addEventListener('click', () => {
  teardownPeer();
  roomId = '';
  networkRole = 'offline';
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
document.addEventListener('fullscreenchange', updateFullscreenButton);
document.addEventListener('webkitfullscreenchange', updateFullscreenButton);
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
    if (layoutEditMode || event.target.closest('[data-btn]')) return;
    const next = getActionButtonsFromPoint(point);
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
  let pointerId = null;

  button.addEventListener('pointerdown', (event) => {
    if (layoutEditMode) return;
    event.preventDefault();
    pointerId = event.pointerId;
    button.setPointerCapture?.(pointerId);
    localSourceStates.action.add(name);
    syncLocalPlayerState();
  });

  const up = (event) => {
    if (pointerId !== null && event.pointerId !== pointerId) return;
    event.preventDefault();
    localSourceStates.action.delete(name);
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
window.addEventListener('resize', positionScaleTools);
window.addEventListener('orientationchange', () => window.setTimeout(positionScaleTools, 80));
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
updateSoundButton();
updateFullscreenButton();
restoreNetworkRoom();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(console.warn);
  });
}
