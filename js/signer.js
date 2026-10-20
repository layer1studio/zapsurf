import { BunkerSigner, finalizeEvent, verifyEvent, nip49 } from './deps.js';
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
  const password = await promptPassword({
    title: 'Unlock your key',
    message: 'Enter the password you used when you logged in with your private key.'
  });
  toast('Unlocking…');
  await nextPaint();
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
    return { signEvent: template => window.nostr.signEvent(template) };
  }
  if (session.method === 'bunker') {
    if (!liveSigner) {
      liveSigner = BunkerSigner.fromBunker(hexToBytes(session.bunker.clientSecret), session.bunker.pointer, { pool, onauth: openAuthUrl });
    }
    return liveSigner;
  }
  if (!unlockedKey) await unlockKey();
  return { signEvent: template => finalizeEvent(template, unlockedKey) };
}

export async function signEvent(template) {
  const signer = await getSigner();
  const signed = await signer.signEvent({ ...template, pubkey: session.pubkey });
  if (signed?.pubkey !== session.pubkey || !verifyEvent(signed)) {
    throw new Error('The signer returned an invalid event.');
  }
  return signed;
}
