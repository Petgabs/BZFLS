// ---------------------------------------------------------------------------
// Structured metadata for library items.
//
// Every file in /apps is a plain upload with no database behind it, so the
// subject / year / tag metadata is derived from three layers, in order of
// increasing authority:
//
//   1. Defaults          - everything is "General", no year, no tags.
//   2. Inference         - keywords in the file name and description.
//   3. library.json      - hand-curated overrides, keyed by path or file name.
//
// Keeping this pure (no DOM, no fetch) is what makes it unit-testable.
// ---------------------------------------------------------------------------

export const UNKNOWN_SUBJECT = 'General';

// Each subject lists the keywords that identify it. Order matters only in that
// the first subject with a match wins, so put narrower subjects first.
export const SUBJECTS = [
  { name: 'Mathematics', keywords: ['math', 'maths', 'mathematics', 'algebra', 'geometry', 'calculus', 'trigonometry', 'statistics', 'arithmetic', 'numeracy', 'probability', 'distribution', 'equations', 'differentiation', 'integration', 'matrices', 'combinatorics'] },
  { name: 'Physics', keywords: ['physics', 'mechanics', 'kinematics', 'optics', 'thermodynamics'] },
  { name: 'Chemistry', keywords: ['chemistry', 'chemical', 'periodic', 'organic', 'titration'] },
  { name: 'Biology', keywords: ['biology', 'biological', 'anatomy', 'genetics', 'ecology', 'photosynthesis'] },
  { name: 'Science', keywords: ['science', 'scientific', 'lab', 'laboratory', 'experiment'] },
  { name: 'English', keywords: ['english', 'literature', 'grammar', 'poetry', 'essay', 'comprehension', 'spelling', 'vocabulary'] },
  { name: 'History', keywords: ['history', 'historical', 'civilisation', 'civilization', 'revolution', 'ancient'] },
  { name: 'Geography', keywords: ['geography', 'geographic', 'map', 'climate', 'volcano', 'continent'] },
  { name: 'Computing', keywords: ['computing', 'computer', 'ict', 'coding', 'programming', 'javascript', 'python', 'algorithm', 'software'] },
  { name: 'Business', keywords: ['business', 'economics', 'commerce', 'accounting', 'finance', 'marketing'] },
  { name: 'Art & Design', keywords: ['art', 'design', 'drawing', 'painting', 'sculpture'] },
  { name: 'Music', keywords: ['music', 'musical', 'rhythm', 'instrument', 'choir'] },
  { name: 'Physical Education', keywords: ['physical education', 'sport', 'athletics', 'fitness', 'football', 'basketball'] },
  { name: 'Languages', keywords: ['french', 'spanish', 'german', 'arabic', 'mandarin', 'language'] },
  { name: 'Religious Studies', keywords: ['religious', 'religion', 're studies', 'islamic', 'bible', 'quran'] },
  { name: 'Administration', keywords: ['schedule', 'timetable', 'calendar', 'policy', 'handbook', 'form', 'letter', 'notice', 'report card', 'admission'] }
];

// Document kinds, derived from the extension.
export const RESOURCE_TYPE_NAMES = {
  html: 'Interactive mini app',
  htm: 'Interactive mini app',
  pdf: 'PDF document',
  doc: 'Word document',
  docx: 'Word document',
  xls: 'Excel spreadsheet',
  xlsx: 'Excel spreadsheet',
  ppt: 'PowerPoint presentation',
  pptx: 'PowerPoint presentation'
};

// ---------------------------------------------------------------------------
// Structured metadata vocabulary.
//
// The file name is *never* the primary title: a human-readable title is
// supplied by the teacher (or curated in library.json) and the file name is
// kept as secondary, searchable text. "16G.pdf" tells a student far less than
// "Continuous Probability Distributions — Exercise 16G Solutions".
// ---------------------------------------------------------------------------

/** Visibility of a resource, as set by the teacher. */
export const VISIBILITY_PUBLIC = 'public';
export const VISIBILITY_SCHOOL = 'school';
export const VISIBILITY_CLASS = 'class';

export const VISIBILITY_OPTIONS = [
  { value: VISIBILITY_PUBLIC, label: 'Public', hint: 'Listed for everyone, including families and the wider community.' },
  { value: VISIBILITY_SCHOOL, label: 'School only', hint: 'Intended for staff and students of the school.' },
  { value: VISIBILITY_CLASS, label: 'Class only', hint: 'Intended for one class or teaching group.' }
];

const VISIBILITY_LABELS = {
  [VISIBILITY_PUBLIC]: 'Public',
  [VISIBILITY_SCHOOL]: 'School only',
  [VISIBILITY_CLASS]: 'Class only'
};

/** Normalise any input to a known visibility value (default: public). */
export function normaliseVisibility(value) {
  const text = String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '-');
  if (text === 'school' || text === 'school-only' || text === 'internal') return VISIBILITY_SCHOOL;
  if (text === 'class' || text === 'class-only' || text === 'classroom') return VISIBILITY_CLASS;
  return VISIBILITY_PUBLIC;
}

/** Human label for a visibility value. */
export function visibilityLabel(value) {
  return VISIBILITY_LABELS[normaliseVisibility(value)] || VISIBILITY_LABELS[VISIBILITY_PUBLIC];
}

/** True when a review/expiry date exists and has passed. */
export function isReviewDue(reviewDate, now = new Date()) {
  if (!reviewDate) return false;
  const date = new Date(reviewDate);
  if (Number.isNaN(date.getTime())) return false;
  return date.getTime() <= now.getTime();
}

/** Lowercase extension without the dot, or '' when there is none. */
export function extensionOf(fileName) {
  const match = String(fileName || '').match(/\.([A-Za-z0-9]+)$/);
  return match ? match[1].toLowerCase() : '';
}

/** Human label for a file's kind. */
export function kindOf(fileName) {
  return RESOURCE_TYPE_NAMES[extensionOf(fileName)] || 'Classroom resource';
}

/** True when the file is an interactive HTML mini app rather than a document. */
export function isMiniApp(fileName) {
  const extension = extensionOf(fileName);
  return extension === 'html' || extension === 'htm';
}

/**
 * Pull year groups out of free text.
 * Handles "Year 10", "Yr 7", "Grade 9", "Y11", "Year 10 & 11", "Years 7-9".
 * Returns a sorted, de-duplicated array of numbers between 1 and 13.
 */
export function inferYears(text) {
  const haystack = String(text || '').toLowerCase();
  const years = new Set();

  // Ranges first: "years 7-9", "year 7 to 9".
  const rangePattern = /\b(?:years?|yrs?|grades?|y)\s*(\d{1,2})\s*(?:-|–|—|to|through)\s*(\d{1,2})\b/g;
  let match;
  while ((match = rangePattern.exec(haystack)) !== null) {
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (start <= end && end - start <= 12) {
      for (let year = start; year <= end; year += 1) {
        if (year >= 1 && year <= 13) years.add(year);
      }
    }
  }

  // "Year 10 & 11", "Year 10 and 11", "Year 10, 11".
  const listPattern = /\b(?:years?|yrs?|grades?|y)\s*(\d{1,2})((?:\s*(?:&|and|,|\+)\s*\d{1,2})*)/g;
  while ((match = listPattern.exec(haystack)) !== null) {
    const first = Number(match[1]);
    if (first >= 1 && first <= 13) years.add(first);
    const rest = match[2] || '';
    const restPattern = /(\d{1,2})/g;
    let restMatch;
    while ((restMatch = restPattern.exec(rest)) !== null) {
      const year = Number(restMatch[1]);
      if (year >= 1 && year <= 13) years.add(year);
    }
  }

  return [...years].sort((a, b) => a - b);
}

/** First subject whose keywords appear in the text, else UNKNOWN_SUBJECT. */
export function inferSubject(text) {
  const haystack = ` ${String(text || '').toLowerCase()} `;
  for (const subject of SUBJECTS) {
    for (const keyword of subject.keywords) {
      // Word-boundary match so "art" does not fire inside "chart".
      const pattern = new RegExp(`(^|[^a-z])${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`);
      if (pattern.test(haystack)) return subject.name;
    }
  }
  return UNKNOWN_SUBJECT;
}

/** Turn "16G.pdf" / "2024-01-year-10-algebra.pdf" into a readable title. */
export function titleFromFileName(fileName) {
  const base = String(fileName || '')
    .replace(/^\d+[-_ ]+/, '')          // strip a leading numeric prefix
    .replace(/\.[A-Za-z0-9]+$/, '')     // strip the extension
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return base || String(fileName || 'Untitled');
}

/** Normalise a user-supplied tag list into clean lowercase strings. */
export function normaliseTags(value) {
  const list = Array.isArray(value)
    ? value
    : String(value || '').split(/[,;]/);
  const seen = new Set();
  for (const entry of list) {
    const tag = String(entry || '').trim().toLowerCase();
    if (tag) seen.add(tag);
  }
  return [...seen];
}

/**
 * Build the full metadata record for one library item.
 *
 * Values are resolved from three layers, in increasing order of authority:
 * inference from the text, fields carried on the item itself (uploads and
 * approved submissions persist their metadata there), and library.json
 * overrides curated by the administrator.
 *
 * `tags` and `keywords` are synonyms: library.json has always used `tags`,
 * while the upload form labels the field "Keywords". Both are normalised
 * into `meta.tags`.
 *
 * @param {object} item      Raw app/resource record.
 * @param {object} overrides library.json entry for this item, if any.
 */
export function buildMetadata(item, overrides = {}) {
  const fileName = item?.fileName || '';
  const searchText = [fileName, item?.name, item?.description, overrides?.description, item?.topic]
    .filter(Boolean)
    .join(' ');

  const subject = (overrides.subject || item?.subject)
    ? String(overrides.subject || item?.subject).trim()
    : inferSubject(searchText);

  const rawYears = Array.isArray(overrides.years) && overrides.years.length
    ? overrides.years
    : (Array.isArray(item?.years) && item.years.length ? item.years : null);
  const years = rawYears
    ? [...new Set(rawYears.map(Number).filter(year => Number.isFinite(year)))].sort((a, b) => a - b)
    : inferYears(searchText);

  const rawTags = overrides.tags ?? overrides.keywords ?? item?.keywords ?? item?.tags;
  const tags = normaliseTags(rawTags);
  const extension = extensionOf(fileName);

  const pick = (key, fallback = '') => {
    const value = overrides[key] ?? item?.[key];
    return value === undefined || value === null ? fallback : String(value).trim();
  };

  const visibility = normaliseVisibility(overrides.visibility ?? item?.visibility);

  return {
    // The human title. Never the bare file name — the name is kept as
    // secondary text and remains searchable.
    title: String(overrides.title || item?.name || titleFromFileName(fileName) || 'Untitled').trim(),
    subject: subject || UNKNOWN_SUBJECT,
    years,
    tags,
    extension,
    kind: kindOf(fileName),
    isMiniApp: isMiniApp(fileName),
    topic: pick('topic'),
    resourceType: pick('resourceType'),
    language: pick('language') || 'English',
    owner: String(overrides.owner || item?.teacherName || '').trim(),
    department: pick('department'),
    academicYear: pick('academicYear'),
    visibility,
    version: pick('version', '1.0') || '1.0',
    reviewDate: pick('reviewDate'),
    licence: pick('licence'),
    accessibility: pick('accessibility'),
    // When the resource joined the library (curated value wins), used by the
    // dashboard to show the Latest / Yesterday / date-added badge.
    addedAt: pick('addedAt') || pick('publishedAt'),
    // Whether any of the values above were curated rather than guessed.
    curated: Boolean(
      overrides.subject || overrides.years || overrides.tags || overrides.keywords ||
      overrides.description || overrides.title || overrides.topic || overrides.resourceType ||
      overrides.language || overrides.department || overrides.academicYear ||
      overrides.visibility || overrides.version || overrides.reviewDate ||
      overrides.licence || overrides.accessibility ||
      item?.subject || item?.keywords || item?.topic
    )
  };
}

/**
 * Index a library.json payload so entries can be found by path or file name.
 * Accepts either an object keyed by path, or an array of { path, ... } records.
 */
export function indexOverrides(payload) {
  const index = new Map();
  const add = (key, value) => {
    const normalised = String(key || '').trim().toLowerCase().replace(/^\/+/, '');
    if (normalised) index.set(normalised, value);
  };

  if (Array.isArray(payload)) {
    for (const entry of payload) {
      if (!entry || typeof entry !== 'object') continue;
      if (entry.path) add(entry.path, entry);
      if (entry.fileName) add(entry.fileName, entry);
    }
  } else if (payload && typeof payload === 'object') {
    for (const [key, value] of Object.entries(payload)) {
      if (value && typeof value === 'object') add(key, value);
    }
  }

  return index;
}

/** Look an item up in an override index built by indexOverrides(). */
export function findOverride(index, item) {
  if (!index || typeof index.get !== 'function') return {};
  const candidates = [item?.githubPath, item?.fileName, `apps/${item?.fileName || ''}`];
  for (const candidate of candidates) {
    const key = String(candidate || '').trim().toLowerCase().replace(/^\/+/, '');
    if (key && index.has(key)) return index.get(key);
  }
  return {};
}
