import { bech32 } from './deps.js';

const HTTP_TIMEOUT_MS = 10_000;
const LUD16 = /^([a-z0-9._+-]+)@([a-z0-9.-]+\.[a-z]{2,})$/i;
const HEX_PUBKEY = /^[0-9a-f]{64}$/i;

export async function fetchJson(url) {
  if (new URL(url).protocol !== 'https:') throw new Error('Lightning address server must use https.');
  const res = await fetch(url, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Lightning server returned HTTP ${res.status}.`);
  const data = await res.json();
  if (data?.status === 'ERROR') throw new Error(data.reason || 'Lightning server error.');
  return data;
}

export async function getLnurlPay(profile) {
  let payUrl;
  if (profile.lud16) {
    const match = LUD16.exec(profile.lud16.trim());
    if (!match) throw new Error(`${profile.name} has an invalid Lightning address.`);
    payUrl = `https://${match[2]}/.well-known/lnurlp/${encodeURIComponent(match[1])}`;
  } else if (profile.lud06) {
    let decoded;
    try {
      decoded = bech32.decode(profile.lud06.trim(), 1000);
    } catch {
      throw new Error(`${profile.name} has an invalid Lightning address.`);
    }
    if (decoded.prefix !== 'lnurl') {
      throw new Error(`${profile.name} has an invalid Lightning address.`);
    }
    payUrl = new TextDecoder().decode(bech32.fromWords(decoded.words));
  } else {
    throw new Error(`${profile.name} has no Lightning address.`);
  }

  const data = await fetchJson(payUrl);
  if (!data.allowsNostr || !HEX_PUBKEY.test(data.nostrPubkey || '')) {
    throw new Error(`${profile.name}'s wallet does not accept nostr zaps.`);
  }
  if (typeof data.callback !== 'string') throw new Error(`${profile.name}'s wallet returned no zap callback.`);
  return { ...data, nostrPubkey: data.nostrPubkey.toLowerCase(), payUrl };
}