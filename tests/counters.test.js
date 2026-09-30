import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  counterKeyFor,
  readMirror,
  writeMirror,
  createSupabaseBackend,
  createAbacusBackend,
  createLocalBackend,
  createCounterClient,
  MIRROR_KEY
} from '../assets/js/lib/counters.js';

/** Minimal in-memory localStorage stand-in. */
function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: key => data.delete(key),
    _dump: () => Object.fromEntries(data)
  };
}

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => body
  };
}

describe('counterKeyFor', () => {
  it('slugs a repository path', () => {
    expect(counterKeyFor({ githubPath: 'apps/Year 10 & 11  class schedule.pdf' }))
      .toBe('dl-year-10-11-class-schedule');
  });

  it('drops the extension', () => {
    expect(counterKeyFor({ fileName: 'quiz.html' })).toBe('dl-quiz');
  });

  it('prefers the path over the file name so renames are distinct', () => {
    const a = counterKeyFor({ githubPath: 'apps/a.pdf', fileName: 'shared.pdf' });
    const b = counterKeyFor({ githubPath: 'apps/b.pdf', fileName: 'shared.pdf' });
    expect(a).not.toBe(b);
  });

  it('falls back for an unusable item', () => {
    expect(counterKeyFor({})).toBe('dl-unknown');
    expect(counterKeyFor(null)).toBe('dl-unknown');
  });

  it('produces a key the database will accept', () => {
    const key = counterKeyFor({ githubPath: 'apps/Ünïcode &&& Mess!!.pdf' });
    expect(key).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    expect(key.length).toBeLessThanOrEqual(80);
  });
});

describe('mirror', () => {
  it('round-trips a value', () => {
    const storage = memoryStorage();
    writeMirror('dl-a', 7, storage);
    expect(readMirror(storage)['dl-a']).toBe(7);
  });

  it('ignores corrupt JSON', () => {
    const storage = memoryStorage({ [MIRROR_KEY]: 'not json' });
    expect(readMirror(storage)).toEqual({});
  });

  it('survives a storage that throws', () => {
    const hostile = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); }
    };
    expect(readMirror(hostile)).toEqual({});
    expect(() => writeMirror('a', 1, hostile)).not.toThrow();
  });
});

describe('supabase backend', () => {
  const config = { url: 'https://example.supabase.co', anonKey: 'anon-key' };

  it('is null without configuration', () => {
    expect(createSupabaseBackend({})).toBeNull();
    expect(createSupabaseBackend({ url: 'x' })).toBeNull();
  });

  it('reads a counter value', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([{ value: 42 }]));
    const backend = createSupabaseBackend(config, { fetch: fetchMock });
    expect(await backend.get('dl-a')).toBe(42);

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toContain('/rest/v1/counters');
    expect(url).toContain('key=eq.dl-a');
    expect(options.headers.apikey).toBe('anon-key');
  });

  it('treats a missing row as zero', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
    const backend = createSupabaseBackend(config, { fetch: fetchMock });
    expect(await backend.get('dl-new')).toBe(0);
  });

  it('increments through the RPC', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(8));
    const backend = createSupabaseBackend(config, { fetch: fetchMock });
    expect(await backend.hit('dl-a')).toBe(8);

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toContain('/rest/v1/rpc/increment_counter');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({ counter_key: 'dl-a' });
  });

  it('throws on an HTTP error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(null, { ok: false, status: 500 }));
    const backend = createSupabaseBackend(config, { fetch: fetchMock });
    await expect(backend.get('dl-a')).rejects.toThrow(/500/);
  });

  it('batches reads and zero-fills absent keys', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([{ key: 'dl-a', value: 3 }]));
    const backend = createSupabaseBackend(config, { fetch: fetchMock });
    expect(await backend.getMany(['dl-a', 'dl-b'])).toEqual({ 'dl-a': 3, 'dl-b': 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('abacus backend', () => {
  const config = { base: 'https://abacus.example', namespace: 'ns' };

  it('reads a value', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ value: 5 }));
    const backend = createAbacusBackend(config, { fetch: fetchMock });
    expect(await backend.get('dl-a')).toBe(5);
  });

  it('treats "Key not found" as zero rather than an outage', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: 'Key not found' }));
    const backend = createAbacusBackend(config, { fetch: fetchMock });
    expect(await backend.get('dl-missing')).toBe(0);
  });

  it('throws on a server error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, { ok: false, status: 503 }));
    const backend = createAbacusBackend(config, { fetch: fetchMock });
    await expect(backend.get('dl-a')).rejects.toThrow(/503/);
  });
});

describe('local backend', () => {
  it('increments in storage', async () => {
    const storage = memoryStorage();
    const backend = createLocalBackend({ storage });
    expect(await backend.hit('dl-a')).toBe(1);
    expect(await backend.hit('dl-a')).toBe(2);
    expect(await backend.get('dl-a')).toBe(2);
  });
});

describe('createCounterClient fallback chain', () => {
  const supabase = { url: 'https://example.supabase.co', anonKey: 'anon' };
  const abacus = { base: 'https://abacus.example', namespace: 'ns' };
  let storage;

  beforeEach(() => {
    storage = memoryStorage();
  });

  it('prefers Supabase when it succeeds', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([{ value: 11 }]));
    const client = createCounterClient({ supabase, abacus }, { fetch: fetchMock, storage });
    expect(await client.get('dl-a')).toBe(11);
    expect(client.lastBackend).toBe('supabase');
    expect(client.online).toBe(true);
  });

  it('falls through to Abacus when Supabase fails', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(jsonResponse({ value: 4 }));
    const client = createCounterClient({ supabase, abacus }, { fetch: fetchMock, storage });
    expect(await client.get('dl-a')).toBe(4);
    expect(client.lastBackend).toBe('abacus');
    expect(client.online).toBe(true);
  });

  it('falls back to the local mirror when everything fails', async () => {
    writeMirror('dl-a', 9, storage);
    const fetchMock = vi.fn().mockRejectedValue(new Error('offline'));
    const client = createCounterClient({ supabase, abacus }, { fetch: fetchMock, storage });
    expect(await client.get('dl-a')).toBe(9);
    expect(client.lastBackend).toBe('local');
    expect(client.online).toBe(false);
  });

  it('mirrors successful reads for the next offline visit', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([{ value: 15 }]));
    const client = createCounterClient({ supabase }, { fetch: fetchMock, storage });
    await client.get('dl-a');
    expect(readMirror(storage)['dl-a']).toBe(15);
  });

  it('uses only the local backend when nothing is configured', async () => {
    const client = createCounterClient({}, { storage });
    expect(client.backends).toEqual([]);
    expect(await client.hit('dl-a')).toBe(1);
  });

  it('batches through Supabase in a single request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse([{ key: 'dl-a', value: 1 }, { key: 'dl-b', value: 2 }])
    );
    const client = createCounterClient({ supabase }, { fetch: fetchMock, storage });
    expect(await client.getMany(['dl-a', 'dl-b'])).toEqual({ 'dl-a': 1, 'dl-b': 2 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns an empty object for an empty batch', async () => {
    const client = createCounterClient({}, { storage });
    expect(await client.getMany([])).toEqual({});
  });
});
