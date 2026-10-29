const HEX_PUBKEY = /^[0-9a-f]{64}$/;
export const FOLLOWER_COUNT_CACHE_MS = 30 * 60 * 1000;
export const POPULAR_FOLLOWERS_CACHE_MS = 30 * 60 * 1000;
// Show any popular followers regardless of their own follower count.
export const POPULAR_FOLLOWER_MIN_COUNT = 0;
export const POPULAR_FOLLOWER_LIMIT = 6;
export const POPULAR_FOLLOWER_CANDIDATE_LIMIT = 150;

export function followerPubkeys(events, pubkey) {
  const followers = new Set();
  if (!HEX_PUBKEY.test(pubkey || '')) return followers;
  for (const event of events || []) {
    if (event?.kind !== 3 || !HEX_PUBKEY.test(event.pubkey || '') || !Array.isArray(event.tags)) continue;
    if (event.tags.some(tag => Array.isArray(tag) && tag[0] === 'p' && tag[1] === pubkey)) followers.add(event.pubkey);
  }
  return followers;
}

export function countFollowers(events, pubkey) {
  return followerPubkeys(events, pubkey).size;
}

export function followerCountsForTargets(events, targets) {
  const targetSet = new Set((targets || []).filter(pubkey => HEX_PUBKEY.test(pubkey || '')));
  const followersByTarget = new Map([...targetSet].map(pubkey => [pubkey, new Set()]));
  for (const event of events || []) {
    if (event?.kind !== 3 || !HEX_PUBKEY.test(event.pubkey || '') || !Array.isArray(event.tags)) continue;
    for (const tag of event.tags) {
      if (!Array.isArray(tag) || tag[0] !== 'p' || !targetSet.has(tag[1])) continue;
      followersByTarget.get(tag[1]).add(event.pubkey);
    }
  }
  return new Map([...followersByTarget].map(([pubkey, followers]) => [pubkey, followers.size]));
}

export function popularFollowersFromEvents(targetFollowerEvents, popularityEvents, pubkey, {
  minFollowers = POPULAR_FOLLOWER_MIN_COUNT,
  limit = POPULAR_FOLLOWER_LIMIT,
  candidateLimit = POPULAR_FOLLOWER_CANDIDATE_LIMIT
} = {}) {
  const candidates = [...followerPubkeys(targetFollowerEvents, pubkey)].slice(0, candidateLimit);
  const counts = followerCountsForTargets(popularityEvents, candidates);
  return candidates
    .map(follower => ({ pubkey: follower, followers: counts.get(follower) || 0 }))
    .filter(follower => follower.followers >= minFollowers)
    .sort((left, right) => right.followers - left.followers || left.pubkey.localeCompare(right.pubkey))
    .slice(0, limit);
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

export function createPopularFollowersLoader({
  query,
  cache,
  relays,
  ttlMs = POPULAR_FOLLOWERS_CACHE_MS,
  minFollowers = POPULAR_FOLLOWER_MIN_COUNT,
  limit = POPULAR_FOLLOWER_LIMIT,
  candidateLimit = POPULAR_FOLLOWER_CANDIDATE_LIMIT,
  batchSize = 50
}) {
  return async pubkey => {
    if (!HEX_PUBKEY.test(pubkey || '')) return [];
    const key = `profile-popular-followers:v2:${pubkey}`;
    const cached = cache.get(key);
    if (Array.isArray(cached)) return cached.filter(item => HEX_PUBKEY.test(item?.pubkey || '') && Number.isSafeInteger(item.followers));

    const targetFollowerEvents = await query(relays, { kinds: [3], '#p': [pubkey] });
    const candidates = [...followerPubkeys(targetFollowerEvents, pubkey)].slice(0, candidateLimit);
    if (candidates.length === 0) {
      cache.set(key, [], ttlMs);
      return [];
    }

    const popularityEvents = [];
    for (let index = 0; index < candidates.length; index += batchSize) {
      const batch = candidates.slice(index, index + batchSize);
      popularityEvents.push(...await query(relays, { kinds: [3], '#p': batch }));
    }

    const popular = popularFollowersFromEvents(targetFollowerEvents, popularityEvents, pubkey, { minFollowers, limit, candidateLimit });
    cache.set(key, popular, ttlMs);
    return popular;
  };
}
