import { BunkerSigner, finalizeEvent, verifyEvent, nip04, nip44, nip49 } from './deps.js';
import { pool } from './state.js';
import { HEX64, hexToBytes, safeHttpUrl, store, emit } from './util.js';
import { promptPassword, toast, nextPaint } from './dialogs.js';

const SESSION_KEY = 'zs-session';

export const LOGIN_METHODS = {
  extension: 'Extension',
  bunker: 'Remote signer',
  nsec: 'Encrypted key',
  readonly: 'Read-only'
};

let session = loadSession();
let liveSigner = null;
let unlockedKey = null;
const passwordHooks = [];

function loadSession() {
  const stored = store.get(SESSION_KEY);
  if (!HEX64.test(stored?.pubkey) || !LOGIN_METHODS[stored.method]) {
    store.remove(SESSION_KEY);
    return null;
  }
  if (stored.method === 'nsec' && typeof stored.ncryptsec !== 'string') return null;
  if (stored.method === 'bunker' && (!HEX64.test(stored.bunker?.clientSecret) || !HEX64.test(stored.bunker?.pointer?.pubkey))) return null;
  return stored;
}

export const getSession = () => session;
export const canSign = () => Boolean(session && session.method !== 'readonly');
export const isOwn = pubkey => Boolean(session && pubkey === session.pubkey);

export function openAuthUrl(url) {
  const safe = safeHttpUrl(url);
  if (safe) window.open(safe, '_blank', 'noopener,noreferrer');
}

export function setSession(newSession, { signer = null, secretKey = null } = {}) {
  liveSigner?.close?.().catch(() => {});
  liveSigner = signer;
  unlockedKey = secretKey;
  session = newSession;
  if (session) store.set(SESSION_KEY, session);
  else store.remove(SESSION_KEY);
  emit('zs:session', session);
}

export function logout() {
  setSession(null);
}

export function onPasswordUnlocked(hook) {
  passwordHooks.push(hook);
}

export function runPasswordHooks(password, source) {
  for (const hook of passwordHooks) hook(password, source);
}

export function tryUnlockKeyWith(password) {
  if (unlockedKey || session?.method !== 'nsec') return;
  try { unlockedKey = nip49.decrypt(session.ncryptsec, password); } catch { /* different password */ }
}

onPasswordUnlocked((password, source) => {
  if (source !== 'key') tryUnlockKeyWith(password);
});

async function unlockKey() {
  const currentSession = session;
  const password = await promptPassword({
    title: 'Unlock your key',
    message: 'Enter the password you used when you logged in with your private key.'
  });
  toast('Unlocking…');
  await nextPaint();
  if (session !== currentSession) throw new Error('Account changed. Try again.');
  try {
    unlockedKey = nip49.decrypt(session.ncryptsec, password);
  } catch {
    throw new Error('Wrong password.');
  }
  runPasswordHooks(password, 'key');
}

async function getSigner() {
  if (!session) {
    emit('zs:need-login');
    throw new Error('Log in to do that.');
  }
  if (session.method === 'readonly') {
    throw new Error('You are logged in read-only. Log in with a signer to post or zap.');
  }
  if (session.method === 'extension') {
    if (!window.nostr?.signEvent) throw new Error('Your nostr extension is not available.');
    const extension = window.nostr;
    return {
      signEvent: template => extension.signEvent(template),
      nip44Encrypt: extension.nip44?.encrypt && ((pubkey, text) => extension.nip44.encrypt(pubkey, text)),
      nip44Decrypt: extension.nip44?.decrypt && ((pubkey, text) => extension.nip44.decrypt(pubkey, text)),
      nip04Encrypt: extension.nip04?.encrypt && ((pubkey, text) => extension.nip04.encrypt(pubkey, text)),
      nip04Decrypt: extension.nip04?.decrypt && ((pubkey, text) => extension.nip04.decrypt(pubkey, text))
    };
  }
  if (session.method === 'bunker') {
    if (!liveSigner) {
      liveSigner = BunkerSigner.fromBunker(hexToBytes(session.bunker.clientSecret), session.bunker.pointer, { pool, onauth: openAuthUrl });
    }
    return liveSigner;
  }
  if (!unlockedKey) await unlockKey();
  const key = unlockedKey;
  return {
    signEvent: template => finalizeEvent(template, key),
    nip44Encrypt: (pubkey, text) => nip44.v2.encrypt(text, nip44.v2.utils.getConversationKey(key, pubkey)),
    nip44Decrypt: (pubkey, text) => nip44.v2.decrypt(text, nip44.v2.utils.getConversationKey(key, pubkey)),
    nip04Encrypt: (pubkey, text) => nip04.encrypt(key, pubkey, text),
    nip04Decrypt: (pubkey, text) => nip04.decrypt(key, pubkey, text)
  };
}

export async function signEvent(template) {
  const currentSession = session;
  const signer = await getSigner();
  if (session !== currentSession) throw new Error('Account changed. Try again.');
  const signed = await signer.signEvent({ ...template, pubkey: currentSession.pubkey });
  if (session !== currentSession) throw new Error('Account changed. Try again.');
  if (signed?.pubkey !== currentSession.pubkey || !verifyEvent(signed)) {
    throw new Error('The signer returned an invalid event.');
  }
  return signed;
}

async function cryptMessage(method, pubkey, text) {
  if (!HEX64.test(pubkey) || typeof text !== 'string') throw new Error('Invalid encryption request.');
  const currentSession = session;
  const signer = await getSigner().catch(error => { error.dmSignerFailure = true; throw error; });
  if (session !== currentSession) throw new Error('Account changed. Try again.');
  if (typeof signer[method] !== 'function') {
    const error = new Error(method.startsWith('nip04') ? 'Your signer does not support this legacy NIP-04 operation.'
      : 'Your signer must support NIP-44 private messages.');
    error.dmSignerFailure = true;
    throw error;
  }
  let result;
  try {
    result = await signer[method](pubkey, text);
  } catch (error) {
    if (/denied|rejected|cancelled|permission|not supported/i.test(error?.message || String(error))) {
      const failure = new Error(error?.message || String(error));
      failure.dmSignerFailure = true;
      throw failure;
    }
    throw error;
  }
  if (session !== currentSession) throw new Error('Account changed. Try again.');
  if (typeof result !== 'string') throw new Error('The signer returned an invalid encryption result.');
  return result;
}

export const encryptMessage = (pubkey, text) => cryptMessage('nip44Encrypt', pubkey, text);
export const decryptMessage = (pubkey, text) => cryptMessage('nip44Decrypt', pubkey, text);
export const decryptLegacyMessage = (pubkey, text) => cryptMessage('nip04Decrypt', pubkey, text);
export const encryptLegacyMessage = (pubkey, text) => cryptMessage('nip04Encrypt', pubkey, text);

export async function prepareMessageSigner() {
  const currentSession = session;
  const signer = await getSigner();
  if (session !== currentSession) throw new Error('Account changed. Try again.');
  const secure = typeof signer.nip44Encrypt === 'function' && typeof signer.nip44Decrypt === 'function';
  const legacy = typeof signer.nip04Encrypt === 'function' && typeof signer.nip04Decrypt === 'function';
  if (!secure && !legacy) throw new Error('Your signer must support NIP-44 or legacy NIP-04 messages.');
  return { secure, legacy };
}
