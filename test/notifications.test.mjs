import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyNotifications, mergeNotifications, notificationSince, selectOwnedNotes } from '../js/notifications.mjs';

const me = 'a'.repeat(64);
const other = 'b'.repeat(64);
const note = { id: 'own-note', pubkey: me };
const event = (id, kind, created_at, tags = [], pubkey = other) => ({ id, kind, created_at, tags, pubkey });

test('classifies direct replies, reply descendants, and explicit mentions', () => {
  const reply = event('reply', 1, 10, [['e', note.id, '', 'reply']]);
  const descendant = event('descendant', 1, 11, [['e', reply.id, '', 'reply']]);
  const mention = event('mention', 1, 12, [['p', me]]);
  assert.deepEqual(classifyNotifications({ events: [mention, descendant, reply], ownNotes: [note], pubkey: me })
    .map(item => [item.id, item.type, item.targetId]), [
    ['mention', 'mention', mention.id],
    ['descendant', 'reply', note.id],
    ['reply', 'reply', note.id]
  ]);
});

test('does not classify inherited participant tags as mentions', () => {
  const unrelatedReply = event('unrelated-reply', 1, 10, [['e', 'other-note', '', 'reply'], ['p', me]]);
  const markedMention = event('marked-mention', 1, 11, [['e', note.id, '', 'mention']]);
  const replyToMention = event('reply-to-mention', 1, 12, [['e', markedMention.id, '', 'reply']]);
  assert.deepEqual(classifyNotifications({
    events: [unrelatedReply, markedMention, replyToMention], ownNotes: [note], pubkey: me
  }).map(item => [item.id, item.type, item.targetId]), [
    ['marked-mention', 'mention', 'marked-mention']
  ]);
});

test('classifies reactions, reposts, and only validated zaps on owned notes', () => {
  const events = [
    event('like', 7, 1, [['e', note.id]]),
    event('repost', 6, 2, [['e', note.id]]),
    event('zap', 9735, 3, [['e', note.id]]),
    event('invalid-zap', 9735, 4, [['e', note.id]])
  ];
  const notifications = classifyNotifications({
    events,
    ownNotes: [note],
    pubkey: me,
    validatedZaps: new Map([['zap', { sats: 21 }]])
  });
  assert.deepEqual(notifications.map(item => [item.id, item.type]), [
    ['zap', 'zap'], ['repost', 'repost'], ['like', 'like']
  ]);
});

test('merges by ID and keeps newest entries first', () => {
  assert.deepEqual(mergeNotifications(
    [{ id: 'old', created_at: 1 }, { id: 'same', created_at: 2 }],
    [{ id: 'same', created_at: 3 }, { id: 'new', created_at: 4 }]
  ).map(item => [item.id, item.created_at]), [['new', 4], ['same', 3], ['old', 1]]);
});

test('keeps older authored notes available as targets for recent activity', () => {
  const oldNote = { id: 'old-note', pubkey: me, created_at: 1 };
  const recentNote = { id: 'recent-note', pubkey: me, created_at: 50 };
  const otherNote = { id: 'other-note', pubkey: other, created_at: 100 };
  assert.deepEqual(selectOwnedNotes([oldNote], [recentNote, otherNote], me).map(item => item.id), [
    'recent-note', 'old-note'
  ]);
  const recentLike = event('recent-like', 7, 200, [['e', oldNote.id]]);
  assert.equal(classifyNotifications({
    events: [recentLike], ownNotes: [oldNote], pubkey: me
  })[0].targetId, oldNote.id);
});

test('notification queries overlap the last poll without exceeding initial history', () => {
  assert.equal(notificationSince({ lastPollAt: 10_000, now: 20_000 }), 9_700);
  assert.equal(notificationSince({ lastPollAt: null, now: 20_000 }), 20_000 - 30 * 24 * 60 * 60);
});