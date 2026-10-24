const HEX_PUBKEY = /^[0-9a-f]{64}$/;
export const FOLLOWER_COUNT_CACHE_MS = 30 * 60 * 1000;

export function countFollowers(events, pubkey) {
  const followers = new Set();
  for (const event of events || []) {
    if (event?.kind !== 3 || !HEX_PUBKEY.test(event.pubkey || '') || !Array.isArray(event.tags)) continue;
    if (event.tags.some(tag => Array.isArray(tag) && tag[0] === 'p' && tag[1] === pubkey)) followers.add(event.pubkey);
  }
  return followers.size;
}

export function createFollowerCountLoader({ query, cache, relays, ttlMs = FOLLOWER_COUNT_CACHE_MS }) {
  return async pubkey => {
    if (!HEX_PUBKEY.test(pubkey || '')) return null;
    const key = `profile-followers:${pubkey}`;
    const cached = cache.get(key);
    if (Number.isSafeInteger(cached) && cached >= 0) return cached;

    const events = await query(relays, { kinds: [3], '#p': [pubkey] });
    const count = countFollowers(events, pubkey);
    cache.set(key, count, ttlMs);
    return count;
  };
}