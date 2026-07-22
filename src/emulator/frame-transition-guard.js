const DEFAULTS = Object.freeze({
  sampleStride: 16,
  darkChannelThreshold: 24,
  nearBlackRatio: 0.006,
  nearBlackLumaThreshold: 12,
  minTransitionHoldFrames: 3,
  holdDarkFrames: 8,
  fadeOutFrames: 12,
  stableReleaseFrames: 3,
  fadeInFrames: 4,
  flashLockFrames: 2,
  settleFramesAfterDark: 2,
});

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Fast display-only darkness test. Sampling is deliberate: running a full
 * 61,440-pixel histogram at 60 fps is unnecessary for the MMC3 transition
 * frames this guard targets. An early exit keeps ordinary gameplay cheap.
 */
export function isNearBlackFrame(frame, options = {}) {
  if (!frame?.length) return true;

  const sampleStride = Math.max(1, Math.floor(options.sampleStride ?? DEFAULTS.sampleStride));
  const darkChannelThreshold = clamp(
    Math.floor(options.darkChannelThreshold ?? DEFAULTS.darkChannelThreshold),
    0,
    255,
  );
  const nearBlackRatio = clamp(options.nearBlackRatio ?? DEFAULTS.nearBlackRatio, 0, 1);
  const sampleCount = Math.ceil(frame.length / sampleStride);
  const allowedBrightSamples = Math.floor(sampleCount * nearBlackRatio);
  let brightSamples = 0;

  for (let index = 0; index < frame.length; index += sampleStride) {
    const color = frame[index] >>> 0;
    const red = color & 0xff;
    const green = (color >>> 8) & 0xff;
    const blue = (color >>> 16) & 0xff;
    if (red > darkChannelThreshold || green > darkChannelThreshold || blue > darkChannelThreshold) {
      brightSamples += 1;
      if (brightSamples > allowedBrightSamples) return false;
    }
  }

  return true;
}

function copyFrame(target, source) {
  if (!target || target.length !== source.length) target = new Uint32Array(source.length);
  target.set(source);
  return target;
}

function scaleFrame(target, source, level) {
  if (!target || target.length !== source.length) target = new Uint32Array(source.length);
  const scale = clamp(level, 0, 1);
  for (let index = 0; index < source.length; index += 1) {
    const color = source[index] >>> 0;
    const red = Math.round((color & 0xff) * scale);
    const green = Math.round(((color >>> 8) & 0xff) * scale);
    const blue = Math.round(((color >>> 16) & 0xff) * scale);
    target[index] = red | (green << 8) | (blue << 16);
  }
  return target;
}

function frameLuma(frame, options) {
  const sampleStride = Math.max(1, Math.floor(options.sampleStride ?? DEFAULTS.sampleStride));
  let total = 0;
  let count = 0;
  for (let index = 0; index < frame.length; index += sampleStride) {
    const color = frame[index] >>> 0;
    const red = color & 0xff;
    const green = (color >>> 8) & 0xff;
    const blue = (color >>> 16) & 0xff;
    total += (red + green + blue) / 3;
    count += 1;
  }
  return count ? (total / count) : 0;
}

function isNearBlackFrameByLuma(frame, options = {}) {
  return frameLuma(frame, options) <= (options.nearBlackLumaThreshold ?? DEFAULTS.nearBlackLumaThreshold);
}

function blendFrame(target, from, to, level) {
  if (!target || target.length !== to.length) target = new Uint32Array(to.length);
  const amount = clamp(level, 0, 1);
  const inverse = 1 - amount;
  for (let index = 0; index < to.length; index += 1) {
    const oldColor = from[index] >>> 0;
    const newColor = to[index] >>> 0;
    const red = Math.round((oldColor & 0xff) * inverse + (newColor & 0xff) * amount);
    const green = Math.round(((oldColor >>> 8) & 0xff) * inverse + ((newColor >>> 8) & 0xff) * amount);
    const blue = Math.round(((oldColor >>> 16) & 0xff) * inverse + ((newColor >>> 16) & 0xff) * amount);
    target[index] = red | (green << 8) | (blue << 16);
  }
  return target;
}

/**
 * Smooths the stock Tunshi MMC3 battle transition at presentation time only.
 * It never calls nes.frame(), touches mapper/RAM state, or mutates the source
 * framebuffer, so saves, hashes, rollback and netplay remain deterministic.
 */
export function createFrameTransitionGuard(options = {}) {
  const settings = { ...DEFAULTS, ...options };
  let enabled = Boolean(options.enabled);
  let phase = 'normal';
  let lastStable = null;
  let transitionBase = null;
  let revealBase = null;
  let output = null;
  let consecutiveDark = 0;
  let consecutiveStable = 0;
  let fadeInStep = 0;
  let flashHold = 0;
  let settleFrames = 0;

  function reset() {
    phase = 'normal';
    lastStable = null;
    transitionBase = null;
    revealBase = null;
    output = null;
    consecutiveDark = 0;
    consecutiveStable = 0;
    fadeInStep = 0;
    flashHold = 0;
    settleFrames = 0;
  }

  function setEnabled(nextEnabled) {
    const next = Boolean(nextEnabled);
    if (next !== enabled) {
      enabled = next;
      reset();
    }
  }

  function result(frame, guarded, nearBlack) {
    return { frame, guarded, nearBlack, phase };
  }

  function process(frame) {
    if (!enabled || !frame?.length) return result(frame, false, false);

    const nearBlack = isNearBlackFrame(frame, settings);
    const nearBlackByLuma = isNearBlackFrameByLuma(frame, settings);
    // Sparse, high-contrast screens such as the stock password/record-code
    // menu have a very low average luma even though their white glyphs are
    // perfectly valid output. Only a genuinely near-black pixel ratio may
    // start a transition; otherwise those menus can be mistaken for a fade
    // and remain hidden forever while the game and music continue running.
    const isTransitionSeed = nearBlack;

    if (phase === 'normal') {
      if (!isTransitionSeed) {
        lastStable = copyFrame(lastStable, frame);
        return result(frame, false, false);
      }

      // There is nothing sensible to hold if the ROM starts on black.
      if (!lastStable) return result(frame, false, true);

      phase = 'transition';
      transitionBase = copyFrame(transitionBase, lastStable);
      consecutiveDark = 1;
      consecutiveStable = 0;
      settleFrames = settings.settleFramesAfterDark;
      flashHold = settings.flashLockFrames;
      output = copyFrame(output, transitionBase);
      return result(output, true, true);
    }

    if (nearBlack) {
      // A black frame during reveal means the PPU transition is not stable yet.
      // Keep the same base image and restart the release test.
      if (phase === 'fade-in') transitionBase = copyFrame(transitionBase, output);
      const effectiveHoldDarkFrames = Math.max(settings.holdDarkFrames, settings.minTransitionHoldFrames);
      phase = 'transition';
      consecutiveStable = 0;
      fadeInStep = 0;
      consecutiveDark += 1;
      settleFrames = Math.max(settleFrames, settings.settleFramesAfterDark);
      flashHold = Math.max(flashHold, settings.flashLockFrames);

      if (consecutiveDark <= effectiveHoldDarkFrames) {
        output = copyFrame(output, transitionBase);
      } else {
        const fadeStep = consecutiveDark - effectiveHoldDarkFrames;
        const level = 1 - fadeStep / Math.max(1, settings.fadeOutFrames);
        output = scaleFrame(output, transitionBase, level);
      }
      return result(output, true, true);
    }

    consecutiveStable += 1;
    consecutiveDark = 0;

    // The first stable frame can sometimes be a true black/visible alternating
    // flash residue. Hold output for a few extra frames to avoid exposing it.
    if (nearBlackByLuma && consecutiveStable < settings.stableReleaseFrames) {
      flashHold = Math.max(settings.flashLockFrames, flashHold);
      return result(output, true, false);
    }

    if (flashHold > 0 && consecutiveStable < settings.flashLockFrames) {
      flashHold -= 1;
      return result(output, true, false);
    }

    if (settleFrames > 0) {
      settleFrames -= 1;
      return result(output, true, false);
    }

    // Alternating black/non-black frames are the visible flash reported by the
    // user. Requiring a few consecutive healthy frames hides that sequence.
    if (phase === 'transition' && consecutiveStable < settings.stableReleaseFrames) {
      return result(output, true, false);
    }

    if (phase === 'transition') {
      phase = 'fade-in';
      fadeInStep = 0;
      revealBase = copyFrame(revealBase, output);
    }

    fadeInStep += 1;
    const reveal = fadeInStep / Math.max(1, settings.fadeInFrames);
    output = blendFrame(output, revealBase, frame, reveal);

    if (fadeInStep >= settings.fadeInFrames) {
      phase = 'normal';
      lastStable = copyFrame(lastStable, frame);
      transitionBase = null;
      revealBase = null;
      consecutiveStable = 0;
      fadeInStep = 0;
      return result(frame, false, false);
    }

    return result(output, true, false);
  }

  return {
    process,
    reset,
    setEnabled,
    isEnabled: () => enabled,
    getPhase: () => phase,
  };
}
