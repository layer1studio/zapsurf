import { postNote } from './publish.js';
import { quotePreview } from './render.js';
import { parseProfile } from './state.js';
import { el } from './util.js';
import { toast, setBusy } from './dialogs.js';

const MAX_LENGTH = 8000;
const dialog = document.getElementById('compose-dialog');
const form = document.getElementById('compose-form');
const textarea = document.getElementById('compose-text');
const countEl = document.getElementById('compose-count');
const statusEl = document.getElementById('compose-status');
const contextEl = document.getElementById('compose-context');
let mode = {};

function updateCount(input, counter) {
  counter.textContent = `${input.value.length} / ${MAX_LENGTH}`;
}

textarea.maxLength = MAX_LENGTH;
textarea.addEventListener('input', () => updateCount(textarea, countEl));

export function openComposer({ replyTo = null, quote = null } = {}) {
  mode = { replyTo, quote };
  const target = replyTo || quote;
  document.getElementById('compose-title').textContent = replyTo
    ? `Reply to ${parseProfile(replyTo.pubkey).name}`
    : quote ? 'Quote note' : 'New note';
  contextEl.replaceChildren(...(target ? [quotePreview(target)] : []));
  textarea.value = '';
  statusEl.textContent = '';
  updateCount(textarea, countEl);
  dialog.showModal();
  textarea.focus();
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  setBusy(dialog, true);
  statusEl.textContent = 'Publishing…';
  try {
    await postNote(textarea.value, mode);
    toast(mode.replyTo ? 'Reply posted' : 'Note posted');
    dialog.close();
  } catch (err) {
    statusEl.textContent = err.message || String(err);
  } finally {
    setBusy(dialog, false);
  }
});

textarea.addEventListener('keydown', event => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) form.requestSubmit();
});

document.getElementById('compose-close').addEventListener('click', () => dialog.close());

export function inlineReplyBox(note) {
  const input = el('textarea', { class: 'reply-input', rows: '3', maxlength: String(MAX_LENGTH), placeholder: `Reply to ${parseProfile(note.pubkey).name}…`, 'aria-label': 'Reply' });
  const counter = el('span', { class: 'char-count' }, `0 / ${MAX_LENGTH}`);
  const status = el('span', { class: 'form-status', role: 'status' });
  const box = el('form', { class: 'inline-reply' },
    input,
    el('div', { class: 'compose-footer' }, counter, status, el('button', { class: 'button', type: 'submit' }, 'Reply')));
  input.addEventListener('input', () => updateCount(input, counter));
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) box.requestSubmit();
  });
  box.addEventListener('submit', async event => {
    event.preventDefault();
    setBusy(box, true);
    status.textContent = 'Publishing…';
    try {
      await postNote(input.value, { replyTo: note });
      input.value = '';
      updateCount(input, counter);
      status.textContent = '';
      toast('Reply posted');
    } catch (err) {
      status.textContent = err.message || String(err);
    } finally {
      setBusy(box, false);
    }
  });
  return box;
}
