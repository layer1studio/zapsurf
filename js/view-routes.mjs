export function parseViewPath(pathname, nip19) {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length === 0) return { type: 'home' };
  const activity = segments.length === 2 && segments[1] === 'activity';
  if (segments.length !== 1 && !activity) return { type: 'invalid' };

  try {
    const entity = nip19.decode(decodeURIComponent(segments[0]));
    const profileType = activity ? 'profile-activity' : 'profile';
    if (entity.type === 'npub') return { type: profileType, pubkey: entity.data };
    if (entity.type === 'nprofile') return { type: profileType, pubkey: entity.data.pubkey };
    if (activity) return { type: 'invalid' };

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

export function profileActivityPath(pubkey, nip19) {
  return `${profilePath(pubkey, nip19)}/activity`;
}

export function notePath(noteId, nip19) {
  return `/${encodeURIComponent(nip19.noteEncode(noteId))}`;
}