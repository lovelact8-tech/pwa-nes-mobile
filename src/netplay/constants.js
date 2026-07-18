export const MAX_PEER_QUEUE_SIZE = 32;
export const NET_INPUT_DELAY_FRAMES = 1;
export const GUEST_INPUT_MIN_LEAD_FRAMES = 1;
export const GUEST_INPUT_MAX_LEAD_FRAMES = 4;
export const GUEST_INPUT_MAX_SAFETY_FRAMES = 2;
export const GUEST_INPUT_SAFETY_DECAY_MS = 15000;
// Rollback remains cheaper than delaying every 2P edge on a healthy mobile or
// Tailscale path. Above this range, buffering is safer because replay bursts
// become large enough to disturb audio and rendering.
export const GUEST_ROLLBACK_MAX_RTT_MS = 90;
export const GUEST_ROLLBACK_MAX_JITTER_MS = 20;
export const NET_CLOCK_INTERVAL_MS = 100;
export const NETWORK_PING_IDLE_MS = 1000;
export const NETWORK_PING_BOOTSTRAP_MS = 500;
export const NETWORK_PING_TIMEOUT_MS = 5000;
export const NETWORK_BOOTSTRAP_PING_TIMEOUT_MS = 3000;
export const NETWORK_SYNC_TIMEOUT_MS = 30000;
export const DEFAULT_NETWORK_RTT_MS = 250;
export const RELAY_MIN_JITTER_BUFFER_MS = 8;
export const RELAY_MAX_JITTER_BUFFER_MS = 50;
export const RELAY_MIN_GUEST_BUFFER_FRAMES = 1;
export const RELAY_MAX_GUEST_BUFFER_FRAMES = 4;
// requestAnimationFrame and timers can briefly pause while Safari/Chrome opens
// share sheets, address bars or system overlays. 750ms caused a healthy 30ms
// Tailscale route to be declared dead and left the guest frozen.
export const HOST_CLOCK_STALE_MS = 1800;
export const GUEST_FAST_CATCHUP_THRESHOLD_FRAMES = 12;
export const GUEST_FAST_CATCHUP_MAX_FRAMES = 6;
export const LATE_INPUT_RESYNC_COOLDOWN_MS = 5000;
export const ROLLBACK_SNAPSHOT_INTERVAL_FRAMES = 4;
export const ROLLBACK_WINDOW_FRAMES = 128;
export const ROLLBACK_MAX_SNAPSHOTS = Math.ceil(ROLLBACK_WINDOW_FRAMES / ROLLBACK_SNAPSHOT_INTERVAL_FRAMES) + 2;
export const NETWORK_STATE_CHECK_INTERVAL_FRAMES = 160;
