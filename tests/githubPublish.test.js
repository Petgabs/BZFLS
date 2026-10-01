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
  createGithubPublisher,
  publishSubmissionToGithub
} from '../assets/js/lib/githubPublish.js';
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
