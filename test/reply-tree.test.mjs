import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReplyTree } from '../js/reply-tree.mjs';

const event = (id, parent, createdAt) => ({ id, parent, created_at: createdAt });
const ids = nodes => nodes.map(node => [node.event.id, ids(node.children)]);

test('builds nested replies with chronologically sorted siblings', () => {
  const replies = [
    event('child-late', 'root', 4),
    event('grandchild', 'child-early', 3),
    event('child-early', 'root', 2),
    event('root-child', 'root', 1)
  ];
  const tree = buildReplyTree('root', replies, reply => reply.parent);
  assert.deepEqual(ids(tree), [
    ['root-child', []],
    ['child-early', [['grandchild', []]]],
    ['child-late', []]
  ]);
});

test('deduplicates events and excludes replies with missing parents', () => {
  const duplicate = event('child', 'root', 2);
  const tree = buildReplyTree('root', [
    duplicate,
    { ...duplicate, created_at: 9 },
    event('orphan', 'missing', 3)
  ], reply => reply.parent);
  assert.deepEqual(ids(tree), [['child', []]]);
});