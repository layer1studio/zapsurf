import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createDirectMessage, createLegacyDirectMessage, unwrapDirectMessage, unwrapLegacyDirectMessage, messageRelayUrls } from '../js/messages.mjs';
import { createMessageService } from '../js/message-service.mjs';

const sender = '1'.repeat(64);
const recipient = '2'.repeat(64);
const stranger = '3'.repeat(64);
const hash = event => createHash('sha256').update(JSON.stringify([
  0, event.pubkey, event.created_at, event.kind, event.tags, event.content
])).digest('hex');
let keyNumber = 0;
const keys = [];
const encrypt = (author, target, text) => JSON.stringify({ author, target, text });
const crypto = {
  now: () => 1000000,
  randomTime: () => 900000,
  getEventHash: hash,
  verifyEvent: event => event.sig === 'valid' && event.id === hash(event),
  signEvent: async template => {
    const event = { ...template, pubkey: sender, sig: 'valid' };
    return { ...event, id: hash(event) };
  },
  encrypt: async (target, text) => encrypt(sender, target, text),
  generateSecretKey: () => {
    const key = new Uint8Array(32).fill(++keyNumber);
    keys.push(key);
    return key;
  },
  encryptWithKey: (key, target, text) => encrypt(key[0].toString(16).padStart(2, '0').repeat(32), target, text),
  finalizeEvent: (template, key) => {
    const event = { ...template, pubkey: key[0].toString(16).padStart(2, '0').repeat(32), sig: 'valid' };
    return { ...event, id: hash(event) };
  }
};

function receiver(ownPubkey, alter = value => value) {
  return { ...crypto, decrypt: async (author, ciphertext) => {
    const envelope = JSON.parse(ciphertext);
    assert.equal(envelope.author, author);
    assert.equal(envelope.target, ownPubkey);
    return JSON.stringify(alter(JSON.parse(envelope.text)));
  } };
}

test('creates distinct recipient and sender wraps around the same unsigned rumor', async () => {
  const { rumor, wraps } = await createDirectMessage({ sender, recipient, content: 'hello' }, crypto);
  assert.equal(rumor.sig, undefined);
  assert.deepEqual(wraps.map(wrap => wrap.target), [recipient, sender]);
  assert.notEqual(wraps[0].event.pubkey, wraps[1].event.pubkey);
  for (const { target, event } of wraps) {
    const message = await unwrapDirectMessage(event, target, receiver(target));
    assert.equal(message.id, rumor.id);
    assert.equal(message.content, 'hello');
    assert.equal(message.peer, target === sender ? recipient : sender);
  }
  assert.ok(keys.every(key => key.every(byte => byte === 0)));
});

test('rejects invalid wrappers, seals, forged authors, hashes and unrelated recipients', async () => {
  const { wraps } = await createDirectMessage({ sender, recipient, content: 'hello' }, crypto);
  const wrap = wraps[0].event;
  await assert.rejects(unwrapDirectMessage({ ...wrap, sig: 'bad' }, recipient, receiver(recipient)));
  await assert.rejects(unwrapDirectMessage(wrap, stranger, receiver(stranger)));
  for (const change of [
    event => ({ ...event, sig: 'bad' }),
    event => event.kind === 14 ? { ...event, pubkey: stranger } : event,
    event => event.kind === 14 ? { ...event, id: stranger } : event,
    event => event.kind === 14 ? { ...event, sig: 'valid' } : event,
    event => event.kind === 14 ? { ...event, tags: [['p', stranger]] } : event
  ]) {
    await assert.rejects(unwrapDirectMessage(wrap, recipient, receiver(recipient, change)));
  }
});

test('rejects blank, oversized, self-addressed or invalid-key messages', async () => {
  for (const options of [
    { content: ' ' }, { content: 'a'.repeat(16001) }, { recipient: sender }, { recipient: 'invalid' }
  ]) {
    await assert.rejects(createDirectMessage({ sender, recipient, content: 'hello', ...options }, crypto));
  }
});

test('accepts only secure, deduplicated DM inbox relay URLs', () => {
  assert.deepEqual(messageRelayUrls({ kind: 10050, tags: [
    ['relay', 'wss://example.com'], ['relay', 'wss://example.com/'], ['relay', 'https://example.com'],
    ['relay', 'ws://example.com'], ['relay', 'wss://user:password@example.com'], null
  ] }), ['wss://example.com/']);
  assert.deepEqual(messageRelayUrls({ kind: 10002, tags: [['r', 'wss://example.com']] }), []);
});

function serviceFixture(cryptoOverrides = {}, historyRelays = []) {
  let session = { pubkey: sender, method: 'extension' };
  const published = [];
  const subscriptions = [];
  let subscription;
  let failRecipient = false;
  let failSender = false;
  let missingRecipient = false;
  const list = pubkey => {
    const event = { kind: 10050, pubkey, created_at: 900000, content: '',
      tags: [['relay', pubkey === sender ? 'wss://sender.example/' : 'wss://recipient.example/']], sig: 'valid' };
    return { ...event, id: hash(event) };
  };
  const pool = {
    querySync: async (relays, filter) => filter.kinds[0] === 10050
      ? (missingRecipient && filter.authors[0] === recipient ? [] : [list(filter.authors[0])]) : [],
    publish: (relays, event, options) => {
      published.push({ relays, event, options });
      return relays.map(relay => (relay.includes('recipient') ? failRecipient : failSender)
        ? Promise.reject(new Error('offline')) : Promise.resolve('accepted'));
    },
    subscribeMany: (relays, filter, options) => {
      subscription = { relays, filter, options, closed: false, close() { this.closed = true; } };
      subscriptions.push(subscription);
      return subscription;
    },
    close: () => {}
  };
  const service = createMessageService({ pool, discoveryRelays: ['wss://discovery.example/'],
    getSession: () => session, crypto: { ...crypto, ...cryptoOverrides }, getHistoryRelays: async () => historyRelays });
  return { service, published, pool, subscriptions, get subscription() { return subscription; },
    logout: () => { session = null; service.stop(); },
    failRecipient: value => { failRecipient = value; },
    failSender: value => { failSender = value; },
    missingRecipient: () => { missingRecipient = true; }
  };
}

test('discovers dedicated inboxes and publishes only per-target wraps', async () => {
  const fixture = serviceFixture();
  await fixture.service.start();
  assert.deepEqual(fixture.subscription.filter['#p'], [sender]);
  assert.deepEqual(fixture.subscription.filter.kinds, [1059]);
  assert.equal(typeof fixture.subscription.options.onauth, 'function');
  await fixture.service.send(recipient, 'private');
  assert.deepEqual(fixture.published.map(item => item.relays), [
    ['wss://recipient.example/'], ['wss://sender.example/']
  ]);
  assert.ok(fixture.published.every(item => item.event.kind === 1059));
  assert.equal(fixture.service.snapshot().messages[0].delivery, 'Accepted by inbox relays');
  fixture.logout();
  assert.equal(fixture.subscription.closed, true);
  assert.deepEqual(fixture.service.snapshot().messages, []);
});

test('refuses delivery without a recipient inbox list', async () => {
  const fixture = serviceFixture();
  await fixture.service.start();
  fixture.missingRecipient();
  await assert.rejects(fixture.service.send(recipient, 'private'), /not advertised/);
  assert.equal(fixture.published.length, 0);
});

test('retries only failed targets using the original encrypted envelope', async () => {
  const fixture = serviceFixture();
  await fixture.service.start();
  fixture.failRecipient(true);
  const id = await fixture.service.send(recipient, 'retry me');
  assert.equal(fixture.service.snapshot().messages[0].delivery, 'Not sent');
  assert.equal(fixture.service.snapshot().messages[0].retry, true);
  fixture.failRecipient(false);
  await fixture.service.retry(id);
  assert.equal(fixture.published.length, 3);
  assert.equal(fixture.published[2].event.id, fixture.published[0].event.id);
  assert.equal(fixture.service.snapshot().messages[0].retry, false);
});

test('reports a failed sender copy without marking the recipient copy unsent', async () => {
  const fixture = serviceFixture();
  await fixture.service.start();
  fixture.failSender(true);
  await fixture.service.send(recipient, 'history');
  assert.equal(fixture.service.snapshot().messages[0].delivery, 'Sent; history copy failed');
});

test('aborts an in-flight send on account change before publication', async () => {
  const fixture = serviceFixture();
  await fixture.service.start();
  const sending = fixture.service.send(recipient, 'do not publish');
  fixture.logout();
  await assert.rejects(sending, /session ended/);
  assert.equal(fixture.published.length, 0);
  assert.deepEqual(fixture.service.snapshot().messages, []);
});

test('deduplicates independently wrapped copies by inner message ID', async () => {
  const fixture = serviceFixture(receiver(sender));
  await fixture.service.start();
  const first = await createDirectMessage({ sender, recipient, content: 'same rumor' }, crypto);
  const second = await createDirectMessage({ sender, recipient, content: 'same rumor' }, crypto);
  fixture.subscription.options.onevent(first.wraps[1].event);
  fixture.subscription.options.onevent(first.wraps[1].event);
  fixture.subscription.options.onevent(second.wraps[1].event);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.service.snapshot().messages.length, 1);
});

test('pauses queued decryption after signer access is denied', async () => {
  let attempts = 0;
  const fixture = serviceFixture({ decrypt: async () => {
    attempts++;
    throw Object.assign(new Error('User denied access'), { dmSignerFailure: true });
  } });
  await fixture.service.start();
  const first = await createDirectMessage({ sender, recipient, content: 'first' }, crypto);
  const second = await createDirectMessage({ sender, recipient, content: 'second' }, crypto);
  fixture.subscription.options.onevent(first.wraps[1].event);
  fixture.subscription.options.onevent(second.wraps[1].event);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts, 1);
  assert.match(fixture.service.snapshot().status, /Signer access declined/);
});

test('publishes inbox settings as kind 10050 and rejects invalid relay settings', async () => {
  const fixture = serviceFixture();
  await fixture.service.start();
  for (const urls of [[], ['http://bad.example'], ['wss://one.example', 'wss://one.example/'],
    ['wss://one.example', 'wss://two.example', 'wss://three.example', 'wss://four.example']]) {
    await assert.rejects(fixture.service.saveRelays(urls));
  }
  await fixture.service.saveRelays(['wss://inbox.example']);
  assert.equal(fixture.published.length, 1);
  assert.equal(fixture.published[0].event.kind, 10050);
  assert.deepEqual(fixture.published[0].event.tags, [['relay', 'wss://inbox.example/']]);
  assert.deepEqual(fixture.published[0].relays, ['wss://discovery.example/']);
});

test('rejects a validly hashed rumor with an unsafe future timestamp', async () => {
  const { wraps } = await createDirectMessage({ sender, recipient, content: 'future' }, crypto);
  await assert.rejects(unwrapDirectMessage(wraps[0].event, recipient, receiver(recipient, event => {
    if (event.kind !== 14) return event;
    const rumor = { ...event, created_at: Number.MAX_SAFE_INTEGER };
    return { ...rumor, id: hash(rumor) };
  })));
});

test('loads older history from the oldest returned envelope instead of skipping recent overflow', async () => {
  const fixture = serviceFixture(receiver(sender));
  await fixture.service.start();
  const { wraps } = await createDirectMessage({ sender, recipient, content: 'recent history' }, crypto);
  fixture.subscription.options.onevent(wraps[1].event);
  fixture.subscription.options.oneose();
  let filter;
  fixture.pool.querySync = async (relays, query) => { filter = query; return []; };
  await fixture.service.loadOlder();
  assert.equal(filter.until, wraps[1].event.created_at - 1);
});

function legacyMessage(author, target, overrides = {}) {
  const event = { kind: 4, pubkey: author, created_at: 500000, content: 'encrypted legacy payload',
    tags: [['p', target]], sig: 'valid', ...overrides };
  return { ...event, id: hash(event) };
}

test('decrypts received and sent legacy messages using the other participant key', async () => {
  const peers = [];
  const dependencies = { ...crypto, decryptLegacy: async pubkey => { peers.push(pubkey); return 'old conversation'; } };
  for (const event of [legacyMessage(recipient, sender), legacyMessage(sender, recipient)]) {
    const message = await unwrapLegacyDirectMessage(event, sender, dependencies);
    assert.equal(message.peer, recipient);
    assert.equal(message.legacy, true);
    assert.equal(message.content, 'old conversation');
  }
  assert.deepEqual(peers, [recipient, recipient]);
});

test('rejects legacy messages with invalid signatures or unrelated participants before decrypting', async () => {
  let calls = 0;
  const dependencies = { ...crypto, decryptLegacy: async () => { calls++; return 'do not display'; } };
  for (const event of [legacyMessage(recipient, sender, { sig: 'bad' }), legacyMessage(recipient, stranger),
    legacyMessage(sender, recipient, { tags: [['p', recipient], ['p', stranger]] }),
    legacyMessage(recipient, sender, { created_at: Number.MAX_SAFE_INTEGER })]) {
    await assert.rejects(unwrapLegacyDirectMessage(event, sender, dependencies));
  }
  assert.equal(calls, 0);
});

test('initial NIP-17 history includes conversations older than 32 days', async () => {
  const fixture = serviceFixture();
  await fixture.service.start();
  assert.equal('since' in fixture.subscription.filter, false);
});

test('reads legacy history without a NIP-17 inbox and discovers lists on account relays', async () => {
  const history = ['wss://account.example/'];
  const fixture = serviceFixture({ decryptLegacy: async () => 'recovered history' }, history);
  let discovery;
  fixture.pool.querySync = async (relays, filter) => {
    if (filter.kinds.includes(10050)) discovery = relays;
    return [];
  };
  await fixture.service.start();
  assert.deepEqual(discovery, ['wss://discovery.example/', ...history]);
  assert.equal(fixture.subscriptions.length, 2);
  assert.deepEqual(fixture.subscriptions[0].filter, { kinds: [4], '#p': [sender], limit: 100 });
  assert.deepEqual(fixture.subscriptions[1].filter, { kinds: [4], authors: [sender], limit: 100 });
  fixture.subscriptions[0].options.onevent(legacyMessage(recipient, sender));
  fixture.subscriptions[1].options.onevent(legacyMessage(sender, recipient));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.service.snapshot().messages.length, 2);
  assert.equal(fixture.published.length, 0);
  fixture.logout();
  assert.ok(fixture.subscriptions.every(subscription => subscription.closed));
});

test('legacy history access denial does not pause secure NIP-17 decryption', async () => {
  const fixture = serviceFixture({ ...receiver(sender), decryptLegacy: async () => {
    throw Object.assign(new Error('No legacy permission'), { dmSignerFailure: true });
  } }, ['wss://account.example/']);
  await fixture.service.start();
  fixture.subscriptions.find(subscription => subscription.filter.kinds.includes(4)).options.onevent(legacyMessage(recipient, sender));
  const { wraps } = await createDirectMessage({ sender, recipient, content: 'secure remains available' }, crypto);
  fixture.subscriptions.find(subscription => subscription.filter.kinds.includes(1059)).options.onevent(wraps[1].event);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.service.snapshot().messages[0].content, 'secure remains available');
});

test('paginates received and sent legacy history independently', async () => {
  const fixture = serviceFixture({ decryptLegacy: async () => 'history' }, ['wss://account.example/']);
  await fixture.service.start();
  const received = fixture.subscriptions.find(subscription => subscription.filter.kinds.includes(4) && subscription.filter['#p']);
  const sent = fixture.subscriptions.find(subscription => subscription.filter.kinds.includes(4) && subscription.filter.authors);
  received.options.onevent(legacyMessage(recipient, sender, { created_at: 400000 }));
  sent.options.onevent(legacyMessage(sender, recipient, { created_at: 600000 }));
  received.options.oneose();
  sent.options.oneose();
  const filters = [];
  fixture.pool.querySync = async (relays, filter) => { filters.push(filter); return []; };
  await fixture.service.loadOlder();
  assert.equal(filters.find(filter => filter.kinds.includes(4) && filter['#p']).until, 399999);
  assert.equal(filters.find(filter => filter.kinds.includes(4) && filter.authors).until, 599999);
});

test('preflights recipient inbox readiness without publishing', async () => {
  const fixture = serviceFixture();
  await fixture.service.start();
  assert.deepEqual(await fixture.service.checkRecipient(recipient), { ready: true, reason: '' });
  const missing = serviceFixture();
  await missing.service.start();
  missing.missingRecipient();
  const result = await missing.service.checkRecipient(recipient);
  assert.equal(result.ready, false);
  assert.match(result.reason, /not advertised/);
  assert.equal(missing.published.length, 0);
});

test('legacy sending requires explicit opt-in and does not require a NIP-17 inbox', async () => {
  const fixture = serviceFixture({ encryptLegacy: async (pubkey, content) => `ciphertext:${pubkey}:${content}` }, ['wss://legacy.example/']);
  fixture.pool.querySync = async () => [];
  await fixture.service.start();
  assert.equal((await fixture.service.checkRecipient(recipient)).ready, false);
  assert.equal((await fixture.service.checkRecipient(recipient, { legacy: true })).ready, true);
  await assert.rejects(fixture.service.send(recipient, 'no automatic downgrade'));
  assert.equal(fixture.published.length, 0);
  await fixture.service.send(recipient, 'explicit legacy', { legacy: true });
  assert.ok(fixture.published.every(item => item.event.kind === 4));
  assert.ok(fixture.published.every(item => item.event.content.startsWith('ciphertext:')));
  assert.ok(fixture.published.every(item => !item.event.content.startsWith('explicit legacy')));
  assert.equal(fixture.service.snapshot().messages[0].legacy, true);
  assert.equal(fixture.service.snapshot().messages[0].delivery, 'Accepted by relays (legacy)');
});

test('legacy envelope encrypts before signing and rejects invalid messages', async () => {
  const dependencies = { ...crypto, encryptLegacy: async () => 'encrypted only' };
  const { event, message } = await createLegacyDirectMessage({ sender, recipient, content: 'private text' }, dependencies);
  assert.equal(event.content, 'encrypted only');
  assert.equal(message.content, 'private text');
  for (const options of [{ recipient: sender }, { content: '' }, { content: 'a'.repeat(16001) }]) {
    await assert.rejects(createLegacyDirectMessage({ sender, recipient, content: 'text', ...options }, dependencies));
  }
});