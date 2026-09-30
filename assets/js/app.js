// ---------------------------------------------------------------------------
// BZFLS-SchoolCloud — Alpine component.
//
// Phase 1: search + facets, structured metadata, previews, local vendor
// bundles, explicit loading/error/offline states, and counters backed by a
// managed database.
// ---------------------------------------------------------------------------

import {
  DEFAULT_GITHUB_REPO,
  MAX_LOCAL_APP_BYTES,
  SUPPORTED_FILE_PATTERN,
  COUNTER_CONFIG,
  VISITOR_COUNTER_KEY,
  VISIT_SESSION_KEY,
  ADMIN_USERNAME,
  ADMIN_HASH_SALT,
  ADMIN_PASSWORD_SHA256,
  ADMIN_SESSION_KEY,
  APPS_STORAGE_KEY,
  GITHUB_CONFIG_KEY,
  LIBRARY_CACHE_KEY
} from './config.js';

import {
  buildMetadata,
  indexOverrides,
  findOverride,
  titleFromFileName,
  kindOf,
  isMiniApp,
  extensionOf
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
  formatYears,
  iconForExtension,
  subjectAccent,
  describeFilters
} from './lib/format.js';

import { canPreview, previewDescriptor } from './lib/preview.js';

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

    // --- Admin --------------------------------------------------------------
    isAdmin: false,
    showLogin: false,
    checkingLogin: false,
    loginError: '',
    loginForm: { username: '', password: '' },
    uploading: false,
    syncing: false,
    fileName: '',
    fileContent: '',
    fileReady: false,
    fileReadId: 0,
    githubConfig: { repo: DEFAULT_GITHUB_REPO },
    newApp: { name: '', teacherName: '', description: '', subject: '', years: '', tags: '' },

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

    get decoratedApps() {
      return this.apps;
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
      return this.apps.filter(app => app.source !== 'github').length;
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

      try {
        this.isAdmin = sessionStorage.getItem(ADMIN_SESSION_KEY) === ADMIN_PASSWORD_SHA256;
      } catch (error) {
        console.warn('Session storage unavailable; admin must sign in each visit.', error);
      }

      try {
        const savedApps = JSON.parse(localStorage.getItem(APPS_STORAGE_KEY) || '[]');
        if (Array.isArray(savedApps)) this.apps = savedApps.map(app => this.decorate(app));
      } catch (error) {
        console.warn('Ignoring invalid saved app data.', error);
        localStorage.removeItem(APPS_STORAGE_KEY);
      }

      try {
        const savedConfig = JSON.parse(localStorage.getItem(GITHUB_CONFIG_KEY) || '{}');
        const savedRepo = this.normalizeRepository(savedConfig.repo);
        if (savedRepo) this.githubConfig.repo = savedRepo;
      } catch (error) {
        console.warn('Ignoring invalid GitHub configuration.', error);
      }
      this.persistGithubConfig();

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

    /** Attach a `meta` block to a raw app record. */
    decorate(app) {
      if (!app || typeof app !== 'object') return app;
      const overrides = findOverride(this.overrides, app);
      return {
        ...app,
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
      return canPreview(item);
    },

    openPreview(item) {
      const descriptor = previewDescriptor(item);
      this.errors.preview = '';

      if (!descriptor) {
        this.errors.preview = 'This file type cannot be previewed in the browser.';
        return;
      }
      if (descriptor.requiresPublicUrl && this.offline) {
        this.errors.preview = 'Office previews need an internet connection. Download the file instead.';
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
    subjectAccent,

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

    // --- Uploads ------------------------------------------------------------

    handleFileChange(event) {
      const file = event.target.files[0];
      const readId = ++this.fileReadId;
      this.fileName = '';
      this.fileContent = '';
      this.fileReady = false;

      if (!file) return;

      if (!/\.html$/i.test(file.name)) {
        event.target.value = '';
        alert('Please select an HTML file.');
        return;
      }
      if (file.size > MAX_LOCAL_APP_BYTES) {
        event.target.value = '';
        alert('The HTML file must be 2 MB or smaller for browser storage.');
        return;
      }

      this.fileName = file.name;
      const reader = new FileReader();
      reader.onload = loadEvent => {
        if (readId !== this.fileReadId) return;
        this.fileContent = String(loadEvent.target.result || '');
        this.fileReady = true;
      };
      reader.onerror = () => {
        if (readId !== this.fileReadId) return;
        this.fileName = '';
        this.fileContent = '';
        this.fileReady = false;
        alert('The selected file could not be read.');
      };
      reader.readAsText(file);
    },

    async handleUpload() {
      if (!this.requireAdmin()) return;
      if (!this.fileReady || !this.fileName || !this.fileContent) {
        alert('Wait for a valid HTML file to finish loading.');
        return;
      }

      this.uploading = true;
      const years = String(this.newApp.years || '')
        .split(/[,\s&]+/)
        .map(Number)
        .filter(year => Number.isFinite(year) && year >= 1 && year <= 13);

      const app = this.decorate({
        id: globalThis.crypto?.randomUUID?.() || Date.now().toString(),
        name: this.newApp.name.trim(),
        teacherName: this.newApp.teacherName.trim(),
        description: this.newApp.description.trim(),
        fileName: this.fileName,
        content: this.fileContent,
        createdAt: new Date().toISOString(),
        source: 'local'
      });

      // Explicit metadata from the upload form wins over inference.
      if (this.newApp.subject) app.meta.subject = this.newApp.subject;
      if (years.length) app.meta.years = years;
      if (this.newApp.tags) {
        app.meta.tags = this.newApp.tags.split(',').map(tag => tag.trim().toLowerCase()).filter(Boolean);
      }

      try {
        this.apps.unshift(app);
        this.saveApps();

        this.newApp = { name: '', teacherName: '', description: '', subject: '', years: '', tags: '' };
        this.fileName = '';
        this.fileContent = '';
        this.fileReady = false;
        this.fileReadId += 1;
        this.$refs.uploadForm.reset();
        this.currentView = 'library';
        alert('App saved to this browser. Use “Upload File Through GitHub” to share it publicly.');
      } catch (error) {
        this.apps = this.apps.filter(item => item.id !== app.id);
        alert('The app could not be saved. Browser storage may be full.');
      } finally {
        this.uploading = false;
      }
    },

    saveApps() {
      try {
        localStorage.setItem(APPS_STORAGE_KEY, JSON.stringify(this.apps));
      } catch (error) {
        console.warn('Could not save the library to this browser.', error);
      }
    },

    async downloadApp(app) {
      let blob = null;

      if (typeof app.content === 'string' && app.content) {
        blob = new Blob([app.content], { type: 'text/html' });
      } else if (app.downloadUrl) {
        try {
          const response = await fetch(app.downloadUrl, { cache: 'no-store' });
          if (!response.ok) throw new Error(`Download returned ${response.status}`);
          // Keep binary resources byte-for-byte intact.
          blob = await response.blob();
        } catch (error) {
          alert('Failed to download from GitHub: ' + error.message);
          return;
        }
      }

      if (!blob) {
        alert('No downloadable content is available for this file.');
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

      this.recordDownload(app);
    },

    deleteApp(id) {
      if (!this.requireAdmin()) return;
      if (confirm('Remove this browser-only app?')) {
        this.apps = this.apps.filter(app => app.id !== id);
        this.saveApps();
      }
    },

    clearData() {
      if (!this.requireAdmin()) return;
      if (confirm('Clear cached apps and reset the public repository setting?')) {
        localStorage.removeItem(APPS_STORAGE_KEY);
        localStorage.removeItem(GITHUB_CONFIG_KEY);
        localStorage.removeItem(LIBRARY_CACHE_KEY);
        this.apps = [];
        this.githubConfig = { repo: DEFAULT_GITHUB_REPO };
        this.currentView = 'library';
      }
    },

    // --- Admin session ------------------------------------------------------

    openLogin() {
      this.loginError = '';
      this.loginForm = { username: '', password: '' };
      this.showLogin = true;
      this.$nextTick(() => {
        refreshIcons();
        document.getElementById('admin-user')?.focus();
      });
    },

    async login() {
      if (this.checkingLogin) return;
      this.checkingLogin = true;
      this.loginError = '';

      try {
        const username = this.loginForm.username.trim();
        const digest = await sha256Hex(`${ADMIN_HASH_SALT}::${username}::${this.loginForm.password}`);

        if (username !== ADMIN_USERNAME || !digestsMatch(digest, ADMIN_PASSWORD_SHA256)) {
          this.loginError = 'Incorrect username or password.';
          return;
        }

        this.isAdmin = true;
        this.showLogin = false;
        this.loginForm = { username: '', password: '' };
        try {
          sessionStorage.setItem(ADMIN_SESSION_KEY, ADMIN_PASSWORD_SHA256);
        } catch (error) {
          console.warn('Could not persist the admin session.', error);
        }
        this.$nextTick(() => refreshIcons());
      } catch (error) {
        this.loginError = error.message;
      } finally {
        this.checkingLogin = false;
      }
    },

    logout() {
      this.isAdmin = false;
      this.currentView = 'library';
      try {
        sessionStorage.removeItem(ADMIN_SESSION_KEY);
      } catch (error) {
        console.warn('Could not clear the admin session.', error);
      }
      this.$nextTick(() => refreshIcons());
    },

    requireAdmin() {
      if (this.isAdmin) return true;
      this.openLogin();
      return false;
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
      this.apps = this.apps.filter(app => app.source === 'github');
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
