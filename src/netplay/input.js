export const NETPLAY_BUTTONS = Object.freeze([
  'A',
  'B',
  'SELECT',
  'START',
  'UP',
  'DOWN',
  'LEFT',
  'RIGHT',
]);

const BUTTON_BITS = new Map(NETPLAY_BUTTONS.map((button, index) => [button, 1 << index]));

export function encodeInputMask(buttons) {
  let mask = 0;
  for (const button of buttons || []) mask |= BUTTON_BITS.get(String(button)) || 0;
  return mask & 0xff;
}

export function decodeInputMask(mask) {
  const normalized = Number(mask) & 0xff;
  return NETPLAY_BUTTONS.filter((button) => normalized & BUTTON_BITS.get(button));
}

export function messageButtons(message = {}) {
  if (Number.isFinite(Number(message.mask))) return decodeInputMask(message.mask);
  return Array.from(message.buttons || []).filter((button) => BUTTON_BITS.has(button));
}

export function inputPayload(buttons) {
  const normalized = decodeInputMask(encodeInputMask(buttons));
  // Keep one transition-version fallback so an already-open v53 tab can still
  // play with a freshly updated v54 tab. New clients consume the fixed mask.
  return { mask: encodeInputMask(normalized), buttons: normalized };
}
