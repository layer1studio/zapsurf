import { createDirectMessage, createLegacyDirectMessage, unwrapDirectMessage, unwrapLegacyDirectMessage, messageRelayUrls } from './messages.mjs';

export function createMessageService({ pool, discoveryRelays, getSession, crypto, getHistoryRelays = async () => [], onChange = () => {} }) {
  const messages = new Map();
  const pending = new Map();
  const relayLists = new Map();
  const seen = new Set();
  const connected = new Set(discoveryRelays);
  const pausedKinds = new Set();
  let historySubscriptions = [];
  let historyRelays = [];
  let legacyCursors = [null, null];
  let subscription = null;
  let generation = 0;
  let queue = Promise.resolve();
  let queued = 0;
  let ownRelays = [];
  let status = '';
  let olderUntil = null;
  let loadingOlder = false;
  let activeSession = null;
  let closing = Promise.resolve();

  const snapshot = () => ({ messages: [...messages.values()], relays: [...ownRelays], status, loadingOlder });
  const notify = () => onChange(snapshot());
  const active = token => token === generation && activeSession && getSession() === activeSession;
  function assertActive(token) {
    if (!active(token)) throw new Error('Messaging session ended. Reopen Messages.');
  }

  async function inboxRelays(pubkey, token, refresh = false) {
    const cached = relayLists.get(pubkey);
    if (!refresh && cached && Date.now() - cached.time < 60000) return cached.urls;
    const hints = await getHistoryRelays(pubkey);
    assertActive(token);
    const lookupRelays = [...new Set([...discoveryRelays, ...hints])];
    lookupRelays.forEach(url => connected.add(url));
    const events = await pool.querySync(lookupRelays, { kinds: [10050], authors: [pubkey] }, { maxWait: 6000 });
    assertActive(token);
    const newest = events.filter(event => event.pubkey === pubkey && event.kind === 10050 && crypto.verifyEvent(event))
      .sort((left, right) => right.created_at - left.created_at || left.id.localeCompare(right.id))[0];
    const urls = messageRelayUrls(newest);
    relayLists.set(pubkey, { urls, time: Date.now() });
    urls.forEach(url => connected.add(url));
    return urls;
  }

  function ingest(event, token) {
    if (!active(token) || pausedKinds.has(event.kind) || seen.has(event.id) || queued >= 200 || seen.size >= 4000) return;
    seen.add(event.id);
    queued++;
    queue = queue.then(async () => {
      if (!active(token) || pausedKinds.has(event.kind)) return;
      try {
        const message = await (event.kind === 4 ? unwrapLegacyDirectMessage : unwrapDirectMessage)(event, activeSession.pubkey, crypto);
        if (!active(token)) return;
        if (!messages.has(message.id) && messages.size < 1000) {
          messages.set(message.id, message);
          notify();
        }
      } catch (cause) {
        if (active(token)) {
          if (cause?.dmSignerFailure) pausedKinds.add(event.kind);
          status = cause?.dmSignerFailure ? (event.kind === 4 ? 'Legacy message access declined. Reopen Messages to retry.'
            : 'Signer access declined. Reopen Messages to retry.')
            : 'Some messages could not be decrypted or verified. Reopen Messages to retry.';
          notify();
        }
      }
    }).finally(() => { if (token === generation) queued--; });
  }

  function auth(token) {
    return template => {
      assertActive(token);
      if (template.kind !== 22242) throw new Error('Invalid relay authentication request.');
      return crypto.signEvent(template);
    };
  }

  function stop() {
    generation++;
    const closed = Promise.all([subscription?.close(), ...historySubscriptions.map(handle => handle.close())]);
    subscription = null;
    historySubscriptions = [];
    const urls = [...connected];
    closing = closing.then(() => closed).catch(() => {}).then(async () => {
      for (const relay of pool.relays?.values() || []) relay.closeAllSubscriptions('DM inbox closed');
      await Promise.resolve();
      pool.close(urls);
    }).catch(() => {});
    messages.clear();
    pending.clear();
    relayLists.clear();
    seen.clear();
    queue = Promise.resolve();
    queued = 0;
    ownRelays = [];
    status = '';
    olderUntil = null;
    loadingOlder = false;
    activeSession = null;
    pausedKinds.clear();
    historyRelays = [];
    legacyCursors = [null, null];
    notify();
    return closing;
  }

  async function start() {
    const stopped = stop();
    activeSession = getSession();
    if (!activeSession || activeSession.method === 'readonly') {
      activeSession = null;
      throw new Error('Log in with a NIP-44 signer to use private messages.');
    }
    const token = generation;
    await stopped;
    assertActive(token);
    status = 'Finding your inbox relays...';
    notify();
    ownRelays = await inboxRelays(activeSession.pubkey, token, true);
    assertActive(token);
    if (!ownRelays.length) {
      status = 'No DM inbox relays configured.';
      notify();
      await startHistory(token);
      return;
    }
    let oldestInitial = Infinity;
    let initialComplete = false;
    olderUntil = crypto.now();
    status = 'Loading private messages...';
    notify();
    subscription = pool.subscribeMany(ownRelays, {
      kinds: [1059], '#p': [activeSession.pubkey], limit: 200
    }, {
      onauth: auth(token),
      onevent: event => {
        if (!initialComplete && Number.isSafeInteger(event.created_at)) oldestInitial = Math.min(oldestInitial, event.created_at);
        ingest(event, token);
      },
      oneose: () => {
        if (active(token)) {
          initialComplete = true;
          olderUntil = Number.isFinite(oldestInitial) ? oldestInitial - 1 : 0;
          if (status === 'Loading private messages...') status = '';
          notify();
        }
      },
      onclose: () => { if (active(token)) { status = 'Inbox connection closed. Reopen Messages to reconnect.'; notify(); } }
    });
    await startHistory(token);
  }

  async function startHistory(token) {
    const relays = await getHistoryRelays(activeSession.pubkey);
    assertActive(token);
    historyRelays = [...new Set(relays)];
    historyRelays.forEach(url => connected.add(url));
    if (!historyRelays.length) return;
    legacyCursors = [crypto.now(), crypto.now()];
    historySubscriptions = [
      { kinds: [4], '#p': [activeSession.pubkey], limit: 100 },
      { kinds: [4], authors: [activeSession.pubkey], limit: 100 }
    ].map((filter, index) => {
      let oldest = Infinity;
      let initialComplete = false;
      return pool.subscribeMany(historyRelays, filter, {
      onauth: auth(token),
      onevent: event => {
        if (!initialComplete && Number.isSafeInteger(event.created_at)) oldest = Math.min(oldest, event.created_at);
        ingest(event, token);
      },
      oneose: () => {
        if (active(token)) {
          initialComplete = true;
          legacyCursors[index] = Number.isFinite(oldest) ? oldest - 1 : 0;
        }
      }
      });
    });
    notify();
  }

  async function loadOlder() {
    const token = generation;
    assertActive(token);
    if (loadingOlder || (!ownRelays.length && !historyRelays.length)) return;
    loadingOlder = true;
    notify();
    try {
      const events = ownRelays.length && olderUntil !== null ? await pool.querySync(ownRelays, {
        kinds: [1059], '#p': [activeSession.pubkey], until: olderUntil, limit: 100
      }, { maxWait: 10000, onauth: auth(token) }) : [];
      const legacyPages = historyRelays.length ? await Promise.all([
        { kinds: [4], '#p': [activeSession.pubkey], until: legacyCursors[0], limit: 100 },
        { kinds: [4], authors: [activeSession.pubkey], until: legacyCursors[1], limit: 100 }
      ].map(filter => pool.querySync(historyRelays, filter, { maxWait: 10000, onauth: auth(token) }))) : [];
      const legacyEvents = legacyPages.flat();
      assertActive(token);
      for (const event of events) ingest(event, token);
      for (const event of legacyEvents) ingest(event, token);
      if (events.length) olderUntil = Math.min(...events.map(event => event.created_at)) - 1;
      legacyPages.forEach((page, index) => {
        if (page.length) legacyCursors[index] = Math.min(...page.map(event => event.created_at)) - 1;
      });
      status = events.length || legacyEvents.length ? '' : 'No older messages found.';
      await queue;
    } finally {
      if (active(token)) { loadingOlder = false; notify(); }
    }
  }

  async function saveRelays(urls) {
    const token = generation;
    assertActive(token);
    const relays = messageRelayUrls({ kind: 10050, tags: urls.map(url => ['relay', url]) });
    if (!relays.length || relays.length > 3 || relays.length !== urls.length) throw new Error('Enter 1 to 3 unique wss:// inbox relays.');
    const event = await crypto.signEvent({ kind: 10050, created_at: crypto.now(), tags: relays.map(url => ['relay', url]), content: '' });
    assertActive(token);
    const results = await Promise.allSettled(pool.publish(discoveryRelays, event, { onauth: auth(token) }));
    assertActive(token);
    if (!results.some(result => result.status === 'fulfilled')) throw new Error('No relay accepted your inbox settings.');
    await start();
  }

  async function deliver(id, token) {
    const item = pending.get(id);
    if (!item || item.busy) return;
    item.busy = true;
    try {
      for (const copy of item.wraps) {
        if (copy.accepted) continue;
        assertActive(token);
        const results = await Promise.allSettled(pool.publish(copy.relays, copy.event, { onauth: auth(token) }));
        assertActive(token);
        copy.accepted = results.some(result => result.status === 'fulfilled');
      }
      const delivered = item.wraps[0].accepted;
      const saved = item.wraps[1].accepted;
      const message = messages.get(id);
      const delivery = delivered ? (saved ? (message?.legacy ? 'Accepted by relays (legacy)' : 'Accepted by inbox relays')
        : 'Sent; history copy failed') : 'Not sent';
      if (message) messages.set(id, { ...message, delivery, retry: !delivered || !saved });
      if (delivered && saved) pending.delete(id);
      notify();
    } finally {
      item.busy = false;
    }
  }

  async function checkRecipient(recipient, { legacy = false } = {}) {
    const token = generation;
    assertActive(token);
    if (!/^[0-9a-f]{64}$/.test(recipient) || recipient === activeSession.pubkey) {
      return { ready: false, reason: 'Choose another person to message.' };
    }
    if (legacy) {
      const relays = await getHistoryRelays(recipient);
      assertActive(token);
      return { ready: Boolean(relays.length), reason: relays.length ? '' : 'No relay route is available for legacy messages.' };
    }
    if (!ownRelays.length) return { ready: false, reason: 'Set up your DM inbox relays before sending.' };
    const relays = await inboxRelays(recipient, token);
    assertActive(token);
    return { ready: Boolean(relays.length), reason: relays.length ? '' : 'This person has not advertised a NIP-17 inbox.' };
  }

  async function send(recipient, content, { legacy = false } = {}) {
    const token = generation;
    assertActive(token);
    if (pending.size >= 20) throw new Error('Retry pending messages before sending more.');
    const sender = activeSession.pubkey;
    if (legacy) {
      const [recipientRelays, senderRelays] = await Promise.all([getHistoryRelays(recipient), getHistoryRelays(sender)]);
      assertActive(token);
      if (!recipientRelays.length) throw new Error('No relay route is available for legacy messages.');
      const { event, message } = await createLegacyDirectMessage({ sender, recipient, content }, crypto);
      assertActive(token);
      [...recipientRelays, ...senderRelays].forEach(url => connected.add(url));
      messages.set(event.id, { ...message, delivery: 'Sending legacy message...', retry: false });
      pending.set(event.id, { wraps: [
        { target: recipient, event, relays: recipientRelays, accepted: false },
        { target: sender, event, relays: senderRelays, accepted: !senderRelays.length }
      ] });
      notify();
      await deliver(event.id, token);
      return event.id;
    }
    const [recipientRelays, senderRelays] = await Promise.all([
      inboxRelays(recipient, token, true), inboxRelays(sender, token)
    ]);
    assertActive(token);
    if (!recipientRelays.length) throw new Error('This person has not advertised DM inbox relays.');
    if (!senderRelays.length) throw new Error('Configure your DM inbox relays first.');
    const { rumor, wraps } = await createDirectMessage({ sender, recipient, content }, crypto);
    assertActive(token);
    pending.set(rumor.id, { wraps: wraps.map((copy, index) => ({ ...copy, relays: index ? senderRelays : recipientRelays, accepted: false })) });
    messages.set(rumor.id, { ...rumor, peer: recipient, delivery: 'Sending...', retry: false });
    notify();
    await deliver(rumor.id, token);
    return rumor.id;
  }

  return { start, stop, send, checkRecipient, saveRelays, loadOlder, snapshot, retry: id => deliver(id, generation) };
}