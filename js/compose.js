import { nip05, nip19 } from './deps.js';
import { postNote } from './publish.js';
import { renderContent, quotePreview } from './render.js';
import { ensureProfile, parseProfile, profiles } from './state.js';
import { ensureProfiles, getFollows } from './notes.js';
import { getSession } from './signer.js';
import { rebaseMentions, serializeMentions } from './compose-text.mjs';
import { el } from './util.js';
import { toast, setBusy } from './dialogs.js';

const MAX_LENGTH = 8000;
const dialog = document.getElementById('compose-dialog');
const form = document.getElementById('compose-form');
const textarea = document.getElementById('compose-text');
const statusEl = document.getElementById('compose-status');
const contextEl = document.getElementById('compose-context');
let mode = {};

const EMOJI = [
  '😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣',
  '🥲', '🥹', '☺️', '😊', '😇', '🙂', '🙃', '😉',
  '😍', '🥰', '😘', '😗', '😙', '😚', '😋', '😛',
  '😜', '🤪', '😝', '🤑', '🤗', '🤭', '🫢', '🫣',
  '🤫', '🤔', '🫡', '🤐', '🤨', '😐', '😑', '😶',
  '🫥', '😏', '😒', '🙄', '😬', '😮‍💨', '🤥', '🫨',
  '😌', '😔', '😪', '🤤', '😴', '🥱', '😷', '🤒',
  '🤕', '🤢', '🤮', '🤧', '🥵', '🥶', '🥴', '😵',
  '😵‍💫', '🤯', '🤠', '🥳', '🥸', '😎', '🤓', '🧐',
  '😕', '🫤', '😟', '🙁', '☹️', '😮', '😯', '😲',
  '😳', '🥺', '🥹', '😦', '😧', '😨', '😰', '😥',
  '😢', '😭', '😱', '😖', '😣', '😞', '😓', '😩',
  '😫', '🥱', '😤', '😡', '😠', '🤬', '😈', '👿',
  '💀', '💩', '🤡', '👻', '💯', '💢', '💥', '💫',
  '💦', '💨', '🕳️', '💤', '👋', '🤚', '🖐️', '✋',
  '🖖', '🫱', '🫲', '🫳', '🫴', '👌', '🤌', '🤏',
  '✌️', '🤞', '🫰', '🤟', '🤘', '🤙', '👈', '👉',
  '👆', '👇', '☝️', '🫵', '👍', '👎', '✊', '👊',
  '🤛', '🤜', '👏', '🙌', '👐', '🤲', '🙏', '💪',
  '🫶', '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤',
  '🤍', '🤎', '💔', '❤️‍🔥', '💕', '💞', '💓', '💗',
  '💖', '💘', '💝', '💟', '✨', '⭐', '🌟', '🔥',
  '⚡', '☀️', '🌈', '🎉', '🎊', '🥂', '🍻', '💐'
];
const EMOJI_NAMES = new Map([
  ['😀', 'grinning face smile happy'], ['😃', 'smiling face open mouth happy'], ['😄', 'smiling face smiling eyes happy'], ['😁', 'beaming face grin'],
  ['😆', 'laughing squint'], ['😅', 'smile sweat nervous'], ['😂', 'joy laugh tears'], ['🤣', 'rolling floor laugh rofl'],
  ['🥲', 'smile tear grateful sad'], ['🥹', 'holding back tears touched'], ['☺️', 'smiling face blush'], ['😊', 'smiling eyes blush'],
  ['😇', 'angel halo innocent'], ['🙂', 'slight smile happy'], ['🙃', 'upside down silly'], ['😉', 'wink playful'],
  ['😍', 'heart eyes love'], ['🥰', 'smiling hearts love'], ['😘', 'kiss love'], ['😗', 'kissing face'],
  ['😙', 'kissing smile'], ['😚', 'kissing closed eyes'], ['😋', 'yum delicious tongue'], ['😛', 'tongue playful'],
  ['😜', 'wink tongue silly'], ['🤪', 'zany crazy goofy'], ['😝', 'squint tongue silly'], ['🤑', 'money rich'],
  ['🤗', 'hug hands'], ['🤭', 'hand over mouth giggle'], ['🫢', 'open eyes mouth surprise'], ['🫣', 'peeking eye shy'],
  ['🤫', 'shush quiet secret'], ['🤔', 'thinking face wonder'], ['🫡', 'salute respect'], ['🤐', 'zipper mouth secret'],
  ['🤨', 'raised eyebrow skeptical'], ['😐', 'neutral face'], ['😑', 'expressionless blank'], ['😶', 'no mouth speechless'],
  ['🫥', 'dotted line invisible hidden'], ['😏', 'smirk sly'], ['😒', 'unamused annoyed'], ['🙄', 'eye roll'],
  ['😬', 'grimace awkward'], ['😮‍💨', 'sigh relief tired'], ['🤥', 'lying pinocchio'], ['🫨', 'shaking shock'],
  ['😌', 'relieved calm'], ['😔', 'pensive sad'], ['😪', 'sleepy tear'], ['🤤', 'drooling'],
  ['😴', 'sleep zzz tired'], ['🥱', 'yawn tired bored'], ['😷', 'mask sick'], ['🤒', 'thermometer fever sick'],
  ['🤕', 'bandage hurt injured'], ['🤢', 'nauseated sick green'], ['🤮', 'vomit sick'], ['🤧', 'sneeze sick'],
  ['🥵', 'hot overheated'], ['🥶', 'cold freezing'], ['🥴', 'woozy drunk dizzy'], ['😵', 'dizzy dead'],
  ['😵‍💫', 'spiral eyes dizzy'], ['🤯', 'exploding head mind blown'], ['🤠', 'cowboy hat'], ['🥳', 'party celebration'],
  ['🥸', 'disguise glasses'], ['😎', 'sunglasses cool'], ['🤓', 'nerd glasses'], ['🧐', 'monocle curious'],
  ['😕', 'confused'], ['🫤', 'diagonal mouth unsure'], ['😟', 'worried'], ['🙁', 'slightly frowning sad'],
  ['☹️', 'frowning sad'], ['😮', 'open mouth surprised'], ['😯', 'hushed surprised'], ['😲', 'astonished shocked'],
  ['😳', 'flushed embarrassed'], ['🥺', 'pleading please puppy eyes'], ['😦', 'frowning open mouth'], ['😧', 'anguished'],
  ['😨', 'fearful scared'], ['😰', 'anxious sweat nervous'], ['😥', 'sad relieved sweat'], ['😢', 'cry tear sad'],
  ['😭', 'loudly crying sob'], ['😱', 'scream fear shocked'], ['😖', 'confounded'], ['😣', 'persevering'],
  ['😞', 'disappointed sad'], ['😓', 'downcast sweat'], ['😩', 'weary tired'], ['😫', 'tired exhausted'],
  ['😤', 'steam nose angry triumph'], ['😡', 'pouting angry mad'], ['😠', 'angry mad'], ['🤬', 'swearing cursing angry'],
  ['😈', 'smiling devil imp'], ['👿', 'angry devil imp'], ['💀', 'skull death dead'], ['💩', 'poop poo'],
  ['🤡', 'clown'], ['👻', 'ghost spooky'], ['💯', 'hundred points perfect'], ['💢', 'anger symbol'],
  ['💥', 'collision boom explosion'], ['💫', 'dizzy star'], ['💦', 'sweat drops water'], ['💨', 'dash wind'],
  ['🕳️', 'hole'], ['💤', 'sleep zzz tired'], ['👋', 'waving hand hello goodbye'], ['🤚', 'raised back hand stop'],
  ['🖐️', 'hand fingers'], ['✋', 'raised hand stop high five'], ['🖖', 'vulcan salute star trek'], ['🫱', 'rightwards hand'],
  ['🫲', 'leftwards hand'], ['🫳', 'palm down hand'], ['🫴', 'palm up hand'], ['👌', 'ok hand perfect'],
  ['🤌', 'pinched fingers'], ['🤏', 'pinching hand small'], ['✌️', 'victory peace fingers'], ['🤞', 'crossed fingers luck'],
  ['🫰', 'finger heart love'], ['🤟', 'love you hand'], ['🤘', 'rock horns'], ['🤙', 'call me hand'],
  ['👈', 'point left finger'], ['👉', 'point right finger'], ['👆', 'point up finger'], ['👇', 'point down finger'],
  ['☝️', 'index finger up'], ['🫵', 'point at you'], ['👍', 'thumbs up like yes'], ['👎', 'thumbs down dislike no'],
  ['✊', 'raised fist power'], ['👊', 'fist bump punch'], ['🤛', 'left fist'], ['🤜', 'right fist'],
  ['👏', 'clap applause'], ['🙌', 'raised hands celebrate hooray'], ['👐', 'open hands'], ['🤲', 'palms up hands prayer'],
  ['🙏', 'folded hands prayer please thanks'], ['💪', 'flexed biceps muscle strong'], ['🫶', 'heart hands love'],
  ['❤️', 'red heart love'], ['🧡', 'orange heart love'], ['💛', 'yellow heart love'], ['💚', 'green heart love'],
  ['💙', 'blue heart love'], ['💜', 'purple heart love'], ['🖤', 'black heart love'], ['🤍', 'white heart love'],
  ['🤎', 'brown heart love'], ['💔', 'broken heart heartbreak'], ['❤️‍🔥', 'heart on fire passion'], ['💕', 'two hearts love'],
  ['💞', 'revolving hearts love'], ['💓', 'beating heart love'], ['💗', 'growing heart love'], ['💖', 'sparkling heart love'],
  ['💘', 'heart arrow cupid love'], ['💝', 'heart ribbon gift love'], ['💟', 'heart decoration love'], ['✨', 'sparkles shiny magic'],
  ['⭐', 'star'], ['🌟', 'glowing star'], ['🔥', 'fire flame hot lit'], ['⚡', 'lightning bolt electric zap'],
  ['☀️', 'sun sunny'], ['🌈', 'rainbow'], ['🎉', 'party popper celebration'], ['🎊', 'confetti ball celebration'],
  ['🥂', 'clinking glasses cheers celebration'], ['🍻', 'beer mugs cheers'], ['💐', 'bouquet flowers']
]);
const NOSTR_REF = /(?:npub|nprofile)1[02-9ac-hj-np-z]{20,}/gi;
const followedProfiles = new Map();
const followedProfileLoads = new Map();

function profileData(pubkey) {
  try {
    return JSON.parse(profiles.get(pubkey)?.content || '{}') || {};
  } catch {
    return {};
  }
}

function usernameFor(pubkey) {
  const data = profileData(pubkey);
  const name = [data.display_name, data.name].find(value => typeof value === 'string' && value.trim());
  if (name) return name.trim();
  return typeof data.nip05 === 'string' ? data.nip05.split('@')[0] : '';
}

function loadFollowedProfiles() {
  const pubkey = getSession()?.pubkey;
  if (!pubkey || followedProfileLoads.has(pubkey)) return followedProfileLoads.get(pubkey) || Promise.resolve();
  const load = getFollows(pubkey).then(async follows => {
    const keys = [...follows];
    await ensureProfiles(keys);
    for (const key of keys) followedProfiles.set(key, true);
  }).catch(() => {});
  followedProfileLoads.set(pubkey, load);
  return load;
}

function editorContent(input, mentions) {
  return serializeMentions(input.value, mentions, pubkey => nip19.npubEncode(pubkey));
}

export function createEmojiPicker(input, insertEmoji) {
  const emojiButton = el('button', {
    type: 'button', class: 'icon-button emoji-toggle', 'aria-label': 'Insert emoji', title: 'Insert emoji', 'aria-expanded': 'false'
  }, '☺');
  const search = el('input', {
    type: 'search', class: 'emoji-search', placeholder: 'Search emoji', 'aria-label': 'Search emoji', autocomplete: 'off'
  });
  const empty = el('span', { class: 'emoji-empty', role: 'status', hidden: true }, 'No matching emoji.');
  const choices = EMOJI.map(emoji => el('button', {
    type: 'button', class: 'emoji-choice', 'aria-label': `Insert ${EMOJI_NAMES.get(emoji) || emoji}`,
    'data-search': `${emoji} ${EMOJI_NAMES.get(emoji) || ''}`.toLocaleLowerCase()
  }, emoji));
  const emojiPicker = el('div', { class: 'emoji-picker', role: 'group', 'aria-label': 'Emoji picker', 'aria-hidden': 'true' }, search, empty, ...choices);
  emojiPicker.inert = true;
  const toolbar = el('div', { class: 'compose-tools' }, emojiButton, emojiPicker);

  const setOpen = open => {
    emojiPicker.classList.toggle('is-open', open);
    emojiPicker.inert = !open;
    emojiPicker.setAttribute('aria-hidden', String(!open));
    emojiButton.setAttribute('aria-expanded', String(open));
  };
  const filterChoices = () => {
    const query = search.value.trim().toLocaleLowerCase();
    let matches = 0;
    for (const choice of choices) {
      choice.hidden = !choice.dataset.search.includes(query);
      if (!choice.hidden) matches++;
    }
    empty.hidden = matches > 0;
  };

  emojiButton.addEventListener('click', () => setOpen(!emojiPicker.classList.contains('is-open')));
  search.addEventListener('input', filterChoices);
  emojiPicker.addEventListener('mousedown', event => {
    if (event.target.closest('.emoji-choice')) event.preventDefault();
  });
  emojiPicker.addEventListener('click', event => {
    const choice = event.target.closest('.emoji-choice');
    if (!choice) return;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    if (insertEmoji(choice.textContent, start, end) === false) return;
    close();
  });

  function close() {
    setOpen(false);
    search.value = '';
    filterChoices();
  }

  return { toolbar, close };
}

function createEditorTools(input) {
  const state = { mentions: [], lastValue: input.value, queryId: 0, suggestionIndex: 0, nip05Timer: null };
  const emojiTools = createEmojiPicker(input, (emoji, start, end) => applyEdit(start, end, emoji));
  const suggestions = el('div', { class: 'mention-suggestions', role: 'listbox', 'aria-label': 'People suggestions', hidden: true });
  const preview = el('section', { class: 'draft-preview', hidden: true },
    el('h3', {}, 'Preview'),
    el('div', { class: 'draft-preview-content' }));
  input.after(emojiTools.toolbar, suggestions, preview);
  input.setAttribute('aria-autocomplete', 'list');

  const refreshPreview = () => {
    const content = editorContent(input, state.mentions);
    preview.hidden = !content.trim();
    preview.lastElementChild.replaceChildren(...(content.trim()
      ? [renderContent(content, 'note-content', { linkPreviews: true })]
      : []));
  };

  function applyEdit(start, end, replacement, addedMention = null, cursor = start + replacement.length) {
    const previous = input.value;
    const next = `${previous.slice(0, start)}${replacement}${previous.slice(end)}`;
    if (next.length > MAX_LENGTH) return false;
    state.mentions = rebaseMentions(previous, next, state.mentions);
    input.value = next;
    state.lastValue = next;
    if (addedMention) state.mentions.push({ ...addedMention, start, end: start + replacement.length });
    input.focus();
    input.setSelectionRange(cursor, cursor);
    refreshPreview();
    updateSuggestions();
    return true;
  }

  function queryAtCursor() {
    const before = input.value.slice(0, input.selectionStart);
    const match = before.match(/(?:^|\s)@([^\s]*)$/u);
    if (!match) return null;
    const at = match.index + match[0].lastIndexOf('@');
    return { start: at, end: input.selectionStart, query: match[1] };
  }

  function candidateProfiles(query) {
    const keys = new Set([...profiles.keys(), ...followedProfiles.keys()]);
    const normalised = query.toLocaleLowerCase();
    return [...keys].map(pubkey => {
      const data = profileData(pubkey);
      const profile = parseProfile(pubkey);
      return { pubkey, name: usernameFor(pubkey) || profile.name, nip05: typeof data.nip05 === 'string' ? data.nip05 : '' };
    }).filter(person => {
      if (!normalised) return true;
      return [person.name, person.nip05, parseProfile(person.pubkey).npub]
        .some(value => value.toLocaleLowerCase().includes(normalised));
    }).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 8);
  }

  function selectProfile(pubkey, queryRange, fallbackName = '') {
    const name = usernameFor(pubkey) || fallbackName || parseProfile(pubkey).name;
    const label = `@${name}`;
    applyEdit(queryRange.start, queryRange.end, `${label} `, { text: label, pubkey });
    suggestions.hidden = true;
  }

  function renderSuggestions(query, range, extraPubkey = null) {
    const people = candidateProfiles(query);
    if (extraPubkey && !people.some(person => person.pubkey === extraPubkey)) {
      const data = profileData(extraPubkey);
      const nip05Address = typeof data.nip05 === 'string' ? data.nip05 : '';
      people.unshift({ pubkey: extraPubkey, name: usernameFor(extraPubkey) || nip05Address.split('@')[0] || parseProfile(extraPubkey).name, nip05: nip05Address });
    }
    state.suggestionIndex = Math.min(state.suggestionIndex, Math.max(0, people.length - 1));
    suggestions.replaceChildren(...(people.length
      ? people.map((person, index) => el('button', {
        type: 'button', class: 'mention-option', role: 'option', 'aria-selected': String(index === state.suggestionIndex),
        onmousedown: event => event.preventDefault(),
        onclick: () => selectProfile(person.pubkey, range, person.name)
      }, el('span', {}, `@${person.name}`), person.nip05 ? el('small', {}, person.nip05) : null))
      : [el('span', { class: 'mention-empty' }, 'No matching profiles.')]));
    suggestions.hidden = !range;
  }

  function updateSuggestions() {
    const queryRange = queryAtCursor();
    const queryId = ++state.queryId;
    clearTimeout(state.nip05Timer);
    if (!queryRange) {
      suggestions.hidden = true;
      return;
    }
    renderSuggestions(queryRange.query, queryRange);
    loadFollowedProfiles().then(() => {
      if (queryId === state.queryId) renderSuggestions(queryRange.query, queryRange);
    });
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(queryRange.query)) {
      state.nip05Timer = setTimeout(async () => {
        try {
          const result = await nip05.queryProfile(queryRange.query);
          if (queryId !== state.queryId || !/^[0-9a-f]{64}$/i.test(result?.pubkey || '')) return;
          await ensureProfile(result.pubkey);
          if (queryId === state.queryId) renderSuggestions(queryRange.query, queryRange, result.pubkey);
        } catch { /* unresolved NIP-05 identifiers simply produce no extra result */ }
      }, 250);
    }
  }

  async function replaceNpubs() {
    const source = input.value;
    const references = [...source.matchAll(NOSTR_REF)];
    if (!references.length) return;
    const resolved = await Promise.all(references.map(async match => {
      try {
        const decoded = nip19.decode(match[0]);
        const pubkey = decoded.type === 'npub' ? decoded.data : decoded.type === 'nprofile' ? decoded.data.pubkey : null;
        if (!pubkey) return null;
        await ensureProfile(pubkey);
        const name = usernameFor(pubkey);
        return name ? { start: match.index, end: match.index + match[0].length, pubkey, label: `@${name}` } : null;
      } catch { return null; }
    }));
    if (input.value !== source) return;
    for (const mention of resolved.filter(Boolean).sort((a, b) => b.start - a.start)) {
      const next = `${mention.label}${/[\p{L}\p{N}_]/u.test(input.value[mention.end] || '') ? ' ' : ''}`;
      applyEdit(mention.start, mention.end, next, { text: mention.label, pubkey: mention.pubkey });
    }
  }

  input.addEventListener('input', () => {
    state.mentions = rebaseMentions(state.lastValue, input.value, state.mentions);
    state.lastValue = input.value;
    refreshPreview();
    updateSuggestions();
    replaceNpubs();
  });
  input.addEventListener('click', updateSuggestions);
  input.addEventListener('keyup', event => {
    if (['ArrowUp', 'ArrowDown', 'Enter', 'Escape'].includes(event.key)) return;
    updateSuggestions();
  });
  input.addEventListener('keydown', event => {
    if (suggestions.hidden) return;
    const options = [...suggestions.querySelectorAll('.mention-option')];
    if (event.key === 'ArrowDown' && options.length) {
      event.preventDefault();
      state.suggestionIndex = (state.suggestionIndex + 1) % options.length;
      options.forEach((option, index) => option.setAttribute('aria-selected', String(index === state.suggestionIndex)));
    } else if (event.key === 'ArrowUp' && options.length) {
      event.preventDefault();
      state.suggestionIndex = (state.suggestionIndex - 1 + options.length) % options.length;
      options.forEach((option, index) => option.setAttribute('aria-selected', String(index === state.suggestionIndex)));
    } else if (event.key === 'Enter' && options.length) {
      event.preventDefault();
      options[state.suggestionIndex].click();
    } else if (event.key === 'Escape') {
      suggestions.hidden = true;
    }
  });
  input.addEventListener('blur', () => setTimeout(() => { suggestions.hidden = true; }, 120));
  refreshPreview();

  return {
    serialize: () => editorContent(input, state.mentions),
    reset: () => {
      state.mentions = [];
      state.lastValue = '';
      state.queryId++;
      input.value = '';
      emojiTools.close();
      suggestions.hidden = true;
      refreshPreview();
    }
  };
}

textarea.maxLength = MAX_LENGTH;
const composerEditor = createEditorTools(textarea);

export function openComposer({ replyTo = null, quote = null } = {}) {
  mode = { replyTo, quote };
  const target = replyTo || quote;
  document.getElementById('compose-title').textContent = replyTo
    ? `Reply to ${parseProfile(replyTo.pubkey).name}`
    : quote ? 'Quote note' : 'New note';
  contextEl.replaceChildren(...(target ? [quotePreview(target)] : []));
  composerEditor.reset();
  statusEl.textContent = '';
  dialog.showModal();
  textarea.focus();
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  setBusy(dialog, true);
  statusEl.textContent = 'Publishing…';
  let relayResult = { accepted: 0, settled: 0, total: 0 };
  try {
    await postNote(composerEditor.serialize(), {
      ...mode,
      onProgress: result => {
        relayResult = result;
        statusEl.textContent = `Publishing… ${result.accepted}/${result.total} relays accepted`;
      }
    });
    statusEl.textContent = `Posted to ${relayResult.accepted}/${relayResult.total} relays.`;
    await new Promise(resolve => setTimeout(resolve, 900));
    toast(`${mode.replyTo ? 'Reply' : 'Note'} posted to ${relayResult.accepted}/${relayResult.total} relays`);
    dialog.close();
  } catch (err) {
    statusEl.textContent = `${relayResult.accepted}/${relayResult.total} relays accepted. ${err.message || String(err)}`;
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
  const status = el('span', { class: 'form-status', role: 'status' });
  const box = el('form', { class: 'inline-reply' },
    input,
    el('div', { class: 'compose-footer' }, status, el('button', { class: 'button', type: 'submit' }, 'Reply')));
  const editor = createEditorTools(input);
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) box.requestSubmit();
  });
  box.addEventListener('submit', async event => {
    event.preventDefault();
    setBusy(box, true);
    status.textContent = 'Publishing…';
    let relayResult = { accepted: 0, settled: 0, total: 0 };
    try {
      await postNote(editor.serialize(), {
        replyTo: note,
        onProgress: result => {
          relayResult = result;
          status.textContent = `Publishing… ${result.accepted}/${result.total} relays accepted`;
        }
      });
      editor.reset();
      status.textContent = `Posted to ${relayResult.accepted}/${relayResult.total} relays.`;
      toast(`Reply posted to ${relayResult.accepted}/${relayResult.total} relays`);
    } catch (err) {
      status.textContent = `${relayResult.accepted}/${relayResult.total} relays accepted. ${err.message || String(err)}`;
    } finally {
      setBusy(box, false);
    }
  });
  return box;
}
