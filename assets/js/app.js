// ---------------------------------------------------------------------------
// School Cloud System (powered by Petgabs) — Alpine component.
//
// Phase 1: search + facets, structured metadata, previews, local vendor
// bundles, explicit loading/error/offline states, and counters backed by a
// managed database.
//
// Phase 2: teacher workflow — shared teacher sign-in, structured uploads
// with an automatic preview, a review queue, administrative approval and
// instant searchability.
// ---------------------------------------------------------------------------

import {
  DEFAULT_GITHUB_REPO,
  MAX_UPLOAD_BYTES,
  MAX_INLINE_UPLOAD_BYTES,
  SUPPORTED_FILE_PATTERN,
  COUNTER_CONFIG,
  VISITOR_COUNTER_KEY,
  VISIT_SESSION_KEY,
  ADMIN_USERNAME,
  ADMIN_HASH_SALT,
  ADMIN_PASSWORD_SHA256,
  ADMIN_SESSION_KEY,
  TEACHER_USERNAME,
  TEACHER_HASH_SALT,
  TEACHER_PASSWORD_SHA256,
  TEACHER_SESSION_KEY,
  TEACHER_OVERRIDE_KEY,
  REQUIRE_TEACHER_APPROVAL,
  APPS_STORAGE_KEY,
  SUBMISSIONS_STORAGE_KEY,
  UPLOAD_PREFS_KEY,
  GITHUB_CONFIG_KEY,
  GITHUB_TOKEN_SESSION_KEY,
  LIBRARY_CACHE_KEY
} from './config.js';

import {
  buildMetadata,
  indexOverrides,
  findOverride,
  titleFromFileName,
  kindOf,
  isMiniApp,
  extensionOf,
  visibilityLabel,
  isReviewDue
} from './lib/metadata.js';

import {
  queryLibrary,
  availableSubjects,
  availableYears,
  facetCounts
} from './lib/search.js';

import {
  createCounterClient,
  counterKeyFor,
  readMirror
} from './lib/counters.js';

import {
  formatCount,
  downloadLabel,
  formatDate,
  formatBytes,
  formatYears,
  iconForExtension,
  subjectAccent,
  describeFilters,
  visibilityAccent,
  submissionStatusAccent,
  submissionStatusLabel
} from './lib/format.js';

import { canPreview, previewDescriptor } from './lib/preview.js';

import {
  validateTeacherCredentials,
  teacherConfigSnippet
} from './lib/credentials.js';

import {
  emptyDraft,
  validateDraft,
  submissionFromDraft,
  libraryItemFromSubmission,
  libraryJsonEntry,
  overrideFromSubmission,
  submissionCounts,
  parseYearsInput,
  suggestSubject,
  suggestYears,
  titleHint,
  FORM_OPTIONS,
  academicYearOptions
} from './lib/submissions.js';

import {
  fileStoreSupported,
  putFile,
  getFile,
  deleteFile,
  readAsDataUrl
} from './lib/fileStore.js';

import {
  createGithubPublisher,
  publishSubmissionToGithub as runGithubPublish,
  deleteFileFromGithub as runGithubDelete,
  normaliseToken,
  isFineGrainedToken,
  blobToBase64
} from './lib/githubPublish.js';

// --- Admin hashing ----------------------------------------------------------

export async function sha256Hex(text) {
  if (!globalThis.crypto?.subtle) {
    throw new Error('This browser does not support secure hashing (requires HTTPS).');
  }
  const data = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

/** Constant-time-ish comparison to avoid trivial timing leaks. */
export function digestsMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const counters = createCounterClient(COUNTER_CONFIG);

function refreshIcons() {
  // Lucide replaces <i data-lucide> placeholders; re-run after DOM changes.
  try {
    globalThis.lucide?.createIcons?.();
  } catch (error) {
    console.warn('Icon rendering failed.', error);
  }
}

export function schoolCloud() {
  return {
    // --- View state ---------------------------------------------------------
    currentView: 'library',
    apps: [],
    overrides: new Map(),

    // --- Search & filters ---------------------------------------------------
    filters: { query: '', subject: '', year: '', kind: '', sort: 'relevance' },
    showFilters: false,

    // --- Loading / error / offline -----------------------------------------
    loading: { library: true, stats: false, preview: false },
    errors: { library: '', preview: '' },
    offline: false,
    usingCachedLibrary: false,

    // --- Preview ------------------------------------------------------------
    preview: { open: false, item: null, descriptor: null },

    // --- Roles ---------------------------------------------------------------
    // 'anonymous' | 'teacher' | 'admin'. Teachers share one staff account and
    // can upload resources; only the administrator can approve, delete or
    // change settings.
    role: 'anonymous',
    loginMode: 'teacher',
    showLogin: false,
    checkingLogin: false,
    loginError: '',
    loginForm: { username: '', password: '' },

    // --- Upload (teacher + admin) ---------------------------------------------
    uploading: false,
    syncing: false,
    fileName: '',
    fileContent: '',
    fileReady: false,
    fileReadId: 0,
    draftFile: null,          // { file, name, size, extension, objectUrl }
    draft: emptyDraft(),
    draftErrors: {},
    submitting: false,
    formOptions: FORM_OPTIONS,
    academicYears: academicYearOptions(),
    githubConfig: { repo: DEFAULT_GITHUB_REPO },

    // --- GitHub auto-publish (administrator) -----------------------------------
    // A fine-grained PAT (Contents: Read and write, this repository only) that
    // lets approval push the file to apps/ and merge library.json in one step.
    // Session-only: kept in sessionStorage, forgotten when the tab closes.
    githubAuth: {
      token: '',          // input field, mirrored to sessionStorage on connect
      connected: false,
      login: '',          // 'Connected as <login>' (cosmetic, may be empty)
      verifying: false,
      error: '',
      showToken: false
    },
    publishingSubmissionId: '',
    deletingAppId: '',

    // --- Submissions -----------------------------------------------------------
    submissions: [],

    // --- Teacher access (administrator) ---------------------------------------
    // A device-local override of the shared teacher login, set from Settings.
    // Stores only the username and salted SHA-256 digest — never a password.
    teacherOverride: null,
    teacherCredsOpen: false,
    teacherCreds: { username: '', password: '', confirm: '' },
    teacherCredsErrors: {},
    savingTeacherCreds: false,
    showTeacherPassword: false,

    // --- Stats --------------------------------------------------------------
    stats: {
      visitors: 0,
      downloads: {},
      online: true,
      backend: 'local',
      loadingVisitors: true,
      loadingDownloads: false,
      updatedAtLabel: 'never'
    },

    // --- Derived collections ------------------------------------------------

    get isAdmin() {
      return this.role === 'admin';
    },

    get isTeacher() {
      return this.role === 'teacher';
    },

    /** Signed-in staff: teachers and the administrator. */
    get isStaff() {
      return this.role === 'teacher' || this.role === 'admin';
    },

    get decoratedApps() {
      return this.apps;
    },

    get submissionCounts() {
      return submissionCounts(this.submissions);
    },

    get pendingSubmissions() {
      return this.submissions.filter(record => record.status === 'pending');
    },

    get reviewedSubmissions() {
      return this.submissions.filter(record => record.status !== 'pending');
    },

    /** The teacher login in force on this device (override or repository). */
    get effectiveTeacherUsername() {
      return this.teacherOverride?.username || TEACHER_USERNAME;
    },

    get effectiveTeacherDigest() {
      return this.teacherOverride?.digest || TEACHER_PASSWORD_SHA256;
    },

    get teacherOverrideActive() {
      return Boolean(this.teacherOverride);
    },

    /** True when approval can publish straight to GitHub from this session. */
    get autoPublishReady() {
      return this.githubAuth.connected && !this.offline;
    },

    get filteredApps() {
      return queryLibrary(this.apps, {
        ...this.filters,
        downloadsOf: item => this.downloadsOf(item)
      });
    },

    get filteredMiniApps() {
      return this.filteredApps.filter(app => app.meta?.isMiniApp);
    },

    get filteredResources() {
      return this.filteredApps.filter(app => !app.meta?.isMiniApp);
    },

    get subjectOptions() {
      return availableSubjects(this.apps);
    },

    get yearOptions() {
      return availableYears(this.apps);
    },

    get facets() {
      return facetCounts(this.apps);
    },

    get hasActiveFilters() {
      const { query, subject, year, kind } = this.filters;
      return Boolean(query.trim() || subject || year !== '' || kind);
    },

    get filterSummary() {
      return describeFilters(this.filters);
    },

    get resultCount() {
      return this.filteredApps.length;
    },

    get miniApps() {
      return this.apps.filter(app => app.meta?.isMiniApp);
    },

    get resources() {
      return this.apps.filter(app => !app.meta?.isMiniApp);
    },

    get rankedMiniApps() {
      return [...this.miniApps].sort((a, b) => this.downloadsOf(b) - this.downloadsOf(a));
    },

    get totalDownloads() {
      return this.apps.reduce((sum, app) => sum + this.downloadsOf(app), 0);
    },

    get localAppCount() {
      // Browser-only mini app drafts; approved teacher submissions are
      // counted separately in the review queue.
      return this.apps.filter(app => app.source !== 'github' && !app.submissionId).length;
    },

    get cloudAppCount() {
      return this.apps.filter(app => app.source === 'github').length;
    },

    // --- Lifecycle ----------------------------------------------------------

    async init() {
      this.offline = globalThis.navigator ? !globalThis.navigator.onLine : false;
      globalThis.addEventListener?.('online', () => {
        this.offline = false;
        this.syncFromGithub({ silent: true }).then(() => this.refreshStats());
      });
      globalThis.addEventListener?.('offline', () => { this.offline = true; });

      // Must run before the session check: a rotated teacher login replaces
      // the repository credentials on this device.
      this.loadTeacherOverride();

      try {
        if (sessionStorage.getItem(ADMIN_SESSION_KEY) === ADMIN_PASSWORD_SHA256) this.role = 'admin';
        else if (sessionStorage.getItem(TEACHER_SESSION_KEY) === this.effectiveTeacherDigest) this.role = 'teacher';
      } catch (error) {
        console.warn('Session storage unavailable; staff must sign in each visit.', error);
      }

      try {
        const savedApps = JSON.parse(localStorage.getItem(APPS_STORAGE_KEY) || '[]');
        if (Array.isArray(savedApps)) this.apps = savedApps.map(app => this.decorate(app));
      } catch (error) {
        console.warn('Ignoring invalid saved app data.', error);
        localStorage.removeItem(APPS_STORAGE_KEY);
      }

      this.loadSubmissions();
      this.loadUploadPrefs();

      try {
        const savedConfig = JSON.parse(localStorage.getItem(GITHUB_CONFIG_KEY) || '{}');
        const savedRepo = this.normalizeRepository(savedConfig.repo);
        if (savedRepo) this.githubConfig.repo = savedRepo;
      } catch (error) {
        console.warn('Ignoring invalid GitHub configuration.', error);
      }
      this.persistGithubConfig();
      this.loadGithubToken();

      // Restore filters from the URL so searches are shareable.
      this.readFiltersFromUrl();
      this.$watch('filters', () => this.writeFiltersToUrl(), { deep: true });

      this.$nextTick(() => refreshIcons());
      this.$watch('currentView', () => setTimeout(refreshIcons, 50));
      this.$watch('filteredApps', () => this.$nextTick(() => refreshIcons()));

      // Seed counters from the local mirror so numbers render instantly.
      this.stats.downloads = readMirror();
      this.stats.visitors = Number(this.stats.downloads[VISITOR_COUNTER_KEY]) || 0;

      await this.loadOverrides();
      this.countVisit();
      await this.syncFromGithub({ silent: true });
      this.refreshStats();
    },

    // --- Metadata -----------------------------------------------------------

    /**
     * Attach a `meta` block to a raw app record.
     *
     * @param {object} app              Raw app/resource record.
     * @param {object} [explicitOverride] Curated fields to use instead of
     *        looking the item up in library.json (used for submissions).
     */
    decorate(app, explicitOverride) {
      if (!app || typeof app !== 'object') return app;
      const overrides = explicitOverride || findOverride(this.overrides, app);
      return {
        ...app,
        // A curated title is the resource's real name; the file name is only
        // ever a fallback ("16G.pdf" says far less than a proper title).
        name: overrides.title || app.name || titleFromFileName(app.fileName),
        // A curated description always wins: the description generated during
        // sync ("PDF document shared through the public repository") is only a
        // placeholder, so `app.description || overrides.description` would
        // silently discard the curated text.
        description: overrides.description || app.description || '',
        meta: buildMetadata(app, overrides)
      };
    },

    /** Load the hand-curated metadata file, if present. */
    async loadOverrides() {
      try {
        const response = await fetch('./library.json', { cache: 'no-store' });
        if (!response.ok) return;
        this.overrides = indexOverrides(await response.json());
        // Re-decorate anything already loaded from cache.
        this.apps = this.apps.map(app => this.decorate(app));
      } catch (error) {
        console.warn('Curated metadata (library.json) was unavailable.', error);
      }
    },

    // --- Filters ------------------------------------------------------------

    clearFilters() {
      this.filters = { query: '', subject: '', year: '', kind: '', sort: 'relevance' };
    },

    setSubject(subject) {
      this.filters.subject = this.filters.subject === subject ? '' : subject;
    },

    setYear(year) {
      this.filters.year = String(this.filters.year) === String(year) ? '' : year;
    },

    setKind(kind) {
      this.filters.kind = this.filters.kind === kind ? '' : kind;
    },

    readFiltersFromUrl() {
      try {
        const params = new URLSearchParams(globalThis.location?.search || '');
        if (params.has('q')) this.filters.query = params.get('q') || '';
        if (params.has('subject')) this.filters.subject = params.get('subject') || '';
        if (params.has('year')) this.filters.year = params.get('year') || '';
        if (params.has('kind')) this.filters.kind = params.get('kind') || '';
        if (params.has('sort')) this.filters.sort = params.get('sort') || 'relevance';
        if (this.hasActiveFilters) this.showFilters = true;
      } catch (error) {
        console.warn('Could not read filters from the URL.', error);
      }
    },

    writeFiltersToUrl() {
      try {
        const params = new URLSearchParams();
        if (this.filters.query.trim()) params.set('q', this.filters.query.trim());
        if (this.filters.subject) params.set('subject', this.filters.subject);
        if (this.filters.year !== '') params.set('year', this.filters.year);
        if (this.filters.kind) params.set('kind', this.filters.kind);
        if (this.filters.sort && this.filters.sort !== 'relevance') params.set('sort', this.filters.sort);
        const query = params.toString();
        const url = query
          ? `${globalThis.location.pathname}?${query}`
          : globalThis.location.pathname;
        globalThis.history?.replaceState?.(null, '', url);
      } catch (error) {
        console.warn('Could not sync filters to the URL.', error);
      }
    },

    // --- Previews -----------------------------------------------------------

    canPreview(item) {
      if (!item) return false;
      // Approved submissions keep their bytes in the file store; they are
      // previewable whenever the file type supports it.
      const hydrated = item.submissionId && !item.downloadUrl && !item.content
        ? { ...item, downloadUrl: `blob:${item.submissionId}` }
        : item;
      return canPreview(hydrated);
    },

    async openPreview(item) {
      this.errors.preview = '';

      /** Open the modal straight into its error state. */
      const openWithError = (message) => {
        this.errors.preview = message;
        this.preview = { open: true, item, descriptor: null };
        this.loading.preview = false;
        this.$nextTick(() => {
          refreshIcons();
          document.getElementById('preview-close')?.focus();
        });
      };

      // Fetch the stored bytes for submission-backed items on demand.
      if (item.submissionId && !item.downloadUrl && !item.content) {
        const record = this.submissions.find(entry => entry.id === item.submissionId);
        const url = await this.submissionObjectUrl(record);
        if (!url) {
          openWithError('The stored file is no longer available on this device.');
          return;
        }
        item = { ...item, downloadUrl: url };
      }

      const descriptor = previewDescriptor(item);

      if (!descriptor) {
        openWithError('This file type cannot be previewed in the browser.');
        return;
      }
      if (descriptor.mode === 'office' && !/^https?:/i.test(item.downloadUrl || '')) {
        // Microsoft's viewer can only reach publicly hosted files; local
        // submissions must be downloaded to be checked.
        openWithError('Word, Excel and PowerPoint files are previewed online once published. Download the file to check its contents.');
        return;
      }
      if (descriptor.requiresPublicUrl && this.offline) {
        openWithError('Office previews need an internet connection. Download the file instead.');
        return;
      }

      this.preview = { open: true, item, descriptor };
      this.loading.preview = true;
      this.$nextTick(() => {
        refreshIcons();
        document.getElementById('preview-close')?.focus();
      });
    },

    onPreviewLoad() {
      this.loading.preview = false;
    },

    onPreviewError() {
      this.loading.preview = false;
      this.errors.preview = 'The preview could not be loaded. You can still download the file.';
    },

    closePreview() {
      this.preview = { open: false, item: null, descriptor: null };
      this.loading.preview = false;
      this.errors.preview = '';
      this.$nextTick(() => refreshIcons());
    },

    // --- Counters -----------------------------------------------------------

    async countVisit() {
      this.stats.loadingVisitors = true;
      let alreadyCounted = false;
      try {
        alreadyCounted = sessionStorage.getItem(VISIT_SESSION_KEY) === '1';
      } catch (error) {
        console.warn('Session storage unavailable; this visit may be counted twice.', error);
      }

      try {
        this.stats.visitors = alreadyCounted
          ? await counters.get(VISITOR_COUNTER_KEY)
          : await counters.hit(VISITOR_COUNTER_KEY);
        this.stats.online = counters.online;
        this.stats.backend = counters.lastBackend;
        if (!alreadyCounted) {
          try {
            sessionStorage.setItem(VISIT_SESSION_KEY, '1');
          } catch {
            /* Counting twice is preferable to failing here. */
          }
        }
      } catch (error) {
        console.warn('The visit counter is unavailable.', error);
        this.stats.online = false;
      } finally {
        this.stats.loadingVisitors = false;
        this.$nextTick(() => refreshIcons());
      }
    },

    downloadsOf(app) {
      return Number(this.stats.downloads[counterKeyFor(app)]) || 0;
    },

    sharePercent(app) {
      const total = this.totalDownloads;
      if (!total) return 0;
      return Math.round((this.downloadsOf(app) / total) * 100);
    },

    async refreshStats() {
      if (this.stats.loadingDownloads) return;
      this.stats.loadingDownloads = true;
      this.loading.stats = true;

      try {
        const keys = this.apps.map(app => counterKeyFor(app));
        const values = await counters.getMany([...keys, VISITOR_COUNTER_KEY]);

        const downloads = { ...this.stats.downloads, ...values };
        this.stats.downloads = downloads;
        if (Number.isFinite(Number(values[VISITOR_COUNTER_KEY]))) {
          this.stats.visitors = Number(values[VISITOR_COUNTER_KEY]);
        }

        this.stats.online = counters.online;
        this.stats.backend = counters.lastBackend;
        this.stats.updatedAtLabel = new Date().toLocaleTimeString();
      } catch (error) {
        console.warn('Could not refresh the counters.', error);
        this.stats.online = false;
      } finally {
        this.stats.loadingDownloads = false;
        this.loading.stats = false;
        this.$nextTick(() => refreshIcons());
      }
    },

    async recordDownload(app) {
      const key = counterKeyFor(app);
      // Optimistic update keeps the card responsive on slow networks.
      this.stats.downloads = { ...this.stats.downloads, [key]: this.downloadsOf(app) + 1 };
      try {
        const value = await counters.hit(key);
        this.stats.downloads = { ...this.stats.downloads, [key]: value };
        this.stats.online = counters.online;
        this.stats.backend = counters.lastBackend;
      } catch (error) {
        console.warn('The download counter is unavailable.', error);
        this.stats.online = false;
      } finally {
        this.$nextTick(() => refreshIcons());
      }
    },

    openDashboard() {
      if (!this.requireAdmin()) return;
      this.currentView = 'dashboard';
      this.refreshStats();
    },

    // --- Display helpers ----------------------------------------------------

    formatCount,
    formatDate,
    formatYears,
    formatBytes,
    subjectAccent,
    visibilityLabel,
    visibilityAccent,
    submissionStatusAccent,
    submissionStatusLabel,
    isReviewDue,

    downloadLabel(item) {
      return downloadLabel(this.downloadsOf(item));
    },

    fileExtension(item) {
      return (item?.meta?.extension || extensionOf(item?.fileName) || 'file').toUpperCase();
    },

    fileIcon(item) {
      return iconForExtension(item?.meta?.extension || extensionOf(item?.fileName));
    },

    kindLabel(item) {
      return item?.meta?.kind || kindOf(item?.fileName);
    },

    // --- GitHub sync --------------------------------------------------------

    normalizeRepository(value) {
      let repo = String(value || '').trim();
      repo = repo.replace(/^https:\/\/github\.com\//i, '').replace(/\/+$/, '');
      repo = repo.replace(/\.git$/i, '');
      return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]+$/.test(repo) ? repo : '';
    },

    persistGithubConfig() {
      try {
        localStorage.setItem(GITHUB_CONFIG_KEY, JSON.stringify({ repo: this.githubConfig.repo }));
      } catch (error) {
        console.warn('Could not persist the repository setting.', error);
      }
    },

    async saveSettings() {
      if (!this.requireAdmin()) return;
      const repo = this.normalizeRepository(this.githubConfig.repo);
      if (!repo) {
        alert('Enter a valid public repository in Owner/Repo format.');
        return;
      }
      this.githubConfig.repo = repo;
      this.persistGithubConfig();
      await this.syncFromGithub();
    },

    githubUploadUrl() {
      const repo = this.normalizeRepository(this.githubConfig.repo) || DEFAULT_GITHUB_REPO;
      const safeRepo = repo.split('/').map(encodeURIComponent).join('/');
      return `https://github.com/${safeRepo}/upload/main/apps`;
    },

    // --- GitHub auto-publish (administrator) ---------------------------------
    //
    // Settings → GitHub Auto-Publish stores a fine-grained PAT in
    // sessionStorage for this tab only. While connected, approving a pending
    // submission commits the file to apps/ and merges its curated metadata
    // into library.json automatically; the manual copy/paste flow stays
    // available as the fallback.

    githubTokenUrl() {
      // Deep link that pre-selects the fine-grained token form.
      return 'https://github.com/settings/personal-access-tokens/new';
    },

    loadGithubToken() {
      try {
        const token = normaliseToken(sessionStorage.getItem(GITHUB_TOKEN_SESSION_KEY) || '');
        if (token) {
          this.githubAuth.token = token;
          // Trust the stored token for this tab; it was verified when saved.
          this.githubAuth.connected = true;
        }
      } catch (error) {
        console.warn('Session storage unavailable; GitHub auto-publish needs reconnecting.', error);
      }
    },

    buildGithubPublisher() {
      return createGithubPublisher({
        repo: this.normalizeRepository(this.githubConfig.repo) || DEFAULT_GITHUB_REPO,
        token: this.githubAuth.token,
        branch: 'main'
      });
    },

    /** Verify the pasted token against the repository, then keep it for this tab. */
    async connectGithub() {
      if (!this.requireAdmin()) return;
      const token = normaliseToken(this.githubAuth.token);
      this.githubAuth.error = '';

      if (!token) {
        this.githubAuth.error = 'Paste a GitHub token first.';
        return;
      }
      if (!isFineGrainedToken(token) && !/^gh[a-z]_/.test(token)) {
        this.githubAuth.error = 'That does not look like a GitHub token. Fine-grained tokens start with “github_pat_”.';
        return;
      }

      this.githubAuth.verifying = true;
      try {
        this.githubAuth.token = token;
        const result = await this.buildGithubPublisher().verify();
        this.githubAuth.connected = true;
        this.githubAuth.login = result.login;
        try {
          sessionStorage.setItem(GITHUB_TOKEN_SESSION_KEY, token);
        } catch (error) {
          console.warn('Could not keep the GitHub token for this session.', error);
        }
      } catch (error) {
        this.githubAuth.connected = false;
        this.githubAuth.login = '';
        this.githubAuth.error = error.message;
      } finally {
        this.githubAuth.verifying = false;
        this.$nextTick(() => refreshIcons());
      }
    },

    /** Forget the token (sessionStorage + memory). */
    disconnectGithub() {
      this.githubAuth = { token: '', connected: false, login: '', verifying: false, error: '', showToken: false };
      try {
        sessionStorage.removeItem(GITHUB_TOKEN_SESSION_KEY);
      } catch (error) {
        console.warn('Could not clear the GitHub token.', error);
      }
      this.$nextTick(() => refreshIcons());
    },

    toggleGithubToken() {
      this.githubAuth.showToken = !this.githubAuth.showToken;
      this.$nextTick(() => refreshIcons());
    },

    /** Raw base64 of a submission's stored bytes, or '' when unavailable. */
    async submissionBase64(record) {
      if (!record) return '';
      if (record.storage === 'idb') {
        const blob = await getFile(record.id);
        return blob ? blobToBase64(blob) : '';
      }
      if (record.storage === 'inline' && record.inlineData) {
        const comma = record.inlineData.indexOf(',');
        return comma >= 0 ? record.inlineData.slice(comma + 1).replace(/\s+/g, '') : '';
      }
      return '';
    },

    /**
     * Push an approved submission to the public repository: the file goes to
     * apps/ and the curated metadata is merged into library.json. Returns
     * true on success. Safe to call from the approve flow or from the
     * "Publish to GitHub" button on an already-approved submission.
     */
    async publishSubmissionToGithub(id, options = {}) {
      if (!this.requireAdmin()) return false;
      const record = this.submissions.find(item => item.id === id);
      if (!record || record.status !== 'approved' || record.published) return false;
      if (!this.githubAuth.connected) {
        this.currentView = 'settings';
        alert('Connect a GitHub token in Settings → GitHub Auto-Publish first.');
        return false;
      }
      if (this.publishingSubmissionId) return false;

      this.publishingSubmissionId = record.id;
      try {
        const fileBase64 = await this.submissionBase64(record);
        if (!fileBase64) {
          alert('The stored file is no longer available on this device, so it cannot be uploaded. Ask the owner to submit it again, or use the manual GitHub upload.');
          return false;
        }

        const publisher = this.buildGithubPublisher();
        const input = {
          fileName: record.fileName,
          fileBase64,
          entry: overrideFromSubmission(record),
          title: record.title,
          overwrite: Boolean(options.overwrite)
        };

        let result;
        try {
          result = await runGithubPublish(publisher, input);
        } catch (error) {
          // A file already at apps/<name> needs an explicit decision.
          if (error.status === 409 && !input.overwrite &&
              confirm(`“apps/${record.fileName}” already exists in the repository.\n\nReplace it with this submission? The curated metadata will be updated too.`)) {
            result = await runGithubPublish(publisher, { ...input, overwrite: true });
          } else {
            throw error;
          }
        }

        // Mark published: the repository copy is canonical from now on, so
        // the local library copy is dropped and the next sync replaces it.
        record.published = true;
        record.publishedAt = new Date().toISOString();
        record.publishedPath = result.path;
        record.commitUrl = result.commitUrl;
        this.apps = this.apps.filter(app => app.submissionId !== record.id);
        this.saveSubmissions();
        this.saveApps();
        this.syncFromGithub({ silent: true }).then(() => this.loadOverrides());
        this.$nextTick(() => refreshIcons());
        return true;
      } catch (error) {
        console.warn('GitHub auto-publish failed.', error);
        alert(`Publishing to GitHub failed: ${error.message}\n\nNothing is lost — the resource stays approved on this device. You can retry, or publish manually with “Copy metadata” + “Upload to GitHub”.`);
        return false;
      } finally {
        this.publishingSubmissionId = '';
        this.$nextTick(() => refreshIcons());
      }
    },

    /**
     * Permanently delete a file that lives in the public repository: removes
     * it from `apps/` and drops its entry from `library.json`, in-app via
     * the connected GitHub token — no trip to github.com required. Returns
     * true on success.
     */
    async deleteAppFromGithub(app) {
      if (!this.requireAdmin()) return false;
      if (!app || app.source !== 'github') return false;
      if (!this.githubAuth.connected) {
        this.currentView = 'settings';
        alert('Connect a GitHub token in Settings → GitHub Auto-Publish first, so deletions can be made from this page.');
        return false;
      }
      if (this.deletingAppId) return false;

      const path = String(app.githubPath || `apps/${app.fileName || ''}`).replace(/^\/+/, '');
      this.deletingAppId = app.id;
      try {
        const publisher = this.buildGithubPublisher();
        const result = await runGithubDelete(publisher, { path });
        this.apps = this.apps.filter(item => item.id !== app.id);
        this.saveApps();
        this.syncFromGithub({ silent: true }).then(() => this.loadOverrides());
        this.$nextTick(() => refreshIcons());
        return true;
      } catch (error) {
        console.warn('GitHub delete failed.', error);
        alert(`Deleting from GitHub failed: ${error.message}\n\nNothing was changed. You can retry, or delete the file manually on github.com.`);
        return false;
      } finally {
        this.deletingAppId = '';
        this.$nextTick(() => refreshIcons());
      }
    },

    /**
     * One confirm-and-delete handler for every file card and dashboard row:
     * browser-only apps are removed locally; files already published to the
     * public repository are deleted there too (via the connected GitHub
     * token when available, falling back to the manual github.com page).
     */
    async confirmDeleteApp(app) {
      if (!this.requireAdmin() || !app) return;

      if (app.source !== 'github') {
        this.deleteApp(app.id);
        return;
      }

      if (this.githubAuth.connected) {
        if (!confirm(`Permanently delete “${app.fileName}” from the GitHub repository and remove it from library.json?\n\nThis cannot be undone from here.`)) return;
        const deleted = await this.deleteAppFromGithub(app);
        if (deleted) {
          alert(`Deleted. “${app.name}” was removed from the repository — it will disappear everywhere once GitHub Pages redeploys (usually 1–2 minutes).`);
        }
        return;
      }

      if (confirm('Connect GitHub Auto-Publish in Settings to delete cloud files directly from this page.\n\nOpen the manual delete page on github.com instead?')) {
        globalThis.open?.(this.githubDeleteUrl(app), '_blank', 'noopener,noreferrer');
      }
    },

    async loadAppFiles(repo) {
      const hostname = globalThis.location?.hostname?.toLowerCase() || '';
      const onGithubPages = hostname.endsWith('.github.io');

      // GitHub Pages generates this manifest during every deployment. It avoids
      // GitHub's anonymous API rate limit when a whole class refreshes at once.
      if (repo === DEFAULT_GITHUB_REPO && onGithubPages) {
        try {
          const manifestResponse = await fetch(`./apps.json?refresh=${Date.now()}`, { cache: 'no-store' });
          if (manifestResponse.ok) {
            const manifestFiles = await manifestResponse.json();
            if (Array.isArray(manifestFiles)) return manifestFiles;
          }
        } catch (error) {
          console.warn('The deployed app manifest was unavailable; using the GitHub API.', error);
        }
      }

      const [owner, repository] = repo.split('/');
      const endpoint = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/contents/apps`;
      const response = await fetch(endpoint, {
        cache: 'no-store',
        headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
      });

      if (response.status === 404) {
        throw new Error('The public repository or its apps folder was not found.');
      }
      if (response.status === 403) {
        throw new Error('GitHub rate limit reached. Please try again in a few minutes.');
      }
      if (!response.ok) {
        let message = `GitHub returned ${response.status}`;
        try {
          const errorData = await response.json();
          if (errorData.message) message = errorData.message;
        } catch {
          /* Keep the status-based message for non-JSON responses. */
        }
        throw new Error(message);
      }

      const files = await response.json();
      if (!Array.isArray(files)) throw new Error('GitHub did not return an app list.');
      return files;
    },

    async syncFromGithub(options = {}) {
      const silent = Boolean(options.silent);
      const repo = this.normalizeRepository(this.githubConfig.repo);

      if (!repo) {
        if (!silent) {
          alert('Enter a valid public repository in Owner/Repo format.');
          if (this.isAdmin) this.currentView = 'settings';
        }
        return;
      }

      if (this.syncing) return;
      this.syncing = true;
      this.loading.library = true;
      this.errors.library = '';

      try {
        const files = await this.loadAppFiles(repo);
        const githubApps = files
          .filter(file => file.type === 'file' && SUPPORTED_FILE_PATTERN.test(file.name))
          .sort((a, b) => b.name.localeCompare(a.name))
          .map(file => {
            const resource = !isMiniApp(file.name);
            return this.decorate({
              id: `github:${file.sha}`,
              name: titleFromFileName(file.name),
              teacherName: 'GitHub Library',
              description: resource
                ? `${kindOf(file.name)} shared through the public repository`
                : 'Shared through the public repository',
              fileName: file.name,
              githubPath: file.path,
              downloadUrl: file.download_url,
              size: file.size,
              createdAt: file.createdAt || new Date().toISOString(),
              source: 'github'
            });
          });

        // GitHub is the source of truth when a browser-only app shares a
        // filename with something published to the repository.
        const githubFileNames = new Set(githubApps.map(app => app.fileName.toLowerCase()));
        const localApps = this.apps.filter(app =>
          app.source !== 'github' &&
          !(!app.content && app.downloadUrl) &&
          !githubFileNames.has(String(app.fileName || '').toLowerCase())
        );

        this.apps = [...localApps, ...githubApps];
        this.usingCachedLibrary = false;
        this.saveApps();
        this.cacheLibrary();
        this.refreshStats();
        this.$nextTick(() => refreshIcons());

        if (!silent) {
          alert(`Sync complete! Found ${githubApps.length} public file${githubApps.length === 1 ? '' : 's'}.`);
          this.currentView = 'library';
        }
      } catch (error) {
        console.error('GitHub sync failed:', error);
        this.errors.library = error.message || 'The library could not be loaded.';
        // Anything already on screen came from the cache.
        this.usingCachedLibrary = this.apps.length > 0;
        if (!silent) alert('Unable to sync the public library: ' + error.message);
      } finally {
        this.syncing = false;
        this.loading.library = false;
        this.$nextTick(() => refreshIcons());
      }
    },

    retryLoad() {
      this.errors.library = '';
      this.syncFromGithub({ silent: true }).then(() => this.refreshStats());
    },

    cacheLibrary() {
      try {
        localStorage.setItem(LIBRARY_CACHE_KEY, JSON.stringify({
          savedAt: new Date().toISOString(),
          apps: this.apps.filter(app => app.source === 'github')
        }));
      } catch (error) {
        console.warn('Could not cache the library for offline use.', error);
      }
    },

    // --- Uploads (teacher + admin) -------------------------------------------
    //
    // Teachers choose a file, describe it with structured metadata, see an
    // automatic preview, then submit it for publication. Administrator
    // uploads skip the review queue.

    openUpload() {
      if (!this.requireStaff()) return;
      this.currentView = 'upload';
      this.$nextTick(() => refreshIcons());
    },

    clearDraftFile() {
      if (this.draftFile?.objectUrl) {
        try { URL.revokeObjectURL(this.draftFile.objectUrl); } catch { /* already revoked */ }
      }
      this.draftFile = null;
    },

    handleFileChange(event) {
      this.ingestFile(event.target.files ? event.target.files[0] : null);
      // Allow picking the same file again after an error message.
      event.target.value = '';
    },

    handleFileDrop(event) {
      const file = event.dataTransfer?.files?.[0];
      if (file) this.ingestFile(file);
    },

    ingestFile(file) {
      this.clearDraftFile();
      this.draftErrors = { ...this.draftErrors, file: '' };

      if (!file) return;

      if (!SUPPORTED_FILE_PATTERN.test(file.name)) {
        this.draftErrors = {
          ...this.draftErrors,
          file: 'Unsupported file type. Supported: HTML, PDF, Word, Excel and PowerPoint files.'
        };
        return;
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        this.draftErrors = {
          ...this.draftErrors,
          file: `That file is ${(file.size / (1024 * 1024)).toFixed(1)} MB. Uploads are limited to ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB — ask the administrator to publish larger files through GitHub.`
        };
        return;
      }

      this.draftFile = {
        file,
        name: file.name,
        size: file.size,
        extension: extensionOf(file.name),
        // Old embedded browsers may lack createObjectURL; the card preview
        // still works and the file remains uploadable.
        objectUrl: typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : ''
      };
      this.$nextTick(() => refreshIcons());
    },

    /** Live file preview inside the upload form (PDFs and HTML only). */
    get draftFilePreview() {
      if (!this.draftFile || !this.draftFile.objectUrl) return null;
      const extension = this.draftFile.extension;
      const label = `Automatic preview of ${this.draft.title || this.draftFile.name}`;
      if (extension === 'html' || extension === 'htm') {
        return {
          mode: 'iframe',
          src: this.draftFile.objectUrl,
          // Third-party HTML is never granted same-origin.
          sandbox: 'allow-scripts allow-forms allow-popups',
          label
        };
      }
      if (extension === 'pdf') {
        return { mode: 'iframe', src: `${this.draftFile.objectUrl}#view=FitH`, sandbox: 'allow-scripts allow-same-origin allow-popups', label };
      }
      return null;
    },

    /** Metadata block for the live card preview, exactly as it will appear. */
    get draftCardMeta() {
      return buildMetadata({
        fileName: this.draftFile?.name || '',
        name: this.draft.title,
        description: this.draft.description,
        teacherName: this.draft.owner,
        subject: this.draft.subject,
        years: parseYearsInput(this.draft.years),
        keywords: this.draft.keywords,
        topic: this.draft.topic,
        resourceType: this.draft.resourceType,
        language: this.draft.language,
        department: this.draft.department,
        academicYear: this.draft.academicYear,
        visibility: this.draft.visibility,
        version: this.draft.version,
        reviewDate: this.draft.reviewDate,
        licence: this.draft.licence,
        accessibility: this.draft.accessibility
      }, {});
    },

    suggestedSubject() {
      return suggestSubject(this.draft);
    },

    suggestedYearsLabel() {
      const years = suggestYears(this.draft);
      return years.length ? formatYears(years) : '';
    },

    applySuggestedSubject() {
      const subject = suggestSubject(this.draft);
      if (subject) this.draft.subject = subject;
    },

    applySuggestedYears() {
      const years = suggestYears(this.draft);
      if (years.length) this.draft.years = years.join(', ');
    },

    titlePlaceholder() {
      if (this.draftFile) {
        // Suggest building on the file name only when it carries real words;
        // a bare code like "16G" would make a useless suggestion.
        const hint = titleHint(this.draftFile.name);
        if (hint.length >= 4 && /[a-z]{3}/i.test(hint)) {
          return `e.g. “${hint} — solutions”`;
        }
      }
      return 'e.g. Continuous Probability Distributions — Exercise 16G Solutions';
    },

    loadUploadPrefs() {
      try {
        const prefs = JSON.parse(localStorage.getItem(UPLOAD_PREFS_KEY) || '{}');
        if (prefs.owner) this.draft.owner = String(prefs.owner);
        if (prefs.department) this.draft.department = String(prefs.department);
      } catch {
        /* Preferences are optional. */
      }
    },

    rememberUploadPrefs() {
      try {
        localStorage.setItem(UPLOAD_PREFS_KEY, JSON.stringify({
          owner: this.draft.owner,
          department: this.draft.department
        }));
      } catch {
        /* Preferences are optional. */
      }
    },

    resetDraft() {
      this.clearDraftFile();
      this.draft = emptyDraft();
      this.loadUploadPrefs();
      this.draftErrors = {};
      this.fileReadId += 1;
      try { this.$refs.uploadForm?.reset(); } catch { /* no form mounted */ }
    },

    /**
     * Submit the draft for publication. Teachers' submissions join the review
     * queue; the administrator's own uploads are published immediately.
     */
    async submitResource() {
      if (!this.requireStaff()) return;

      this.draftErrors = validateDraft(
        this.draft,
        this.draftFile ? { name: this.draftFile.name, size: this.draftFile.size } : null,
        { maxBytes: MAX_UPLOAD_BYTES }
      );
      if (Object.values(this.draftErrors).some(Boolean)) {
        alert('Please fix the highlighted fields before submitting.');
        return;
      }

      this.submitting = true;
      const id = globalThis.crypto?.randomUUID?.() ||
        `sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      try {
        // 1. Store the bytes (IndexedDB, with an inline base64 fallback).
        let storage = null;
        let inlineData = null;

        if (fileStoreSupported()) {
          try {
            await putFile(id, this.draftFile.file);
            storage = 'idb';
          } catch (error) {
            console.warn('The file store is unavailable; falling back to inline storage.', error);
          }
        }
        if (!storage) {
          if (this.draftFile.size > MAX_INLINE_UPLOAD_BYTES) {
            this.draftErrors = {
              ...this.draftErrors,
              file: 'This browser cannot store files larger than 2 MB in fallback mode. Try another browser, or ask the administrator to publish the file through GitHub.'
            };
            return;
          }
          inlineData = await readAsDataUrl(this.draftFile.file);
          if (!inlineData) {
            this.draftErrors = { ...this.draftErrors, file: 'The selected file could not be read.' };
            return;
          }
          storage = 'inline';
        }

        // 2. Build the submission record.
        const needsReview = REQUIRE_TEACHER_APPROVAL && !this.isAdmin;
        const record = submissionFromDraft(
          this.draft,
          { name: this.draftFile.name, size: this.draftFile.size, type: this.draftFile.file.type },
          { id, submittedBy: this.role, status: needsReview ? 'pending' : 'approved', storage, inlineData }
        );

        this.submissions.unshift(record);
        if (!this.saveSubmissions()) {
          // Roll back so the teacher is not told the upload succeeded.
          this.submissions = this.submissions.filter(item => item.id !== id);
          if (storage === 'idb') await deleteFile(id);
          alert('The submission could not be saved: browser storage is full. Remove old submissions from this device or use a smaller file.');
          return;
        }

        // 3. Publish immediately when no review is required.
        if (record.status === 'approved') {
          this.addApprovedToLibrary(record);
          this.saveApps();
        }

        this.rememberUploadPrefs();
        this.resetDraft();

        if (record.status === 'approved') {
          this.currentView = 'library';
          alert(`Published. “${record.title}” is now in the library and searchable immediately.`);
        } else {
          this.currentView = 'submissions';
          alert(`Submitted for review. “${record.title}” will appear in the public library once an administrator approves it. You can track its status on this page.`);
        }
      } finally {
        this.submitting = false;
        this.$nextTick(() => refreshIcons());
      }
    },

    saveApps() {
      try {
        localStorage.setItem(APPS_STORAGE_KEY, JSON.stringify(this.apps));
      } catch (error) {
        console.warn('Could not save the library to this browser.', error);
      }
    },

    // --- Submissions & review ------------------------------------------------

    loadSubmissions() {
      try {
        const saved = JSON.parse(localStorage.getItem(SUBMISSIONS_STORAGE_KEY) || '[]');
        if (Array.isArray(saved)) this.submissions = saved;
      } catch (error) {
        console.warn('Ignoring invalid submission data.', error);
        localStorage.removeItem(SUBMISSIONS_STORAGE_KEY);
      }
      // Approved submissions become searchable library items immediately.
      for (const record of this.submissions) {
        if (record.status === 'approved') this.addApprovedToLibrary(record);
      }
    },

    /** Returns false when the data could not be persisted. */
    saveSubmissions() {
      try {
        localStorage.setItem(SUBMISSIONS_STORAGE_KEY, JSON.stringify(this.submissions));
        return true;
      } catch (error) {
        console.warn('Could not save the submissions to this browser.', error);
        return false;
      }
    },

    openSubmissions() {
      if (!this.requireStaff()) return;
      this.currentView = 'submissions';
      this.$nextTick(() => refreshIcons());
    },

    /** Add an approved submission to the library (once, and never over GitHub). */
    addApprovedToLibrary(record) {
      if (record.published) return; // the public repository copy is canonical
      if (this.apps.some(app => app.submissionId === record.id)) return;
      this.apps.unshift(libraryItemFromSubmission(record));
    },

    async approveSubmission(id) {
      if (!this.requireAdmin()) return;
      const record = this.submissions.find(item => item.id === id);
      if (!record || record.status !== 'pending') return;

      record.status = 'approved';
      record.reviewedAt = new Date().toISOString();
      record.reviewedBy = 'administrator';
      this.addApprovedToLibrary(record);
      this.saveSubmissions();
      this.saveApps();
      this.$nextTick(() => refreshIcons());

      // With a GitHub token connected, approval publishes to the public
      // repository in the same step. Any failure falls back to the manual
      // copy/paste flow — the approval itself always stands.
      if (this.autoPublishReady) {
        const published = await this.publishSubmissionToGithub(id);
        if (published) {
          alert(`Approved and published. “${record.title}” was uploaded to the apps folder and its metadata merged into library.json — it will appear on every device once GitHub Pages redeploys (usually 1–2 minutes).`);
          return;
        }
        // publishSubmissionToGithub already explained the failure.
        return;
      }

      alert(`Approved. “${record.title}” is now in the library and searchable immediately.\n\nTo make it appear on every device, connect GitHub Auto-Publish in Settings — or upload the file to the apps folder on GitHub and paste the copied metadata into library.json (use “Copy metadata” next to the submission).`);
    },

    declineSubmission(id) {
      if (!this.requireAdmin()) return;
      const record = this.submissions.find(item => item.id === id);
      if (!record || record.status === 'rejected') return;

      const reason = prompt(`Reason for declining “${record.title}” (shown to the teacher):`, '');
      if (reason === null) return;

      record.status = 'rejected';
      record.reviewNote = reason.trim();
      record.reviewedAt = new Date().toISOString();
      record.reviewedBy = 'administrator';
      this.apps = this.apps.filter(app => app.submissionId !== record.id);
      this.saveSubmissions();
      this.saveApps();
      this.$nextTick(() => refreshIcons());
    },

    /** Permanently remove a submission and its stored file (admin only). */
    async deleteSubmission(id) {
      if (!this.requireAdmin()) return;
      const record = this.submissions.find(item => item.id === id);
      if (!record) return;

      // Already published to the repository: deleting only the local record
      // would leave an orphaned copy on GitHub, so fold in the cloud delete
      // (via the connected token) when one is available.
      if (record.published) {
        const path = record.publishedPath || `apps/${record.fileName}`;
        if (this.githubAuth.connected) {
          if (!confirm(`Permanently remove “${record.title}”? This also deletes “${path}” from the GitHub repository and its entry in library.json. This cannot be undone.`)) return;
          try {
            const publisher = this.buildGithubPublisher();
            await runGithubDelete(publisher, { path });
          } catch (error) {
            console.warn('GitHub delete failed.', error);
            alert(`Deleting “${path}” from GitHub failed: ${error.message}\n\nThe submission record was not removed either, so you can retry.`);
            return;
          }
        } else if (!confirm(`Permanently remove “${record.title}” from this device?\n\nIt was already published to “${path}” on GitHub — connect GitHub Auto-Publish in Settings to also delete it from the repository, or remove it manually on github.com.`)) {
          return;
        }
      } else if (!confirm(`Permanently remove “${record.title}”? The stored file will be deleted from this device.`)) {
        return;
      }

      this.submissions = this.submissions.filter(item => item.id !== id);
      this.apps = this.apps.filter(app => app.submissionId !== id && app.githubPath !== (record.publishedPath || `apps/${record.fileName}`));
      await deleteFile(id);
      this.saveSubmissions();
      this.saveApps();
      if (record.published && this.githubAuth.connected) {
        this.syncFromGithub({ silent: true }).then(() => this.loadOverrides());
      }
      this.$nextTick(() => refreshIcons());
    },

    /** Record that a submission has been published to the public repository. */
    markPublished(id) {
      if (!this.requireAdmin()) return;
      const record = this.submissions.find(item => item.id === id);
      if (!record || record.published) return;
      record.published = true;
      this.apps = this.apps.filter(app => app.submissionId !== id);
      this.saveSubmissions();
      this.saveApps();
      this.syncFromGithub({ silent: true });
    },

    /** Blob URL for a submission's stored bytes, or '' when unavailable. */
    async submissionObjectUrl(record) {
      if (!record) return '';
      if (typeof URL.createObjectURL !== 'function') return '';
      if (record.storage === 'idb') {
        const blob = await getFile(record.id);
        return blob ? URL.createObjectURL(blob) : '';
      }
      if (record.storage === 'inline' && record.inlineData) {
        try {
          const response = await fetch(record.inlineData);
          return URL.createObjectURL(await response.blob());
        } catch {
          return '';
        }
      }
      return '';
    },

    /** Preview a submission straight from the review queue. */
    async openSubmissionPreview(record) {
      const item = libraryItemFromSubmission(record);
      await this.openPreview(item);
    },

    /** Download a submission's file straight from the review queue. */
    async downloadSubmission(record) {
      await this.downloadApp(libraryItemFromSubmission(record));
    },

    viewInLibrary(record) {
      this.currentView = 'library';
      this.filters = { ...this.filters, query: record.title };
      this.$nextTick(() => refreshIcons());
    },

    /** Copy a ready-to-paste library.json entry for publishing a submission. */
    async copySubmissionMetadata(record) {
      const snippet = libraryJsonEntry(record);
      const copied = await this.copyToClipboard(snippet);
      if (copied) {
        alert('Metadata copied to the clipboard.\n\n1. Upload the file to the apps folder on GitHub.\n2. Paste this entry into library.json and commit.\nThe resource then appears with its full details on every device.');
      } else {
        alert('Automatic copy is blocked in this browser. Copy the metadata from the dialog that follows.');
        prompt('library.json entry:', snippet);
      }
    },

    async downloadApp(app) {
      let target = app;
      let temporaryUrl = '';

      // Approved submissions keep their bytes in the file store.
      if (app.submissionId && !app.content && !app.downloadUrl) {
        const record = this.submissions.find(item => item.id === app.submissionId);
        const url = await this.submissionObjectUrl(record);
        if (!url) {
          alert('The stored file is no longer available on this device. Ask the owner to upload it again.');
          return;
        }
        target = { ...app, downloadUrl: url };
        temporaryUrl = url;
      }

      let blob = null;

      if (typeof target.content === 'string' && target.content) {
        blob = new Blob([target.content], { type: 'text/html' });
      } else if (target.downloadUrl) {
        try {
          const response = await fetch(target.downloadUrl, { cache: 'no-store' });
          if (!response.ok) throw new Error(`Download returned ${response.status}`);
          // Keep binary resources byte-for-byte intact.
          blob = await response.blob();
        } catch (error) {
          alert('Failed to download the file: ' + error.message);
          if (temporaryUrl) URL.revokeObjectURL(temporaryUrl);
          return;
        }
      }

      if (!blob) {
        alert('No downloadable content is available for this file.');
        if (temporaryUrl) URL.revokeObjectURL(temporaryUrl);
        return;
      }

      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = app.fileName || 'download';
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);
      if (temporaryUrl) URL.revokeObjectURL(temporaryUrl);

      this.recordDownload(app);
    },

    deleteApp(id) {
      if (!this.requireAdmin()) return;
      const app = this.apps.find(item => item.id === id);
      if (!confirm('Remove this browser-only app?')) return;
      this.apps = this.apps.filter(item => item.id !== id);
      // Removing a published submission from the library sends it back to
      // the review queue with a note, so the decision is traceable.
      if (app?.submissionId) {
        const record = this.submissions.find(item => item.id === app.submissionId);
        if (record) {
          record.status = 'rejected';
          record.reviewNote = 'Removed from the library by the administrator.';
          record.reviewedAt = new Date().toISOString();
          record.reviewedBy = 'administrator';
          this.saveSubmissions();
        }
      }
      this.saveApps();
    },

    async clearData() {
      if (!this.requireAdmin()) return;
      if (!confirm('Clear cached apps, submissions and stored upload files from this device, and reset the repository setting?')) {
        return;
      }
      for (const record of this.submissions) await deleteFile(record.id);
      localStorage.removeItem(APPS_STORAGE_KEY);
      localStorage.removeItem(SUBMISSIONS_STORAGE_KEY);
      localStorage.removeItem(UPLOAD_PREFS_KEY);
      localStorage.removeItem(GITHUB_CONFIG_KEY);
      localStorage.removeItem(LIBRARY_CACHE_KEY);
      this.apps = [];
      this.submissions = [];
      this.githubConfig = { repo: DEFAULT_GITHUB_REPO };
      this.currentView = 'library';
      this.$nextTick(() => refreshIcons());
    },

    // --- Sign-in (teacher + admin) -------------------------------------------

    /**
     * Open the sign-in modal. 'teacher' and 'admin' are separate accounts:
     * teachers can upload and describe resources; only the administrator can
     * approve, delete or change settings.
     */
    openLogin(mode = 'teacher') {
      this.loginMode = mode === 'admin' ? 'admin' : 'teacher';
      this.loginError = '';
      this.loginForm = { username: '', password: '' };
      this.showLogin = true;
      this.$nextTick(() => {
        refreshIcons();
        document.getElementById('login-user')?.focus();
      });
    },

    adoptRole(role) {
      this.role = role;
      this.showLogin = false;
      this.loginForm = { username: '', password: '' };
      if (role === 'teacher' && ['dashboard', 'settings'].includes(this.currentView)) {
        this.currentView = 'library';
      }
      this.$nextTick(() => refreshIcons());
    },

    async login() {
      if (this.checkingLogin) return;
      this.checkingLogin = true;
      this.loginError = '';

      try {
        const username = this.loginForm.username.trim();
        const password = this.loginForm.password;

        if (this.loginMode === 'admin') {
          const digest = await sha256Hex(`${ADMIN_HASH_SALT}::${username}::${password}`);
          if (username !== ADMIN_USERNAME || !digestsMatch(digest, ADMIN_PASSWORD_SHA256)) {
            this.loginError = 'Incorrect administrator username or password.';
            return;
          }
          this.adoptRole('admin');
          try {
            sessionStorage.setItem(ADMIN_SESSION_KEY, ADMIN_PASSWORD_SHA256);
            sessionStorage.removeItem(TEACHER_SESSION_KEY);
          } catch (error) {
            console.warn('Could not persist the administrator session.', error);
          }
        } else {
          // The effective credentials come from the administrator's override
          // (Settings → Teacher Access) when one is set on this device,
          // otherwise from the repository defaults in config.js.
          const digest = await sha256Hex(`${TEACHER_HASH_SALT}::${username}::${password}`);
          if (username !== this.effectiveTeacherUsername || !digestsMatch(digest, this.effectiveTeacherDigest)) {
            this.loginError = 'Incorrect teacher username or password.';
            return;
          }
          this.adoptRole('teacher');
          try {
            sessionStorage.setItem(TEACHER_SESSION_KEY, this.effectiveTeacherDigest);
            sessionStorage.removeItem(ADMIN_SESSION_KEY);
          } catch (error) {
            console.warn('Could not persist the teacher session.', error);
          }
        }
      } catch (error) {
        this.loginError = error.message;
      } finally {
        this.checkingLogin = false;
      }
    },

    logout() {
      this.role = 'anonymous';
      this.currentView = 'library';
      try {
        sessionStorage.removeItem(ADMIN_SESSION_KEY);
        sessionStorage.removeItem(TEACHER_SESSION_KEY);
      } catch (error) {
        console.warn('Could not clear the sign-in session.', error);
      }
      // Signing out forgets the GitHub token too — it belongs to the
      // administrator's session, not to the browser.
      this.disconnectGithub();
      this.$nextTick(() => refreshIcons());
    },

    requireAdmin() {
      if (this.isAdmin) return true;
      this.openLogin('admin');
      return false;
    },

    requireStaff() {
      if (this.isStaff) return true;
      this.openLogin('teacher');
      return false;
    },

    // --- Teacher access (administrator) ---------------------------------------
    //
    // The shared teacher login can be rotated from Settings. The override
    // applies immediately on this device; publishing the generated config
    // lines to GitHub applies it to every device after the next deploy.

    loadTeacherOverride() {
      try {
        const saved = JSON.parse(localStorage.getItem(TEACHER_OVERRIDE_KEY) || 'null');
        this.teacherOverride = saved && typeof saved === 'object' && saved.username && saved.digest
          ? saved
          : null;
      } catch {
        this.teacherOverride = null;
      }
    },

    openTeacherCreds() {
      if (!this.requireAdmin()) return;
      this.teacherCredsOpen = true;
      this.teacherCredsErrors = {};
      // Prefill the current username so a password-only change is easy.
      this.teacherCreds = { username: this.effectiveTeacherUsername, password: '', confirm: '' };
      this.$nextTick(() => {
        refreshIcons();
        document.getElementById('teacher-new-user')?.focus();
      });
    },

    cancelTeacherCreds() {
      this.teacherCredsOpen = false;
      this.teacherCreds = { username: '', password: '', confirm: '' };
      this.teacherCredsErrors = {};
      this.showTeacherPassword = false;
      this.$nextTick(() => refreshIcons());
    },

    toggleTeacherPassword() {
      this.showTeacherPassword = !this.showTeacherPassword;
      this.$nextTick(() => refreshIcons());
    },

    async saveTeacherCredentials() {
      if (!this.requireAdmin()) return;

      this.teacherCredsErrors = validateTeacherCredentials(this.teacherCreds);
      if (Object.values(this.teacherCredsErrors).some(Boolean)) return;

      this.savingTeacherCreds = true;
      try {
        const username = this.teacherCreds.username.trim();
        // Same scheme as config.js: salted SHA-256, never plaintext.
        const digest = await sha256Hex(`${TEACHER_HASH_SALT}::${username}::${this.teacherCreds.password}`);

        const override = {
          username,
          digest,
          changedAt: new Date().toISOString(),
          changedBy: 'administrator'
        };
        localStorage.setItem(TEACHER_OVERRIDE_KEY, JSON.stringify(override));
        this.teacherOverride = override;
      } catch (error) {
        console.warn('Could not save the teacher credential override.', error);
        alert('The change could not be saved in this browser.');
        return;
      } finally {
        this.savingTeacherCreds = false;
      }

      // A teacher session on this device was signed in under the old
      // credentials — sign it out so the new login takes effect.
      try { sessionStorage.removeItem(TEACHER_SESSION_KEY); } catch { /* optional */ }

      this.cancelTeacherCreds();
      alert(`Teacher login updated on this device.\n\nUsername: ${this.effectiveTeacherUsername}\n\nThis applies to this browser only. To give every teacher the new login, copy the config lines below and paste them into assets/js/config.js on GitHub, then commit — the change applies site-wide once the site redeploys.`);
      this.$nextTick(() => refreshIcons());
    },

    resetTeacherCredentials() {
      if (!this.requireAdmin()) return;
      if (!this.teacherOverride) return;
      if (!confirm('Restore the repository teacher username and password on this device? Teachers will sign in with the credentials published in assets/js/config.js again.')) return;

      localStorage.removeItem(TEACHER_OVERRIDE_KEY);
      this.teacherOverride = null;
      this.cancelTeacherCreds();
      try { sessionStorage.removeItem(TEACHER_SESSION_KEY); } catch { /* optional */ }
      this.$nextTick(() => refreshIcons());
    },

    /** The exact lines to paste into assets/js/config.js. */
    teacherConfigText() {
      return teacherConfigSnippet(this.effectiveTeacherUsername, this.effectiveTeacherDigest);
    },

    async copyTeacherConfig() {
      if (!this.requireAdmin()) return;
      const copied = await this.copyToClipboard(this.teacherConfigText());
      if (copied) {
        alert('Config lines copied to the clipboard.\n\n1. Open assets/js/config.js on GitHub (link beside this button).\n2. Replace the TEACHER_USERNAME and TEACHER_PASSWORD_SHA256 lines with the copied ones.\n3. Commit — once the site redeploys, the new teacher login works on every device.');
      } else {
        alert('Automatic copy is blocked in this browser. Copy the lines from the dialog that follows.');
        prompt('assets/js/config.js — teacher credentials:', this.teacherConfigText());
      }
    },

    githubEditConfigUrl() {
      const repo = this.normalizeRepository(this.githubConfig.repo) || DEFAULT_GITHUB_REPO;
      const safeRepo = repo.split('/').map(encodeURIComponent).join('/');
      return `https://github.com/${safeRepo}/edit/main/assets/js/config.js`;
    },

    /** Clipboard with a fallback for browsers without the async API. */
    async copyToClipboard(text) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        try {
          const helper = document.createElement('textarea');
          helper.value = text;
          helper.setAttribute('readonly', '');
          helper.style.position = 'fixed';
          helper.style.opacity = '0';
          document.body.appendChild(helper);
          helper.select();
          const copied = document.execCommand('copy');
          document.body.removeChild(helper);
          return copied;
        } catch {
          return false;
        }
      }
    },

    // Deletion happens on github.com itself, so GitHub performs the
    // authentication and authorisation. No token lives in this site.
    githubDeleteUrl(app) {
      const repo = this.normalizeRepository(this.githubConfig.repo) || DEFAULT_GITHUB_REPO;
      const safeRepo = repo.split('/').map(encodeURIComponent).join('/');
      const path = String(app?.githubPath || `apps/${app?.fileName || ''}`)
        .replace(/^\/+/, '')
        .split('/')
        .map(encodeURIComponent)
        .join('/');
      return `https://github.com/${safeRepo}/delete/main/${path}`;
    },

    clearLocalDrafts() {
      if (!this.requireAdmin()) return;
      const count = this.localAppCount;
      if (!count) {
        alert('There are no browser-only apps to remove.');
        return;
      }
      if (!confirm(`Remove ${count} browser-only app${count === 1 ? '' : 's'} from this device?`)) return;
      this.apps = this.apps.filter(app => app.source === 'github' || app.submissionId);
      this.saveApps();
      this.$nextTick(() => refreshIcons());
    },

    clearGithubCache() {
      if (!this.requireAdmin()) return;
      if (!confirm('Clear the cached cloud entries from this browser? The public repository is not changed.')) return;
      this.apps = this.apps.filter(app => app.source !== 'github');
      this.saveApps();
      localStorage.removeItem(LIBRARY_CACHE_KEY);
      this.$nextTick(() => refreshIcons());
    }
  };
}

// Alpine resolves `x-data="schoolCloud()"` against the global scope.
globalThis.schoolCloud = schoolCloud;
