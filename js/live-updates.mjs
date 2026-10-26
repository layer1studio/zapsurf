export function filterHomeItems(items, follows, self) {
  return items.filter(item => {
    const source = item.repostedBy || item.note.pubkey;
    return source === self || follows.has(source);
  });
}

export function selectNewNotes(events, knownIds, isReply) {
  return [...new Map(events
    .filter(event => event.kind === 1 && event.id && !knownIds.has(event.id) && !isReply(event))
    .map(event => [event.id, event])).values()]
    .sort((a, b) => b.created_at - a.created_at);
}