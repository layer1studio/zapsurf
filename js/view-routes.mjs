export function parseViewPath(pathname, nip19) {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length === 0) return { type: 'home' };
  if (segments.length !== 1) return { type: 'invalid' };

  try {
    const entity = nip19.decode(decodeURIComponent(segments[0]));
    if (entity.type === 'npub') return { type: 'profile', pubkey: entity.data };
    if (entity.type === 'nprofile') return { type: 'profile', pubkey: entity.data.pubkey };

    if (entity.type === 'note') return { type: 'note', id: entity.data, relays: [] };
    if (entity.type === 'nevent' && (!entity.data.kind || entity.data.kind === 1)) {
      return { type: 'note', id: entity.data.id, relays: entity.data.relays || [] };
    }
  } catch {
    return { type: 'invalid' };
  }
  return { type: 'invalid' };
}

export function profilePath(pubkey, nip19) {
  return `/${encodeURIComponent(nip19.npubEncode(pubkey))}`;
}

export function notePath(noteId, nip19) {
  return `/${encodeURIComponent(nip19.noteEncode(noteId))}`;
}