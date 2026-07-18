export function createFullscreenController({
  game,
  onStatus,
  onTransition,
} = {}) {
  let fallbackFullscreen = false;

  const getElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;

  function request() {
    const requestFullscreen = game.requestFullscreen || game.webkitRequestFullscreen;
    if (!requestFullscreen) return Promise.reject(new Error('Fullscreen is not supported'));
    return Promise.resolve(requestFullscreen.call(game));
  }

  async function lockLandscape() {
    try {
      await screen.orientation?.lock?.('landscape');
      return true;
    } catch (error) {
      return false;
    }
  }

  function finishTransition() {
    onTransition?.(isActive());
  }

  function isActive() {
    return document.body.classList.contains('landscape-mode');
  }

  async function exit() {
    fallbackFullscreen = false;
    document.body.classList.remove('fullscreen-mode', 'landscape-mode');
    screen.orientation?.unlock?.();
    const exitFullscreen = document.exitFullscreen || document.webkitExitFullscreen;
    if (getElement() && exitFullscreen) {
      try {
        await Promise.resolve(exitFullscreen.call(document));
      } catch (error) {
        console.warn(error);
      }
    }
    finishTransition();
  }

  async function toggle() {
    if (isActive()) {
      await exit();
      return;
    }
    try {
      await request();
      fallbackFullscreen = false;
    } catch (error) {
      fallbackFullscreen = true;
    }
    document.body.classList.add('fullscreen-mode', 'landscape-mode');
    const locked = await lockLandscape();
    finishTransition();
    if (!locked) onStatus?.('已进入横屏模式');
  }

  function handleChange() {
    if (!getElement() && !fallbackFullscreen && isActive()) {
      document.body.classList.remove('fullscreen-mode', 'landscape-mode');
      screen.orientation?.unlock?.();
    }
    finishTransition();
  }

  document.addEventListener('fullscreenchange', handleChange);
  document.addEventListener('webkitfullscreenchange', handleChange);

  return { exit, isActive, toggle };
}
