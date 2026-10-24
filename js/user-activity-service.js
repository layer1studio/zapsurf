import { verifyEvent } from './deps.js';
import { pool, DEFAULT_RELAYS, PROFILE_RELAYS } from './state.js';
import { getWriteRelays, fetchRelayLists, uniqueRelays } from './relays.js';
import { ensureProfiles } from './notes.js?v=0.4.0';
import { validateSentZap } from './zapcount.js';
import { chunk, now } from './util.js';
import { classifyUserActivity, createActivityPager, followActivity, mergeActivity } from './user-activity.mjs';

const HEX = /^[0-9a-f]{64}$/i;

function verified(event) {
  try { return verifyEvent(event); } catch { return false; }
}

function queryRelay(relay, filter) {
  return new Promise((resolve, reject) => {
    const events = new Map();
    let subscription;
    let finished = false;
    const finish = error => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      subscription?.close();
      if (error) reject(error);
      else resolve([...events.values()]);
    };
    const timer = setTimeout(() => finish(new Error('Relay query timed out.')), 10000);
    try {
      subscription = pool.subscribeMany([relay], filter, {
        onevent: event => { if (verified(event)) events.set(event.id, event); },
        oneose: () => finish(),
        onclose: () => finish(new Error('Relay closed before completing the query.'))
      });
      if (finished) subscription.close();
    } catch (error) {
      finish(error);
    }
  });
}

export async function createUserActivityLoader(pubkey) {
  const writeRelays = await getWriteRelays(pubkey);
  const relays = uniqueRelays(writeRelays, DEFAULT_RELAYS);
  const sources = [];
  for (const kind of [1, 6, 7, 16, 9735, 3]) {
    const locations = kind === 3 ? uniqueRelays(relays, PROFILE_RELAYS) : relays;
    for (const relay of locations) sources.push({ relay, kind });
  }
  const unavailable = new Set();
  const targets = new Map();
  const snapshots = new Map();
  let items = [];
  let successes = 0;
  const pager = createActivityPager({
    sources,
    until: now(),
    query: async (source, until, limit) => {
      const key = `${source.relay}:${source.kind}`;
      if (unavailable.has(key)) return [];
      try {
        const filter = { kinds: [source.kind], until, limit };
        if (source.kind === 9735) filter['#P'] = [pubkey];
        else filter.authors = [pubkey];
        const events = await queryRelay(source.relay, filter);
        successes++;
        return events;
      } catch {
        unavailable.add(key);
        return [];
      }
    }
  });

  async function hydrateTargets(incoming) {
    const missing = [...new Set(incoming.map(item => item.targetId).filter(id => HEX.test(id || '') && !targets.has(id)))];
    const hints = [];
    const authors = [];
    for (const item of incoming) {
      if (item.type === 'post') targets.set(item.event.id, item.event);
      for (const tag of item.event.tags || []) {
        if (tag[0] === 'e' && tag[1] === item.targetId && tag[2]) hints.push(tag[2]);
        if (tag[0] === 'p' && HEX.test(tag[1] || '')) authors.push(tag[1]);
      }
      if (item.type !== 'repost') continue;
      try {
        const embedded = JSON.parse(item.event.content);
        if (embedded.id === item.targetId && verified(embedded)) targets.set(embedded.id, embedded);
      } catch {}
    }
    const authorRelays = await fetchRelayLists([...new Set(authors)]);
    const locations = uniqueRelays(relays, hints, [...authorRelays.values()].flatMap(list => list.write));
    await Promise.all(chunk(missing.filter(id => !targets.has(id)), 80).map(async ids => {
      const events = await pool.querySync(locations, { ids, limit: ids.length }, { maxWait: 8000 }).catch(() => []);
      for (const event of events) {
        if (ids.includes(event.id) && verified(event)) targets.set(event.id, event);
      }
    }));
    await ensureProfiles([pubkey, ...incoming.map(item => item.account), ...[...targets.values()].map(event => event.pubkey)]
      .filter(account => HEX.test(account || '')));
  }

  return {
    async next() {
      const page = await pager.next();
      if (!successes) throw new Error('No activity relays are available. Please try again.');
      const events = page.events.filter(event => event.kind === 9735
        ? event.tags.some(tag => tag[0] === 'P' && tag[1] === pubkey)
        : event.pubkey === pubkey);
      for (const event of events) if (event.kind === 3) snapshots.set(event.id, event);
      const validatedZaps = new Map();
      const receipts = events.filter(event => event.kind === 9735);
      for (const batch of chunk(receipts, 8)) {
        await Promise.all(batch.map(async receipt => {
          const zap = await validateSentZap(receipt, pubkey).catch(() => null);
          if (zap) validatedZaps.set(receipt.id, zap);
        }));
      }
      const incoming = mergeActivity(classifyUserActivity(events, pubkey, validatedZaps), followActivity([...snapshots.values()], pubkey));
      await hydrateTargets(incoming);
      items = mergeActivity(items.filter(item => item.type !== 'follow'), incoming).filter(item => item.type !== 'zap' || !item.targetId
        || !targets.has(item.targetId) || targets.get(item.targetId).pubkey === item.account);
      return {
        items,
        targets,
        exhausted: page.exhausted,
        blocked: page.blocked,
        partial: unavailable.size > 0,
        followHistoryLimited: new Set([...snapshots.values()].map(event => event.created_at)).size < 2
      };
    }
  };
}