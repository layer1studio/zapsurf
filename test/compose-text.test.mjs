import test from 'node:test';
import assert from 'node:assert/strict';
import { rebaseMentions, serializeMentions } from '../js/compose-text.mjs';

const mention = { start: 3, end: 7, text: '@Ada', pubkey: 'a'.repeat(64) };

test('moves mention spans when text is inserted before them', () => {
  assert.deepEqual(rebaseMentions('Hi @Ada', 'Hey! Hi @Ada', [mention]), [
    { ...mention, start: 8, end: 12 }
  ]);
});

test('drops a mention token when its visible text is edited', () => {
  assert.deepEqual(rebaseMentions('Hi @Ada', 'Hi @Adam', [mention]), []);
});

test('serializes intact selected mentions to canonical Nostr references', () => {
  const content = serializeMentions('Hi @Ada!', [mention], pubkey => `npub-for-${pubkey.slice(0, 1)}`);
  assert.equal(content, 'Hi nostr:npub-for-a!');
});

test('does not serialize stale mention spans', () => {
  const content = serializeMentions('Hi @Adam!', [mention], () => 'npub1encoded');
  assert.equal(content, 'Hi @Adam!');
});

test('preserves the space after a selected mention before and after typing', () => {
  const initial = 'Hi @Ada ';
  const next = `${initial}hello`;
  const rebased = rebaseMentions(initial, next, [mention]);
  assert.deepEqual(rebased, [mention]);
  assert.equal(serializeMentions(initial, [mention], () => 'npub1encoded'), 'Hi nostr:npub1encoded ');
  assert.equal(serializeMentions(next, rebased, () => 'npub1encoded'), 'Hi nostr:npub1encoded hello');
});

test('preserves separators between multiple selected mentions', () => {
  const second = { start: 8, end: 12, text: '@Bob', pubkey: 'b'.repeat(64) };
  assert.equal(
    serializeMentions('Hi @Ada @Bob hello', [mention, second], pubkey => `npub-for-${pubkey[0]}`),
    'Hi nostr:npub-for-a nostr:npub-for-b hello'
  );
});