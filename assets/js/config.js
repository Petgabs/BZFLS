// ---------------------------------------------------------------------------
// Site configuration.
//
// Everything here is public by design — this file ships to the browser. Only
// ever put publishable identifiers in it (Supabase's anon key is safe to
// expose when row-level security is enabled; see db/schema.sql).
// ---------------------------------------------------------------------------

export const DEFAULT_GITHUB_REPO = 'Petgabs/BZFLS';

// Teacher uploads are stored as files in IndexedDB (not base64 text in
// localStorage), so they can be larger than the browser-only mini apps.
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
// Fallback ceiling when IndexedDB is unavailable and the bytes would have to
// live inside localStorage as a base64 data URL.
export const MAX_INLINE_UPLOAD_BYTES = 2 * 1024 * 1024;

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

// --- Teacher ----------------------------------------------------------------
//
// A single shared staff account for uploading resources. Same scheme as the
// administrator: only the salted SHA-256 digest ships to the browser. Teachers
// can upload and describe resources but cannot delete anything — removal from
// the public repository happens on github.com with the administrator's
// account, and browser-side actions are guarded in code.
export const TEACHER_USERNAME = 'hoc-teacher';
export const TEACHER_HASH_SALT = 'BZFLS-SchoolCloud';
export const TEACHER_PASSWORD_SHA256 =
  'c793d667d6aa03c9001b2b8416f55ee3ade89c781d7cf1233e9d424ba1e70512';
export const TEACHER_SESSION_KEY = 'schoolcloud_teacher_session';

// Teacher submissions wait in a review queue until an administrator approves
// them. Administrators publish their own uploads immediately.
export const REQUIRE_TEACHER_APPROVAL = true;

// --- Storage keys -----------------------------------------------------------
export const APPS_STORAGE_KEY = 'schoolcloud_apps';
export const SUBMISSIONS_STORAGE_KEY = 'schoolcloud_submissions';
export const UPLOAD_PREFS_KEY = 'schoolcloud_upload_prefs';
export const GITHUB_CONFIG_KEY = 'schoolcloud_github_config';
export const LIBRARY_CACHE_KEY = 'schoolcloud_library_cache';
