import { pool, PROFILE_RELAYS, rememberProfile, profiles, parseProfile, ensureProfile, settings, MAX_MIN_ZAP_SATS, statsFor } from './state.js';
import { FEEDS, DEFAULT_FEED_ID, loadTrendingItems } from './primal.js';
import { loadHomeItems, loadThread as fetchThread, prefetchThread, ensureProfiles, loadNoteStats, loadProfileNotes, fetchContactList } from './notes.js?v=0.2.0';
import { countRecentZapsSent, loadNoteZaps as fetchNoteZaps, cachedZapCount, cachedZapSats } from './zapcount.js';
import { getSession, canSign, isOwn, logout, LOGIN_METHODS } from './signer.js';
import { avatar, authorLine, badge, repostLine, renderContent, timeEl } from './render.js';
import { actionBar, requireSigner } from './actions.js?v=0.2.0';
import { isFollowing, setFollowing } from './social.js';
import { toast } from './dialogs.js';
import { nip19 } from './deps.js';
import { inlineReplyBox, openComposer } from './compose.js';
import { openLoginDialog } from './login.js';
import { openSettings } from './settings.js';
import { el, isDirectReplyTo, now, store, formatSats, safeHttpUrl } from './util.js';

const SORT_KEY = 'zs-sort';
const stat = key => item => statsFor(item.note.id)[key];
const SORTS = [
  { id: 'newest', label: 'Newest', score: item => item.note.created_at },
  { id: 'sats', label: 'Most sats zapped', score: stat('satszapped'), needsStats: true },
  { id: 'zaps', label: 'Most zaps', score: stat('zaps'), needsStats: true },
  { id: 'author', label: 'Top zapper authors (count)', score: item => item.zaps || 0 },
  { id: 'author-sats', label: 'Top zapper authors (sats)', score: item => cachedZapSats(item.note.pubkey) },
  { id: 'likes', label: 'Most liked', score: stat('likes'), needsStats: true },
  { id: 'replies', label: 'Most replies', score: stat('replies'), needsStats: true },
  { id: 'reposts', label: 'Most reposted', score: stat('reposts'), needsStats: true },
  {
    id: 'engagement', label: 'Most engagement', needsStats: true,
    score: item => {
      const s = statsFor(item.note.id);
      return s.replies * 3 + s.zaps * 3 + s.reposts * 2 + s.likes;
    }
  }
];
const sortSelect = document.getElementById('sort-select');
const currentSort = () => SORTS.find(s => s.id === sortSelect.value) || SORTS[0];

function renderSortOptions() {
  const saved = store.get(SORT_KEY);
  sortSelect.replaceChildren(...SORTS.map(sort => el('option', { value: sort.id }, sort.label)));
  sortSelect.value = SORTS.some(sort => sort.id === saved) ? saved : SORTS[0].id;
}

function sortItems(items) {
  const sort = currentSort();
  if (!sort.score) return items;
  return [...items].sort((a, b) => (sort.score(b) - sort.score(a)) || (b.note.created_at - a.note.created_at));
}

const feedSelect = document.getElementById('feed-select');
const showAllFollows = document.getElementById('show-all-follows');
const minZapSatsInput = document.getElementById('min-zap-sats');
const statusEl = document.getElementById('status');
const listEl = document.getElementById('note-list');
const mainEl = document.getElementById('main');
const accountEl = document.getElementById('account');

const HOME_FEED = { id: 'home', label: 'Home (following)', group: 'You', personal: true };
const MAX_EMPTY_PAGES = 3;
const HOME_MAX_AGE_DAYS = 30;

let selectedNoteId = null;
let shownNoteId = null;
let moreObserver = null;
let replyObserver = null;
const replyPrefetchQueue = [];
const queuedReplyIds = new Set();
let activeReplyPrefetches = 0;
let loadToken = 0;
let threadToken = 0;
let lastResult = null;
let openThread = null;
let currentItem = null;
let profileOpen = null;
let profileToken = 0;

const passesFilter = pubkey => isOwn(pubkey) || cachedZapSats(pubkey) >= settings.minZapSats;

const thresholdText = () => `sent ${formatSats(settings.minZapSats)}+ sats in the last 14 days`;

// ---------- Profiles & following ----------

function profileLink(pubkey, ...children) {
  return el('button', {
    type: 'button', class: 'profile-link', title: 'View profile',
    onclick: event => { event.stopPropagation(); showProfile(pubkey); }
  }, ...children);
}

function setFollowState(button, following) {
  button.dataset.following = String(following);
  button.textContent = following ? 'Following' : 'Follow';
  button.classList.toggle('ghost', following);
}

function followButton(pubkey) {
  if (isOwn(pubkey)) return null;
  const button = el('button', { type: 'button', class: 'button small follow-button', 'data-pubkey': pubkey }, 'Follow');
  if (getSession()) isFollowing(pubkey).then(following => setFollowState(button, following)).catch(() => {});
  button.addEventListener('mouseenter', () => {
    if (button.dataset.following === 'true' && !button.disabled) button.textContent = 'Unfollow';
  });
  button.addEventListener('mouseleave', () => {
    if (button.dataset.following === 'true' && !button.disabled) button.textContent = 'Following';
  });
  button.addEventListener('click', async event => {
    event.stopPropagation();
    if (!requireSigner()) return;
    const follow = button.dataset.following !== 'true';
    const name = parseProfile(pubkey).name;
    button.disabled = true;
    button.textContent = follow ? 'Following…' : 'Unfollowing…';
    try {
      await setFollowing(pubkey, follow);
      toast(follow ? `Following ${name}` : `Unfollowed ${name}`);
    } catch (err) {
      setFollowState(button, !follow);
      if (!['Cancelled', 'Unlock cancelled'].includes(err?.message)) toast(err?.message || String(err), 'error');
    } finally {
      button.disabled = false;
    }
  });
  return button;
}

document.addEventListener('zs:follows', ({ detail }) => {
  for (const button of document.querySelectorAll('.follow-button')) {
    if (button.dataset.pubkey === detail.pubkey) setFollowState(button, detail.following);
  }
});

function profileData(pubkey) {
  try {
    return JSON.parse(profiles.get(pubkey)?.content || '{}') || {};
  } catch {
    return {};
  }
}

function backToNote() {
  if (!currentItem) return;
  const button = [...listEl.querySelectorAll('.note-item')].find(b => b.dataset.noteId === currentItem.note.id);
  showNote(currentItem, button);
}

function profileNoteCard(note, zaps) {
  return el('article', { class: 'profile-note' },
    renderContent(note.content, 'note-content profile-note-content'),
    el('div', { class: 'profile-note-footer' },
      timeEl(note.created_at),
      itemStats(note.id),
      el('button', {
        type: 'button',
        class: 'link-button',
        onclick: () => showNote({ note, zaps })
      }, 'Open note')));
}

async function showProfile(pubkey) {
  const token = ++profileToken;
  threadToken++;
  openThread = null;
  profileOpen = pubkey;
  shownNoteId = null;
  for (const other of listEl.querySelectorAll('.note-item')) other.removeAttribute('aria-current');

  const back = currentItem ? el('button', { type: 'button', class: 'link-button back-link', onclick: backToNote }, '← Back to note') : null;
  const notesEl = el('section', { class: 'profile-notes' },
    el('p', { class: 'replies-status busy' }, 'Loading notes from their relays…'));
  const view = el('article', { class: 'note profile' });
  mainEl.replaceChildren(view);
  mainEl.parentElement.scrollTop = 0;

  const render = (zaps = cachedZapCount(pubkey), followsCount = null) => {
    const data = profileData(pubkey);
    const profile = parseProfile(pubkey);
    const banner = safeHttpUrl(data.banner || '');
    const website = safeHttpUrl(data.website || '');
    const npub = nip19.npubEncode(pubkey);
    view.replaceChildren(...[
      back,
      banner ? el('img', { class: 'profile-banner', src: banner, alt: '', referrerpolicy: 'no-referrer' }) : null,
      el('header', { class: 'note-header profile-header' },
        avatar(pubkey, 'large'),
        el('div', { class: 'note-meta' },
          el('div', { class: 'author-line' }, el('span', { class: 'author-name' }, profile.name), badge(zaps, cachedZapSats(pubkey))),
          typeof data.nip05 === 'string' && data.nip05 ? el('div', { class: 'note-time' }, data.nip05) : null),
        el('div', { class: 'profile-actions' }, followButton(pubkey))),
      typeof data.about === 'string' && data.about ? renderContent(data.about, 'note-content profile-about') : null,
      el('dl', { class: 'profile-meta' },
        website ? [el('dt', {}, 'Website'), el('dd', {}, el('a', { href: website, target: '_blank', rel: 'noopener noreferrer' }, website))] : null,
        profile.lud16 ? [el('dt', {}, 'Lightning'), el('dd', {}, profile.lud16)] : null,
        followsCount !== null ? [el('dt', {}, 'Follows'), el('dd', {}, String(followsCount))] : null,
        el('dt', {}, 'Public key'),
        el('dd', { class: 'npub' },
          el('span', {}, `${npub.slice(0, 20)}…${npub.slice(-6)}`),
          el('button', {
            type: 'button', class: 'link-button',
            onclick: () => navigator.clipboard.writeText(npub).then(() => toast('npub copied')).catch(() => toast('Could not copy', 'error'))
          }, 'Copy'))),
      notesEl
    ].filter(Boolean));
  };
  render();

  const [, counts, contactList] = await Promise.all([
    ensureProfile(pubkey),
    countRecentZapsSent([pubkey]),
    fetchContactList(pubkey).catch(() => null)
  ]);
  if (token !== profileToken) return;
  const zaps = counts.get(pubkey) || 0;
  render(zaps, contactList ? contactList.tags.filter(t => t[0] === 'p').length : null);

  try {
    const notes = await loadProfileNotes(pubkey);
    if (token !== profileToken) return;
    notesEl.replaceChildren(el('p', { class: 'replies-status busy' }, 'Loading interaction counts…'));
    await loadNoteStats(notes, getSession()?.pubkey);
    if (token !== profileToken) return;
    notesEl.replaceChildren(
      el('h2', { class: 'replies-heading' }, `Recent notes (${notes.length})`),
      ...(notes.length ? notes.map(note => profileNoteCard(note, zaps)) : [el('p', { class: 'replies-status' }, 'No recent notes found on their relays.')]));
  } catch (err) {
    if (token !== profileToken) return;
    notesEl.replaceChildren(el('p', { class: 'replies-status' }, `Could not load notes: ${err.message}`));
  }
}

document.addEventListener('zs:open-profile', ({ detail: pubkey }) => showProfile(pubkey));

// ---------- Note view ----------

function replyItem(reply, zaps) {
  return el('article', { class: 'reply' },
    profileLink(reply.pubkey, avatar(reply.pubkey, 'small')),
    el('div', { class: 'reply-body' },
      el('div', { class: 'reply-meta' }, profileLink(reply.pubkey, authorLine(reply.pubkey, zaps)), timeEl(reply.created_at)),
      renderContent(reply.content),
      actionBar(reply)));
}

function renderReplies() {
  if (!openThread?.replies) return;
  const { replies, counts, container, showAllReplies } = openThread;
  const visible = showAllReplies ? replies : replies.filter(r => passesFilter(r.pubkey));
  const hidden = replies.length - visible.length;
  const hiddenStatus = hidden ? el('p', { class: 'replies-status' },
    `${hidden} ${hidden === 1 ? 'reply' : 'replies'} hidden from people who haven't ${thresholdText()}. `,
    el('button', {
      type: 'button',
      class: 'link-button',
      onclick: () => {
        openThread.showAllReplies = true;
        renderReplies();
      }
    }, 'Show anyway')) : null;
  container.replaceChildren(
    el('h2', { class: 'replies-heading' }, `Replies (${visible.length})`),
    ...(hiddenStatus ? [hiddenStatus] : []),
    ...visible.map(reply => replyItem(reply, counts.get(reply.pubkey) || 0)));
}

function renderZap(zap) {
  return el('div', { class: 'reply zap-item' },
    avatar(zap.sender, 'small'),
    el('div', { class: 'reply-body' },
      el('div', { class: 'reply-meta' },
        profileLink(zap.sender, authorLine(zap.sender, 0)),
        el('span', { class: 'zap-amount' }, `⚡ ${formatSats(zap.sats)} sats`),
        timeEl(zap.createdAt)),
      zap.comment.trim() ? renderContent(zap.comment, 'note-content zap-comment') : null));
}

async function loadNoteZaps(note, container) {
  try {
    const zaps = await fetchNoteZaps(note);
    if (!container.isConnected) return;
    await ensureProfiles([...new Set(zaps.map(zap => zap.sender))]);
    if (!container.isConnected) return;
    container.replaceChildren(
      el('h2', { class: 'replies-heading' }, `Note zaps (${zaps.length})`),
      ...(zaps.length ? zaps.map(renderZap) : [el('p', { class: 'replies-status' }, 'No verified zaps yet.')])
    );
  } catch (err) {
    if (container.isConnected) container.replaceChildren(el('p', { class: 'replies-status' }, `Could not load zaps: ${err.message}`));
  }
}

function createInteractionDropdown() {
  const panel = el('div', { class: 'interaction-panel' }, el('p', { class: 'replies-status busy' }, 'Loading people…'));
  const dropdown = el('details', { class: 'interaction-dropdown' },
    el('summary', { class: 'action interaction-toggle' }, el('span', { 'aria-hidden': 'true' }, '👥'), 'People'),
    panel);
  const group = (label, pubkeys) => el('section', { class: 'interaction-group' },
    el('h3', {}, `${label} (${pubkeys.length})`),
    pubkeys.length
      ? el('ul', {}, ...pubkeys.map(pubkey => {
        const name = parseProfile(pubkey).name;
        const link = profileLink(pubkey, avatar(pubkey, 'small'));
        link.setAttribute('aria-label', `View ${name}'s profile`);
        link.title = name;
        return el('li', {}, link);
      }))
      : el('p', { class: 'interaction-empty' }, 'No one yet.'));
  return {
    element: dropdown,
    render(people) {
      panel.replaceChildren(
        group('Reposted by', people.reposts),
        group('Quoted by', people.quotes),
        group('Liked by', people.likes));
    }
  };
}

async function loadThread(note, container, interactionDropdown) {
  const token = ++threadToken;
  openThread = { noteId: note.id, container, showAllReplies: false };
  const progress = el('p', { class: 'replies-status busy' }, 'Loading replies, likes and zaps from relays…');
  container.replaceChildren(progress, skeletonReply(), skeletonReply());
  try {
    let zapCountsPromise;
    const replies = await fetchThread(note, getSession()?.pubkey, loadedReplies => {
      if (token !== threadToken) return;
      const repliers = [...new Set(loadedReplies.map(reply => reply.pubkey))];
      progress.textContent = `Found ${loadedReplies.length} replies. Loading zap receipts for ${repliers.length} people…`;
      zapCountsPromise = countRecentZapsSent(repliers, (done, total, stage) => {
        if (token !== threadToken || !progress.isConnected) return;
        progress.textContent = stage === 'fetching'
          ? `Found ${loadedReplies.length} replies. Loading zap receipts for ${total} people…`
          : `Found ${loadedReplies.length} replies. Checking zap history: ${done}/${total} people…`;
      });
    }, people => interactionDropdown.render(people));
    if (token !== threadToken) return;
    const counts = await zapCountsPromise;
    if (token !== threadToken) return;
    Object.assign(openThread, { replies, counts });
    renderReplies();
  } catch (err) {
    if (token !== threadToken) return;
    container.replaceChildren(el('p', { class: 'replies-status' }, `Could not load replies: ${err.message}`));
  }
}

function showNote(item, button = null) {
  for (const other of listEl.querySelectorAll('.note-item')) other.removeAttribute('aria-current');
  button?.setAttribute('aria-current', 'true');
  if (button) selectedNoteId = item.note.id;
  shownNoteId = item.note.id;
  profileOpen = null;
  profileToken++;
  if (button) currentItem = item;

  const { note, zaps, repostedBy } = item;
  const zapsEl = el('section', { class: 'note-zaps' }, el('p', { class: 'replies-status busy' }, 'Loading zaps…'));
  const repliesEl = el('section', { class: 'replies' });
  const interactionDropdown = createInteractionDropdown();
  const replyBox = canSign()
    ? inlineReplyBox(note)
    : el('p', { class: 'replies-status' }, getSession() ? 'Read-only: log in with a signer to reply.' : el('button', { type: 'button', class: 'link-button', onclick: openLoginDialog }, 'Log in to reply'));
  const focusReply = () => replyBox.querySelector?.('textarea')?.focus();
  const back = !button && currentItem ? el('button', { type: 'button', class: 'link-button back-link', onclick: backToNote }, '← Back') : null;

  mainEl.replaceChildren(el('article', { class: 'note' },
    back,
    repostLine(repostedBy),
    el('header', { class: 'note-header' },
      profileLink(note.pubkey, avatar(note.pubkey, 'large')),
      el('div', { class: 'note-meta' }, profileLink(note.pubkey, authorLine(note.pubkey, zaps)), timeEl(note.created_at)),
      el('div', { class: 'profile-actions' }, followButton(note.pubkey))),
    renderContent(note.content, 'note-content', { linkPreviews: true }),
    el('div', { class: 'note-toolbar' },
      actionBar(note, { onReply: focusReply }),
      interactionDropdown.element),
    zapsEl,
    replyBox,
    repliesEl));
  mainEl.parentElement.scrollTop = 0;
  loadNoteZaps(note, zapsEl);
  loadThread(note, repliesEl, interactionDropdown);
}

// ---------- Feed list ----------

function setStatus(text, busy = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('busy', busy);
}

const skeletonLine = width => el('span', { class: 'skeleton-line', style: `width: ${width}%` });

function skeletonItem() {
  return el('li', { class: 'skeleton-item', 'aria-hidden': 'true' },
    el('span', { class: 'avatar skeleton' }),
    el('div', { class: 'note-item-body' }, skeletonLine(40), skeletonLine(95), skeletonLine(70)));
}

function skeletonReply() {
  return el('div', { class: 'reply', 'aria-hidden': 'true' },
    el('span', { class: 'avatar small skeleton' }),
    el('div', { class: 'reply-body' }, skeletonLine(30), skeletonLine(85)));
}

function skeletonNote(message) {
  return el('div', { class: 'note' },
    el('p', { class: 'empty busy' }, message),
    el('div', { class: 'note-header', 'aria-hidden': 'true' },
      el('span', { class: 'avatar large skeleton' }),
      el('div', { class: 'note-meta' }, skeletonLine(50), skeletonLine(30))),
    skeletonLine(100), skeletonLine(92), skeletonLine(60));
}

function itemStats(noteId) {
  const s = statsFor(noteId);
  const parts = [
    s.satszapped && `⚡ ${formatSats(s.satszapped)}`,
    s.replies && `💬 ${s.replies}`,
    s.reposts && `🔁 ${s.reposts}`,
    s.likes && `❤️ ${s.likes}`
  ].filter(Boolean);
  return parts.length ? el('div', { class: 'item-stats' }, parts.join('  ·  ')) : null;
}

function renderList(items, emptyMessage) {
  listEl.replaceChildren(...items.map(item => {
    const button = el('button', { class: 'note-item', type: 'button', 'data-note-id': item.note.id },
      avatar(item.note.pubkey),
      el('div', { class: 'note-item-body' },
        repostLine(item.repostedBy),
        authorLine(item.note.pubkey, item.zaps),
        el('div', { class: 'note-preview' }, item.note.content.slice(0, 280)),
        itemStats(item.note.id)));
    button.addEventListener('click', () => showNote(item, button));
    return el('li', {}, button);
  }));
  const selected = [...listEl.querySelectorAll('.note-item')].find(b => b.dataset.noteId === selectedNoteId);
  if (profileOpen || (selected && selectedNoteId === shownNoteId)) {
    if (!profileOpen) selected.setAttribute('aria-current', 'true');
  } else if (selected || listEl.querySelector('.note-item')) {
    (selected || listEl.querySelector('.note-item')).click();
  } else {
    shownNoteId = null;
    mainEl.replaceChildren(el('p', { class: 'empty' }, emptyMessage));
  }
  renderLoadMore();
  observeReplyPrefetch(items);
}

function drainReplyPrefetchQueue() {
  while (activeReplyPrefetches < 2 && replyPrefetchQueue.length) {
    const { note, self } = replyPrefetchQueue.shift();
    activeReplyPrefetches++;
    prefetchThread(note, self).catch(() => {}).finally(() => {
      activeReplyPrefetches--;
      queuedReplyIds.delete(note.id);
      drainReplyPrefetchQueue();
    });
  }
}

function observeReplyPrefetch(items) {
  replyObserver?.disconnect();
  const itemsById = new Map(items.map(item => [item.note.id, item]));
  replyObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      replyObserver.unobserve(entry.target);
      const item = itemsById.get(entry.target.dataset.noteId);
      if (!item || queuedReplyIds.has(item.note.id)) continue;
      queuedReplyIds.add(item.note.id);
      replyPrefetchQueue.push({ note: item.note, self: getSession()?.pubkey });
    }
    drainReplyPrefetchQueue();
  }, { root: listEl, rootMargin: '400px' });
  for (const item of listEl.querySelectorAll('.note-item')) replyObserver.observe(item);
}

// ---------- Home feed: load older notes on scroll ----------

const dateLabel = seconds => new Date(seconds * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

function renderLoadMore() {
  moreObserver?.disconnect();
  if (!lastResult?.isHome || lastResult.loading) return;
  const { exhausted, failed, cursor } = lastResult;
  const text = exhausted
    ? `That's everything back to ${dateLabel(cursor)}.`
    : failed ? 'Could not load older notes. Scroll to retry.' : 'Loading older notes…';
  const sentinel = el('li', { class: `load-more${exhausted || failed ? '' : ' busy'}`, role: 'status' }, text);
  listEl.append(sentinel);
  if (exhausted) return;
  // observe() fires straight away if the sentinel is already visible, so short pages keep loading.
  moreObserver = new IntersectionObserver(entries => {
    if (entries.some(entry => entry.isIntersecting)) loadMore();
  }, { root: listEl, rootMargin: '300px' });
  moreObserver.observe(sentinel);
}

async function loadMore() {
  const result = lastResult;
  if (!result?.isHome || result.loadingMore || result.exhausted) return;
  result.loadingMore = true;
  result.failed = false;
  try {
    const sentinel = () => listEl.querySelector('.load-more');
    const page = await loadHomeItems(getSession().pubkey, result.cursor, text => {
      if (sentinel()) sentinel().textContent = `Older notes: ${text.charAt(0).toLowerCase()}${text.slice(1)}`;
    });
    const known = new Set(result.items.map(item => item.note.id));
    const fresh = page.items.filter(item => !known.has(item.note.id));
    const counts = await countRecentZapsSent([...new Set(fresh.map(item => item.note.pubkey))], (done, total, stage) => {
      if (sentinel()) sentinel().textContent = stage === 'fetching'
        ? `Older notes: loading zap receipts for ${total} authors…`
        : `Older notes: checking zap history ${done}/${total}…`;
    });
    if (result !== lastResult) return;
    for (const item of fresh) item.zaps = counts.get(item.note.pubkey);
    result.items.push(...fresh);
    result.cursor = page.cursor;
    result.emptyPages = fresh.length ? 0 : (result.emptyPages || 0) + 1;
    result.exhausted = result.emptyPages >= MAX_EMPTY_PAGES || result.cursor < now() - HOME_MAX_AGE_DAYS * 86400;
  } catch (err) {
    console.warn('Loading older notes failed', err);
    result.failed = true;
  } finally {
    result.loadingMore = false;
  }
  if (result !== lastResult) return;
  const scrollTop = listEl.scrollTop;
  applyFilter();
  listEl.scrollTop = scrollTop;
  refreshStats();
}

// Counts for list items arrive after the list renders; re-sort once they are in.
async function refreshStats() {
  const result = lastResult;
  const missing = result?.items.filter(item => !item.hasStats) || [];
  if (missing.length === 0) return;
  await loadNoteStats(missing.map(item => item.note), getSession()?.pubkey);
  for (const item of missing) item.hasStats = true;
  if (result !== lastResult) return;
  const scrollTop = listEl.scrollTop;
  applyFilter();
  listEl.scrollTop = scrollTop;
}

function applyFilter() {
  if (!lastResult) return;
  const { items, isHome, fallback, verifiedAuthors, zapCheckComplete, zapStage, authorCount } = lastResult;
  const readyItems = verifiedAuthors && !zapCheckComplete
    ? items.filter(item => verifiedAuthors.has(item.note.pubkey))
    : items;
  const filterOn = !isHome || !settings.showAllFollows;
  const filtered = filterOn ? readyItems.filter(item => passesFilter(item.note.pubkey)) : readyItems;
  const shown = sortItems(filtered);
  const counting = currentSort().needsStats && items.some(item => !item.hasStats);
  const badged = readyItems.filter(i => i.zaps > 0 && cachedZapSats(i.note.pubkey) >= settings.minZapSats).length;
  const progressText = zapCheckComplete ? '' : zapStage === 'fetching'
    ? ` Loading zap receipts for ${authorCount} authors…`
    : ` Checking zap history: ${verifiedAuthors?.size || 0}/${authorCount} authors…`;
  setStatus((filterOn
    ? `${shown.length} of ${zapCheckComplete ? items.length : readyItems.length} notes are from authors who have ${thresholdText()}.`
    : `${readyItems.length} notes from people you follow. ${badged} have the zapper badge.`)
    + progressText
    + (counting ? ' Counting zaps and replies…' : '')
    + (fallback ? ' Primal is unavailable, so notes are ranked from relays.' : ''), counting);
  if (!shown.length && !zapCheckComplete && !selectedNoteId) return;
  renderList(shown, isHome
    ? zapCheckComplete ? 'No recent notes from people you follow match this filter.' : 'Checking zap history for more notes…'
    : zapCheckComplete ? 'No trending notes from verified zappers in this feed.' : 'Checking zap history for more notes…');
}

async function loadFeed(feedId) {
  const token = ++loadToken;
  const session = getSession();
  const isHome = Boolean(feedId === HOME_FEED.id && session);
  const found = FEEDS.find(f => f.id === feedId && (session || !f.personal));
  const feed = isHome ? HOME_FEED : found || FEEDS.find(f => f.id === DEFAULT_FEED_ID);
  lastResult = null;
  selectedNoteId = null;
  profileOpen = null;
  profileToken++;
  moreObserver?.disconnect();
  renderSortOptions();
  listEl.replaceChildren(...Array.from({ length: 6 }, skeletonItem));
  const firstStep = isHome
    ? 'Loading notes from the relays your follows publish to…'
    : `Loading ${feed.label.toLowerCase()} from Primal…`;
  mainEl.replaceChildren(skeletonNote(firstStep));
  const progress = text => {
    if (token !== loadToken) return;
    setStatus(text, true);
    const message = mainEl.querySelector('.empty.busy');
    if (message) message.textContent = text;
  };
  progress(firstStep);

  try {
    let items;
    let cursor = null;
    let source = 'relays';
    if (isHome) {
      ({ items, cursor } = await loadHomeItems(session.pubkey, null, progress));
    } else {
      ({ items, source } = await loadTrendingItems(feed, session?.pubkey, progress));
      progress(`Got ${items.length} notes${source === 'Primal' ? '' : ' (ranked from relays, Primal unavailable)'}. Loading profiles…`);
      await ensureProfiles(items.map(item => item.note.pubkey));
    }
    if (token !== loadToken) return;
    const authors = [...new Set(items.map(item => item.note.pubkey))];
    const result = {
      items,
      isHome,
      cursor,
      fallback: !isHome && source !== 'Primal',
      verifiedAuthors: new Set(),
      zapCheckComplete: false,
      zapStage: 'fetching',
      authorCount: authors.length,
      loading: true
    };
    lastResult = result;
    const counts = await countRecentZapsSent(authors, (done, total, stage, author) => {
      if (token !== loadToken || result !== lastResult) return;
      result.zapStage = stage;
      if (author) {
        result.verifiedAuthors.add(author);
        for (const item of items) {
          if (item.note.pubkey === author) item.zaps = cachedZapCount(author);
        }
      }
      applyFilter();
    });
    if (token !== loadToken) return;
    for (const item of items) item.zaps = counts.get(item.note.pubkey);
    result.zapCheckComplete = true;
    result.loading = false;
    applyFilter();
    refreshStats();
  } catch (err) {
    if (token !== loadToken) return;
    setStatus(`Failed to load: ${err.message}`);
    listEl.replaceChildren();
    mainEl.replaceChildren(el('p', { class: 'empty' }, 'Could not load this feed. Try another one.'));
  }
}

function renderFeedOptions(selectedId) {
  const session = getSession();
  const feeds = [HOME_FEED, ...FEEDS].filter(f => session || !f.personal);
  const groups = new Map();
  for (const feed of feeds) {
    if (!groups.has(feed.group)) groups.set(feed.group, el('optgroup', { label: feed.group }));
    groups.get(feed.group).append(el('option', { value: feed.id }, feed.label));
  }
  feedSelect.replaceChildren(...groups.values());
  feedSelect.value = feeds.some(f => f.id === selectedId) ? selectedId : DEFAULT_FEED_ID;
}

// ---------- Account ----------

function settingsButton() {
  return el('button', { class: 'button secondary small', type: 'button', onclick: openSettings }, '⚙️ Settings');
}

function renderAccount() {
  const session = getSession();
  if (!session) {
    accountEl.replaceChildren(
      el('div', { class: 'account-actions' },
        settingsButton(),
        el('button', { class: 'button small', type: 'button', onclick: openLoginDialog }, 'Log in')));
    return;
  }
  const profile = parseProfile(session.pubkey);
  accountEl.replaceChildren(
    el('button', { type: 'button', class: 'account-who profile-link', title: 'View your profile', onclick: () => showProfile(session.pubkey) },
      avatar(session.pubkey, 'small'),
      el('div', { class: 'account-info' },
        el('span', { class: 'author-name' }, profile.name),
        el('span', { class: 'account-method' }, LOGIN_METHODS[session.method]))),
    el('div', { class: 'account-actions' },
      settingsButton(),
      el('button', { class: 'button ghost small', type: 'button', onclick: logout }, 'Log out')));
  const newNoteButton = document.getElementById('new-note');
  newNoteButton.replaceChildren(el('img', { class: 'new-note-icon', src: 'send-message-icon.webp', alt: '', 'aria-hidden': 'true' }), 'New note');
  newNoteButton.hidden = !canSign();
}

async function loadOwnProfile() {
  const session = getSession();
  if (!session || profiles.has(session.pubkey)) return;
  const ev = await pool.get(PROFILE_RELAYS, { kinds: [0], authors: [session.pubkey] }).catch(() => null);
  if (ev) {
    rememberProfile(ev);
    renderAccount();
  }
}

// ---------- Settings ----------

function updateThresholdLabels() {
  minZapSatsInput.value = settings.minZapSats;
  showAllFollows.checked = settings.showAllFollows;
}

let thresholdTimer = null;

// Spinner clicks fire a change per step, so wait for the user to settle before reloading.
function reloadSoon() {
  clearTimeout(thresholdTimer);
  thresholdTimer = setTimeout(() => loadFeed(feedSelect.value), 400);
}

function bindThreshold(input, max, current, save) {
  input.addEventListener('change', () => {
    const value = Math.trunc(Number(input.value));
    if (Number.isFinite(value) && value >= 0 && value <= max && value !== current()) {
      save(value);
      reloadSoon();
    }
    updateThresholdLabels();
  });
}

bindThreshold(minZapSatsInput, MAX_MIN_ZAP_SATS, () => settings.minZapSats, value => settings.setMinZapSats(value));

// ---------- Events ----------

document.addEventListener('zs:session', () => {
  const session = getSession();
  renderAccount();
  document.getElementById('new-note').hidden = !canSign();
  const wasPersonal = [HOME_FEED, ...FEEDS].some(f => f.id === feedSelect.value && f.personal);
  const next = session ? HOME_FEED.id : wasPersonal ? DEFAULT_FEED_ID : feedSelect.value;
  renderFeedOptions(next);
  loadFeed(feedSelect.value);
  loadOwnProfile();
});

document.addEventListener('zs:need-login', openLoginDialog);

document.addEventListener('zs:published', ({ detail: event }) => {
  if (event.kind !== 1) return;
  const isThreadReply = openThread && isDirectReplyTo(event, openThread.noteId);
  if (isThreadReply && openThread.replies) {
    openThread.replies.push(event);
    openThread.counts.set(event.pubkey, cachedZapCount(event.pubkey));
    renderReplies();
  } else if (!event.tags.some(t => t[0] === 'e') && lastResult?.isHome) {
    lastResult.items.unshift({ note: event, zaps: cachedZapCount(event.pubkey) });
    selectedNoteId = event.id;
    applyFilter();
  }
});

feedSelect.addEventListener('change', () => loadFeed(feedSelect.value));
showAllFollows.addEventListener('change', () => {
  settings.setShowAllFollows(showAllFollows.checked);
  applyFilter();
});
sortSelect.addEventListener('change', () => {
  store.set(SORT_KEY, sortSelect.value);
  applyFilter();
  listEl.scrollTop = 0;
});
document.getElementById('new-note').addEventListener('click', () => openComposer());

// ---------- Collapsible sidebar controls ----------

const CONTROLS_KEY = 'zs-controls-collapsed';
const controlsToggle = document.getElementById('controls-toggle');
const controlsEl = document.getElementById('sidebar-controls');
const controlsSummary = document.getElementById('controls-summary');

function updateControlsSummary() {
  const feed = feedSelect.selectedOptions[0]?.textContent || '';
  const sort = sortSelect.selectedOptions[0]?.textContent || '';
  controlsSummary.textContent = [feed, sort].filter(Boolean).join(' · ');
}

function setControlsCollapsed(collapsed) {
  controlsEl.hidden = collapsed;
  controlsSummary.hidden = !collapsed;
  controlsEl.parentElement.classList.toggle('collapsed', collapsed);
  controlsToggle.setAttribute('aria-expanded', String(!collapsed));
  const label = collapsed ? 'Show controls' : 'Hide controls';
  controlsToggle.setAttribute('aria-label', label);
  controlsToggle.title = label;
  updateControlsSummary();
  store.set(CONTROLS_KEY, collapsed);
}

controlsToggle.addEventListener('click', () => setControlsCollapsed(!controlsEl.hidden));
feedSelect.addEventListener('change', updateControlsSummary);
sortSelect.addEventListener('change', updateControlsSummary);
document.addEventListener('zs:session', updateControlsSummary);
document.getElementById('home-button').addEventListener('click', () => {
  const homeId = getSession() ? HOME_FEED.id : DEFAULT_FEED_ID;
  feedSelect.value = homeId;
  updateControlsSummary();
  loadFeed(homeId);
});

// ---------- Slide-out sidebar ----------

const SIDEBAR_KEY = 'zs-sidebar-hidden';
const sidebarShow = document.getElementById('sidebar-show');
const sidebarHide = document.getElementById('sidebar-hide');

function setSidebarHidden(hidden, { focus = false } = {}) {
  document.body.classList.toggle('sidebar-hidden', hidden);
  document.getElementById('sidebar').inert = hidden;
  sidebarShow.hidden = !hidden;
  store.set(SIDEBAR_KEY, hidden);
  if (focus) (hidden ? sidebarShow : sidebarHide).focus();
}

sidebarHide.addEventListener('click', () => setSidebarHidden(true, { focus: true }));
sidebarShow.addEventListener('click', () => setSidebarHidden(false, { focus: true }));

updateThresholdLabels();
renderAccount();
document.getElementById('new-note').hidden = !canSign();
renderFeedOptions(getSession() ? HOME_FEED.id : DEFAULT_FEED_ID);
loadFeed(feedSelect.value);
setControlsCollapsed(store.get(CONTROLS_KEY) === true);
document.body.classList.add('no-anim');
setSidebarHidden(store.get(SIDEBAR_KEY) === true);
requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove('no-anim')));
loadOwnProfile();
