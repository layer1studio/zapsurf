export const CONTENT_TOKEN_RE = /(https?:\/\/[^\s<>"']+)|nostr:((?:npub|nprofile|note|nevent|naddr)1[02-9ac-hj-np-z]+)|(?<![a-z0-9])((?:npub|nprofile|note|nevent)1[02-9ac-hj-np-z]+)(?![a-z0-9])/gi;
const HEX_ID = /^[0-9a-f]{64}$/;

function relayHints(values) {
  return [...new Set(values.filter(value => {
    try {
      const url = new URL(value);
      return url.protocol === 'wss:' && !url.username && !url.password;
    } catch { return false; }
  }))];
}

export function quoteReference(entity, decode) {
  try {
    const { type, data } = decode(entity);
    const id = type === 'note' ? data : type === 'nevent' ? data.id : null;
    return HEX_ID.test(id || '') ? { id, relays: relayHints(type === 'nevent' ? data.relays || [] : []) } : null;
  } catch { return null; }
}

export function taggedQuotes(tags = []) {
  const seen = new Set();
  return tags.flatMap(tag => {
    if (tag[0] !== 'q' || !HEX_ID.test(tag[1] || '') || seen.has(tag[1])) return [];
    seen.add(tag[1]);
    return [{ id: tag[1], relays: relayHints([tag[2]]) }];
  });
}

export function createQuoteContext(id = null) {
  return { depth: 0, ancestors: new Set(id ? [id] : []), budget: { quotes: 0, previews: 0 } };
}

export function enterQuote(context, id) {
  if (context.depth >= 2 || context.budget.quotes >= 4 || context.ancestors.has(id)) return null;
  context.budget.quotes++;
  return { depth: context.depth + 1, ancestors: new Set([...context.ancestors, id]), budget: context.budget };
}