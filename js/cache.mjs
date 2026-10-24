const DEFAULT_PREFIX = 'zs-content-cache:v1:';
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 160;
const DEFAULT_MAX_ENTRY_CHARS = 256 * 1024;
const DEFAULT_MAX_TOTAL_CHARS = 2.5 * 1024 * 1024;

export function createContentCache({
  storage,
  now = () => Date.now(),
  prefix = DEFAULT_PREFIX,
  defaultTtlMs = DEFAULT_TTL_MS,
  maxEntries = DEFAULT_MAX_ENTRIES,
  maxEntryChars = DEFAULT_MAX_ENTRY_CHARS,
  maxTotalChars = DEFAULT_MAX_TOTAL_CHARS
} = {}) {
  const getStorage = () => {
    if (storage !== undefined) return storage;
    try { return globalThis.localStorage; } catch { return null; }
  };
  const storageKey = key => `${prefix}${key}`;

  function entriesFor(storageApi) {
    const entries = [];
    try {
      for (let index = storageApi.length - 1; index >= 0; index--) {
        const key = storageApi.key(index);
        if (!key?.startsWith(prefix)) continue;
        let raw;
        let entry;
        try {
          raw = storageApi.getItem(key);
          entry = JSON.parse(raw);
        } catch {}
        if (!entry || !Number.isFinite(entry.expiresAt) || !Number.isFinite(entry.cachedAt)
          || entry.expiresAt <= now()) {
          storageApi.removeItem(key);
          continue;
        }
        entries.push({ key, cachedAt: entry.cachedAt, size: raw?.length || 0 });
      }
    } catch {
      return null;
    }
    return entries;
  }

  return {
    get(key) {
      const storageApi = getStorage();
      if (!storageApi) return null;
      const keyName = storageKey(key);
      try {
        const raw = storageApi.getItem(keyName);
        if (raw === null) return null;
        const entry = JSON.parse(raw);
        if (!Number.isFinite(entry?.expiresAt) || entry.expiresAt <= now()
          || !Number.isFinite(entry?.cachedAt) || !Object.hasOwn(entry, 'value')) {
          storageApi.removeItem(keyName);
          return null;
        }
        return entry.value;
      } catch {
        try { storageApi.removeItem(keyName); } catch {}
        return null;
      }
    },

    set(key, value, ttlMs = defaultTtlMs) {
      const storageApi = getStorage();
      if (!storageApi || !Number.isFinite(ttlMs) || ttlMs <= 0) return false;
      const keyName = storageKey(key);
      let raw;
      try {
        raw = JSON.stringify({ cachedAt: now(), expiresAt: now() + ttlMs, value });
      } catch {
        return false;
      }
      if (!raw || raw.length > maxEntryChars) return false;
      if (raw.length > maxTotalChars || maxEntries < 1) return false;

      try {
        const entries = entriesFor(storageApi);
        if (!entries) return false;
        const remaining = entries.filter(entry => entry.key !== keyName);
        remaining.sort((left, right) => left.cachedAt - right.cachedAt);
        let totalChars = remaining.reduce((total, entry) => total + entry.size, 0);
        while (remaining.length >= maxEntries || totalChars + raw.length > maxTotalChars) {
          const oldest = remaining.shift();
          if (!oldest) return false;
          storageApi.removeItem(oldest.key);
          totalChars -= oldest.size;
        }
        storageApi.setItem(keyName, raw);
        return true;
      } catch {
        return false;
      }
    },

    remove(key) {
      const storageApi = getStorage();
      if (!storageApi) return false;
      try {
        storageApi.removeItem(storageKey(key));
        return true;
      } catch {
        return false;
      }
    },

    clear() {
      const storageApi = getStorage();
      if (!storageApi) return false;
      try {
        const entries = entriesFor(storageApi);
        if (!entries) return false;
        for (const entry of entries) storageApi.removeItem(entry.key);
        return true;
      } catch {
        return false;
      }
    }
  };
}

export const contentCache = createContentCache();