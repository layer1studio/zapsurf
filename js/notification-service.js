import { verifyEvent } from './deps.js';
import { pool } from './state.js';
import { fetchRelayLists, getReadRelays, getWriteRelays, uniqueRelays } from './relays.js';
import { ensureProfiles } from './notes.js?v=0.4.0';
import { validateZapForNote } from './zapcount.js';
import { chunk } from './util.js';
import { classifyNotifications, replyParentId, selectOwnedNotes, MAX_OWN_NOTES } from './notifications.mjs';

const QUERY_WAIT_MS = 8000;
const REPLY_LIMIT = 1500;
const REPLY_DEPTH_LIMIT = 20;
const ZAP_VALIDATION_LIMIT = 300;
const TAG_BATCH_SIZE = 80;

function uniqueEvents(events) {
  const unique = new Map();
  for (const event of events) {
    if (!event?.id || unique.has(event.id)) continue;
    try {
      if (verifyEvent(event)) unique.set(event.id, event);
    } catch { /* Ignore malformed relay events. */ }
  }
  return [...unique.values()];
}

async function queryByTag(relays, kinds, ids, since) {
  const results = await Promise.all(chunk(ids, TAG_BATCH_SIZE).map(batch =>
    pool.querySync(relays, { kinds, '#e': batch, since, limit: 2000 }, { maxWait: QUERY_WAIT_MS })));
  return uniqueEvents(results.flat());
}

async function loadReplyTree(relays, ownNotes, since) {
  const allReplies = new Map();
  const seen = new Set(ownNotes.map(note => note.id));
  let frontier = ownNotes.map(note => ({ id: note.id, pubkey: note.pubkey }));

  for (let depth = 0; depth < REPLY_DEPTH_LIMIT && frontier.length && allReplies.size < REPLY_LIMIT; depth++) {
    const current = frontier.slice(0, REPLY_LIMIT - allReplies.size);
    const relayLists = await fetchRelayLists([...new Set(current.map(parent => parent.pubkey))]);
    const relayParents = new Map();
    for (const parent of current) {
      const authorReads = relayLists.get(parent.pubkey)?.read.slice(0, 4) || [];
      for (const relay of uniqueRelays(authorReads, relays)) {
        if (!relayParents.has(relay)) relayParents.set(relay, []);
        relayParents.get(relay).push(parent.id);
      }
    }
    const resultLists = await Promise.all([...relayParents].flatMap(([relay, ids]) =>
      chunk(ids, TAG_BATCH_SIZE).map(batch =>
        pool.querySync([relay], { kinds: [1], '#e': batch, since, limit: 2000 }, { maxWait: QUERY_WAIT_MS }))));
    const events = uniqueEvents(resultLists.flat());
    const parentIds = new Set(current.map(parent => parent.id));
    const next = [];
    for (const event of events) {
      const parentId = replyParentId(event);
      if (event.kind !== 1 || !parentIds.has(parentId) || seen.has(event.id)) continue;
      seen.add(event.id);
      allReplies.set(event.id, event);
      next.push({ id: event.id, pubkey: event.pubkey });
      if (allReplies.size >= REPLY_LIMIT) break;
    }
    frontier = next;
  }
  return [...allReplies.values()];
}

export async function fetchNotificationActivity(pubkey, since, previousNotes = []) {
  const [readRelays, writeRelays] = await Promise.all([
    getReadRelays(pubkey),
    getWriteRelays(pubkey)
  ]);
  const ownEvents = await pool.querySync(writeRelays, {
    kinds: [1], authors: [pubkey], limit: MAX_OWN_NOTES
  }, { maxWait: QUERY_WAIT_MS });
  const ownNotes = selectOwnedNotes(previousNotes, uniqueEvents(ownEvents), pubkey);
  const ownIds = ownNotes.map(note => note.id);
  const [mentions, replies, interactions] = await Promise.all([
    pool.querySync(readRelays, { kinds: [1], '#p': [pubkey], since, limit: 2000 }, { maxWait: QUERY_WAIT_MS })
      .then(uniqueEvents),
    loadReplyTree(readRelays, ownNotes, since),
    queryByTag(readRelays, [6, 7, 16, 9735], ownIds, since)
  ]);
  const events = uniqueEvents([...mentions, ...replies, ...interactions]);
  const notesById = new Map(ownNotes.map(note => [note.id, note]));
  const validatedZaps = new Map();
  const receipts = events.filter(event => event.kind === 9735)
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, ZAP_VALIDATION_LIMIT);
  await Promise.all(receipts.map(async receipt => {
    const target = receipt.tags?.find(tag => Array.isArray(tag) && tag[0] === 'e' && notesById.has(tag[1]));
    const note = target && notesById.get(target[1]);
    if (!note) return;
    const zap = await validateZapForNote(receipt, note);
    if (zap) validatedZaps.set(receipt.id, zap);
  }));

  const notifications = classifyNotifications({ events, ownNotes, pubkey, validatedZaps });
  await ensureProfiles(notifications.map(item => item.event.pubkey));

  return { ownNotes, notifications };
}