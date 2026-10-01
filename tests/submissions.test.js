// ---------------------------------------------------------------------------
// Teacher upload workflow: draft → submission → review → searchable library
// item → publishable library.json entry. These tests lock the behaviour the
// teacher workflow depends on.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import {
  parseYearsInput,
  emptyDraft,
  validateDraft,
  submissionFromDraft,
  libraryItemFromSubmission,
  overrideFromSubmission,
  libraryJsonEntry,
  submissionCounts,
  suggestSubject,
  suggestYears,
  suggestSubjectOption,
  suggestYearLevel,
  titleHint,
  academicYearOptions,
  FORM_OPTIONS,
  SUBJECT_OPTIONS,
  YEAR_LEVEL_OPTIONS
} from '../assets/js/lib/submissions.js';
import { buildMetadata, normaliseVisibility, visibilityLabel, isReviewDue } from '../assets/js/lib/metadata.js';
import { searchableText, queryLibrary } from '../assets/js/lib/search.js';

const FILE = { name: '16G.pdf', size: 512 * 1024, type: 'application/pdf' };

function filledDraft(overrides = {}) {
  return {
    ...emptyDraft(),
    title: 'Continuous Probability Distributions — Exercise 16G Solutions',
    description: 'Worked solutions for Exercise 16G.',
    subject: 'Mathematics',
    years: '12',
    topic: 'Continuous probability distributions',
    resourceType: 'Exercise solutions',
    owner: 'Mr A. Rahman',
    department: 'Mathematics',
    academicYear: '2026',
    keywords: 'probability, HSC, revision',
    visibility: 'school',
    version: '1.1',
    reviewDate: '2027-01-31',
    licence: 'School use only — check with the owner',
    accessibility: 'Tagged PDF.',
    ...overrides
  };
}

describe('parseYearsInput', () => {
  it('reads bare numbers and lists', () => {
    expect(parseYearsInput('12')).toEqual([12]);
    expect(parseYearsInput('10, 11')).toEqual([10, 11]);
    expect(parseYearsInput('7 8 9')).toEqual([7, 8, 9]);
  });

  it('reads phrased input', () => {
    expect(parseYearsInput('Year 12')).toEqual([12]);
    expect(parseYearsInput('Years 7-9')).toEqual([7, 8, 9]);
    expect(parseYearsInput('Year 10 & 11')).toEqual([10, 11]);
  });

  it('ignores numbers outside school years', () => {
    expect(parseYearsInput('99, 0')).toEqual([]);
  });

  it('returns an empty array for blank input', () => {
    expect(parseYearsInput('')).toEqual([]);
    expect(parseYearsInput(null)).toEqual([]);
  });
});

describe('normaliseVisibility / visibilityLabel', () => {
  it('accepts the three canonical values', () => {
    expect(normaliseVisibility('public')).toBe('public');
    expect(normaliseVisibility('school')).toBe('school');
    expect(normaliseVisibility('class')).toBe('class');
  });

  it('normalises human variants', () => {
    expect(normaliseVisibility('School only')).toBe('school');
    expect(normaliseVisibility('Class only')).toBe('class');
    expect(normaliseVisibility('SCHOOL-ONLY')).toBe('school');
  });

  it('falls back to public', () => {
    expect(normaliseVisibility('')).toBe('public');
    expect(normaliseVisibility('everyone')).toBe('public');
    expect(visibilityLabel('school')).toBe('School only');
    expect(visibilityLabel('nonsense')).toBe('Public');
  });
});

describe('isReviewDue', () => {
  it('flags dates in the past', () => {
    expect(isReviewDue('2020-01-01', new Date('2026-10-01'))).toBe(true);
  });

  it('keeps future and missing dates quiet', () => {
    expect(isReviewDue('2030-01-01', new Date('2026-10-01'))).toBe(false);
    expect(isReviewDue('', new Date('2026-10-01'))).toBe(false);
    expect(isReviewDue('not a date', new Date('2026-10-01'))).toBe(false);
  });
});

describe('validateDraft', () => {
  it('accepts a complete draft', () => {
    expect(validateDraft(filledDraft(), FILE, { maxBytes: 50 * 1024 * 1024 })).toEqual({});
  });

  it('requires a file, a title and an owner', () => {
    const errors = validateDraft(emptyDraft(), null, {});
    expect(errors.file).toBeTruthy();
    expect(errors.title).toBeTruthy();
    expect(errors.owner).toBeTruthy();
  });

  it('rejects a title that is only a code like the file name', () => {
    const errors = validateDraft(filledDraft({ title: '16G' }), FILE, {});
    expect(errors.title).toMatch(/descriptive title/i);
  });

  it('rejects oversized files with the limit in the message', () => {
    const big = { ...FILE, size: 55 * 1024 * 1024 };
    const errors = validateDraft(filledDraft(), big, { maxBytes: 50 * 1024 * 1024 });
    expect(errors.file).toMatch(/50 MB/);
  });

  it('requires the resource to be classified', () => {
    const errors = validateDraft(emptyDraft(), null, {});
    expect(errors.subject).toBeTruthy();
    expect(errors.years).toBeTruthy();
  });

  it('only accepts subjects from the school vocabulary', () => {
    expect(validateDraft(filledDraft({ subject: 'Underwater Basket Weaving' }), FILE, {}).subject)
      .toMatch(/Choose a subject from the list/i);
    for (const subject of SUBJECT_OPTIONS) {
      expect(validateDraft(filledDraft({ subject }), FILE, {}).subject).toBeUndefined();
    }
  });

  it('accepts every offered year level', () => {
    for (const level of YEAR_LEVEL_OPTIONS) {
      expect(validateDraft(filledDraft({ years: level }), FILE, {}).years).toBeUndefined();
    }
    expect(validateDraft(filledDraft({ years: 'whenever' }), FILE, {}).years)
      .toMatch(/Choose a year level from the list/i);
  });
});

describe('submissionFromDraft', () => {
  it('normalises every metadata field', () => {
    const record = submissionFromDraft(filledDraft(), FILE, { id: 's1', submittedBy: 'teacher', now: new Date('2026-10-01T09:00:00Z') });
    expect(record.id).toBe('s1');
    expect(record.fileName).toBe('16G.pdf');
    expect(record.title).toContain('Continuous Probability');
    expect(record.subject).toBe('Mathematics');
    expect(record.years).toEqual([12]);
    expect(record.keywords).toEqual(['probability', 'hsc', 'revision']);
    expect(record.visibility).toBe('school');
    expect(record.version).toBe('1.1');
    expect(record.reviewDate).toBe('2027-01-31');
    expect(record.licence).toContain('School use only');
    expect(record.accessibility).toBe('Tagged PDF.');
    expect(record.status).toBe('pending');
    expect(record.submittedBy).toBe('teacher');
    expect(record.submittedAt).toBe('2026-10-01T09:00:00.000Z');
  });

  it('defaults language and version when left blank', () => {
    const record = submissionFromDraft({ ...filledDraft(), language: '', version: '' }, FILE, { id: 's2' });
    expect(record.language).toBe('English');
    expect(record.version).toBe('1.0');
  });

  it('normalises an unknown visibility to public', () => {
    const record = submissionFromDraft({ ...filledDraft(), visibility: '' }, FILE, { id: 's3' });
    expect(record.visibility).toBe('public');
  });
});

describe('submission → library item', () => {
  const record = submissionFromDraft(filledDraft(), FILE, { id: 's1', status: 'approved' });
  const item = libraryItemFromSubmission(record);

  it('uses the title, never the file name, as the primary name', () => {
    expect(item.name).toBe(record.title);
    expect(item.name).not.toBe('16G.pdf');
    expect(item.fileName).toBe('16G.pdf');
  });

  it('carries the full structured metadata', () => {
    expect(item.meta.subject).toBe('Mathematics');
    expect(item.meta.years).toEqual([12]);
    expect(item.meta.topic).toBe('Continuous probability distributions');
    expect(item.meta.resourceType).toBe('Exercise solutions');
    expect(item.meta.language).toBe('English');
    expect(item.meta.owner).toBe('Mr A. Rahman');
    expect(item.meta.department).toBe('Mathematics');
    expect(item.meta.academicYear).toBe('2026');
    expect(item.meta.visibility).toBe('school');
    expect(item.meta.version).toBe('1.1');
    expect(item.meta.reviewDate).toBe('2027-01-31');
    expect(item.meta.licence).toContain('School use only');
    expect(item.meta.accessibility).toBe('Tagged PDF.');
    expect(item.meta.curated).toBe(true);
  });

  it('is searchable immediately by title, topic, keyword and owner', () => {
    const text = searchableText(item);
    for (const term of ['continuous', 'exercise 16g', 'probability', 'rahman', 'mathematics', 'hsc', 'school only', 'solutions', '2026']) {
      expect(text).toContain(term);
    }
  });;

  it('matches real queries through queryLibrary', () => {
    const results = queryLibrary([item], { query: 'continuous probability solutions' });
    expect(results).toHaveLength(1);
    expect(queryLibrary([item], { query: 'chemistry titration' })).toHaveLength(0);
  });

  it('survives re-decoration from its own persisted fields', () => {
    // Simulates a page reload: the item is re-decorated with no override.
    const restored = { ...item, meta: undefined };
    const meta = buildMetadata(restored, {});
    expect(meta.subject).toBe('Mathematics');
    expect(meta.years).toEqual([12]);
    expect(meta.topic).toBe('Continuous probability distributions');
    expect(meta.visibility).toBe('school');
    expect(meta.tags).toEqual(['probability', 'hsc', 'revision']);
  });
});

describe('library.json publishing helpers', () => {
  const record = submissionFromDraft(filledDraft(), FILE, { id: 's1', status: 'approved' });

  it('builds an override keyed by the same fields library.json uses', () => {
    const entry = overrideFromSubmission(record);
    expect(entry.title).toBe(record.title);
    expect(entry.subject).toBe('Mathematics');
    expect(entry.years).toEqual([12]);
    expect(entry.keywords).toEqual(record.keywords);
    expect(entry.visibility).toBe('school');
    expect(entry.owner).toBe('Mr A. Rahman');
  });

  it('produces a parseable library.json snippet keyed by path', () => {
    const snippet = libraryJsonEntry(record);
    const json = JSON.parse(`{\n${snippet}\n}`);
    expect(Object.keys(json)).toEqual(['apps/16G.pdf']);
    expect(json['apps/16G.pdf'].title).toBe(record.title);
  });

  it('applies the override to a GitHub-synced file', () => {
    // This is what happens after the administrator publishes on GitHub.
    const githubItem = {
      fileName: '16G.pdf',
      githubPath: 'apps/16G.pdf',
      name: '16G',
      description: 'PDF document shared through the public repository'
    };
    const meta = buildMetadata(githubItem, overrideFromSubmission(record));
    expect(meta.title).toBe(record.title);
    expect(meta.subject).toBe('Mathematics');
    expect(meta.years).toEqual([12]);
    expect(meta.visibility).toBe('school');
  });
});

describe('submissionCounts', () => {
  it('counts by status', () => {
    const list = [
      { status: 'pending' },
      { status: 'pending' },
      { status: 'approved' },
      { status: 'rejected' }
    ];
    expect(submissionCounts(list)).toEqual({ pending: 2, approved: 1, rejected: 1, all: 4 });
    expect(submissionCounts([])).toEqual({ pending: 0, approved: 0, rejected: 0, all: 0 });
  });
});

describe('suggestions', () => {
  it('suggests a subject from the title text but never overrides a choice', () => {
    expect(suggestSubject(filledDraft({ subject: '' }))).toBe('Mathematics');
    expect(suggestSubject(filledDraft())).toBe('');
  });

  it('suggests years from the title text', () => {
    expect(suggestYears(filledDraft({ years: '' }))).toEqual([]);
    expect(suggestYears({ ...emptyDraft(), title: 'Year 12 probability revision' })).toEqual([12]);
  });
});

describe('titleHint', () => {
  it('turns a bare file name into the seed of a real title', () => {
    expect(titleHint('16G.pdf')).toBe('16G');
    expect(titleHint('2024-year-10-algebra.pdf')).toBe('year 10 algebra');
  });
});

describe('classification vocabulary', () => {
  it('offers exactly the school\'s subjects, in order', () => {
    expect(FORM_OPTIONS.subjects).toEqual([
      'Mathematics', 'EALD/English', 'CAL', 'BS', 'VA', 'PHY', 'MEX', 'Others'
    ]);
    expect(FORM_OPTIONS.subjects).toBe(SUBJECT_OPTIONS);
  });

  it('offers Year 9 to Year 12 as year levels', () => {
    expect(FORM_OPTIONS.yearLevels).toEqual(['Year 9', 'Year 10', 'Year 11', 'Year 12']);
    expect(FORM_OPTIONS.yearLevels).toBe(YEAR_LEVEL_OPTIONS);
  });

  it('turns every year-level option into a real year number', () => {
    expect(YEAR_LEVEL_OPTIONS.map(level => parseYearsInput(level))).toEqual([[9], [10], [11], [12]]);
  });

  it('suggests only values the dropdowns actually contain', () => {
    const maths = { title: 'Algebra revision for Year 10', description: '', topic: '' };
    expect(suggestSubjectOption(maths)).toBe('Mathematics');
    expect(SUBJECT_OPTIONS).toContain(suggestSubjectOption(maths));
    expect(suggestYearLevel(maths)).toBe('Year 10');

    // "English" is EALD/English here, not the generic inferred label.
    expect(suggestSubjectOption({ title: 'Poetry comprehension essay' })).toBe('EALD/English');
    expect(suggestSubjectOption({ title: 'Optics and kinematics practical' })).toBe('PHY');
  });

  it('stays silent rather than guessing something that is not on the list', () => {
    // Chemistry has no code in this school's vocabulary, and Year 7 is not
    // offered — a wrong pre-filled dropdown is worse than an empty one.
    expect(suggestSubjectOption({ title: 'Titration practical write-up' })).toBe('');
    expect(suggestYearLevel({ title: 'Year 7 transition booklet' })).toBe('');
    expect(suggestSubjectOption({ title: '' })).toBe('');
    expect(suggestYearLevel({ title: '' })).toBe('');
  });

  it('never suggests over a choice the teacher already made', () => {
    expect(suggestSubjectOption({ title: 'Algebra', subject: 'Others' })).toBe('');
    expect(suggestYearLevel({ title: 'Year 10 algebra', years: 'Year 12' })).toBe('');
  });
});

describe('form vocabulary', () => {
  it('offers the three visibility levels with plain-language hints', () => {
    expect(FORM_OPTIONS.visibilities.map(option => option.value)).toEqual(['public', 'school', 'class']);
    for (const option of FORM_OPTIONS.visibilities) {
      expect(option.label).toBeTruthy();
      expect(option.hint).toBeTruthy();
    }
  });

  it('offers a non-empty, de-duplicated vocabulary', () => {
    for (const key of ['resourceTypes', 'languages', 'departments', 'licences']) {
      const options = FORM_OPTIONS[key];
      expect(options.length).toBeGreaterThan(3);
      expect(new Set(options).size).toBe(options.length);
    }
  });

  it('anchors academic year suggestions on the current date', () => {
    expect(academicYearOptions(new Date('2026-10-01'))[0]).toBe('2026');
    expect(academicYearOptions(new Date('2026-02-01'))[0]).toBe('2025');
  });
});
