import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptedBadgeReferences, verifiedProfileBadges, createProfileBadgeLoader } from '../js/profile-badges.mjs';

const self = 'a'.repeat(64);
const issuer = 'b'.repeat(64);
const awardId = 'c'.repeat(64);
const address = `30009:${issuer}:bravery`;
const verify = event => event.signatureValid !== false;
const event = (kind, pubkey, tags, extra = {}) => ({ kind, pubkey, tags, id: 'd'.repeat(64), created_at: 100, ...extra });
const list = event(10008, self, [['a', address], ['e', awardId]]);
const award = event(8, issuer, [['a', address], ['p', self]], { id: awardId });
const definition = event(30009, issuer, [['d', 'bravery'], ['name', 'Bravery'], ['thumb', 'https://example.com/badge.png']]);
const references = () => acceptedBadgeReferences([list], self, verify);

test('accepts current and legacy profile lists and preserves accepted display order', () => {
  assert.equal(references()[0].awardId, awardId);
  const legacy = { ...list, kind: 30008, tags: [['d', 'profile_badges'], ...list.tags] };
  assert.equal(acceptedBadgeReferences([legacy], self, verify).length, 1);
  const cleared = { ...list, created_at: 101, tags: [] };
  assert.deepEqual(acceptedBadgeReferences([legacy, cleared], self, verify), []);
  const secondAddress = `30009:${issuer}:honor`;
  const ordered = { ...list, tags: [...list.tags, ['a', secondAddress], ['e', 'e'.repeat(64)]] };
  assert.deepEqual(acceptedBadgeReferences([ordered], self, verify).map(reference => reference.address), [address, secondAddress]);
});

test('ignores unpaired, malformed, duplicate, foreign and unsigned accepted badges', () => {
  const malformed = { ...list, tags: [['a', address], ['name', 'gap'], ['e', awardId], ...list.tags, ...list.tags] };
  assert.equal(acceptedBadgeReferences([malformed], self, verify).length, 1);
  for (const invalid of [{ ...list, pubkey: issuer }, { ...list, signatureValid: false }, { ...list, tags: [null] }]) {
    assert.deepEqual(acceptedBadgeReferences([invalid], self, verify), []);
  }
});

test('requires a signed issuer award to the profile and a matching signed definition', () => {
  assert.equal(verifiedProfileBadges(references(), [award, definition], self, verify)[0].name, 'Bravery');
  const invalidAwards = [
    { ...award, pubkey: self },
    { ...award, signatureValid: false },
    { ...award, tags: [['a', address], ['p', issuer]] },
    { ...award, tags: [['a', `${address}-other`], ['p', self]] },
    { ...award, tags: [...award.tags, ['a', address]] }
  ];
  for (const invalid of invalidAwards) {
    assert.deepEqual(verifiedProfileBadges(references(), [invalid, definition], self, verify), []);
  }
  for (const invalid of [{ ...definition, pubkey: self }, { ...definition, signatureValid: false }, { ...definition, tags: [['d', 'other']] }]) {
    assert.deepEqual(verifiedProfileBadges(references(), [award, invalid], self, verify), []);
  }
});

test('uses the latest definition, breaks timestamp ties by ID, and rejects unsafe images', () => {
  const updated = { ...definition, id: '0'.repeat(64), tags: [['d', 'bravery'], ['name', 'Updated'], ['thumb', 'javascript:alert(1)']] };
  const [badge] = verifiedProfileBadges(references(), [award, definition, updated], self, verify);
  assert.equal(badge.name, 'Updated');
  assert.equal(badge.image, null);
});

test('deduplicates pending lookups and caches only successful queries until expiry', async () => {
  let time = 0;
  let calls = 0;
  let fail = true;
  const loader = createProfileBadgeLoader({
    query: async (_relays, filters) => {
      calls++;
      if (fail) throw new Error('Offline');
      return filters[0].kinds[0] === 10008 ? [list] : [award, definition];
    },
    relaysFor: async () => ['wss://relay.example'], verifyEvent: verify, now: () => time, ttlMs: 100
  });
  await assert.rejects(loader(self), /Offline/);
  fail = false;
  const [first, second] = await Promise.all([loader(self), loader(self)]);
  assert.equal(first, second);
  assert.equal(first.length, 1);
  assert.equal(calls, 3);
  await loader(self);
  assert.equal(calls, 3);
  time = 101;
  await loader(self);
  assert.equal(calls, 5);
});