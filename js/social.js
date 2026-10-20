import { publish } from './publish.js';
import { fetchContactList, getFollows, setCachedFollows } from './notes.js';
import { getSession, isOwn } from './signer.js';
import { emit } from './util.js';

export async function isFollowing(pubkey) {
  const session = getSession();
  if (!session || isOwn(pubkey)) return false;
  return (await getFollows(session.pubkey)).has(pubkey);
}

export async function setFollowing(pubkey, follow) {
  const self = getSession().pubkey;
  // Edit the freshest copy from relays; publishing from a stale or missing list would wipe follows.
  const current = await fetchContactList(self);
  if (!current && !window.confirm('Your follow list could not be found on your relays. Saving now creates a new list that only contains this change. Continue?')) {
    throw new Error('Cancelled');
  }
  const tags = (current?.tags || []).filter(t => !(t[0] === 'p' && t[1] === pubkey));
  if (follow) tags.push(['p', pubkey]);
  const event = await publish({ kind: 3, content: current?.content || '', tags });
  setCachedFollows(self, event);
  emit('zs:follows', { pubkey, following: follow });
  return event;
}
