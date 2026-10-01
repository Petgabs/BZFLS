// ---------------------------------------------------------------------------
// Admin "Resource Statistics" section.
//
// Pure, DOM-free aggregation over a flat list of "resource records" — one per
// file currently published in the GitHub cloud (apps/), enriched with the
// matching teacher-upload submission when one exists (submissions/queue.json,
// loaded cross-device by app.js). No network or storage access happens here,
// so the whole dashboard can be unit-tested with synthetic data.
//
// A resource record looks like:
//   {
//     id, title, fileName, path,
//     owner,            // teacher name, or '' when unknown
//     subject,          // e.g. "Mathematics", or '' when unclassified
//     years,            // number[] e.g. [10, 11]
//     size,             // bytes, or null when unknown
//     uploadedAt,       // ISO string, or null when unknown (published by
//                       // hand, with no matching submission record)
//     downloads,        // total download count
//     source            // 'github' | 'local'
//   }
// ---------------------------------------------------------------------------

export const YEAR_LEVELS = [9, 10, 11, 12];

export const AGE_BUCKETS = ['week', 'twoWeeks', 'month', 'older', 'unknown'];

export const AGE_BUCKET_LABELS = {
  week: 'Uploaded in the last week',
  twoWeeks: 'Uploaded 1–2 weeks ago',
  month: 'Uploaded 2–4 weeks ago (about a month)',
  older: 'Uploaded over a month ago',
  unknown: 'Upload date unknown'
};

/** Label used for a resource with no attributable teacher. */
export const UNATTRIBUTED_OWNER = 'Unattributed';

/**
 * Generic placeholder the sync step stamps on every GitHub-sourced resource
 * before `library.json` or a submission record supplies a real name (see
 * `teacherName: 'GitHub Library'` in app.js). It must never be counted as an
 * actual teacher.
 */
const SYNC_PLACEHOLDER_OWNER = 'GitHub Library';

/** A raw owner value, with the generic sync placeholder treated as unknown. */
function realOwner(value) {
  const trimmed = String(value || '').trim();
  return trimmed && trimmed !== SYNC_PLACEHOLDER_OWNER ? trimmed : '';
}

/** Fractional days between an ISO timestamp and `now`, or null when unknown. */
export function daysSince(isoString, now = new Date()) {
  if (!isoString) return null;
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return null;
  const nowTime = now instanceof Date ? now.getTime() : new Date(now).getTime();
  return Math.max(0, (nowTime - date.getTime()) / 86400000);
}

/** Which "age in the cloud" bucket a timestamp falls into. */
export function ageBucketOf(isoString, now = new Date()) {
  const days = daysSince(isoString, now);
  if (days === null) return 'unknown';
  if (days <= 7) return 'week';
  if (days <= 14) return 'twoWeeks';
  if (days <= 30) return 'month';
  return 'older';
}

/** Human label for a teacher name, falling back to a clear placeholder. */
export function ownerLabel(owner) {
  const trimmed = String(owner || '').trim();
  return trimmed || UNATTRIBUTED_OWNER;
}

/**
 * Build one unified statistics record for a currently-published cloud
 * resource, optionally enriched with the submission that produced it.
 *
 * @param {object} resource    Decorated app/resource from the library.
 * @param {object} [options]
 * @param {object} [options.submission]  Matching entry from `submissions`.
 * @param {number} [options.downloads]   Download count for this resource.
 */
export function buildResourceRecord(resource, options = {}) {
  const submission = options.submission || null;
  const meta = resource?.meta || {};

  const owner = realOwner(submission?.owner) || realOwner(meta.owner) || realOwner(resource?.teacherName);
  const subject = String(submission?.subject || meta.subject || '').trim();
  const years = (Array.isArray(submission?.years) && submission.years.length
    ? submission.years
    : (Array.isArray(meta.years) ? meta.years : []))
    .map(Number)
    .filter(Number.isFinite);

  const size = Number.isFinite(Number(submission?.size)) && Number(submission?.size) > 0
    ? Number(submission.size)
    : (Number.isFinite(Number(resource?.size)) && Number(resource.size) > 0 ? Number(resource.size) : null);

  const uploadedAt = submission?.submittedAt || null;

  return {
    id: resource?.id || submission?.id || resource?.fileName || '',
    title: resource?.name || submission?.title || resource?.fileName || 'Untitled',
    fileName: resource?.fileName || submission?.fileName || '',
    path: resource?.githubPath || submission?.publishedPath || '',
    owner,
    subject,
    years,
    size,
    uploadedAt,
    downloads: Number(options.downloads) || 0,
    source: resource?.source || 'github'
  };
}

/** Total resources, grouped and counted per teacher. */
export function summariseByTeacher(records, now = new Date()) {
  const byOwner = new Map();

  for (const record of records) {
    const owner = ownerLabel(record.owner);
    if (!byOwner.has(owner)) {
      byOwner.set(owner, {
        owner,
        uploads: 0,
        totalSize: 0,
        knownSizeCount: 0,
        yearCounts: Object.fromEntries(YEAR_LEVELS.map(year => [year, 0])),
        subjectCounts: {},
        downloads: 0,
        lastUploadAt: null
      });
    }
    const entry = byOwner.get(owner);
    entry.uploads += 1;
    entry.downloads += Number(record.downloads) || 0;
    if (Number.isFinite(record.size) && record.size > 0) {
      entry.totalSize += record.size;
      entry.knownSizeCount += 1;
    }
    for (const year of record.years || []) {
      if (entry.yearCounts[year] !== undefined) entry.yearCounts[year] += 1;
    }
    const subject = record.subject || 'Unclassified';
    entry.subjectCounts[subject] = (entry.subjectCounts[subject] || 0) + 1;

    if (record.uploadedAt) {
      if (!entry.lastUploadAt || new Date(record.uploadedAt) > new Date(entry.lastUploadAt)) {
        entry.lastUploadAt = record.uploadedAt;
      }
    }
  }

  return [...byOwner.values()]
    .map(entry => ({ ...entry, lastUploadDaysAgo: daysSince(entry.lastUploadAt, now) }))
    .sort((a, b) => b.uploads - a.uploads || a.owner.localeCompare(b.owner));
}

/** Resource counts for Year 9/10/11/12 (a multi-year resource counts once per year). */
export function summariseByYearLevel(records, years = YEAR_LEVELS) {
  const counts = Object.fromEntries(years.map(year => [year, 0]));
  let other = 0;
  let unclassified = 0;

  for (const record of records) {
    const recordYears = (record.years || []).filter(Number.isFinite);
    if (!recordYears.length) {
      unclassified += 1;
      continue;
    }
    for (const year of recordYears) {
      if (counts[year] !== undefined) counts[year] += 1;
      else other += 1;
    }
  }

  return { counts, other, unclassified };
}

/** Resource counts (and storage) per subject, most popular first. */
export function summariseBySubject(records) {
  const bySubject = new Map();
  for (const record of records) {
    const subject = record.subject || 'Unclassified';
    if (!bySubject.has(subject)) bySubject.set(subject, { subject, count: 0, totalSize: 0 });
    const entry = bySubject.get(subject);
    entry.count += 1;
    if (Number.isFinite(record.size) && record.size > 0) entry.totalSize += record.size;
  }
  return [...bySubject.values()].sort((a, b) => b.count - a.count || a.subject.localeCompare(b.subject));
}

/** Total storage occupied in the GitHub cloud, and how much of it is known. */
export function summariseStorage(records) {
  let totalBytes = 0;
  let knownCount = 0;
  for (const record of records) {
    if (Number.isFinite(record.size) && record.size > 0) {
      totalBytes += record.size;
      knownCount += 1;
    }
  }
  return { totalBytes, knownCount, totalCount: records.length, unknownCount: records.length - knownCount };
}

/** Group resources by how long they have been published, newest first within each bucket. */
export function bucketResourcesByAge(records, now = new Date()) {
  const buckets = Object.fromEntries(AGE_BUCKETS.map(bucket => [bucket, []]));
  for (const record of records) {
    buckets[ageBucketOf(record.uploadedAt, now)].push(record);
  }
  for (const bucket of AGE_BUCKETS) {
    buckets[bucket].sort((a, b) => new Date(b.uploadedAt || 0) - new Date(a.uploadedAt || 0));
  }
  return buckets;
}

/**
 * Resources that look safe to clean up: old enough, and never (or barely)
 * downloaded. Only resources with a known upload date are considered — an
 * unknown age is not evidence of staleness. Oldest / least-used first.
 */
export function findCleanupCandidates(records, options = {}) {
  const minAgeDays = Number.isFinite(options.minAgeDays) ? options.minAgeDays : 30;
  const maxDownloads = Number.isFinite(options.maxDownloads) ? options.maxDownloads : 0;
  const now = options.now || new Date();

  return records
    .filter(record => record.uploadedAt && (Number(record.downloads) || 0) <= maxDownloads)
    .map(record => ({ ...record, ageDays: daysSince(record.uploadedAt, now) }))
    .filter(record => record.ageDays !== null && record.ageDays >= minAgeDays)
    .sort((a, b) => b.ageDays - a.ageDays);
}
