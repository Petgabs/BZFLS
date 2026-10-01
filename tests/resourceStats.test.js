// ---------------------------------------------------------------------------
// Admin "Resource Statistics" aggregation: teacher activity, year/subject
// breakdowns, cloud storage totals, upload-age buckets and cleanup
// candidates. Pure functions, no DOM or network — see assets/js/lib/
// resourceStats.js for the record shape.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import {
  daysSince,
  ageBucketOf,
  ownerLabel,
  buildResourceRecord,
  summariseByTeacher,
  summariseByYearLevel,
  summariseBySubject,
  summariseStorage,
  bucketResourcesByAge,
  findCleanupCandidates,
  UNATTRIBUTED_OWNER
} from '../assets/js/lib/resourceStats.js';

const NOW = new Date('2026-10-01T00:00:00.000Z');
const daysAgo = n => new Date(NOW.getTime() - n * 86400000).toISOString();

function record(overrides = {}) {
  return {
    id: 'id-1',
    title: 'Untitled',
    fileName: 'file.pdf',
    path: 'apps/file.pdf',
    owner: 'Peter',
    subject: 'Mathematics',
    years: [10],
    size: 1024,
    uploadedAt: daysAgo(3),
    downloads: 0,
    source: 'github',
    ...overrides
  };
}

describe('daysSince / ageBucketOf', () => {
  it('returns null for missing or invalid dates', () => {
    expect(daysSince('', NOW)).toBeNull();
    expect(daysSince('not-a-date', NOW)).toBeNull();
    expect(ageBucketOf('', NOW)).toBe('unknown');
  });

  it('buckets by elapsed time', () => {
    expect(ageBucketOf(daysAgo(0), NOW)).toBe('week');
    expect(ageBucketOf(daysAgo(7), NOW)).toBe('week');
    expect(ageBucketOf(daysAgo(10), NOW)).toBe('twoWeeks');
    expect(ageBucketOf(daysAgo(14), NOW)).toBe('twoWeeks');
    expect(ageBucketOf(daysAgo(25), NOW)).toBe('month');
    expect(ageBucketOf(daysAgo(30), NOW)).toBe('month');
    expect(ageBucketOf(daysAgo(45), NOW)).toBe('older');
  });
});

describe('ownerLabel', () => {
  it('falls back to a clear placeholder for blank owners', () => {
    expect(ownerLabel('Mia')).toBe('Mia');
    expect(ownerLabel('  ')).toBe(UNATTRIBUTED_OWNER);
    expect(ownerLabel(undefined)).toBe(UNATTRIBUTED_OWNER);
  });
});

describe('buildResourceRecord', () => {
  it('prefers the submission for owner/subject/years/size/date', () => {
    const resource = {
      id: 'github:abc',
      name: 'Seat plan',
      fileName: 'seat plan.docx',
      githubPath: 'apps/seat plan.docx',
      size: 999,
      source: 'github',
      meta: { owner: 'GitHub Library', subject: 'General', years: [] }
    };
    const submission = {
      owner: 'Peter',
      subject: 'Mathematics',
      years: [12],
      size: 1003735,
      submittedAt: '2026-09-30T06:57:50.192Z'
    };
    const out = buildResourceRecord(resource, { submission, downloads: 4 });
    expect(out.owner).toBe('Peter');
    expect(out.subject).toBe('Mathematics');
    expect(out.years).toEqual([12]);
    expect(out.size).toBe(1003735);
    expect(out.uploadedAt).toBe('2026-09-30T06:57:50.192Z');
    expect(out.downloads).toBe(4);
  });

  it('never attributes a resource to the generic "GitHub Library" sync placeholder', () => {
    const resource = {
      id: 'github:ghi',
      name: 'Untitled upload',
      fileName: 'untitled.pdf',
      teacherName: 'GitHub Library',
      source: 'github',
      meta: { owner: 'GitHub Library', subject: '', years: [] }
    };
    const out = buildResourceRecord(resource);
    expect(out.owner).toBe('');
    expect(ownerLabel(out.owner)).toBe(UNATTRIBUTED_OWNER);
  });

  it('falls back to resource metadata with no submission, and leaves the date unknown', () => {
    const resource = {
      id: 'github:def',
      name: 'MCQ Practice',
      fileName: 'mcq.html',
      size: 0,
      source: 'github',
      meta: { owner: 'Peter', subject: '', years: [12] }
    };
    const out = buildResourceRecord(resource);
    expect(out.owner).toBe('Peter');
    expect(out.subject).toBe('');
    expect(out.years).toEqual([12]);
    expect(out.size).toBeNull();
    expect(out.uploadedAt).toBeNull();
    expect(out.downloads).toBe(0);
  });
});

describe('summariseByTeacher', () => {
  it('aggregates uploads, storage, years, subjects and last upload per teacher', () => {
    const records = [
      record({ owner: 'Peter', years: [10], subject: 'Mathematics', size: 1000, uploadedAt: daysAgo(10), downloads: 2 }),
      record({ owner: 'Peter', years: [12], subject: 'Mathematics', size: 2000, uploadedAt: daysAgo(2), downloads: 5 }),
      record({ owner: 'Mia', years: [11], subject: 'PHY', size: 3000, uploadedAt: daysAgo(20), downloads: 0 }),
      record({ owner: '', years: [9], subject: '', size: null, uploadedAt: null, downloads: 0 })
    ];

    const summary = summariseByTeacher(records, NOW);
    expect(summary.map(s => s.owner)).toEqual(['Peter', 'Mia', UNATTRIBUTED_OWNER]);

    const peter = summary.find(s => s.owner === 'Peter');
    expect(peter.uploads).toBe(2);
    expect(peter.totalSize).toBe(3000);
    expect(peter.yearCounts[10]).toBe(1);
    expect(peter.yearCounts[12]).toBe(1);
    expect(peter.subjectCounts.Mathematics).toBe(2);
    expect(peter.lastUploadAt).toBe(daysAgo(2));
    expect(peter.lastUploadDaysAgo).toBeCloseTo(2, 5);

    const unattributed = summary.find(s => s.owner === UNATTRIBUTED_OWNER);
    expect(unattributed.uploads).toBe(1);
    expect(unattributed.lastUploadAt).toBeNull();
  });
});

describe('summariseByYearLevel', () => {
  it('counts a multi-year resource once per year, and tracks unclassified resources', () => {
    const records = [
      record({ years: [10, 11] }),
      record({ years: [9] }),
      record({ years: [] })
    ];
    const { counts, unclassified } = summariseByYearLevel(records);
    expect(counts).toEqual({ 9: 1, 10: 1, 11: 1, 12: 0 });
    expect(unclassified).toBe(1);
  });
});

describe('summariseBySubject', () => {
  it('counts and sums storage per subject, most popular first', () => {
    const records = [
      record({ subject: 'Mathematics', size: 1000 }),
      record({ subject: 'Mathematics', size: 2000 }),
      record({ subject: 'PHY', size: 500 }),
      record({ subject: '', size: 10 })
    ];
    const out = summariseBySubject(records);
    expect(out[0]).toMatchObject({ subject: 'Mathematics', count: 2, totalSize: 3000 });
    expect(out.find(s => s.subject === 'Unclassified').count).toBe(1);
  });
});

describe('summariseStorage', () => {
  it('sums only resources with a known size', () => {
    const records = [record({ size: 1000 }), record({ size: null }), record({ size: 2000 })];
    const out = summariseStorage(records);
    expect(out.totalBytes).toBe(3000);
    expect(out.knownCount).toBe(2);
    expect(out.unknownCount).toBe(1);
    expect(out.totalCount).toBe(3);
  });
});

describe('bucketResourcesByAge', () => {
  it('sorts resources into buckets, newest first within each', () => {
    const records = [
      record({ id: 'a', uploadedAt: daysAgo(1) }),
      record({ id: 'b', uploadedAt: daysAgo(5) }),
      record({ id: 'c', uploadedAt: daysAgo(12) }),
      record({ id: 'd', uploadedAt: daysAgo(40) }),
      record({ id: 'e', uploadedAt: null })
    ];
    const buckets = bucketResourcesByAge(records, NOW);
    expect(buckets.week.map(r => r.id)).toEqual(['a', 'b']);
    expect(buckets.twoWeeks.map(r => r.id)).toEqual(['c']);
    expect(buckets.older.map(r => r.id)).toEqual(['d']);
    expect(buckets.unknown.map(r => r.id)).toEqual(['e']);
  });
});

describe('findCleanupCandidates', () => {
  it('flags only old, undownloaded resources with a known date, oldest first', () => {
    const records = [
      record({ id: 'stale', uploadedAt: daysAgo(60), downloads: 0 }),
      record({ id: 'stale-ish', uploadedAt: daysAgo(31), downloads: 0 }),
      record({ id: 'too-new', uploadedAt: daysAgo(5), downloads: 0 }),
      record({ id: 'popular', uploadedAt: daysAgo(90), downloads: 10 }),
      record({ id: 'unknown-date', uploadedAt: null, downloads: 0 })
    ];
    const out = findCleanupCandidates(records, { minAgeDays: 30, maxDownloads: 0, now: NOW });
    expect(out.map(r => r.id)).toEqual(['stale', 'stale-ish']);
  });

  it('respects a custom download threshold', () => {
    const records = [record({ id: 'low-use', uploadedAt: daysAgo(40), downloads: 1 })];
    expect(findCleanupCandidates(records, { minAgeDays: 30, maxDownloads: 0, now: NOW })).toHaveLength(0);
    expect(findCleanupCandidates(records, { minAgeDays: 30, maxDownloads: 1, now: NOW })).toHaveLength(1);
  });
});
