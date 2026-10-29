import { t } from './i18n.js';
import { icon } from './icons.js';

// A native modal provides focus trapping, Escape handling and focus return.
// Resolve null on dismissal, preserving window.prompt's existing contract.
export function requestWorkspaceName(message, initialValue = '') {
  const existing = document.querySelector('.workspace-dialog');
  if (existing) return Promise.resolve(null);
  const dialog = document.createElement('dialog');
  dialog.className = 'workspace-dialog';
  dialog.setAttribute('aria-labelledby', 'workspace-dialog-title');
  const form = document.createElement('form');
  form.method = 'dialog';
  form.innerHTML = `<div class="dialog-symbol">${icon('edit')}</div><h2 id="workspace-dialog-title"></h2><label for="workspace-dialog-name"></label><input id="workspace-dialog-name" name="name" type="text" autocomplete="off" maxlength="200"><div class="workspace-dialog-actions"><button class="secondary-btn" value="cancel"></button><button class="primary-btn" value="submit"></button></div>`;
  form.querySelector('h2').textContent = t('workspace.nameDialogTitle');
  form.querySelector('label').textContent = message;
  const input = form.querySelector('input');
  input.value = initialValue;
  form.querySelector('[value="cancel"]').textContent = t('workspace.cancel');
  form.querySelector('[value="submit"]').textContent = t('workspace.continue');
  dialog.append(form);
  document.body.append(dialog);
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => {
      const value = dialog.returnValue === 'submit' ? input.value : null;
      dialog.remove();
      resolve(value);
    }, { once: true });
    dialog.addEventListener('click', (event) => {
      if (event.target !== dialog) return;
      const bounds = dialog.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close('cancel');
    });
    // Enter in the input must choose the primary action, not the first button.
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      dialog.close(event.submitter?.value === 'cancel' ? 'cancel' : 'submit');
    });
    form.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && event.target === input && !event.isComposing) {
        event.preventDefault();
        dialog.close('submit');
      }
    });
    dialog.showModal();
    input.focus();
    input.select();
  });
}
