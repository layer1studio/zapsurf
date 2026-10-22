import test from 'node:test';
import assert from 'node:assert/strict';
import { settleRelayPublishes } from '../js/relay-results.mjs';

test('reports accepted and settled relay totals as results arrive', async () => {
  const progress = [];
  const result = await settleRelayPublishes([
    Promise.resolve('accepted'),
    Promise.reject(new Error('rejected')),
    Promise.resolve('accepted')
  ], update => progress.push(update));

  assert.equal(result.accepted, 2);
  assert.equal(result.total, 3);
  assert.deepEqual(result.results.map(item => item.status), ['fulfilled', 'rejected', 'fulfilled']);
  assert.deepEqual(progress.at(-1), { accepted: 2, settled: 3, total: 3 });
});

test('reports zero accepted relays when all publish attempts fail', async () => {
  const progress = [];
  const result = await settleRelayPublishes([
    Promise.reject(new Error('offline')),
    Promise.reject(new Error('offline'))
  ], update => progress.push(update));

  assert.equal(result.accepted, 0);
  assert.equal(result.total, 2);
  assert.deepEqual(progress.at(-1), { accepted: 0, settled: 2, total: 2 });
});