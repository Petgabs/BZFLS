// ---------------------------------------------------------------------------
// GitHub auto-publish client (Contents API).
//
// Lets the administrator publish an approved teacher submission to the public
// repository without leaving the site: the file is committed into `apps/` and
// its curated metadata is merged into `library.json`, exactly as the manual
// copy/paste flow would do by hand.
//
// Authentication uses a fine-grained Personal Access Token scoped to the one
// repository with the single "Contents: Read and write" permission. The token
// is supplied by the administrator at runtime and kept in sessionStorage only
// (see app.js) — it is never embedded in this public site, never written to
// localStorage, and only ever sent to api.github.com.
//
// Everything here takes `fetch` as an injectable dependency so the whole
// publish pipeline is unit-testable without network access.
// ---------------------------------------------------------------------------

const API_BASE = 'https://api.github.com';
const API_HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28'
};

/** Error with a message that is safe and useful to show the administrator. */
export class GithubPublishError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'GithubPublishError';
    this.status = status;
  }
}

/**
 * Normalise a pasted token: trims whitespace and rejects obviously wrong
 * values (empty, contains spaces). Fine-grained tokens start with
 * `github_pat_`, classic ones with `ghp_` — both work with the Contents API,
 * so the shape is advisory, not enforced.
 */
export function normaliseToken(value) {
  const token = String(value || '').trim();
  if (!token || /\s/.test(token)) return '';
  return token;
}

/** True when the token looks like a fine-grained PAT (the recommended kind). */
export function isFineGrainedToken(token) {
  return /^github_pat_/.test(String(token || ''));
}

function authHeaders(token) {
  return { ...API_HEADERS, Authorization: `Bearer ${token}` };
}

/** `apps/My File.pdf` → `apps/My%20File.pdf` (keeps the `/` separators). */
export function encodeRepoPath(path) {
  return String(path || '')
    .split('/')
    .map(encodeURIComponent)
    .join('/');
}

async function apiError(response, fallback) {
  let message = fallback;
  try {
    const data = await response.json();
    if (data?.message) message = data.message;
  } catch {
    /* Non-JSON body: keep the fallback message. */
  }
  return new GithubPublishError(message, response.status);
}

function friendly(error) {
  if (!(error instanceof GithubPublishError)) return error;
  const hints = {
    401: 'GitHub rejected the token. It may have expired or been revoked — create a new fine-grained token and reconnect.',
    403: 'The token is not allowed to write to this repository. Check it grants “Contents: Read and write” on exactly this repository.',
    404: 'GitHub could not find the repository (or the token cannot see it). Check the Owner/Repo setting and the token’s repository access.',
    409: 'GitHub reported a conflict — someone else changed the repository at the same time. Try again.',
    422: 'GitHub rejected the commit. The file may be too large for the Contents API (about 50 MB) or the branch name is wrong.'
  };
  const hint = hints[error.status];
  return hint ? new GithubPublishError(`${hint} (GitHub said: ${error.message})`, error.status) : error;
}

// --- Encoding helpers --------------------------------------------------------

/** Blob/File → raw base64 (no data URL prefix). Chunked, so 8 MB files are fine. */
export async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** UTF-8 text → base64, for committing library.json. */
export function textToBase64(text) {
  const bytes = new TextEncoder().encode(String(text ?? ''));
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Base64 (as returned by the Contents API, may contain newlines) → UTF-8 text. */
export function base64ToText(base64) {
  const binary = atob(String(base64 || '').replace(/\s+/g, ''));
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// --- library.json merging ----------------------------------------------------

/**
 * Merge one curated entry into the text of library.json.
 *
 * Pure: takes the current file text, returns the new text. Preserves every
 * existing key (including the leading `_comment` block) and the insertion
 * order; an existing entry for the same path is replaced. Output is the same
 * 2-space-indented JSON the file already uses.
 *
 * @param {string} currentText  Current library.json content ('' for a new file).
 * @param {string} key          Repository path, e.g. 'apps/16G.pdf'.
 * @param {object} entry        Curated metadata (from overrideFromSubmission).
 */
export function mergeLibraryEntry(currentText, key, entry) {
  let data = {};
  const text = String(currentText || '').trim();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (error) {
      throw new GithubPublishError(
        'library.json in the repository is not valid JSON, so the metadata cannot be merged automatically. Fix the file on GitHub first.',
        0
      );
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new GithubPublishError('library.json must contain a JSON object of path → metadata entries.', 0);
    }
  }
  data[key] = entry;
  return `${JSON.stringify(data, null, 2)}\n`;
}

/**
 * Remove one entry from the text of library.json, the inverse of
 * mergeLibraryEntry(). Pure: takes the current file text, returns the new
 * text, or `null` when there is nothing to change (missing/empty file, or
 * the key is not present) so the caller can skip a no-op commit.
 *
 * @param {string} currentText  Current library.json content.
 * @param {string} key          Repository path, e.g. 'apps/16G.pdf'.
 */
export function removeLibraryEntry(currentText, key) {
  const text = String(currentText || '').trim();
  if (!text) return null;
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new GithubPublishError(
      'library.json in the repository is not valid JSON, so the entry cannot be removed automatically. Fix the file on GitHub first.',
      0
    );
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new GithubPublishError('library.json must contain a JSON object of path → metadata entries.', 0);
  }
  if (!(key in data)) return null;
  delete data[key];
  return `${JSON.stringify(data, null, 2)}\n`;
}

// --- Client -------------------------------------------------------------------

/**
 * Create a client bound to one repository + token.
 *
 * @param {object} config { repo: 'Owner/Repo', token, branch = 'main', fetch }
 */
export function createGithubPublisher(config = {}) {
  const repo = String(config.repo || '').trim();
  const token = normaliseToken(config.token);
  const branch = String(config.branch || 'main').trim() || 'main';
  const fetchImpl = config.fetch || globalThis.fetch?.bind(globalThis);

  if (!repo) throw new GithubPublishError('No repository is configured.', 0);
  if (!token) throw new GithubPublishError('No GitHub token is connected.', 0);
  if (!fetchImpl) throw new GithubPublishError('fetch is unavailable in this environment.', 0);

  const contentsUrl = path => `${API_BASE}/repos/${encodeRepoPath(repo)}/contents/${encodeRepoPath(path)}`;

  return {
    repo,
    branch,

    /**
     * Check the token works and can write to the repository.
     * Returns { login, repoFullName, canWrite }.
     */
    async verify() {
      let response;
      try {
        response = await fetchImpl(`${API_BASE}/repos/${encodeRepoPath(repo)}`, {
          headers: authHeaders(token),
          cache: 'no-store'
        });
      } catch {
        throw new GithubPublishError('GitHub could not be reached. Check the connection and try again.', 0);
      }
      if (!response.ok) throw friendly(await apiError(response, `GitHub returned ${response.status}`));
      const data = await response.json();
      const canWrite = Boolean(data?.permissions?.push);
      if (!canWrite) {
        throw new GithubPublishError(
          'The token can read the repository but not write to it. Grant “Contents: Read and write” when creating the fine-grained token.',
          403
        );
      }

      // The login is cosmetic (shown as "Connected as …"); a fine-grained
      // token without "account" permissions may not expose it, so a failure
      // here is not an error.
      let login = '';
      try {
        const userResponse = await fetchImpl(`${API_BASE}/user`, { headers: authHeaders(token), cache: 'no-store' });
        if (userResponse.ok) login = (await userResponse.json())?.login || '';
      } catch {
        /* Cosmetic only. */
      }

      return { login, repoFullName: data?.full_name || repo, canWrite };
    },

    /**
     * Fetch a file's current blob SHA and decoded text.
     * Returns { exists, sha, text } — { exists: false } for a missing file.
     */
    async getFile(path) {
      let response;
      try {
        response = await fetchImpl(`${contentsUrl(path)}?ref=${encodeURIComponent(branch)}`, {
          headers: authHeaders(token),
          cache: 'no-store'
        });
      } catch {
        throw new GithubPublishError('GitHub could not be reached. Check the connection and try again.', 0);
      }
      if (response.status === 404) return { exists: false, sha: '', text: '' };
      if (!response.ok) throw friendly(await apiError(response, `GitHub returned ${response.status}`));
      const data = await response.json();
      return {
        exists: true,
        sha: data?.sha || '',
        text: data?.encoding === 'base64' ? base64ToText(data.content) : String(data?.content || '')
      };
    },

    /**
     * Fetch a file's metadata and its raw base64 content, without decoding
     * it to text — the way to read an uploaded PDF or Word document back out
     * of the repository.
     *
     * The Contents API inlines `content` only for files under 1 MB; above
     * that it returns an empty string and the bytes must come from the Git
     * blob API (good to 100 MB), so both paths are handled here.
     *
     * Returns { exists, sha, size, base64 }.
     */
    async getFileBase64(path) {
      let response;
      try {
        response = await fetchImpl(`${contentsUrl(path)}?ref=${encodeURIComponent(branch)}`, {
          headers: authHeaders(token),
          cache: 'no-store'
        });
      } catch {
        throw new GithubPublishError('GitHub could not be reached. Check the connection and try again.', 0);
      }
      if (response.status === 404) return { exists: false, sha: '', size: 0, base64: '' };
      if (!response.ok) throw friendly(await apiError(response, `GitHub returned ${response.status}`));

      const data = await response.json();
      const sha = data?.sha || '';
      const inline = data?.encoding === 'base64' ? String(data.content || '').replace(/\s+/g, '') : '';
      if (inline) return { exists: true, sha, size: Number(data?.size) || 0, base64: inline };

      let blobResponse;
      try {
        blobResponse = await fetchImpl(`${API_BASE}/repos/${encodeRepoPath(repo)}/git/blobs/${encodeURIComponent(sha)}`, {
          headers: authHeaders(token),
          cache: 'no-store'
        });
      } catch {
        throw new GithubPublishError('GitHub could not be reached. Check the connection and try again.', 0);
      }
      if (!blobResponse.ok) throw friendly(await apiError(blobResponse, `GitHub returned ${blobResponse.status}`));
      const blob = await blobResponse.json();

      return {
        exists: true,
        sha,
        size: Number(data?.size) || Number(blob?.size) || 0,
        base64: String(blob?.content || '').replace(/\s+/g, '')
      };
    },

    /**
     * Create or update a file via the Contents API.
     *
     * @param {object} options { path, contentBase64, message, sha }  `sha` is
     *        required when updating an existing file.
     * Returns { commitSha, commitUrl, contentSha, htmlUrl }.
     */
    async putFile(options) {
      const body = {
        message: String(options.message || 'Update from School Cloud System'),
        content: String(options.contentBase64 || ''),
        branch
      };
      if (options.sha) body.sha = options.sha;

      let response;
      try {
        response = await fetchImpl(contentsUrl(options.path), {
          method: 'PUT',
          headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
      } catch {
        throw new GithubPublishError('GitHub could not be reached. Check the connection and try again.', 0);
      }
      if (!response.ok) throw friendly(await apiError(response, `GitHub returned ${response.status}`));
      const data = await response.json();
      return {
        commitSha: data?.commit?.sha || '',
        commitUrl: data?.commit?.html_url || '',
        contentSha: data?.content?.sha || '',
        htmlUrl: data?.content?.html_url || ''
      };
    },

    /**
     * Delete a file via the Contents API.
     *
     * @param {object} options { path, sha, message }  `sha` is the current
     *        blob SHA (from getFile()) and is required by GitHub.
     * Returns { commitSha, commitUrl }.
     */
    async deleteFile(options) {
      const body = {
        message: String(options.message || 'Delete via School Cloud System'),
        sha: String(options.sha || ''),
        branch
      };
      if (!body.sha) {
        throw new GithubPublishError('Missing the file SHA, so GitHub cannot confirm which version to delete.', 0);
      }

      let response;
      try {
        response = await fetchImpl(contentsUrl(options.path), {
          method: 'DELETE',
          headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
      } catch {
        throw new GithubPublishError('GitHub could not be reached. Check the connection and try again.', 0);
      }
      if (!response.ok) throw friendly(await apiError(response, `GitHub returned ${response.status}`));
      const data = await response.json();
      return {
        commitSha: data?.commit?.sha || '',
        commitUrl: data?.commit?.html_url || ''
      };
    }
  };
}

// --- Conflict-safe JSON updates -------------------------------------------------

/**
 * Read a JSON file, transform its text, and commit the result — retrying
 * when someone else committed in between.
 *
 * The review queue is a single shared file that several teachers can append
 * to at the same moment. Whoever commits second would get a stale-SHA error
 * and silently lose their entry, so the read/transform/write cycle is redone
 * against the newest version instead.
 *
 * @param {object} publisher  From createGithubPublisher().
 * @param {object} options {
 *          path,       file to update
 *          message,    commit message
 *          transform,  (currentText) => newText | null  (null = nothing to do)
 *          attempts    how many times to retry a conflict (default 3)
 *        }
 * Returns { changed, commitUrl, contentSha }.
 */
export async function commitJsonWithRetry(publisher, options = {}) {
  const attempts = Math.max(1, Number(options.attempts) || 3);
  let lastError;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const current = await publisher.getFile(options.path);
    const nextText = await options.transform(current.exists ? current.text : '');
    if (nextText === null || nextText === undefined) {
      return { changed: false, commitUrl: '', contentSha: current.sha || '' };
    }

    try {
      const result = await publisher.putFile({
        path: options.path,
        contentBase64: textToBase64(nextText),
        sha: current.exists ? current.sha : '',
        message: options.message
      });
      return { changed: true, commitUrl: result.commitUrl, contentSha: result.contentSha };
    } catch (error) {
      // 409 (conflict) and 422 (stale sha) both mean "re-read and try again".
      const retryable = error instanceof GithubPublishError && (error.status === 409 || error.status === 422);
      if (!retryable || attempt === attempts - 1) throw error;
      lastError = error;
    }
  }

  throw lastError;
}

// --- One-call publish pipeline -------------------------------------------------

/**
 * Publish an approved submission: commit the file into `apps/` and merge its
 * curated metadata into `library.json`, as two commits on the configured
 * branch. Mirrors the manual flow exactly, so the result is indistinguishable
 * from a hand-made publish.
 *
 * @param {object} publisher  From createGithubPublisher().
 * @param {object} input      {
 *          fileName,          e.g. '16G.pdf' → committed as 'apps/16G.pdf'
 *          fileBase64,        raw base64 of the file bytes
 *          entry,             library.json metadata (overrideFromSubmission)
 *          title,             used in the commit messages
 *          overwrite          allow replacing an existing apps/ file
 *        }
 * Returns { path, fileCommitUrl, libraryCommitUrl, commitUrl, replaced }.
 */
export async function publishSubmissionToGithub(publisher, input) {
  const fileName = String(input.fileName || '').trim();
  if (!fileName || fileName.includes('/') || fileName.includes('\\') || fileName.includes('..')) {
    throw new GithubPublishError('The submission has an unusable file name.', 0);
  }
  const path = `apps/${fileName}`;
  const title = String(input.title || fileName);

  // 1. The file itself. If something already lives at that path we need its
  //    SHA to replace it — and the caller's explicit consent.
  const existing = await publisher.getFile(path);
  if (existing.exists && !input.overwrite) {
    throw new GithubPublishError(
      `“${path}” already exists in the repository. Approve again and confirm to replace it, or rename the file and re-submit.`,
      409
    );
  }

  const fileResult = await publisher.putFile({
    path,
    contentBase64: input.fileBase64,
    sha: existing.exists ? existing.sha : '',
    message: existing.exists
      ? `Update ${path}: ${title} (via School Cloud System)`
      : `Publish ${path}: ${title} (via School Cloud System)`
  });

  // 2. The curated metadata. library.json may legitimately be missing — the
  //    site treats it as optional — so a missing file simply starts a new one.
  const library = await publisher.getFile('library.json');
  const mergedText = mergeLibraryEntry(library.text, path, input.entry || {});
  const libraryResult = await publisher.putFile({
    path: 'library.json',
    contentBase64: textToBase64(mergedText),
    sha: library.exists ? library.sha : '',
    message: `Add curated metadata for ${path} (via School Cloud System)`
  });

  return {
    path,
    replaced: existing.exists,
    fileCommitUrl: fileResult.commitUrl,
    libraryCommitUrl: libraryResult.commitUrl,
    // The metadata commit is the tip of the publish; link to it by default.
    commitUrl: libraryResult.commitUrl || fileResult.commitUrl
  };
}

/**
 * Delete a previously published file from the repository: removes it from
 * `apps/` and drops its entry from `library.json`, as up to two commits on
 * the configured branch. Mirrors publishSubmissionToGithub() in reverse, so
 * the admin dashboard can offer a genuine one-click "Delete from GitHub"
 * next to every cloud file, instead of only a link to github.com.
 *
 * @param {object} publisher  From createGithubPublisher().
 * @param {object} input      { path }  Repository path, e.g. 'apps/16G.pdf'.
 * Returns { path, fileCommitUrl, libraryCommitUrl, commitUrl, existed }.
 */
export async function deleteFileFromGithub(publisher, input) {
  const path = String(input?.path || '').trim().replace(/^\/+/, '');
  if (!path) throw new GithubPublishError('No file path was given to delete.', 0);

  const existing = await publisher.getFile(path);
  let fileResult = { commitUrl: '' };
  if (existing.exists) {
    fileResult = await publisher.deleteFile({
      path,
      sha: existing.sha,
      message: `Delete ${path} (via School Cloud System)`
    });
  }

  // Metadata clean-up is best-effort: library.json may be missing, may not
  // reference this path, or the delete may be the only thing the caller
  // wants — any of those is a no-op, not a failure.
  let libraryResult = { commitUrl: '' };
  const library = await publisher.getFile('library.json');
  if (library.exists) {
    const mergedText = removeLibraryEntry(library.text, path);
    if (mergedText !== null) {
      libraryResult = await publisher.putFile({
        path: 'library.json',
        contentBase64: textToBase64(mergedText),
        sha: library.sha,
        message: `Remove metadata for ${path} (via School Cloud System)`
      });
    }
  }

  return {
    path,
    existed: existing.exists,
    fileCommitUrl: fileResult.commitUrl,
    libraryCommitUrl: libraryResult.commitUrl,
    commitUrl: libraryResult.commitUrl || fileResult.commitUrl
  };
}
