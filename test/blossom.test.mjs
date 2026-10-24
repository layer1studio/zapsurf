import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseBlossomServer, blossomServers, selectBlossomServers, validateImage, uploadAuthorization, authorizationHeader, uploadImage, MAX_IMAGE_BYTES } from '../js/blossom.mjs';

const file = new Blob(['image fixture'], { type: 'image/png' });
const server = 'https://images.example';
const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())), byte => byte.toString(16).padStart(2, '0')).join('');
const descriptor = { url: `${server}/${hash}.png`, sha256: hash, size: file.size, type: file.type };
const signEvent = async template => ({ ...template, pubkey: 'a'.repeat(64), sig: 'test' });
const response = (value = descriptor, status = 201) => new Response(JSON.stringify(value), { status });

test('accepts HTTPS origins and local development servers only', () => {
  assert.equal(normaliseBlossomServer(' https://IMAGES.example/ '), server);
  assert.equal(normaliseBlossomServer('http://localhost:8080'), 'http://localhost:8080');
  for (const value of ['http://images.example', 'https://user:secret@images.example', `${server}/path`, `${server}/?secret=1`, `${server}/#hash`, 'javascript:alert(1)']) {
    assert.equal(normaliseBlossomServer(value), null);
  }
});

test('preserves ordered unique valid server tags', () => {
  assert.deepEqual(blossomServers({ tags: [['server', server], ['server', 'http://bad.example'], ['server', `${server}/`], ['server', 'https://second.example']] }), [server, 'https://second.example']);
});

test('uses only the newest verified server list for the requested account', () => {
  const older = { kind: 10063, pubkey: 'alice', id: 'b', created_at: 1, tags: [['server', server]] };
  const newer = { ...older, id: 'a', created_at: 2, tags: [['server', 'https://new.example']] };
  const events = [older, newer, { ...newer, pubkey: 'bob', created_at: 10 }, { ...newer, invalid: true, created_at: 20 }];
  assert.deepEqual(selectBlossomServers(events, 'alice', event => !event.invalid), ['https://new.example']);
  assert.deepEqual(selectBlossomServers([...events, { ...newer, created_at: 3, tags: [] }], 'alice', event => !event.invalid), []);
  assert.deepEqual(selectBlossomServers(events, 'carol', () => true), []);
});

test('breaks equal-time server-list ties by lowest event ID', () => {
  const event = { kind: 10063, pubkey: 'alice', created_at: 1 };
  assert.deepEqual(selectBlossomServers([
    { ...event, id: 'b', tags: [['server', 'https://second.example']] },
    { ...event, id: 'a', tags: [['server', server]] }
  ], 'alice', () => true), [server]);
});

test('rejects empty, oversized and unsupported images', () => {
  assert.throws(() => validateImage(new Blob([], { type: 'image/png' })), /empty/);
  assert.throws(() => validateImage({ size: MAX_IMAGE_BYTES + 1, type: 'image/png' }), /20 MiB/);
  assert.throws(() => validateImage(new Blob(['svg'], { type: 'image/svg+xml' })), /Choose/);
});

test('authorization is scoped to the image, server and five-minute expiration', () => {
  const template = uploadAuthorization(hash, server, 1000);
  assert.equal(template.kind, 24242);
  assert.equal(template.created_at, 999);
  assert.deepEqual(template.tags, [['t', 'upload'], ['x', hash], ['expiration', '1300'], ['server', 'images.example']]);
  const token = authorizationHeader({ ...template, content: 'Upload caf\u00e9 image' }).slice(6);
  assert.match(token, /^[A-Za-z0-9_-]+$/);
  assert.equal(JSON.parse(Buffer.from(token, 'base64url').toString()).content, 'Upload caf\u00e9 image');
});

test('uploads exact bytes with signed auth via raw PUT and validates descriptor', async () => {
  let called = false;
  const result = await uploadImage(file, server, { signEvent, now: () => 1000, fetch: async (url, options) => {
    called = true;
    assert.equal(url, `${server}/upload`);
    assert.equal(options.method, 'PUT');
    assert.equal(options.body, file);
    assert.equal(options.headers['X-SHA-256'], hash);
    assert.equal(options.headers['Content-Type'], 'image/png');
    assert.equal(options.redirect, 'error');
    assert.equal(JSON.parse(Buffer.from(options.headers.Authorization.slice(6), 'base64url').toString()).kind, 24242);
    return response();
  } });
  assert.equal(called, true);
  assert.deepEqual(result, descriptor);
});

test('accepts existing blobs and safe CDN URLs', async () => {
  const result = await uploadImage(file, server, { signEvent, fetch: async () => response({ ...descriptor, url: `https://cdn.example/${hash}.png` }, 200) });
  assert.equal(result.url, `https://cdn.example/${hash}.png`);
});

test('rejects mismatched hashes, sizes, types and unsafe image URLs', async () => {
  for (const change of [{ sha256: 'b'.repeat(64) }, { size: 0 }, { type: 'text/html' }, { url: 'javascript:alert(1)' }, { url: `${server}/page.html` }]) {
    await assert.rejects(uploadImage(file, server, { signEvent, fetch: async () => response({ ...descriptor, ...change }) }), /invalid image descriptor/);
  }
});

test('reports server errors and connection failures', async () => {
  for (const [status, message] of [[401, /authorization/], [402, /payment/], [403, /does not allow/], [413, /size limit/], [415, /image type/], [429, /Too many/]]) {
    await assert.rejects(uploadImage(file, server, { signEvent, fetch: async () => response({}, status) }), message);
  }
  await assert.rejects(uploadImage(file, server, { signEvent, fetch: async () => { throw new TypeError('Failed to fetch'); } }), /CORS/);
});

test('never sends bytes after cancellation, signing refusal or invalid input', async () => {
  let requests = 0;
  const fetch = async () => { requests++; return response(); };
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(uploadImage(file, server, { signEvent, fetch, signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(uploadImage(file, server, { fetch, signEvent: async () => { throw new Error('Denied'); } }), { name: 'SigningError' });
  const duringSigning = new AbortController();
  await assert.rejects(uploadImage(file, server, { fetch, signal: duringSigning.signal, signEvent: async template => { duringSigning.abort(); return template; } }), { name: 'AbortError' });
  await assert.rejects(uploadImage(file, '', { signEvent, fetch }), /Settings/);
  assert.equal(requests, 0);
});