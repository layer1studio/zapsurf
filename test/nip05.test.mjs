import test from 'node:test';
import assert from 'node:assert/strict';
import { createNip05Verifier } from '../js/nip05.mjs';

const pubkey = 'a'.repeat(64);

test('verifies only when the NIP-05 address resolves to the author', async () => {
  const verify = createNip05Verifier({ queryProfile: async () => ({ pubkey }) });
  assert.equal(await verify('alice@example.com', pubkey), true);
  assert.equal(await verify('alice@example.com', 'b'.repeat(64)), false);
  assert.equal(await verify('', pubkey), false);
  assert.equal(await verify(null, pubkey), false);
  assert.equal(await verify('alice@example.com', 'invalid'), false);
});

test('shares pending lookups and caches results until expiration', async () => {
  let calls = 0;
  let time = 0;
  const verify = createNip05Verifier({
    queryProfile: async () => { calls++; return { pubkey }; }, now: () => time, ttlMs: 100
  });
  assert.deepEqual(await Promise.all([
    verify('alice@example.com', pubkey), verify('alice@example.com', pubkey)
  ]), [true, true]);
  assert.equal(await verify('alice@example.com', pubkey), true);
  assert.equal(calls, 1);
  time = 100;
  assert.equal(await verify('alice@example.com', pubkey), true);
  assert.equal(calls, 2);
});

test('missing identifiers and failed requests never produce verification', async () => {
  const missing = createNip05Verifier({ queryProfile: async () => null });
  assert.equal(await missing('alice@example.com', pubkey), false);
  let calls = 0;
  const verify = createNip05Verifier({ queryProfile: async () => {
    if (++calls === 1) throw new Error('offline');
    return { pubkey };
  } });
  assert.equal(await verify('alice@example.com', pubkey), false);
  assert.equal(await verify('alice@example.com', pubkey), true);
});