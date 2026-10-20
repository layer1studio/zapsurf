import { statsFor, actionsFor, settings } from './state.js';
import { getSession, canSign } from './signer.js';
import { likeNote, repostNote } from './publish.js';
import { zapNote, openZapDialog } from './zaps.js';
import { openComposer } from './compose.js';
import { el, emit, formatSats } from './util.js';
import { toast } from './dialogs.js';

const LONG_PRESS_MS = 500;
const liveBars = new Set();

document.addEventListener('zs:stats', event => {
  for (const bar of liveBars) {
    if (!bar.el.isConnected) liveBars.delete(bar);
    else if (bar.noteId === event.detail) bar.render();
  }
});

export function requireSigner() {
  if (!getSession()) {
    emit('zs:need-login');
    return false;
  }
  if (!canSign()) {
    toast('You are logged in read-only. Log in with a signer to post or zap.', 'error');
    return false;
  }
  return true;
}

function actionButton({ icon, label, count, active, onclick }) {
  return el('button', {
    type: 'button',
    class: `action${active ? ' active' : ''}`,
    'aria-label': label,
    'aria-pressed': String(Boolean(active)),
    title: label,
    onclick
  }, el('span', { 'aria-hidden': 'true' }, icon), count ? el('span', { class: 'action-count' }, count) : null);
}

async function runAction(button, task, success) {
  button.disabled = true;
  try {
    await task();
    if (success) toast(success);
  } catch (err) {
    if (err?.message !== 'Unlock cancelled') toast(err.message || String(err), 'error');
  } finally {
    button.disabled = false;
  }
}

function zapButton(note, rerender) {
  const stats = statsFor(note.id);
  const button = actionButton({
    icon: '⚡',
    label: settings.defaultZap ? `Zap ${settings.defaultZap} sats (hold for more options)` : 'Zap',
    count: stats.satszapped ? formatSats(stats.satszapped) : '',
    active: actionsFor(note.id).zapped
  });
  let pressTimer = null;
  let longPressed = false;

  const openDialog = () => {
    if (requireSigner()) openZapDialog(note);
  };
  button.addEventListener('pointerdown', () => {
    longPressed = false;
    pressTimer = setTimeout(() => { longPressed = true; openDialog(); }, LONG_PRESS_MS);
  });
  for (const type of ['pointerup', 'pointerleave', 'pointercancel']) {
    button.addEventListener(type, () => clearTimeout(pressTimer));
  }
  button.addEventListener('contextmenu', event => {
    event.preventDefault();
    clearTimeout(pressTimer);
    if (!longPressed) openDialog();
    longPressed = true;
  });
  button.addEventListener('click', () => {
    if (longPressed) return;
    if (!requireSigner()) return;
    const sats = settings.defaultZap;
    if (!sats) {
      openZapDialog(note);
      return;
    }
    runAction(button, async () => {
      toast(`Zapping ${formatSats(sats)} sats…`);
      const { paid, invoice } = await zapNote(note, sats);
      if (paid) {
        toast(`Zapped ${formatSats(sats)} sats ⚡`);
        rerender();
      } else {
        openZapDialog(note, sats, invoice);
      }
    });
  });
  return button;
}

export function actionBar(note, { onReply } = {}) {
  const bar = el('div', { class: 'action-bar' });
  const render = () => {
    const stats = statsFor(note.id);
    const actions = actionsFor(note.id);
    bar.replaceChildren(
      actionButton({
        icon: '💬', label: 'Reply', count: stats.replies || '', active: actions.replied,
        onclick: () => { if (requireSigner()) (onReply ? onReply() : openComposer({ replyTo: note })); }
      }),
      actionButton({
        icon: '🔁', label: 'Repost', count: stats.reposts || '', active: actions.reposted,
        onclick: event => {
          if (!requireSigner() || actions.reposted) return;
          runAction(event.currentTarget, () => repostNote(note).then(render), 'Reposted');
        }
      }),
      actionButton({
        icon: '❝', label: 'Quote',
        onclick: () => { if (requireSigner()) openComposer({ quote: note }); }
      }),
      actionButton({
        icon: actions.liked ? '❤️' : '🤍', label: 'Like', count: stats.likes || '', active: actions.liked,
        onclick: event => {
          if (!requireSigner() || actions.liked) return;
          runAction(event.currentTarget, () => likeNote(note).then(render));
        }
      }),
      zapButton(note, render));
  };
  render();
  liveBars.add({ el: bar, noteId: note.id, render });
  return bar;
}
