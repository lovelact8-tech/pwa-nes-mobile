const icons = {
  play: '<path d="m8 5 11 7-11 7z"/>',
  folder: '<path d="M3 7h6l2 2h10v10H3z"/><path d="M3 7V5h6l2 2"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="m16 16 4 4"/>',
  gamepad: '<path d="M7 9h10a5 5 0 0 1 4.7 6.7l-.8 2.2a2 2 0 0 1-3.2.8L15 16H9l-2.7 2.7a2 2 0 0 1-3.2-.8l-.8-2.2A5 5 0 0 1 7 9Z"/><path d="M7 12v4M5 14h4M17 13h.01M19 15h.01"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1"/><path d="M14 11a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 12 20l1.1-1.1"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10 3v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/>',
  volume: '<path d="M5 10v4h4l5 4V6l-5 4z"/><path d="M17 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  expand: '<path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/>',
  save: '<path d="M5 3h12l2 2v16H5z"/><path d="M8 3v6h8V3M8 16h8"/>',
  cloud: '<path d="M7 18h11a4 4 0 0 0 .6-8A6 6 0 0 0 7.2 8.4 4.8 4.8 0 0 0 7 18Z"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
  wifi: '<path d="M5 12.5a10 10 0 0 1 14 0M8 16a6 6 0 0 1 8 0M11 19.5a2 2 0 0 1 2 0"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  rotate: '<path d="M4 4v6h6M20 20v-6h-6"/><path d="M5.1 15a8 8 0 0 0 13.2 2M18.9 9A8 8 0 0 0 5.7 7"/>',
  sliders: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10M14 4v6M6 14v6"/>',
  power: '<path d="M12 2v10"/><path d="M6.3 5.7a8 8 0 1 0 11.4 0"/>',
  star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-2.9-5.6 2.9 1.1-6.2L3 9.6l6.2-.9z"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5M4 20h16"/>',
  download: '<path d="M12 4v12M7 11l5 5 5-5M4 20h16"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6"/>',
};

export function icon(name, className = 'icon') {
  const body = icons[name] || icons.gamepad;
  return `<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
}

export function hydrateIcons(root = document) {
  const elements = root.matches?.('[data-icon]')
    ? [root, ...root.querySelectorAll('[data-icon]')]
    : root.querySelectorAll('[data-icon]');
  elements.forEach((element) => {
    if (element.querySelector('svg')) return;
    element.insertAdjacentHTML('afterbegin', icon(element.dataset.icon));
  });
}
