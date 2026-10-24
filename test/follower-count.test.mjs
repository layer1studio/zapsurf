import test from 'node:test';
import assert from 'node:assert/strict';
import { countFollowers, createFollowerCountLoader } from '../js/follower-count.mjs';

const target = 'a'.repeat(64);
const author = 'b'.repeat(64);
const otherAuthor = 'c'.repeat(64);
const event = (pubkey, tags, extra = {}) => ({ kind: 3, pubkey, tags, ...extra });

test('counts unique valid authors with a matching p tag', () => {
  assert.equal(countFollowers([
    event(author, [['p', target], ['p', target]]),
    event(author, [['p', target]]),
    event(otherAuthor, [['p', target]]),
    event('invalid', [['p', target]]),
    event('d'.repeat(64), [['p', 'invalid']]),
    event('e'.repeat(64), [['p', target]], { kind: 1 }),
    event('f'.repeat(64), [['p', target]], { tags: null })
  ], target), 2);
});

test('queries relay candidates once and reuses the cached count until expiry', async () => {
  let time = 0;
  const values = new Map();
  const cache = {
    get(key) {
      const entry = values.get(key);
      if (!entry || entry.expiresAt <= time) return null;
      return entry.value;
    },
    set(key, value, ttlMs) { values.set(key, { value, expiresAt: time + ttlMs }); }
  };
  const calls = [];
  const loader = createFollowerCountLoader({
    query: async (...args) => {
      calls.push(args);
      return [event(author, [['p', target]])];
    },
    cache,
    relays: ['wss://relay.example'],
    ttlMs: 100
  });

  assert.equal(await loader(target), 1);
  assert.equal(await loader(target), 1);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [['wss://relay.example'], { kinds: [3], '#p': [target] }]);

  time = 100;
  assert.equal(await loader(target), 1);
  assert.equal(calls.length, 2);
});

test('does not cache query failures or treat them as a zero count', async () => {
  const values = new Map();
  const cache = {
    get: key => values.get(key) ?? null,
    set: (key, value) => values.set(key, value)
  };
  let fail = true;
  const loader = createFollowerCountLoader({
    query: async () => {
      if (fail) throw new Error('relay unavailable');
      return [];
    },
    cache,
    relays: []
  });

  await assert.rejects(loader(target), /relay unavailable/);
  fail = false;
  assert.equal(await loader(target), 0);
  assert.equal(await loader(target), 0);
});