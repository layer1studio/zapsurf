import { nip04, nip44, nip47, nip49, finalizeEvent, getPublicKey } from './deps.js';
import { pool } from './state.js';
import { HEX64, hexToBytes, store, now } from './util.js';
import { promptPassword, toast, nextPaint } from './dialogs.js';
import { onPasswordUnlocked, runPasswordHooks } from './signer.js';

const NWC_KEY = 'zs-nwc';
const NWC_TIMEOUT_MS = 60_000;
const ARK_BALANCE_RE = /insuffi?e?cient\s+ark\s+balance/i;
let nwcSecret = null;

export function getNwc() {
  const stored = store.get(NWC_KEY);
  if (!HEX64.test(stored?.pubkey) || !Array.isArray(stored.relays) || typeof stored.ncryptsec !== 'string') return null;
  return stored;
}

export const hasWebln = () => Boolean(window.webln?.sendPayment);

export function walletLabel() {
  if (getNwc()) return 'Nostr Wallet Connect';
  if (hasWebln()) return 'Browser wallet (WebLN)';
  return 'None, invoices shown as QR codes';
}

export async function connectNwc(uri, password) {
  if (!uri.startsWith('nostr+walletconnect://')) throw new Error('That is not a nostr+walletconnect:// connection string.');
  let parsed;
  try { parsed = nip47.parseConnectionString(uri); } catch { parsed = null; }
  const relays = (parsed?.relays || []).filter(r => /^wss:\/\//.test(r));
  if (!HEX64.test(parsed?.pubkey || '') || !HEX64.test(parsed?.secret || '') || relays.length === 0) {
    throw new Error('The connection string is missing its wallet key, relay or secret.');
  }
  if (password.length < 8) throw new Error('Password must be at least 8 characters.');
  await nextPaint();
  const secret = hexToBytes(parsed.secret);
  store.set(NWC_KEY, { pubkey: parsed.pubkey, relays, ncryptsec: nip49.encrypt(secret, password) });
  nwcSecret = secret;
}

export function disconnectNwc() {
  store.remove(NWC_KEY);
  nwcSecret = null;
}

onPasswordUnlocked((password, source) => {
  const nwc = getNwc();
  if (source === 'wallet' || nwcSecret || !nwc) return;
  try { nwcSecret = nip49.decrypt(nwc.ncryptsec, password); } catch { /* different password */ }
});

async function unlockNwc(nwc) {
  if (nwcSecret) return nwcSecret;
  const password = await promptPassword({
    title: 'Unlock your wallet',
    message: 'Enter the password you chose when connecting your wallet.'
  });
  toast('Unlocking wallet…');
  await nextPaint();
  try {
    nwcSecret = nip49.decrypt(nwc.ncryptsec, password);
  } catch {
    throw new Error('Wrong wallet password.');
  }
  runPasswordHooks(password, 'wallet');
  return nwcSecret;
}

async function walletSupportsNip44(nwc) {
  const info = await pool.get(nwc.relays, { kinds: [13194], authors: [nwc.pubkey] }, { maxWait: 4000 }).catch(() => null);
  const schemes = info?.tags.find(t => t[0] === 'encryption')?.[1]?.split(/\s+/) || [];
  return schemes.includes('nip44_v2');
}

async function nwcPayInvoice(nwc, invoice) {
  const secret = await unlockNwc(nwc);
  const useNip44 = await walletSupportsNip44(nwc);
  const payload = JSON.stringify({ method: 'pay_invoice', params: { invoice } });
  const conversationKey = useNip44 ? nip44.getConversationKey(secret, nwc.pubkey) : null;
  const content = useNip44 ? nip44.encrypt(payload, conversationKey) : await nip04.encrypt(secret, nwc.pubkey, payload);
  const tags = [['p', nwc.pubkey]];
  if (useNip44) tags.push(['encryption', 'nip44_v2']);
  const request = finalizeEvent({ kind: 23194, created_at: now(), tags, content }, secret);

  const decrypt = async data => {
    try {
      return useNip44 ? nip44.decrypt(data, conversationKey) : await nip04.decrypt(secret, nwc.pubkey, data);
    } catch {
      return useNip44 ? nip04.decrypt(secret, nwc.pubkey, data) : nip44.decrypt(data, nip44.getConversationKey(secret, nwc.pubkey));
    }
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sub.close();
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error('Your wallet did not respond in time.')), NWC_TIMEOUT_MS);
    const sub = pool.subscribe(nwc.relays, {
      kinds: [23195], authors: [nwc.pubkey], '#p': [getPublicKey(secret)], '#e': [request.id]
    }, {
      onevent: async event => {
        try {
          const response = JSON.parse(await decrypt(event.content));
          if (response.error) {
            const message = response.error.message || response.error.code || 'Wallet payment failed.';
            finish(reject, new Error(ARK_BALANCE_RE.test(message)
              ? `${message} Coinos returned this from your Nostr Wallet Connect wallet. Add sats to your Coinos Ark balance, swap/receive into Ark if Coinos shows the funds in another balance, or disconnect NWC to scan/copy the invoice with another Lightning wallet.`
              : message));
          } else finish(resolve, response.result);
        } catch {
          finish(reject, new Error('Could not read the wallet response.'));
        }
      }
    });
    Promise.any(pool.publish(nwc.relays, request))
      .catch(() => finish(reject, new Error('Could not reach your wallet relay.')));
  });
}

// Returns false when no wallet is configured, so the caller can fall back to a QR invoice.
export async function payInvoice(invoice) {
  const nwc = getNwc();
  if (nwc) {
    await nwcPayInvoice(nwc, invoice);
    return true;
  }
  if (hasWebln()) {
    await window.webln.enable();
    await window.webln.sendPayment(invoice);
    return true;
  }
  return false;
}
