// ---------------------------------------------------------------------------
// End-to-end smoke test.
//
// Boots the real index.html in jsdom with the real Alpine bundle and a stubbed
// network, then drives the component the way a visitor would: load the
// library, search it, filter it, and open a preview. This is what catches
// wiring mistakes that the pure unit tests cannot see.
// ---------------------------------------------------------------------------

// @vitest-environment jsdom

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
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

// ---------------------------------------------------------------------------
// Teacher upload workflow: shared staff sign-in, structured upload with an
// automatic preview, administrative approval, and instant searchability.
// ---------------------------------------------------------------------------

describe('teacher upload workflow', () => {
  const librarySizeBefore = () => component.apps.length;

  beforeAll(() => {
    // jsdom does not implement blob object URLs; the browser always does.
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: () => 'blob:mock-url'
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: () => {}
    });
  });

  beforeEach(() => {
    vi.spyOn(globalThis, 'alert').mockImplementation(() => {});
    vi.spyOn(globalThis, 'confirm').mockImplementation(() => true);
    vi.spyOn(globalThis, 'prompt').mockImplementation(() => 'Out of date — please use the 2027 edition.');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects the wrong teacher credentials', async () => {
    component.openLogin('teacher');
    component.loginForm = { username: 'hoc-teacher', password: 'wrong-password' };
    await component.login();
    expect(component.role).toBe('anonymous');
    expect(component.loginError).toBeTruthy();
    component.showLogin = false;
  });

  it('signs a teacher in with the shared staff account', async () => {
    component.openLogin('teacher');
    component.loginForm = { username: 'hoc-teacher', password: 'hsc-bzfls' };
    await component.login();
    expect(component.role).toBe('teacher');
    expect(component.isStaff).toBe(true);
    expect(component.isAdmin).toBe(false); // teachers are not administrators
    expect(component.showLogin).toBe(false);
  });

  it('a teacher submission waits for review and is not yet searchable', async () => {
    const before = librarySizeBefore();
    component.openUpload();
    expect(component.currentView).toBe('upload');

    // Choose a file (the drag-and-drop entry point shares this code).
    component.ingestFile(new File(['%PDF-1.4 fake'], '16G.pdf', { type: 'application/pdf' }));
    expect(component.draftFile.name).toBe('16G.pdf');
    expect(component.draftFile.objectUrl).toBe('blob:mock-url');
    // The automatic preview appears straight away for PDFs.
    expect(component.draftFilePreview.mode).toBe('iframe');

    component.draft = {
      ...component.draft,
      title: 'Continuous Probability Distributions — Exercise 16G Solutions',
      description: 'Worked solutions for Exercise 16G.',
      subject: 'Mathematics',
      years: '12',
      owner: 'Mr A. Rahman',
      keywords: 'probability, revision',
      visibility: 'school'
    };
    await component.submitResource();

    expect(component.submissions).toHaveLength(1);
    const record = component.submissions[0];
    expect(record.status).toBe('pending');
    expect(record.submittedBy).toBe('teacher');
    expect(record.years).toEqual([12]);
    expect(component.apps).toHaveLength(before); // nothing published yet
    expect(component.currentView).toBe('submissions');

    // Not searchable while it waits for review.
    component.clearFilters();
    component.filters.query = 'continuous probability';
    expect(component.resultCount).toBe(0);
    component.clearFilters();
  });

  it('teachers cannot delete: destructive actions demand the administrator', () => {
    const before = librarySizeBefore();
    // Attempting a browser-side deletion as a teacher opens the admin login
    // instead of removing anything.
    component.deleteApp(component.apps[0].id);
    expect(component.showLogin).toBe(true);
    expect(component.loginMode).toBe('admin');
    expect(component.apps).toHaveLength(before);
    component.showLogin = false;

    // The same applies to removing a submission from the review queue.
    component.deleteSubmission(component.submissions[0].id);
    expect(component.showLogin).toBe(true);
    expect(component.submissions).toHaveLength(1);
    component.showLogin = false;
  });

  it('an administrator approves the submission and it becomes searchable immediately', () => {
    // The administrator's session is already active for this check.
    component.role = 'admin';
    const before = librarySizeBefore();
    const record = component.submissions[0];

    component.openSubmissions();
    component.approveSubmission(record.id);

    expect(record.status).toBe('approved');
    expect(component.apps).toHaveLength(before + 1);
    expect(component.pendingSubmissions).toHaveLength(0);

    // Searchable immediately — by title, topic and keyword.
    component.clearFilters();
    component.filters.query = 'continuous probability';
    const matches = component.filteredApps.filter(app => app.submissionId === record.id);
    expect(matches).toHaveLength(1);
    expect(matches[0].name).toBe(record.title); // the title, never the file name
    expect(matches[0].fileName).toBe('16G.pdf');
    expect(matches[0].meta.subject).toBe('Mathematics');
    expect(matches[0].meta.years).toEqual([12]);
    expect(matches[0].meta.visibility).toBe('school');
    expect(matches[0].meta.tags).toContain('probability');

    // The file name alone also finds it, and the card keeps both.
    component.clearFilters();
    component.filters.query = '16g';
    expect(component.filteredApps.filter(app => app.submissionId === record.id)).toHaveLength(1);
    component.clearFilters();
  });

  it('declining a submission records the reason and keeps it out of the library', async () => {
    const record = component.submissions[0];
    component.declineSubmission(record.id);
    expect(record.status).toBe('rejected');
    expect(record.reviewNote).toContain('2027');
    expect(component.apps.some(app => app.submissionId === record.id)).toBe(false);
  });

  it('the administrator can publish the approved resource and record it', () => {
    const record = component.submissions[0];
    record.status = 'approved'; // re-approve for this check
    component.addApprovedToLibrary(record);
    expect(component.apps.some(app => app.submissionId === record.id)).toBe(true);

    // "Done — published": the GitHub copy becomes canonical, so the local
    // browser copy steps aside.
    component.markPublished(record.id);
    expect(record.published).toBe(true);
    expect(component.apps.some(app => app.submissionId === record.id)).toBe(false);
  });

  it('the administrator can remove a rejected submission and its stored file', async () => {
    expect(component.submissions).toHaveLength(1);
    await component.deleteSubmission(component.submissions[0].id);
    expect(component.submissions).toHaveLength(0);
    expect(component.role).toBe('admin'); // still signed in as admin
  });

  it('signing out returns to the anonymous library view', () => {
    component.logout();
    expect(component.role).toBe('anonymous');
    expect(component.isStaff).toBe(false);
    expect(component.currentView).toBe('library');
  });
});

// ---------------------------------------------------------------------------
// Teacher login rotation: the administrator changes the shared staff username
// and password in Settings → Teacher Access.
// ---------------------------------------------------------------------------

describe('teacher credential rotation (administrator)', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'alert').mockImplementation(() => {});
    vi.spyOn(globalThis, 'confirm').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts from the repository default', () => {
    component.role = 'anonymous';
    component.teacherOverride = null;
    expect(component.teacherOverrideActive).toBe(false);
    expect(component.effectiveTeacherUsername).toBe('hoc-teacher');
  });

  it('rejects a weak or mismatched change without saving anything', async () => {
    component.role = 'admin';
    component.openTeacherCreds();
    component.teacherCreds = { username: 'ab', password: 'short', confirm: 'nope' };
    await component.saveTeacherCredentials();

    expect(component.teacherCredsErrors.username).toBeTruthy();
    expect(component.teacherCredsErrors.password).toBeTruthy();
    expect(component.teacherCredsErrors.confirm).toBeTruthy();
    expect(component.teacherOverrideActive).toBe(false);
    expect(localStorage.getItem('schoolcloud_teacher_override')).toBeNull();
    component.cancelTeacherCreds();
  });

  it('changes the teacher login on this device and blocks the old one', async () => {
    component.role = 'admin';
    component.openTeacherCreds();
    // The form opens prefilled with the current username.
    expect(component.teacherCreds.username).toBe('hoc-teacher');

    component.teacherCreds = { username: 'staff-2027', password: 'Sunshine-Cloud-9', confirm: 'Sunshine-Cloud-9' };
    await component.saveTeacherCredentials();

    expect(component.teacherOverrideActive).toBe(true);
    expect(component.effectiveTeacherUsername).toBe('staff-2027');
    expect(component.teacherConfigText()).toContain("'staff-2027'");

    // The old shared credentials no longer work on this device.
    component.openLogin('teacher');
    component.loginForm = { username: 'hoc-teacher', password: 'hsc-bzfls' };
    await component.login();
    expect(component.loginError).toBeTruthy();
    expect(component.role).toBe('admin'); // unchanged
    component.showLogin = false;

    // The new credentials sign in as a teacher.
    component.openLogin('teacher');
    component.loginForm = { username: 'staff-2027', password: 'Sunshine-Cloud-9' };
    await component.login();
    expect(component.loginError).toBe('');
    expect(component.role).toBe('teacher');
    component.logout();
  });

  it('restores the repository default when reset', async () => {
    component.role = 'admin';
    component.resetTeacherCredentials();

    expect(component.teacherOverrideActive).toBe(false);
    expect(component.effectiveTeacherUsername).toBe('hoc-teacher');
    expect(localStorage.getItem('schoolcloud_teacher_override')).toBeNull();

    // The original shared credentials work again.
    component.openLogin('teacher');
    component.loginForm = { username: 'hoc-teacher', password: 'hsc-bzfls' };
    await component.login();
    expect(component.role).toBe('teacher');
    expect(component.loginError).toBe('');
    component.logout();
    component.role = 'anonymous';
  });

  it('keeps a teacher session valid across a reload while an override is set', async () => {
    // Rotate, sign in as a teacher, then simulate a reload: init() must
    // restore the session using the override digest, not the repository one.
    component.role = 'admin';
    component.openTeacherCreds();
    component.teacherCreds = { username: 'staff-2027', password: 'Sunshine-Cloud-9', confirm: 'Sunshine-Cloud-9' };
    await component.saveTeacherCredentials();

    component.openLogin('teacher');
    component.loginForm = { username: 'staff-2027', password: 'Sunshine-Cloud-9' };
    await component.login();
    expect(component.role).toBe('teacher');

    component.loadTeacherOverride();
    component.role = 'anonymous';
    // The same check init() performs when the page loads.
    expect(sessionStorage.getItem('schoolcloud_teacher_session')).toBe(component.effectiveTeacherDigest);

    // Only the administrator can reset the credentials: as a teacher the
    // call must be refused (and demand the admin login) without any change.
    component.resetTeacherCredentials();
    expect(component.teacherOverrideActive).toBe(true);
    expect(component.showLogin).toBe(true);
    component.showLogin = false;

    component.role = 'admin';
    component.resetTeacherCredentials();
    component.logout();
    expect(component.teacherOverrideActive).toBe(false);
    expect(component.effectiveTeacherUsername).toBe('hoc-teacher');
  });
});

// ---------------------------------------------------------------------------
// Administrator cloud file deletion and dashboard management
// ---------------------------------------------------------------------------

describe('administrator cloud file deletion and dashboard features', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'alert').mockImplementation(() => {});
    vi.spyOn(globalThis, 'confirm').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('allows files up to 50 MB and rejects files exceeding 50 MB', () => {
    component.role = 'teacher';
    component.openUpload();

    // 55 MB file is rejected
    const oversizedFile = new File(['x'.repeat(100)], 'large.pdf', { type: 'application/pdf' });
    Object.defineProperty(oversizedFile, 'size', { value: 55 * 1024 * 1024 });
    component.ingestFile(oversizedFile);
    expect(component.draftErrors.file).toMatch(/50 MB/);

    // 40 MB file is accepted
    const validLargeFile = new File(['x'.repeat(100)], 'valid-large.pdf', { type: 'application/pdf' });
    Object.defineProperty(validLargeFile, 'size', { value: 40 * 1024 * 1024 });
    component.ingestFile(validLargeFile);
    expect(component.draftErrors.file).toBeFalsy();
    expect(component.draftFile.name).toBe('valid-large.pdf');
    component.clearDraftFile();
  });

  it('filters dashboard resources by type and cloud source', () => {
    component.role = 'admin';
    component.currentView = 'dashboard';

    expect(component.dashboardResourceCounts.all).toBeGreaterThan(0);
    expect(component.dashboardResourceCounts.pdf).toBeGreaterThan(0);

    component.setDashboardResourceType('pdf');
    expect(component.dashboardResourceType).toBe('pdf');
    for (const item of component.filteredDashboardResources) {
      expect(item.meta.extension).toBe('pdf');
    }

    component.setDashboardResourceType('cloud');
    for (const item of component.filteredDashboardResources) {
      expect(item.source).toBe('github');
    }

    component.setDashboardResourceType('all');
    component.dashboardResourceQuery = 'schedule';
    expect(component.filteredDashboardResources.length).toBe(1);
    component.dashboardResourceQuery = '';
  });

  it('allows an administrator to delete a cloud PDF file using GitHub API', async () => {
    component.role = 'admin';
    component.githubAuth.connected = true;
    component.githubAuth.token = 'github_pat_test123';

    const pdfApp = component.apps.find(app => app.source === 'github' && app.meta.extension === 'pdf');
    expect(pdfApp).toBeTruthy();
    const initialCount = component.apps.length;

    // Stub fetch for GitHub delete and library update
    const fetchStub = vi.fn(async (url, options = {}) => {
      const href = String(url);
      if (options.method === 'DELETE') {
        return { ok: true, status: 200, json: async () => ({ commit: { sha: 'del-sha', html_url: 'https://github.com/Petgabs/BZFLS/commit/del-sha' } }) };
      }
      if (href.includes('contents/library.json')) {
        return { ok: true, status: 200, json: async () => ({ sha: 'lib-sha', content: 'e30=', encoding: 'base64' }) };
      }
      if (href.includes('contents/apps/')) {
        return { ok: true, status: 200, json: async () => ({ sha: 'file-sha', content: 'e30=', encoding: 'base64' }) };
      }
      if (href.includes('library.json')) {
        return { ok: true, status: 200, json: async () => ({}) };
      }
      if (href.includes('apps.json')) {
        return { ok: true, status: 200, json: async () => MANIFEST.filter(f => f.name !== pdfApp.fileName) };
      }
      throw new Error('network disabled in tests');
    });
    vi.stubGlobal('fetch', fetchStub);

    const deleted = await component.deleteAppFromGithub(pdfApp);
    expect(deleted).toBe(true);
    expect(component.apps.some(app => app.id === pdfApp.id)).toBe(false);
    expect(component.apps.length).toBe(initialCount - 1);
  });
});

// ---------------------------------------------------------------------------
// The shared publishing token: saved into the repository by the
// administrator, unlocked by the teacher login on every other device.
// ---------------------------------------------------------------------------

describe('shared cloud publishing token', () => {
  const CLOUD_PATH = 'assets/data/cloud-token.json';
  const PASTED_TOKEN = 'github_pat_11CLOUD000examplevalue_ZZ9';
  const TEACHER_PASSWORD = 'hoc-teacher-2026';

  /** Stands in for the file in the repository. */
  let repoVaultText;
  let lastCommitMessage;
  let deleteCalls;

  function githubFetchStub() {
    return vi.fn(async (url, options = {}) => {
      const href = String(url);
      const method = options.method || 'GET';
      const isVaultPath = href.includes(CLOUD_PATH);

      // The deployed copy on GitHub Pages.
      if (isVaultPath && href.includes('refresh=')) {
        if (!repoVaultText) return { ok: false, status: 404, text: async () => 'Not Found' };
        return { ok: true, status: 200, text: async () => repoVaultText };
      }

      if (isVaultPath && method === 'PUT') {
        const body = JSON.parse(options.body);
        lastCommitMessage = body.message;
        repoVaultText = Buffer.from(body.content, 'base64').toString('utf8');
        return {
          ok: true,
          status: 200,
          json: async () => ({ commit: { sha: 'vault-commit', html_url: 'https://github.test/c' }, content: { sha: 'vault-sha' } })
        };
      }

      if (isVaultPath && method === 'DELETE') {
        deleteCalls += 1;
        lastCommitMessage = JSON.parse(options.body).message;
        repoVaultText = null;
        return { ok: true, status: 200, json: async () => ({ commit: { sha: 'del-commit', html_url: 'https://github.test/d' } }) };
      }

      if (isVaultPath) {
        if (!repoVaultText) {
          return { ok: false, status: 404, text: async () => 'Not Found', json: async () => ({ message: 'Not Found' }) };
        }
        const envelope = {
          sha: 'vault-sha',
          encoding: 'base64',
          content: Buffer.from(repoVaultText, 'utf8').toString('base64')
        };
        return { ok: true, status: 200, text: async () => JSON.stringify(envelope), json: async () => envelope };
      }

      if (href.endsWith('/repos/Petgabs/BZFLS')) {
        return { ok: true, status: 200, json: async () => ({ full_name: 'Petgabs/BZFLS', permissions: { push: true } }) };
      }
      if (href.endsWith('/user')) {
        return { ok: true, status: 200, json: async () => ({ login: 'petgabs' }) };
      }
      if (href.includes('apps.json')) {
        return { ok: true, status: 200, json: async () => MANIFEST };
      }
      if (href.includes('library.json')) {
        return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
      }
      throw new Error('network disabled in tests');
    });
  }

  beforeEach(async () => {
    repoVaultText = null;
    lastCommitMessage = '';
    deleteCalls = 0;
    vi.spyOn(globalThis, 'alert').mockImplementation(() => {});
    vi.spyOn(globalThis, 'confirm').mockImplementation(() => true);
    vi.stubGlobal('fetch', githubFetchStub());

    // Known teacher password on this device, so the vault has a key.
    component.role = 'admin';
    component.teacherCreds = { username: 'hoc-teacher', password: TEACHER_PASSWORD, confirm: TEACHER_PASSWORD };
    await component.saveTeacherCredentials();

    component.disconnectGithub();
    component.cloudToken.checked = false;
    component.cloudToken.exists = false;
    component.cloudToken.payload = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    component.disconnectGithub();
    component.teacherOverride = null;
    window.localStorage.removeItem('schoolcloud_teacher_override');
  });

  async function saveTokenAsAdmin(token = PASTED_TOKEN) {
    component.role = 'admin';
    component.githubAuth.token = token;
    component.cloudToken.password = TEACHER_PASSWORD;
    return component.saveCloudToken();
  }

  it('refuses to save without a token or with the wrong teacher password', async () => {
    component.role = 'admin';
    component.githubAuth.token = '';
    component.cloudToken.password = TEACHER_PASSWORD;
    expect(await component.saveCloudToken()).toBe(false);
    expect(component.cloudToken.error).toMatch(/paste the fine-grained/i);

    component.githubAuth.token = PASTED_TOKEN;
    component.cloudToken.password = '';
    expect(await component.saveCloudToken()).toBe(false);
    expect(component.cloudToken.error).toMatch(/teacher password/i);

    component.cloudToken.password = 'not-the-teacher-password';
    expect(await component.saveCloudToken()).toBe(false);
    expect(component.cloudToken.error).toMatch(/not the current teacher password/i);
    expect(repoVaultText).toBeNull();

    component.githubAuth.token = 'definitely not a token';
    component.cloudToken.password = TEACHER_PASSWORD;
    expect(await component.saveCloudToken()).toBe(false);
    expect(repoVaultText).toBeNull();
  });

  it('commits the token to the repository without ever writing it in the clear', async () => {
    expect(await saveTokenAsAdmin()).toBe(true);

    expect(repoVaultText).toBeTruthy();
    expect(repoVaultText).not.toContain(PASTED_TOKEN);
    expect(repoVaultText).not.toContain('github_pat_');
    expect(lastCommitMessage).toMatch(/shared publishing token/i);

    const published = JSON.parse(repoVaultText);
    expect(published.cipher).toBe('AES-GCM-256');
    expect(published.kdf).toBe('PBKDF2-SHA256');
    expect(published.iterations).toBeGreaterThanOrEqual(310000);

    // The administrator's own tab is now publishing with it.
    expect(component.cloudToken.exists).toBe(true);
    expect(component.cloudToken.unlocked).toBe(true);
    expect(component.usingCloudToken).toBe(true);
    expect(component.autoPublishReady).toBe(true);
    expect(component.cloudTokenStatusLabel).toMatch(/unlocked/i);
  });

  it('hands the token to any device where a teacher signs in', async () => {
    await saveTokenAsAdmin();

    // A different device: no session, no memory of the token.
    component.logout();
    component.cloudToken.checked = false;
    expect(component.githubAuth.connected).toBe(false);

    component.loginMode = 'teacher';
    component.loginForm = { username: 'hoc-teacher', password: TEACHER_PASSWORD };
    await component.login();

    // Unlocking runs in the background so a slow network cannot block the
    // sign-in itself; give the key derivation time to finish.
    for (let attempt = 0; attempt < 60 && !component.githubAuth.connected; attempt += 1) {
      await new Promise(done => setTimeout(done, 50));
    }

    expect(component.role).toBe('teacher');
    expect(component.githubAuth.token).toBe(PASTED_TOKEN);
    expect(component.usingCloudToken).toBe(true);
    expect(window.sessionStorage.getItem('schoolcloud_github_token')).toBe(PASTED_TOKEN);
  });

  it('stays locked for the wrong password', async () => {
    await saveTokenAsAdmin();
    component.disconnectGithub();
    component.cloudToken.unlockPassword = 'guessing';

    component.role = 'admin';
    await component.unlockCloudTokenFromForm();

    expect(component.githubAuth.connected).toBe(false);
    expect(component.cloudToken.unlocked).toBe(false);
    expect(component.cloudToken.error).toMatch(/does not unlock/i);
  });

  it('replaces the saved token with a new one', async () => {
    await saveTokenAsAdmin();
    const first = repoVaultText;

    component.startCloudTokenReplace();
    expect(component.cloudToken.replacing).toBe(true);
    expect(component.githubAuth.token).toBe('');

    const replacement = 'github_pat_11SECOND00examplevalue_YY8';
    expect(await saveTokenAsAdmin(replacement)).toBe(true);

    expect(repoVaultText).not.toBe(first);
    expect(repoVaultText).not.toContain(replacement);
    expect(component.cloudToken.replacing).toBe(false);
    expect(component.githubAuth.token).toBe(replacement);

    // The old token no longer opens anything; the new one is what teachers get.
    component.disconnectGithub();
    component.cloudToken.unlockPassword = TEACHER_PASSWORD;
    component.role = 'admin';
    await component.unlockCloudTokenFromForm();
    expect(component.githubAuth.token).toBe(replacement);
  });

  it('deletes the saved token from the repository and disconnects', async () => {
    await saveTokenAsAdmin();

    expect(await component.deleteCloudToken()).toBe(true);
    expect(deleteCalls).toBe(1);
    expect(repoVaultText).toBeNull();
    expect(lastCommitMessage).toMatch(/delete the shared publishing token/i);

    expect(component.cloudToken.exists).toBe(false);
    expect(component.cloudToken.unlocked).toBe(false);
    expect(component.githubAuth.connected).toBe(false);
    expect(component.githubAuth.token).toBe('');
    expect(window.sessionStorage.getItem('schoolcloud_github_token')).toBeNull();

    // And nothing is left for another device to find.
    component.cloudToken.checked = false;
    expect(await component.loadCloudToken({ silent: true })).toBe(false);
  });

  it('will not delete without a working token to commit the deletion', async () => {
    await saveTokenAsAdmin();
    component.disconnectGithub();

    expect(await component.deleteCloudToken()).toBe(false);
    expect(deleteCalls).toBe(0);
    expect(repoVaultText).toBeTruthy();
    expect(component.cloudToken.error).toMatch(/unlock the saved token/i);
  });

  it('re-locks the saved token when the teacher password is rotated', async () => {
    await saveTokenAsAdmin();
    const before = repoVaultText;

    const rotated = 'staffroom-rotated-2027';
    component.role = 'admin';
    component.teacherCreds = { username: 'hoc-teacher', password: rotated, confirm: rotated };
    await component.saveTeacherCredentials();

    expect(repoVaultText).not.toBe(before);
    expect(repoVaultText).not.toContain(PASTED_TOKEN);
    expect(lastCommitMessage).toMatch(/re-lock/i);

    // The new password opens it; the old one no longer does.
    component.disconnectGithub();
    component.cloudToken.unlockPassword = TEACHER_PASSWORD;
    component.role = 'admin';
    await component.unlockCloudTokenFromForm();
    expect(component.githubAuth.connected).toBe(false);

    component.cloudToken.unlockPassword = rotated;
    await component.unlockCloudTokenFromForm();
    expect(component.githubAuth.token).toBe(PASTED_TOKEN);
  });

  it('finds a token saved by someone else on a cold start', async () => {
    await saveTokenAsAdmin();
    const published = repoVaultText;

    // Pretend this browser has never seen it.
    component.disconnectGithub();
    component.cloudToken = {
      ...component.cloudToken,
      checked: false, exists: false, payload: null, fingerprint: '', savedAt: '', savedBy: ''
    };
    repoVaultText = published;

    expect(await component.loadCloudToken({ silent: true })).toBe(true);
    expect(component.cloudToken.exists).toBe(true);
    expect(component.cloudToken.unlocked).toBe(false);
    expect(component.cloudToken.fingerprint).toHaveLength(12);
    expect(component.cloudTokenStatusLabel).toMatch(/locked/i);
  });
});
