import { settings, ZAP_PRESETS } from './state.js';
import { getNwc, connectNwc, disconnectNwc, hasWebln, walletLabel } from './wallet.js';
import { el, formatSats, emit } from './util.js';
import { toast, setBusy } from './dialogs.js';
import { getSession } from './signer.js';
import { discoverBlossomServers, getBlossomFallback, setBlossomFallback } from './blossom.js';

const dialog = document.getElementById('settings-dialog');
const defaultZapSelect = document.getElementById('default-zap');
const showProfileBadges = document.getElementById('show-profile-badges');
const walletStatus = document.getElementById('wallet-status');
const nwcForm = document.getElementById('nwc-form');
const nwcDisconnect = document.getElementById('nwc-disconnect');
const nwcStatus = document.getElementById('nwc-status');
const blossomForm = document.getElementById('blossom-form');
const blossomInput = document.getElementById('blossom-server');
const blossomStatus = document.getElementById('blossom-server-status');
const blossomError = document.getElementById('blossom-settings-error');
let blossomRenderId = 0;

async function renderBlossom(refresh = false) {
  const renderId = ++blossomRenderId;
  const pubkey = getSession()?.pubkey;
  blossomError.textContent = '';
  blossomInput.value = getBlossomFallback(pubkey);
  blossomForm.querySelectorAll('input, button').forEach(control => { control.disabled = !pubkey; });
  if (!pubkey) {
    blossomStatus.textContent = 'Log in to configure your image server.';
    return;
  }
  blossomStatus.textContent = 'Checking account servers...';
  try {
    const servers = await discoverBlossomServers(pubkey, { refresh });
    if (renderId !== blossomRenderId || getSession()?.pubkey !== pubkey) return;
    const fallback = getBlossomFallback(pubkey);
    blossomStatus.textContent = servers[0] ? `Account server: ${servers[0]}`
      : fallback ? `Fallback server: ${fallback}` : 'No account server found.';
  } catch {
    if (renderId === blossomRenderId) blossomStatus.textContent = 'Could not check account servers. Close and reopen Settings to retry.';
  }
}

defaultZapSelect.replaceChildren(
  el('option', { value: '0' }, 'Off: always ask'),
  ...ZAP_PRESETS.map(sats => el('option', { value: String(sats) }, `${formatSats(sats)} sats`)));

function render() {
  showProfileBadges.checked = settings.showProfileBadges;
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
  renderBlossom(true);
  dialog.showModal();
}

blossomForm.addEventListener('submit', event => {
  event.preventDefault();
  try {
    setBlossomFallback(getSession()?.pubkey, blossomInput.value);
    toast('Image server saved');
    renderBlossom();
  } catch (error) {
    blossomError.textContent = error.message;
  }
});
document.getElementById('blossom-clear').addEventListener('click', () => {
  if (!getSession()) return;
  setBlossomFallback(getSession().pubkey, '');
  renderBlossom();
});
document.addEventListener('zs:session', () => { if (dialog.open) renderBlossom(); });

defaultZapSelect.addEventListener('change', () => {
  settings.setDefaultZap(Number(defaultZapSelect.value));
  toast(settings.defaultZap ? `One-tap zaps: ${formatSats(settings.defaultZap)} sats` : 'One-tap zaps off');
});

showProfileBadges.addEventListener('change', () => {
  settings.setShowProfileBadges(showProfileBadges.checked);
  emit('zs:profile-badges');
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
