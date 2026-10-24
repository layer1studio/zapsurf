import test from 'node:test';
import assert from 'node:assert/strict';
import { CONTENT_TOKEN_RE, quoteReference, taggedQuotes, createQuoteContext, enterQuote } from '../js/quote-references.mjs';

const first = 'a'.repeat(64);
const second = 'b'.repeat(64);

test('tokenizes canonical and bare note/profile references without matching words or URLs twice', () => {
  const matches = [...'nostr:nevent1qqqq note1qqqq (npub1qqqq) xnote1qqqq https://example.com/note1qqqq'.matchAll(CONTENT_TOKEN_RE)];
  assert.equal(matches.length, 4);
  assert.equal(matches[0][2], 'nevent1qqqq');
  assert.equal(matches[1][3], 'note1qqqq');
  assert.equal(matches[2][3], 'npub1qqqq');
  assert.equal(matches[3][1], 'https://example.com/note1qqqq');
});

test('decodes note and nevent targets, preserving safe relay hints only', () => {
  assert.deepEqual(quoteReference('note', () => ({ type: 'note', data: first })), { id: first, relays: [] });
  assert.deepEqual(quoteReference('event', () => ({ type: 'nevent', data: { id: second, relays: ['wss://relay.example', 'https://bad.example', 'wss://user:secret@relay.example', 'wss://relay.example'] } })), { id: second, relays: ['wss://relay.example'] });
  assert.equal(quoteReference('profile', () => ({ type: 'npub', data: first })), null);
  assert.equal(quoteReference('broken', () => { throw new Error('Bad checksum'); }), null);
  assert.equal(quoteReference('invalid', () => ({ type: 'note', data: 'bad-id' })), null);
});

test('extracts unique q tags, never thread ancestors or replies', () => {
  assert.deepEqual(taggedQuotes([['q', first, 'wss://relay.example'], ['q', first], ['e', second, '', 'reply'], ['e', second, '', 'root'], ['q', 'invalid']]), [{ id: first, relays: ['wss://relay.example'] }]);
});

test('rejects circular quotes and limits nesting to two levels', () => {
  const context = createQuoteContext(first);
  assert.equal(enterQuote(context, first), null);
  const nested = enterQuote(context, second);
  assert.equal(nested.depth, 1);
  assert.equal(enterQuote(nested, first), null);
  const deepest = enterQuote(nested, 'c'.repeat(64));
  assert.equal(deepest.depth, 2);
  assert.equal(enterQuote(deepest, 'd'.repeat(64)), null);
});

test('shares quote and preview budgets between sibling quotes', () => {
  const context = createQuoteContext();
  for (const id of ['a', 'b', 'c', 'd']) {
    const child = enterQuote(context, id.repeat(64));
    assert.equal(child.budget, context.budget);
  }
  assert.equal(enterQuote(context, 'e'.repeat(64)), null);
  assert.equal(context.budget.quotes, 4);
});