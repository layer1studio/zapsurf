export function mergeReactionGroups(...collections) {
  const groups = new Map();
  for (const { content, pubkeys } of collections.flat()) {
    const label = !content || content === '+' || content === '\u2764' ? '\u2764\uFE0F' : content;
    if (!groups.has(label)) groups.set(label, new Set());
    for (const pubkey of pubkeys) groups.get(label).add(pubkey);
  }
  return [...groups].map(([content, pubkeys]) => ({ content, pubkeys: [...pubkeys] }));
}

export function groupReactions(events, noteId) {
  return mergeReactionGroups(events.filter(event => event.kind === 7
    && event.tags?.filter(tag => tag[0] === 'e').at(-1)?.[1] === noteId)
    .map(event => ({ content: event.content, pubkeys: [event.pubkey] })));
}