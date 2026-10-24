function tagValues(event, name) {
  return Array.isArray(event?.tags)
    ? event.tags.filter(tag => Array.isArray(tag) && tag[0] === name).map(tag => tag[1])
    : [];
}

function singleTag(event, name) {
  const values = tagValues(event, name);
  return values.length === 1 && typeof values[0] === 'string' ? values[0] : null;
}

function validEvent(event, verifyEvent) {
  try {
    return verifyEvent(event);
  } catch {
    return false;
  }
}

export async function validateZapReceipt(receipt, expectedSender, {
  verifyEvent,
  getProviderPubkey,
  getBolt11AmountMsats
}) {
  if (receipt?.kind !== 9735 || !validEvent(receipt, verifyEvent)) return null;

  const sender = singleTag(receipt, 'P');
  const recipient = singleTag(receipt, 'p');
  const bolt11 = singleTag(receipt, 'bolt11');
  const description = singleTag(receipt, 'description');
  if (sender !== expectedSender || !recipient || recipient === sender || !bolt11 || !description) return null;
  if (!/^[0-9a-f]{64}$/i.test(sender) || !/^[0-9a-f]{64}$/i.test(recipient)) return null;

  let request;
  try {
    request = JSON.parse(description);
  } catch {
    return null;
  }
  if (request?.kind !== 9734 || request.pubkey !== sender || !validEvent(request, verifyEvent)) return null;

  const requestRecipients = tagValues(request, 'p');
  if (requestRecipients.length !== 1 || requestRecipients[0] !== recipient) return null;

  const amountTag = singleTag(request, 'amount');
  if (!amountTag || !/^\d+$/.test(amountTag)) return null;
  const amountMsats = Number(amountTag);
  if (!Number.isSafeInteger(amountMsats) || amountMsats <= 0) return null;

  let invoiceMsats;
  let providerPubkey;
  try {
    [invoiceMsats, providerPubkey] = await Promise.all([
      getBolt11AmountMsats(bolt11),
      getProviderPubkey(recipient)
    ]);
  } catch {
    return null;
  }
  if (invoiceMsats !== amountMsats || !/^[0-9a-f]{64}$/i.test(providerPubkey || '')) return null;
  if (receipt.pubkey?.toLowerCase() !== providerPubkey.toLowerCase()) return null;

  return {
    sender,
    recipient,
    amountMsats,
    sats: amountMsats / 1000,
    comment: typeof request.content === 'string' ? request.content : ''
  };
}

export async function validateZapActivityReceipt(receipt, expectedSender, dependencies) {
  const zap = await validateZapReceipt(receipt, expectedSender, dependencies);
  if (!zap) return null;
  const request = JSON.parse(singleTag(receipt, 'description'));
  const receiptTargets = tagValues(receipt, 'e');
  const requestTargets = tagValues(request, 'e');
  if (receiptTargets.length > 1 || requestTargets.length > 1 || receiptTargets.length !== requestTargets.length) return null;
  const targetId = receiptTargets[0] || null;
  if (targetId && (!/^[0-9a-f]{64}$/i.test(targetId) || targetId !== requestTargets[0])) return null;
  if (receiptTargets.length && !targetId) return null;
  return { ...zap, targetId };
}