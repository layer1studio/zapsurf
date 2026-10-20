import { nip10, nip19 } from './deps.js';
import { pool, statsFor, actionsFor } from './state.js';
import { signEvent, getSession } from './signer.js';
import { getWriteRelays } from './relays.js';
import { now, emit } from './util.js';

export { getWriteRelays };

export async function publish(template) {
  const event = await signEvent({ created_at: now(), ...template });
  const relays = await getWriteRelays(event.pubkey);
  const results = await Promise.allSettled(pool.publish(relays, event));
  if (!results.some(r => r.status === 'fulfilled')) {
    throw new Error('No relay accepted the event. Check your connection and try again.');
  }
  emit('zs:published', event);
  return event;
}

const BECH32_REF = /(^|[\s(])@?((?:npub|nprofile|note|nevent|naddr)1[02-9ac-hj-np-z]{20,})/g;
const HASHTAG = /(?:^|\s)#([\p{L}\p{N}_]{1,64})/gu;
const NOSTR_REF = /nostr:((?:npub|nprofile|note|nevent)1[02-9ac-hj-np-z]+)/g;

export function normaliseContent(content) {
  return content.replace(BECH32_REF, '$1nostr:$2').trim();
}

function contentTags(content) {
  const tags = [];
  const seen = new Set();
  const add = tag => {
    const key = tag.slice(0, 2).join(':');
    if (!seen.has(key)) {
      seen.add(key);
      tags.push(tag);
    }
  };
  for (const [, tag] of content.matchAll(HASHTAG)) add(['t', tag.toLowerCase()]);
  for (const [, entity] of content.matchAll(NOSTR_REF)) {
    try {
      const { type, data } = nip19.decode(entity);
      if (type === 'npub') add(['p', data]);
      else if (type === 'nprofile') add(['p', data.pubkey]);
      else if (type === 'note') add(['q', data]);
      else if (type === 'nevent') {
        add(['q', data.id, data.relays?.[0] || '', data.author || '']);
        if (data.author) add(['p', data.author]);
      }
    } catch { /* not a valid reference */ }
  }
  return tags;
}

function replyTags(parent) {
  const { root } = nip10.parse(parent);
  const tags = root
    ? [['e', root.id, root.relays?.[0] || '', 'root', root.author || ''], ['e', parent.id, '', 'reply', parent.pubkey]]
    : [['e', parent.id, '', 'root', parent.pubkey]];
  const self = getSession()?.pubkey;
  const people = new Set([parent.pubkey, ...parent.tags.filter(t => t[0] === 'p' && t[1]).map(t => t[1])]);
  people.delete(self);
  for (const pubkey of people) tags.push(['p', pubkey]);
  return tags;
}

export async function postNote(rawContent, { replyTo = null, quote = null } = {}) {
  let content = normaliseContent(rawContent);
  if (quote) content = `${content}\n\nnostr:${nip19.neventEncode({ id: quote.id, author: quote.pubkey })}`;
  if (!content) throw new Error('Write something first.');

  const tags = replyTo ? replyTags(replyTo) : [];
  for (const tag of contentTags(content)) {
    if (!tags.some(t => t[0] === tag[0] && t[1] === tag[1])) tags.push(tag);
  }
  const event = await publish({ kind: 1, content, tags });
  if (replyTo) {
    statsFor(replyTo.id).replies++;
    actionsFor(replyTo.id).replied = true;
    emit('zs:stats', replyTo.id);
  }
  return event;
}

export async function likeNote(note) {
  const actions = actionsFor(note.id);
  if (actions.liked) return;
  await publish({ kind: 7, content: '+', tags: [['e', note.id], ['p', note.pubkey], ['k', String(note.kind)]] });
  actions.liked = true;
  statsFor(note.id).likes++;
  emit('zs:stats', note.id);
}

export async function repostNote(note) {
  const actions = actionsFor(note.id);
  if (actions.reposted) return;
  await publish({ kind: 6, content: JSON.stringify(note), tags: [['e', note.id, ''], ['p', note.pubkey]] });
  actions.reposted = true;
  statsFor(note.id).reposts++;
  emit('zs:stats', note.id);
}
