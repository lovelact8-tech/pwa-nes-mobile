import {
  CONTROL_LAYOUT_STORAGE_KEY,
  LEGACY_CONTROL_LAYOUT_STORAGE_KEY,
  CONTROL_OPACITY_STORAGE_KEY,
} from '../storage/keys.js';
import { setButtonLabel } from '../ui/buttons.js';

export function createControlLayoutController({
  dpad,
  game,
  layoutEditBtn,
  layoutPresetButtons,
  controlOpacityInput,
  controlOpacityValue,
  settingsModeText,
  releaseAllButtons,
} = {}) {
  let editMode = false;
  let controlOffsets = {};
  let selectedControlKey = null;
  let selectedControlElement = null;
  let scaleTools = null;

  const getAdjustableControls = () => [dpad, ...document.querySelectorAll('[data-btn]')];
  const getProfile = () => document.body.classList.contains('landscape-mode')
    || window.matchMedia('(orientation: landscape)').matches
    ? 'landscape'
    : 'portrait';
  const getBaseKey = (element) => element === dpad ? 'dpad' : `button-${element.dataset.btn}`;
  const getKey = (element) => `${getProfile()}:${getBaseKey(element)}`;

  function isRotatedLandscapeFallback() {
    return document.body.classList.contains('landscape-mode')
      && window.matchMedia('(orientation: portrait)').matches;
  }

  function normalizeOffset(value = {}) {
    const numberOr = (candidate, fallback) => Number.isFinite(Number(candidate)) ? Number(candidate) : fallback;
    return {
      x: Math.max(-900, Math.min(900, numberOr(value.x, 0))),
      y: Math.max(-900, Math.min(900, numberOr(value.y, 0))),
      scale: Math.max(0.65, Math.min(1.8, numberOr(value.scale, 1))),
    };
  }

  function save() {
    try {
      localStorage.setItem(CONTROL_LAYOUT_STORAGE_KEY, JSON.stringify(controlOffsets));
    } catch (error) {
      console.warn(error);
    }
  }

  function read() {
    try {
      const saved = localStorage.getItem(CONTROL_LAYOUT_STORAGE_KEY);
      const parsed = JSON.parse(saved || '{}');
      if (parsed && typeof parsed === 'object') {
        controlOffsets = Object.fromEntries(
          Object.entries(parsed).map(([key, value]) => [key, normalizeOffset(value)]),
        );
      }
      if (!saved) {
        const legacy = JSON.parse(localStorage.getItem(LEGACY_CONTROL_LAYOUT_STORAGE_KEY) || '{}');
        if (legacy && typeof legacy === 'object') {
          for (const [key, value] of Object.entries(legacy)) {
            controlOffsets[`portrait:${key}`] = normalizeOffset(value);
            controlOffsets[`landscape:${key}`] = normalizeOffset(value);
          }
          save();
        }
      }
    } catch (error) {
      controlOffsets = {};
    }
  }

  function applyOpacity(value) {
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

  function apply() {
    const scales = [];
    for (const element of getAdjustableControls()) {
      const key = getKey(element);
      const offset = normalizeOffset(controlOffsets[key]);
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

  function select(element) {
    selectedControlKey = getKey(element);
    selectedControlElement = element;
    apply();
    positionTools();
  }

  function scaleSelected(delta) {
    if (!selectedControlKey) return;
    const offset = controlOffsets[selectedControlKey] || { x: 0, y: 0, scale: 1 };
    const nextScale = Math.min(1.8, Math.max(0.65, (Number(offset.scale) || 1) + delta));
    controlOffsets[selectedControlKey] = { ...offset, scale: Number(nextScale.toFixed(2)) };
    apply();
    save();
    positionTools();
  }

  function ensureTools() {
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
      scaleSelected(button.dataset.scale === '+' ? 0.1 : -0.1);
    });
    return scaleTools;
  }

  function positionTools() {
    if (!editMode || !selectedControlElement) {
      scaleTools?.classList.add('hidden');
      return;
    }
    const tools = ensureTools();
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

  function setEditMode(enabled) {
    editMode = Boolean(enabled);
    document.body.classList.toggle('layout-editing', editMode);
    setButtonLabel(layoutEditBtn, editMode ? '完成调整' : '调整按键位置');
    settingsModeText.textContent = editMode
      ? `正在调整${getProfile() === 'landscape' ? '横屏' : '竖屏'}布局：拖动按键移动，选中后用 −/+ 或双指缩放，点空白保存。`
      : '横屏与竖屏布局会分别保存，不会互相影响。';
    if (!editMode) {
      selectedControlKey = null;
      selectedControlElement = null;
      scaleTools?.classList.add('hidden');
    }
    apply();
    releaseAllButtons?.();
  }

  function reset() {
    controlOffsets = {};
    save();
    apply();
    layoutPresetButtons.forEach((button) => button.classList.toggle('active', button.dataset.layoutScale === '1'));
  }

  function applyScalePreset(scale) {
    const nextScale = Math.min(1.8, Math.max(0.65, Number(scale) || 1));
    for (const element of getAdjustableControls()) {
      const key = getKey(element);
      const offset = controlOffsets[key] || { x: 0, y: 0 };
      controlOffsets[key] = { ...offset, scale: nextScale };
    }
    save();
    apply();
    layoutPresetButtons.forEach((button) => {
      button.classList.toggle('active', Number(button.dataset.layoutScale) === nextScale);
    });
  }

  function bindDraggable(element) {
    let drag = null;
    let pinch = null;
    const touchDistance = (touches) => Math.hypot(
      touches[0].clientX - touches[1].clientX,
      touches[0].clientY - touches[1].clientY,
    );

    const startDrag = (event, point, pointerId = null) => {
      if (!editMode) return;
      event.preventDefault();
      event.stopPropagation();
      select(element);
      const key = getKey(element);
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
      controlOffsets[drag.key] = {
        x: Math.round(Math.max(-maxX, Math.min(maxX, rawX))),
        y: Math.round(Math.max(-maxY, Math.min(maxY, rawY))),
        scale: drag.baseScale,
      };
      apply();
      positionTools();
    };

    const endDrag = (event, pointerId = null) => {
      if (!drag || (pointerId !== null && drag.pointerId !== pointerId)) return;
      event.preventDefault();
      event.stopPropagation();
      element.classList.remove('dragging');
      drag = null;
      save();
      positionTools();
    };

    element.addEventListener('pointerdown', (event) => startDrag(event, event, event.pointerId));
    element.addEventListener('pointermove', (event) => moveDrag(event, event, event.pointerId));
    element.addEventListener('pointerup', endDrag);
    element.addEventListener('pointercancel', endDrag);
    element.addEventListener('touchstart', (event) => {
      if (!editMode) return;
      if (event.touches.length >= 2) {
        event.preventDefault();
        event.stopPropagation();
        const key = getKey(element);
        const offset = controlOffsets[key] || { x: 0, y: 0, scale: 1 };
        pinch = { key, startDistance: touchDistance(event.touches), baseScale: Number(offset.scale) || 1 };
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
        const nextScale = Math.min(1.8, Math.max(0.65, pinch.baseScale * (touchDistance(event.touches) / pinch.startDistance)));
        controlOffsets[pinch.key] = { ...offset, scale: Number(nextScale.toFixed(3)) };
        apply();
        positionTools();
        return;
      }
      const touch = Array.from(event.changedTouches).find((item) => drag && item.identifier === drag.pointerId);
      if (touch) moveDrag(event, touch, touch.identifier);
    }, { passive: false });
    const endTouch = (event) => {
      if (pinch && event.touches.length < 2) {
        event.preventDefault();
        event.stopPropagation();
        element.classList.remove('dragging');
        pinch = null;
        save();
        return;
      }
      const touch = Array.from(event.changedTouches).find((item) => drag && item.identifier === drag.pointerId);
      if (touch) endDrag(event, touch.identifier);
    };
    element.addEventListener('touchend', endTouch, { passive: false });
    element.addEventListener('touchcancel', endTouch, { passive: false });
  }

  read();
  apply();
  applyOpacity(localStorage.getItem(CONTROL_OPACITY_STORAGE_KEY) || 90);
  getAdjustableControls().forEach(bindDraggable);
  window.addEventListener('resize', () => {
    apply();
    positionTools();
  });
  window.addEventListener('orientationchange', () => window.setTimeout(() => {
    apply();
    positionTools();
  }, 80));
  game.addEventListener('pointerdown', (event) => {
    if (!editMode || event.target.closest('#dpad, [data-btn], dialog, .topHud')) return;
    event.preventDefault();
    save();
    document.body.classList.remove('settings-open');
    setEditMode(false);
  }, true);

  return {
    apply,
    applyOpacity,
    applyScalePreset,
    isEditing: () => editMode,
    isRotatedLandscapeFallback,
    positionTools,
    reset,
    setEditMode,
  };
}
