const HEX64 = /^[0-9a-f]{64}$/;
const MAX_BADGES = 48;

function valid(event, verifyEvent) {
  try {
    return Boolean(event && HEX64.test(event.pubkey) && HEX64.test(event.id)
      && Number.isSafeInteger(event.created_at) && Array.isArray(event.tags)
      && event.tags.every(tag => Array.isArray(tag) && tag.every(value => typeof value === 'string'))
      && verifyEvent(event));
  } catch {
    return false;
  }
}

function newest(events) {
  return [...events].sort((left, right) => right.created_at - left.created_at || left.id.localeCompare(right.id))[0] || null;
}

function addressParts(address) {
  const match = /^30009:([0-9a-f]{64}):(.+)$/.exec(address || '');
  return match ? { issuer: match[1], identifier: match[2] } : null;
}

export function acceptedBadgeReferences(events, pubkey, verifyEvent) {
  const lists = events.filter(event => valid(event, verifyEvent) && event.pubkey === pubkey
    && (event.kind === 10008 || (event.kind === 30008 && event.tags.find(tag => tag[0] === 'd')?.[1] === 'profile_badges')));
  const list = newest(lists);
  const references = [];
  const seen = new Set();
  for (let index = 0; index < (list?.tags.length || 0) - 1; index++) {
    const address = list.tags[index];
    const award = list.tags[index + 1];
    const parts = address[0] === 'a' ? addressParts(address[1]) : null;
    if (!parts || award[0] !== 'e' || !HEX64.test(award[1]) || seen.has(address[1])) continue;
    seen.add(address[1]);
    references.push({ address: address[1], awardId: award[1], relay: award[2], ...parts });
    if (references.length === MAX_BADGES) break;
  }
  return references;
}

function imageUrl(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

export function verifiedProfileBadges(references, events, pubkey, verifyEvent) {
  const verified = events.filter(event => valid(event, verifyEvent));
  return references.flatMap(reference => {
    const award = verified.find(event => event.id === reference.awardId && event.kind === 8
      && event.pubkey === reference.issuer
      && event.tags.filter(tag => tag[0] === 'a').length === 1
      && event.tags.some(tag => tag[0] === 'a' && tag[1] === reference.address)
      && event.tags.some(tag => tag[0] === 'p' && tag[1] === pubkey));
    if (!award) return [];
    const definition = newest(verified.filter(event => event.kind === 30009 && event.pubkey === reference.issuer
      && event.tags.find(tag => tag[0] === 'd')?.[1] === reference.identifier));
    if (!definition) return [];
    const tagValue = name => definition.tags.find(tag => tag[0] === name)?.[1] || '';
    const images = [...definition.tags.filter(tag => tag[0] === 'thumb').map(tag => tag[1]), tagValue('image')];
    return [{
      address: reference.address,
      issuer: reference.issuer,
      awardId: award.id,
      name: tagValue('name') || reference.identifier,
      description: tagValue('description'),
      image: images.map(imageUrl).find(Boolean) || null
    }];
  });
}

export function createProfileBadgeLoader({ query, verifyEvent, relaysFor, now = () => Date.now(), ttlMs = 300_000 }) {
  const cache = new Map();
  const pending = new Map();
  return async pubkey => {
    if (!HEX64.test(pubkey)) return [];
    const cached = cache.get(pubkey);
    if (cached && cached.expiresAt > now()) return cached.badges;
    if (pending.has(pubkey)) return pending.get(pubkey);
    const request = (async () => {
      const relays = await relaysFor(pubkey);
      const lists = await query(relays, [
        { kinds: [10008], authors: [pubkey] },
        { kinds: [30008], authors: [pubkey], '#d': ['profile_badges'] }
      ]);
      const references = acceptedBadgeReferences(lists, pubkey, verifyEvent);
      let badges = [];
      if (references.length) {
        const issuerRelays = await Promise.all([...new Set(references.map(reference => reference.issuer))].map(relaysFor));
        const hints = references.map(reference => reference.relay).filter(relay => {
          try { return new URL(relay).protocol === 'wss:'; } catch { return false; }
        });
        const filters = [
          { kinds: [8], ids: references.map(reference => reference.awardId) },
          ...references.map(reference => ({ kinds: [30009], authors: [reference.issuer], '#d': [reference.identifier] }))
        ];
        const events = await query([...new Set([...relays, ...issuerRelays.flat(), ...hints])].slice(0, 32), filters);
        badges = verifiedProfileBadges(references, events, pubkey, verifyEvent);
      }
      cache.set(pubkey, { badges, expiresAt: now() + ttlMs });
      if (cache.size > 100) cache.delete(cache.keys().next().value);
      return badges;
    })();
    pending.set(pubkey, request);
    try { return await request; } finally { pending.delete(pubkey); }
  };
}