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
  PUBLISH_TEACHER_UPLOADS_IMMEDIATELY,
  APPS_STORAGE_KEY,
  SUBMISSIONS_STORAGE_KEY,
  UPLOAD_PREFS_KEY,
  GITHUB_CONFIG_KEY,
  GITHUB_TOKEN_SESSION_KEY,
  GITHUB_TOKEN_SOURCE_SESSION_KEY,
  CLOUD_TOKEN_PATH,
  CLOUD_QUEUE_PATH,
  CLOUD_TOKEN_FINGERPRINT_SESSION_KEY,
  LIBRARY_CACHE_KEY,
  FIRST_SEEN_KEY
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
  freshnessBadge,
  sortByFreshness,
  countLatest,
  addedAtOf,
  freshnessStatus
} from './lib/freshness.js';

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
  suggestSubjectOption,
  suggestYearLevel,
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
  blobToBase64,
  textToBase64,
  base64ToText,
  commitJsonWithRetry
} from './lib/githubPublish.js';

import {
  buildResourceRecord,
  summariseByTeacher,
  summariseByYearLevel,
  summariseBySubject,
  summariseStorage,
  bucketResourcesByAge,
  findCleanupCandidates,
  AGE_BUCKETS,
  AGE_BUCKET_LABELS,
  YEAR_LEVELS
} from './lib/resourceStats.js';

import {
  pendingPathFor,
  queueEntryFromSubmission,
  submissionFromQueueEntry,
  mergeSubmissionLists,
  mergeQueueEntry,
  patchQueueEntry,
  removeQueueEntry,
  parseQueue,
  pendingCount
} from './lib/reviewQueue.js';

import {
  encryptCloudToken,
  decryptCloudToken,
  tokenFingerprint,
  serialiseVault,
  parseVault,
  vaultSummary
} from './lib/tokenVault.js';

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

    // --- Freshness ("Latest" badges) ---------------------------------------
    // `now` is refreshed on a timer so a card stops saying "Latest" once it is
    // more than a day old, without a page reload.
    now: Date.now(),
    firstSeen: {},

    // --- Search & filters ---------------------------------------------------
    filters: { query: '', subject: '', year: '', kind: '', sort: 'newest' },
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
      showToken: false,
      // 'manual' when pasted into this tab, 'vault' when unlocked from the
      // shared token saved in the repository.
      source: ''
    },
    publishingSubmissionId: '',
    deletingAppId: '',

    // --- Shared cloud publishing token ----------------------------------------
    // The administrator can save the fine-grained token into the repository
    // itself (assets/data/cloud-token.json), encrypted with the shared
    // teacher password. Every device then unlocks the same token at sign-in
    // instead of each administrator pasting their own. See lib/tokenVault.js.
    cloudTokenPath: CLOUD_TOKEN_PATH,
    cloudToken: {
      checked: false,     // have we looked for the file yet?
      loading: false,
      exists: false,
      sha: '',            // blob SHA, needed to replace or delete the file
      payload: null,      // the encrypted vault, as published
      fingerprint: '',
      savedAt: '',
      savedBy: '',
      unlocked: false,    // this session holds the decrypted token
      saving: false,
      deleting: false,
      unlocking: false,
      replacing: false,   // the administrator is swapping in a new token
      previousToken: '',  // live token parked while a replacement is typed
      error: '',
      notice: '',
      password: '',       // teacher password used to lock the vault (admin)
      showPassword: false,
      unlockPassword: '',
      showUnlockPassword: false
    },

    // --- Submissions -----------------------------------------------------------
    submissions: [],

    // --- Cross-device review queue ---------------------------------------------
    // Uploads are staged in the repository (submissions/) so an administrator
    // on any device can review them. Nothing here is in the library: the
    // public list is built from apps/ alone. See lib/reviewQueue.js.
    cloudQueue: {
      loading: false,
      loadedAt: '',
      error: '',
      available: false,   // a queue file was found in the repository
      count: 0,           // entries waiting for review, as of the last load
      uploading: false    // a teacher's upload is being staged right now
    },

    // --- Admin Dashboard filter state -----------------------------------------
    dashboardResourceType: 'all',
    dashboardResourceQuery: '',

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

    // --- Resource statistics (admin) -----------------------------------------
    // Thresholds for the "needs cleanup" list: a resource is flagged once it
    // has sat in the cloud for at least this many days with at most this many
    // downloads. Adjustable from the Statistics section.
    statsCleanupMinAgeDays: 30,
    statsCleanupMaxDownloads: 0,
    ageBucketLabels: AGE_BUCKET_LABELS,
    ageBuckets: AGE_BUCKETS,
    yearLevels: YEAR_LEVELS,
    statsAgeBucketOpen: 'week',

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
      return this.orderByFreshness(this.filteredApps.filter(app => app.meta?.isMiniApp));
    },

    get filteredResources() {
      return this.orderByFreshness(this.filteredApps.filter(app => !app.meta?.isMiniApp));
    },

    /**
     * Newest first, oldest last — unless the visitor has explicitly chosen a
     * different ordering (name, downloads, relevance with a live query).
     */
    orderByFreshness(items) {
      const sort = this.filters.sort;
      if (sort === 'name' || sort === 'downloads') return items;
      if (sort === 'relevance' && this.filters.query.trim()) return items;
      return sortByFreshness(items, new Date(this.now));
    },

    /** Badge data (Latest / Yesterday / date added) for a resource card. */
    freshness(item) {
      return freshnessBadge(item, new Date(this.now));
    },

    /** True when a resource was added within the last 24 hours. */
    isLatest(item) {
      return freshnessStatus(addedAtOf(item), new Date(this.now)) === 'latest';
    },

    /** How many library items are brand new (added today). */
    get latestCount() {
      return countLatest(this.apps, new Date(this.now));
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

    get dashboardResourceCounts() {
      const counts = { all: 0, pdf: 0, word: 0, excel: 0, ppt: 0, cloud: 0 };
      for (const r of this.resources) {
        counts.all += 1;
        const ext = (r.meta?.extension || extensionOf(r.fileName) || '').toLowerCase();
        if (ext === 'pdf') counts.pdf += 1;
        else if (ext === 'doc' || ext === 'docx') counts.word += 1;
        else if (ext === 'xls' || ext === 'xlsx') counts.excel += 1;
        else if (ext === 'ppt' || ext === 'pptx') counts.ppt += 1;
        if (r.source === 'github') counts.cloud += 1;
      }
      return counts;
    },

    get filteredDashboardResources() {
      return sortByFreshness(this.dashboardResourceMatches, new Date(this.now));
    },

    get dashboardResourceMatches() {
      const type = (this.dashboardResourceType || 'all').toLowerCase();
      const query = (this.dashboardResourceQuery || '').trim().toLowerCase();

      return this.resources.filter(resource => {
        const ext = (resource.meta?.extension || extensionOf(resource.fileName) || '').toLowerCase();

        if (type === 'pdf' && ext !== 'pdf') return false;
        if (type === 'word' && ext !== 'doc' && ext !== 'docx') return false;
        if (type === 'excel' && ext !== 'xls' && ext !== 'xlsx') return false;
        if (type === 'ppt' && ext !== 'ppt' && ext !== 'pptx') return false;
        if (type === 'cloud' && resource.source !== 'github') return false;

        if (query) {
          const name = String(resource.name || '').toLowerCase();
          const fileName = String(resource.fileName || '').toLowerCase();
          const subject = String(resource.meta?.subject || '').toLowerCase();
          if (!name.includes(query) && !fileName.includes(query) && !subject.includes(query)) {
            return false;
          }
        }

        return true;
      });
      // Newest first on the admin dashboard too.
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

    // --- Resource statistics (admin) -----------------------------------------
    //
    // Built from every file currently published in the GitHub cloud, each
    // enriched with the matching teacher-upload record from the cross-device
    // review queue (submissions/queue.json) when one exists — that record is
    // the only reliable source of who uploaded a file, its true size and when
    // it reached the cloud. See assets/js/lib/resourceStats.js.

    /** The submission (any status) that produced a given published resource. */
    findSubmissionForResource(resource) {
      const path = String(resource?.githubPath || `apps/${resource?.fileName || ''}`).trim().toLowerCase();
      const fileName = String(resource?.fileName || '').trim().toLowerCase();
      if (!fileName) return null;

      const matches = (this.submissions || []).filter(sub => {
        const subPath = String(sub?.publishedPath || '').trim().toLowerCase();
        const subFile = String(sub?.fileName || '').trim().toLowerCase();
        if (subPath && path && subPath === path) return true;
        return Boolean(subFile) && subFile === fileName;
      });
      if (!matches.length) return null;

      const publishedMatch = matches.find(sub =>
        sub.published && String(sub.publishedPath || '').trim().toLowerCase() === path
      );
      if (publishedMatch) return publishedMatch;

      return [...matches].sort((a, b) => new Date(b.submittedAt || 0) - new Date(a.submittedAt || 0))[0];
    },

    /** One unified statistics record per file currently published to GitHub. */
    get cloudResourceRecords() {
      return this.apps
        .filter(app => app.source === 'github')
        .map(resource => buildResourceRecord(resource, {
          submission: this.findSubmissionForResource(resource),
          downloads: this.downloadsOf(resource)
        }));
    },

    /** Per-teacher: uploads, storage, year/subject spread, last upload. */
    get teacherStatistics() {
      return summariseByTeacher(this.cloudResourceRecords);
    },

    /** Resource counts for Year 9 / 10 / 11 / 12. */
    get yearLevelStatistics() {
      return summariseByYearLevel(this.cloudResourceRecords);
    },

    /** Resource counts (and storage) per subject, most popular first. */
    get subjectStatistics() {
      return summariseBySubject(this.cloudResourceRecords);
    },

    /** Total bytes occupied in the GitHub cloud, and how much is known. */
    get cloudStorageStatistics() {
      return summariseStorage(this.cloudResourceRecords);
    },

    /** Resources grouped by how long ago they were published. */
    get resourcesByAgeBucket() {
      return bucketResourcesByAge(this.cloudResourceRecords);
    },

    /** Resources old enough and little/never downloaded — candidates to remove. */
    get cleanupCandidates() {
      return findCleanupCandidates(this.cloudResourceRecords, {
        minAgeDays: Number(this.statsCleanupMinAgeDays) || 0,
        maxDownloads: Number(this.statsCleanupMaxDownloads) || 0
      });
    },

    setStatsAgeBucket(bucket) {
      this.statsAgeBucketOpen = this.statsAgeBucketOpen === bucket ? '' : bucket;
      this.$nextTick(() => refreshIcons());
    },

    /** Delete a resource straight from the Statistics section's lists. */
    deleteCloudResourceById(id) {
      const app = this.apps.find(item => item.id === id);
      if (app) this.confirmDeleteApp(app);
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

      // Find the shared publishing token (if the administrator saved one) and
      // unlock it for a teacher session that is already signed in on this
      // device — the password is not available then, so the token kept in
      // sessionStorage by loadGithubToken() is what carries the session over.
      this.loadCloudToken({ silent: true });

      this.loadFirstSeen();
      // Keep the Latest / Yesterday badges honest while the page stays open.
      setInterval(() => { this.now = Date.now(); }, 60 * 1000);

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

    // --- First-seen ledger ---------------------------------------------------
    //
    // GitHub's contents API does not tell us when a file was added, so the
    // browser keeps its own ledger: the first sync records a baseline (the
    // files that already existed have an unknown date), and anything that
    // appears afterwards is stamped with the moment it showed up. A curated
    // `addedAt` in library.json always wins over the ledger.

    loadFirstSeen() {
      try {
        const saved = JSON.parse(localStorage.getItem(FIRST_SEEN_KEY) || '{}');
        this.firstSeen = saved && typeof saved === 'object' ? saved : {};
      } catch (error) {
        console.warn('Ignoring an invalid first-seen ledger.', error);
        this.firstSeen = {};
      }
    },

    saveFirstSeen() {
      try {
        localStorage.setItem(FIRST_SEEN_KEY, JSON.stringify(this.firstSeen));
      } catch (error) {
        console.warn('Could not save the first-seen ledger.', error);
      }
    },

    firstSeenKeyFor(app) {
      return String(app?.githubPath || app?.fileName || app?.id || '').trim().toLowerCase();
    },

    /**
     * Record when each file was first seen. On the very first run every file
     * is marked as pre-existing (no date) so the whole library does not light
     * up as "Latest".
     */
    recordFirstSeen(apps) {
      const ledger = this.firstSeen && typeof this.firstSeen === 'object' ? { ...this.firstSeen } : {};
      const baselineDone = Boolean(ledger.__baseline);
      const stamp = new Date().toISOString();
      let changed = false;

      for (const app of apps || []) {
        const key = this.firstSeenKeyFor(app);
        if (!key || key === '__baseline') continue;
        if (Object.prototype.hasOwnProperty.call(ledger, key)) continue;
        ledger[key] = baselineDone ? stamp : null;
        changed = true;
      }

      if (!baselineDone) {
        ledger.__baseline = stamp;
        changed = true;
      }

      if (changed) {
        this.firstSeen = ledger;
        this.saveFirstSeen();
      }
      return this.firstSeen;
    },

    /** The ledger's date for an app, if any. */
    firstSeenAt(app) {
      const key = this.firstSeenKeyFor(app);
      return key ? this.firstSeen?.[key] || '' : '';
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
      const meta = buildMetadata(app, overrides);
      // Curated date wins; otherwise fall back to this browser's ledger of
      // when the file first appeared in the cloud library.
      const addedAt = meta.addedAt || app.addedAt || this.firstSeenAt(app) || '';
      return {
        ...app,
        addedAt,
        // A curated title is the resource's real name; the file name is only
        // ever a fallback ("16G.pdf" says far less than a proper title).
        name: overrides.title || app.name || titleFromFileName(app.fileName),
        // A curated description always wins: the description generated during
        // sync ("PDF document shared through the public repository") is only a
        // placeholder, so `app.description || overrides.description` would
        // silently discard the curated text.
        description: overrides.description || app.description || '',
        meta: { ...meta, addedAt: addedAt || '' }
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
      this.filters = { query: '', subject: '', year: '', kind: '', sort: 'newest' };
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

    setDashboardResourceType(type) {
      this.dashboardResourceType = type;
      this.$nextTick(() => refreshIcons());
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
        if (this.filters.sort && this.filters.sort !== 'newest') params.set('sort', this.filters.sort);
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
      // Resource Statistics needs every teacher's uploads, not just this
      // device's, so pull in the shared cloud queue too.
      this.loadCloudQueue({ silent: true });
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

    /** Same label, but from an already-known count (resource statistics records). */
    formatDownloadCount(count) {
      return downloadLabel(count);
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
          this.githubAuth.source = sessionStorage.getItem(GITHUB_TOKEN_SOURCE_SESSION_KEY) || 'manual';
          if (this.githubAuth.source === 'vault') {
            this.cloudToken.unlocked = true;
            this.cloudToken.fingerprint =
              sessionStorage.getItem(CLOUD_TOKEN_FINGERPRINT_SESSION_KEY) || this.cloudToken.fingerprint;
          }
        }
      } catch (error) {
        console.warn('Session storage unavailable; GitHub auto-publish needs reconnecting.', error);
      }
    },

    /** Remember the live token for this tab (never localStorage). */
    rememberGithubToken(token, source) {
      try {
        sessionStorage.setItem(GITHUB_TOKEN_SESSION_KEY, token);
        sessionStorage.setItem(GITHUB_TOKEN_SOURCE_SESSION_KEY, source);
      } catch (error) {
        console.warn('Could not keep the GitHub token for this session.', error);
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
        this.githubAuth.source = 'manual';
        this.rememberGithubToken(token, 'manual');
        this.loadCloudQueue({ silent: true });
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
      this.githubAuth = { token: '', connected: false, login: '', verifying: false, error: '', showToken: false, source: '' };
      this.cloudToken.unlocked = false;
      this.cloudToken.replacing = false;
      this.cloudToken.previousToken = '';
      this.cloudToken.password = '';
      this.cloudToken.unlockPassword = '';
      try {
        sessionStorage.removeItem(GITHUB_TOKEN_SESSION_KEY);
        sessionStorage.removeItem(GITHUB_TOKEN_SOURCE_SESSION_KEY);
        sessionStorage.removeItem(CLOUD_TOKEN_FINGERPRINT_SESSION_KEY);
      } catch (error) {
        console.warn('Could not clear the GitHub token.', error);
      }
      this.$nextTick(() => refreshIcons());
    },

    toggleGithubToken() {
      this.githubAuth.showToken = !this.githubAuth.showToken;
      this.$nextTick(() => refreshIcons());
    },

    // --- Shared cloud publishing token ----------------------------------------
    //
    // "Save to GitHub Cloud" writes the administrator's fine-grained token
    // into the repository as assets/data/cloud-token.json — encrypted with
    // the shared teacher password, never in the clear. Signing in with the
    // teacher login then unlocks it on any device, so staff publish through
    // the site instead of each administrator pasting a token into each tab.
    //
    // Saving, replacing and deleting all go through the Contents API, so the
    // repository, the GitHub Pages site and every other browser converge on
    // the same answer as soon as the deploy lands (usually 1–2 minutes).

    /** Public URL of the vault file in the repository. */
    cloudTokenFileUrl() {
      const repo = this.normalizeRepository(this.githubConfig.repo) || DEFAULT_GITHUB_REPO;
      const safeRepo = repo.split('/').map(encodeURIComponent).join('/');
      return `https://github.com/${safeRepo}/blob/main/${CLOUD_TOKEN_PATH}`;
    },

    /** Where to revoke a token that is being deleted or replaced. */
    githubTokenSettingsUrl() {
      return 'https://github.com/settings/personal-access-tokens';
    },

    get cloudTokenStatusLabel() {
      if (!this.cloudToken.checked && this.cloudToken.loading) return 'Checking…';
      if (!this.cloudToken.exists) return 'No token saved in the repository';
      return this.cloudToken.unlocked ? 'Saved in the repository · unlocked here' : 'Saved in the repository · locked';
    },

    /** True when this session is publishing with the shared cloud token. */
    get usingCloudToken() {
      return this.githubAuth.connected && this.githubAuth.source === 'vault';
    },

    /**
     * Read the published vault. The deployed site is tried first (no API
     * rate limit, works for every visitor); the Contents API is the fallback
     * so a freshly saved token is visible before GitHub Pages redeploys.
     */
    async loadCloudToken(options = {}) {
      if (this.cloudToken.loading) return this.cloudToken.exists;
      this.cloudToken.loading = true;
      if (!options.silent) this.cloudToken.error = '';

      try {
        let payload = null;

        try {
          const response = await fetch(`./${CLOUD_TOKEN_PATH}?refresh=${Date.now()}`, { cache: 'no-store' });
          if (response.ok) payload = parseVault(await response.text());
        } catch (error) {
          console.warn('The deployed cloud token file was unavailable.', error);
        }

        if (!payload) payload = await this.fetchCloudTokenFromApi();

        const summary = vaultSummary(payload);
        this.cloudToken.payload = summary.exists ? payload : null;
        this.cloudToken.exists = summary.exists;
        this.cloudToken.fingerprint = summary.fingerprint || this.cloudToken.fingerprint;
        this.cloudToken.savedAt = summary.savedAt;
        this.cloudToken.savedBy = summary.savedBy;
        if (!summary.exists) {
          this.cloudToken.sha = '';
          this.cloudToken.unlocked = false;
        }
        return summary.exists;
      } finally {
        this.cloudToken.checked = true;
        this.cloudToken.loading = false;
        this.$nextTick(() => refreshIcons());
      }
    },

    /** Unauthenticated Contents API read; returns the vault or null. */
    async fetchCloudTokenFromApi() {
      const repo = this.normalizeRepository(this.githubConfig.repo) || DEFAULT_GITHUB_REPO;
      const [owner, repository] = repo.split('/');
      const path = CLOUD_TOKEN_PATH.split('/').map(encodeURIComponent).join('/');
      const endpoint = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/contents/${path}?ref=main`;

      try {
        const response = await fetch(endpoint, {
          cache: 'no-store',
          headers: { Accept: 'application/vnd.github.raw+json', 'X-GitHub-Api-Version': '2022-11-28' }
        });
        if (!response.ok) return null;

        // `Accept: raw` normally returns the file itself, but a proxy (or a
        // cache) may hand back the regular JSON envelope instead — accept
        // either rather than reporting "no token saved" by mistake.
        const body = await response.text();
        const direct = parseVault(body);
        if (direct) return direct;

        try {
          const envelope = JSON.parse(body);
          if (envelope?.encoding === 'base64' && envelope.content) {
            return parseVault(base64ToText(envelope.content));
          }
        } catch {
          /* Not the JSON envelope either. */
        }
        return null;
      } catch (error) {
        console.warn('Could not read the shared token from the GitHub API.', error);
        return null;
      }
    },

    /**
     * Save (or replace) the shared token in the repository.
     *
     * The token in the input field is verified against the repository first —
     * publishing a token that does not work would lock every other device
     * out — then encrypted with the teacher password and committed.
     */
    async saveCloudToken() {
      if (!this.requireAdmin()) return false;
      if (this.cloudToken.saving) return false;

      this.cloudToken.error = '';
      this.cloudToken.notice = '';

      const token = normaliseToken(this.githubAuth.token);
      if (!token) {
        this.cloudToken.error = 'Paste the fine-grained Personal Access Token above first.';
        return false;
      }
      if (!isFineGrainedToken(token) && !/^gh[a-z]_/.test(token)) {
        this.cloudToken.error = 'That does not look like a GitHub token. Fine-grained tokens start with “github_pat_”.';
        return false;
      }

      const password = String(this.cloudToken.password || '');
      if (!password) {
        this.cloudToken.error = 'Enter the current teacher password — it is the key that unlocks the saved token.';
        return false;
      }

      // The vault is only useful if teachers can actually open it, so the
      // password must be the one the teacher login uses right now.
      let digest;
      try {
        digest = await sha256Hex(`${TEACHER_HASH_SALT}::${this.effectiveTeacherUsername}::${password}`);
      } catch (error) {
        this.cloudToken.error = error.message;
        return false;
      }
      if (!digestsMatch(digest, this.effectiveTeacherDigest)) {
        this.cloudToken.error = 'That is not the current teacher password, so teachers would not be able to unlock the token. Use the password from Teacher Access below.';
        return false;
      }

      this.cloudToken.saving = true;
      try {
        this.githubAuth.token = token;
        const publisher = this.buildGithubPublisher();

        // 1. The token must work before it is published to everyone.
        const verified = await publisher.verify();

        // 2. Encrypt, then commit over whatever is there now.
        const payload = await encryptCloudToken({ token, password, savedBy: ADMIN_USERNAME });
        const existing = await publisher.getFile(CLOUD_TOKEN_PATH);
        const result = await publisher.putFile({
          path: CLOUD_TOKEN_PATH,
          contentBase64: textToBase64(serialiseVault(payload)),
          sha: existing.exists ? existing.sha : '',
          message: existing.exists
            ? 'Replace the shared publishing token (via School Cloud System)'
            : 'Save the shared publishing token (via School Cloud System)'
        });

        const summary = vaultSummary(payload);
        this.cloudToken.payload = payload;
        this.cloudToken.exists = true;
        this.cloudToken.sha = result.contentSha || '';
        this.cloudToken.fingerprint = summary.fingerprint;
        this.cloudToken.savedAt = summary.savedAt;
        this.cloudToken.savedBy = summary.savedBy;
        this.cloudToken.replacing = false;
        this.cloudToken.previousToken = '';
        this.cloudToken.password = '';
        this.cloudToken.showPassword = false;
        this.cloudToken.notice = existing.exists
          ? 'The saved token was replaced. Every device picks up the new one at the next sign-in.'
          : 'Saved. Teachers and administrators on any device now unlock this token when they sign in.';

        // This tab is now publishing with the shared token too.
        this.githubAuth.connected = true;
        this.githubAuth.login = verified.login;
        this.githubAuth.source = 'vault';
        this.githubAuth.error = '';
        this.cloudToken.unlocked = true;
        this.rememberGithubToken(token, 'vault');
        try {
          sessionStorage.setItem(CLOUD_TOKEN_FINGERPRINT_SESSION_KEY, summary.fingerprint);
        } catch {
          /* Cosmetic only. */
        }

        alert(`Token saved to GitHub Cloud.\n\nIt is stored at ${CLOUD_TOKEN_PATH}, encrypted with the teacher password — the file never contains the token itself.\n\nAnyone signing in with the teacher login now publishes through this token, on every device, once GitHub Pages redeploys (usually 1–2 minutes).`);
        return true;
      } catch (error) {
        console.warn('Saving the shared token failed.', error);
        this.cloudToken.error = `The token could not be saved to GitHub: ${error.message}`;
        return false;
      } finally {
        this.cloudToken.saving = false;
        this.$nextTick(() => refreshIcons());
      }
    },

    /** Show the paste-a-new-token form so the saved token can be swapped. */
    startCloudTokenReplace() {
      if (!this.requireAdmin()) return;
      this.cloudToken.replacing = true;
      this.cloudToken.error = '';
      this.cloudToken.notice = '';
      this.cloudToken.password = '';
      // Park the live token so cancelling leaves the session exactly as it
      // was, rather than "connected" with an empty token.
      this.cloudToken.previousToken = this.githubAuth.token;
      this.githubAuth.token = '';
      this.githubAuth.error = '';
      this.$nextTick(() => {
        refreshIcons();
        document.getElementById('github-token')?.focus();
      });
    },

    cancelCloudTokenReplace() {
      this.cloudToken.replacing = false;
      this.cloudToken.password = '';
      this.cloudToken.error = '';
      this.githubAuth.token = this.cloudToken.previousToken || '';
      this.cloudToken.previousToken = '';
      this.$nextTick(() => refreshIcons());
    },

    /**
     * Delete the shared token from the repository. The commit removes the
     * file, so the GitHub Pages site and every other browser stop finding it;
     * this tab disconnects immediately.
     */
    async deleteCloudToken() {
      if (!this.requireAdmin()) return false;
      if (this.cloudToken.deleting) return false;

      this.cloudToken.error = '';
      this.cloudToken.notice = '';

      if (!this.githubAuth.connected || !normaliseToken(this.githubAuth.token)) {
        this.cloudToken.error = 'Unlock the saved token (or paste a working one) first — deleting the file is itself a commit, so GitHub needs a token to do it.';
        return false;
      }
      if (!confirm(
        'Delete the shared publishing token from the repository?\n\n' +
        '• The file is removed from GitHub in one commit.\n' +
        '• Every device stops publishing through it at the next sign-in.\n' +
        '• This tab disconnects straight away.\n\n' +
        'Remember to revoke the token on github.com as well — deleting the file does not revoke it.'
      )) return false;

      this.cloudToken.deleting = true;
      try {
        const publisher = this.buildGithubPublisher();
        const existing = await publisher.getFile(CLOUD_TOKEN_PATH);
        if (existing.exists) {
          await publisher.deleteFile({
            path: CLOUD_TOKEN_PATH,
            sha: existing.sha,
            message: 'Delete the shared publishing token (via School Cloud System)'
          });
        }

        this.cloudToken.payload = null;
        this.cloudToken.exists = false;
        this.cloudToken.sha = '';
        this.cloudToken.fingerprint = '';
        this.cloudToken.savedAt = '';
        this.cloudToken.savedBy = '';
        this.cloudToken.replacing = false;

        // Disconnect everywhere this tab could still use it, then restore the
        // message disconnectGithub() does not know about.
        this.disconnectGithub();
        this.cloudToken.notice = 'The shared token was deleted from the repository. Revoke it on github.com too.';

        alert(`Deleted. ${CLOUD_TOKEN_PATH} has been removed from the repository, so no device can unlock it any more.\n\nThe token itself still exists on GitHub until you revoke it — open Settings → Developer settings → Personal access tokens and revoke it there.`);
        return true;
      } catch (error) {
        console.warn('Deleting the shared token failed.', error);
        this.cloudToken.error = `The token could not be deleted from GitHub: ${error.message}`;
        return false;
      } finally {
        this.cloudToken.deleting = false;
        this.$nextTick(() => refreshIcons());
      }
    },

    /**
     * Decrypt the shared token with a teacher password and use it for this
     * session. Called automatically at teacher sign-in, and from the unlock
     * form in Settings for administrators.
     *
     * @param {string} password  The shared teacher password.
     * @param {object} options   { silent } — no UI noise during auto-unlock.
     */
    async unlockCloudToken(password, options = {}) {
      const silent = Boolean(options.silent);
      if (!silent) {
        this.cloudToken.error = '';
        this.cloudToken.notice = '';
      }

      if (!this.cloudToken.checked) await this.loadCloudToken({ silent: true });
      if (!this.cloudToken.exists || !this.cloudToken.payload) {
        if (!silent) this.cloudToken.error = 'No shared token is saved in the repository yet.';
        return false;
      }

      this.cloudToken.unlocking = true;
      try {
        const token = await decryptCloudToken(this.cloudToken.payload, password);
        this.githubAuth.token = token;
        this.githubAuth.connected = true;
        this.githubAuth.source = 'vault';
        this.githubAuth.error = '';
        this.cloudToken.unlocked = true;
        this.cloudToken.unlockPassword = '';
        this.cloudToken.showUnlockPassword = false;
        this.rememberGithubToken(token, 'vault');

        const fingerprint = await tokenFingerprint(token);
        this.cloudToken.fingerprint = fingerprint;
        try {
          sessionStorage.setItem(CLOUD_TOKEN_FINGERPRINT_SESSION_KEY, fingerprint);
        } catch {
          /* Cosmetic only. */
        }
        if (!silent) this.cloudToken.notice = 'Unlocked. Publishing from this device uses the shared token.';
        // With a token in hand, the shared review queue becomes readable.
        this.loadCloudQueue({ silent: true });
        return true;
      } catch (error) {
        // An auto-unlock attempt that fails is not an error the teacher
        // caused — the administrator may simply have rotated the password.
        if (silent) console.warn('The shared token could not be unlocked automatically.', error);
        else this.cloudToken.error = error.message;
        return false;
      } finally {
        this.cloudToken.unlocking = false;
        this.$nextTick(() => refreshIcons());
      }
    },

    /** Unlock from the Settings form (administrators). */
    async unlockCloudTokenFromForm() {
      if (!this.requireAdmin()) return;
      await this.unlockCloudToken(this.cloudToken.unlockPassword);
    },

    toggleCloudTokenPassword() {
      this.cloudToken.showPassword = !this.cloudToken.showPassword;
      this.$nextTick(() => refreshIcons());
    },

    toggleCloudTokenUnlockPassword() {
      this.cloudToken.showUnlockPassword = !this.cloudToken.showUnlockPassword;
      this.$nextTick(() => refreshIcons());
    },

    /**
     * Re-encrypt the saved token under a new teacher password, so rotating
     * the teacher login does not silently lock every device out of
     * publishing. Called from saveTeacherCredentials().
     */
    async reEncryptCloudToken(newPassword) {
      if (!this.cloudToken.exists) return false;
      const token = normaliseToken(this.githubAuth.token);
      if (!token) return false;

      try {
        const publisher = this.buildGithubPublisher();
        const payload = await encryptCloudToken({ token, password: newPassword, savedBy: ADMIN_USERNAME });
        const existing = await publisher.getFile(CLOUD_TOKEN_PATH);
        const result = await publisher.putFile({
          path: CLOUD_TOKEN_PATH,
          contentBase64: textToBase64(serialiseVault(payload)),
          sha: existing.exists ? existing.sha : '',
          message: 'Re-lock the shared publishing token after a teacher password change (via School Cloud System)'
        });

        const summary = vaultSummary(payload);
        this.cloudToken.payload = payload;
        this.cloudToken.sha = result.contentSha || '';
        this.cloudToken.savedAt = summary.savedAt;
        this.cloudToken.fingerprint = summary.fingerprint;
        return true;
      } catch (error) {
        console.warn('The shared token could not be re-locked with the new teacher password.', error);
        return false;
      }
    },

    /** Raw base64 of a submission's stored bytes, or '' when unavailable. */
    async submissionBase64(record) {
      if (!record) return '';
      if (record.storage === 'idb') {
        const blob = await getFile(record.id);
        if (blob) return blobToBase64(blob);
      }
      if (record.storage === 'inline' && record.inlineData) {
        const comma = record.inlineData.indexOf(',');
        if (comma >= 0) return record.inlineData.slice(comma + 1).replace(/\s+/g, '');
      }
      // Staged in the repository by another device (or by this one before the
      // browser store was cleared) — read it back out of GitHub.
      if (record.cloudPath && this.githubAuth.connected) {
        const file = await this.buildGithubPublisher().getFileBase64(record.cloudPath);
        if (file.exists) return file.base64;
      }
      return '';
    },

    // --- Cross-device review queue ---------------------------------------------
    //
    // A teacher's upload is committed to `submissions/pending/` and indexed in
    // `submissions/queue.json` the moment it is submitted, so an administrator
    // on any device sees it in Review Submissions. It is NOT in the library:
    // apps.json is built from `apps/` alone, so a staged upload is not listed,
    // searchable or linked anywhere until approval moves it into `apps/`.

    /** True when uploads can be staged in (and reviewed from) the repository. */
    get cloudReviewReady() {
      return this.githubAuth.connected && !this.offline;
    },

    /**
     * Stage a teacher's upload in the repository: the bytes go to
     * `submissions/pending/`, the metadata into `submissions/queue.json`.
     * Returns true when the upload reached GitHub.
     */
    async uploadSubmissionToCloudQueue(record) {
      if (!record || !this.cloudReviewReady) return false;

      this.cloudQueue.uploading = true;
      try {
        const fileBase64 = await this.submissionBase64(record);
        if (!fileBase64) throw new Error('The selected file could not be read back for upload.');

        const publisher = this.buildGithubPublisher();
        const path = pendingPathFor(record);

        // 1. The bytes. A re-submission with the same id simply replaces it.
        const existing = await publisher.getFile(path);
        await publisher.putFile({
          path,
          contentBase64: fileBase64,
          sha: existing.exists ? existing.sha : '',
          message: `Submit for review: ${record.title} (via School Cloud System)`
        });

        // 2. The queue entry, written with a retry so two teachers submitting
        //    at the same moment cannot overwrite each other.
        const entry = queueEntryFromSubmission(record, { path });
        await commitJsonWithRetry(publisher, {
          path: CLOUD_QUEUE_PATH,
          message: `Queue “${record.title}” for review (via School Cloud System)`,
          transform: currentText => mergeQueueEntry(currentText, entry)
        });

        record.cloudPath = path;
        record.cloudQueued = true;
        record.queuedAt = new Date().toISOString();
        this.saveSubmissions();
        this.cloudQueue.available = true;
        return true;
      } catch (error) {
        console.warn('Staging the submission in the repository failed.', error);
        this.cloudQueue.error = error.message || 'The upload could not be sent to the school cloud.';
        return false;
      } finally {
        this.cloudQueue.uploading = false;
        this.$nextTick(() => refreshIcons());
      }
    },

    /** Read queue.json: the deployed site first, the API as the fallback. */
    async fetchCloudQueue() {
      try {
        const response = await fetch(`./${CLOUD_QUEUE_PATH}?refresh=${Date.now()}`, { cache: 'no-store' });
        if (response.ok) return parseQueue(await response.text());
      } catch (error) {
        console.warn('The deployed review queue was unavailable.', error);
      }

      // Not deployed yet (GitHub Pages lags a commit by a minute or two), so
      // ask the API — authenticated when possible, to dodge the rate limit.
      const repo = this.normalizeRepository(this.githubConfig.repo) || DEFAULT_GITHUB_REPO;
      const [owner, repository] = repo.split('/');
      const path = CLOUD_QUEUE_PATH.split('/').map(encodeURIComponent).join('/');
      const endpoint = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/contents/${path}?ref=main`;
      const headers = { Accept: 'application/vnd.github.raw+json', 'X-GitHub-Api-Version': '2022-11-28' };
      if (this.githubAuth.connected && this.githubAuth.token) {
        headers.Authorization = `Bearer ${this.githubAuth.token}`;
      }

      try {
        const response = await fetch(endpoint, { cache: 'no-store', headers });
        if (!response.ok) return null;
        const body = await response.text();
        const direct = parseQueue(body);
        if (direct.length) return direct;
        try {
          const envelope = JSON.parse(body);
          if (envelope?.encoding === 'base64' && envelope.content) {
            return parseQueue(base64ToText(envelope.content));
          }
        } catch {
          /* Not the JSON envelope. */
        }
        return direct;
      } catch (error) {
        console.warn('Could not read the review queue from the GitHub API.', error);
        return null;
      }
    },

    /**
     * Pull the repository's queue in and merge it with this browser's own
     * submissions, so Review Submissions shows every teacher's uploads
     * regardless of which device made them.
     */
    async loadCloudQueue(options = {}) {
      if (this.cloudQueue.loading) return false;
      this.cloudQueue.loading = true;
      if (!options.silent) this.cloudQueue.error = '';

      try {
        const entries = await this.fetchCloudQueue();
        if (entries === null) {
          this.cloudQueue.available = false;
          return false;
        }

        this.submissions = mergeSubmissionLists(this.submissions, entries);
        this.saveSubmissions();

        // An entry approved and published elsewhere must not linger as a
        // local library card; the repository copy is the canonical one.
        for (const record of this.submissions) {
          if (record.published) this.apps = this.apps.filter(app => app.submissionId !== record.id);
        }
        this.saveApps();

        this.cloudQueue.available = true;
        this.cloudQueue.count = pendingCount(entries);
        this.cloudQueue.loadedAt = new Date().toISOString();
        return true;
      } catch (error) {
        console.warn('The review queue could not be loaded.', error);
        this.cloudQueue.error = error.message || 'The review queue could not be loaded.';
        return false;
      } finally {
        this.cloudQueue.loading = false;
        this.$nextTick(() => refreshIcons());
      }
    },

    /** Manual refresh button in Review Submissions. */
    async refreshCloudQueue() {
      if (!this.requireStaff()) return;
      const loaded = await this.loadCloudQueue();
      if (!loaded && !this.cloudQueue.error) {
        this.cloudQueue.error = 'No shared review queue was found in the repository yet.';
      }
    },

    /** Patch one entry in the repository's queue (status, review notes…). */
    async patchCloudQueueEntry(record, changes) {
      if (!record?.cloudQueued || !this.githubAuth.connected) return false;
      try {
        const result = await commitJsonWithRetry(this.buildGithubPublisher(), {
          path: CLOUD_QUEUE_PATH,
          message: `Update review status for “${record.title}” (via School Cloud System)`,
          transform: currentText => patchQueueEntry(currentText, record.id, changes)
        });
        return result.changed;
      } catch (error) {
        console.warn('The review queue could not be updated.', error);
        return false;
      }
    },

    /** Remove a staged file and its queue entry from the repository. */
    async removeFromCloudQueue(record, { keepEntry = false, message = '' } = {}) {
      if (!record?.cloudPath || !this.githubAuth.connected) return false;
      const publisher = this.buildGithubPublisher();

      try {
        const staged = await publisher.getFile(record.cloudPath);
        if (staged.exists) {
          await publisher.deleteFile({
            path: record.cloudPath,
            sha: staged.sha,
            message: message || `Remove staged upload ${record.cloudPath} (via School Cloud System)`
          });
        }
      } catch (error) {
        console.warn('The staged file could not be deleted.', error);
        return false;
      }

      if (keepEntry) return true;

      try {
        await commitJsonWithRetry(publisher, {
          path: CLOUD_QUEUE_PATH,
          message: `Remove “${record.title}” from the review queue (via School Cloud System)`,
          transform: currentText => removeQueueEntry(currentText, record.id)
        });
      } catch (error) {
        console.warn('The queue entry could not be removed.', error);
      }
      return true;
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
      return this.pushSubmissionToRepository(record, options);
    },

    /**
     * The publishing pipeline itself, without the administrator guard, so it
     * can also serve a teacher's own upload when
     * PUBLISH_TEACHER_UPLOADS_IMMEDIATELY is enabled and the shared cloud
     * token is unlocked. Callers are responsible for authorisation.
     */
    async pushSubmissionToRepository(record, options = {}) {
      if (!record || record.published) return false;
      if (!this.githubAuth.connected) return false;
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

        // The file now lives in apps/, so the staging copy is redundant:
        // delete it and record the outcome in the shared queue, which is how
        // every other device learns the submission was approved.
        if (record.cloudQueued) {
          if (record.cloudPath) {
            const staged = record.cloudPath;
            const removed = await this.removeFromCloudQueue(record, {
              keepEntry: true,
              message: `Approved — remove staged copy ${staged} (via School Cloud System)`
            });
            if (removed) record.cloudPath = '';
          }
          await this.patchCloudQueueEntry(record, {
            status: 'approved',
            reviewedAt: record.reviewedAt || new Date().toISOString(),
            reviewedBy: record.reviewedBy || 'administrator',
            published: true,
            publishedPath: record.publishedPath,
            commitUrl: record.commitUrl,
            path: ''
          });
        }

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
      const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
      if (this.githubAuth?.connected && this.githubAuth?.token) {
        headers.Authorization = `Bearer ${this.githubAuth.token}`;
      }
      const response = await fetch(endpoint, {
        cache: 'no-store',
        headers
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
        // Stamp new arrivals before decorating, so their "Latest" badge is
        // based on when they appeared rather than when this page loaded.
        this.recordFirstSeen(
          files
            .filter(file => file.type === 'file' && SUPPORTED_FILE_PATTERN.test(file.name))
            .map(file => ({ githubPath: file.path, fileName: file.name }))
        );

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
              createdAt: file.createdAt || file.addedAt || new Date().toISOString(),
              addedAt: file.addedAt || this.firstSeenAt({ githubPath: file.path, fileName: file.name }) || '',
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

    // Both classification fields are fixed dropdowns, so a suggestion is only
    // offered when the inferred value is one of the school's own options.

    suggestedSubject() {
      return suggestSubjectOption(this.draft);
    },

    suggestedYearsLabel() {
      return suggestYearLevel(this.draft);
    },

    applySuggestedSubject() {
      const subject = suggestSubjectOption(this.draft);
      if (subject) this.draft.subject = subject;
    },

    applySuggestedYears() {
      const level = suggestYearLevel(this.draft);
      if (level) this.draft.years = level;
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

        // 4a. Optional: skip review entirely and publish straight to the
        //     library. Off by default (PUBLISH_TEACHER_UPLOADS_IMMEDIATELY).
        let cloudPublished = false;
        if (record.status === 'pending' && PUBLISH_TEACHER_UPLOADS_IMMEDIATELY && this.cloudReviewReady) {
          cloudPublished = await this.pushSubmissionToRepository(record);
          if (cloudPublished) {
            record.status = 'approved';
            record.reviewedAt = new Date().toISOString();
            record.reviewedBy = 'shared cloud token';
            record.reviewNote = 'Published automatically — this school publishes teacher uploads straight to the public repository.';
            this.saveSubmissions();
          }
        }

        // 4b. The normal path: stage the upload in the repository so an
        //     administrator on ANY device can review it. It goes to
        //     submissions/, never to apps/, so it stays out of the library
        //     until it is approved.
        let staged = false;
        if (!cloudPublished && record.status === 'pending') {
          staged = await this.uploadSubmissionToCloudQueue(record);
        }

        this.rememberUploadPrefs();
        this.resetDraft();

        if (cloudPublished) {
          this.currentView = 'library';
          alert(`Uploaded to the school cloud. “${record.title}” was committed to the public repository and appears on every device once GitHub Pages redeploys (usually 1–2 minutes).`);
        } else if (record.status === 'approved') {
          this.currentView = 'library';
          alert(`Published. “${record.title}” is now in the library and searchable immediately.`);
        } else if (staged) {
          this.currentView = 'submissions';
          alert(`Sent to the school cloud for review.\n\n“${record.title}” was uploaded to GitHub and is now in the administrator's review queue — on every device, not just this one.\n\nIt is NOT in the public library yet: students will only see it once an administrator approves it.`);
        } else {
          this.currentView = 'submissions';
          const reason = this.cloudQueue.error
            ? `\n\nIt could not be sent to the school cloud (${this.cloudQueue.error}), so for now it is saved on this device only — an administrator must review it here, or you can submit again once the connection is back.`
            : '\n\nIt is saved on this device only: no shared publishing token is unlocked, so an administrator must review it in this browser. Ask the administrator to save a token in Settings → GitHub Auto-Publish.';
          alert(`Submitted for review. “${record.title}” will appear in the public library once an administrator approves it.${reason}`);
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
      // Pull in uploads staged by other devices, so the queue is the whole
      // school's and not just this browser's.
      this.loadCloudQueue({ silent: true });
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

      // A submission staged in the repository has no bytes on this device,
      // so approval must reach GitHub — otherwise "approved" would mean
      // nothing and the file would stay in the staging folder forever.
      if (record.cloudPath && !this.githubAuth.connected) {
        this.currentView = 'settings';
        alert(`“${record.title}” was uploaded from another device, so approving it needs a GitHub connection.\n\nUnlock the shared token in Settings → GitHub Auto-Publish and try again.`);
        return;
      }

      record.status = 'approved';
      record.reviewedAt = new Date().toISOString();
      record.reviewedBy = 'administrator';
      // Only a locally-stored file can be shown from this browser; a staged
      // upload becomes a library card once it has been moved into apps/.
      if (!record.cloudPath) this.addApprovedToLibrary(record);
      this.saveSubmissions();
      this.saveApps();
      this.$nextTick(() => refreshIcons());

      // With a GitHub token connected, approval publishes to the public
      // repository in the same step. Any failure falls back to the manual
      // copy/paste flow — the approval itself always stands.
      if (this.autoPublishReady) {
        const published = await this.publishSubmissionToGithub(id);
        if (published) {
          alert(`Approved and published. “${record.title}” was moved into the apps folder and its metadata merged into library.json — it will appear on every device once GitHub Pages redeploys (usually 1–2 minutes).`);
          return;
        }
        // publishSubmissionToGithub already explained the failure.
        return;
      }

      alert(`Approved. “${record.title}” is now in the library and searchable immediately.\n\nTo make it appear on every device, connect GitHub Auto-Publish in Settings — or upload the file to the apps folder on GitHub and paste the copied metadata into library.json (use “Copy metadata” next to the submission).`);
    },

    async declineSubmission(id) {
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

      // A declined upload must not be left sitting in the repository: delete
      // the staged file, but keep the queue entry so the teacher sees why.
      if (record.cloudQueued && this.githubAuth.connected) {
        if (record.cloudPath) {
          const removed = await this.removeFromCloudQueue(record, {
            keepEntry: true,
            message: `Decline ${record.cloudPath} (via School Cloud System)`
          });
          if (removed) record.cloudPath = '';
        }
        await this.patchCloudQueueEntry(record, {
          status: 'rejected',
          reviewNote: record.reviewNote,
          reviewedAt: record.reviewedAt,
          reviewedBy: record.reviewedBy,
          path: ''
        });
        this.saveSubmissions();
        this.$nextTick(() => refreshIcons());
      }
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
      } else if (record.cloudQueued) {
        // Staged in the repository and awaiting review: removing it here must
        // remove it there too, or the queue would keep showing a ghost.
        if (!this.githubAuth.connected) {
          alert(`“${record.title}” is waiting for review in the repository, so removing it needs a GitHub connection.\n\nUnlock the shared token in Settings → GitHub Auto-Publish and try again.`);
          return;
        }
        if (!confirm(`Permanently remove “${record.title}”? The staged file and its review-queue entry are deleted from GitHub, so it disappears for every device. This cannot be undone.`)) return;
        if (!(await this.removeFromCloudQueue(record))) {
          alert(`Removing “${record.title}” from the repository failed, so nothing was changed. You can retry.`);
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
        if (blob) return URL.createObjectURL(blob);
      }
      if (record.storage === 'inline' && record.inlineData) {
        try {
          const response = await fetch(record.inlineData);
          return URL.createObjectURL(await response.blob());
        } catch {
          /* Fall through to the repository copy. */
        }
      }
      // Staged in the repository: fetch the bytes so an administrator can
      // preview and download an upload made on someone else's device.
      if (record.cloudPath && this.githubAuth.connected) {
        try {
          const file = await this.buildGithubPublisher().getFileBase64(record.cloudPath);
          if (!file.exists || !file.base64) return '';
          const binary = atob(file.base64);
          const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
          return URL.createObjectURL(new Blob([bytes], { type: record.mime || 'application/octet-stream' }));
        } catch (error) {
          console.warn('The staged file could not be fetched from the repository.', error);
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
          // The administrator's password cannot open the vault (it is locked
          // with the teacher password), so just make sure Settings knows
          // whether a shared token exists.
          this.loadCloudToken({ silent: true });
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
          // The teacher password is the key to the shared publishing token,
          // and this is the only moment the site ever sees it in the clear —
          // so unlock the vault now and keep only the decrypted token.
          this.unlockCloudToken(password, { silent: true });
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
      const newPassword = this.teacherCreds.password;
      try {
        const username = this.teacherCreds.username.trim();
        // Same scheme as config.js: salted SHA-256, never plaintext.
        const digest = await sha256Hex(`${TEACHER_HASH_SALT}::${username}::${newPassword}`);

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

      // The shared publishing token is locked with the teacher password, so a
      // rotation would strand every device unless the vault is re-locked with
      // the new one. Do it now, while the token is still in this session.
      let vaultNote = '';
      if (this.cloudToken.exists) {
        if (normaliseToken(this.githubAuth.token)) {
          vaultNote = (await this.reEncryptCloudToken(newPassword))
            ? '\n\nThe shared publishing token was re-locked with the new password, so teachers keep publishing without interruption.'
            : '\n\nWARNING: the shared publishing token could NOT be re-locked with the new password. Open Settings → GitHub Auto-Publish and save the token again, or teachers will not be able to publish.';
        } else {
          vaultNote = '\n\nWARNING: a shared publishing token is saved in the repository but is locked with the OLD password. Unlock it with the old password and save it again, or delete and re-save it.';
        }
      }

      // A teacher session on this device was signed in under the old
      // credentials — sign it out so the new login takes effect.
      try { sessionStorage.removeItem(TEACHER_SESSION_KEY); } catch { /* optional */ }

      this.cancelTeacherCreds();
      alert(`Teacher login updated on this device.\n\nUsername: ${this.effectiveTeacherUsername}\n\nThis applies to this browser only. To give every teacher the new login, copy the config lines below and paste them into assets/js/config.js on GitHub, then commit — the change applies site-wide once the site redeploys.${vaultNote}`);
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
