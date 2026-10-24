import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyUserActivity, createActivityPager, filterActivity, followActivity, mergeActivity } from '../js/user-activity.mjs';

const pubkey = 'a'.repeat(64);
const parent = 'b'.repeat(64);
const root = 'c'.repeat(64);
const account = 'd'.repeat(64);
const event = (id, kind, tags = [], extra = {}) => ({ id, pubkey, kind, tags, created_at: 10, content: '', ...extra });

test('classifies original posts, replies, reactions, reposts and validated sent zaps', () => {
  const events = [
    event('post', 1),
    event('reply', 1, [['e', root, '', 'root'], ['e', parent, '', 'reply']]),
    event('like', 7, [['e', root], ['e', parent]], { content: '+' }),
    event('repost', 6, [['e', parent]]),
    event('zap', 9735, [], { pubkey: account }),
    event('unpaid', 9734),
    event('other', 1, [], { pubkey: account })
  ];
  const zaps = new Map([['zap', { sender: pubkey, recipient: account, sats: 21, targetId: parent }]]);
  const items = classifyUserActivity(events, pubkey, zaps);
  assert.deepEqual(items.map(item => [item.id, item.type]), [
    ['like', 'like'], ['post', 'post'], ['reply', 'reply'], ['repost', 'repost'], ['zap', 'zap']
  ]);
  assert.equal(items.find(item => item.type === 'reply').targetId, parent);
  assert.equal(items.find(item => item.type === 'like').targetId, parent);
});

test('handles legacy replies, mentions, actual reactions, generic reposts and profile zaps', () => {
  const events = [
    event('legacy', 1, [['e', root], ['e', parent]]),
    event('mention', 1, [['e', parent, '', 'mention']]),
    event('negative', 7, [['e', parent]], { content: '-' }),
    event('generic', 16, [['e', parent], ['k', '30023']]),
    event('bad', 7, [['e', 'invalid']]),
    event('bad-reply', 1, [['e', 'invalid', '', 'reply']]),
    event('zap', 9735), event('unvalidated', 9735)
  ];
  const items = classifyUserActivity(events, pubkey, new Map([['zap', { sender: pubkey, recipient: account, sats: 10 }]]));
  assert.equal(items.find(item => item.id === 'legacy').targetId, parent);
  assert.equal(items.find(item => item.id === 'mention').type, 'post');
  assert.equal(items.find(item => item.id === 'negative').reaction, '-');
  assert.equal(items.find(item => item.id === 'generic').targetKind, 30023);
  assert.equal(items.find(item => item.id === 'bad-reply').targetId, 'bad-reply');
  assert.equal(items.find(item => item.id === 'bad-reply').type, 'post');
  assert.equal(items.find(item => item.id === 'zap').targetId, null);
  assert.ok(!items.some(item => ['bad', 'unvalidated'].includes(item.id)));
});

test('follows require a baseline and emit additions, not removals or existing contacts', () => {
  const first = event('first', 3, [['p', parent]], { created_at: 1 });
  const second = event('second', 3, [['p', parent], ['p', account], ['p', account]], { created_at: 2 });
  const third = event('third', 3, [['p', account]], { created_at: 3 });
  const fourth = event('fourth', 3, [['p', account], ['p', root]], { created_at: 4 });
  assert.deepEqual(followActivity([second], pubkey), []);
  assert.deepEqual(followActivity([fourth, third, first, second, second], pubkey).map(item => [item.account, item.created_at]), [[root, 4], [account, 2]]);
});

test('merge deduplicates source IDs, not posts targeted by multiple actions', () => {
  const items = classifyUserActivity([event('one', 7, [['e', parent]]), event('two', 6, [['e', parent]])], pubkey);
  assert.equal(mergeActivity(items, items).length, 2);
});

test('activity filters select one type without mutating loaded history', () => {
  const items = classifyUserActivity([
    event('post', 1), event('reply', 1, [['e', parent, '', 'reply']]),
    event('like', 7, [['e', parent]]), event('repost', 6, [['e', parent]])
  ], pubkey);
  const likes = filterActivity(items, 'like');
  assert.deepEqual(likes.map(item => item.id), ['like']);
  assert.equal(filterActivity(items, 'all'), items);
  assert.equal(items.length, 4);
  assert.deepEqual(filterActivity(items, 'zap'), []);
});

test('equal-time replaceable follow lists use the lowest ID without inventing an order', () => {
  const baseline = event('baseline', 3, [['p', parent]], { created_at: 1 });
  const alternate = event('z', 3, [['p', parent], ['p', root]], { created_at: 2 });
  const winner = event('a', 3, [['p', parent], ['p', account]], { created_at: 2 });
  assert.deepEqual(followActivity([alternate, winner], pubkey), []);
  assert.deepEqual(followActivity([alternate, baseline, winner], pubkey).map(item => item.account), [account]);
});

test('pagination uses per-source coverage and overlaps boundary timestamps without duplicates', async () => {
  const dense = [10, 9, 9, 8, 7].map((time, index) => event(`dense${index}`, 1, [], { created_at: time }));
  const sparse = [10, 8, 2].map(time => event(`sparse${time}`, 7, [], { created_at: time }));
  const pager = createActivityPager({ sources: [dense, sparse], until: 10, limit: 2,
    query: async (source, until, limit) => source.filter(item => item.created_at <= until).slice(0, limit) });
  const found = [];
  let page;
  do {
    page = await pager.next();
    assert.equal(page.blocked, false);
    found.push(...page.events);
  } while (!page.exhausted);
  assert.equal(found.length, 8);
  assert.equal(new Set(found.map(item => item.id)).size, 8);
  assert.ok(found.slice(0, 2).every(item => item.created_at >= 9));
});

test('same-second saturation is explicit and failed queries do not advance the cursor', async () => {
  let fail = true;
  const untils = [];
  const pager = createActivityPager({ sources: ['one'], until: 10, limit: 2, maxLimit: 4,
    query: async (_source, until, limit) => {
      untils.push(until);
      if (fail) { fail = false; throw new Error('offline'); }
      return Array.from({ length: limit }, (_, index) => event(String(index), 1));
    } });
  await assert.rejects(pager.next(), /offline/);
  const page = await pager.next();
  assert.equal(page.blocked, true);
  assert.equal(page.exhausted, false);
  assert.deepEqual(untils, [10, 10, 10]);
});