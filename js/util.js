import { nip10 } from './deps.js';

export const HEX64 = /^[0-9a-f]{64}$/;

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child != null && child !== false) node.append(child);
  }
  return node;
}

export function safeHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

export function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export const now = () => Math.floor(Date.now() / 1000);
export const hoursAgo = hours => now() - hours * 3600;

export function isReply(event) {
  const { root, reply } = nip10.parse(event);
  return Boolean(root || reply);
}

export function isDirectReplyTo(event, noteId) {
  const { root, reply } = nip10.parse(event);
  return reply ? reply.id === noteId : root?.id === noteId;
}

export function hexToBytes(hex) {
  if (!/^([0-9a-f]{2})+$/i.test(hex)) throw new Error('Invalid hex');
  return Uint8Array.from(hex.match(/../g), byte => parseInt(byte, 16));
}

export function bytesToHex(bytes) {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

export function formatSats(sats) {
  if (!sats) return '0';
  if (sats >= 1_000_000) return `${+(sats / 1_000_000).toFixed(1)}M`;
  if (sats >= 1_000) return `${+(sats / 1_000).toFixed(1)}k`;
  return String(sats);
}

export const store = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  },
  remove(key) {
    localStorage.removeItem(key);
  }
};

export function emit(name, detail) {
  document.dispatchEvent(new CustomEvent(name, { detail }));
}
