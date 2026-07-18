import { RELAY_URL_STORAGE_KEY } from '../storage/keys.js';

export function getRuntimeRelayUrl() {
  try {
    const queryValue = new URLSearchParams(window.location.search).get('relay');
    if (queryValue?.trim()) return queryValue.trim();
    // A deployed private relay is authoritative. Stale Quick Tunnel/VPS URLs
    // saved by an older client must not override it on only one device.
    const deployedValue = String(import.meta.env.VITE_RELAY_URL || '').trim();
    if (deployedValue) return deployedValue;
    return localStorage.getItem(RELAY_URL_STORAGE_KEY)?.trim() || '';
  } catch (error) {
    return '';
  }
}
