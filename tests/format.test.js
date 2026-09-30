import { describe, it, expect } from 'vitest';
import {
  formatCount,
  downloadLabel,
  formatDate,
  formatBytes,
  formatYears,
  iconForExtension,
  subjectAccent,
  describeFilters
} from '../assets/js/lib/format.js';

describe('formatCount', () => {
  it('formats numbers', () => {
    expect(formatCount(1234)).toBe((1234).toLocaleString());
  });

  it('coerces junk to zero', () => {
    expect(formatCount(undefined)).toBe('0');
    expect(formatCount('abc')).toBe('0');
    expect(formatCount(NaN)).toBe('0');
  });
});

describe('downloadLabel', () => {
  it('uses the singular for one', () => {
    expect(downloadLabel(1)).toBe('1 download');
  });

  it('uses the plural otherwise', () => {
    expect(downloadLabel(0)).toBe('0 downloads');
    expect(downloadLabel(2)).toBe('2 downloads');
  });
});

describe('formatDate', () => {
  it('formats a valid ISO date', () => {
    expect(formatDate('2025-03-04T00:00:00Z')).toMatch(/2025/);
  });

  it('reports unparseable input clearly', () => {
    expect(formatDate('not a date')).toBe('Unknown date');
    expect(formatDate(undefined)).toBe('Unknown date');
  });
});

describe('formatBytes', () => {
  it('formats each magnitude', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });

  it('returns an empty string for unknown sizes', () => {
    expect(formatBytes(0)).toBe('');
    expect(formatBytes(undefined)).toBe('');
  });
});

describe('formatYears', () => {
  it('formats a single year', () => {
    expect(formatYears([10])).toBe('Year 10');
  });

  it('joins two years with an ampersand', () => {
    expect(formatYears([10, 11])).toBe('Years 10 & 11');
  });

  it('collapses a contiguous run into a range', () => {
    expect(formatYears([7, 8, 9])).toBe('Years 7–9');
  });

  it('lists a non-contiguous set', () => {
    expect(formatYears([7, 9, 11])).toBe('Years 7, 9 & 11');
  });

  it('sorts and de-duplicates', () => {
    expect(formatYears([11, 10, 11])).toBe('Years 10 & 11');
  });

  it('returns an empty string when unknown', () => {
    expect(formatYears([])).toBe('');
    expect(formatYears(undefined)).toBe('');
  });
});

describe('iconForExtension', () => {
  it('maps known types', () => {
    expect(iconForExtension('pdf')).toBe('file-text');
    expect(iconForExtension('HTML')).toBe('file-code');
    expect(iconForExtension('xlsx')).toBe('sheet');
    expect(iconForExtension('pptx')).toBe('presentation');
  });

  it('falls back for unknown types', () => {
    expect(iconForExtension('zip')).toBe('file');
  });
});

describe('subjectAccent', () => {
  it('is stable for the same subject', () => {
    expect(subjectAccent('Mathematics')).toBe(subjectAccent('Mathematics'));
  });

  it('returns Tailwind classes the safelist covers', () => {
    expect(subjectAccent('Biology')).toMatch(/^bg-\w+-50 text-\w+-700 ring-\w+-200$/);
  });
});

describe('describeFilters', () => {
  it('describes a query', () => {
    expect(describeFilters({ query: 'algebra' })).toContain('algebra');
  });

  it('describes combined facets', () => {
    const text = describeFilters({ subject: 'Biology', year: 10, kind: 'app' });
    expect(text).toContain('in Biology');
    expect(text).toContain('Year 10');
    expect(text).toContain('mini apps');
  });

  it('is empty with no filters', () => {
    expect(describeFilters({})).toBe('');
  });
});
