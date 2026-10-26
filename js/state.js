import { SimplePool, nip19 } from './deps.js';
import { safeHttpUrl, store } from './util.js';
import { contentCache } from './cache.mjs';

export const DEFAULT_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'];
export const PROFILE_RELAYS = ['wss://purplepag.es', 'wss://relay.primal.net', 'wss://relay.damus.io'];
export const NOSTRCONNECT_RELAYS = ['wss://relay.nsec.app', 'wss://relay.primal.net'];
export const ZAP_PRESETS = [21, 100, 500, 1000, 5000];

export const pool = new SimplePool();
export const profiles = new Map();
export const noteStats = new Map();
export const noteActions = new Map();
const PROFILE_CACHE_MS = 7 * 24 * 60 * 60 * 1000;

export function rememberProfile(ev) {
  if (ev?.kind !== 0 || typeof ev.pubkey !== 'string' || typeof ev.content !== 'string') return;
  const prev = profiles.get(ev.pubkey);
  if (!prev || prev.created_at < ev.created_at) {
    profiles.set(ev.pubkey, ev);
    contentCache.set(`profile-event:${ev.pubkey}`, ev, PROFILE_CACHE_MS);
  }
}

export function parseProfile(pubkey) {
  const ev = profiles.get(pubkey);
  let data = {};
  if (ev) {
    try { data = JSON.parse(ev.content) || {}; } catch { /* malformed profile */ }
  }
  const npub = nip19.npubEncode(pubkey);
  return {
    name: data.display_name || data.name || `${npub.slice(0, 12)}…`,
    picture: safeHttpUrl(data.picture || ''),
    nip05: typeof data.nip05 === 'string' ? data.nip05.trim() : '',
    lud16: typeof data.lud16 === 'string' ? data.lud16 : '',
    lud06: typeof data.lud06 === 'string' ? data.lud06 : '',
    npub,
    event: ev
  };
}

export async function ensureProfile(pubkey) {
  if (!profiles.has(pubkey)) {
    const cached = contentCache.get(`profile-event:${pubkey}`);
    if (cached?.kind === 0 && cached.pubkey === pubkey && typeof cached.content === 'string') rememberProfile(cached);
    if (!profiles.has(pubkey)) {
      const ev = await pool.get(PROFILE_RELAYS, { kinds: [0], authors: [pubkey] }, { maxWait: 6000 }).catch(() => null);
      if (ev) rememberProfile(ev);
    }
  }
  return parseProfile(pubkey);
}

export function statsFor(id) {
  if (!noteStats.has(id)) noteStats.set(id, { likes: 0, replies: 0, reposts: 0, zaps: 0, satszapped: 0 });
  return noteStats.get(id);
}

export function actionsFor(id) {
  if (!noteActions.has(id)) noteActions.set(id, { liked: false, replied: false, reposted: false, zapped: false });
  return noteActions.get(id);
}

const MIN_ZAP_SATS_KEY = 'zs-min-zap-sats';
const SHOW_ALL_FOLLOWS_KEY = 'zs-show-all-follows';
const DEFAULT_ZAP_KEY = 'zs-default-zap';
const SHOW_PROFILE_BADGES_KEY = 'zs-show-profile-badges';
export const MAX_MIN_ZAP_SATS = 100_000_000;

function validInt(value, max) {
  return Number.isInteger(value) && value >= 0 && value <= max;
}

export const settings = {
  minZapSats: validInt(store.get(MIN_ZAP_SATS_KEY), MAX_MIN_ZAP_SATS) ? store.get(MIN_ZAP_SATS_KEY) : 100,
  showAllFollows: store.get(SHOW_ALL_FOLLOWS_KEY) === true,
  showProfileBadges: store.get(SHOW_PROFILE_BADGES_KEY) !== false,
  defaultZap: validInt(store.get(DEFAULT_ZAP_KEY), 10_000_000) ? store.get(DEFAULT_ZAP_KEY) : 0,
  setMinZapSats(value) {
    this.minZapSats = value;
    store.set(MIN_ZAP_SATS_KEY, value);
  },
  setShowAllFollows(value) {
    this.showAllFollows = value;
    store.set(SHOW_ALL_FOLLOWS_KEY, value);
  },
  setDefaultZap(value) {
    this.defaultZap = value;
    store.set(DEFAULT_ZAP_KEY, value);
  },
  setShowProfileBadges(value) {
    this.showProfileBadges = value;
    store.set(SHOW_PROFILE_BADGES_KEY, value);
  }
};
