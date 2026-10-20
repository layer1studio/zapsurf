import { nip57, nip10 } from './deps.js';
import { pool, PROFILE_RELAYS, DEFAULT_RELAYS, profiles, rememberProfile, statsFor, actionsFor } from './state.js';
import { fetchRelayLists, getWriteRelays, planOutbox, uniqueRelays } from './relays.js';
import { chunk, now, isReply, isDirectReplyTo, emit } from './util.js';

const HOME_WINDOW_HOURS = 48;
const HOME_LIMIT = 150;
const RELAY_LIMIT = 300;
const QUERY_WAIT_MS = 7000;

function newest(events) {
  return events.reduce((best, ev) => (!best || ev.created_at > best.created_at ? ev : best), null);
}

export async function ensureProfiles(pubkeys) {
  const missing = [...new Set(pubkeys)].filter(pk => !profiles.has(pk));
  await Promise.all(chunk(missing, 200).map(async authors => {
    const events = await pool.querySync(PROFILE_RELAYS, { kinds: [0], authors }, { maxWait: QUERY_WAIT_MS }).catch(() => []);
    for (const ev of events) rememberProfile(ev);
  }));
}

const followsCache = new Map();
const HEX_PUBKEY = /^[0-9a-f]{64}$/;

const followsFrom = contactList =>
  new Set(contactList?.tags.filter(t => t[0] === 'p' && HEX_PUBKEY.test(t[1] || '')).map(t => t[1]) || []);

// Always queries relays, so it can be used as the base for editing a contact list.
export async function fetchContactList(pubkey) {
  const relays = uniqueRelays(PROFILE_RELAYS, await getWriteRelays(pubkey));
  return newest(await pool.querySync(relays, { kinds: [3], authors: [pubkey] }, { maxWait: QUERY_WAIT_MS }));
}

export async function getFollows(pubkey) {
  if (followsCache.has(pubkey)) return followsCache.get(pubkey);
  const follows = followsFrom(await fetchContactList(pubkey));
  followsCache.set(pubkey, follows);
  return follows;
}

export function setCachedFollows(pubkey, contactList) {
  followsCache.set(pubkey, followsFrom(contactList));
}

export async function loadProfileNotes(pubkey, limit = 30) {
  const relays = uniqueRelays(await getWriteRelays(pubkey), DEFAULT_RELAYS);
  const events = await pool.querySync(relays, { kinds: [1], authors: [pubkey], limit: limit * 3 }, { maxWait: QUERY_WAIT_MS });
  return [...new Map(events.map(ev => [ev.id, ev])).values()]
    .filter(ev => !isReply(ev))
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, limit);
}

function parseRepost(repost, notesById) {
  const targetId = repost.tags.find(t => t[0] === 'e')?.[1];
  if (targetId && notesById.has(targetId)) return notesById.get(targetId);
  try {
    const original = JSON.parse(repost.content);
    if (original?.kind === 1 && typeof original.content === 'string' && (!targetId || original.id === targetId)) return original;
  } catch { /* empty or invalid repost content */ }
  return null;
}

// Returns one page of home items plus a cursor: pass it as `before` to get the next, older page.
export async function loadHomeItems(pubkey, before = null, onProgress = () => {}) {
  onProgress('Loading your follow list…');
  const follows = await getFollows(pubkey);
  const authors = [...new Set([...follows, pubkey])];
  onProgress(`Finding the relays your ${follows.size} follows publish to…`);
  const plan = await planOutbox(authors);
  const until = before ?? now();
  const since = until - HOME_WINDOW_HOURS * 3600;

  const queries = [];
  for (const [relay, pks] of plan) {
    for (const batch of chunk(pks, 250)) {
      queries.push(pool.querySync([relay], { kinds: [1, 6], authors: batch, since, until, limit: RELAY_LIMIT }, { maxWait: QUERY_WAIT_MS })
        .catch(() => []));
    }
  }
  const receivedEventIds = new Set();
  let done = 0;
  onProgress(`Loading notes from ${plan.size} relays (0/${queries.length} queries done; 0 events received)…`);
  const results = await Promise.all(queries.map(async query => {
    const events = await query;
    for (const event of events) if (event.id) receivedEventIds.add(event.id);
    onProgress(`Loading notes from ${plan.size} relays (${++done}/${queries.length} queries done; ${receivedEventIds.size} events received)…`);
    return events;
  }));
  // A relay that hit its limit only covers back to its oldest event; stop there so pages have no gaps.
  let cursor = since;
  for (const batch of results) {
    if (batch.length >= RELAY_LIMIT) cursor = Math.max(cursor, Math.min(...batch.map(ev => ev.created_at)));
  }
  const events = new Map();
  for (const ev of results.flat()) {
    if (ev.created_at >= cursor && ev.created_at <= until) events.set(ev.id, ev);
  }

  const visible = new Set(authors);
  const notesById = new Map([...events.values()].filter(ev => ev.kind === 1).map(ev => [ev.id, ev]));
  const items = new Map();
  for (const ev of [...events.values()].sort((a, b) => b.created_at - a.created_at)) {
    if (items.size >= HOME_LIMIT) {
      cursor = ev.created_at + 1;
      break;
    }
    if (!visible.has(ev.pubkey)) continue;
    if (ev.kind === 6) {
      const original = parseRepost(ev, notesById);
      if (original && !isReply(original) && !items.has(original.id)) items.set(original.id, { note: original, repostedBy: ev.pubkey });
    } else if (ev.kind === 1 && !isReply(ev) && !items.has(ev.id)) {
      items.set(ev.id, { note: ev });
    }
  }
  const result = [...items.values()];
  onProgress('Loading profiles…');
  await ensureProfiles(result.flatMap(item => [item.note.pubkey, item.repostedBy].filter(Boolean)));
  return { items: result, cursor: cursor - 1 };
}

function zapAmount(receipt) {
  try {
    return nip57.getSatoshisAmountFromBolt11(receipt.tags.find(t => t[0] === 'bolt11')?.[1] || '');
  } catch {
    return 0;
  }
}

// Interaction counts from relays are a lower bound; merge with anything already known.
function applyInteractions(events, ids, self) {
  const fresh = new Map(ids.map(id => [id, { likes: 0, reposts: 0, replies: 0, zaps: 0, satszapped: 0, liked: false, reposted: false, replied: false, zapped: false }]));
  for (const ev of events) {
    if (ev.kind === 1) {
      const { root, reply } = nip10.parse(ev);
      const counts = fresh.get(reply ? reply.id : root?.id);
      if (!counts) continue;
      counts.replies++;
      if (ev.pubkey === self) counts.replied = true;
      continue;
    }
    const target = ev.tags.filter(t => t[0] === 'e').pop()?.[1];
    const counts = fresh.get(target);
    if (!counts) continue;
    if (ev.kind === 7 && ev.content !== '-') {
      counts.likes++;
      if (ev.pubkey === self) counts.liked = true;
    } else if (ev.kind === 6) {
      counts.reposts++;
      if (ev.pubkey === self) counts.reposted = true;
    } else if (ev.kind === 9735) {
      counts.zaps++;
      counts.satszapped += zapAmount(ev);
      if (self && ev.tags.some(t => t[0] === 'P' && t[1] === self)) counts.zapped = true;
    }
  }
  for (const [id, counts] of fresh) {
    const stats = statsFor(id);
    const actions = actionsFor(id);
    for (const key of Object.keys(stats)) stats[key] = Math.max(stats[key], counts[key]);
    for (const key of Object.keys(actions)) actions[key] = actions[key] || counts[key];
    emit('zs:stats', id);
  }
}

const statsLoaded = new Set();

// Batch counts for feed lists; uses the default relays only, so treat as approximate.
export async function loadNoteStats(notes, self) {
  const ids = [...new Set(notes.map(n => n.id))].filter(id => !statsLoaded.has(id));
  await Promise.all(chunk(ids, 100).map(async batch => {
    const events = await pool.querySync(DEFAULT_RELAYS, { kinds: [1, 6, 7, 9735], '#e': batch, limit: 5000 }, { maxWait: QUERY_WAIT_MS }).catch(() => []);
    applyInteractions([...new Map(events.map(ev => [ev.id, ev])).values()], batch, self);
    for (const id of batch) statsLoaded.add(id);
  }));
}

async function interactionRelays(note, self) {
  const lists = await fetchRelayLists([note.pubkey, ...(self ? [self] : [])]);
  // Replies and reactions are sent to the author's read (inbox) relays.
  return uniqueRelays(lists.get(note.pubkey).read.slice(0, 4), self ? lists.get(self).read.slice(0, 2) : [], DEFAULT_RELAYS);
}

export async function loadThread(note, self, onReplies = () => {}) {
  const relays = await interactionRelays(note, self);
  const events = await pool.querySync(relays, { kinds: [1, 6, 7, 9735], '#e': [note.id], limit: 1500 }, { maxWait: QUERY_WAIT_MS });
  const unique = [...new Map(events.map(ev => [ev.id, ev])).values()];
  const replies = unique
    .filter(ev => ev.kind === 1 && isDirectReplyTo(ev, note.id))
    .sort((a, b) => a.created_at - b.created_at);
  onReplies(replies);
  applyInteractions(unique, [note.id], self);

  const replyIds = replies.map(r => r.id);
  if (replyIds.length) {
    const nested = await pool.querySync(relays, { kinds: [1, 6, 7, 9735], '#e': replyIds.slice(0, 200), limit: 2000 }, { maxWait: QUERY_WAIT_MS }).catch(() => []);
    applyInteractions(nested, replyIds, self);
  }
  await ensureProfiles(replies.map(r => r.pubkey));
  return replies;
}
