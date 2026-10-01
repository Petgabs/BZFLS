// ---------------------------------------------------------------------------
// GitHub auto-publish client: token handling, library.json merging and the
// two-commit publish pipeline (file → apps/, metadata → library.json). All
// network access is through an injected fetch, so these tests lock the exact
// requests the administrator's token is used for.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import {
  GithubPublishError,
  normaliseToken,
  isFineGrainedToken,
  encodeRepoPath,
  blobToBase64,
  textToBase64,
  base64ToText,
  mergeLibraryEntry,
  removeLibraryEntry,
  createGithubPublisher,
  publishSubmissionToGithub,
  deleteFileFromGithub,
  commitJsonWithRetry
} from '../assets/js/lib/githubPublish.js';
import { mergeQueueEntry } from '../assets/js/lib/reviewQueue.js';
import { overrideFromSubmission, submissionFromDraft, emptyDraft } from '../assets/js/lib/submissions.js';

const REPO = 'Petgabs/BZFLS';
const TOKEN = 'github_pat_11AAAA_examplevalue';

/** Minimal fetch stub: route → ({status, json}) or a handler(url, options). */
function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    for (const [match, respond] of routes) {
      const matches = typeof match === 'function' ? match(String(url), options) : String(url).includes(match);
      if (matches) {
        const result = typeof respond === 'function' ? respond(String(url), options) : respond;
        return {
          ok: result.status >= 200 && result.status < 300,
          status: result.status,
          json: async () => result.json ?? {}
        };
      }
    }
    return { ok: false, status: 404, json: async () => ({ message: 'Not Found' }) };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

// --- Token handling ----------------------------------------------------------

describe('token handling', () => {
  it('trims pasted tokens and rejects whitespace', () => {
    expect(normaliseToken('  github_pat_abc  ')).toBe('github_pat_abc');
    expect(normaliseToken('github pat abc')).toBe('');
    expect(normaliseToken('')).toBe('');
    expect(normaliseToken(null)).toBe('');
  });

  it('recognises fine-grained tokens', () => {
    expect(isFineGrainedToken('github_pat_abc')).toBe(true);
    expect(isFineGrainedToken('ghp_classic')).toBe(false);
  });
});

// --- Path encoding -------------------------------------------------------------

describe('encodeRepoPath', () => {
  it('encodes each segment but keeps separators', () => {
    expect(encodeRepoPath('apps/Year 10 & 11  class schedule.pdf'))
      .toBe('apps/Year%2010%20%26%2011%20%20class%20schedule.pdf');
    expect(encodeRepoPath('library.json')).toBe('library.json');
  });
});

// --- Encoding helpers ----------------------------------------------------------

describe('base64 helpers', () => {
  it('round-trips UTF-8 text (incl. the em dashes library.json uses)', () => {
    const text = '{\n  "title": "Exercise 16G — Solutions ✓"\n}\n';
    expect(base64ToText(textToBase64(text))).toBe(text);
  });

  it('tolerates the newlines GitHub inserts into base64 content', () => {
    const base64 = textToBase64('hello world');
    const wrapped = `${base64.slice(0, 6)}\n${base64.slice(6)}\n`;
    expect(base64ToText(wrapped)).toBe('hello world');
  });

  it('encodes binary blobs without a data URL prefix', async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]);
    const blob = new Blob([bytes]);
    const base64 = await blobToBase64(blob);
    expect(base64).not.toContain(',');
    const decoded = atob(base64);
    expect(decoded.length).toBe(bytes.length);
    expect(decoded.charCodeAt(5)).toBe(0xff);
  });
});

// --- library.json merging --------------------------------------------------------

describe('mergeLibraryEntry', () => {
  const CURRENT = JSON.stringify({
    _comment: ['Hand-curated metadata for files in /apps.'],
    'apps/16G.pdf': { title: 'Existing', subject: 'Mathematics' }
  }, null, 2);

  it('appends a new entry and preserves existing keys and order', () => {
    const merged = mergeLibraryEntry(CURRENT, 'apps/new.pdf', { title: 'New resource' });
    const data = JSON.parse(merged);
    expect(Object.keys(data)).toEqual(['_comment', 'apps/16G.pdf', 'apps/new.pdf']);
    expect(data['apps/new.pdf'].title).toBe('New resource');
    expect(data['apps/16G.pdf'].title).toBe('Existing');
  });

  it('replaces an existing entry for the same path', () => {
    const merged = mergeLibraryEntry(CURRENT, 'apps/16G.pdf', { title: 'Updated title' });
    const data = JSON.parse(merged);
    expect(data['apps/16G.pdf']).toEqual({ title: 'Updated title' });
  });

  it('starts a fresh file when library.json does not exist yet', () => {
    const merged = mergeLibraryEntry('', 'apps/a.pdf', { title: 'A' });
    expect(JSON.parse(merged)).toEqual({ 'apps/a.pdf': { title: 'A' } });
    expect(merged.endsWith('\n')).toBe(true);
  });

  it('refuses to merge into a broken library.json instead of clobbering it', () => {
    expect(() => mergeLibraryEntry('{ not json', 'apps/a.pdf', {}))
      .toThrow(GithubPublishError);
    expect(() => mergeLibraryEntry('[1, 2]', 'apps/a.pdf', {}))
      .toThrow(/JSON object/);
  });
});

describe('removeLibraryEntry', () => {
  const CURRENT = JSON.stringify({
    _comment: ['Hand-curated metadata for files in /apps.'],
    'apps/16G.pdf': { title: 'Existing', subject: 'Mathematics' },
    'apps/other.pdf': { title: 'Other' }
  }, null, 2);

  it('removes the entry and preserves the rest', () => {
    const result = removeLibraryEntry(CURRENT, 'apps/16G.pdf');
    const data = JSON.parse(result);
    expect(Object.keys(data)).toEqual(['_comment', 'apps/other.pdf']);
  });

  it('returns null when the file is empty (nothing to change)', () => {
    expect(removeLibraryEntry('', 'apps/16G.pdf')).toBeNull();
  });

  it('returns null when the key is not present', () => {
    expect(removeLibraryEntry(CURRENT, 'apps/missing.pdf')).toBeNull();
  });

  it('refuses to touch a broken library.json', () => {
    expect(() => removeLibraryEntry('{ not json', 'apps/16G.pdf')).toThrow(GithubPublishError);
  });
});

// --- Client ------------------------------------------------------------------------

describe('createGithubPublisher', () => {
  it('requires a repo and a token', () => {
    expect(() => createGithubPublisher({ repo: '', token: TOKEN, fetch: fakeFetch([]) })).toThrow(/repository/i);
    expect(() => createGithubPublisher({ repo: REPO, token: '', fetch: fakeFetch([]) })).toThrow(/token/i);
  });

  it('verify() checks push permission and reads the login', async () => {
    const fetchImpl = fakeFetch([
      [`/repos/${REPO}`, { status: 200, json: { full_name: REPO, permissions: { push: true } } }],
      ['/user', { status: 200, json: { login: 'Petgabs' } }]
    ]);
    const publisher = createGithubPublisher({ repo: REPO, token: TOKEN, fetch: fetchImpl });
    const result = await publisher.verify();
    expect(result).toEqual({ login: 'Petgabs', repoFullName: REPO, canWrite: true });

    // Every request must carry the token as a Bearer header.
    for (const call of fetchImpl.calls) {
      expect(call.options.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    }
  });

  it('verify() rejects a read-only token with a precise message', async () => {
    const fetchImpl = fakeFetch([
      [`/repos/${REPO}`, { status: 200, json: { full_name: REPO, permissions: { push: false } } }]
    ]);
    const publisher = createGithubPublisher({ repo: REPO, token: TOKEN, fetch: fetchImpl });
    await expect(publisher.verify()).rejects.toThrow(/Read and write/);
  });

  it('verify() translates a 401 into reconnect guidance', async () => {
    const fetchImpl = fakeFetch([
      [`/repos/${REPO}`, { status: 401, json: { message: 'Bad credentials' } }]
    ]);
    const publisher = createGithubPublisher({ repo: REPO, token: TOKEN, fetch: fetchImpl });
    await expect(publisher.verify()).rejects.toThrow(/expired or been revoked/);
  });

  it('getFile() decodes base64 content and reports missing files cleanly', async () => {
    const fetchImpl = fakeFetch([
      ['contents/library.json', { status: 200, json: { sha: 'abc', encoding: 'base64', content: textToBase64('{"a":1}') } }]
    ]);
    const publisher = createGithubPublisher({ repo: REPO, token: TOKEN, fetch: fetchImpl });
    expect(await publisher.getFile('library.json')).toEqual({ exists: true, sha: 'abc', text: '{"a":1}' });
    expect(await publisher.getFile('missing.txt')).toEqual({ exists: false, sha: '', text: '' });
  });

  it('deleteFile() sends the blob sha and reports the commit', async () => {
    const fetchImpl = fakeFetch([
      [
        (url, options) => url.includes('contents/apps/16G.pdf') && options.method === 'DELETE',
        (url, options) => ({ status: 200, json: { commit: { sha: 'c9', html_url: 'https://github.com/Petgabs/BZFLS/commit/c9' } } })
      ]
    ]);
    const publisher = createGithubPublisher({ repo: REPO, token: TOKEN, fetch: fetchImpl });
    const result = await publisher.deleteFile({ path: 'apps/16G.pdf', sha: 'file-sha', message: 'Delete it' });
    expect(result).toEqual({ commitSha: 'c9', commitUrl: 'https://github.com/Petgabs/BZFLS/commit/c9' });

    const call = fetchImpl.calls.find(c => c.options.method === 'DELETE');
    expect(JSON.parse(call.options.body)).toMatchObject({ sha: 'file-sha', branch: 'main', message: 'Delete it' });
  });

  it('deleteFile() refuses to delete without a sha', async () => {
    const publisher = createGithubPublisher({ repo: REPO, token: TOKEN, fetch: fakeFetch([]) });
    await expect(publisher.deleteFile({ path: 'apps/16G.pdf' })).rejects.toThrow(/SHA/);
  });
});

// --- Publish pipeline -----------------------------------------------------------------

function approvedRecord() {
  const draft = {
    ...emptyDraft(),
    title: 'Continuous Probability Distributions — Exercise 16G Solutions',
    description: 'Worked solutions for Exercise 16G.',
    subject: 'Mathematics',
    years: '12',
    owner: 'Mr A. Rahman'
  };
  return submissionFromDraft(draft, { name: '16G-solutions.pdf', size: 1024, type: 'application/pdf' }, { status: 'approved' });
}

function publishRoutes({ fileExists = false, libraryExists = true } = {}) {
  const puts = [];
  const routes = [
    [
      (url, options) => url.includes('contents/apps/') && (!options.method || options.method === 'GET'),
      () => (fileExists
        ? { status: 200, json: { sha: 'old-file-sha', encoding: 'base64', content: 'QUJD' } }
        : { status: 404, json: { message: 'Not Found' } })
    ],
    [
      (url, options) => url.includes('contents/apps/') && options.method === 'PUT',
      (url, options) => {
        puts.push({ url, body: JSON.parse(options.body) });
        return { status: fileExists ? 200 : 201, json: { content: { sha: 'new-file-sha' }, commit: { sha: 'c1', html_url: 'https://github.com/Petgabs/BZFLS/commit/c1' } } };
      }
    ],
    [
      (url, options) => url.includes('contents/library.json') && (!options.method || options.method === 'GET'),
      () => (libraryExists
        ? { status: 200, json: { sha: 'lib-sha', encoding: 'base64', content: textToBase64('{\n  "apps/other.pdf": { "title": "Other" }\n}\n') } }
        : { status: 404, json: { message: 'Not Found' } })
    ],
    [
      (url, options) => url.includes('contents/library.json') && options.method === 'PUT',
      (url, options) => {
        puts.push({ url, body: JSON.parse(options.body) });
        return { status: 200, json: { content: { sha: 'new-lib-sha' }, commit: { sha: 'c2', html_url: 'https://github.com/Petgabs/BZFLS/commit/c2' } } };
      }
    ]
  ];
  return { routes, puts };
}

describe('publishSubmissionToGithub', () => {
  it('commits the file to apps/ and merges the metadata into library.json', async () => {
    const record = approvedRecord();
    const { routes, puts } = publishRoutes();
    const publisher = createGithubPublisher({ repo: REPO, token: TOKEN, fetch: fakeFetch(routes) });

    const result = await publishSubmissionToGithub(publisher, {
      fileName: record.fileName,
      fileBase64: 'JVBERi0=',
      entry: overrideFromSubmission(record),
      title: record.title
    });

    expect(result.path).toBe('apps/16G-solutions.pdf');
    expect(result.replaced).toBe(false);
    expect(result.fileCommitUrl).toContain('/commit/c1');
    expect(result.libraryCommitUrl).toContain('/commit/c2');
    expect(result.commitUrl).toContain('/commit/c2');

    // Commit 1: the file bytes, no sha (new file), on main.
    expect(puts[0].body).toMatchObject({ content: 'JVBERi0=', branch: 'main' });
    expect(puts[0].body.sha).toBeUndefined();
    expect(puts[0].body.message).toContain('apps/16G-solutions.pdf');

    // Commit 2: library.json keeps existing entries and gains the new one,
    // with exactly the metadata the manual "Copy metadata" flow produces.
    expect(puts[1].body.sha).toBe('lib-sha');
    const merged = JSON.parse(base64ToText(puts[1].body.content));
    expect(merged['apps/other.pdf']).toEqual({ title: 'Other' });
    expect(merged['apps/16G-solutions.pdf']).toEqual(overrideFromSubmission(record));
  });

  it('refuses to overwrite an existing file without explicit consent', async () => {
    const record = approvedRecord();
    const { routes } = publishRoutes({ fileExists: true });
    const publisher = createGithubPublisher({ repo: REPO, token: TOKEN, fetch: fakeFetch(routes) });

    await expect(publishSubmissionToGithub(publisher, {
      fileName: record.fileName,
      fileBase64: 'JVBERi0=',
      entry: {},
      title: record.title
    })).rejects.toMatchObject({ status: 409 });
  });

  it('replaces an existing file (with its sha) when overwrite is confirmed', async () => {
    const record = approvedRecord();
    const { routes, puts } = publishRoutes({ fileExists: true });
    const publisher = createGithubPublisher({ repo: REPO, token: TOKEN, fetch: fakeFetch(routes) });

    const result = await publishSubmissionToGithub(publisher, {
      fileName: record.fileName,
      fileBase64: 'JVBERi0=',
      entry: {},
      title: record.title,
      overwrite: true
    });

    expect(result.replaced).toBe(true);
    expect(puts[0].body.sha).toBe('old-file-sha');
    expect(puts[0].body.message).toMatch(/^Update /);
  });

  it('starts library.json from scratch when the repository has none', async () => {
    const record = approvedRecord();
    const { routes, puts } = publishRoutes({ libraryExists: false });
    const publisher = createGithubPublisher({ repo: REPO, token: TOKEN, fetch: fakeFetch(routes) });

    await publishSubmissionToGithub(publisher, {
      fileName: record.fileName,
      fileBase64: 'JVBERi0=',
      entry: { title: record.title },
      title: record.title
    });

    expect(puts[1].body.sha).toBeUndefined();
    const merged = JSON.parse(base64ToText(puts[1].body.content));
    expect(Object.keys(merged)).toEqual(['apps/16G-solutions.pdf']);
  });

  it('rejects path-traversal file names before touching the network', async () => {
    const fetchImpl = fakeFetch([]);
    const publisher = createGithubPublisher({ repo: REPO, token: TOKEN, fetch: fetchImpl });
    for (const bad of ['../evil.html', 'a/b.pdf', 'a\\b.pdf', '']) {
      await expect(publishSubmissionToGithub(publisher, { fileName: bad, fileBase64: '', entry: {} }))
        .rejects.toThrow(/file name/);
    }
    expect(fetchImpl.calls.length).toBe(0);
  });
});

// --- Delete pipeline -------------------------------------------------------------------

function deleteRoutes({ fileExists = true, libraryExists = true, libraryHasEntry = true } = {}) {
  const calls = [];
  const libraryText = libraryHasEntry
    ? '{\n  "apps/16G.pdf": { "title": "Existing" },\n  "apps/other.pdf": { "title": "Other" }\n}\n'
    : '{\n  "apps/other.pdf": { "title": "Other" }\n}\n';
  const routes = [
    [
      (url, options) => url.includes('contents/apps/16G.pdf') && (!options.method || options.method === 'GET'),
      () => (fileExists
        ? { status: 200, json: { sha: 'file-sha', encoding: 'base64', content: 'QUJD' } }
        : { status: 404, json: { message: 'Not Found' } })
    ],
    [
      (url, options) => url.includes('contents/apps/16G.pdf') && options.method === 'DELETE',
      (url, options) => {
        calls.push({ url, body: JSON.parse(options.body) });
        return { status: 200, json: { commit: { sha: 'd1', html_url: 'https://github.com/Petgabs/BZFLS/commit/d1' } } };
      }
    ],
    [
      (url, options) => url.includes('contents/library.json') && (!options.method || options.method === 'GET'),
      () => (libraryExists
        ? { status: 200, json: { sha: 'lib-sha', encoding: 'base64', content: textToBase64(libraryText) } }
        : { status: 404, json: { message: 'Not Found' } })
    ],
    [
      (url, options) => url.includes('contents/library.json') && options.method === 'PUT',
      (url, options) => {
        calls.push({ url, body: JSON.parse(options.body) });
        return { status: 200, json: { commit: { sha: 'd2', html_url: 'https://github.com/Petgabs/BZFLS/commit/d2' } } };
      }
    ]
  ];
  return { routes, calls };
}

describe('deleteFileFromGithub', () => {
  it('deletes the file and removes its library.json entry', async () => {
    const { routes, calls } = deleteRoutes();
    const publisher = createGithubPublisher({ repo: REPO, token: TOKEN, fetch: fakeFetch(routes) });

    const result = await deleteFileFromGithub(publisher, { path: 'apps/16G.pdf' });

    expect(result.existed).toBe(true);
    expect(result.fileCommitUrl).toContain('/commit/d1');
    expect(result.libraryCommitUrl).toContain('/commit/d2');
    expect(result.commitUrl).toContain('/commit/d2');

    const deleteCall = calls.find(c => c.url.includes('apps/16G.pdf'));
    expect(deleteCall.body.sha).toBe('file-sha');

    const libraryCall = calls.find(c => c.url.includes('library.json'));
    const merged = JSON.parse(base64ToText(libraryCall.body.content));
    expect(Object.keys(merged)).toEqual(['apps/other.pdf']);
  });

  it('is a no-op on the file when it is already gone, but still returns cleanly', async () => {
    const { routes, calls } = deleteRoutes({ fileExists: false });
    const publisher = createGithubPublisher({ repo: REPO, token: TOKEN, fetch: fakeFetch(routes) });

    const result = await deleteFileFromGithub(publisher, { path: 'apps/16G.pdf' });

    expect(result.existed).toBe(false);
    expect(result.fileCommitUrl).toBe('');
    expect(calls.find(c => c.url.includes('apps/16G.pdf'))).toBeUndefined();
  });

  it('skips the library.json commit when the path has no entry there', async () => {
    const { routes, calls } = deleteRoutes({ libraryHasEntry: false });
    const publisher = createGithubPublisher({ repo: REPO, token: TOKEN, fetch: fakeFetch(routes) });

    const result = await deleteFileFromGithub(publisher, { path: 'apps/16G.pdf' });

    expect(result.fileCommitUrl).toContain('/commit/d1');
    expect(result.libraryCommitUrl).toBe('');
    expect(calls.find(c => c.url.includes('library.json'))).toBeUndefined();
  });

  it('skips the library.json commit entirely when library.json does not exist', async () => {
    const { routes, calls } = deleteRoutes({ libraryExists: false });
    const publisher = createGithubPublisher({ repo: REPO, token: TOKEN, fetch: fakeFetch(routes) });

    await deleteFileFromGithub(publisher, { path: 'apps/16G.pdf' });

    expect(calls.find(c => c.url.includes('library.json'))).toBeUndefined();
  });

  it('requires a path', async () => {
    const publisher = createGithubPublisher({ repo: REPO, token: TOKEN, fetch: fakeFetch([]) });
    await expect(deleteFileFromGithub(publisher, {})).rejects.toThrow(/path/);
  });
});

// --- Reading staged bytes back -------------------------------------------------

describe('getFileBase64', () => {
  it('returns the inline base64 the Contents API gives for a small file', async () => {
    const fetchImpl = fakeFetch([
      ['contents/submissions/pending/sub-1__a.pdf', {
        status: 200,
        json: { sha: 'blob-sha', size: 12, encoding: 'base64', content: 'SGVsbG8=\n' }
      }]
    ]);
    const publisher = createGithubPublisher({ repo: REPO, token: TOKEN, fetch: fetchImpl });

    const file = await publisher.getFileBase64('submissions/pending/sub-1__a.pdf');

    expect(file.exists).toBe(true);
    expect(file.sha).toBe('blob-sha');
    // Newlines in the API's wrapped base64 must be stripped before decoding.
    expect(base64ToText(file.base64)).toBe('Hello');
  });

  it('falls back to the blob API when the file is too big to inline', async () => {
    // Above ~1 MB the Contents API returns metadata with no content at all.
    const fetchImpl = fakeFetch([
      ['/contents/', { status: 200, json: { sha: 'big-sha', size: 2_000_000, encoding: 'none', content: '' } }],
      ['/git/blobs/big-sha', { status: 200, json: { sha: 'big-sha', size: 2_000_000, content: 'QmlnIGZpbGU=' } }]
    ]);
    const publisher = createGithubPublisher({ repo: REPO, token: TOKEN, fetch: fetchImpl });

    const file = await publisher.getFileBase64('submissions/pending/sub-1__big.pdf');

    expect(base64ToText(file.base64)).toBe('Big file');
    expect(file.size).toBe(2_000_000);
    expect(fetchImpl.calls.some(call => call.url.includes('/git/blobs/big-sha'))).toBe(true);
  });

  it('reports a missing file instead of throwing', async () => {
    const publisher = createGithubPublisher({ repo: REPO, token: TOKEN, fetch: fakeFetch([]) });
    const file = await publisher.getFileBase64('submissions/pending/gone.pdf');
    expect(file).toEqual({ exists: false, sha: '', size: 0, base64: '' });
  });

  it('surfaces a real API failure', async () => {
    const publisher = createGithubPublisher({
      repo: REPO,
      token: TOKEN,
      fetch: fakeFetch([['/contents/', { status: 500, json: { message: 'Server Error' } }]])
    });
    await expect(publisher.getFileBase64('submissions/pending/a.pdf')).rejects.toThrow(GithubPublishError);
  });
});

// --- Concurrent edits to one JSON file -----------------------------------------

describe('commitJsonWithRetry', () => {
  /** A queue.json that starts at `text` and accepts conflicting writes. */
  function jsonRepo({ text = '[]', exists = true, conflictsBeforeSuccess = 0 } = {}) {
    const state = { text, exists, sha: 'sha-0', writes: 0, conflicts: 0 };
    const routes = [
      [(url, options) => url.includes('/contents/') && (options.method || 'GET') === 'GET', () => (
        state.exists
          ? { status: 200, json: { sha: state.sha, encoding: 'base64', content: textToBase64(state.text) } }
          : { status: 404, json: { message: 'Not Found' } }
      )],
      [(url, options) => url.includes('/contents/') && options.method === 'PUT', (url, options) => {
        if (state.conflicts < conflictsBeforeSuccess) {
          state.conflicts += 1;
          // Someone else committed first; GitHub rejects our stale sha.
          state.text = '[{"id":"other","submittedAt":"2026-01-01T00:00:00.000Z"}]';
          state.sha = `sha-${state.conflicts}`;
          state.exists = true;
          return { status: 409, json: { message: 'is at 1234 but expected 5678' } };
        }
        state.writes += 1;
        state.text = base64ToText(JSON.parse(options.body).content);
        state.sha = `sha-written-${state.writes}`;
        state.exists = true;
        return { status: 200, json: { content: { sha: state.sha }, commit: { html_url: 'https://github.com/x/commit/c1' } } };
      }]
    ];
    return { state, routes };
  }

  it('reads, transforms and commits in one pass when nothing conflicts', async () => {
    const { state, routes } = jsonRepo({ text: '[]' });
    const publisher = createGithubPublisher({ repo: REPO, token: TOKEN, fetch: fakeFetch(routes) });

    const result = await commitJsonWithRetry(publisher, {
      path: 'submissions/queue.json',
      message: 'Queue a submission',
      transform: current => `${current.trim()}added`
    });

    expect(result.changed).toBe(true);
    expect(state.writes).toBe(1);
    expect(state.text).toBe('[]added');
  });

  it('re-reads and re-applies the transform when another device commits first', async () => {
    // This is the two-teachers-at-once case: the second write must not
    // clobber the first, it must merge into whatever is now in the repo.
    const { state, routes } = jsonRepo({ text: '[]', conflictsBeforeSuccess: 1 });
    const publisher = createGithubPublisher({ repo: REPO, token: TOKEN, fetch: fakeFetch(routes) });

    const result = await commitJsonWithRetry(publisher, {
      path: 'submissions/queue.json',
      message: 'Queue a submission',
      transform: current => mergeQueueEntry(current, { id: 'mine', submittedAt: '2026-02-01T00:00:00.000Z' })
    });

    expect(result.changed).toBe(true);
    const ids = JSON.parse(state.text).map(entry => entry.id);
    expect(ids).toContain('mine');
    expect(ids).toContain('other');
  });

  it('retries a 422 stale-sha rejection too', async () => {
    const state = { attempts: 0, text: '[]' };
    const routes = [
      [(url, options) => (options.method || 'GET') === 'GET', () => ({
        status: 200, json: { sha: 'sha-x', encoding: 'base64', content: textToBase64(state.text) }
      })],
      [(url, options) => options.method === 'PUT', () => {
        state.attempts += 1;
        return state.attempts === 1
          ? { status: 422, json: { message: 'does not match' } }
          : { status: 200, json: { content: { sha: 's' }, commit: { html_url: 'u' } } };
      }]
    ];
    const publisher = createGithubPublisher({ repo: REPO, token: TOKEN, fetch: fakeFetch(routes) });

    await expect(commitJsonWithRetry(publisher, {
      path: 'submissions/queue.json',
      message: 'retry',
      transform: () => '[]'
    })).resolves.toMatchObject({ changed: true });
    expect(state.attempts).toBe(2);
  });

  it('gives up after the configured number of attempts', async () => {
    const { routes } = jsonRepo({ conflictsBeforeSuccess: 99 });
    const publisher = createGithubPublisher({ repo: REPO, token: TOKEN, fetch: fakeFetch(routes) });

    await expect(commitJsonWithRetry(publisher, {
      path: 'submissions/queue.json',
      message: 'doomed',
      transform: current => `${current}x`,
      attempts: 2
    })).rejects.toThrow(GithubPublishError);
  });

  it('does not retry an error that retrying cannot fix', async () => {
    const calls = { puts: 0 };
    const routes = [
      [(url, options) => (options.method || 'GET') === 'GET', { status: 404, json: { message: 'Not Found' } }],
      [(url, options) => options.method === 'PUT', () => {
        calls.puts += 1;
        return { status: 403, json: { message: 'Resource not accessible by personal access token' } };
      }]
    ];
    const publisher = createGithubPublisher({ repo: REPO, token: TOKEN, fetch: fakeFetch(routes) });

    await expect(commitJsonWithRetry(publisher, {
      path: 'submissions/queue.json',
      message: 'forbidden',
      transform: () => '[]'
    })).rejects.toThrow(/permission|access/i);
    expect(calls.puts).toBe(1);
  });

  it('skips the commit when the transform returns null', async () => {
    // patchQueueEntry returns null when the entry is not there — committing
    // an unchanged file would just be noise in the history.
    const { state, routes } = jsonRepo({ text: '[]' });
    const publisher = createGithubPublisher({ repo: REPO, token: TOKEN, fetch: fakeFetch(routes) });

    const result = await commitJsonWithRetry(publisher, {
      path: 'submissions/queue.json',
      message: 'nothing to do',
      transform: () => null
    });

    expect(result.changed).toBe(false);
    expect(state.writes).toBe(0);
  });

  it('creates the file when the repository has no queue yet', async () => {
    const { state, routes } = jsonRepo({ exists: false });
    const publisher = createGithubPublisher({ repo: REPO, token: TOKEN, fetch: fakeFetch(routes) });

    await commitJsonWithRetry(publisher, {
      path: 'submissions/queue.json',
      message: 'first submission',
      transform: current => mergeQueueEntry(current, { id: 'first', submittedAt: '2026-02-01T00:00:00.000Z' })
    });

    expect(JSON.parse(state.text).map(entry => entry.id)).toEqual(['first']);
  });
});
