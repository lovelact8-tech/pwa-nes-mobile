import { hydrateIcons } from './icons.js';

export function setButtonLabel(button, label) {
  button.setAttribute('aria-label', label);
  button.setAttribute('title', label);
  if (button.classList.contains('iconOnly') || button.id === 'fullscreenBtn') return;
  const actionTitle = button.querySelector('.menuAction strong');
  if (actionTitle) {
    actionTitle.textContent = label;
    return;
  }
  const labelNode = button.querySelector('.dynamicLabel') || document.createElement('span');
  labelNode.className = 'dynamicLabel';
  labelNode.textContent = label;
  if (!labelNode.isConnected) {
    Array.from(button.childNodes).forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) node.remove();
    });
    button.appendChild(labelNode);
  }
}

export function setButtonIcon(button, name, label) {
  button.dataset.icon = name;
  button.querySelector('svg')?.remove();
  hydrateIcons(button);
  setButtonLabel(button, label);
}
