import test from 'node:test';
import assert from 'node:assert/strict';
import { selectNewNotes } from '../js/live-updates.mjs';

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