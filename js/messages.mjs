const HEX64 = /^[0-9a-f]{64}$/;
export const DM_MAX_TEXT_BYTES = 16000;
export const DM_MAX_EVENT_BYTES = 100000;
export const DM_OVERLAP_SECONDS = 2 * 24 * 60 * 60;

function requireKey(pubkey) {
  if (!HEX64.test(pubkey)) throw new Error('Invalid message public key.');
}

function checkSize(text, maximum) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > maximum) {
    throw new Error('Message exceeds the supported size.');
  }
}

function parseEvent(text) {
  checkSize(text, DM_MAX_EVENT_BYTES);
  const event = JSON.parse(text);
  if (!event || typeof event !== 'object' || !Array.isArray(event.tags) ||
      !event.tags.every(tag => Array.isArray(tag) && tag.every(value => typeof value === 'string')) ||
      !Number.isSafeInteger(event.created_at) || event.created_at < 0 || typeof event.content !== 'string') {
    throw new Error('Invalid private message.');
  }
  requireKey(event.pubkey);
  return event;
}

export async function createDirectMessage({ sender, recipient, content }, crypto) {
  requireKey(sender);
  requireKey(recipient);
  if (sender === recipient) throw new Error('Choose another person to message.');
  checkSize(content, DM_MAX_TEXT_BYTES);
  if (!content.trim()) throw new Error('Enter a message.');
  const rumor = {
    pubkey: sender, created_at: crypto.now(), kind: 14,
    tags: [['p', recipient]], content
  };
  rumor.id = crypto.getEventHash(rumor);
  const wraps = [];
  for (const target of [recipient, sender]) {
    const seal = await crypto.signEvent({
      kind: 13, tags: [], created_at: crypto.randomTime(),
      content: await crypto.encrypt(target, JSON.stringify(rumor))
    });
    if (seal.pubkey !== sender || !crypto.verifyEvent(seal)) throw new Error('Invalid message seal.');
    const secret = crypto.generateSecretKey();
    try {
      const wrap = crypto.finalizeEvent({
        kind: 1059, created_at: crypto.randomTime(), tags: [['p', target]],
        content: crypto.encryptWithKey(secret, target, JSON.stringify(seal))
      }, secret);
      wraps.push({ target, event: wrap });
    } finally {
      secret.fill(0);
    }
  }
  return { rumor, wraps };
}

export async function unwrapDirectMessage(wrap, ownPubkey, crypto) {
  requireKey(ownPubkey);
  checkSize(JSON.stringify(wrap), DM_MAX_EVENT_BYTES);
  if (wrap?.kind !== 1059 || !crypto.verifyEvent(wrap) ||
      !Array.isArray(wrap.tags) || !wrap.tags.some(tag => tag?.[0] === 'p' && tag[1] === ownPubkey)) {
    throw new Error('Invalid message envelope.');
  }
  const seal = parseEvent(await crypto.decrypt(wrap.pubkey, wrap.content));
  if (seal.kind !== 13 || seal.tags.length || !crypto.verifyEvent(seal)) {
    throw new Error('Invalid message seal.');
  }
  const rumor = parseEvent(await crypto.decrypt(seal.pubkey, seal.content));
  const recipients = rumor.tags.filter(tag => tag[0] === 'p').map(tag => tag[1]);
  if (rumor.kind !== 14 || 'sig' in rumor || rumor.pubkey !== seal.pubkey ||
      rumor.created_at > crypto.now() + 300 ||
      rumor.id !== crypto.getEventHash(rumor) || recipients.length !== 1 ||
      !HEX64.test(recipients[0]) || recipients[0] === rumor.pubkey ||
      (rumor.pubkey !== ownPubkey && recipients[0] !== ownPubkey)) {
    throw new Error('Invalid direct message.');
  }
  checkSize(rumor.content, DM_MAX_TEXT_BYTES);
  return { ...rumor, peer: rumor.pubkey === ownPubkey ? recipients[0] : rumor.pubkey };
}

export async function unwrapLegacyDirectMessage(event, ownPubkey, crypto) {
  requireKey(ownPubkey);
  checkSize(JSON.stringify(event), DM_MAX_EVENT_BYTES);
  if (event?.kind !== 4 || !crypto.verifyEvent(event) || !Array.isArray(event.tags) ||
      !Number.isSafeInteger(event.created_at) || event.created_at < 0 || event.created_at > crypto.now() + 300) {
    throw new Error('Invalid legacy message.');
  }
  requireKey(event.pubkey);
  const recipients = event.tags.filter(tag => Array.isArray(tag) && tag[0] === 'p').map(tag => tag[1]);
  if (recipients.length !== 1 || !HEX64.test(recipients[0]) || recipients[0] === event.pubkey ||
      (event.pubkey !== ownPubkey && recipients[0] !== ownPubkey)) throw new Error('Invalid legacy recipient.');
  const peer = event.pubkey === ownPubkey ? recipients[0] : event.pubkey;
  const content = await crypto.decryptLegacy(peer, event.content);
  checkSize(content, DM_MAX_TEXT_BYTES);
  return { id: event.id, pubkey: event.pubkey, created_at: event.created_at, kind: 4,
    tags: event.tags, content, peer, legacy: true };
}

export async function createLegacyDirectMessage({ sender, recipient, content }, crypto) {
  requireKey(sender);
  requireKey(recipient);
  if (sender === recipient) throw new Error('Choose another person to message.');
  checkSize(content, DM_MAX_TEXT_BYTES);
  if (!content.trim()) throw new Error('Enter a message.');
  const ciphertext = await crypto.encryptLegacy(recipient, content);
  const event = await crypto.signEvent({ kind: 4, created_at: crypto.now(), tags: [['p', recipient]], content: ciphertext });
  if (event.pubkey !== sender || event.kind !== 4 || event.content !== ciphertext ||
      JSON.stringify(event.tags) !== JSON.stringify([['p', recipient]]) || !crypto.verifyEvent(event)) {
    throw new Error('Invalid legacy message signature.');
  }
  return { event, message: { ...event, content, peer: recipient, legacy: true } };
}

export function messageRelayUrls(event) {
  if (event?.kind !== 10050 || !Array.isArray(event.tags)) return [];
  return [...new Set(event.tags.filter(tag => Array.isArray(tag) && tag[0] === 'relay').flatMap(tag => {
    try {
      const url = new URL(tag[1]);
      return url.protocol === 'wss:' && !url.username && !url.password && !url.hash ? [url.href] : [];
    } catch { return []; }
  }))];
}