// ---------------------------------------------------------------------------
// Search, filtering and sorting for the public library.
//
// Pure functions over plain arrays so the whole query pipeline can be unit
// tested without a browser.
// ---------------------------------------------------------------------------

/** Strip accents and punctuation so "Café" matches "cafe". */
export function normalise(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Everything about an item that a search query may match. */
export function searchableText(item) {
  const meta = item?.meta || {};
  return normalise([
    item?.name,
    item?.description,
    item?.fileName,
    item?.teacherName,
    meta.subject,
    meta.kind,
    (meta.tags || []).join(' '),
    (meta.years || []).map(year => `year ${year} y${year} grade ${year}`).join(' ')
  ].filter(Boolean).join(' '));
}

/**
 * Score one item against a set of query terms.
 * Returns 0 when any term is missing entirely (AND semantics).
 */
export function scoreItem(item, terms) {
  if (!terms.length) return 1;

  const haystack = searchableText(item);
  const title = normalise(item?.name);
  let score = 0;

  for (const term of terms) {
    if (!haystack.includes(term)) return 0;

    // Title matches outrank body matches; whole-word beats substring.
    if (title === term) score += 100;
    else if (title.startsWith(term)) score += 50;
    else if (new RegExp(`(^|\\s)${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(title)) score += 30;
    else if (title.includes(term)) score += 15;
    else score += 5;
  }

  return score;
}

/** Split a raw query string into distinct lowercase terms. */
export function parseQuery(query) {
  return [...new Set(normalise(query).split(' ').filter(Boolean))];
}

/**
 * Apply search + facet filters + sorting.
 *
 * @param {Array}  items
 * @param {object} options
 * @param {string} options.query
 * @param {string} options.subject  Subject name, or '' for all.
 * @param {string|number} options.year  Year number, or '' for all.
 * @param {string} options.kind     'app' | 'document' | '' for all.
 * @param {string} options.sort     'relevance' | 'downloads' | 'name' | 'newest'
 * @param {(item:any)=>number} options.downloadsOf
 */
export function queryLibrary(items, options = {}) {
  const {
    query = '',
    subject = '',
    year = '',
    kind = '',
    sort = 'relevance',
    downloadsOf = () => 0
  } = options;

  const terms = parseQuery(query);
  const yearFilter = year === '' || year === null || year === undefined ? null : Number(year);

  const matched = [];
  for (const item of items || []) {
    const meta = item?.meta || {};

    if (subject && meta.subject !== subject) continue;
    if (yearFilter !== null && !(meta.years || []).includes(yearFilter)) continue;
    if (kind === 'app' && !meta.isMiniApp) continue;
    if (kind === 'document' && meta.isMiniApp) continue;

    const score = scoreItem(item, terms);
    if (!score) continue;

    matched.push({ item, score });
  }

  const comparators = {
    relevance: (a, b) =>
      b.score - a.score ||
      downloadsOf(b.item) - downloadsOf(a.item) ||
      String(a.item?.name || '').localeCompare(String(b.item?.name || '')),
    downloads: (a, b) =>
      downloadsOf(b.item) - downloadsOf(a.item) ||
      String(a.item?.name || '').localeCompare(String(b.item?.name || '')),
    name: (a, b) =>
      String(a.item?.name || '').localeCompare(String(b.item?.name || ''), undefined, { numeric: true }),
    newest: (a, b) =>
      new Date(b.item?.createdAt || 0) - new Date(a.item?.createdAt || 0) ||
      String(a.item?.name || '').localeCompare(String(b.item?.name || ''))
  };

  matched.sort(comparators[sort] || comparators.relevance);
  return matched.map(entry => entry.item);
}

/** Distinct subjects present in the collection, alphabetically. */
export function availableSubjects(items) {
  const subjects = new Set();
  for (const item of items || []) {
    const subject = item?.meta?.subject;
    if (subject) subjects.add(subject);
  }
  return [...subjects].sort((a, b) => a.localeCompare(b));
}

/** Distinct year groups present in the collection, ascending. */
export function availableYears(items) {
  const years = new Set();
  for (const item of items || []) {
    for (const year of item?.meta?.years || []) years.add(Number(year));
  }
  return [...years].filter(Number.isFinite).sort((a, b) => a - b);
}

/** Count how many items sit behind each facet value, for filter badges. */
export function facetCounts(items) {
  const subjects = new Map();
  const years = new Map();
  let apps = 0;
  let documents = 0;

  for (const item of items || []) {
    const meta = item?.meta || {};
    if (meta.subject) subjects.set(meta.subject, (subjects.get(meta.subject) || 0) + 1);
    for (const year of meta.years || []) years.set(year, (years.get(year) || 0) + 1);
    if (meta.isMiniApp) apps += 1;
    else documents += 1;
  }

  return { subjects, years, apps, documents };
}
