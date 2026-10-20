import { settings, ZAP_PRESETS } from './state.js';
import { getNwc, connectNwc, disconnectNwc, hasWebln, walletLabel } from './wallet.js';
import { el, formatSats } from './util.js';
import { toast, setBusy } from './dialogs.js';

const dialog = document.getElementById('settings-dialog');
const defaultZapSelect = document.getElementById('default-zap');
const walletStatus = document.getElementById('wallet-status');
const nwcForm = document.getElementById('nwc-form');
const nwcDisconnect = document.getElementById('nwc-disconnect');
const nwcStatus = document.getElementById('nwc-status');

defaultZapSelect.replaceChildren(
  el('option', { value: '0' }, 'Off: always ask'),
  ...ZAP_PRESETS.map(sats => el('option', { value: String(sats) }, `${formatSats(sats)} sats`)));

function render() {
  const value = String(settings.defaultZap);
  if (![...defaultZapSelect.options].some(o => o.value === value)) {
    defaultZapSelect.append(el('option', { value }, `${formatSats(settings.defaultZap)} sats`));
  }
  defaultZapSelect.value = value;
  const connected = Boolean(getNwc());
  walletStatus.textContent = `Paying with: ${walletLabel()}${!connected && hasWebln() ? '. Connect NWC to use it instead.' : ''}`;
  nwcForm.hidden = connected;
  nwcDisconnect.hidden = !connected;
  nwcStatus.textContent = '';
}

export function openSettings() {
  render();
  dialog.showModal();
}

defaultZapSelect.addEventListener('change', () => {
  settings.setDefaultZap(Number(defaultZapSelect.value));
  toast(settings.defaultZap ? `One-tap zaps: ${formatSats(settings.defaultZap)} sats` : 'One-tap zaps off');
});

nwcForm.addEventListener('submit', async event => {
  event.preventDefault();
  const uriInput = document.getElementById('nwc-uri');
  const passwordInput = document.getElementById('nwc-password');
  setBusy(nwcForm, true);
  nwcStatus.textContent = 'Encrypting…';
  try {
    await connectNwc(uriInput.value.trim(), passwordInput.value);
    uriInput.value = '';
    passwordInput.value = '';
    toast('Wallet connected');
    render();
  } catch (err) {
    nwcStatus.textContent = err.message || String(err);
  } finally {
    setBusy(nwcForm, false);
  }
});

nwcDisconnect.addEventListener('click', () => {
  disconnectNwc();
  toast('Wallet disconnected');
  render();
});

document.getElementById('settings-close').addEventListener('click', () => dialog.close());
