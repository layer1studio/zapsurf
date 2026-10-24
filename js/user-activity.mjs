import { replyParentId } from './notifications.mjs';

const HEX = /^[0-9a-f]{64}$/i;
const tagsFor = (event, name) => (event?.tags || []).filter(tag => Array.isArray(tag) && tag[0] === name);
const lastTarget = event => tagsFor(event, 'e').at(-1)?.[1];
const compare = (left, right) => right.created_at - left.created_at || left.id.localeCompare(right.id);

export function mergeActivity(current, incoming) {
  return [...new Map([...current, ...incoming].map(item => [item.id, item])).values()].sort(compare);
}

export function filterActivity(items, type = 'all') {
  return type === 'all' ? items : items.filter(item => item.type === type);
}

export function classifyUserActivity(events, pubkey, validatedZaps = new Map()) {
  const items = [];
  for (const event of events) {
    if (!event?.id) continue;
    const base = { id: event.id, event, created_at: event.created_at };
    if (event.kind === 9735) {
      const zap = validatedZaps.get(event.id);
      if (zap?.sender === pubkey) items.push({ ...base, type: 'zap', zap, targetId: zap.targetId || null, targetKind: 1, account: zap.recipient });
      continue;
    }
    if (event.pubkey !== pubkey) continue;
    if (event.kind === 1) {
      const reference = replyParentId(event);
      const parentId = HEX.test(reference || '') ? reference : null;
      items.push({ ...base, type: parentId ? 'reply' : 'post', targetId: parentId || event.id, targetKind: 1 });
    } else if (event.kind === 7 || event.kind === 6 || event.kind === 16) {
      const targetId = lastTarget(event);
      if (!HEX.test(targetId || '')) continue;
      const kindTag = tagsFor(event, 'k').at(-1)?.[1];
      const targetKind = kindTag !== undefined && /^\d+$/.test(kindTag) ? Number(kindTag) : event.kind === 16 ? null : 1;
      items.push({ ...base, type: event.kind === 7 ? 'like' : 'repost', targetId, targetKind, reaction: event.content || '+' });
    }
  }
  return mergeActivity([], items);
}

export function followActivity(snapshots, pubkey) {
  const byTime = new Map();
  for (const event of snapshots) {
    if (event.kind !== 3 || event.pubkey !== pubkey) continue;
    const previous = byTime.get(event.created_at);
    if (!previous || event.id < previous.id) byTime.set(event.created_at, event);
  }
  const ordered = [...byTime.values()].sort((left, right) => left.created_at - right.created_at);
  const items = [];
  let previous = null;
  for (const event of ordered) {
    const follows = new Set(tagsFor(event, 'p').map(tag => tag[1]).filter(value => HEX.test(value || '')));
    if (previous) {
      for (const account of follows) {
        if (!previous.has(account)) items.push({ id: `${event.id}:${account}`, type: 'follow', event, account, created_at: event.created_at });
      }
    }
    previous = follows;
  }
  return mergeActivity([], items);
}

export function createActivityPager({ sources, query, until, limit = 60, maxLimit = 960, onSourceSettled }) {
  let cursor = until;
  let exhausted = false;
  let blocked = false;
  let busy = false;
  const seen = new Set();
  return {
    async next() {
      if (busy) throw new Error('Activity is already loading.');
      if (exhausted || blocked) return { events: [], exhausted, blocked };
      busy = true;
      let completedSources = 0;
      try {
        const results = await Promise.all(sources.map(async source => {
          try {
            let size = limit;
            while (true) {
              const received = await query(source, cursor, size);
              const events = received.filter(event => Number.isSafeInteger(event.created_at) && event.created_at >= 0 && event.created_at <= cursor);
              const saturated = received.length >= size;
              const oldest = events.length ? Math.min(...events.map(event => event.created_at)) : cursor;
              if (saturated && oldest === cursor && size < maxLimit) {
                size = Math.min(size * 2, maxLimit);
                continue;
              }
              return { events, saturated, oldest };
            }
          } finally {
            try {
              onSourceSettled?.({ source, completed: ++completedSources, total: sources.length });
            } catch {}
          }
        }));
        const full = results.filter(result => result.saturated);
        const boundary = full.length ? Math.max(...full.map(result => result.oldest)) : 0;
        const events = [...new Map(results.flatMap(result => result.events)
          .filter(event => event.created_at >= boundary && !seen.has(event.id))
          .map(event => [event.id, event])).values()];
        blocked = full.some(result => result.oldest === cursor);
        exhausted = !full.length;
        for (const event of events) seen.add(event.id);
        cursor = boundary;
        return { events, exhausted, blocked };
      } finally {
        busy = false;
      }
    }
  };
}