import { createElement, Mail, Send, X, Settings2, ArrowLeft, RefreshCw } from 'https://esm.sh/lucide@0.468.0?exports=createElement,Mail,Send,X,Settings2,ArrowLeft,RefreshCw';
import { SimplePool, nip19, nip44, getEventHash, generateSecretKey, finalizeEvent, verifyEvent } from './deps.js';
import { PROFILE_RELAYS, parseProfile } from './state.js';
import { getSession, canSign, signEvent, encryptMessage, decryptMessage, encryptLegacyMessage, decryptLegacyMessage, prepareMessageSigner } from './signer.js';
import { getReadRelays, getWriteRelays } from './relays.js';
import { openLoginDialog } from './login.js';
import { el, HEX64, now } from './util.js';
import { createMessageService } from './message-service.mjs';
import { DM_MAX_TEXT_BYTES, DM_OVERLAP_SECONDS } from './messages.mjs';

const icon = definition => createElement(definition, { width: 18, height: 18, 'aria-hidden': 'true' });
const iconButton = (definition, label, onclick) => el('button', {
  type: 'button', class: 'icon-button', title: label, 'aria-label': label, onclick
}, icon(definition));

let selectedPeer = null;
let busy = false;
let viewToken = 0;
let recipientToken = 0;
let recipientState = { ready: false, reason: '', checking: false };
let signerCapabilities = null;
let started = false;
let state = { messages: [], relays: [], status: '' };
const dialog = el('dialog', { class: 'modal messages-modal', id: 'messages-dialog', 'aria-labelledby': 'messages-title' });
const error = el('p', { class: 'form-error messages-error', role: 'alert' });
const status = el('p', { class: 'form-status messages-status', role: 'status' });
const conversations = el('div', { class: 'message-conversations', role: 'list', 'aria-label': 'Conversations' });
const transcript = el('div', { class: 'message-transcript', role: 'log', 'aria-label': 'Messages', 'aria-live': 'polite' });
const title = el('h3', { class: 'message-peer-title' }, 'Select a conversation');
const recipientInput = el('input', { type: 'text', placeholder: 'npub, nprofile or public key',
  'aria-label': 'Message recipient', autocomplete: 'off', spellcheck: 'false', required: true });
const text = el('textarea', { rows: 3, placeholder: 'Message', 'aria-label': 'Private message', maxlength: DM_MAX_TEXT_BYTES });
const sendButton = el('button', { type: 'submit', class: 'button message-send', title: 'Send private message', 'aria-label': 'Send private message' }, icon(Send));
const sendStatus = el('span', { id: 'message-send-status', role: 'status' });
const setupInbox = el('button', { type: 'button', class: 'link-button', onclick: () => {
  relaySettings.open = true;
  relayInput.focus();
} }, 'Set up inbox');
const composeState = el('div', { class: 'message-compose-state', hidden: true }, sendStatus, setupInbox);
const legacyMode = el('input', { type: 'checkbox', role: 'switch', 'aria-label': 'Use legacy DM (NIP-04)' });
const legacyWarning = el('p', { class: 'message-legacy-warning', hidden: true },
  'Legacy NIP-04 exposes sender, recipient and message timing to relays and observers.');
const protocolControls = el('div', { class: 'message-protocol' },
  el('label', { class: 'message-legacy-toggle' }, legacyMode, 'Use legacy DM (NIP-04)'), legacyWarning);
const olderButton = el('button', { type: 'button', class: 'link-button message-older', onclick: () => run(() => service.loadOlder()) }, 'Load older messages');
const relayInput = el('textarea', { rows: 3, placeholder: 'wss://relay.example',
  'aria-label': 'DM inbox relays, one per line', autocomplete: 'off', spellcheck: 'false' });
const relaySave = el('button', { type: 'submit', class: 'button small' }, 'Save inbox relays');
const relaySettings = el('details', { class: 'message-relay-settings' },
  el('summary', {}, icon(Settings2), 'Inbox relays'),
  el('form', { class: 'stacked-form', onsubmit: event => {
    event.preventDefault();
    run(() => service.saveRelays(relayInput.value.split(/\s+/).filter(Boolean)));
  } }, relayInput, relaySave));
const back = iconButton(ArrowLeft, 'Back to conversations', () => selectPeer(null));
back.classList.add('message-back');

const service = createMessageService({
  pool: new SimplePool(), discoveryRelays: PROFILE_RELAYS, getSession,
  getHistoryRelays: async pubkey => [...new Set((await Promise.all([getReadRelays(pubkey), getWriteRelays(pubkey)])).flat())],
  crypto: {
    now, randomTime: () => Math.max(0, now() - Math.floor(Math.random() * DM_OVERLAP_SECONDS)),
    getEventHash, generateSecretKey, finalizeEvent, verifyEvent,
    signEvent, encrypt: encryptMessage, decrypt: decryptMessage, encryptLegacy: encryptLegacyMessage, decryptLegacy: decryptLegacyMessage,
    encryptWithKey: (key, pubkey, plaintext) => nip44.v2.encrypt(plaintext, nip44.v2.utils.getConversationKey(key, pubkey))
  },
  onChange: next => { state = next; if (dialog.open) render(); }
});

function publicKey(value) {
  const input = value.trim().replace(/^nostr:/, '');
  if (HEX64.test(input)) return input;
  try {
    const decoded = nip19.decode(input);
    if (decoded.type === 'npub') return decoded.data;
    if (decoded.type === 'nprofile') return decoded.data.pubkey;
  } catch { /* invalid recipient */ }
  throw new Error('Enter an npub, nprofile or hex public key.');
}

async function run(task) {
  if (busy) return;
  const token = viewToken;
  busy = true;
  error.textContent = '';
  renderControls();
  try {
    await task();
  } catch (cause) {
    if (token === viewToken) error.textContent = cause?.message || 'Private messaging failed.';
  } finally {
    if (token === viewToken) { busy = false; renderControls(); checkRecipient(); }
  }
}

async function checkRecipient() {
  if (!dialog.open || !selectedPeer || busy || !started) return;
  const token = ++recipientToken;
  const legacy = legacyMode.checked;
  const supported = legacy ? signerCapabilities?.legacy : signerCapabilities?.secure;
  recipientState = { ready: false, reason: '', checking: true };
  renderControls();
  try {
    const result = supported ? await service.checkRecipient(selectedPeer, { legacy })
      : { ready: false, reason: legacy ? 'Your signer does not support legacy NIP-04 encryption.'
        : 'Your signer does not support NIP-44 encryption.' };
    if (token === recipientToken && dialog.open) recipientState = { ...result, checking: false };
  } catch (cause) {
    if (token === recipientToken && dialog.open) recipientState = {
      ready: false, checking: false, reason: cause?.message || 'Could not check this recipient. Refresh the inbox to retry.'
    };
  }
  if (token === recipientToken && dialog.open) renderControls();
}

function renderControls() {
  const blocked = busy ? 'Waiting for the current operation to finish.'
    : !selectedPeer ? 'Select a conversation.'
      : !legacyMode.checked && !state.relays.length ? 'Set up your DM inbox relays before sending.'
        : recipientState.checking ? 'Checking recipient...'
          : !recipientState.ready ? recipientState.reason || 'Checking recipient...'
            : !text.value.trim() ? 'Enter a message.' : '';
  sendButton.disabled = Boolean(blocked);
  sendButton.title = blocked || 'Send private message';
  sendButton.setAttribute('aria-busy', String(busy || recipientState.checking));
  sendButton.setAttribute('aria-describedby', 'message-send-status');
  const needsInbox = Boolean(selectedPeer && !legacyMode.checked && !busy && !state.relays.length);
  setupInbox.hidden = !needsInbox;
  composeState.hidden = !selectedPeer || !blocked || blocked === 'Enter a message.';
  sendStatus.textContent = composeState.hidden ? '' : blocked;
  legacyMode.disabled = busy || !selectedPeer;
  legacyWarning.hidden = !legacyMode.checked;
  text.disabled = busy || !selectedPeer;
  relaySave.disabled = busy;
  relayInput.disabled = busy;
  recipientInput.disabled = busy;
  olderButton.disabled = busy || state.loadingOlder;
  back.disabled = busy;
}

function selectPeer(pubkey) {
  if (busy) return;
  if (pubkey === getSession()?.pubkey) {
    error.textContent = 'Choose another person to message.';
    return;
  }
  selectedPeer = pubkey;
  legacyMode.checked = false;
  recipientToken++;
  recipientState = { ready: false, reason: '', checking: false };
  text.value = '';
  error.textContent = '';
  render();
  checkRecipient();
  if (pubkey) text.focus();
}

function render() {
  status.textContent = state.status;
  dialog.classList.toggle('has-conversation', Boolean(selectedPeer));
  title.textContent = selectedPeer ? parseProfile(selectedPeer).name : 'Select a conversation';
  title.title = selectedPeer ? nip19.npubEncode(selectedPeer) : '';
  const latest = new Map();
  for (const message of [...state.messages].sort((left, right) => left.created_at - right.created_at || left.id.localeCompare(right.id))) {
    latest.set(message.peer, message);
  }
  if (selectedPeer && !latest.has(selectedPeer)) latest.set(selectedPeer, null);
  conversations.replaceChildren(...[...latest].sort((left, right) => (right[1]?.created_at || 0) - (left[1]?.created_at || 0)).map(([peer, message]) =>
    el('button', { type: 'button', class: `message-conversation${selectedPeer === peer ? ' selected' : ''}`,
      'aria-pressed': selectedPeer === peer, onclick: () => selectPeer(peer) },
    el('strong', {}, parseProfile(peer).name),
    el('span', {}, message?.content || 'New conversation'))));
  if (!latest.size) conversations.append(el('p', { class: 'hint message-empty' }, 'No conversations yet.'));
  const nearBottom = transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop < 80;
  const previousPeer = transcript.dataset.peer;
  transcript.dataset.peer = selectedPeer || '';
  const items = state.messages.filter(message => message.peer === selectedPeer)
    .sort((left, right) => left.created_at - right.created_at || left.id.localeCompare(right.id));
  transcript.replaceChildren(...items.map(message => {
    const own = message.pubkey === getSession()?.pubkey;
    const retry = message.retry ? el('button', { type: 'button', class: 'link-button', disabled: busy,
      onclick: () => run(() => service.retry(message.id)) }, 'Retry') : null;
    return el('article', { class: `private-message${own ? ' own' : ''}` },
      el('p', { class: 'private-message-text' }, message.content),
      el('div', { class: 'private-message-meta' },
        message.legacy ? el('span', {}, 'Legacy (NIP-04)') : null,
        el('time', { datetime: new Date(message.created_at * 1000).toISOString() },
          new Date(message.created_at * 1000).toLocaleString()),
        own ? el('span', {}, message.delivery || 'Synced') : null, retry));
  }));
  if (!items.length) transcript.append(el('p', { class: 'hint message-empty' }, selectedPeer ? 'No messages yet.' : 'No conversation selected.'));
  if (nearBottom || previousPeer !== (selectedPeer || '')) transcript.scrollTop = transcript.scrollHeight;
  renderControls();
}

const recipientForm = el('form', { class: 'message-recipient', onsubmit: event => {
  event.preventDefault();
  try { selectPeer(publicKey(recipientInput.value)); } catch (cause) { error.textContent = cause.message; }
} }, recipientInput, el('button', { type: 'submit', class: 'icon-button', title: 'Open conversation', 'aria-label': 'Open conversation' }, icon(Mail)));
const composeForm = el('form', { class: 'message-compose', onsubmit: event => {
  event.preventDefault();
  const token = viewToken;
  const peer = selectedPeer;
  const legacy = legacyMode.checked;
  if (sendButton.disabled || !recipientState.ready) return;
  run(async () => {
    await service.send(peer, text.value, { legacy });
    if (token === viewToken) text.value = '';
  });
} }, text, sendButton);

dialog.append(
  el('div', { class: 'dialog-header' }, el('h2', { id: 'messages-title' }, 'Messages'),
    el('div', { class: 'message-tools' },
      iconButton(RefreshCw, 'Refresh inbox', () => run(() => service.start())),
      iconButton(X, 'Close messages', () => dialog.close()))),
  el('div', { class: 'message-layout' },
    el('section', { class: 'message-inbox', 'aria-label': 'Inbox' }, recipientForm, conversations, olderButton),
    el('section', { class: 'message-chat', 'aria-label': 'Conversation' },
      el('header', { class: 'message-chat-header' }, back, title), transcript, protocolControls, composeState, composeForm)),
  status, error, relaySettings
);
document.body.append(dialog);
function clearMessages() {
  viewToken++;
  busy = false;
  selectedPeer = null;
  recipientToken++;
  recipientState = { ready: false, reason: '', checking: false };
  signerCapabilities = null;
  started = false;
  legacyMode.checked = false;
  service.stop();
  text.value = '';
  recipientInput.value = '';
  relayInput.value = '';
  transcript.replaceChildren();
  conversations.replaceChildren();
  error.textContent = '';
  relaySettings.open = false;
}
dialog.addEventListener('close', clearMessages);
document.addEventListener('zs:session', () => {
  clearMessages();
  if (dialog.open) dialog.close();
});

export function openMessages(pubkey = null) {
  if (!getSession()) { openLoginDialog(); return; }
  if (!canSign()) { openLoginDialog(); return; }
  if (dialog.open) { selectPeer(pubkey); return; }
  viewToken++;
  selectedPeer = pubkey;
  dialog.showModal();
  render();
  const token = viewToken;
  run(async () => {
    signerCapabilities = await prepareMessageSigner();
    if (token !== viewToken) return;
    await service.start();
    if (dialog.open && token === viewToken) {
      started = true;
      relayInput.value = service.snapshot().relays.join('\n');
      relaySettings.open = !service.snapshot().relays.length;
    }
  });
}

export function messageButton(pubkey = null) {
  return iconButton(Mail, pubkey ? 'Send private message' : 'Messages', () => openMessages(pubkey));
}

const messageShortcut = document.getElementById('new-message');
messageShortcut.replaceChildren(icon(Mail), 'Messages');
messageShortcut.addEventListener('click', () => openMessages());
text.addEventListener('input', renderControls);
legacyMode.addEventListener('change', () => {
  error.textContent = '';
  checkRecipient();
});