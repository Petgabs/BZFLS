import { describe, it, expect } from 'vitest';
import {
  inferYears,
  inferSubject,
  titleFromFileName,
  extensionOf,
  kindOf,
  isMiniApp,
  normaliseTags,
  buildMetadata,
  indexOverrides,
  findOverride,
  UNKNOWN_SUBJECT
} from '../assets/js/lib/metadata.js';

describe('extensionOf', () => {
  it('lowercases the extension', () => {
    expect(extensionOf('Report.PDF')).toBe('pdf');
  });

  it('handles names with several dots', () => {
    expect(extensionOf('year.10.notes.docx')).toBe('docx');
  });

  it('returns an empty string when there is no extension', () => {
    expect(extensionOf('README')).toBe('');
    expect(extensionOf(null)).toBe('');
  });
});

describe('kindOf / isMiniApp', () => {
  it('names known document types', () => {
    expect(kindOf('a.pdf')).toBe('PDF document');
    expect(kindOf('a.xlsx')).toBe('Excel spreadsheet');
    expect(kindOf('a.pptx')).toBe('PowerPoint presentation');
  });

  it('falls back for unknown types', () => {
    expect(kindOf('a.zip')).toBe('Classroom resource');
  });

  it('identifies mini apps', () => {
    expect(isMiniApp('quiz.html')).toBe(true);
    expect(isMiniApp('quiz.htm')).toBe(true);
    expect(isMiniApp('quiz.pdf')).toBe(false);
  });
});

describe('inferYears', () => {
  it('reads a single year', () => {
    expect(inferYears('Year 10 revision')).toEqual([10]);
  });

  it('reads the real repository file name', () => {
    expect(inferYears('Year 10 & 11  class schedule.pdf')).toEqual([10, 11]);
  });

  it('reads "and" lists and commas', () => {
    expect(inferYears('Year 7 and 8')).toEqual([7, 8]);
    expect(inferYears('Year 7, 8, 9')).toEqual([7, 8, 9]);
  });

  it('expands ranges', () => {
    expect(inferYears('Years 7-9 handbook')).toEqual([7, 8, 9]);
    expect(inferYears('Years 7 to 9')).toEqual([7, 8, 9]);
  });

  it('accepts grade and abbreviated forms', () => {
    expect(inferYears('Grade 9 science')).toEqual([9]);
    expect(inferYears('Yr 11 mock')).toEqual([11]);
  });

  it('ignores out-of-range numbers', () => {
    expect(inferYears('Year 99 nonsense')).toEqual([]);
    expect(inferYears('Year 0')).toEqual([]);
  });

  it('returns an empty array when there is no year', () => {
    expect(inferYears('Periodic table explorer')).toEqual([]);
    expect(inferYears(undefined)).toEqual([]);
  });

  it('de-duplicates and sorts', () => {
    expect(inferYears('Year 11 and 10 and 11')).toEqual([10, 11]);
  });
});

describe('inferSubject', () => {
  it('detects subjects from keywords', () => {
    expect(inferSubject('Algebra practice')).toBe('Mathematics');
    expect(inferSubject('Photosynthesis diagram')).toBe('Biology');
    expect(inferSubject('Python coding tasks')).toBe('Computing');
  });

  it('classifies timetables as administration', () => {
    expect(inferSubject('Year 10 & 11 class schedule.pdf')).toBe('Administration');
  });

  it('does not match a keyword inside a longer word', () => {
    // "art" must not fire on "chart".
    expect(inferSubject('Bar chart builder')).not.toBe('Art & Design');
  });

  it('falls back to the default subject', () => {
    expect(inferSubject('16G')).toBe(UNKNOWN_SUBJECT);
    expect(inferSubject('')).toBe(UNKNOWN_SUBJECT);
  });
});

describe('titleFromFileName', () => {
  it('strips the extension and tidies separators', () => {
    expect(titleFromFileName('periodic-table_explorer.html')).toBe('periodic table explorer');
  });

  it('strips a leading numeric prefix', () => {
    expect(titleFromFileName('2024-quiz.html')).toBe('quiz');
  });

  it('keeps a name that is only an extension-less token', () => {
    expect(titleFromFileName('16G.pdf')).toBe('16G');
  });

  it('collapses repeated whitespace', () => {
    expect(titleFromFileName('Year 10 & 11  class schedule.pdf')).toBe('Year 10 & 11 class schedule');
  });
});

describe('normaliseTags', () => {
  it('accepts arrays and strings', () => {
    expect(normaliseTags(['Revision', 'QUIZ'])).toEqual(['revision', 'quiz']);
    expect(normaliseTags('revision, quiz')).toEqual(['revision', 'quiz']);
  });

  it('removes blanks and duplicates', () => {
    expect(normaliseTags(['a', '', 'a', '  '])).toEqual(['a']);
    expect(normaliseTags(null)).toEqual([]);
  });
});

describe('buildMetadata', () => {
  it('infers everything when there are no overrides', () => {
    const meta = buildMetadata({ fileName: 'Year 9 algebra worksheet.pdf' });
    expect(meta.subject).toBe('Mathematics');
    expect(meta.years).toEqual([9]);
    expect(meta.extension).toBe('pdf');
    expect(meta.kind).toBe('PDF document');
    expect(meta.isMiniApp).toBe(false);
    expect(meta.curated).toBe(false);
  });

  it('lets overrides win over inference', () => {
    const meta = buildMetadata(
      { fileName: 'Year 9 algebra worksheet.pdf' },
      { subject: 'Physics', years: [12], tags: ['Mechanics'] }
    );
    expect(meta.subject).toBe('Physics');
    expect(meta.years).toEqual([12]);
    expect(meta.tags).toEqual(['mechanics']);
    expect(meta.curated).toBe(true);
  });

  it('marks HTML uploads as mini apps', () => {
    expect(buildMetadata({ fileName: 'game.html' }).isMiniApp).toBe(true);
  });

  it('survives an empty item', () => {
    const meta = buildMetadata({});
    expect(meta.subject).toBe(UNKNOWN_SUBJECT);
    expect(meta.years).toEqual([]);
    expect(meta.tags).toEqual([]);
  });
});

describe('indexOverrides / findOverride', () => {
  const payload = {
    'apps/Year 10 & 11  class schedule.pdf': { subject: 'Administration', years: [10, 11] },
    'quiz.html': { subject: 'Science' }
  };

  it('finds an entry by repository path', () => {
    const index = indexOverrides(payload);
    const found = findOverride(index, { githubPath: 'apps/Year 10 & 11  class schedule.pdf' });
    expect(found.subject).toBe('Administration');
  });

  it('finds an entry by bare file name', () => {
    const index = indexOverrides(payload);
    expect(findOverride(index, { fileName: 'quiz.html' }).subject).toBe('Science');
  });

  it('matches case-insensitively', () => {
    const index = indexOverrides(payload);
    expect(findOverride(index, { fileName: 'QUIZ.HTML' }).subject).toBe('Science');
  });

  it('accepts an array payload', () => {
    const index = indexOverrides([{ path: 'apps/a.pdf', subject: 'History' }]);
    expect(findOverride(index, { githubPath: 'apps/a.pdf' }).subject).toBe('History');
  });

  it('returns an empty object when nothing matches', () => {
    const index = indexOverrides(payload);
    expect(findOverride(index, { fileName: 'missing.pdf' })).toEqual({});
    expect(findOverride(null, { fileName: 'quiz.html' })).toEqual({});
  });
});
