import { verifyEvent } from './deps.js';
import { pool, PROFILE_RELAYS } from './state.js';
import { getWriteRelays, uniqueRelays } from './relays.js';
import { getSession, canSign, signEvent } from './signer.js';
import { store } from './util.js';
import { selectBlossomServers, normaliseBlossomServer, uploadImage } from './blossom.mjs';

const discoveries = new Map();
const pending = new Map();
const fallbackKey = pubkey => `zs-blossom-server:${pubkey}`;

export function getBlossomFallback(pubkey) {
  return pubkey ? normaliseBlossomServer(store.get(fallbackKey(pubkey), '')) || '' : '';
}

export function setBlossomFallback(pubkey, value) {
  if (!pubkey) throw new Error('Log in to configure a Blossom server.');
  const server = value.trim() ? normaliseBlossomServer(value) : '';
  if (value.trim() && !server) throw new Error('Enter an HTTPS server origin, without a path, query or credentials.');
  if (server) store.set(fallbackKey(pubkey), server);
  else store.remove(fallbackKey(pubkey));
}

export async function discoverBlossomServers(pubkey, { refresh = false } = {}) {
  const cached = discoveries.get(pubkey);
  if (!refresh && cached?.expires > Date.now()) return cached.servers;
  if (pending.has(pubkey)) return pending.get(pubkey);
  const request = (async () => {
    const relays = uniqueRelays(PROFILE_RELAYS, await getWriteRelays(pubkey));
    const events = await pool.querySync(relays, { kinds: [10063], authors: [pubkey] }, { maxWait: 6000 });
    const servers = selectBlossomServers(events, pubkey, verifyEvent);
    discoveries.set(pubkey, { servers, expires: Date.now() + (servers.length ? 300000 : 30000) });
    return servers;
  })();
  pending.set(pubkey, request);
  try { return await request; } finally { pending.delete(pubkey); }
}

export async function resolveBlossomServer(pubkey) {
  let servers;
  try {
    servers = await discoverBlossomServers(pubkey);
  } catch {
    throw new Error('Could not check your Blossom server list. Open Settings to check the connection and retry.');
  }
  const server = servers[0] || getBlossomFallback(pubkey);
  if (!server) throw new Error('No Blossom server found. Add your fallback server in Settings.');
  return server;
}

export function uploadBlossomImage(file, server, pubkey, signal) {
  return uploadImage(file, server, {
    signal,
    signEvent: template => {
      signal.throwIfAborted();
      if (!canSign() || getSession()?.pubkey !== pubkey) throw new Error('Your account changed. Select the images again.');
      return signEvent(template);
    }
  });
}