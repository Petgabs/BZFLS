// ---------------------------------------------------------------------------
// The cross-device review queue.
//
// A teacher uploads on a classroom laptop; the administrator approves from
// home. That only works because the queue lives in the repository rather than
// in one browser, so these tests lock the two things that makes fragile:
//
//   1. the staging paths and the exact bytes written to queue.json, and
//   2. the merge rule — the repository owns the *workflow*, the browser owns
//      *where the file bytes are* — which is what keeps a local preview alive
//      after a record round-trips through GitHub.
//
// Everything here is pure, so no network or storage is involved.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import {
  QUEUE_PATH,
  PENDING_DIR,
  QUEUE_STATUSES,
  safeFileName,
  pendingPathFor,
  queueEntryFromSubmission,
  submissionFromQueueEntry,
  parseQueue,
  serialiseQueue,
  mergeQueueEntry,
  patchQueueEntry,
  removeQueueEntry,
  mergeSubmissionLists,
  isCloudBacked,
  pendingCount
} from '../assets/js/lib/reviewQueue.js';
import { submissionFromDraft, emptyDraft } from '../assets/js/lib/submissions.js';

/** A submission shaped like the ones app.js stores. */
function submission(overrides = {}) {
  return {
    id: 'sub-1700000000000-abc',
    fileName: 'algebra-worksheet.pdf',
    size: 24576,
    mime: 'application/pdf',
    title: 'Algebra Worksheet',
    description: 'Practice questions.',
    subject: 'Mathematics',
    years: [10],
    topic: 'Quadratics',
    resourceType: 'Worksheet',
    language: 'English',
    owner: 'Ms Chen',
    keywords: ['algebra'],
    submittedBy: 'teacher',
    submittedAt: '2026-02-01T09:00:00.000Z',
    status: 'pending',
    storage: 'idb',
    ...overrides
  };
}

// --- Paths -------------------------------------------------------------------

describe('staging paths', () => {
  it('keeps the queue out of the published library', () => {
    // apps.json only lists files under apps/, so a staged upload is invisible.
    expect(QUEUE_PATH).toBe('submissions/queue.json');
    expect(PENDING_DIR).toBe('submissions/pending');
    expect(QUEUE_PATH.startsWith('apps/')).toBe(false);
    expect(PENDING_DIR.startsWith('apps/')).toBe(false);
  });

  it('prefixes the file with the submission id so two teachers cannot collide', () => {
    const a = pendingPathFor(submission({ id: 'sub-a', fileName: 'worksheet.pdf' }));
    const b = pendingPathFor(submission({ id: 'sub-b', fileName: 'worksheet.pdf' }));
    expect(a).toBe('submissions/pending/sub-a__worksheet.pdf');
    expect(b).toBe('submissions/pending/sub-b__worksheet.pdf');
    expect(a).not.toBe(b);
  });

  it('neutralises directory traversal in the uploaded file name', () => {
    expect(safeFileName('../../etc/passwd')).toBe('-.-etc-passwd');
    expect(safeFileName('a/b\\c.pdf')).toBe('a-b-c.pdf');
    expect(pendingPathFor({ id: 'x', fileName: '../../secret.pdf' }))
      .toBe('submissions/pending/x__-.-secret.pdf');
  });

  it('strips control characters, leading dots and blank names', () => {
    expect(safeFileName('  .hidden.pdf')).toBe('hidden.pdf');
    expect(safeFileName('bad\u0000name.pdf')).toBe('badname.pdf');
    expect(safeFileName('')).toBe('upload');
    expect(safeFileName(null)).toBe('upload');
  });

  it('truncates absurdly long names but keeps the extension', () => {
    const name = `${'x'.repeat(400)}.pdf`;
    const safe = safeFileName(name);
    expect(safe.length).toBe(120);
    expect(safe.endsWith('.pdf')).toBe(true);
  });

  it('sanitises the id too, so it can never escape the folder', () => {
    expect(pendingPathFor({ id: '../../../evil', fileName: 'a.pdf' }))
      .toBe('submissions/pending/evil__a.pdf');
    expect(pendingPathFor({}).startsWith('submissions/pending/')).toBe(true);
  });
});

// --- Entry shape -------------------------------------------------------------

describe('queue entries', () => {
  it('carries the metadata an administrator needs to review without the file', () => {
    const entry = queueEntryFromSubmission(submission());
    expect(entry).toMatchObject({
      id: 'sub-1700000000000-abc',
      path: 'submissions/pending/sub-1700000000000-abc__algebra-worksheet.pdf',
      fileName: 'algebra-worksheet.pdf',
      title: 'Algebra Worksheet',
      subject: 'Mathematics',
      years: [10],
      owner: 'Ms Chen',
      status: 'pending',
      published: false
    });
  });

  it('never carries the file bytes into queue.json', () => {
    const entry = queueEntryFromSubmission(submission({
      inlineData: 'data:application/pdf;base64,AAAA',
      storage: 'inline'
    }));
    expect(entry.inlineData).toBeUndefined();
    expect(JSON.stringify(entry)).not.toContain('base64');
  });

  it('defaults an unknown status to pending, so nothing auto-approves', () => {
    expect(queueEntryFromSubmission(submission({ status: 'approved' })).status).toBe('approved');
    expect(queueEntryFromSubmission(submission({ status: 'sneaky' })).status).toBe('pending');
    expect(queueEntryFromSubmission(submission({ status: undefined })).status).toBe('pending');
    expect(QUEUE_STATUSES).toEqual(['pending', 'approved', 'rejected']);
  });

  it('accepts a real draft-built submission', () => {
    const draft = {
      ...emptyDraft(),
      title: 'Forces Revision',
      subject: 'PHY',
      years: 'Year 11',
      owner: 'Mr Diaz'
    };
    const record = submissionFromDraft(draft, { name: 'forces.pdf', size: 100, type: 'application/pdf' });
    const entry = queueEntryFromSubmission(record);
    expect(entry.title).toBe('Forces Revision');
    expect(entry.subject).toBe('PHY');
    expect(entry.fileName).toBe('forces.pdf');
    expect(entry.status).toBe('pending');
  });

  it('round-trips back into a reviewable record pointing at the repository', () => {
    const entry = queueEntryFromSubmission(submission());
    const record = submissionFromQueueEntry(entry);
    expect(record.title).toBe('Algebra Worksheet');
    expect(record.origin).toBe('cloud');
    expect(record.storage).toBe('cloud');
    expect(record.cloudQueued).toBe(true);
    expect(record.cloudPath).toBe(entry.path);
    expect(record.inlineData).toBeNull();
  });

  it('lets the caller override the path (an id that was re-used, say)', () => {
    const entry = queueEntryFromSubmission(submission(), { path: 'submissions/pending/custom.pdf' });
    expect(entry.path).toBe('submissions/pending/custom.pdf');
  });
});

// --- Serialising -------------------------------------------------------------

describe('queue.json text', () => {
  it('parses an empty, missing or corrupt file as an empty queue', () => {
    expect(parseQueue('')).toEqual([]);
    expect(parseQueue('   ')).toEqual([]);
    expect(parseQueue(null)).toEqual([]);
    expect(parseQueue('not json')).toEqual([]);
    expect(parseQueue('{"nope":1}')).toEqual([]);
  });

  it('accepts both a bare array and a { submissions: [] } envelope', () => {
    expect(parseQueue('[{"id":"a"}]')).toHaveLength(1);
    expect(parseQueue('{"submissions":[{"id":"a"},{"id":"b"}]}')).toHaveLength(2);
  });

  it('drops entries with no id, which could never be matched again', () => {
    expect(parseQueue('[{"id":"a"},{"title":"orphan"},null,"x"]')).toEqual([{ id: 'a' }]);
  });

  it('writes newest-first, 2-space indented, newline-terminated JSON', () => {
    const text = serialiseQueue([
      { id: 'old', submittedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'new', submittedAt: '2026-03-01T00:00:00.000Z' }
    ]);
    expect(text.endsWith('\n')).toBe(true);
    expect(text).toContain('\n  {');
    expect(JSON.parse(text).map(entry => entry.id)).toEqual(['new', 'old']);
  });

  it('does not mutate the array it is given', () => {
    const entries = [{ id: 'a', submittedAt: '2026-01-01' }, { id: 'b', submittedAt: '2026-02-01' }];
    serialiseQueue(entries);
    expect(entries.map(entry => entry.id)).toEqual(['a', 'b']);
  });
});

// --- Transforms --------------------------------------------------------------

describe('queue transforms', () => {
  it('adds a submission to an empty queue', () => {
    const entry = queueEntryFromSubmission(submission());
    const text = mergeQueueEntry('', entry);
    expect(parseQueue(text)).toHaveLength(1);
    expect(parseQueue(text)[0].id).toBe(entry.id);
  });

  it('replaces rather than duplicates when the same id is submitted again', () => {
    const first = queueEntryFromSubmission(submission({ title: 'Draft' }));
    const second = queueEntryFromSubmission(submission({ title: 'Final' }));
    const text = mergeQueueEntry(mergeQueueEntry('', first), second);
    const entries = parseQueue(text);
    expect(entries).toHaveLength(1);
    expect(entries[0].title).toBe('Final');
  });

  it('keeps other teachers\u2019 submissions untouched', () => {
    const mine = queueEntryFromSubmission(submission({ id: 'mine', submittedAt: '2026-02-01T00:00:00.000Z' }));
    const theirs = queueEntryFromSubmission(submission({ id: 'theirs', submittedAt: '2026-01-01T00:00:00.000Z' }));
    const text = mergeQueueEntry(serialiseQueue([theirs]), mine);
    expect(parseQueue(text).map(entry => entry.id)).toEqual(['mine', 'theirs']);
  });

  it('refuses an entry with no id', () => {
    expect(() => mergeQueueEntry('[]', { title: 'x' })).toThrow(/id/i);
  });

  it('patches only the named entry', () => {
    const text = serialiseQueue([
      queueEntryFromSubmission(submission({ id: 'a' })),
      queueEntryFromSubmission(submission({ id: 'b' }))
    ]);
    const patched = patchQueueEntry(text, 'a', { status: 'approved', reviewedBy: 'administrator' });
    const entries = parseQueue(patched);
    expect(entries.find(entry => entry.id === 'a')).toMatchObject({
      status: 'approved',
      reviewedBy: 'administrator'
    });
    expect(entries.find(entry => entry.id === 'b').status).toBe('pending');
  });

  it('returns null for a patch with nothing to patch, so no empty commit happens', () => {
    expect(patchQueueEntry('[]', 'missing', { status: 'approved' })).toBeNull();
    expect(removeQueueEntry('[]', 'missing')).toBeNull();
  });

  it('removes an entry and leaves valid JSON behind', () => {
    const text = serialiseQueue([
      queueEntryFromSubmission(submission({ id: 'a' })),
      queueEntryFromSubmission(submission({ id: 'b' }))
    ]);
    const removed = removeQueueEntry(text, 'a');
    expect(parseQueue(removed).map(entry => entry.id)).toEqual(['b']);
    expect(removeQueueEntry(removed, 'b')).toBe('[]\n');
  });

  it('survives a hand-edited or truncated queue file without losing the new entry', () => {
    const entry = queueEntryFromSubmission(submission());
    const text = mergeQueueEntry('[{"id":"a", TRUNCATED', entry);
    expect(parseQueue(text).map(item => item.id)).toEqual([entry.id]);
  });
});

// --- Merging -----------------------------------------------------------------

describe('merging the repository queue into this browser', () => {
  it('shows uploads made on other devices', () => {
    const cloud = [queueEntryFromSubmission(submission({ id: 'remote', title: 'From the staffroom' }))];
    const merged = mergeSubmissionLists([], cloud);
    expect(merged).toHaveLength(1);
    expect(merged[0].title).toBe('From the staffroom');
    expect(merged[0].origin).toBe('cloud');
  });

  it('keeps local-only submissions that are not in the repository yet', () => {
    const local = [submission({ id: 'local-only' })];
    const merged = mergeSubmissionLists(local, []);
    expect(merged.map(record => record.id)).toEqual(['local-only']);
  });

  it('lets the repository win on workflow state', () => {
    // Approved by an administrator on another device: this browser must agree.
    const local = [submission({ id: 'shared', status: 'pending', published: false })];
    const cloud = [queueEntryFromSubmission(submission({
      id: 'shared',
      status: 'approved',
      reviewedBy: 'administrator',
      reviewedAt: '2026-02-02T10:00:00.000Z',
      published: true,
      publishedPath: 'apps/algebra-worksheet.pdf'
    }))];
    const merged = mergeSubmissionLists(local, cloud);
    expect(merged[0]).toMatchObject({
      status: 'approved',
      reviewedBy: 'administrator',
      published: true,
      publishedPath: 'apps/algebra-worksheet.pdf'
    });
  });

  it('lets the browser win on where the bytes are, so local previews survive', () => {
    const local = [submission({ id: 'shared', storage: 'idb' })];
    const cloud = [queueEntryFromSubmission(submission({ id: 'shared' }))];
    const merged = mergeSubmissionLists(local, cloud);
    expect(merged[0].storage).toBe('idb');
    expect(merged[0].cloudPath).toBe('submissions/pending/shared__algebra-worksheet.pdf');
    expect(merged[0].cloudQueued).toBe(true);
  });

  it('marks a record with no local bytes as cloud-backed', () => {
    const cloud = [queueEntryFromSubmission(submission({ id: 'shared' }))];
    const merged = mergeSubmissionLists([], cloud);
    expect(merged[0].storage).toBe('cloud');
    expect(isCloudBacked(merged[0])).toBe(true);
    expect(isCloudBacked(submission())).toBe(false);
  });

  it('sorts the whole queue newest first', () => {
    const local = [submission({ id: 'mid', submittedAt: '2026-02-01T00:00:00.000Z' })];
    const cloud = [
      queueEntryFromSubmission(submission({ id: 'oldest', submittedAt: '2026-01-01T00:00:00.000Z' })),
      queueEntryFromSubmission(submission({ id: 'newest', submittedAt: '2026-03-01T00:00:00.000Z' }))
    ];
    expect(mergeSubmissionLists(local, cloud).map(record => record.id))
      .toEqual(['newest', 'mid', 'oldest']);
  });

  it('is idempotent, so repeated refreshes cannot duplicate the queue', () => {
    const cloud = [queueEntryFromSubmission(submission({ id: 'shared' }))];
    const once = mergeSubmissionLists([submission({ id: 'shared' })], cloud);
    const twice = mergeSubmissionLists(once, cloud);
    expect(twice).toHaveLength(1);
    expect(twice).toEqual(once);
  });

  it('tolerates null, undefined and junk input', () => {
    expect(mergeSubmissionLists(null, null)).toEqual([]);
    expect(mergeSubmissionLists(undefined, undefined)).toEqual([]);
    expect(mergeSubmissionLists([{ noId: true }], [{ noId: true }])).toEqual([]);
  });

  it('counts only what is still waiting for a decision', () => {
    const entries = [
      queueEntryFromSubmission(submission({ id: 'a', status: 'pending' })),
      queueEntryFromSubmission(submission({ id: 'b', status: 'approved' })),
      queueEntryFromSubmission(submission({ id: 'c', status: 'rejected' })),
      queueEntryFromSubmission(submission({ id: 'd', status: 'pending' }))
    ];
    expect(pendingCount(entries)).toBe(2);
    expect(pendingCount([])).toBe(0);
    expect(pendingCount(null)).toBe(0);
  });
});

// --- The full lifecycle ------------------------------------------------------

describe('the review lifecycle', () => {
  it('runs submit → approve → publish end to end in the queue file', () => {
    const record = submission();

    // A teacher submits: the entry is pending and the bytes are staged.
    let text = mergeQueueEntry('', queueEntryFromSubmission(record, { path: pendingPathFor(record) }));
    expect(parseQueue(text)[0].status).toBe('pending');
    expect(pendingCount(parseQueue(text))).toBe(1);

    // Another device sees it and shows it for review.
    const onOtherDevice = mergeSubmissionLists([], parseQueue(text));
    expect(onOtherDevice[0].cloudPath).toBe('submissions/pending/sub-1700000000000-abc__algebra-worksheet.pdf');

    // The administrator approves and publishes: the staged path is cleared.
    text = patchQueueEntry(text, record.id, {
      status: 'approved',
      reviewedBy: 'administrator',
      reviewedAt: '2026-02-02T10:00:00.000Z',
      published: true,
      publishedPath: 'apps/algebra-worksheet.pdf',
      path: ''
    });
    const approved = parseQueue(text)[0];
    expect(approved.status).toBe('approved');
    expect(approved.publishedPath).toBe('apps/algebra-worksheet.pdf');
    expect(approved.path).toBe('');
    expect(pendingCount(parseQueue(text))).toBe(0);

    // And the teacher's device agrees on the next refresh.
    const back = mergeSubmissionLists([record], parseQueue(text));
    expect(back[0].published).toBe(true);
    expect(back[0].status).toBe('approved');
  });

  it('keeps a declined entry (with its reason) but clears the staged file', () => {
    const record = submission();
    let text = mergeQueueEntry('', queueEntryFromSubmission(record));
    text = patchQueueEntry(text, record.id, {
      status: 'rejected',
      reviewNote: 'Please add an answer key.',
      reviewedBy: 'administrator',
      path: ''
    });
    const entry = parseQueue(text)[0];
    expect(entry.status).toBe('rejected');
    expect(entry.reviewNote).toBe('Please add an answer key.');
    expect(entry.path).toBe('');

    // The teacher sees why, and it is no longer counted as waiting.
    const merged = mergeSubmissionLists([record], parseQueue(text));
    expect(merged[0].reviewNote).toBe('Please add an answer key.');
    expect(pendingCount(parseQueue(text))).toBe(0);
  });

  it('removes everything when a submission is deleted', () => {
    const record = submission();
    const text = mergeQueueEntry('', queueEntryFromSubmission(record));
    expect(removeQueueEntry(text, record.id)).toBe('[]\n');
  });
});
