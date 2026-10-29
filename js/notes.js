import { nip57, nip10, verifyEvent } from './deps.js';
import { pool, PROFILE_RELAYS, DEFAULT_RELAYS, profiles, rememberProfile, statsFor, actionsFor } from './state.js';
import { fetchRelayLists, getWriteRelays, planOutbox, uniqueRelays } from './relays.js';
import { chunk, now, isReply, isDirectReplyTo, emit } from './util.js';
import { contentCache } from './cache.mjs';
import { createFollowerCountLoader, createPopularFollowersLoader, FOLLOWER_COUNT_CACHE_MS, POPULAR_FOLLOWERS_CACHE_MS } from './follower-count.mjs';
import { createProfileBadgeLoader } from './profile-badges.mjs';
import { groupReactions } from './reaction-groups.mjs';

const HOME_WINDOW_HOURS = 48;
const HOME_LIMIT = 150;
const RELAY_LIMIT = 300;
const QUERY_WAIT_MS = 7000;
const MAX_THREAD_DEPTH = 8;
const MAX_THREAD_REPLIES = 500;
const PROFILE_NOTES_CACHE_MS = 6 * 60 * 60 * 1000;
const NOTE_EVENT_CACHE_MS = 30 * 24 * 60 * 60 * 1000;
const NOTE_STATS_CACHE_MS = 2 * 60 * 60 * 1000;

export const loadProfileBadges = createProfileBadgeLoader({
  verifyEvent,
  relaysFor: async pubkey => uniqueRelays(PROFILE_RELAYS, await getWriteRelays(pubkey)),
  query: async (relays, filters) => (await Promise.all(filters.map(filter =>
    pool.querySync(relays, filter, { maxWait: QUERY_WAIT_MS })))).flat()
});

function newest(events) {
  return events.reduce((best, ev) => (!best || ev.created_at > best.created_at ? ev : best), null);
}

export async function ensureProfiles(pubkeys) {
  const unique = [...new Set(pubkeys)];
  for (const pubkey of unique) {
    if (profiles.has(pubkey)) continue;
    const cached = contentCache.get(`profile-event:${pubkey}`);
    if (cached?.kind === 0 && cached.pubkey === pubkey && typeof cached.content === 'string') rememberProfile(cached);
  }
  const missing = unique.filter(pk => !profiles.has(pk));
  await Promise.all(chunk(missing, 200).map(async authors => {
    const events = await pool.querySync(PROFILE_RELAYS, { kinds: [0], authors }, { maxWait: QUERY_WAIT_MS }).catch(() => []);
    for (const ev of events) rememberProfile(ev);
  }));
}

const followsCache = new Map();
const HEX_PUBKEY = /^[0-9a-f]{64}$/;
const followsFrom = contactList =>
  new Set(contactList?.tags.filter(tag => tag[0] === 'p' && HEX_PUBKEY.test(tag[1] || '')).map(tag => tag[1]) || []);

function queryFollowerEvents(relays, filter) {
  return new Promise((resolve, reject) => {
    const events = [];
    pool.subscribeEose(relays, filter, {
      maxWait: QUERY_WAIT_MS,
      onevent: event => events.push(event),
      onclose: results => {
        if (results?.some(result => result.reason === 'closed automatically on eose')) resolve(events);
        else reject(new Error('No follower count relays completed the query.'));
      }
    });
  });
}

// Always queries relays, so it can be used as the base for editing a contact list.
export async function fetchContactList(pubkey) {
  const relays = uniqueRelays(PROFILE_RELAYS, await getWriteRelays(pubkey));
  return newest(await pool.querySync(relays, { kinds: [3], authors: [pubkey] }, { maxWait: QUERY_WAIT_MS }));
}

const followerCountRelays = uniqueRelays(PROFILE_RELAYS, DEFAULT_RELAYS);

const loadFollowerCount = createFollowerCountLoader({
  query: queryFollowerEvents,
  cache: contentCache,
  relays: followerCountRelays,
  ttlMs: FOLLOWER_COUNT_CACHE_MS
});

const loadPopularFollowers = createPopularFollowersLoader({
  query: queryFollowerEvents,
  cache: contentCache,
  relays: followerCountRelays,
  ttlMs: POPULAR_FOLLOWERS_CACHE_MS
});

export function fetchFollowerCount(pubkey) {
  return loadFollowerCount(pubkey);
}

export function fetchPopularFollowers(pubkey) {
  return loadPopularFollowers(pubkey);
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

const profileNotesCacheKey = (pubkey, limit) => `profile-notes:${pubkey}:${limit}`;

async function fetchProfileNotes(pubkey, limit) {
  const relays = uniqueRelays(await getWriteRelays(pubkey), DEFAULT_RELAYS);
  const events = await pool.querySync(relays, { kinds: [1], authors: [pubkey], limit: limit * 3 }, { maxWait: QUERY_WAIT_MS });
  const notes = [...new Map(events.map(ev => [ev.id, ev])).values()]
    .filter(ev => !isReply(ev))
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, limit);
  contentCache.set(profileNotesCacheKey(pubkey, limit), notes, PROFILE_NOTES_CACHE_MS);
  for (const note of notes) contentCache.set(`note-event:${note.id}`, note, NOTE_EVENT_CACHE_MS);
  return notes;
}

export async function loadProfileNotes(pubkey, limit = 30) {
  const cached = contentCache.get(profileNotesCacheKey(pubkey, limit));
  if (validProfileNotes(cached, pubkey)) return cached;
  return fetchProfileNotes(pubkey, limit);
}

function validProfileNotes(notes, pubkey) {
  return Array.isArray(notes) && notes.every(note => note?.kind === 1 && note.pubkey === pubkey
    && typeof note.id === 'string' && typeof note.content === 'string' && Number.isSafeInteger(note.created_at));
}

export function getCachedProfileNotes(pubkey, limit = 30) {
  const cached = contentCache.get(profileNotesCacheKey(pubkey, limit));
  return validProfileNotes(cached, pubkey) ? cached : null;
}

export function refreshProfileNotes(pubkey, limit = 30) {
  return fetchProfileNotes(pubkey, limit);
}

export async function loadNoteEvent(id, relayHints = []) {
  const cached = contentCache.get(`note-event:${id}`);
  if (cached?.id === id && cached.kind === 1) return cached;
  const relays = uniqueRelays(relayHints, DEFAULT_RELAYS);
  const events = await pool.querySync(relays, { kinds: [1], ids: [id], limit: 1 }, { maxWait: QUERY_WAIT_MS });
  const note = events.find(event => event.id === id && event.kind === 1) || null;
  if (note) contentCache.set(`note-event:${id}`, note, NOTE_EVENT_CACHE_MS);
  return note;
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
  for (const id of ids) {
    const cached = contentCache.get(`note-stats:${self || ''}:${id}`);
    if (cached?.stats) Object.assign(statsFor(id), cached.stats);
    if (cached?.actions) Object.assign(actionsFor(id), cached.actions);
  }
  await Promise.all(chunk(ids, 100).map(async batch => {
    const events = await pool.querySync(DEFAULT_RELAYS, { kinds: [1, 6, 7, 9735], '#e': batch, limit: 5000 }, { maxWait: QUERY_WAIT_MS }).catch(() => []);
    applyInteractions([...new Map(events.map(ev => [ev.id, ev])).values()], batch, self);
    for (const id of batch) {
      statsLoaded.add(id);
      contentCache.set(`note-stats:${self || ''}:${id}`, {
        stats: statsFor(id), actions: actionsFor(id)
      }, NOTE_STATS_CACHE_MS);
    }
  }));
}

export async function refreshNoteStats(notes, self) {
  const ids = [...new Set(notes.map(note => note.id))];
  await Promise.all(chunk(ids, 100).map(async batch => {
    const events = await pool.querySync(DEFAULT_RELAYS, {
      kinds: [1, 6, 7, 9735], '#e': batch, limit: 5000
    }, { maxWait: QUERY_WAIT_MS }).catch(() => []);
    applyInteractions([...new Map(events.map(event => [event.id, event])).values()], batch, self);
    for (const id of batch) contentCache.set(`note-stats:${self || ''}:${id}`, {
      stats: statsFor(id), actions: actionsFor(id)
    }, NOTE_STATS_CACHE_MS);
  }));
}

export async function pollRecentNotes(authors, since) {
  const uniqueAuthors = [...new Set(authors)];
  if (!uniqueAuthors.length) return [];
  const results = await Promise.all(chunk(uniqueAuthors, 200).map(batch =>
    pool.querySync(DEFAULT_RELAYS, {
      kinds: [1], authors: batch, since, limit: 1000
    }, { maxWait: QUERY_WAIT_MS })));
  return [...new Map(results.flat().map(event => [event.id, event])).values()];
}

async function interactionRelays(note, self) {
  const lists = await fetchRelayLists([note.pubkey, ...(self ? [self] : [])]);
  // Replies and reactions are sent to the author's read (inbox) relays.
  return uniqueRelays(lists.get(note.pubkey).read.slice(0, 4), self ? lists.get(self).read.slice(0, 2) : [], DEFAULT_RELAYS);
}

const THREAD_CACHE_LIMIT = 40;
const THREAD_CACHE_TTL_MS = 2 * 60 * 1000;
const threadCache = new Map();

function peopleByAuthor(events) {
  return [...new Map(events.map(event => [event.pubkey, event])).values()]
    .sort((a, b) => b.created_at - a.created_at)
    .map(event => event.pubkey);
}

function interactionPeople(events, noteId) {
  const references = event => event.tags?.some(tag =>
    (tag[0] === 'e' || tag[0] === 'q') && tag[1] === noteId);
  return {
    reposts: peopleByAuthor(events.filter(event => [6, 16].includes(event.kind) && references(event))),
    quotes: peopleByAuthor(events.filter(event => event.kind === 1 && event.tags?.some(tag =>
      (tag[0] === 'q' && tag[1] === noteId) || (tag[0] === 'e' && tag[1] === noteId && tag[3] === 'mention')))),
    likes: peopleByAuthor(events.filter(event => event.kind === 7 && event.content !== '-' && references(event))),
    reactions: groupReactions(events, noteId)
  };
}

async function fetchThread(note, self, onReplies, onInteractions) {
  const relays = await interactionRelays(note, self);
  const [events, quoteEvents] = await Promise.all([
    pool.querySync(relays, { kinds: [1, 6, 7, 16, 9735], '#e': [note.id], limit: 1500 }, { maxWait: QUERY_WAIT_MS }),
    pool.querySync(relays, { kinds: [1], '#q': [note.id], limit: 1000 }, { maxWait: QUERY_WAIT_MS }).catch(() => [])
  ]);
  const unique = [...new Map([...events, ...quoteEvents].map(ev => [ev.id, ev])).values()];
  const replies = unique
    .filter(ev => ev.kind === 1 && isDirectReplyTo(ev, note.id))
    .sort((a, b) => a.created_at - b.created_at)
    .slice(0, MAX_THREAD_REPLIES);
  const people = interactionPeople(unique, note.id);
  applyInteractions(unique, [note.id], self);

  const allReplies = [...replies];
  const knownIds = new Set(replies.map(reply => reply.id));
  let frontier = replies;
  for (let depth = 1; depth < MAX_THREAD_DEPTH && frontier.length && allReplies.length < MAX_THREAD_REPLIES; depth++) {
    const next = [];
    for (let start = 0; start < frontier.length && allReplies.length + next.length < MAX_THREAD_REPLIES; start += 200) {
      const parents = frontier.slice(start, start + 200);
      const parentIds = parents.map(reply => reply.id);
      const events = await pool.querySync(relays, {
        kinds: [1, 6, 7, 9735], '#e': parentIds, limit: 2000
      }, { maxWait: QUERY_WAIT_MS }).catch(() => []);
      applyInteractions(events, parentIds, self);
      const candidateReplies = events.filter(event => event.kind === 1 && !knownIds.has(event.id));
      for (const parent of parents) {
        for (const event of candidateReplies) {
          if (allReplies.length + next.length >= MAX_THREAD_REPLIES) break;
          if (!knownIds.has(event.id) && isDirectReplyTo(event, parent.id)) {
            knownIds.add(event.id);
            next.push(event);
          }
        }
      }
    }
    allReplies.push(...next);
    frontier = next;
  }
  allReplies.sort((a, b) => a.created_at - b.created_at);
  onReplies(allReplies);
  await ensureProfiles([...allReplies.map(reply => reply.pubkey), ...people.reposts, ...people.quotes, ...people.likes,
    ...people.reactions.flatMap(reaction => reaction.pubkeys)]);
  onInteractions(people);
  return allReplies;
}

function getThreadEntry(note, self) {
  const key = `${note.id}:${self || ''}`;
  let entry = threadCache.get(key);
  if (entry && (!entry.loadedAt || Date.now() - entry.loadedAt < THREAD_CACHE_TTL_MS)) {
    threadCache.delete(key);
    threadCache.set(key, entry);
    return entry;
  }
  if (entry) threadCache.delete(key);

  let resolveReplies;
  let resolveInteractions;
  const persistent = contentCache.get(`thread:${key}`);
  const cachedReplies = Array.isArray(persistent?.replies)
    ? persistent.replies.filter(reply => reply?.kind === 1 && typeof reply.id === 'string'
      && typeof reply.pubkey === 'string' && typeof reply.content === 'string' && Number.isSafeInteger(reply.created_at))
    : null;
  const cachedPeople = persistent?.interactions;
  const validInteractions = cachedPeople && ['reposts', 'quotes', 'likes', 'reactions'].every(type => Array.isArray(cachedPeople[type]))
    ? cachedPeople : null;
  entry = {
    replies: cachedReplies,
    repliesLoaded: cachedReplies !== null,
    interactions: validInteractions,
    interactionsLoaded: validInteractions !== null,
    loadedAt: persistent ? Date.now() : 0,
    repliesReady: new Promise(resolve => { resolveReplies = resolve; }),
    interactionsReady: new Promise(resolve => { resolveInteractions = resolve; })
  };
  entry.resolveInteractions = resolveInteractions;
  threadCache.set(key, entry);
  while (threadCache.size > THREAD_CACHE_LIMIT) {
    threadCache.delete(threadCache.keys().next().value);
  }
  entry.promise = fetchThread(note, self, replies => {
    entry.replies = replies;
    entry.repliesLoaded = true;
    resolveReplies(replies);
  }, people => {
    entry.interactions = people;
    entry.interactionsLoaded = true;
    entry.resolveInteractions(people);
  }).then(replies => {
    entry.loadedAt = Date.now();
    contentCache.set(`thread:${key}`, {
      replies: entry.replies,
      interactions: entry.interactions
    }, THREAD_CACHE_TTL_MS);
    return replies;
  }).catch(err => {
    if (entry.repliesLoaded) {
      if (!entry.interactionsLoaded) {
        entry.interactions = { reposts: [], quotes: [], likes: [], reactions: [] };
        entry.interactionsLoaded = true;
        entry.resolveInteractions(entry.interactions);
      }
      entry.loadedAt = Date.now();
      return entry.replies;
    }
    resolveReplies([]);
    entry.resolveInteractions({ reposts: [], quotes: [], likes: [], reactions: [] });
    if (threadCache.get(key) === entry) threadCache.delete(key);
    throw err;
  });
  return entry;
}

export function prefetchThread(note, self) {
  return getThreadEntry(note, self).promise;
}

export function loadThread(note, self, onReplies = () => {}, onInteractions = () => {}) {
  const entry = getThreadEntry(note, self);
  if (entry.repliesLoaded) onReplies(entry.replies);
  else entry.repliesReady.then(onReplies).catch(() => {});
  if (entry.interactionsLoaded) onInteractions(entry.interactions);
  else entry.interactionsReady.then(onInteractions).catch(() => {});
  return entry.promise;
}

export function refreshThread(note, self, onReplies = () => {}, onInteractions = () => {}) {
  let replies = [];
  let interactions = null;
  return fetchThread(note, self, value => {
    replies = value;
    onReplies(value);
  }, value => {
    interactions = value;
    onInteractions(value);
  }).then(result => {
    contentCache.set(`thread:${note.id}:${self || ''}`, { replies, interactions }, THREAD_CACHE_TTL_MS);
    return result;
  });
}
