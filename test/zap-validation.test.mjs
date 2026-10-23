import test from 'node:test';
import assert from 'node:assert/strict';
import { validateZapReceipt } from '../js/zap-validation.mjs';

const sender = '1'.repeat(64);
const recipient = '2'.repeat(64);
const provider = '3'.repeat(64);
const request = {
  kind: 9734,
  pubkey: sender,
  valid: true,
  content: 'Thanks for the note!',
  tags: [['p', recipient], ['amount', '21000']]
};

function receiptWith(overrides = {}) {
  return {
    kind: 9735,
    pubkey: provider,
    valid: true,
    tags: [
      ['P', sender],
      ['p', recipient],
      ['bolt11', 'invoice'],
      ['description', JSON.stringify(request)]
    ],
    ...overrides
  };
}

function validate(receipt = receiptWith(), options = {}) {
  return validateZapReceipt(receipt, sender, {
    verifyEvent: event => event.valid,
    getProviderPubkey: async () => provider,
    getBolt11AmountMsats: async () => 21000,
    ...options
  });
}

test('accepts a signed, paid non-self zap from the expected sender', async () => {
  assert.deepEqual(await validate(), {
    sender, recipient, amountMsats: 21000, sats: 21, comment: 'Thanks for the note!'
  });
});

test('rejects invalid receipt and request signatures', async () => {
  assert.equal(await validate(receiptWith({ valid: false })), null);
  const invalidRequest = { ...request, valid: false };
  assert.equal(await validate(receiptWith({
    tags: receiptWith().tags.map(tag => tag[0] === 'description' ? ['description', JSON.stringify(invalidRequest)] : tag)
  })), null);
});

test('ignores malformed tag entries', async () => {
  assert.equal(await validate(receiptWith({ tags: [null, ['P', sender]] })), null);
});

test('rejects a receipt signed by a key other than the recipient provider', async () => {
  assert.equal(await validate(receiptWith(), { getProviderPubkey: async () => '4'.repeat(64) }), null);
  assert.equal(await validate(receiptWith(), { getProviderPubkey: async () => null }), null);
});

test('rejects missing or mismatched invoice amounts', async () => {
  assert.equal(await validate(receiptWith(), { getBolt11AmountMsats: async () => 20000 }), null);
  const noAmount = { ...request, tags: [['p', recipient]] };
  const receipt = receiptWith({ tags: receiptWith().tags.map(tag => tag[0] === 'description' ? ['description', JSON.stringify(noAmount)] : tag) });
  assert.equal(await validate(receipt), null);
});

test('rejects inconsistent sender or recipient tags and self-zaps', async () => {
  assert.equal(await validate(receiptWith({ tags: receiptWith().tags.map(tag => tag[0] === 'P' ? ['P', '4'.repeat(64)] : tag) })), null);
  const wrongRecipient = { ...request, tags: [['p', '4'.repeat(64)], ['amount', '21000']] };
  assert.equal(await validate(receiptWith({ tags: receiptWith().tags.map(tag => tag[0] === 'description' ? ['description', JSON.stringify(wrongRecipient)] : tag) })), null);
  const selfRequest = { ...request, tags: [['p', sender], ['amount', '21000']] };
  const selfReceipt = receiptWith({ tags: receiptWith().tags.map(tag => tag[0] === 'p' ? ['p', sender] : tag[0] === 'description' ? ['description', JSON.stringify(selfRequest)] : tag) });
  assert.equal(await validate(selfReceipt), null);
});