import { nip19 } from './deps.js';
import { ensureProfile, parseProfile, settings } from './state.js';
import { cachedZapSats } from './zapcount.js';
import { el, safeHttpUrl, formatSats, emit } from './util.js';
import { loadNoteEvent } from './notes.js';
import { CONTENT_TOKEN_RE, quoteReference, taggedQuotes, createQuoteContext, enterQuote } from './quote-references.mjs';

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

const IMAGE_RE = /\.(jpe?g|png|gif|webp|avif)$/i;
const VIDEO_RE = /\.(mp4|webm|mov|m4v)$/i;
const profileLookups = new Map();
const linkPreviewCache = new Map();
const LINK_PREVIEW_TTL_MS = 10 * 60 * 1000;
const MAX_LINK_PREVIEWS = 4;
const quoteLookups = new Map();

function loadMentionProfile(pubkey) {
  if (!profileLookups.has(pubkey)) {
    const lookup = ensureProfile(pubkey).finally(() => profileLookups.delete(pubkey));
    profileLookups.set(pubkey, lookup);
  }
  return profileLookups.get(pubkey);
}

export function renderContent(text, className = 'note-content', { linkPreviews = false, event = null, quotes = true, quoteContext = createQuoteContext(event?.id) } = {}) {
  const container = el('div', { class: className });
  const seenQuotes = new Set();
  let last = 0;
  for (const match of text.matchAll(CONTENT_TOKEN_RE)) {
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
        if (linkPreviews && quoteContext.budget.previews < MAX_LINK_PREVIEWS && isPreviewableLink(href)) {
          container.append(createLinkPreview(href));
          quoteContext.budget.previews++;
        }
      }
    } else {
      const entity = match[2] || match[3];
      const reference = quotes ? quoteReference(entity, nip19.decode) : null;
      if (reference && !seenQuotes.has(reference.id)) {
        seenQuotes.add(reference.id);
        container.append(renderQuoteReference(reference, entity, quoteContext));
      } else {
        container.append(renderNostrRef(entity));
      }
    }
  }
  container.append(text.slice(last));
  if (quotes) {
    for (const reference of taggedQuotes(event?.tags)) {
      if (seenQuotes.has(reference.id)) continue;
      seenQuotes.add(reference.id);
      container.append(renderQuoteReference(reference, nip19.noteEncode(reference.id), quoteContext));
    }
  }
  return container;
}

function renderQuoteReference(reference, entity, context) {
  const fallback = el('a', { href: `https://njump.me/${entity}`, target: '_blank', rel: 'noopener noreferrer' }, `${entity.slice(0, 14)}\u2026`);
  const next = enterQuote(context, reference.id);
  if (!next) return fallback;
  const placeholder = el('div', { class: 'quote-loading', 'aria-busy': 'true' }, fallback);
  let mounted = false;
  queueMicrotask(() => { mounted = placeholder.isConnected; });
  if (!quoteLookups.has(reference.id)) {
    const lookup = loadNoteEvent(reference.id, reference.relays).finally(() => quoteLookups.delete(reference.id));
    quoteLookups.set(reference.id, lookup);
  }
  quoteLookups.get(reference.id).then(note => {
    if (!note || (mounted && !placeholder.isConnected)) return;
    placeholder.replaceChildren(quotePreview(note, next));
  }).catch(() => {}).finally(() => placeholder.removeAttribute('aria-busy'));
  return placeholder;
}

function isPreviewableLink(href) {
  try {
    const url = new URL(href);
    const hostname = url.hostname.toLowerCase();
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
    if (hostname.includes(':') || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal')) return false;
    const octets = hostname.split('.').map(Number);
    if (octets.length === 4 && octets.every(Number.isInteger)) {
      const [first, second] = octets;
      if (first === 0 || first === 10 || first === 127 || (first === 169 && second === 254) ||
          (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function fetchLinkPreview(href) {
  const cached = linkPreviewCache.get(href);
  if (cached && Date.now() - cached.createdAt < LINK_PREVIEW_TTL_MS) return cached.promise;
  const fallback = { title: new URL(href).hostname, description: '', image: '' };
  const endpoint = new URL('https://api.microlink.io/');
  endpoint.searchParams.set('url', href);
  endpoint.searchParams.set('screenshot', 'false');
  const promise = fetch(endpoint, { signal: AbortSignal.timeout(7000) })
    .then(response => {
      if (!response.ok) throw new Error('Preview request failed');
      return response.json();
    })
    .then(result => {
      const data = result?.data;
      if (result?.status !== 'success' || !data) return fallback;
      return {
        title: typeof data.title === 'string' && data.title.trim() ? data.title.trim() : fallback.title,
        description: typeof data.description === 'string' ? data.description.trim() : '',
        image: safeHttpUrl(data.image?.url || '') || ''
      };
    })
    .catch(() => fallback);
  linkPreviewCache.set(href, { createdAt: Date.now(), promise });
  return promise;
}

function createLinkPreview(href) {
  const host = new URL(href).hostname;
  const title = el('strong', { class: 'link-preview-title' }, host);
  const description = el('span', { class: 'link-preview-description' }, 'Loading preview…');
  const details = el('span', { class: 'link-preview-details' },
    el('span', { class: 'link-preview-host' }, host), title, description);
  const card = el('a', {
    class: 'link-preview', href, target: '_blank', rel: 'noopener noreferrer',
    'aria-label': `Link preview for ${host}`
  }, details);
  fetchLinkPreview(href).then(preview => {
    title.textContent = preview.title;
    description.textContent = preview.description || href;
    if (preview.image && card.isConnected) {
      const image = el('img', { class: 'link-preview-image', src: preview.image, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
      image.addEventListener('error', () => image.remove(), { once: true });
      card.prepend(image);
    }
  });
  return card;
}

function renderNostrRef(entity) {
  let label = `${entity.slice(0, 14)}…`;
  try {
    const { type, data } = nip19.decode(entity);
    const pubkey = type === 'npub' ? data : type === 'nprofile' ? data.pubkey : null;
    if (pubkey) {
      const button = el('button', {
        type: 'button', class: 'mention',
        onclick: event => { event.stopPropagation(); emit('zs:open-profile', pubkey); }
      }, `@${parseProfile(pubkey).name}`);
      loadMentionProfile(pubkey).then(profile => {
        button.textContent = `@${profile.name}`;
      }).catch(() => {});
      return button;
    }
  } catch {
    return entity;
  }
  return el('a', { href: `https://njump.me/${entity}`, target: '_blank', rel: 'noopener noreferrer' }, label);
}

export function quotePreview(note, context = enterQuote(createQuoteContext(), note.id)) {
  const author = el('button', {
    type: 'button', class: 'link-button quote-author',
    onclick: event => { event.stopPropagation(); emit('zs:open-profile', note.pubkey); }
  }, avatar(note.pubkey, 'small'), el('span', { class: 'author-name' }, parseProfile(note.pubkey).name));
  loadMentionProfile(note.pubkey).then(profile => { author.lastElementChild.textContent = profile.name; }).catch(() => {});
  const open = el('a', {
    href: `/${nip19.noteEncode(note.id)}`, class: 'quote-open',
    onclick: event => {
      event.stopPropagation();
      if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      emit('zs:open-note', note);
    }
  }, 'Open note');
  return el('section', { class: `quote-preview${context.depth > 1 ? ' nested-quote' : ''}`, onclick: event => event.stopPropagation() },
    el('header', { class: 'quote-header' }, author, timeEl(note.created_at)),
    renderContent(note.content, 'note-content quote-content', { event: note, linkPreviews: true, quoteContext: context }),
    open);
}
