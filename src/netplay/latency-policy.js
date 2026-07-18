import { FRAME_MS } from '../emulator/constants.js';
import {
  GUEST_INPUT_MIN_LEAD_FRAMES,
  GUEST_INPUT_MAX_LEAD_FRAMES,
  GUEST_ROLLBACK_MAX_RTT_MS,
  GUEST_ROLLBACK_MAX_JITTER_MS,
} from './constants.js';

export function shouldUseGuestRollback({ rttMs, jitterMs, transportStalled = false }) {
  const rtt = Number(rttMs) || 0;
  const jitter = Number(jitterMs) || 0;
  return !transportStalled
    && rtt > 0
    && rtt <= GUEST_ROLLBACK_MAX_RTT_MS
    && jitter <= GUEST_ROLLBACK_MAX_JITTER_MS;
}

export function getGuestInputPlan({
  gameFrame,
  estimatedHostFrame,
  rttMs,
  jitterMs,
  safetyFrames = 0,
  transportStalled = false,
}) {
  const localFrame = Math.max(0, Math.floor(Number(gameFrame) || 0));
  const hostFrame = Math.max(localFrame, Number(estimatedHostFrame) || localFrame);
  const transitFrames = rttMs > 0 ? Math.ceil((rttMs / 2) / FRAME_MS) : 1;
  const leadFrames = Math.max(
    GUEST_INPUT_MIN_LEAD_FRAMES,
    Math.min(GUEST_INPUT_MAX_LEAD_FRAMES, transitFrames + Math.max(0, Number(safetyFrames) || 0)),
  );
  const rollback = shouldUseGuestRollback({ rttMs, jitterMs, transportStalled });
  return {
    frame: rollback
      ? localFrame + 1
      : Math.max(localFrame + 1, Math.ceil(hostFrame) + leadFrames),
    leadFrames,
    transitFrames,
    mode: rollback ? 'rollback' : 'buffered',
    rollback,
  };
}
