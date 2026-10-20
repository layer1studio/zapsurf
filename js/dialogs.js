let toastTimer = null;

document.getElementById('unlock-cancel').addEventListener('click', () => document.getElementById('unlock-dialog').close());

export function toast(message, kind = 'info') {
  const node = document.getElementById('toast');
  node.textContent = message;
  node.dataset.kind = kind;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, kind === 'error' ? 6000 : 3500);
}

export function promptPassword({ title, message }) {
  const dialog = document.getElementById('unlock-dialog');
  const form = document.getElementById('unlock-form');
  const input = document.getElementById('unlock-password');
  document.getElementById('unlock-title').textContent = title;
  document.getElementById('unlock-message').textContent = message;
  input.value = '';

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      form.removeEventListener('submit', onSubmit);
      dialog.removeEventListener('close', onClose);
    };
    const onSubmit = event => {
      event.preventDefault();
      const password = input.value;
      input.value = '';
      cleanup();
      dialog.close();
      resolve(password);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('Unlock cancelled'));
    };
    form.addEventListener('submit', onSubmit);
    dialog.addEventListener('close', onClose);
    dialog.showModal();
    input.focus();
  });
}

export function setBusy(container, busy) {
  for (const control of container.querySelectorAll('button, input, textarea, select')) {
    if (!control.dataset.keepEnabled) control.disabled = busy;
  }
}

// scrypt in NIP-49 blocks the main thread; yield first so status text paints.
export const nextPaint = () => new Promise(resolve => setTimeout(resolve, 30));
