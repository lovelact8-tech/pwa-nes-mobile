export function createInputController({
  actionZone,
  dpad,
  layout,
  onChange,
} = {}) {
  const sources = { keyboard: new Set(), dpad: new Set(), action: new Set() };
  let dpadPointerId = null;
  let actionPointerId = null;

  const keyboardMap = {
    ArrowUp: 'UP', ArrowDown: 'DOWN', ArrowLeft: 'LEFT', ArrowRight: 'RIGHT',
    z: 'A', Z: 'A', x: 'B', X: 'B', Enter: 'START', Shift: 'SELECT',
  };

  function getButtons() {
    return new Set([...sources.keyboard, ...sources.dpad, ...sources.action]);
  }

  function syncVisuals() {
    const activeButtons = getButtons();
    document.querySelectorAll('[data-btn]').forEach((element) => {
      const active = element.dataset.btn === 'AB'
        ? activeButtons.has('A') && activeButtons.has('B')
        : activeButtons.has(element.dataset.btn);
      element.classList.toggle('active', active);
    });
    document.querySelectorAll('.padVisual').forEach((element) => element.classList.remove('active'));
    let dpadActive = false;
    for (const name of ['UP', 'DOWN', 'LEFT', 'RIGHT']) {
      if (!activeButtons.has(name)) continue;
      dpadActive = true;
      document.querySelector(`.padVisual.${name.toLowerCase()}`)?.classList.add('active');
    }
    dpad.classList.toggle('active', dpadActive);
  }

  function notify() {
    syncVisuals();
    onChange?.(getButtons());
  }

  function clear({ notifyChange = true } = {}) {
    sources.keyboard.clear();
    sources.dpad.clear();
    sources.action.clear();
    actionPointerId = null;
    dpadPointerId = null;
    if (notifyChange) notify();
    else syncVisuals();
  }

  const getActionButton = (name) => document.querySelector(`[data-btn="${name}"]`);

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
      if (Math.hypot(point.clientX - middleX, point.clientY - middleY) <= comboRadius + Math.min(3, touchRadius * 0.12)) {
        return new Set(['A', 'B']);
      }
    }
    for (const name of ['A', 'B']) {
      const button = getActionButton(name);
      if (!button) continue;
      const rect = button.getBoundingClientRect();
      const distance = Math.hypot(
        point.clientX - (rect.left + rect.width / 2),
        point.clientY - (rect.top + rect.height / 2),
      );
      if (distance <= Math.max(rect.width, rect.height) / 2 + touchRadius * 0.2) next.add(name);
    }
    return next;
  }

  function setActionButtons(next) {
    sources.action = new Set(next);
    notify();
  }

  function bindActionZone() {
    if (!actionZone) return;
    const start = (event, point, pointerId = null) => {
      if (layout.isEditing()) return;
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
      if (layout.isEditing()) return;
      event.preventDefault();
      pointerId = event.pointerId;
      button.setPointerCapture?.(pointerId);
      names.forEach((buttonName) => sources.action.add(buttonName));
      notify();
    });
    const up = (event) => {
      if (pointerId !== null && event.pointerId !== pointerId) return;
      event.preventDefault();
      names.forEach((buttonName) => sources.action.delete(buttonName));
      notify();
      pointerId = null;
    };
    button.addEventListener('pointerup', up);
    button.addEventListener('pointercancel', up);
  }

  function setDpadDirections(next) {
    sources.dpad = new Set(next);
    notify();
  }

  function updateDpad(event) {
    const rect = dpad.getBoundingClientRect();
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;
    let localX = event.clientX - rect.left;
    let localY = event.clientY - rect.top;
    if (layout.isRotatedLandscapeFallback()) {
      const offsetX = localX - centerX;
      const offsetY = localY - centerY;
      localX = centerX + offsetY;
      localY = centerY - offsetX;
    }
    const dx = (localX - centerX) / centerX;
    const dy = (localY - centerY) / centerY;
    const next = new Set();
    const distance = Math.hypot(dx, dy);
    if (distance >= 0.28) {
      const nx = dx / distance;
      const ny = dy / distance;
      if (nx < -0.48) next.add('LEFT');
      if (nx > 0.48) next.add('RIGHT');
      if (ny < -0.48) next.add('UP');
      if (ny > 0.48) next.add('DOWN');
    }
    setDpadDirections(next);
  }

  dpad.addEventListener('pointerdown', (event) => {
    if (layout.isEditing()) return;
    event.preventDefault();
    dpadPointerId = event.pointerId;
    dpad.setPointerCapture?.(dpadPointerId);
    updateDpad(event);
  });
  dpad.addEventListener('pointermove', (event) => {
    if (event.pointerId !== dpadPointerId) return;
    event.preventDefault();
    updateDpad(event);
  });
  const releaseDpad = (event) => {
    if (event.pointerId !== dpadPointerId) return;
    event.preventDefault();
    sources.dpad.clear();
    notify();
    dpadPointerId = null;
  };
  dpad.addEventListener('pointerup', releaseDpad);
  dpad.addEventListener('pointercancel', releaseDpad);

  window.addEventListener('keydown', (event) => {
    if (layout.isEditing()) return;
    const name = keyboardMap[event.key];
    if (!name) return;
    event.preventDefault();
    sources.keyboard.add(name);
    notify();
  });
  window.addEventListener('keyup', (event) => {
    if (layout.isEditing()) return;
    const name = keyboardMap[event.key];
    if (!name) return;
    event.preventDefault();
    sources.keyboard.delete(name);
    notify();
  });

  document.querySelectorAll('[data-btn]').forEach(bindTouchButton);
  bindActionZone();
  syncVisuals();

  return { clear, getButtons, syncVisuals };
}
