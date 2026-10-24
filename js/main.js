import { pool, PROFILE_RELAYS, rememberProfile, profiles, parseProfile, ensureProfile, settings, MAX_MIN_ZAP_SATS, statsFor } from './state.js';
import { FEEDS, DEFAULT_FEED_ID, loadTrendingItems } from './primal.js';
import { loadHomeItems, loadThread as fetchThread, prefetchThread, ensureProfiles, loadNoteStats, refreshNoteStats, pollRecentNotes, refreshThread, loadProfileNotes, loadNoteEvent, fetchContactList } from './notes.js?v=0.4.0';
import { countRecentZapsSent, loadNoteZaps as fetchNoteZaps, cachedZapCount, cachedZapSats } from './zapcount.js';
import { getSession, canSign, isOwn, logout, LOGIN_METHODS } from './signer.js';
import { avatar, authorLine, badge, repostLine, renderContent, timeEl } from './render.js';
import { actionBar, requireSigner } from './actions.js?v=0.2.0';
import { isFollowing, setFollowing } from './social.js';
import { toast } from './dialogs.js';
import { nip10, nip19 } from './deps.js';
import { inlineReplyBox, openComposer } from './compose.js';
import { openLoginDialog } from './login.js';
import { openSettings } from './settings.js';
import { el, isDirectReplyTo, isReply, now, store, formatSats, safeHttpUrl } from './util.js';
import { buildReplyTree } from './reply-tree.mjs';
import { notePath, parseViewPath, profilePath, profileActivityPath } from './view-routes.mjs';
import { selectNewNotes } from './live-updates.mjs';
import { fetchNotificationActivity } from './notification-service.js';
import { mergeNotifications, notificationSince } from './notifications.mjs';
import { createUserActivityLoader } from './user-activity-service.js';

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
const accountProfileEl = document.getElementById('account-profile');
const sidebarProfileIconEl = document.getElementById('sidebar-profile-icon');
const newFeedNotesButton = document.getElementById('new-feed-notes');
const notificationsDialog = document.getElementById('notifications-dialog');
const notificationsListEl = document.getElementById('notifications-list');
const noteNavigation = document.getElementById('note-navigation');
const previousNoteButton = document.getElementById('previous-note');
const nextNoteButton = document.getElementById('next-note');

const HOME_FEED = { id: 'home', label: 'Home (following)', group: 'You', personal: true };
const MAX_EMPTY_PAGES = 3;
const HOME_MAX_AGE_DAYS = 30;
const LIVE_REFRESH_MS = 60_000;
const MAX_PENDING_FEED_NOTES = 100;

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
let routeToken = 0;
let routeNotice = '';
let liveRefreshBusy = false;
let lastLivePollAt = now();
let notificationTrigger = null;
let notificationBadge = null;
let notificationToken = 0;
let notificationState = {
  pubkey: null,
  ownNotes: [],
  items: [],
  readAt: null,
  lastPollAt: null,
  busy: false,
  failed: false
};

function updatePath(path, replace = false) {
  if (location.pathname === path && !location.search && !location.hash) return;
  history[replace ? 'replaceState' : 'pushState']({ zapsurf: true }, '', path);
}

function replyParentId(event) {
  const { root, reply } = nip10.parse(event);
  return reply?.id || root?.id || null;
}

const passesFilter = pubkey => isOwn(pubkey) || cachedZapSats(pubkey) >= settings.minZapSats;

const thresholdText = () => `sent ${formatSats(settings.minZapSats)}+ sats in the last 14 days`;

// ---------- Profiles & following ----------

function profileLink(pubkey, ...children) {
  return el('button', {
    type: 'button', class: 'profile-link', title: 'View profile',
    onclick: event => { event.stopPropagation(); showProfile(pubkey); }
  }, ...children);
}

function viewLink(path, open, ...children) {
  return el('a', {
    href: path, class: 'link-button',
    onclick: event => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      open();
    }
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

async function showProfile(pubkey, { updateHistory = true } = {}) {
  routeToken++;
  routeNotice = '';
  if (updateHistory) updatePath(profilePath(pubkey, nip19));
  const token = ++profileToken;
  threadToken++;
  openThread = null;
  profileOpen = pubkey;
  shownNoteId = null;
  updateNoteNavigation();
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
      el('nav', { class: 'profile-navigation', 'aria-label': 'Profile' },
        viewLink(profileActivityPath(pubkey, nip19), () => showProfileActivity(pubkey), 'All Activity')),
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

function activityAccount(pubkey) {
  return el('div', { class: 'activity-account' },
    profileLink(pubkey, avatar(pubkey, 'small')),
    profileLink(pubkey, authorLine(pubkey, cachedZapCount(pubkey))));
}

function activityPost(note, label = '') {
  return el('div', { class: 'activity-post' },
    label ? el('p', { class: 'activity-context' }, label) : null,
    activityAccount(note.pubkey),
    renderContent(note.content, 'note-content activity-content'),
    el('div', { class: 'profile-note-footer' },
      timeEl(note.created_at),
      note.kind === 1
        ? viewLink(notePath(note.id, nip19), () => showNote({ note, zaps: cachedZapCount(note.pubkey) }), 'Open note')
        : el('a', {
          href: `https://njump.me/${nip19.neventEncode({ id: note.id, kind: note.kind, author: note.pubkey })}`,
          target: '_blank', rel: 'noopener noreferrer'
        }, 'View event')));
}

function activityItem(item, targets) {
  const labels = { post: 'Posted', reply: 'Replied', repost: 'Reposted', follow: 'Started following' };
  let label = labels[item.type];
  if (item.type === 'like') label = item.reaction === '+' ? 'Liked' : item.reaction === '-' ? 'Disliked' : `Reacted ${item.reaction}`;
  if (item.type === 'zap') label = `Zapped ${formatSats(item.zap.sats)} sats`;
  const target = targets.get(item.targetId);
  const missing = item.targetId && !target ? el('div', { class: 'activity-missing' },
    el('p', { class: 'replies-status' }, 'Target post unavailable.'),
    item.targetKind === 1
      ? viewLink(notePath(item.targetId, nip19), () => restoreActivityTarget(item.targetId), 'Open note')
      : el('a', { href: `https://njump.me/${nip19.neventEncode({ id: item.targetId })}`, target: '_blank', rel: 'noopener noreferrer' }, 'View event'),
    el('span', { class: 'activity-reference' }, item.targetId)) : null;
  return el('article', { class: `activity-item activity-${item.type}`, 'data-activity-id': item.id },
    el('header', { class: 'activity-heading' }, el('strong', {}, label), timeEl(item.created_at)),
    item.type === 'follow' || (item.type === 'zap' && !item.targetId) ? activityAccount(item.account) : null,
    item.type === 'zap' && item.zap.comment ? renderContent(item.zap.comment, 'note-content activity-comment') : null,
    item.type === 'reply' ? el('div', { class: 'activity-response' },
      renderContent(item.event.content, 'note-content activity-content'),
      viewLink(notePath(item.event.id, nip19), () => showNote({ note: item.event, zaps: cachedZapCount(item.event.pubkey) }), 'Open reply')) : null,
    target ? activityPost(target, item.type === 'reply' ? 'In reply to' : '') : missing);
}

function restoreActivityTarget(id) {
  updatePath(notePath(id, nip19));
  restoreLocation();
}

async function showProfileActivity(pubkey, { updateHistory = true } = {}) {
  const activityRoute = ++routeToken;
  routeNotice = '';
  if (updateHistory) updatePath(profileActivityPath(pubkey, nip19));
  const token = ++profileToken;
  loadToken++;
  threadToken++;
  openThread = null;
  profileOpen = pubkey;
  shownNoteId = null;
  updateNoteNavigation();
  for (const other of listEl.querySelectorAll('.note-item')) other.removeAttribute('aria-current');
  if (!lastResult) listEl.replaceChildren();
  setStatus('All Activity');

  const identity = el('div', { class: 'activity-identity' }, activityAccount(pubkey));
  const rows = el('div', { class: 'activity-list', 'aria-label': 'Activity' });
  const status = el('p', { class: 'replies-status', role: 'status' });
  const warnings = el('div', { class: 'activity-warnings' });
  const controls = el('div', { class: 'activity-controls' });
  const back = viewLink(profilePath(pubkey, nip19), () => showProfile(pubkey), 'Back to profile');
  back.classList.add('back-link');
  mainEl.replaceChildren(el('section', { class: 'note activity-page' },
    back, el('h1', { class: 'activity-title' }, 'All Activity'), identity, warnings, rows, status, controls));
  mainEl.parentElement.scrollTop = 0;

  let loader = null;
  let busy = false;
  let items = [];
  const targets = new Map();
  const current = () => token === profileToken && activityRoute === routeToken;
  const load = async (retry = false) => {
    if (busy || !current()) return;
    busy = true;
    rows.setAttribute('aria-busy', 'true');
    status.classList.add('busy');
    status.textContent = 'Loading activity from relays...';
    controls.replaceChildren();
    try {
      if (retry) loader = null;
      if (!loader) loader = await createUserActivityLoader(pubkey);
      if (!current()) return;
      const page = await loader.next();
      if (!current()) return;
      items = page.items;
      for (const [id, note] of page.targets) targets.set(id, note);
      identity.replaceChildren(activityAccount(pubkey));
      rows.replaceChildren(...items.map(item => activityItem(item, targets)));
      warnings.replaceChildren(
        ...(page.partial ? [el('p', { class: 'replies-status' }, 'Some relays are unavailable. Showing available activity.')] : []),
        ...(page.followHistoryLimited ? [el('p', { class: 'replies-status' }, 'New-follow history unavailable: older follow lists were not found.')] : []));
      status.textContent = page.blocked
        ? 'A relay response limit was reached. Older activity could not be loaded without skipping events.'
        : page.exhausted ? items.length ? 'End of available activity.' : 'No activity found on available relays.'
          : `${items.length} ${items.length === 1 ? 'activity' : 'activities'} loaded.`;
      if (!page.exhausted && !page.blocked) controls.append(el('button', { type: 'button', class: 'button secondary', onclick: () => load() }, 'Load more'));
      if (page.partial || page.blocked) controls.append(el('button', { type: 'button', class: 'link-button', onclick: () => load(true) }, 'Retry relays'));
    } catch (error) {
      if (!current()) return;
      status.textContent = `Could not load activity: ${error.message}`;
      controls.append(el('button', { type: 'button', class: 'button secondary', onclick: () => load(true) }, 'Retry'));
    } finally {
      busy = false;
      rows.removeAttribute('aria-busy');
      status.classList.remove('busy');
    }
  };
  await load();
}

// ---------- Note view ----------

function replyItem(reply, zaps, nested = false) {
  return el('article', { class: `reply${nested ? ' nested-reply' : ''}` },
    nested ? el('span', { class: 'reply-marker', 'aria-hidden': 'true' }, '↪') : null,
    profileLink(reply.pubkey, avatar(reply.pubkey, 'small')),
    el('div', { class: 'reply-body' },
      el('div', { class: 'reply-meta' }, profileLink(reply.pubkey, authorLine(reply.pubkey, zaps)), timeEl(reply.created_at)),
      renderContent(reply.content),
      actionBar(reply)));
}

function renderReplyNode(node, counts, depth = 0) {
  return el('div', { class: 'reply-thread' },
    replyItem(node.event, counts.get(node.event.pubkey) || 0, depth > 0),
    node.children.length ? el('div', {
      class: `reply-children${depth >= 4 ? ' reply-children-flat' : ''}`
    }, ...node.children.map(child => renderReplyNode(child, counts, depth + 1))) : null);
}

function countReplyTree(node) {
  return 1 + node.children.reduce((total, child) => total + countReplyTree(child), 0);
}

function renderReplies() {
  if (!openThread?.replies) return;
  const { replies, counts, container, showAllReplies } = openThread;
  const tree = buildReplyTree(openThread.noteId, replies, replyParentId);
  let visibleCount = 0;
  let hidden = 0;
  const filterTree = nodes => nodes.flatMap(node => {
    if (!showAllReplies && !passesFilter(node.event.pubkey)) {
      hidden += countReplyTree(node);
      return [];
    }
    visibleCount++;
    return [{ ...node, children: filterTree(node.children) }];
  });
  const visible = filterTree(tree);
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
    el('h2', { class: 'replies-heading' }, `Replies (${visibleCount})`),
    ...(hiddenStatus ? [hiddenStatus] : []),
    ...visible.map(node => renderReplyNode(node, counts)));
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

async function loadNoteZaps(note, container, quiet = false) {
  if (!quiet) container.replaceChildren(el('p', { class: 'replies-status busy' }, 'Loading verified zaps…'));
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
    if (container.isConnected && !quiet) container.replaceChildren(el('p', { class: 'replies-status' }, `Could not load zaps: ${err.message}`));
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
  openThread = {
    noteId: note.id, container, showAllReplies: false, replies: [], loading: true,
    renderInteractions: people => interactionDropdown.render(people)
  };
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
    Object.assign(openThread, { replies, counts, loading: false });
    renderReplies();
  } catch (err) {
    if (token !== threadToken) return;
    openThread.loading = false;
    container.replaceChildren(el('p', { class: 'replies-status' }, `Could not load replies: ${err.message}`));
  }
}

function showNote(item, button = null, { updateHistory = true } = {}) {
  routeToken++;
  routeNotice = '';
  if (updateHistory) updatePath(notePath(item.note.id, nip19));
  for (const other of listEl.querySelectorAll('.note-item')) other.removeAttribute('aria-current');
  button?.setAttribute('aria-current', 'true');
  if (button) selectedNoteId = item.note.id;
  shownNoteId = item.note.id;
  profileOpen = null;
  profileToken++;
  if (button) currentItem = item;
  updateNoteNavigation();

  const { note, zaps, repostedBy } = item;
  const clientName = note.tags?.find(tag => tag[0] === 'client')?.[1];
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
    repliesEl,
    clientName ? el('p', { class: 'note-attribution' }, `Note published with ${clientName}`) : null));
  mainEl.parentElement.scrollTop = 0;
  loadNoteZaps(note, zapsEl);
  loadThread(note, repliesEl, interactionDropdown);
  if (openThread?.noteId === note.id) openThread.zapsContainer = zapsEl;
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

function updateNewFeedNotesButton(result = lastResult) {
  const count = result?.pendingNewNotes?.length || 0;
  newFeedNotesButton.hidden = count === 0;
  newFeedNotesButton.textContent = `${count} new ${count === 1 ? 'note' : 'notes'}`;
}

async function insertNewFeedNotes() {
  const result = lastResult;
  if (!result?.pendingNewNotes?.length || result.insertingNewNotes) return;
  result.insertingNewNotes = true;
  newFeedNotesButton.disabled = true;
  const pending = result.pendingNewNotes.splice(0);
  updateNewFeedNotesButton(result);
  try {
    const pubkeys = [...new Set(pending.map(item => item.note.pubkey))];
    const [, counts] = await Promise.all([
      ensureProfiles(pubkeys),
      countRecentZapsSent(pubkeys)
    ]);
    await loadNoteStats(pending.map(item => item.note), getSession()?.pubkey);
    if (result !== lastResult) return;
    for (const item of pending) {
      item.zaps = counts.get(item.note.pubkey) || 0;
      item.hasStats = true;
    }
    result.items.unshift(...pending);
    const scrollTop = listEl.scrollTop;
    applyFilter();
    listEl.scrollTop = scrollTop;
  } catch {
    if (result === lastResult) {
      result.pendingNewNotes = [...pending, ...result.pendingNewNotes]
        .sort((a, b) => b.note.created_at - a.note.created_at)
        .slice(0, MAX_PENDING_FEED_NOTES);
    }
  } finally {
    result.insertingNewNotes = false;
    newFeedNotesButton.disabled = false;
    updateNewFeedNotesButton();
  }
}

newFeedNotesButton.addEventListener('click', insertNewFeedNotes);

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
    const button = selected || listEl.querySelector('.note-item');
    const item = items.find(candidate => candidate.note.id === button.dataset.noteId);
    if (item) showNote(item, button, { updateHistory: false });
  } else {
    shownNoteId = null;
    mainEl.replaceChildren(el('p', { class: 'empty' }, emptyMessage));
  }
  updateNoteNavigation();
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

function visibleMenuItems(result) {
  if (!result || result.loading || document.body.classList.contains('sidebar-hidden')) return [];
  const bounds = listEl.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return [];
  const items = new Map(result.items.map(item => [item.note.id, item]));
  return [...listEl.querySelectorAll('.note-item')]
    .filter(button => {
      const rect = button.getBoundingClientRect();
      return rect.bottom > bounds.top && rect.top < bounds.bottom
        && rect.right > 0 && rect.left < window.innerWidth;
    })
    .map(button => items.get(button.dataset.noteId))
    .filter(Boolean);
}

function renderRefreshedMenuStats(items) {
  const buttons = new Map([...listEl.querySelectorAll('.note-item')]
    .map(button => [button.dataset.noteId, button]));
  for (const item of items) {
    const body = buttons.get(item.note.id)?.querySelector('.note-item-body');
    if (!body) continue;
    const current = body.querySelector('.item-stats');
    const updated = itemStats(item.note.id);
    if (current && updated) current.replaceWith(updated);
    else if (!current && updated) body.append(updated);
  }
}

async function refreshOpenThread() {
  const thread = openThread;
  const note = currentItem?.note;
  if (!thread || thread.loading || thread.refreshing || !note || thread.noteId !== note.id || !thread.container.isConnected) return;
  thread.refreshing = true;
  try {
    let replies = [];
    let people = null;
    await refreshThread(note, getSession()?.pubkey, value => { replies = value; }, value => { people = value; });
    if (thread !== openThread || !thread.container.isConnected) return;
    const oldAuthors = new Set(thread.replies.map(reply => reply.pubkey));
    const addedAuthors = [...new Set(replies.filter(reply => !oldAuthors.has(reply.pubkey)).map(reply => reply.pubkey))];
    const counts = new Map(thread.counts || []);
    if (addedAuthors.length) {
      const freshCounts = await countRecentZapsSent(addedAuthors);
      for (const [pubkey, count] of freshCounts) counts.set(pubkey, count);
    }
    if (thread !== openThread || !thread.container.isConnected) return;
    thread.replies = replies;
    thread.counts = counts;
    if (people) thread.renderInteractions(people);
    renderReplies();
    if (thread.zapsContainer?.isConnected) await loadNoteZaps(note, thread.zapsContainer, true);
  } finally {
    thread.refreshing = false;
  }
}

async function pollLiveUpdates() {
  if (document.visibilityState !== 'visible' || liveRefreshBusy) return;
  const result = lastResult;
  if ((!result || result.loading) && !openThread) return;
  liveRefreshBusy = true;
  const pollStartedAt = now();
  const visible = visibleMenuItems(result);
  const authors = result && !result.loading && !document.body.classList.contains('sidebar-hidden')
    ? [...new Set(result.items.map(item => item.note.pubkey))]
    : [];
  try {
    let events = [];
    let feedPollSucceeded = !authors.length;
    if (authors.length) {
      try {
        events = await pollRecentNotes(authors, lastLivePollAt);
        feedPollSucceeded = true;
      } catch { /* Keep the old cursor so the next poll retries the gap. */ }
    }
    if (visible.length) await refreshNoteStats(visible.map(item => item.note), getSession()?.pubkey);
    if (result === lastResult && result && !result.loading) {
      const knownIds = new Set([...result.items, ...result.pendingNewNotes].map(item => item.note.id));
      const room = MAX_PENDING_FEED_NOTES - result.pendingNewNotes.length;
      const additions = selectNewNotes(events, knownIds, isReply)
        .slice(0, Math.max(0, room))
        .map(note => ({ note }));
      result.pendingNewNotes.unshift(...additions);
      updateNewFeedNotesButton(result);
      if (visible.length) renderRefreshedMenuStats(visible);
      if (authors.length && feedPollSucceeded) lastLivePollAt = pollStartedAt;
    }
    await refreshOpenThread();
  } catch {
    // The next foreground poll retries transient relay failures.
  } finally {
    liveRefreshBusy = false;
  }
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
    + (fallback ? ' Primal is unavailable, so notes are ranked from relays.' : '')
    + (routeNotice ? ` ${routeNotice}` : ''), counting);
  if (!shown.length && !zapCheckComplete && !selectedNoteId) return;
  renderList(shown, isHome
    ? zapCheckComplete ? 'No recent notes from people you follow match this filter.' : 'Checking zap history for more notes…'
    : zapCheckComplete ? 'No trending notes from verified zappers in this feed.' : 'Checking zap history for more notes…');
}

async function loadFeed(feedId, { updateHistory = true, notice = '' } = {}) {
  routeToken++;
  routeNotice = notice;
  lastLivePollAt = now();
  newFeedNotesButton.hidden = true;
  newFeedNotesButton.disabled = false;
  if (updateHistory) updatePath('/');
  const token = ++loadToken;
  const session = getSession();
  const isHome = Boolean(feedId === HOME_FEED.id && session);
  const found = FEEDS.find(f => f.id === feedId && (session || !f.personal));
  const feed = isHome ? HOME_FEED : found || FEEDS.find(f => f.id === DEFAULT_FEED_ID);
  lastResult = null;
  selectedNoteId = null;
  updateNoteNavigation();
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
      pendingNewNotes: [],
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

function notificationStorageKey(pubkey) {
  return `zs-notifications:${pubkey}`;
}

function saveNotificationReadAt() {
  if (!notificationState.pubkey || !Number.isFinite(notificationState.readAt)) return;
  try {
    store.set(notificationStorageKey(notificationState.pubkey), { readAt: notificationState.readAt });
  } catch { /* Keep notifications usable when browser storage is unavailable. */ }
}

function setNotificationAccount(pubkey) {
  if (notificationState.pubkey === pubkey) return;
  if (notificationsDialog.open) notificationsDialog.close();
  notificationToken++;
  const saved = pubkey ? store.get(notificationStorageKey(pubkey), null) : null;
  notificationState = {
    pubkey,
    ownNotes: [],
    items: [],
    readAt: pubkey && Number.isFinite(saved?.readAt) ? saved.readAt : pubkey ? now() : null,
    lastPollAt: null,
    busy: false,
    failed: false
  };
  if (pubkey && !Number.isFinite(saved?.readAt)) saveNotificationReadAt();
  updateNotificationBadge();
}

function updateNotificationBadge() {
  if (!notificationTrigger || !notificationBadge) return;
  const unread = notificationState.items.filter(item => item.created_at > notificationState.readAt).length;
  notificationBadge.textContent = unread > 99 ? '99+' : String(unread);
  notificationBadge.hidden = unread === 0;
  notificationTrigger.classList.toggle('has-unread', unread > 0);
  notificationTrigger.setAttribute('aria-label', unread ? `Activity, ${unread} unread` : 'Activity');
  notificationTrigger.title = unread ? `${unread} unread notifications` : 'Activity notifications';
}

function notificationDescription(item) {
  if (item.type === 'reply') return 'replied to your note';
  if (item.type === 'mention') return 'mentioned you';
  if (item.type === 'like') return 'liked your note';
  if (item.type === 'repost') return 'reposted your note';
  return `zapped ${formatSats(item.zap.sats)} sats`;
}

function notificationIcon(type) {
  const glyphs = { reply: '↩', mention: '@', like: '♥', repost: '↻', zap: '⚡' };
  return el('span', { class: `notification-type-icon ${type}`, 'aria-hidden': 'true' }, glyphs[type] || '•');
}

function renderNotificationList() {
  if (!notificationState.items.length) {
    const message = notificationState.failed
      ? 'Could not load activity. It will retry while ZapSurf is open.'
      : 'No activity in the last 30 days.';
    notificationsListEl.replaceChildren(el('p', { class: 'notifications-empty', role: 'status' }, message));
    return;
  }
  notificationsListEl.replaceChildren(...notificationState.items.map(item => {
    const actor = parseProfile(item.event.pubkey).name;
    const preview = item.type === 'zap'
      ? item.zap.comment
      : ['reply', 'mention'].includes(item.type) ? item.event.content : '';
    return el('button', {
      type: 'button',
      class: 'notification-item',
      role: 'listitem',
      onclick: () => {
        notificationsDialog.close();
        updatePath(notePath(item.targetId, nip19));
        restoreLocation();
      }
    },
    el('span', { class: 'notification-row' },
      notificationIcon(item.type),
      el('span', { class: 'notification-copy' },
        el('span', { class: 'notification-heading' },
          el('span', {}, `${actor} ${notificationDescription(item)}`),
          timeEl(item.created_at)),
        preview ? el('span', { class: 'notification-preview' }, preview) : null)));
  }));
}

function openNotifications() {
  if (!notificationState.pubkey) return;
  notificationState.readAt = now();
  saveNotificationReadAt();
  updateNotificationBadge();
  renderNotificationList();
  notificationsDialog.showModal();
}

async function pollNotifications() {
  if (document.visibilityState !== 'visible') return;
  const pubkey = getSession()?.pubkey;
  if (!pubkey) return;
  if (notificationState.pubkey !== pubkey) setNotificationAccount(pubkey);
  if (notificationState.busy) return;

  notificationState.busy = true;
  const token = notificationToken;
  const pollStartedAt = now();
  const since = notificationSince({ lastPollAt: notificationState.lastPollAt, now: pollStartedAt });
  try {
    const result = await fetchNotificationActivity(pubkey, since, notificationState.ownNotes);
    if (token !== notificationToken || getSession()?.pubkey !== pubkey) return;
    notificationState.ownNotes = result.ownNotes;
    notificationState.items = mergeNotifications(notificationState.items, result.notifications);
    notificationState.lastPollAt = pollStartedAt;
    notificationState.failed = false;
    updateNotificationBadge();
    if (notificationsDialog.open) renderNotificationList();
  } catch {
    if (token !== notificationToken) return;
    notificationState.failed = true;
    if (notificationsDialog.open) renderNotificationList();
  } finally {
    if (token === notificationToken) notificationState.busy = false;
  }
}

function settingsButton() {
  return el('button', { class: 'button ghost small settings-button', type: 'button', onclick: openSettings }, '⚙️ Settings');
}

function renderAccount() {
  const session = getSession();
  accountProfileEl.replaceChildren();
  sidebarProfileIconEl.replaceChildren();
  sidebarProfileIconEl.hidden = !session;
  notificationTrigger = null;
  notificationBadge = null;
  if (!session) {
    accountEl.replaceChildren(
      el('div', { class: 'account-actions signed-out' },
        settingsButton(),
        el('button', { class: 'button small', type: 'button', onclick: openLoginDialog }, 'Log in')));
    return;
  }
  const profile = parseProfile(session.pubkey);
  notificationBadge = el('span', { class: 'notification-badge', hidden: true });
  notificationTrigger = el('button', {
    class: 'button ghost small notification-trigger',
    type: 'button',
    onclick: openNotifications,
    'aria-label': 'Activity'
  },
  el('span', { class: 'button-icon', 'aria-hidden': 'true' }, '🔔'),
  'Activity', notificationBadge);
  accountProfileEl.replaceChildren(
    el('button', { type: 'button', class: 'account-who profile-link', title: 'View your profile', onclick: () => showProfile(session.pubkey) },
      avatar(session.pubkey, 'small'),
      el('div', { class: 'account-info' },
        el('span', { class: 'author-name' }, profile.name),
        el('span', { class: 'account-method' }, LOGIN_METHODS[session.method]))));
  sidebarProfileIconEl.replaceChildren(avatar(session.pubkey, 'small'));
  accountEl.replaceChildren(
    el('div', { class: 'account-actions signed-in' },
      notificationTrigger,
      settingsButton(),
      el('button', { class: 'button ghost small', type: 'button', onclick: logout },
        el('span', { class: 'button-icon', 'aria-hidden': 'true' }, '↪'),
        'Log out')));
  updateNotificationBadge();
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

function showRouteError(message) {
  setStatus(message);
  listEl.replaceChildren();
  mainEl.replaceChildren(
    el('p', { class: 'empty' }, message),
    el('button', { type: 'button', class: 'button', onclick: () => loadFeed(feedSelect.value) }, 'Go to feed'));
}

async function restoreLocation() {
  const token = ++routeToken;
  const route = parseViewPath(location.pathname, nip19);
  routeNotice = '';
  if (route.type === 'home') {
    loadFeed(feedSelect.value, { updateHistory: false });
    return;
  }
  if (route.type === 'invalid') {
    updatePath('/', true);
    loadFeed(feedSelect.value, {
      updateHistory: false,
      notice: 'That link was not recognized; showing your feed.'
    });
    return;
  }
  if (route.type === 'profile') {
    showProfile(route.pubkey, { updateHistory: false });
    return;
  }
  if (route.type === 'profile-activity') {
    showProfileActivity(route.pubkey, { updateHistory: false });
    return;
  }

  listEl.replaceChildren();
  setStatus('Loading note…', true);
  mainEl.replaceChildren(skeletonNote('Loading note from relays…'));
  try {
    const note = await loadNoteEvent(route.id, route.relays);
    if (token !== routeToken) return;
    if (!note) throw new Error('No matching note was found on the available relays.');
    await ensureProfiles([note.pubkey]);
    if (token !== routeToken) return;
    currentItem = { note, zaps: cachedZapCount(note.pubkey) };
    showNote(currentItem, null, { updateHistory: false });
  } catch (err) {
    if (token !== routeToken) return;
    showRouteError(`Could not open this note: ${err.message}`);
  }
}

window.addEventListener('popstate', restoreLocation);

// ---------- Events ----------

document.addEventListener('zs:session', () => {
  const session = getSession();
  setNotificationAccount(session?.pubkey || null);
  renderAccount();
  document.getElementById('new-note').hidden = !canSign();
  const wasPersonal = [HOME_FEED, ...FEEDS].some(f => f.id === feedSelect.value && f.personal);
  const next = session ? HOME_FEED.id : wasPersonal ? DEFAULT_FEED_ID : feedSelect.value;
  renderFeedOptions(next);
  const route = parseViewPath(location.pathname, nip19);
  if (route.type === 'profile') showProfile(route.pubkey, { updateHistory: false });
  else if (route.type === 'profile-activity') showProfileActivity(route.pubkey, { updateHistory: false });
  else if (route.type === 'note') restoreLocation();
  else loadFeed(feedSelect.value);
  loadOwnProfile();
  pollNotifications();
});

document.addEventListener('zs:need-login', openLoginDialog);

document.addEventListener('zs:published', ({ detail: event }) => {
  if (event.kind !== 1) return;
  const parentId = replyParentId(event);
  const isThreadReply = openThread?.replies && (parentId === openThread.noteId
    || openThread.replies.some(reply => reply.id === parentId));
  if (isThreadReply && openThread.counts) {
    if (!openThread.replies.some(reply => reply.id === event.id)) openThread.replies.push(event);
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
document.getElementById('notifications-close').addEventListener('click', () => notificationsDialog.close());

// ---------- Collapsible sidebar controls ----------

const CONTROLS_KEY = 'zs-controls-collapsed';
const controlsToggle = document.getElementById('controls-toggle');
const controlsEl = document.getElementById('sidebar-controls');

function setControlsCollapsed(collapsed) {
  controlsEl.hidden = collapsed;
  controlsEl.parentElement.classList.toggle('collapsed', collapsed);
  controlsToggle.setAttribute('aria-expanded', String(!collapsed));
  const label = collapsed ? 'Show controls' : 'Hide controls';
  controlsToggle.setAttribute('aria-label', label);
  controlsToggle.title = label;
  store.set(CONTROLS_KEY, collapsed);
}

controlsToggle.addEventListener('click', () => setControlsCollapsed(!controlsEl.hidden));
document.getElementById('home-button').addEventListener('click', () => {
  const homeId = getSession() ? HOME_FEED.id : DEFAULT_FEED_ID;
  feedSelect.value = homeId;
  loadFeed(homeId);
});

// ---------- Slide-out sidebar ----------

const SIDEBAR_KEY = 'zs-sidebar-hidden';
const sidebarShow = document.getElementById('sidebar-show');
const sidebarHide = document.getElementById('sidebar-hide');

function updateNoteNavigation() {
  const buttons = [...listEl.querySelectorAll('.note-item')];
  const index = buttons.findIndex(button => button.dataset.noteId === shownNoteId);
  const available = document.body.classList.contains('sidebar-hidden') && !profileOpen && index !== -1;
  noteNavigation.hidden = !available;
  previousNoteButton.disabled = !available || index === 0;
  nextNoteButton.disabled = !available || index === buttons.length - 1;
}

function moveBetweenNotes(direction) {
  const buttons = [...listEl.querySelectorAll('.note-item')];
  const index = buttons.findIndex(button => button.dataset.noteId === shownNoteId);
  const target = buttons[index + direction];
  if (!target) return false;
  target.click();
  return true;
}

previousNoteButton.addEventListener('click', () => moveBetweenNotes(-1));
nextNoteButton.addEventListener('click', () => moveBetweenNotes(1));

document.addEventListener('keydown', event => {
  if (!document.body.classList.contains('sidebar-hidden') || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  if (event.target.closest('input, textarea, select, [contenteditable="true"]') || document.querySelector('dialog[open]')) return;

  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    if (!profileOpen && moveBetweenNotes(event.key === 'ArrowLeft' ? -1 : 1)) event.preventDefault();
    return;
  }
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;

  event.preventDefault();
  const distance = Math.round(window.innerHeight * 0.75) * (event.key === 'ArrowDown' ? 1 : -1);
  if (window.matchMedia('(max-width: 760px)').matches) {
    window.scrollBy({ top: distance, behavior: 'smooth' });
  } else {
    mainEl.parentElement.scrollBy({ top: distance, behavior: 'smooth' });
  }
});

let swipeStart = null;
mainEl.addEventListener('touchstart', event => {
  if (!document.body.classList.contains('sidebar-hidden') || event.touches.length !== 1) {
    swipeStart = null;
    return;
  }
  if (event.target.closest('button, a, input, textarea, select, [contenteditable="true"], .interaction-panel')) {
    swipeStart = null;
    return;
  }
  swipeStart = { x: event.touches[0].clientX, y: event.touches[0].clientY };
}, { passive: true });

mainEl.addEventListener('touchend', event => {
  if (!swipeStart || event.changedTouches.length !== 1) return;
  const deltaX = event.changedTouches[0].clientX - swipeStart.x;
  const deltaY = event.changedTouches[0].clientY - swipeStart.y;
  swipeStart = null;
  if (Math.abs(deltaX) < 55 || Math.abs(deltaX) < Math.abs(deltaY) * 1.4) return;
  moveBetweenNotes(deltaX < 0 ? 1 : -1);
}, { passive: true });

function setSidebarHidden(hidden, { focus = false } = {}) {
  document.body.classList.toggle('sidebar-hidden', hidden);
  document.getElementById('sidebar').inert = hidden;
  sidebarShow.hidden = !hidden;
  updateNoteNavigation();
  store.set(SIDEBAR_KEY, hidden);
  if (focus) (hidden ? sidebarShow : sidebarHide).focus();
}

sidebarHide.addEventListener('click', () => setSidebarHidden(true, { focus: true }));
sidebarShow.addEventListener('click', () => setSidebarHidden(false, { focus: true }));

updateThresholdLabels();
renderAccount();
document.getElementById('new-note').hidden = !canSign();
renderFeedOptions(getSession() ? HOME_FEED.id : DEFAULT_FEED_ID);
restoreLocation();
setInterval(pollLiveUpdates, LIVE_REFRESH_MS);
setInterval(pollNotifications, LIVE_REFRESH_MS);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    pollLiveUpdates();
    pollNotifications();
  }
});
setControlsCollapsed(store.get(CONTROLS_KEY) === true);
document.body.classList.add('no-anim');
setSidebarHidden(store.get(SIDEBAR_KEY) === true);
requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove('no-anim')));
loadOwnProfile();
pollNotifications();
