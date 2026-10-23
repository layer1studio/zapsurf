const DAY_SECS = 24 * 60 * 60;
export const NOTIFICATION_HISTORY_SECS = 30 * DAY_SECS;
export const NOTIFICATION_OVERLAP_SECS = 5 * 60;
export const MAX_NOTIFICATIONS = 300;
export const MAX_OWN_NOTES = 1000;

function tagsFor(event, name) {
  return Array.isArray(event?.tags)
    ? event.tags.filter(tag => Array.isArray(tag) && tag[0] === name)
    : [];
}

export function replyParentId(event) {
  const tags = tagsFor(event, 'e');
  const marked = tags.find(tag => tag[3] === 'reply') || tags.find(tag => tag[3] === 'root');
  if (marked) return marked[1] || null;
  return tags.filter(tag => !tag[3]).at(-1)?.[1] || null;
}

function isReplyReference(tags) {
  return tags.some(tag => tag[3] === 'reply' || tag[3] === 'root')
    || (tags.length > 0 && tags.every(tag => !tag[3]));
}

export function classifyNotifications({ events, ownNotes, pubkey, validatedZaps = new Map() }) {
  const ownIds = new Set(ownNotes.map(note => note.id));
  const noteById = new Map(ownNotes.map(note => [note.id, note]));
  const parentById = new Map();
  const notifications = new Map();
  const pending = [...events].sort((a, b) => a.created_at - b.created_at);

  while (pending.length) {
    let progressed = false;
    for (let index = pending.length - 1; index >= 0; index--) {
      const event = pending[index];
      if (event.kind !== 1 || event.pubkey === pubkey || !event.id) {
        pending.splice(index, 1);
        progressed = true;
        continue;
      }

      const eventTags = tagsFor(event, 'e');
      const parentId = replyParentId(event);
      const rootId = eventTags.find(tag => tag[3] === 'root')?.[1];
      const targetId = [parentId, rootId, ...eventTags.map(tag => tag[1])]
        .find(id => ownIds.has(id) || noteById.has(id));
      if (targetId) {
        const isReply = isReplyReference(eventTags);
        const explicitMention = tagsFor(event, 'p').some(tag => tag[1] === pubkey);
        const markedMention = eventTags.some(tag => tag[3] === 'mention');
        if (isReply || explicitMention || markedMention) {
          notifications.set(event.id, {
            id: event.id,
            type: isReply ? 'reply' : 'mention',
            event,
            targetId: isReply ? targetId : event.id,
            created_at: event.created_at
          });
        }
        if (isReply) parentById.set(event.id, targetId);
        pending.splice(index, 1);
        progressed = true;
        continue;
      }

      if (!eventTags.length && tagsFor(event, 'p').some(tag => tag[1] === pubkey)) {
        notifications.set(event.id, {
          id: event.id,
          type: 'mention',
          event,
          targetId: event.id,
          created_at: event.created_at
        });
        pending.splice(index, 1);
        progressed = true;
        continue;
      }

      const inheritedParent = parentById.get(parentId);
      if (inheritedParent) {
        notifications.set(event.id, {
          id: event.id,
          type: 'reply',
          event,
          targetId: inheritedParent,
          created_at: event.created_at
        });
        parentById.set(event.id, inheritedParent);
        pending.splice(index, 1);
        progressed = true;
      }
    }
    if (!progressed) break;
  }

  for (const event of events) {
    if (!event?.id || event.pubkey === pubkey) continue;
    const targetId = tagsFor(event, 'e').map(tag => tag[1]).find(id => ownIds.has(id));
    if (!targetId) continue;

    if ([6, 16].includes(event.kind)) {
      notifications.set(event.id, { id: event.id, type: 'repost', event, targetId, created_at: event.created_at });
    } else if (event.kind === 7) {
      notifications.set(event.id, { id: event.id, type: 'like', event, targetId, created_at: event.created_at });
    } else if (event.kind === 9735 && validatedZaps.has(event.id)) {
      notifications.set(event.id, {
        id: event.id,
        type: 'zap',
        event,
        targetId,
        zap: validatedZaps.get(event.id),
        created_at: event.created_at
      });
    }
  }

  return [...notifications.values()]
    .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))
    .slice(0, MAX_NOTIFICATIONS);
}

export function mergeNotifications(current, incoming) {
  const byId = new Map([...current, ...incoming].map(item => [item.id, item]));
  return [...byId.values()]
    .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))
    .slice(0, MAX_NOTIFICATIONS);
}

export function selectOwnedNotes(current, incoming, pubkey) {
  const byId = new Map([...current, ...incoming]
    .filter(note => note?.id && note.pubkey === pubkey)
    .map(note => [note.id, note]));
  return [...byId.values()]
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, MAX_OWN_NOTES);
}

export function notificationSince({ lastPollAt, now }) {
  if (lastPollAt == null) return now - NOTIFICATION_HISTORY_SECS;
  return Math.max(now - NOTIFICATION_HISTORY_SECS, lastPollAt - NOTIFICATION_OVERLAP_SECS);
}