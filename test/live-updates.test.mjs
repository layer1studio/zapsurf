import test from 'node:test';
import assert from 'node:assert/strict';
import { filterHomeItems, selectNewNotes } from '../js/live-updates.mjs';

const event = (id, createdAt, reply = false) => ({ id, kind: 1, created_at: createdAt, reply });

test('selects unique, new top-level notes in newest-first order', () => {
  const notes = selectNewNotes([
    event('old', 1),
    event('already-shown', 2),
    event('reply', 3, true),
    event('newer', 5),
    event('older', 4),
    event('newer', 5)
  ], new Set(['already-shown']), note => note.reply);

  assert.deepEqual(notes.map(note => note.id), ['newer', 'older', 'old']);
});

test('home items exclude unfollowed authors from saved and newly loaded notes', () => {
  const items = [
    { note: { id: 'own', pubkey: 'self' } },
    { note: { id: 'followed', pubkey: 'friend' } },
    { note: { id: 'unfollowed', pubkey: 'former-friend' } }
  ];

  assert.deepEqual(filterHomeItems(items, new Set(['friend']), 'self').map(item => item.note.id),
    ['own', 'followed']);
  assert.deepEqual(filterHomeItems(items, new Set(), 'self').map(item => item.note.id), ['own']);
  assert.equal(items.length, 3);
});

test('home repost eligibility follows the reposter, not the original author', () => {
  const items = [
    { note: { id: 'friend-repost', pubkey: 'stranger' }, repostedBy: 'friend' },
    { note: { id: 'own-repost', pubkey: 'stranger' }, repostedBy: 'self' },
    { note: { id: 'unfollowed-repost', pubkey: 'friend' }, repostedBy: 'former-friend' }
  ];

  assert.deepEqual(filterHomeItems(items, new Set(['friend']), 'self').map(item => item.note.id),
    ['friend-repost', 'own-repost']);
});