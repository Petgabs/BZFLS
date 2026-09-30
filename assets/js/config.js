// ---------------------------------------------------------------------------
// Site configuration.
//
// Everything here is public by design — this file ships to the browser. Only
// ever put publishable identifiers in it (Supabase's anon key is safe to
// expose when row-level security is enabled; see db/schema.sql).
// ---------------------------------------------------------------------------

export const DEFAULT_GITHUB_REPO = 'Petgabs/BZFLS';

export const MAX_LOCAL_APP_BYTES = 2 * 1024 * 1024;

export const SUPPORTED_FILE_PATTERN = /\.(?:html|pdf|docx?|xlsx?|pptx?)$/i;

// --- Counter storage --------------------------------------------------------
//
// To switch the counters onto the managed database:
//   1. Create a Supabase project (free tier is enough).
//   2. Run db/schema.sql in the SQL editor.
//   3. Paste the project URL and the anon/publishable key below.
//
// Leave `url` empty to keep using the legacy Abacus counter. The site works
// either way — see assets/js/lib/counters.js for the fallback chain.
export const COUNTER_CONFIG = {
  supabase: {
    url: '',
    anonKey: '',
    timeoutMs: 6000
  },
  // Transitional fallback, used until Supabase is configured.
  abacus: {
    base: 'https://abacus.jasoncameron.dev',
    namespace: 'bzfls-schoolcloud-petgabs',
    timeoutMs: 6000
  }
};

export const VISITOR_COUNTER_KEY = 'site-visits';
export const VISIT_SESSION_KEY = 'schoolcloud_visit_counted';

// --- Admin ------------------------------------------------------------------
//
// The password is never stored in plaintext: only the SHA-256 digest of
// `<SALT>::<username>::<password>` is present, and no GitHub token is
// embedded anywhere in this site.
export const ADMIN_USERNAME = 'Petgabs';
export const ADMIN_HASH_SALT = 'BZFLS-SchoolCloud';
export const ADMIN_PASSWORD_SHA256 =
  '80c8d57968c9c07428ad7a68c1b899076a4df66de6c381ed0c2e9efe5aceb262';
export const ADMIN_SESSION_KEY = 'schoolcloud_admin_session';

// --- Storage keys -----------------------------------------------------------
export const APPS_STORAGE_KEY = 'schoolcloud_apps';
export const GITHUB_CONFIG_KEY = 'schoolcloud_github_config';
export const LIBRARY_CACHE_KEY = 'schoolcloud_library_cache';
