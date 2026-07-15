export function createDialogController({ settingsDialog, dismissibleDialogs = [] }) {
  const closeSettings = () => {
    settingsDialog.removeAttribute('open');
    document.body.classList.remove('settings-open');
  };

  const openSettings = () => {
    settingsDialog.setAttribute('open', '');
    document.body.classList.add('settings-open');
  };

  const closeFromBackdrop = (event) => {
    const dialog = event.currentTarget;
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    const inside = event.clientX >= rect.left && event.clientX <= rect.right
      && event.clientY >= rect.top && event.clientY <= rect.bottom;
    if (!inside) dialog.close();
  };

  dismissibleDialogs.forEach((dialog) => dialog.addEventListener('click', closeFromBackdrop));

  document.addEventListener('click', (event) => {
    if (!settingsDialog.hasAttribute('open')) return;
    if (event.target.closest?.('#settingsDialog, #settingsBtn')) return;
    event.preventDefault();
    event.stopPropagation();
    closeSettings();
  }, true);

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && settingsDialog.hasAttribute('open')) closeSettings();
  });

  return { openSettings, closeSettings };
}
