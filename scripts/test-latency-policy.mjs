import assert from 'node:assert/strict';
import {
  getGuestInputLateness,
  getGuestInputPlan,
  shouldUseGuestRollback,
} from '../src/netplay/latency-policy.js';

function plan(overrides = {}) {
  return getGuestInputPlan({
    gameFrame: 100,
    estimatedHostFrame: 102,
    rttMs: 40,
    jitterMs: 4,
    safetyFrames: 0,
    transportStalled: false,
    ...overrides,
  });
}

assert.equal(shouldUseGuestRollback({ rttMs: 40, jitterMs: 4 }), true);
assert.equal(shouldUseGuestRollback({ rttMs: 40, jitterMs: 30 }), false);
assert.equal(shouldUseGuestRollback({ rttMs: 120, jitterMs: 4 }), false);
assert.equal(shouldUseGuestRollback({ rttMs: 40, jitterMs: 4, transportStalled: true }), false);

const stableIpv6 = plan();
assert.equal(stableIpv6.transitFrames, 2);
assert.equal(stableIpv6.leadFrames, 1);
assert.equal(stableIpv6.frame, 103);
assert.equal(stableIpv6.mode, 'rollback-low-latency');

const stableMobile = plan({ rttMs: 80, jitterMs: 12 });
assert.equal(stableMobile.transitFrames, 3);
assert.equal(stableMobile.leadFrames, 2);
assert.equal(stableMobile.frame, 104);

const lateEdgeSafety = plan({ safetyFrames: 1 });
assert.equal(lateEdgeSafety.leadFrames, 2);
assert.equal(lateEdgeSafety.frame, 104);

const jitteryRoute = plan({ rttMs: 60, jitterMs: 30 });
assert.equal(jitteryRoute.rollback, false);
assert.equal(jitteryRoute.leadFrames, 2);
assert.equal(jitteryRoute.mode, 'buffered');

const slowRoute = plan({ rttMs: 180, jitterMs: 15 });
assert.equal(slowRoute.rollback, false);
assert.equal(slowRoute.leadFrames, 4);

const stalledRoute = plan({ transportStalled: true });
assert.equal(stalledRoute.rollback, false);
assert.equal(stalledRoute.leadFrames, 2);

assert.deepEqual(
  getGuestInputLateness({ requestedFrame: 200, hostFrame: 202, rollbackEnabled: true }),
  { latenessFrames: 2, toleranceFrames: 2, tooLate: false },
);
assert.equal(
  getGuestInputLateness({ requestedFrame: 200, hostFrame: 203, rollbackEnabled: true }).tooLate,
  true,
);
assert.equal(
  getGuestInputLateness({ requestedFrame: 200, hostFrame: 201, rollbackEnabled: false }).tooLate,
  true,
);

console.log('✓ 2P延迟策略：稳定IPv6少等1帧，迟到/抖动/慢线路自动恢复安全缓冲');
