import { FRAME_MS } from '../emulator/constants.js';
import {
  GUEST_INPUT_MIN_LEAD_FRAMES,
  GUEST_INPUT_MAX_LEAD_FRAMES,
  GUEST_ROLLBACK_INPUT_MIN_LEAD_FRAMES,
  GUEST_ROLLBACK_INPUT_MAX_LEAD_FRAMES,
  GUEST_ROLLBACK_TRANSIT_DISCOUNT_FRAMES,
  GUEST_ROLLBACK_LATE_TOLERANCE_FRAMES,
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
  const safety = Math.max(0, Number(safetyFrames) || 0);
  const bufferedLeadFrames = Math.max(
    GUEST_INPUT_MIN_LEAD_FRAMES,
    Math.min(GUEST_INPUT_MAX_LEAD_FRAMES, transitFrames + safety),
  );
  const rollback = shouldUseGuestRollback({ rttMs, jitterMs, transportStalled });
  const rollbackLeadFrames = Math.max(
    GUEST_ROLLBACK_INPUT_MIN_LEAD_FRAMES,
    Math.min(
      GUEST_ROLLBACK_INPUT_MAX_LEAD_FRAMES,
      transitFrames - GUEST_ROLLBACK_TRANSIT_DISCOUNT_FRAMES + safety,
    ),
  );
  const leadFrames = rollback ? rollbackLeadFrames : bufferedLeadFrames;
  return {
    // Stable routes trade at most one late frame for lower local/remote input
    // delay. A hostLate acknowledgement raises safetyFrames and immediately
    // restores the conservative lead on that route.
    frame: Math.max(localFrame + 1, Math.ceil(hostFrame) + leadFrames),
    leadFrames,
    transitFrames,
    mode: rollback ? 'rollback-low-latency' : 'buffered',
    rollback,
  };
}

export function getGuestInputLateness({ requestedFrame, hostFrame, rollbackEnabled = false }) {
  const requested = Math.max(0, Math.floor(Number(requestedFrame) || 0));
  const current = Math.max(0, Math.floor(Number(hostFrame) || 0));
  const latenessFrames = Math.max(0, current - requested);
  const toleranceFrames = rollbackEnabled ? GUEST_ROLLBACK_LATE_TOLERANCE_FRAMES : 0;
  return {
    latenessFrames,
    toleranceFrames,
    tooLate: latenessFrames > toleranceFrames,
  };
}
