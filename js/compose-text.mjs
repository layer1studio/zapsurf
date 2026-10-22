export function rebaseMentions(previousText, nextText, mentions) {
  let prefix = 0;
  while (prefix < previousText.length && prefix < nextText.length && previousText[prefix] === nextText[prefix]) prefix++;

  let suffix = 0;
  while (suffix < previousText.length - prefix && suffix < nextText.length - prefix
    && previousText[previousText.length - 1 - suffix] === nextText[nextText.length - 1 - suffix]) suffix++;

  const changedEnd = previousText.length - suffix;
  const delta = nextText.length - previousText.length;
  return mentions.flatMap(mention => {
    if (mention.end <= prefix && !/[\p{L}\p{N}_]/u.test(nextText[mention.end] || '')) return [mention];
    if (mention.start >= changedEnd) {
      return [{ ...mention, start: mention.start + delta, end: mention.end + delta }];
    }
    return [];
  });
}

export function serializeMentions(text, mentions, encodePubkey) {
  let content = text;
  for (const mention of [...mentions].sort((a, b) => b.start - a.start)) {
    if (content.slice(mention.start, mention.end) !== mention.text) continue;
    if (/[\p{L}\p{N}_]/u.test(content[mention.end] || '')) continue;
    content = `${content.slice(0, mention.start)}nostr:${encodePubkey(mention.pubkey)}${content.slice(mention.end)}`;
  }
  return content;
}