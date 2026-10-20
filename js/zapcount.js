import { nip57 } from './deps.js';
import { pool, DEFAULT_RELAYS } from './state.js';
import { chunk, now } from './util.js';

const ZAP_WINDOW_SECS = 14 * 24 * 60 * 60;
const zapCountCache = new Map();
const zapSatsCache = new Map();

function receiptSats(receipt) {
  try {
    return nip57.getSatoshisAmountFromBolt11(receipt.tags.find(t => t[0] === 'bolt11')?.[1] || '');
  } catch {
    return 0;
  }
}

export async function countRecentZapsSent(pubkeys, onProgress = () => {}) {
  const unknown = [...new Set(pubkeys)].filter(pk => !zapCountCache.has(pk));
  const since = now() - ZAP_WINDOW_SECS;
  let checked = 0;
  if (unknown.length) onProgress(0, unknown.length);
  await Promise.all(chunk(unknown, 50).map(async batch => {
    const receipts = new Map(batch.map(pk => [pk, new Map()]));
    try {
      const events = await pool.querySync(DEFAULT_RELAYS, { kinds: [9735], '#P': batch, since, limit: 5000 }, { maxWait: 8000 });
      for (const receipt of events) {
        const sender = receipt.tags.find(t => t[0] === 'P')?.[1];
        if (!receipts.has(sender)) continue;
        // Only count receipts whose embedded zap request was signed by the sender.
        try {
          const description = receipt.tags.find(t => t[0] === 'description')?.[1];
          if (JSON.parse(description).pubkey !== sender) continue;
        } catch {
          continue;
        }
        receipts.get(sender).set(receipt.id, receiptSats(receipt));
      }
      for (const [pk, byId] of receipts) {
        zapCountCache.set(pk, byId.size);
        zapSatsCache.set(pk, [...byId.values()].reduce((sum, sats) => sum + sats, 0));
      }
    } catch (err) {
      console.warn('Zap receipt query failed', err);
    }
    checked += batch.length;
    onProgress(checked, unknown.length);
  }));
  return new Map(pubkeys.map(pk => [pk, zapCountCache.get(pk) || 0]));
}

export function cachedZapCount(pubkey) {
  return zapCountCache.get(pubkey) || 0;
}

export function cachedZapSats(pubkey) {
  return zapSatsCache.get(pubkey) || 0;
}
