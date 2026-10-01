// ---------------------------------------------------------------------------
// Cross-device review queue.
//
// A teacher's upload used to live only in the browser that made it, which
// meant an administrator could only ever approve submissions made on their
// own device. Everyone else's work was invisible.
//
// So an upload now goes straight to the repository — but into a staging area,
// not into the library:
//
//   submissions/pending/<id>__<file>   the bytes, waiting for review
//   submissions/queue.json             the metadata + status of every upload
//
// The public library is built from `apps/` alone (see apps.json), so nothing
// in `submissions/` is listed, searchable or linked anywhere on the site
// until an administrator approves it. Approval is what moves the file:
//
//   submissions/pending/… ──approve──▶ apps/… + library.json  (+ queue entry
//                                       marked approved, staging file deleted)
//   submissions/pending/… ──decline──▶ deleted, queue entry marked rejected
//
// Because the queue lives in the repository, every signed-in device sees the
// same list: a teacher can submit on a classroom laptop and the administrator
// approves it from home.
//
// Pure functions only — no DOM, no fetch, no storage — so the whole queue
// lifecycle is unit-testable. The interactive side lives in app.js.
// ---------------------------------------------------------------------------

/** Where the queue index lives in the repository. */
export const QUEUE_PATH = 'submissions/queue.json';
/** Folder holding the bytes of uploads that are still awaiting review. */
export const PENDING_DIR = 'submissions/pending';

/** Statuses a queue entry can carry. */
export const QUEUE_STATUSES = ['pending', 'approved', 'rejected'];

/**
 * Make a file name safe to use as a repository path segment: no directory
 * separators, no traversal, no leading dots, and short enough for any
 * filesystem a contributor might clone onto.
 */
export function safeFileName(name) {
  const cleaned = String(name || '')
    .replace(/[\\/]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/^[.\s]+/, '')
    .trim();
  const fallback = cleaned || 'upload';
  return fallback.length > 120 ? fallback.slice(-120) : fallback;
}

/**
 * Staging path for a submission's bytes. The id prefix keeps two teachers
 * uploading `worksheet.pdf` on the same morning from colliding.
 */
export function pendingPathFor(record) {
  // Ids are generated as `sub-<timestamp>-<random>`, so dots are never needed
  // and dropping them makes traversal impossible by construction.
  const id = String(record?.id || '').replace(/[^A-Za-z0-9_-]/g, '') || 'upload';
  return `${PENDING_DIR}/${id}__${safeFileName(record?.fileName)}`;
}

/** The metadata-only entry stored in queue.json (never the file bytes). */
export function queueEntryFromSubmission(record, extra = {}) {
  return {
    id: record.id,
    path: extra.path || pendingPathFor(record),
    fileName: record.fileName,
    size: Number(record.size) || 0,
    mime: record.mime || '',

    title: record.title || '',
    description: record.description || '',
    subject: record.subject || '',
    years: Array.isArray(record.years) ? record.years : [],
    topic: record.topic || '',
    resourceType: record.resourceType || '',
    language: record.language || '',
    owner: record.owner || '',
    department: record.department || '',
    academicYear: record.academicYear || '',
    keywords: Array.isArray(record.keywords) ? record.keywords : [],
    visibility: record.visibility || 'public',
    version: record.version || '',
    reviewDate: record.reviewDate || '',
    licence: record.licence || '',
    accessibility: record.accessibility || '',

    submittedBy: record.submittedBy || 'teacher',
    submittedAt: record.submittedAt || new Date().toISOString(),
    status: QUEUE_STATUSES.includes(record.status) ? record.status : 'pending',
    reviewedAt: record.reviewedAt || '',
    reviewedBy: record.reviewedBy || '',
    reviewNote: record.reviewNote || '',

    published: Boolean(record.published),
    publishedPath: record.publishedPath || '',
    commitUrl: record.commitUrl || '',
    ...extra
  };
}

/**
 * Turn a queue entry back into the submission record shape the review UI
 * already understands. `origin: 'cloud'` marks a record whose bytes live in
 * the repository rather than in this browser.
 */
export function submissionFromQueueEntry(entry) {
  return {
    id: entry.id,
    fileName: entry.fileName || '',
    size: Number(entry.size) || 0,
    mime: entry.mime || '',

    title: entry.title || '',
    description: entry.description || '',
    subject: entry.subject || '',
    years: Array.isArray(entry.years) ? entry.years : [],
    topic: entry.topic || '',
    resourceType: entry.resourceType || '',
    language: entry.language || '',
    owner: entry.owner || '',
    department: entry.department || '',
    academicYear: entry.academicYear || '',
    keywords: Array.isArray(entry.keywords) ? entry.keywords : [],
    visibility: entry.visibility || 'public',
    version: entry.version || '',
    reviewDate: entry.reviewDate || '',
    licence: entry.licence || '',
    accessibility: entry.accessibility || '',

    submittedBy: entry.submittedBy || 'teacher',
    submittedAt: entry.submittedAt || '',
    status: QUEUE_STATUSES.includes(entry.status) ? entry.status : 'pending',
    reviewedAt: entry.reviewedAt || '',
    reviewedBy: entry.reviewedBy || '',
    reviewNote: entry.reviewNote || '',

    published: Boolean(entry.published),
    publishedPath: entry.publishedPath || '',
    commitUrl: entry.commitUrl || '',

    // The bytes are in the repository, not in this browser.
    origin: 'cloud',
    storage: 'cloud',
    inlineData: null,
    cloudPath: entry.path || '',
    cloudQueued: true
  };
}

/** Parse queue.json; returns [] for a missing, empty or unusable file. */
export function parseQueue(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = Array.isArray(data) ? data : Array.isArray(data?.submissions) ? data.submissions : null;
  if (!list) return [];
  return list.filter(entry => entry && typeof entry === 'object' && entry.id);
}

/** The exact JSON text to commit (newest first, 2-space indent, newline). */
export function serialiseQueue(entries) {
  const ordered = [...(entries || [])].sort((a, b) =>
    String(b?.submittedAt || '').localeCompare(String(a?.submittedAt || ''))
  );
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/**
 * Add or replace one entry in the text of queue.json.
 * Pure: current text in, new text out — so a commit is a read + transform.
 */
export function mergeQueueEntry(currentText, entry) {
  if (!entry?.id) throw new Error('A queue entry needs an id.');
  const entries = parseQueue(currentText).filter(item => item.id !== entry.id);
  entries.push(entry);
  return serialiseQueue(entries);
}

/**
 * Patch the fields of one entry, leaving the rest untouched. Returns the new
 * text, or null when the entry is not there (so the caller can skip a no-op
 * commit).
 */
export function patchQueueEntry(currentText, id, changes) {
  const entries = parseQueue(currentText);
  const index = entries.findIndex(entry => entry.id === id);
  if (index === -1) return null;
  entries[index] = { ...entries[index], ...changes };
  return serialiseQueue(entries);
}

/**
 * Drop one entry. Returns the new text, or null when there was nothing to
 * remove.
 */
export function removeQueueEntry(currentText, id) {
  const entries = parseQueue(currentText);
  const remaining = entries.filter(entry => entry.id !== id);
  if (remaining.length === entries.length) return null;
  return serialiseQueue(remaining);
}

/**
 * Combine this browser's submissions with the queue from the repository.
 *
 * The repository is authoritative for the *workflow* (status, who reviewed
 * it, whether it is published) because that is what other devices change.
 * The browser is authoritative for *where the bytes are*, so a teacher who
 * uploaded on this device keeps a local preview even after the queue entry
 * comes back from GitHub.
 *
 * @param {Array} local  Submissions from localStorage.
 * @param {Array} cloud  Entries parsed from queue.json.
 */
export function mergeSubmissionLists(local, cloud) {
  const merged = new Map();

  for (const record of local || []) {
    if (record?.id) merged.set(record.id, { ...record });
  }

  for (const entry of cloud || []) {
    if (!entry?.id) continue;
    const incoming = submissionFromQueueEntry(entry);
    const existing = merged.get(entry.id);

    if (!existing) {
      merged.set(entry.id, incoming);
      continue;
    }

    merged.set(entry.id, {
      ...existing,
      // Workflow state follows the repository.
      status: incoming.status,
      reviewedAt: incoming.reviewedAt,
      reviewedBy: incoming.reviewedBy,
      reviewNote: incoming.reviewNote,
      published: incoming.published,
      publishedPath: incoming.publishedPath,
      commitUrl: incoming.commitUrl || existing.commitUrl || '',
      cloudPath: incoming.cloudPath,
      cloudQueued: true,
      // Local bytes win: 'idb' / 'inline' keep previews working offline.
      storage: existing.storage && existing.storage !== 'cloud' ? existing.storage : 'cloud',
      origin: existing.storage && existing.storage !== 'cloud' ? (existing.origin || 'local') : 'cloud'
    });
  }

  return [...merged.values()].sort((a, b) =>
    String(b?.submittedAt || '').localeCompare(String(a?.submittedAt || ''))
  );
}

/** True when a record's bytes live in the repository's staging folder. */
export function isCloudBacked(record) {
  return Boolean(record?.cloudPath);
}

/** Count how many entries are waiting for an administrator. */
export function pendingCount(entries) {
  return (entries || []).filter(entry => entry?.status === 'pending').length;
}
