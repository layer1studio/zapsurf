import { pool, DEFAULT_RELAYS, rememberProfile, statsFor, actionsFor } from './state.js';
import { hoursAgo, isReply, chunk } from './util.js';

// Primal's cache server is only used for trending feeds; everything else comes from relays.
const PRIMAL_CACHE = 'wss://cache1.primal.net/v1';
const REQUEST_TIMEOUT_MS = 15_000;
const IDLE_CLOSE_MS = 60_000;
const CACHE_TTL_MS = 3 * 60_000;
const NOTE_STATS_KIND = 10_000_100;
const NOTE_ACTIONS_KIND = 10_000_115;

const globalTrending = hours => pubkey => ['mega_feed_directive', {
  spec: JSON.stringify({ id: 'global-trending', kind: 'notes', hours }), limit: 50, user_pubkey: pubkey
}];
const explore = (timeframe, hours) => pubkey => ['explore', {
  timeframe, scope: 'global', limit: 50, user_pubkey: pubkey, ...(hours ? { created_after: hoursAgo(hours) } : {})
}];
const scopedTrending = scope => pubkey => ['explore', { timeframe: 'trending', scope, limit: 50, user_pubkey: pubkey, created_after: hoursAgo(24) }];

// Mirrors Primal's own trending feed specs (get_home_feeds) and Explore timeframes.
export const FEEDS = [
  { id: 'trending-1h', label: 'Trending 1h', group: 'Trending on Primal', hours: 1, cache: globalTrending(1) },
  { id: 'trending-4h', label: 'Trending 4h', group: 'Trending on Primal', hours: 4, cache: globalTrending(4) },
  { id: 'trending-12h', label: 'Trending 12h', group: 'Trending on Primal', hours: 12, cache: globalTrending(12) },
  { id: 'trending-24h', label: 'Trending 24h', group: 'Trending on Primal', hours: 24, cache: globalTrending(24) },
  { id: 'trending-48h', label: 'Trending 48h', group: 'Trending on Primal', hours: 48, cache: globalTrending(48) },
  { id: 'trending-7d', label: 'Trending 7d', group: 'Trending on Primal', hours: 168, cache: globalTrending(168) },
  { id: 'mostzapped-4h', label: 'Most zapped 4h', group: 'Explore', hours: 4, zapsOnly: true, cache: explore('mostzapped', 4) },
  { id: 'mostzapped', label: 'Most zapped', group: 'Explore', hours: 24, zapsOnly: true, cache: explore('mostzapped') },
  { id: 'popular', label: 'Popular', group: 'Explore', hours: 24, cache: explore('popular') },
  { id: 'trending-follows', label: 'Trending in my follows', group: 'You', personal: true, hours: 24, cache: scopedTrending('follows') },
  { id: 'trending-tribe', label: 'Trending in my tribe', group: 'You', personal: true, hours: 24, cache: scopedTrending('tribe') },
  { id: 'trending-network', label: 'Trending in my network', group: 'You', personal: true, hours: 24, cache: scopedTrending('network') }
];
export const DEFAULT_FEED_ID = 'trending-24h';

function absorbMeta(ev) {
  if (ev.kind === 0) {
    rememberProfile(ev);
    return true;
  }
  if (ev.kind === NOTE_STATS_KIND || ev.kind === NOTE_ACTIONS_KIND) {
    try {
      const data = JSON.parse(ev.content);
      if (!data?.event_id) return true;
      const target = ev.kind === NOTE_STATS_KIND ? statsFor(data.event_id) : actionsFor(data.event_id);
      for (const key of Object.keys(target)) {
        if (typeof data[key] === 'number') target[key] = Math.max(target[key], data[key]);
        else if (data[key] === true) target[key] = true;
      }
    } catch { /* ignore malformed stats */ }
    return true;
  }
  return false;
}

// ---------- One shared, lazily opened connection ----------

let socket = null;
let opening = null;
let idleTimer = null;
const pending = new Map();

function scheduleIdleClose() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (pending.size === 0) socket?.close();
  }, IDLE_CLOSE_MS);
}

function settle(subId, error) {
  const req = pending.get(subId);
  if (!req) return;
  pending.delete(subId);
  clearTimeout(req.timer);
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(['CLOSE', subId]));
  const events = [...req.events.values()];
  // Some Primal feeds never send EOSE, so partial results on timeout are normal.
  if (error && events.length === 0) req.reject(error);
  else req.resolve(events);
  scheduleIdleClose();
}

function connect() {
  if (socket?.readyState === WebSocket.OPEN) return Promise.resolve();
  if (opening) return opening;
  opening = new Promise((resolve, reject) => {
    const ws = new WebSocket(PRIMAL_CACHE);
    ws.onopen = () => { socket = ws; opening = null; resolve(); };
    ws.onerror = () => { opening = null; reject(new Error('Could not connect to Primal')); };
    ws.onclose = () => {
      if (socket === ws) socket = null;
      for (const subId of [...pending.keys()]) settle(subId, new Error('Primal connection closed'));
    };
    ws.onmessage = ({ data }) => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      const req = pending.get(msg[1]);
      if (!req) return;
      if (msg[0] === 'EVENT' && msg[2]) {
        if (!absorbMeta(msg[2]) && msg[2].id) req.events.set(msg[2].id, msg[2]);
      } else if (msg[0] === 'EOSE') {
        settle(msg[1]);
      } else if (msg[0] === 'NOTICE' || msg[0] === 'CLOSED') {
        settle(msg[1], new Error(msg[2] || 'Primal closed the request'));
      }
    };
  });
  return opening;
}

async function primalRequest(cache) {
  await connect();
  clearTimeout(idleTimer);
  const subId = `zs-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve, reject) => {
    pending.set(subId, {
      events: new Map(), resolve, reject,
      timer: setTimeout(() => settle(subId, new Error('Primal timed out')), REQUEST_TIMEOUT_MS)
    });
    socket.send(JSON.stringify(['REQ', subId, { cache }]));
  });
}

// ---------- Relay fallback ----------

async function relayRankedNotes(feed) {
  const since = hoursAgo(Math.min(feed.hours || 24, 24));
  const notes = (await pool.querySync(DEFAULT_RELAYS, { kinds: [1], since, limit: 500 }, { maxWait: 8000 }))
    .filter(note => !isReply(note));
  const scores = new Map(notes.map(n => [n.id, 0]));
  const weights = feed.zapsOnly ? { 9735: 1 } : { 7: 1, 6: 2, 1: 2, 9735: 3 };
  for (const ids of chunk([...scores.keys()], 100)) {
    const interactions = await pool.querySync(DEFAULT_RELAYS, { kinds: [7, 6, 1, 9735], '#e': ids, since, limit: 2000 }, { maxWait: 8000 }).catch(() => []);
    for (const ev of interactions) {
      const target = ev.tags.filter(t => t[0] === 'e').pop()?.[1];
      if (scores.has(target)) scores.set(target, scores.get(target) + (weights[ev.kind] || 0));
    }
  }
  return notes
    .filter(n => scores.get(n.id) > 0)
    .sort((a, b) => scores.get(b.id) - scores.get(a.id))
    .slice(0, 50);
}

// ---------- Public API ----------

const feedCache = new Map();

export async function loadTrendingItems(feed, pubkey, onProgress = () => {}) {
  const key = `${feed.id}:${pubkey || ''}`;
  const cached = feedCache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.result;

  let result;
  try {
    const events = await primalRequest(feed.cache(pubkey));
    const notes = events.filter(ev => ev.kind === 1);
    if (notes.length === 0) throw new Error('Primal returned no notes');
    result = { items: notes.map(note => ({ note, hasStats: true })), source: 'Primal' };
  } catch (err) {
    if (feed.personal) throw err;
    console.warn('Primal trending failed, ranking from relays instead', err);
    onProgress('Primal is unavailable. Ranking recent notes from relays instead…');
    const notes = await relayRankedNotes(feed);
    result = { items: notes.map(note => ({ note })), source: 'relays' };
  }
  feedCache.set(key, { at: Date.now(), result });
  return result;
}
