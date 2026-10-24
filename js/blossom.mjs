export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif'];

function safeUrl(value) {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password) {
    throw new Error('Use an HTTPS Blossom server URL.');
  }
  return url;
}

export function normaliseBlossomServer(value) {
  try {
    const url = safeUrl(value.trim());
    if (url.pathname !== '/' || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function blossomServers(event) {
  return [...new Set((event?.tags || []).filter(tag => tag[0] === 'server')
    .map(tag => normaliseBlossomServer(tag[1] || '')).filter(Boolean))];
}

export function selectBlossomServers(events, pubkey, verify) {
  const latest = events.filter(event => {
    try { return event.kind === 10063 && event.pubkey === pubkey && verify(event); } catch { return false; }
  }).sort((first, second) => second.created_at - first.created_at || first.id.localeCompare(second.id))[0];
  return blossomServers(latest);
}

export function validateImage(file) {
  if (!IMAGE_TYPES.includes(file?.type)) throw new Error('Choose a JPEG, PNG, GIF, WebP or AVIF image.');
  if (!file.size) throw new Error('The image is empty.');
  if (file.size > MAX_IMAGE_BYTES) throw new Error('Images must be 20 MiB or smaller.');
}

export function uploadAuthorization(hash, server, timestamp) {
  return {
    kind: 24242,
    created_at: timestamp - 1,
    content: 'Upload image to Blossom',
    tags: [['t', 'upload'], ['x', hash], ['expiration', String(timestamp + 300)], ['server', new URL(server).hostname.toLowerCase()]]
  };
}

export function authorizationHeader(event) {
  const bytes = new TextEncoder().encode(JSON.stringify(event));
  const encoded = btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
  return `Nostr ${encoded.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

const UPLOAD_ERRORS = {
  401: 'The Blossom server rejected upload authorization.',
  402: 'This Blossom server requires payment. Manage your account on the server first.',
  403: 'This Blossom server does not allow uploads for your account.',
  413: 'The image exceeds this Blossom server\'s size limit.',
  415: 'This Blossom server does not support this image type.',
  429: 'Too many uploads. Please try again later.'
};

export async function uploadImage(file, server, { signEvent, fetch: request = globalThis.fetch, signal, now = () => Math.floor(Date.now() / 1000) } = {}) {
  validateImage(file);
  const origin = normaliseBlossomServer(server);
  if (!origin) throw new Error('Set a valid Blossom server in Settings.');
  signal?.throwIfAborted();
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  signal?.throwIfAborted();
  let signed;
  try {
    signed = await signEvent(uploadAuthorization(hash, origin, now()));
  } catch (error) {
    const refused = new Error(error.message || 'Upload signing cancelled.');
    refused.name = 'SigningError';
    throw refused;
  }
  signal?.throwIfAborted();
  const uploadSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(60000)]);
  let response;
  try {
    response = await request(`${origin}/upload`, {
      method: 'PUT',
      headers: { Authorization: authorizationHeader(signed), 'Content-Type': file.type, 'X-SHA-256': hash },
      body: file,
      signal: uploadSignal,
      redirect: 'error',
      credentials: 'omit',
      referrerPolicy: 'no-referrer'
    });
  } catch (error) {
    if (uploadSignal.aborted) throw uploadSignal.reason;
    throw new Error('Could not reach the Blossom server. Check its address, connection and CORS settings.');
  }
  if (![200, 201].includes(response.status)) {
    const reason = response.headers.get('X-Reason');
    throw new Error(`${UPLOAD_ERRORS[response.status] || `Upload failed (HTTP ${response.status}).`}${reason ? ` ${reason.slice(0, 300)}` : ''}`);
  }
  let descriptor;
  try {
    descriptor = await response.json();
    const url = safeUrl(descriptor.url);
    if (descriptor.sha256 !== hash || descriptor.size !== file.size || descriptor.type !== file.type ||
      !/\.(jpe?g|png|gif|webp|avif)$/i.test(url.pathname)) throw new Error('Invalid descriptor');
    descriptor.url = url.href;
  } catch {
    throw new Error('The Blossom server returned an invalid image descriptor.');
  }
  signal?.throwIfAborted();
  return descriptor;
}