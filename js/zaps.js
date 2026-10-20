import { nip57 } from './deps.js';
import { getLnurlPay } from './lnurl.js';
import { pool, DEFAULT_RELAYS, ZAP_PRESETS, ensureProfile, statsFor, actionsFor, settings } from './state.js';
import { signEvent, getSession } from './signer.js';
import { getWriteRelays } from './publish.js';
import { payInvoice, walletLabel } from './wallet.js';
import { el, now, formatSats, emit } from './util.js';
import { toast, setBusy } from './dialogs.js';

const BOLT11 = /^ln[a-z0-9]+$/i;

export async function requestZapInvoice(note, sats, comment) {
  const profile = await ensureProfile(note.pubkey);
  const lnurl = await getLnurlPay(profile);
  const msats = sats * 1000;
  if (msats < lnurl.minSendable || msats > lnurl.maxSendable) {
    throw new Error(`${profile.name}'s wallet accepts ${Math.ceil(lnurl.minSendable / 1000)}–${Math.floor(lnurl.maxSendable / 1000)} sats.`);
  }
  const relays = await getWriteRelays(getSession().pubkey);
  const zapRequest = await signEvent(nip57.makeZapRequest({ event: note, amount: msats, comment, relays }));

  const url = new URL(lnurl.callback);
  url.searchParams.set('amount', String(msats));
  url.searchParams.set('nostr', JSON.stringify(zapRequest));
  const data = await fetchJson(url.href);
  if (!BOLT11.test(data.pr || '')) throw new Error('No invoice returned.');
  if (nip57.getSatoshisAmountFromBolt11(data.pr) !== sats) throw new Error('Invoice amount does not match. Zap cancelled.');
  return data.pr;
}

function markZapped(note, sats) {
  const stats = statsFor(note.id);
  stats.zaps++;
  stats.satszapped += sats;
  actionsFor(note.id).zapped = true;
  emit('zs:stats', note.id);
}

export async function zapNote(note, sats, comment = '') {
  const invoice = await requestZapInvoice(note, sats, comment);
  const paid = await payInvoice(invoice);
  if (paid) markZapped(note, sats);
  return { paid, invoice };
}

function watchForReceipt(note, invoice, onPaid) {
  const sub = pool.subscribe(DEFAULT_RELAYS, { kinds: [9735], '#e': [note.id], since: now() - 60 }, {
    onevent: receipt => {
      if (receipt.tags.some(t => t[0] === 'bolt11' && t[1] === invoice)) onPaid();
    }
  });
  return () => sub.close();
}

// ---------- Zap dialog ----------

const dialog = document.getElementById('zap-dialog');
const amountInput = document.getElementById('zap-amount');
const commentInput = document.getElementById('zap-comment');
const statusEl = document.getElementById('zap-status');
const invoiceSection = document.getElementById('zap-invoice');
const presetsEl = document.getElementById('zap-presets');
let current = null;

presetsEl.replaceChildren(...ZAP_PRESETS.map(sats => el('button', {
  type: 'button', class: 'preset', 'data-sats': sats,
  onclick: () => { amountInput.value = sats; highlightPreset(); }
}, `⚡ ${formatSats(sats)}`)));

function highlightPreset() {
  for (const button of presetsEl.children) button.setAttribute('aria-pressed', String(Number(button.dataset.sats) === Number(amountInput.value)));
}

amountInput.addEventListener('input', highlightPreset);

async function showInvoice(invoice) {
  const { default: QRCode } = await import('https://esm.sh/qrcode@1.5.4');
  document.getElementById('zap-qr').src = await QRCode.toDataURL(invoice.toUpperCase(), { margin: 1, width: 240 });
  document.getElementById('zap-invoice-text').value = invoice;
  document.getElementById('zap-open-wallet').href = `lightning:${invoice}`;
  invoiceSection.hidden = false;
  statusEl.textContent = 'No wallet connected. Scan or copy the invoice to pay. Waiting for payment…';
}

document.getElementById('zap-copy').addEventListener('click', () => {
  navigator.clipboard.writeText(document.getElementById('zap-invoice-text').value)
    .then(() => toast('Invoice copied'))
    .catch(() => toast('Could not copy', 'error'));
});

document.getElementById('zap-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!current) return;
  const sats = Math.trunc(Number(amountInput.value));
  if (!Number.isInteger(sats) || sats < 1) {
    statusEl.textContent = 'Enter an amount of at least 1 sat.';
    return;
  }
  const { note } = current;
  setBusy(dialog, true);
  statusEl.textContent = 'Requesting invoice…';
  try {
    const { paid, invoice } = await zapNote(note, sats, commentInput.value.trim());
    if (paid) {
      toast(`Zapped ${formatSats(sats)} sats ⚡`);
      dialog.close();
      return;
    }
    await showInvoice(invoice);
    current.stopWatching = watchForReceipt(note, invoice, () => {
      markZapped(note, sats);
      toast(`Zapped ${formatSats(sats)} sats ⚡`);
      dialog.close();
    });
  } catch (err) {
    statusEl.textContent = err.message || String(err);
  } finally {
    setBusy(dialog, false);
  }
});

dialog.addEventListener('close', () => {
  current?.stopWatching?.();
  current = null;
});

document.getElementById('zap-close').addEventListener('click', () => dialog.close());

export function openZapDialog(note, presetSats = settings.defaultZap || ZAP_PRESETS[0], invoice = null) {
  current = { note };
  amountInput.value = presetSats;
  commentInput.value = '';
  invoiceSection.hidden = true;
  statusEl.textContent = `Wallet: ${walletLabel()}`;
  highlightPreset();
  ensureProfile(note.pubkey).then(profile => {
    document.getElementById('zap-title').textContent = `Zap ${profile.name}`;
  });
  dialog.showModal();
  if (invoice) {
    showInvoice(invoice).then(() => {
      current.stopWatching = watchForReceipt(note, invoice, () => {
        markZapped(note, presetSats);
        toast(`Zapped ${formatSats(presetSats)} sats ⚡`);
        dialog.close();
      });
    });
  }
}
