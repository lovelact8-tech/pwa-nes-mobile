export const PLAYBACK_SPEEDS = Object.freeze([1, 2, 4, 6, 8]);

export function normalizePlaybackSpeed(value) {
  const speed = Number(value);
  return PLAYBACK_SPEEDS.includes(speed) ? speed : 1;
}

export function getEffectivePlaybackSpeed(selectedSpeed, locked = false) {
  return locked ? 1 : normalizePlaybackSpeed(selectedSpeed);
}

export function getPlaybackFrameLimit(speed) {
  return Math.max(3, Math.ceil(normalizePlaybackSpeed(speed) * 3));
}

export function createPlaybackSpeedController({
  buttons = [],
  statusElement = null,
  storageKey = '',
  isLocked = () => false,
  onChange,
} = {}) {
  let selectedSpeed = 1;

  try {
    selectedSpeed = normalizePlaybackSpeed(localStorage.getItem(storageKey));
  } catch (error) { /* private browsing can reject storage */ }

  function render() {
    const locked = Boolean(isLocked());
    const effectiveSpeed = getEffectivePlaybackSpeed(selectedSpeed, locked);
    buttons.forEach((button) => {
      const speed = normalizePlaybackSpeed(button.dataset.playbackSpeed);
      button.classList.toggle('active', speed === selectedSpeed);
      button.setAttribute('aria-pressed', speed === selectedSpeed ? 'true' : 'false');
    });
    if (statusElement) {
      statusElement.textContent = locked
        ? `联机为保证同步已固定 1×；单机将恢复 ${selectedSpeed}×`
        : selectedSpeed === 1
          ? '当前为正常速度；加速会同步压缩声音'
          : `当前 ${selectedSpeed}× 加速；随时可切回 1×`;
    }
    return effectiveSpeed;
  }

  function setSpeed(value, { persist = true } = {}) {
    const nextSpeed = normalizePlaybackSpeed(value);
    const previousEffective = getEffectivePlaybackSpeed(selectedSpeed, isLocked());
    selectedSpeed = nextSpeed;
    if (persist && storageKey) {
      try { localStorage.setItem(storageKey, String(selectedSpeed)); } catch (error) { /* private mode */ }
    }
    const effectiveSpeed = render();
    if (effectiveSpeed !== previousEffective) onChange?.(effectiveSpeed, selectedSpeed);
    return effectiveSpeed;
  }

  const listeners = [];
  buttons.forEach((button) => {
    const listener = () => setSpeed(button.dataset.playbackSpeed);
    button.addEventListener('click', listener);
    listeners.push([button, listener]);
  });
  render();

  return {
    destroy() {
      listeners.forEach(([button, listener]) => button.removeEventListener('click', listener));
    },
    getEffective: () => getEffectivePlaybackSpeed(selectedSpeed, isLocked()),
    getSelected: () => selectedSpeed,
    refresh: render,
    setSpeed,
  };
}
