import { pool, DEFAULT_RELAYS, PROFILE_RELAYS } from './state.js';
import { chunk } from './util.js';

const MAX_RELAYS_PER_AUTHOR = 4;
const relayLists = new Map();

export function normaliseRelay(url) {
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== 'wss:') return null;
    return `wss://${parsed.host.toLowerCase()}${parsed.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

export const uniqueRelays = (...lists) => [...new Set(lists.flat().map(normaliseRelay).filter(Boolean))];

function parseRelayList(event) {
  const read = [];
  const write = [];
  for (const tag of event?.tags || []) {
    if (tag[0] !== 'r') continue;
    const url = normaliseRelay(tag[1] || '');
    if (!url) continue;
    if (tag[2] !== 'write') read.push(url);
    if (tag[2] !== 'read') write.push(url);
  }
  return { read, write };
}

export async function fetchRelayLists(pubkeys) {
  const missing = [...new Set(pubkeys)].filter(pk => !relayLists.has(pk));
  await Promise.all(chunk(missing, 200).map(async authors => {
    const events = await pool.querySync(PROFILE_RELAYS, { kinds: [10002], authors }, { maxWait: 6000 }).catch(() => []);
    const newest = new Map();
    for (const ev of events) {
      if (!newest.has(ev.pubkey) || newest.get(ev.pubkey).created_at < ev.created_at) newest.set(ev.pubkey, ev);
    }
    for (const pk of authors) relayLists.set(pk, parseRelayList(newest.get(pk)));
  }));
  return new Map(pubkeys.map(pk => [pk, relayLists.get(pk)]));
}

export async function getWriteRelays(pubkey, max = 8) {
  const list = (await fetchRelayLists([pubkey])).get(pubkey);
  return uniqueRelays(list.write, DEFAULT_RELAYS).slice(0, max);
}

export async function getReadRelays(pubkey, max = 8) {
  const list = (await fetchRelayLists([pubkey])).get(pubkey);
  return uniqueRelays(list.read, DEFAULT_RELAYS).slice(0, max);
}

// Outbox model: query each author on the relays they publish to, using as few relays as practical.
export async function planOutbox(authors, maxRelays = 12) {
  const lists = await fetchRelayLists(authors);
  const relayAuthors = new Map();
  for (const pk of authors) {
    const write = lists.get(pk)?.write.slice(0, MAX_RELAYS_PER_AUTHOR) || [];
    for (const relay of write.length ? write : DEFAULT_RELAYS) {
      if (!relayAuthors.has(relay)) relayAuthors.set(relay, []);
      relayAuthors.get(relay).push(pk);
    }
  }
  const coverage = new Map();
  const plan = new Map();
  for (const [relay, pks] of [...relayAuthors].sort((a, b) => b[1].length - a[1].length)) {
    if (plan.size >= maxRelays) break;
    if (!pks.some(pk => (coverage.get(pk) || 0) < 2)) continue;
    plan.set(relay, pks);
    for (const pk of pks) coverage.set(pk, (coverage.get(pk) || 0) + 1);
  }
  const uncovered = authors.filter(pk => !coverage.has(pk));
  for (const relay of DEFAULT_RELAYS) {
    if (uncovered.length) plan.set(relay, [...new Set([...(plan.get(relay) || []), ...uncovered])]);
  }
  return plan;
}
