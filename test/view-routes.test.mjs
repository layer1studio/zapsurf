import test from 'node:test';
import assert from 'node:assert/strict';
import { notePath, parseViewPath, profilePath, profileActivityPath } from '../js/view-routes.mjs';

const pubkey = 'a'.repeat(64);
const noteId = 'b'.repeat(64);
const entities = new Map([
  ['npub-user', { type: 'npub', data: pubkey }],
  ['nprofile-user', { type: 'nprofile', data: { pubkey, relays: ['wss://relay.example'] } }],
  ['note-event', { type: 'note', data: noteId }],
  ['nevent-event', { type: 'nevent', data: { id: noteId, relays: ['wss://relay.example'], kind: 1 } }],
  ['nevent-other-kind', { type: 'nevent', data: { id: noteId, kind: 30023 } }]
]);
const nip19 = {
  decode: value => {
    if (!entities.has(value)) throw new Error('Invalid entity');
    return entities.get(value);
  },
  npubEncode: () => 'npub-user',
  noteEncode: () => 'note-event'
};

test('parses profile and note routes with supported NIP-19 entities', () => {
  assert.deepEqual(parseViewPath('/npub-user', nip19), { type: 'profile', pubkey });
  assert.deepEqual(parseViewPath('/nprofile-user', nip19), { type: 'profile', pubkey });
  assert.deepEqual(parseViewPath('/note-event', nip19), { type: 'note', id: noteId, relays: [] });
  assert.deepEqual(parseViewPath('/nevent-event', nip19), {
    type: 'note', id: noteId, relays: ['wss://relay.example']
  });
});

test('formats profile and note paths using NIP-19 identifiers', () => {
  assert.equal(profilePath(pubkey, nip19), '/npub-user');
  assert.equal(notePath(noteId, nip19), '/note-event');
});

test('rejects malformed paths, incompatible entities, and non-note events', () => {
  assert.deepEqual(parseViewPath('/', nip19), { type: 'home' });
  assert.deepEqual(parseViewPath('/bad', nip19), { type: 'invalid' });
  assert.deepEqual(parseViewPath('/profile/npub-user', nip19), { type: 'invalid' });
  assert.deepEqual(parseViewPath('/nevent-other-kind', nip19), { type: 'invalid' });
});

test('activity routes accept profiles only and generate bookmarkable paths', () => {
  assert.equal(profileActivityPath(pubkey, nip19), '/npub-user/activity');
  for (const path of ['/npub-user/activity', '/nprofile-user/activity', '/npub-user/activity/']) {
    assert.deepEqual(parseViewPath(path, nip19), { type: 'profile-activity', pubkey });
  }
  for (const path of ['/note-event/activity', '/nevent-event/activity', '/bad/activity', '/npub-user/other', '/npub-user/activity/more']) {
    assert.deepEqual(parseViewPath(path, nip19), { type: 'invalid' });
  }
});