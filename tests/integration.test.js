// ---------------------------------------------------------------------------
// End-to-end smoke test.
//
// Boots the real index.html in jsdom with the real Alpine bundle and a stubbed
// network, then drives the component the way a visitor would: load the
// library, search it, filter it, and open a preview. This is what catches
// wiring mistakes that the pure unit tests cannot see.
// ---------------------------------------------------------------------------

// @vitest-environment jsdom

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The shape GitHub's contents API (and our apps.json manifest) returns. */
const MANIFEST = [
  {
    type: 'file',
    name: 'Year 10 & 11  class schedule.pdf',
    path: 'apps/Year 10 & 11  class schedule.pdf',
    sha: 'sha-schedule',
    download_url: 'https://example.test/apps/schedule.pdf'
  },
  {
    type: 'file',
    name: 'Year 9 algebra practice.html',
    path: 'apps/Year 9 algebra practice.html',
    sha: 'sha-algebra',
    download_url: 'https://example.test/apps/algebra.html'
  },
  {
    type: 'file',
    name: 'Year 11 python coding.html',
    path: 'apps/Year 11 python coding.html',
    sha: 'sha-python',
    download_url: 'https://example.test/apps/python.html'
  },
  // Must be ignored: unsupported extension.
  { type: 'file', name: 'notes.zip', path: 'apps/notes.zip', sha: 'sha-zip', download_url: 'x' }
];

let component;

beforeAll(async () => {
  const html = await readFile(resolve(root, 'index.html'), 'utf8');

  // Install the real markup into the jsdom document this test runs in, so
  // Alpine walks exactly the DOM that ships to users.
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  const bodyAttrs = html.match(/<body([^>]*)>/i)[1];
  document.body.innerHTML = bodyMatch[1];
  for (const attribute of bodyAttrs.matchAll(/([\w:@.-]+)="([^"]*)"/g)) {
    document.body.setAttribute(attribute[1], attribute[2]);
  }

  // --- Stub the network ---------------------------------------------------
  const fetchStub = vi.fn(async url => {
    const href = String(url);
    if (href.includes('library.json')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          'apps/Year 10 & 11  class schedule.pdf': {
            subject: 'Administration',
            years: [10, 11],
            tags: ['timetable'],
            description: 'Weekly class timetable for Year 10 and Year 11.'
          }
        })
      };
    }
    if (href.includes('apps.json')) {
      return { ok: true, status: 200, json: async () => MANIFEST };
    }
    // Counter traffic: pretend every backend is down so the local mirror runs.
    throw new Error('network disabled in tests');
  });
  vi.stubGlobal('fetch', fetchStub);

  // The manifest path is only used when the site believes it is on Pages.
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: new URL('https://petgabs.github.io/BZFLS/')
  });

  // Lucide is a UMD bundle that needs a DOM; load the vendored copy so any
  // icon wiring mistake surfaces here too.
  const lucideSource = await readFile(resolve(root, 'assets/vendor/lucide.min.js'), 'utf8');
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', `${lucideSource}`)(window, document);

  const { schoolCloud } = await import('../assets/js/app.js');
  window.schoolCloud = schoolCloud;
  globalThis.schoolCloud = schoolCloud;

  const alpineSource = await readFile(resolve(root, 'assets/vendor/alpine.min.js'), 'utf8');
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', `${alpineSource}`)(window, document);

  // Give Alpine a tick to walk the DOM and run x-init, then let the async
  // library sync inside init() settle.
  await new Promise(done => setTimeout(done, 300));
  component = window.Alpine.$data(document.body);
  await new Promise(done => setTimeout(done, 400));
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('library boots in a browser', () => {
  it('mounts the Alpine component', () => {
    expect(component).toBeTruthy();
    expect(component.currentView).toBe('library');
  });

  it('loads the manifest and ignores unsupported files', () => {
    expect(component.apps.length).toBe(3);
    expect(component.apps.some(app => app.fileName === 'notes.zip')).toBe(false);
  });

  it('finishes loading and reports no error', () => {
    expect(component.loading.library).toBe(false);
    expect(component.errors.library).toBe('');
  });

  it('attaches structured metadata to every item', () => {
    for (const app of component.apps) {
      expect(app.meta).toBeTruthy();
      expect(typeof app.meta.subject).toBe('string');
      expect(Array.isArray(app.meta.years)).toBe(true);
    }
  });

  it('applies curated metadata from library.json', () => {
    const schedule = component.apps.find(app => app.fileName.includes('class schedule'));
    expect(schedule.meta.subject).toBe('Administration');
    expect(schedule.meta.years).toEqual([10, 11]);
    expect(schedule.meta.tags).toContain('timetable');
    expect(schedule.description).toContain('Weekly class timetable');
  });

  it('infers metadata for files with no curated entry', () => {
    const algebra = component.apps.find(app => app.fileName.includes('algebra'));
    expect(algebra.meta.subject).toBe('Mathematics');
    expect(algebra.meta.years).toEqual([9]);
    expect(algebra.meta.isMiniApp).toBe(true);
  });

  it('separates mini apps from documents', () => {
    expect(component.miniApps.length).toBe(2);
    expect(component.resources.length).toBe(1);
  });

  it('builds facet lists from the loaded data', () => {
    expect(component.subjectOptions).toContain('Mathematics');
    expect(component.yearOptions).toEqual([9, 10, 11]);
  });
});

describe('search and filtering', () => {
  it('starts unfiltered', () => {
    component.clearFilters();
    expect(component.resultCount).toBe(3);
    expect(component.hasActiveFilters).toBe(false);
  });

  it('narrows results by free-text search', () => {
    component.filters.query = 'python';
    expect(component.filteredApps.map(app => app.fileName)).toEqual(['Year 11 python coding.html']);
  });

  it('finds a document by its curated description', () => {
    component.clearFilters();
    component.filters.query = 'timetable';
    expect(component.resultCount).toBe(1);
  });

  it('filters by subject', () => {
    component.clearFilters();
    component.setSubject('Mathematics');
    expect(component.resultCount).toBe(1);
  });

  it('toggles a subject off when clicked twice', () => {
    component.clearFilters();
    component.setSubject('Mathematics');
    component.setSubject('Mathematics');
    expect(component.filters.subject).toBe('');
    expect(component.resultCount).toBe(3);
  });

  it('filters by year group', () => {
    component.clearFilters();
    component.setYear(11);
    const names = component.filteredApps.map(app => app.fileName).sort();
    expect(names).toEqual(['Year 10 & 11  class schedule.pdf', 'Year 11 python coding.html']);
  });

  it('filters by kind', () => {
    component.clearFilters();
    component.setKind('document');
    expect(component.resultCount).toBe(1);
  });

  it('returns nothing for a query that matches no file', () => {
    component.clearFilters();
    component.filters.query = 'chemistry titration';
    expect(component.resultCount).toBe(0);
  });

  it('clears every filter at once', () => {
    component.filters.query = 'python';
    component.setSubject('Computing');
    component.clearFilters();
    expect(component.hasActiveFilters).toBe(false);
    expect(component.resultCount).toBe(3);
  });
});

describe('previews', () => {
  it('offers a preview for PDFs and mini apps', () => {
    for (const app of component.apps) {
      expect(component.canPreview(app)).toBe(true);
    }
  });

  it('opens a sandboxed preview for a PDF', () => {
    const pdf = component.apps.find(app => app.meta.extension === 'pdf');
    component.openPreview(pdf);
    expect(component.preview.open).toBe(true);
    expect(component.preview.descriptor.src).toContain('#view=FitH');
    component.closePreview();
    expect(component.preview.open).toBe(false);
  });

  it('never grants same-origin to a mini app preview', () => {
    const app = component.apps.find(app => app.meta.isMiniApp);
    component.openPreview(app);
    expect(component.preview.descriptor.sandbox).not.toContain('allow-same-origin');
    component.closePreview();
  });
});

describe('degraded counter backend', () => {
  it('stays online-safe when every backend fails', () => {
    // fetch throws for all counter traffic in this test, so the client must
    // have fallen back to the local mirror rather than breaking the page.
    expect(component.stats.online).toBe(false);
    expect(component.stats.backend).toBe('local');
  });

  it('still renders counts as numbers', () => {
    for (const app of component.apps) {
      expect(Number.isFinite(component.downloadsOf(app))).toBe(true);
    }
    expect(typeof component.formatCount(component.totalDownloads)).toBe('string');
  });
});
