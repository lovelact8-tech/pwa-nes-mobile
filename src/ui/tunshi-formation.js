import {
  readTunshiPostgameFormation,
  setTunshiPostgameFormation,
  supportsTunshiPostgameFormation,
  tunshiPostgameFormationLimits,
  tunshiPostgameRoster,
} from '../emulator/tunshi-postgame-formation.js';

export function createTunshiFormationController({
  button,
  dialog,
  closeButton,
  cancelButton,
  confirmButton,
  rosterElement,
  statusElement,
  getNes,
  canEdit = () => true,
  onBeforeOpen = () => {},
  onApplied = () => {},
}) {
  let selectedIds = [];

  const render = () => {
    rosterElement.replaceChildren();
    for (const officer of tunshiPostgameRoster) {
      const order = selectedIds.indexOf(officer.id);
      const row = document.createElement('button');
      row.type = 'button';
      row.className = `formationOfficer${order >= 0 ? ' selected' : ''}`;
      row.dataset.officerId = String(officer.id);
      row.innerHTML = `<span class="formationOrder">${order >= 0 ? order + 1 : '+'}</span><span><strong>${officer.name}</strong><small>${officer.role}</small></span>`;
      row.addEventListener('click', () => {
        const current = selectedIds.indexOf(officer.id);
        if (current >= 0) selectedIds.splice(current, 1);
        else if (selectedIds.length < tunshiPostgameFormationLimits.max) selectedIds.push(officer.id);
        else {
          statusElement.textContent = `最多只能选 ${tunshiPostgameFormationLimits.max} 人，请先让一人离队`;
          return;
        }
        statusElement.textContent = `已选 ${selectedIds.length}/${tunshiPostgameFormationLimits.max} 人 · 数字是出战顺序`;
        render();
      });
      rosterElement.append(row);
    }
    confirmButton.disabled = selectedIds.length < tunshiPostgameFormationLimits.min || !canEdit();
  };

  const setEnabled = (enabled) => {
    button.classList.toggle('hidden', !enabled);
    if (!enabled && dialog.open) dialog.close();
  };

  const open = () => {
    const nes = getNes();
    if (!supportsTunshiPostgameFormation(nes)) return;
    onBeforeOpen();
    selectedIds = readTunshiPostgameFormation(nes).map(({ id }) => id);
    if (!selectedIds.length) selectedIds = tunshiPostgameRoster.slice(0, 3).map(({ id }) => id);
    statusElement.textContent = canEdit()
      ? `已选 ${selectedIds.length}/${tunshiPostgameFormationLimits.max} 人 · 点击加入或离队`
      : '2P 只能查看队伍，请由 1P 调整';
    render();
    dialog.showModal();
  };

  button.addEventListener('click', open);
  closeButton.addEventListener('click', () => dialog.close());
  cancelButton.addEventListener('click', () => dialog.close());
  confirmButton.addEventListener('click', () => {
    if (!canEdit()) return;
    try {
      const nes = getNes();
      setTunshiPostgameFormation(nes, selectedIds);
      dialog.close();
      onApplied(selectedIds.slice());
    } catch (error) {
      statusElement.textContent = error.message || '编队失败';
    }
  });

  setEnabled(false);
  return { setEnabled, open, refresh: render };
}
