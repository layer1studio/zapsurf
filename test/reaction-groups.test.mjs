import test from 'node:test';
import assert from 'node:assert/strict';
import { groupReactions, mergeReactionGroups } from '../js/reaction-groups.mjs';

const reaction = (content, pubkey = 'alice', target = 'note') => ({
  kind: 7, content, pubkey, tags: [['e', target]]
});

test('groups hearts and emoji with unique reactors per reaction', () => {
  assert.deepEqual(groupReactions([
    reaction('+'), reaction(''), reaction('\u2764', 'bob'), reaction('\u2764\uFE0F', 'carol'),
    reaction('\u{1F525}'), reaction('\u{1F525}'), reaction('\u{1F525}', 'bob'), reaction('-')
  ], 'note'), [
    { content: '\u2764\uFE0F', pubkeys: ['alice', 'bob', 'carol'] },
    { content: '\u{1F525}', pubkeys: ['alice', 'bob'] },
    { content: '-', pubkeys: ['alice'] }
  ]);
});

test('only includes kind-7 events whose last event tag targets this note', () => {
  assert.deepEqual(groupReactions([
    reaction('+', 'alice', 'other'), { ...reaction('+'), kind: 1 },
    { ...reaction('+'), tags: [['e', 'note'], ['e', 'other']] },
    { ...reaction('+'), tags: [['e', 'other'], ['e', 'note']] }
  ], 'note'), [{ content: '\u2764\uFE0F', pubkeys: ['alice'] }]);
});

test('merges locally published reactions with relay results without double counting', () => {
  assert.deepEqual(mergeReactionGroups(
    [{ content: '\u{1F525}', pubkeys: ['alice'] }],
    [{ content: '\u{1F525}', pubkeys: ['alice', 'bob'] }]
  ), [{ content: '\u{1F525}', pubkeys: ['alice', 'bob'] }]);
  assert.deepEqual(groupReactions([], 'note'), []);
});