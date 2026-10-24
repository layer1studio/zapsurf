import {
  BunkerSigner, parseBunkerInput, createNostrConnectURI,
  generateSecretKey, getPublicKey, nip05, nip19, nip49
} from './deps.js';
import { pool, NOSTRCONNECT_RELAYS } from './state.js';
import { setSession, openAuthUrl, runPasswordHooks } from './signer.js';
import { HEX64, bytesToHex } from './util.js';
import { nextPaint } from './dialogs.js';

const dialog = document.getElementById('login-dialog');
const errorEl = document.getElementById('login-error');
let nostrConnectAbort = null;

function setError(message) {
  errorEl.textContent = message;
}

function setLoginBusy(busy) {
  for (const control of dialog.querySelectorAll('button, input')) {
    if (control.id !== 'login-close') control.disabled = busy;
  }
}

export function openLoginDialog() {
  setError('');
  dialog.showModal();
}

function stopNostrConnect() {
  nostrConnectAbort?.abort();
  nostrConnectAbort = null;
  document.getElementById('nostrconnect').hidden = true;
}

function finishLogin(session, options) {
  stopNostrConnect();
  if (dialog.open) dialog.close();
  setSession(session, options);
}

async function runLogin(task) {
  setError('');
  setLoginBusy(true);
  try {
    await task();
  } catch (err) {
    setError(err?.message || String(err));
  } finally {
    setLoginBusy(false);
  }
}

function bunkerSession(pubkey, clientSecret, pointer) {
  if (!HEX64.test(pubkey || '')) throw new Error('Signer returned an invalid public key.');
  return {
    pubkey,
    method: 'bunker',
    // The client secret is a throwaway key the signer authorised; it is not your nostr key.
    bunker: { clientSecret: bytesToHex(clientSecret), pointer: { pubkey: pointer.pubkey, relays: pointer.relays } }
  };
}

document.getElementById('login-extension').addEventListener('click', () => runLogin(async () => {
  if (!window.nostr?.getPublicKey) throw new Error('No nostr extension found. Install Alby or nos2x, then reload.');
  const pubkey = await window.nostr.getPublicKey();
  if (!HEX64.test(pubkey || '')) throw new Error('Extension returned an invalid public key.');
  finishLogin({ pubkey, method: 'extension' });
}));

document.getElementById('bunker-form').addEventListener('submit', event => {
  event.preventDefault();
  runLogin(async () => {
    const pointer = await parseBunkerInput(document.getElementById('bunker-input').value.trim());
    if (!pointer) throw new Error('Not a valid bunker:// URL or NIP-05 signer address.');
    const clientSecret = generateSecretKey();
    const signer = BunkerSigner.fromBunker(clientSecret, pointer, { pool, onauth: openAuthUrl });
    await signer.connect({ name: 'ZapSurf', url: location.origin });
    const pubkey = await signer.getPublicKey();
    finishLogin(bunkerSession(pubkey, clientSecret, pointer), { signer });
  });
});

document.getElementById('nostrconnect-show').addEventListener('click', async () => {
  stopNostrConnect();
  setError('');
  const abort = new AbortController();
  nostrConnectAbort = abort;
  const clientSecret = generateSecretKey();
  const uri = createNostrConnectURI({
    clientPubkey: getPublicKey(clientSecret),
    relays: NOSTRCONNECT_RELAYS,
    secret: crypto.randomUUID().replaceAll('-', ''),
    perms: ['sign_event:1', 'sign_event:6', 'sign_event:7', 'sign_event:9734',
      'sign_event:13', 'sign_event:10050', 'sign_event:22242', 'nip44_encrypt', 'nip44_decrypt', 'nip04_decrypt',
      'sign_event:4', 'nip04_encrypt'],
    name: 'ZapSurf',
    url: location.origin
  });

  const { default: QRCode } = await import('https://esm.sh/qrcode@1.5.4');
  document.getElementById('nostrconnect-qr').src = await QRCode.toDataURL(uri, { margin: 1, width: 220 });
  document.getElementById('nostrconnect-uri').value = uri;
  document.getElementById('nostrconnect').hidden = false;

  try {
    const signer = await BunkerSigner.fromURI(clientSecret, uri, { pool, onauth: openAuthUrl }, abort.signal);
    const pubkey = await signer.getPublicKey();
    finishLogin(bunkerSession(pubkey, clientSecret, signer.bp), { signer });
  } catch (err) {
    if (!abort.signal.aborted) setError(`Signer connection failed: ${err?.message || err}`);
  }
});

document.getElementById('nostrconnect-copy').addEventListener('click', () => {
  navigator.clipboard.writeText(document.getElementById('nostrconnect-uri').value).catch(() => {});
});

document.getElementById('nsec-form').addEventListener('submit', event => {
  event.preventDefault();
  const keyInput = document.getElementById('nsec-input');
  const passwordInput = document.getElementById('nsec-password');
  runLogin(async () => {
    const raw = keyInput.value.trim();
    const password = passwordInput.value;
    if (password.length < 8) throw new Error('Password must be at least 8 characters.');

    let secretKey;
    let ncryptsec;
    if (raw.startsWith('ncryptsec1')) {
      setError('Decrypting…');
      await nextPaint();
      try {
        secretKey = nip49.decrypt(raw, password);
      } catch {
        throw new Error('Wrong password for this ncryptsec.');
      }
      ncryptsec = raw;
    } else {
      let decoded;
      try { decoded = nip19.decode(raw); } catch { decoded = null; }
      if (decoded?.type !== 'nsec') throw new Error('Not a valid nsec or ncryptsec.');
      secretKey = decoded.data;
      setError('Encrypting…');
      await nextPaint();
      ncryptsec = nip49.encrypt(secretKey, password);
    }
    keyInput.value = '';
    passwordInput.value = '';
    setError('');
    finishLogin({ pubkey: getPublicKey(secretKey), method: 'nsec', ncryptsec }, { secretKey });
    runPasswordHooks(password, 'key');
  });
});

document.getElementById('readonly-form').addEventListener('submit', event => {
  event.preventDefault();
  runLogin(async () => {
    const input = document.getElementById('readonly-input').value.trim();
    let pubkey = null;
    if (/^[0-9a-f]{64}$/i.test(input)) {
      pubkey = input.toLowerCase();
    } else if (input.includes('@') || (input.includes('.') && !input.startsWith('n'))) {
      pubkey = (await nip05.queryProfile(input))?.pubkey || null;
      if (!pubkey) throw new Error(`Could not resolve ${input}.`);
    } else {
      try {
        const { type, data } = nip19.decode(input.replace(/^nostr:/, ''));
        pubkey = type === 'npub' ? data : type === 'nprofile' ? data.pubkey : null;
      } catch { /* handled below */ }
    }
    if (!pubkey) throw new Error('Enter an npub, nprofile, hex pubkey or NIP-05 address.');
    finishLogin({ pubkey, method: 'readonly' });
  });
});

document.getElementById('login-close').addEventListener('click', () => dialog.close());
dialog.addEventListener('close', stopNostrConnect);
