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
  { name: 'Mathematics', keywords: ['math', 'maths', 'mathematics', 'algebra', 'geometry', 'calculus', 'trigonometry', 'statistics', 'arithmetic', 'numeracy'] },
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
 * @param {object} item      Raw app/resource record.
 * @param {object} overrides library.json entry for this item, if any.
 */
export function buildMetadata(item, overrides = {}) {
  const fileName = item?.fileName || '';
  const searchText = [fileName, item?.name, item?.description, overrides?.description]
    .filter(Boolean)
    .join(' ');

  const subject = overrides.subject
    ? String(overrides.subject).trim()
    : inferSubject(searchText);

  const years = Array.isArray(overrides.years) && overrides.years.length
    ? [...new Set(overrides.years.map(Number).filter(year => Number.isFinite(year)))].sort((a, b) => a - b)
    : inferYears(searchText);

  const tags = normaliseTags(overrides.tags);
  const extension = extensionOf(fileName);

  return {
    subject: subject || UNKNOWN_SUBJECT,
    years,
    tags,
    extension,
    kind: kindOf(fileName),
    isMiniApp: isMiniApp(fileName),
    // Whether any of the values above were curated rather than guessed.
    curated: Boolean(overrides.subject || overrides.years || overrides.tags || overrides.description)
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
