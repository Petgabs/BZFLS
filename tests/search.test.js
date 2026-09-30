import { describe, it, expect } from 'vitest';
import {
  normalise,
  parseQuery,
  scoreItem,
  queryLibrary,
  availableSubjects,
  availableYears,
  facetCounts
} from '../assets/js/lib/search.js';
import { buildMetadata } from '../assets/js/lib/metadata.js';

/** Build a library item with real metadata attached. */
function item(name, fileName, extra = {}) {
  const base = { id: name, name, fileName, description: '', teacherName: 'GitHub Library', ...extra };
  return { ...base, meta: buildMetadata(base, extra.overrides || {}) };
}

const library = [
  item('Algebra Practice', 'Year 9 algebra practice.html'),
  item('Photosynthesis Diagram', 'Year 10 photosynthesis biology.pdf'),
  item('Class Schedule', 'Year 10 & 11  class schedule.pdf'),
  item('Python Basics', 'Year 11 python coding.html'),
  item('Café Menu Project', 'Year 8 cafe french menu.docx')
];

describe('normalise', () => {
  it('strips accents and punctuation', () => {
    expect(normalise('Café — Menu!')).toBe('cafe menu');
  });

  it('collapses whitespace', () => {
    expect(normalise('  a   b  ')).toBe('a b');
  });

  it('handles nullish input', () => {
    expect(normalise(null)).toBe('');
  });
});

describe('parseQuery', () => {
  it('splits into unique terms', () => {
    expect(parseQuery('year 10 year')).toEqual(['year', '10']);
  });

  it('returns an empty array for blank input', () => {
    expect(parseQuery('   ')).toEqual([]);
  });
});

describe('scoreItem', () => {
  it('returns 1 when there is no query', () => {
    expect(scoreItem(library[0], [])).toBe(1);
  });

  it('returns 0 when any term is missing (AND semantics)', () => {
    expect(scoreItem(library[0], ['algebra', 'chemistry'])).toBe(0);
  });

  it('ranks a title match above a body-only match', () => {
    const titleMatch = scoreItem(library[0], ['algebra']);
    const bodyMatch = scoreItem(library[0], ['github']);
    expect(titleMatch).toBeGreaterThan(bodyMatch);
  });
});

describe('queryLibrary', () => {
  it('returns everything when unfiltered', () => {
    expect(queryLibrary(library, {})).toHaveLength(5);
  });

  it('searches across the file name', () => {
    const results = queryLibrary(library, { query: 'python' });
    expect(results.map(entry => entry.name)).toEqual(['Python Basics']);
  });

  it('matches accented text via its plain form', () => {
    const results = queryLibrary(library, { query: 'cafe' });
    expect(results.map(entry => entry.name)).toEqual(['Café Menu Project']);
  });

  it('finds items by year through the search box', () => {
    const results = queryLibrary(library, { query: 'year 11' });
    const names = results.map(entry => entry.name);
    expect(names).toContain('Class Schedule');
    expect(names).toContain('Python Basics');
  });

  it('filters by subject', () => {
    const results = queryLibrary(library, { subject: 'Biology' });
    expect(results.map(entry => entry.name)).toEqual(['Photosynthesis Diagram']);
  });

  it('filters by year group', () => {
    const results = queryLibrary(library, { year: 11 });
    const names = results.map(entry => entry.name).sort();
    expect(names).toEqual(['Class Schedule', 'Python Basics']);
  });

  it('accepts a year passed as a string, as the <select> provides it', () => {
    expect(queryLibrary(library, { year: '9' }).map(entry => entry.name)).toEqual(['Algebra Practice']);
  });

  it('filters by kind', () => {
    expect(queryLibrary(library, { kind: 'app' })).toHaveLength(2);
    expect(queryLibrary(library, { kind: 'document' })).toHaveLength(3);
  });

  it('combines filters', () => {
    const results = queryLibrary(library, { query: 'python', year: 11, kind: 'app' });
    expect(results.map(entry => entry.name)).toEqual(['Python Basics']);
  });

  it('returns nothing when filters conflict', () => {
    expect(queryLibrary(library, { subject: 'Biology', year: 9 })).toEqual([]);
  });

  it('sorts by downloads', () => {
    const downloads = { 'Algebra Practice': 5, 'Python Basics': 99 };
    const results = queryLibrary(library, {
      kind: 'app',
      sort: 'downloads',
      downloadsOf: entry => downloads[entry.name] || 0
    });
    expect(results[0].name).toBe('Python Basics');
  });

  it('sorts by name', () => {
    const results = queryLibrary(library, { sort: 'name' });
    expect(results[0].name).toBe('Algebra Practice');
  });

  it('sorts by newest', () => {
    const dated = [
      item('Old', 'old.pdf', { createdAt: '2020-01-01T00:00:00Z' }),
      item('New', 'new.pdf', { createdAt: '2025-01-01T00:00:00Z' })
    ];
    expect(queryLibrary(dated, { sort: 'newest' })[0].name).toBe('New');
  });

  it('tolerates an empty or missing collection', () => {
    expect(queryLibrary([], { query: 'x' })).toEqual([]);
    expect(queryLibrary(undefined, {})).toEqual([]);
  });
});

describe('facets', () => {
  it('lists subjects alphabetically', () => {
    const subjects = availableSubjects(library);
    expect(subjects).toEqual([...subjects].sort());
    expect(subjects).toContain('Biology');
  });

  it('lists years ascending', () => {
    expect(availableYears(library)).toEqual([8, 9, 10, 11]);
  });

  it('counts items per facet', () => {
    const counts = facetCounts(library);
    expect(counts.apps).toBe(2);
    expect(counts.documents).toBe(3);
    expect(counts.years.get(10)).toBe(2);
    expect(counts.subjects.get('Biology')).toBe(1);
  });
});
