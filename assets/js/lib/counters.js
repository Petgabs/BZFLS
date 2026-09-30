// ---------------------------------------------------------------------------
// Counter storage.
//
// Phase 1 moves visit/download counts off the anonymous Abacus service and
// onto a managed Postgres database (Supabase), which gives us durability,
// backups and a real owner for the data.
//
// Three backends are tried in order so the site never hard-fails:
//
//   supabase -> managed Postgres, the source of truth
//   abacus   -> legacy shared counter, kept as a transitional fallback
//   local    -> per-browser mirror in localStorage, last resort
//
// Every backend implements the same two-method interface: get(key), hit(key).
// ---------------------------------------------------------------------------

export const MIRROR_KEY = 'schoolcloud_counter_mirror';

/** Safe read of the whole localStorage mirror. */
export function readMirror(storage = globalThis.localStorage) {
  try {
    const parsed = JSON.parse(storage?.getItem(MIRROR_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Safe write of a single mirrored value. */
export function writeMirror(key, value, storage = globalThis.localStorage) {
  try {
    const mirror = readMirror(storage);
    mirror[key] = value;
    storage?.setItem(MIRROR_KEY, JSON.stringify(mirror));
  } catch {
    /* Storage full or blocked; the UI still works without the mirror. */
  }
}

/**
 * Counter keys must be URL-safe, stable for the life of a file, and distinct
 * per file. Derived from the repository path so renames create a new counter
 * rather than silently inheriting another file's total.
 */
export function counterKeyFor(app) {
  const base = String(app?.githubPath || app?.fileName || app?.id || 'unknown');
  const slug = base
    .toLowerCase()
    .replace(/^apps\//, '')
    .replace(/\.[a-z0-9]+$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `dl-${slug || 'unknown'}`;
}

/** fetch() with a hard timeout, so a hung request cannot freeze the UI. */
async function fetchWithTimeout(url, options = {}, timeoutMs = 6000, fetchImpl = globalThis.fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// --- Supabase (managed Postgres) -------------------------------------------
//
// Expects a `counters` table and an `increment_counter` RPC; see db/schema.sql.
// Only the public anon key is used, and row-level security restricts it to
// reading counters and calling the increment function. No secret is exposed.

export function createSupabaseBackend(config, deps = {}) {
  const { url, anonKey, timeoutMs = 6000 } = config || {};
  const fetchImpl = deps.fetch || globalThis.fetch;
  if (!url || !anonKey) return null;

  const base = String(url).replace(/\/+$/, '');
  const headers = {
    apikey: anonKey,
    Authorization: `Bearer ${anonKey}`,
    'Content-Type': 'application/json'
  };

  return {
    name: 'supabase',

    async get(key) {
      const endpoint = `${base}/rest/v1/counters?select=value&key=eq.${encodeURIComponent(key)}`;
      const response = await fetchWithTimeout(endpoint, { headers, cache: 'no-store' }, timeoutMs, fetchImpl);
      if (!response.ok) throw new Error(`Supabase returned ${response.status}`);
      const rows = await response.json();
      // No row yet simply means the counter has never been hit.
      if (!Array.isArray(rows) || rows.length === 0) return 0;
      const value = Number(rows[0]?.value);
      if (!Number.isFinite(value)) throw new Error('Supabase returned an invalid counter value.');
      return value;
    },

    async hit(key) {
      const endpoint = `${base}/rest/v1/rpc/increment_counter`;
      const response = await fetchWithTimeout(endpoint, {
        method: 'POST',
        headers,
        cache: 'no-store',
        body: JSON.stringify({ counter_key: key })
      }, timeoutMs, fetchImpl);
      if (!response.ok) throw new Error(`Supabase returned ${response.status}`);
      const value = Number(await response.json());
      if (!Number.isFinite(value)) throw new Error('Supabase returned an invalid counter value.');
      return value;
    },

    /** Batch read: one request for the whole library instead of N. */
    async getMany(keys) {
      if (!keys.length) return {};
      const list = keys.map(key => `"${String(key).replace(/"/g, '')}"`).join(',');
      const endpoint = `${base}/rest/v1/counters?select=key,value&key=in.(${encodeURIComponent(list)})`;
      const response = await fetchWithTimeout(endpoint, { headers, cache: 'no-store' }, timeoutMs, fetchImpl);
      if (!response.ok) throw new Error(`Supabase returned ${response.status}`);
      const rows = await response.json();
      if (!Array.isArray(rows)) throw new Error('Supabase returned an invalid counter batch.');
      const out = {};
      for (const key of keys) out[key] = 0;
      for (const row of rows) {
        const value = Number(row?.value);
        if (row?.key && Number.isFinite(value)) out[row.key] = value;
      }
      return out;
    }
  };
}

// --- Abacus (legacy shared counter) ----------------------------------------

export function createAbacusBackend(config, deps = {}) {
  const { base, namespace, timeoutMs = 6000 } = config || {};
  const fetchImpl = deps.fetch || globalThis.fetch;
  if (!base || !namespace) return null;

  async function request(action, key) {
    const endpoint = `${String(base).replace(/\/+$/, '')}/${action}/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}`;
    const response = await fetchWithTimeout(endpoint, { cache: 'no-store' }, timeoutMs, fetchImpl);

    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    // A counter that has never been hit does not exist yet; the service
    // reports that as "Key not found", which means zero, not an outage.
    const missing = /not\s*found/i.test(String(data?.error || ''));
    if (response.status === 404 || missing) return 0;
    if (!response.ok) throw new Error(`Counter service returned ${response.status}`);

    const value = Number(data?.value);
    if (!Number.isFinite(value)) throw new Error('Counter service returned an invalid value.');
    return value;
  }

  return {
    name: 'abacus',
    get: key => request('get', key),
    hit: key => request('hit', key)
  };
}

// --- localStorage mirror ----------------------------------------------------

export function createLocalBackend(deps = {}) {
  const storage = deps.storage || globalThis.localStorage;
  return {
    name: 'local',
    async get(key) {
      return Number(readMirror(storage)[key]) || 0;
    },
    async hit(key) {
      const next = (Number(readMirror(storage)[key]) || 0) + 1;
      writeMirror(key, next, storage);
      return next;
    }
  };
}

/**
 * Compose the configured backends into one client that falls through on
 * failure and mirrors every successful read locally.
 *
 * Exposes `.lastBackend` and `.online` so the UI can explain which source the
 * numbers came from.
 */
export function createCounterClient(config = {}, deps = {}) {
  const storage = deps.storage || globalThis.localStorage;
  const chain = [];

  const supabase = createSupabaseBackend(config.supabase, deps);
  if (supabase) chain.push(supabase);

  const abacus = createAbacusBackend(config.abacus, deps);
  if (abacus) chain.push(abacus);

  const local = createLocalBackend({ storage });

  const client = {
    lastBackend: chain.length ? chain[0].name : 'local',
    online: true,
    backends: chain.map(backend => backend.name),

    async run(method, key) {
      let lastError = null;
      for (const backend of chain) {
        try {
          const value = await backend[method](key);
          writeMirror(key, value, storage);
          client.lastBackend = backend.name;
          client.online = true;
          return value;
        } catch (error) {
          lastError = error;
        }
      }

      // Everything remote failed: serve the local mirror and flag the outage.
      client.lastBackend = 'local';
      client.online = false;
      if (lastError) console.warn('All remote counter backends failed.', lastError);
      return local[method](key);
    },

    get: key => client.run('get', key),
    hit: key => client.run('hit', key),

    /** Read many counters, preferring a batched backend call when available. */
    async getMany(keys) {
      const unique = [...new Set(keys)];
      if (!unique.length) return {};

      for (const backend of chain) {
        if (typeof backend.getMany !== 'function') continue;
        try {
          const values = await backend.getMany(unique);
          for (const [key, value] of Object.entries(values)) writeMirror(key, value, storage);
          client.lastBackend = backend.name;
          client.online = true;
          return values;
        } catch (error) {
          console.warn(`Batch counter read failed on ${backend.name}.`, error);
        }
      }

      // Fall back to individual reads through the normal chain.
      const entries = await Promise.all(unique.map(async key => [key, await client.get(key)]));
      return Object.fromEntries(entries);
    }
  };

  return client;
}
