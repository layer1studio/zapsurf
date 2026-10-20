import { nip19 } from './deps.js';
import { parseProfile, settings } from './state.js';
import { cachedZapSats } from './zapcount.js';
import { el, safeHttpUrl, formatSats, emit } from './util.js';

export function avatar(pubkey, size = '') {
  const profile = parseProfile(pubkey);
  const img = el('img', { class: `avatar ${size}`.trim(), alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
  if (profile.picture) img.src = profile.picture;
  img.addEventListener('error', () => img.removeAttribute('src'), { once: true });
  return img;
}

export function badge(count, sats = 0) {
  if (!count || (sats || 0) < settings.minZapSats) return null;
  const title = `Sent ${count} verified zaps${sats ? ` (${sats.toLocaleString()} sats)` : ''} in the last 14 days`;
  const zaps = `${count} ${count === 1 ? 'zap' : 'zaps'}`;
  return el('span', { class: 'badge', title }, sats ? `⚡ ${formatSats(sats)} sats (${zaps})` : `⚡ ${zaps}`);
}

export function authorLine(pubkey, zaps) {
  return el('div', { class: 'author-line' }, el('span', { class: 'author-name' }, parseProfile(pubkey).name), badge(zaps, cachedZapSats(pubkey)));
}

export function repostLine(repostedBy) {
  if (!repostedBy) return null;
  return el('div', { class: 'repost-line' }, `🔁 ${parseProfile(repostedBy).name} reposted`);
}

export function timeEl(createdAt) {
  const time = new Date(createdAt * 1000);
  return el('time', { class: 'note-time', datetime: time.toISOString() }, time.toLocaleString());
}

const TOKEN_RE = /(https?:\/\/[^\s<>"']+)|nostr:((?:npub|nprofile|note|nevent|naddr)1[02-9ac-hj-np-z]+)/gi;
const IMAGE_RE = /\.(jpe?g|png|gif|webp|avif)$/i;
const VIDEO_RE = /\.(mp4|webm|mov|m4v)$/i;

export function renderContent(text, className = 'note-content') {
  const container = el('div', { class: className });
  let last = 0;
  for (const match of text.matchAll(TOKEN_RE)) {
    container.append(text.slice(last, match.index));
    last = match.index + match[0].length;
    if (match[1]) {
      const trimmed = match[1].replace(/[.,;:!?)\]]+$/, '');
      last -= match[1].length - trimmed.length;
      const href = safeHttpUrl(trimmed);
      if (!href) {
        container.append(trimmed);
      } else if (IMAGE_RE.test(new URL(href).pathname)) {
        container.append(el('img', { src: href, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }));
      } else if (VIDEO_RE.test(new URL(href).pathname)) {
        container.append(el('video', { src: href, controls: true, preload: 'metadata', playsinline: true, referrerpolicy: 'no-referrer' }));
      } else {
        container.append(el('a', { href, target: '_blank', rel: 'noopener noreferrer' }, trimmed));
      }
    } else {
      container.append(renderNostrRef(match[2]));
    }
  }
  container.append(text.slice(last));
  return container;
}

function renderNostrRef(entity) {
  let label = `${entity.slice(0, 14)}…`;
  try {
    const { type, data } = nip19.decode(entity);
    const pubkey = type === 'npub' ? data : type === 'nprofile' ? data.pubkey : null;
    if (pubkey) {
      return el('button', {
        type: 'button', class: 'mention',
        onclick: event => { event.stopPropagation(); emit('zs:open-profile', pubkey); }
      }, `@${parseProfile(pubkey).name}`);
    }
  } catch {
    return entity;
  }
  return el('a', { href: `https://njump.me/${entity}`, target: '_blank', rel: 'noopener noreferrer' }, label);
}

export function quotePreview(note) {
  return el('div', { class: 'quote-preview' },
    el('div', { class: 'author-line' }, avatar(note.pubkey, 'small'), el('span', { class: 'author-name' }, parseProfile(note.pubkey).name)),
    el('div', { class: 'note-preview' }, note.content.slice(0, 280)));
}
