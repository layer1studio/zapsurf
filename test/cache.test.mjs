import test from 'node:test';
import assert from 'node:assert/strict';
import { createContentCache } from '../js/cache.mjs';

function memoryStorage() {
  const values = new Map();
  return {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); },
    removeItem(key) { values.delete(key); }
  };
}

test('reads stored JSON values and misses after expiration', () => {
  const storage = memoryStorage();
  let time = 100;
  const cache = createContentCache({ storage, now: () => time, prefix: 'test:', defaultTtlMs: 50 });

  assert.equal(cache.set('feed', { ids: ['a', 'b'] }), true);
  assert.deepEqual(cache.get('feed'), { ids: ['a', 'b'] });
  time = 150;
  assert.equal(cache.get('feed'), null);
  assert.equal(storage.length, 0);
});

test('corrupt entries are discarded and storage errors degrade to misses', () => {
  const storage = memoryStorage();
  const cache = createContentCache({ storage, prefix: 'test:' });
  storage.setItem('test:bad', '{');
  assert.equal(cache.get('bad'), null);
  assert.equal(storage.length, 0);

  const brokenStorage = {
    get length() { throw new Error('blocked'); },
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); },
    removeItem() { throw new Error('blocked'); },
    key() { throw new Error('blocked'); }
  };
  const broken = createContentCache({ storage: brokenStorage });
  assert.equal(broken.get('anything'), null);
  assert.equal(broken.set('anything', {}), false);
  assert.equal(broken.remove('anything'), false);
  assert.equal(broken.clear(), false);
});

test('rejects oversized and unserializable values', () => {
  const cache = createContentCache({ storage: memoryStorage(), maxEntryChars: 80 });
  assert.equal(cache.set('large', 'x'.repeat(100)), false);
  const circular = {};
  circular.self = circular;
  assert.equal(cache.set('circular', circular), false);
});

test('evicts expired and oldest entries to stay within the entry limit', () => {
  const storage = memoryStorage();
  let time = 0;
  const cache = createContentCache({ storage, now: () => time, prefix: 'test:', defaultTtlMs: 10, maxEntries: 2 });

  cache.set('first', 1);
  time++;
  cache.set('second', 2);
  time++;
  cache.set('third', 3);
  assert.equal(cache.get('first'), null);
  assert.equal(cache.get('second'), 2);
  assert.equal(cache.get('third'), 3);

  time = 20;
  cache.set('fourth', 4);
  assert.equal(storage.length, 1);
  assert.equal(cache.get('fourth'), 4);
});

test('evicts oldest entries to stay within the total character limit', () => {
  const storage = memoryStorage();
  let time = 0;
  const cache = createContentCache({ storage, now: () => time++, prefix: 'test:', maxTotalChars: 150, maxEntryChars: 90 });

  assert.equal(cache.set('first', 'a'.repeat(30)), true);
  assert.equal(cache.set('second', 'b'.repeat(30)), true);
  assert.equal(cache.set('third', 'c'.repeat(30)), true);
  assert.equal(cache.get('first'), null);
  assert.equal(cache.get('second'), null);
  assert.equal(cache.get('third'), 'c'.repeat(30));
});

test('clear and remove only affect this cache prefix', () => {
  const storage = memoryStorage();
  const cache = createContentCache({ storage, prefix: 'test:' });
  storage.setItem('other:keep', 'value');
  cache.set('one', 1);
  cache.set('two', 2);

  assert.equal(cache.remove('one'), true);
  assert.equal(cache.clear(), true);
  assert.equal(storage.getItem('other:keep'), 'value');
  assert.equal(storage.length, 1);
});