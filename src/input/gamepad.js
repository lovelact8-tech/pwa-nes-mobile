const AXIS_THRESHOLD = 0.5;

function isPressed(button) {
  if (typeof button === 'number') return button >= 0.5;
  return Boolean(button?.pressed || Number(button?.value) >= 0.5);
}

function anyPressed(buttons, indexes) {
  return indexes.some((index) => isPressed(buttons[index]));
}

function decodeHatAxis(value) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || Math.abs(normalized) > 1.1 || Math.abs(normalized) < 0.06) return null;
  const positions = [
    [-1, ['UP']],
    [-0.714, ['UP', 'RIGHT']],
    [-0.428, ['RIGHT']],
    [-0.142, ['DOWN', 'RIGHT']],
    [0.142, ['DOWN']],
    [0.428, ['DOWN', 'LEFT']],
    [0.714, ['LEFT']],
    [1, ['UP', 'LEFT']],
  ];
  const match = positions.find(([position]) => Math.abs(normalized - position) <= 0.09);
  return match?.[1] || null;
}

export function mapGamepadToNesButtons(gamepad, axisThreshold = AXIS_THRESHOLD) {
  const next = new Set();
  const buttons = gamepad?.buttons || [];
  const axes = gamepad?.axes || [];
  const standard = gamepad?.mapping === 'standard';

  // Standard gamepads place the south button at index 0 and east at index 1.
  // Mapping east to NES A and south to NES B matches the original FC layout.
  // Cheap Bluetooth pads frequently expose an empty mapping string. Their
  // face/menu/shoulder buttons use either the standard indexes or the second
  // common WebKit layout, so accept both only for those non-standard devices.
  if (anyPressed(buttons, standard ? [1] : [1, 2])) next.add('A');
  if (anyPressed(buttons, standard ? [0] : [0, 3])) next.add('B');
  if (anyPressed(buttons, standard ? [8] : [8, 10])) next.add('SELECT');
  if (anyPressed(buttons, standard ? [9] : [9, 11])) next.add('START');
  if (anyPressed(buttons, standard ? [4] : [4, 6])) next.add('TURBO_B');
  if (anyPressed(buttons, standard ? [5] : [5, 7])) next.add('TURBO_A');

  if (isPressed(buttons[12]) || Number(axes[1]) < -axisThreshold) next.add('UP');
  if (isPressed(buttons[13]) || Number(axes[1]) > axisThreshold) next.add('DOWN');
  if (isPressed(buttons[14]) || Number(axes[0]) < -axisThreshold) next.add('LEFT');
  if (isPressed(buttons[15]) || Number(axes[0]) > axisThreshold) next.add('RIGHT');

  // Several Android/iOS-compatible pads expose the D-pad as one POV/hat axis
  // instead of buttons 12-15. It is normally the final axis and is only used
  // for devices that do not report the standard mapping.
  if (!standard && axes.length >= 3) {
    const hatDirections = decodeHatAxis(axes[axes.length - 1]);
    hatDirections?.forEach((direction) => next.add(direction));
  }
  return next;
}

function sameButtons(left, right) {
  return left.size === right.size && Array.from(left).every((button) => right.has(button));
}

function displayName(gamepad) {
  const name = String(gamepad?.id || '蓝牙手柄').replace(/\s+/g, ' ').trim();
  return name.length > 34 ? `${name.slice(0, 31)}…` : name;
}

export function createGamepadInput({
  onChange,
  onStatus,
  isInputEnabled = () => true,
  runtime = globalThis,
  navigatorRef = globalThis.navigator,
} = {}) {
  let activeIndex = null;
  let activeButtons = new Set();
  let animationFrame = 0;
  let started = false;
  let lastDeviceName = '';
  let lastPreview = '';

  const requestFrame = runtime.requestAnimationFrame?.bind(runtime) || ((callback) => runtime.setTimeout(callback, 16));
  const cancelFrame = runtime.cancelAnimationFrame?.bind(runtime) || runtime.clearTimeout?.bind(runtime);

  function availableGamepads() {
    if (typeof navigatorRef?.getGamepads !== 'function') return [];
    try {
      return Array.from(navigatorRef.getGamepads() || []).filter((gamepad) => gamepad?.connected !== false);
    } catch (error) {
      return [];
    }
  }

  function selectGamepad() {
    const gamepads = availableGamepads();
    const selected = gamepads.find((gamepad) => gamepad.index === activeIndex) || gamepads[0] || null;
    activeIndex = selected?.index ?? null;
    return selected;
  }

  function updateButtons(next) {
    if (sameButtons(next, activeButtons)) return;
    activeButtons = new Set(next);
    onChange?.(new Set(activeButtons));
  }

  function refreshStatus() {
    if (typeof navigatorRef?.getGamepads !== 'function') {
      onStatus?.('当前浏览器不支持蓝牙手柄；建议使用最新版 Safari、Chrome 或 Edge');
      return null;
    }
    const gamepad = selectGamepad();
    if (!gamepad) {
      lastDeviceName = '';
      onStatus?.('未检测到手柄：先在系统蓝牙中配对，再回到此页按任意键');
      return null;
    }
    const name = displayName(gamepad);
    if (name !== lastDeviceName) {
      lastDeviceName = name;
      lastPreview = '';
      onStatus?.(`已连接：${name}`);
    }
    return gamepad;
  }

  function poll() {
    if (!started) return;
    const gamepad = selectGamepad();
    if (gamepad && displayName(gamepad) !== lastDeviceName) refreshStatus();
    const detected = gamepad ? mapGamepadToNesButtons(gamepad) : new Set();
    const preview = [...detected].join(' + ');
    if (gamepad && preview !== lastPreview) {
      lastPreview = preview;
      onStatus?.(preview
        ? `已连接：${displayName(gamepad)} · 检测到 ${preview}`
        : `已连接：${displayName(gamepad)} · 请按任意键测试`);
    }
    const next = gamepad && isInputEnabled() ? detected : new Set();
    updateButtons(next);
    animationFrame = requestFrame(poll);
  }

  function start() {
    if (started) return;
    started = true;
    refreshStatus();
    animationFrame = requestFrame(poll);
  }

  function stop() {
    started = false;
    if (animationFrame) cancelFrame?.(animationFrame);
    animationFrame = 0;
    updateButtons(new Set());
  }

  function handleConnected(event) {
    activeIndex = event.gamepad?.index ?? activeIndex;
    lastDeviceName = '';
    refreshStatus();
  }

  function handleDisconnected(event) {
    if (event.gamepad?.index === activeIndex) activeIndex = null;
    lastDeviceName = '';
    lastPreview = '';
    updateButtons(new Set());
    refreshStatus();
  }

  runtime.addEventListener?.('gamepadconnected', handleConnected);
  runtime.addEventListener?.('gamepaddisconnected', handleDisconnected);

  return {
    clear: () => updateButtons(new Set()),
    destroy() {
      stop();
      runtime.removeEventListener?.('gamepadconnected', handleConnected);
      runtime.removeEventListener?.('gamepaddisconnected', handleDisconnected);
    },
    getButtons: () => new Set(activeButtons),
    refreshStatus,
    requestConnection() {
      start();
      const gamepad = refreshStatus();
      if (!gamepad) onStatus?.('请打开系统蓝牙完成配对，然后回到游戏按一下手柄按键');
      return Boolean(gamepad);
    },
    start,
    stop,
  };
}
