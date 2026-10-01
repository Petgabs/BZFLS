// ---------------------------------------------------------------------------
// Teacher upload workflow: draft → submission → review → library.
//
// Pure functions only (no DOM, no storage), so the whole publication pipeline
// is unit-testable. The interactive side lives in app.js.
//
// A *submission* is what a teacher sends for publication. It carries the file
// reference plus the structured metadata, and a status:
//
//   pending  - waiting for an administrator to review it
//   approved - published into the library and searchable immediately
//   rejected - declined by an administrator, with a reason for the teacher
// ---------------------------------------------------------------------------

import {
  buildMetadata,
  inferSubject,
  inferYears,
  normaliseTags,
  normaliseVisibility,
  titleFromFileName,
  VISIBILITY_OPTIONS
} from './metadata.js';

/** Parse free-text year input ("12", "10, 11", "Years 7-9") into numbers 1–13. */
export function parseYearsInput(value) {
  const text = String(value || '');
  const explicit = inferYears(text);
  if (explicit.length) return explicit;

  // Bare numbers: "12" or "10, 11".
  const numbers = text.split(/[,;&\s]+/).map(Number).filter(Number.isFinite);
  const years = [...new Set(numbers)]
    .filter(year => Number.isInteger(year) && year >= 1 && year <= 13)
    .sort((a, b) => a - b);
  return years;
}

/** Blank upload form, also used to reset it after a successful submission. */
export function emptyDraft() {
  return {
    title: '',
    description: '',
    subject: '',
    years: '',
    topic: '',
    resourceType: '',
    language: 'English',
    owner: '',
    department: '',
    academicYear: '',
    keywords: '',
    visibility: 'public',
    version: '1.0',
    reviewDate: '',
    licence: '',
    accessibility: ''
  };
}

/**
 * Validate the upload form.
 * Returns a map of field → message; empty object means the draft is valid.
 *
 * @param {object} draft  Form state from emptyDraft().
 * @param {object} file   {name, size} of the chosen file, or null.
 */
export function validateDraft(draft, file, options = {}) {
  const errors = {};
  const maxBytes = Number(options.maxBytes) || Infinity;

  if (!file) errors.file = 'Choose a file to upload.';
  else if (file.size > maxBytes) {
    errors.file = `That file is ${(file.size / (1024 * 1024)).toFixed(1)} MB. The limit is ${Math.round(maxBytes / (1024 * 1024))} MB — ask the administrator to publish larger files through GitHub.`;
  }

  const title = String(draft?.title || '').trim();
  if (!title) errors.title = 'Give the resource a clear title.';
  else if (/^\d+[a-z]?$/i.test(title)) {
    // A title that is *only* a code like "16G" is almost certainly the file
    // name pasted in — nudge the teacher to describe the resource instead.
    errors.title = 'Use a descriptive title, not just a code. For example “Continuous Probability Distributions — Exercise 16G Solutions”.';
  }

  // Classification is a two-field step with fixed vocabularies, so there is
  // no excuse for an unclassified resource: without a subject and a year
  // level the library's facets cannot find it.
  const subject = String(draft?.subject || '').trim();
  if (!subject) errors.subject = 'Choose the subject this resource belongs to.';
  else if (!SUBJECT_OPTIONS.includes(subject)) {
    errors.subject = `Choose a subject from the list: ${SUBJECT_OPTIONS.join(', ')}.`;
  }

  const years = String(draft?.years || '').trim();
  if (!years) errors.years = 'Choose the year level this resource is for.';
  else if (!parseYearsInput(years).length) {
    errors.years = `Choose a year level from the list: ${YEAR_LEVEL_OPTIONS.join(', ')}.`;
  }

  if (!String(draft?.owner || '').trim()) errors.owner = 'Name the teacher or owner.';

  return errors;
}

/**
 * Turn a validated draft + file into a submission record.
 *
 * @param {object} draft   Form state from emptyDraft().
 * @param {object} file    {name, size, type} of the chosen file.
 * @param {object} options { submittedBy, status, now, storage, inlineData }
 */
export function submissionFromDraft(draft, file, options = {}) {
  const record = {
    id: options.id || (globalThis.crypto?.randomUUID?.() || `sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
    fileName: file.name,
    size: file.size,
    mime: file.type || '',

    // Metadata, normalised.
    title: String(draft.title || '').trim(),
    description: String(draft.description || '').trim(),
    subject: String(draft.subject || '').trim(),
    years: parseYearsInput(draft.years),
    topic: String(draft.topic || '').trim(),
    resourceType: String(draft.resourceType || '').trim(),
    language: String(draft.language || 'English').trim() || 'English',
    owner: String(draft.owner || '').trim(),
    department: String(draft.department || '').trim(),
    academicYear: String(draft.academicYear || '').trim(),
    keywords: normaliseTags(draft.keywords),
    visibility: normaliseVisibility(draft.visibility),
    version: String(draft.version || '1.0').trim() || '1.0',
    reviewDate: String(draft.reviewDate || '').trim(),
    licence: String(draft.licence || '').trim(),
    accessibility: String(draft.accessibility || '').trim(),

    // Workflow.
    submittedBy: options.submittedBy || 'teacher',
    submittedAt: (options.now || new Date()).toISOString(),
    status: options.status || 'pending',
    reviewedAt: '',
    reviewedBy: '',
    reviewNote: '',

    // Where the bytes live: 'idb' (IndexedDB) or 'inline' (base64 data URL
    // inside this record, used when IndexedDB is unavailable).
    storage: options.storage || null,
    inlineData: options.inlineData || null
  };

  return record;
}

/**
 * The library.json-shaped override for a submission. Every curated field the
 * site understands can be carried, so approving a submission and publishing
 * it to the public repository produce exactly the same metadata.
 */
export function overrideFromSubmission(record) {
  const entry = {
    title: record.title,
    description: record.description,
    subject: record.subject,
    years: record.years,
    keywords: record.keywords
  };
  if (record.topic) entry.topic = record.topic;
  if (record.resourceType) entry.resourceType = record.resourceType;
  if (record.language) entry.language = record.language;
  if (record.owner) entry.owner = record.owner;
  if (record.department) entry.department = record.department;
  if (record.academicYear) entry.academicYear = record.academicYear;
  if (record.visibility && record.visibility !== 'public') entry.visibility = record.visibility;
  if (record.version) entry.version = record.version;
  if (record.reviewDate) entry.reviewDate = record.reviewDate;
  if (record.licence) entry.licence = record.licence;
  if (record.accessibility) entry.accessibility = record.accessibility;
  return entry;
}

/**
 * Build the library item for an approved submission. The item carries the
 * full metadata so it survives a page reload without the submission record,
 * and stays searchable immediately.
 */
export function libraryItemFromSubmission(record) {
  const override = overrideFromSubmission(record);
  const base = {
    id: `submission:${record.id}`,
    submissionId: record.id,
    name: record.title,
    teacherName: record.owner,
    description: record.description,
    fileName: record.fileName,
    size: record.size,
    createdAt: record.submittedAt,
    source: 'local',
    subject: override.subject,
    years: override.years,
    keywords: override.keywords,
    topic: record.topic,
    resourceType: record.resourceType,
    language: record.language,
    department: record.department,
    academicYear: record.academicYear,
    visibility: record.visibility,
    version: record.version,
    reviewDate: record.reviewDate,
    licence: record.licence,
    accessibility: record.accessibility
  };
  return { ...base, meta: buildMetadata(base, override) };
}

/** A ready-to-paste library.json entry string for publishing a submission. */
export function libraryJsonEntry(record) {
  const key = `apps/${record.fileName}`;
  const entry = overrideFromSubmission(record);
  return `  ${JSON.stringify(key)}: ${JSON.stringify(entry, null, 2).replace(/\n/g, '\n  ')}`;
}

/** Count submissions by status. */
export function submissionCounts(list) {
  const counts = { pending: 0, approved: 0, rejected: 0, all: 0 };
  for (const record of list || []) {
    counts.all += 1;
    if (counts[record.status] !== undefined) counts[record.status] += 1;
  }
  return counts;
}

/** Suggest a subject for the current draft, used as a live hint in the form. */
export function suggestSubject(draft) {
  if (String(draft?.subject || '').trim()) return '';
  const text = [draft?.title, draft?.description, draft?.topic, draft?.keywords].filter(Boolean).join(' ');
  if (!text.trim()) return '';
  const guess = inferSubject(text);
  return guess === 'General' ? '' : guess;
}

/** Suggest year levels for the current draft, as a live hint in the form. */
export function suggestYears(draft) {
  if (String(draft?.years || '').trim()) return [];
  const text = [draft?.title, draft?.description, draft?.topic].filter(Boolean).join(' ');
  if (!text.trim()) return [];
  return inferYears(text);
}

/**
 * The generic subjects the inference engine knows about, mapped onto the
 * school's own subject codes. Anything without a confident mapping produces
 * no suggestion at all — a wrongly pre-filled dropdown is worse than an empty
 * one, because it gets accepted without being read.
 */
const INFERRED_SUBJECT_TO_OPTION = {
  Mathematics: 'Mathematics',
  English: 'EALD/English',
  Languages: 'EALD/English',
  Physics: 'PHY',
  Business: 'BS',
  'Art & Design': 'VA'
};

/** Suggest one of SUBJECT_OPTIONS for the draft, or '' when unsure. */
export function suggestSubjectOption(draft) {
  const guess = suggestSubject(draft);
  if (!guess) return '';
  const mapped = INFERRED_SUBJECT_TO_OPTION[guess] || '';
  return SUBJECT_OPTIONS.includes(mapped) ? mapped : '';
}

/** Suggest one of YEAR_LEVEL_OPTIONS for the draft, or '' when unsure. */
export function suggestYearLevel(draft) {
  for (const year of suggestYears(draft)) {
    const label = `Year ${year}`;
    if (YEAR_LEVEL_OPTIONS.includes(label)) return label;
  }
  return '';
}

/** Placeholder title hint derived from the file name (never used as-is). */
export function titleHint(fileName) {
  return titleFromFileName(fileName);
}

/**
 * The subjects a teacher can file a resource under.
 *
 * This is the school's own vocabulary, not a guess: the upload form offers
 * exactly these and nothing else, so every resource lands in a facet students
 * can actually filter by. Add a line here to add a subject site-wide.
 */
export const SUBJECT_OPTIONS = [
  'Mathematics',
  'EALD/English',
  'CAL',
  'BS',
  'VA',
  'PHY',
  'MEX',
  'Others'
];

/** The year levels a resource can be filed under. */
export const YEAR_LEVEL_OPTIONS = ['Year 9', 'Year 10', 'Year 11', 'Year 12'];

/** Options shown in the upload form. Kept here so tests can lock the vocabulary. */
export const FORM_OPTIONS = {
  subjects: SUBJECT_OPTIONS,
  yearLevels: YEAR_LEVEL_OPTIONS,
  resourceTypes: [
    'Worksheet',
    'Lesson plan',
    'Exercise solutions',
    'Quiz / assessment',
    'Revision notes',
    'Homework task',
    'Presentation',
    'Reading text',
    'Scheme of work',
    'Template',
    'Interactive mini app',
    'Other'
  ],
  languages: ['English', 'Arabic', 'French', 'Spanish', 'German', 'Mandarin', 'Bahasa Malaysia', 'Tamil', 'Other'],
  departments: [
    'Mathematics', 'Science', 'English', 'Humanities', 'Languages', 'Computing',
    'Business & Economics', 'Arts', 'Physical Education', 'Religious Studies',
    'Special Education', 'Library', 'Administration', 'Other'
  ],
  licences: [
    'All rights reserved',
    'Creative Commons BY 4.0',
    'Creative Commons BY-SA 4.0',
    'Creative Commons BY-NC 4.0',
    'Creative Commons BY-NC-SA 4.0',
    'Public domain',
    'School use only — check with the owner'
  ],
  visibilities: VISIBILITY_OPTIONS
};

/** Which academic years to offer, anchored on the current date. */
export function academicYearOptions(now = new Date()) {
  const year = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
  return [String(year), String(year + 1), `${year}/${String(year + 1).slice(2)}`, `${year}–${String(year + 1).slice(2)}`];
}
