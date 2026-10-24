import { nip57, verifyEvent } from './deps.js';
import { pool, DEFAULT_RELAYS, ensureProfile } from './state.js';
import { getLnurlPay } from './lnurl.js';
import { validateZapReceipt, validateZapActivityReceipt } from './zap-validation.mjs';
import { chunk, now } from './util.js';
import { contentCache } from './cache.mjs';

const ZAP_WINDOW_SECS = 14 * 24 * 60 * 60;
const ZAP_SUMMARY_CACHE_MS = 12 * 60 * 60 * 1000;
const NOTE_ZAPS_CACHE_MS = 60_000;
const zapCountCache = new Map();
const zapSatsCache = new Map();
const providerPubkeyCache = new Map();
const providerQueue = [];
const MAX_PROVIDER_LOOKUPS = 8;
let activeProviderLookups = 0;

function bolt11AmountMsats(bolt11) {
  try {
    const msats = nip57.getSatoshisAmountFromBolt11(bolt11) * 1000;
    const rounded = Math.round(msats);
    return Number.isSafeInteger(rounded) && rounded > 0 && Math.abs(msats - rounded) < 1e-7 ? rounded : null;
  } catch {
    return null;
  }
}

function drainProviderQueue() {
  while (activeProviderLookups < MAX_PROVIDER_LOOKUPS && providerQueue.length) {
    const { recipient, resolve } = providerQueue.shift();
    activeProviderLookups++;
    Promise.resolve()
      .then(async () => {
        const profile = await ensureProfile(recipient);
        if (profile.event?.kind !== 0 || profile.event.pubkey !== recipient || !verifyEvent(profile.event)) return null;
        return (await getLnurlPay(profile)).nostrPubkey;
      })
      .catch(() => null)
      .then(resolve)
      .finally(() => {
        activeProviderLookups--;
        drainProviderQueue();
      });
  }
}

function providerPubkeyFor(recipient) {
  if (!providerPubkeyCache.has(recipient)) {
    const promise = new Promise(resolve => providerQueue.push({ recipient, resolve }));
    providerPubkeyCache.set(recipient, promise);
    drainProviderQueue();
  }
  return providerPubkeyCache.get(recipient);
}

export async function countRecentZapsSent(pubkeys, onProgress = () => {}) {
  const unique = [...new Set(pubkeys)];
  for (const pubkey of unique) restoreZapSummary(pubkey);
  const unknown = unique.filter(pk => !zapCountCache.has(pk));
  const since = now() - ZAP_WINDOW_SECS;
  let checked = 0;
  for (const pubkey of unique) {
    if (zapCountCache.has(pubkey)) onProgress(++checked, unique.length, 'validating', pubkey);
  }
  if (unknown.length) onProgress(checked, unique.length, 'fetching');
  else if (!unique.length) onProgress(0, 0, 'validating');
  const batchSize = Math.min(50, Math.max(1, Math.ceil(unknown.length / 4)));
  await Promise.all(chunk(unknown, batchSize).map(async batch => {
    let events;
    try {
      events = await pool.querySync(DEFAULT_RELAYS, { kinds: [9735], '#P': batch, since, limit: 5000 }, { maxWait: 8000 });
    } catch (err) {
      console.warn('Zap receipt query failed', err);
      for (const pubkey of batch) onProgress(++checked, unique.length, 'validating', pubkey);
      return;
    }

    onProgress(checked, unique.length, 'validating');
    const candidates = new Map(batch.map(pk => [pk, new Map()]));
    for (const receipt of events) {
      if (!Array.isArray(receipt.tags)) continue;
      const sender = receipt.tags.find(tag => Array.isArray(tag) && tag[0] === 'P')?.[1];
      if (!candidates.has(sender)) continue;
      candidates.get(sender).set(receipt.id, receipt);
    }

    await Promise.all(batch.map(async sender => {
      const byId = new Map();
      await Promise.all([...candidates.get(sender).values()].map(async receipt => {
        const zap = await validateZapReceipt(receipt, sender, {
          verifyEvent,
          getProviderPubkey: providerPubkeyFor,
          getBolt11AmountMsats: bolt11AmountMsats
        });
        if (zap) byId.set(receipt.id, zap.sats);
      }));
      zapCountCache.set(sender, byId.size);
      zapSatsCache.set(sender, [...byId.values()].reduce((sum, sats) => sum + sats, 0));
      contentCache.set(`zap-summary:${sender}`, {
        count: zapCountCache.get(sender),
        sats: zapSatsCache.get(sender)
      }, ZAP_SUMMARY_CACHE_MS);
      onProgress(++checked, unique.length, 'validating', sender);
    }));
  }));
  return new Map(unique.map(pk => [pk, zapCountCache.get(pk) || 0]));
}

export async function loadNoteZaps(note) {
  const cached = contentCache.get(`note-zaps:${note.id}`);
  if (Array.isArray(cached)) return cached;
  const receipts = await pool.querySync(DEFAULT_RELAYS, {
    kinds: [9735], '#e': [note.id], limit: 5000
  }, { maxWait: 8000 });
  const uniqueReceipts = [...new Map(receipts.map(receipt => [receipt.id, receipt])).values()];
  const zaps = await Promise.all(uniqueReceipts.map(receipt => validateZapForNote(receipt, note)));
  const verified = zaps.filter(Boolean).sort((a, b) => b.createdAt - a.createdAt);
  contentCache.set(`note-zaps:${note.id}`, verified, NOTE_ZAPS_CACHE_MS);
  return verified;
}

export function validateSentZap(receipt, sender) {
  return validateZapActivityReceipt(receipt, sender, {
    verifyEvent,
    getProviderPubkey: providerPubkeyFor,
    getBolt11AmountMsats: bolt11AmountMsats
  });
}

export async function validateZapForNote(receipt, note) {
  const tags = Array.isArray(receipt.tags) ? receipt.tags.filter(Array.isArray) : [];
  if (!tags.some(tag => tag[0] === 'e' && tag[1] === note.id)) return null;
  const sender = tags.find(tag => tag[0] === 'P')?.[1];
  const zap = await validateZapReceipt(receipt, sender, {
    verifyEvent,
    getProviderPubkey: providerPubkeyFor,
    getBolt11AmountMsats: bolt11AmountMsats
  });
  if (!zap || zap.recipient !== note.pubkey) return null;

  let request;
  try {
    request = JSON.parse(tags.find(tag => tag[0] === 'description')[1]);
  } catch {
    return null;
  }
  if (!request.tags?.some(tag => Array.isArray(tag) && tag[0] === 'e' && tag[1] === note.id)) return null;
  return { ...zap, createdAt: receipt.created_at, id: receipt.id };
}

export function cachedZapCount(pubkey) {
  restoreZapSummary(pubkey);
  return zapCountCache.get(pubkey) || 0;
}

export function cachedZapSats(pubkey) {
  restoreZapSummary(pubkey);
  return zapSatsCache.get(pubkey) || 0;
}

export function hasCachedZapSummary(pubkey) {
  restoreZapSummary(pubkey);
  return zapCountCache.has(pubkey) && zapSatsCache.has(pubkey);
}

function restoreZapSummary(pubkey) {
  if (zapCountCache.has(pubkey)) return;
  const summary = contentCache.get(`zap-summary:${pubkey}`);
  if (!Number.isSafeInteger(summary?.count) || summary.count < 0 || !Number.isSafeInteger(summary?.sats) || summary.sats < 0) return;
  zapCountCache.set(pubkey, summary.count);
  zapSatsCache.set(pubkey, summary.sats);
}

export function cacheZapSummary(pubkey, count, sats) {
  if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(sats) || sats < 0) return false;
  zapCountCache.set(pubkey, count);
  zapSatsCache.set(pubkey, sats);
  contentCache.set(`zap-summary:${pubkey}`, { count, sats }, ZAP_SUMMARY_CACHE_MS);
  return true;
}

export async function refreshRecentZapsSent(pubkeys, onProgress = () => {}) {
  for (const pubkey of new Set(pubkeys)) {
    zapCountCache.delete(pubkey);
    zapSatsCache.delete(pubkey);
    contentCache.remove(`zap-summary:${pubkey}`);
  }
  return countRecentZapsSent(pubkeys, onProgress);
}
