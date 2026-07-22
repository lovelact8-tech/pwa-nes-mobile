const AXIS_THRESHOLD = 0.5;

function isPressed(button) {
  return Boolean(button?.pressed || Number(button?.value) >= 0.5);
}

export function mapGamepadToNesButtons(gamepad, axisThreshold = AXIS_THRESHOLD) {
  const next = new Set();
  const buttons = gamepad?.buttons || [];
  const axes = gamepad?.axes || [];

  // Standard gamepads place the south button at index 0 and east at index 1.
  // Mapping east to NES A and south to NES B matches the original FC layout.
  if (isPressed(buttons[1])) next.add('A');
  if (isPressed(buttons[0])) next.add('B');
  if (isPressed(buttons[8])) next.add('SELECT');
  if (isPressed(buttons[9])) next.add('START');
  if (isPressed(buttons[4])) next.add('TURBO_B');
  if (isPressed(buttons[5])) next.add('TURBO_A');

  if (isPressed(buttons[12]) || Number(axes[1]) < -axisThreshold) next.add('UP');
  if (isPressed(buttons[13]) || Number(axes[1]) > axisThreshold) next.add('DOWN');
  if (isPressed(buttons[14]) || Number(axes[0]) < -axisThreshold) next.add('LEFT');
  if (isPressed(buttons[15]) || Number(axes[0]) > axisThreshold) next.add('RIGHT');
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
      onStatus?.(`已连接：${name}`);
    }
    return gamepad;
  }

  function poll() {
    if (!started) return;
    const gamepad = selectGamepad();
    if (gamepad && displayName(gamepad) !== lastDeviceName) refreshStatus();
    const next = gamepad && isInputEnabled() ? mapGamepadToNesButtons(gamepad) : new Set();
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
