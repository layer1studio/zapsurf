export function createNip05Verifier({ queryProfile, now = () => Date.now(), ttlMs = 300_000 }) {
  const cache = new Map();
  const pending = new Map();
  return async (identifier, pubkey) => {
    if (typeof identifier !== 'string' || !identifier.trim() || !/^[0-9a-f]{64}$/.test(pubkey || '')) return false;
    const address = identifier.trim();
    let result = cache.get(address);
    if (!result || result.expiresAt <= now()) {
      if (!pending.has(address)) {
        const request = Promise.resolve().then(() => queryProfile(address)).then(profile => {
          const value = { pubkey: profile?.pubkey, expiresAt: now() + ttlMs };
          cache.set(address, value);
          if (cache.size > 300) cache.delete(cache.keys().next().value);
          return value;
        }).finally(() => pending.delete(address));
        pending.set(address, request);
      }
      try { result = await pending.get(address); } catch { return false; }
    }
    return result.pubkey === pubkey;
  };
}