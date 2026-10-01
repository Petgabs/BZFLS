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
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
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
export const TEACHER_USERNAME = 'hsc-teacher';
export const TEACHER_HASH_SALT = 'BZFLS-SchoolCloud';
export const TEACHER_PASSWORD_SHA256 =
  '56f580444b9adb758bd63f15249997b73699ad95c78a66a1d2b32c815992542c';
export const TEACHER_SESSION_KEY = 'schoolcloud_teacher_session';

// Teacher submissions wait in a review queue until an administrator approves
// them. Administrators publish their own uploads immediately.
export const REQUIRE_TEACHER_APPROVAL = true;

// When the shared cloud publishing token is unlocked (see below), should a
// teacher's upload go straight into the public repository instead of waiting
// in the review queue?
//
//   false — the safe default. Nothing reaches GitHub until an administrator
//           approves it, exactly as before.
//   true  — a teacher's submission is committed to `apps/` and merged into
//           `library.json` the moment it is submitted, so it reaches every
//           device without the administrator having to be on the same
//           browser. Administrators can still delete anything afterwards.
//
// Flipping this to `true` is the only change needed: the publishing pipeline
// is already wired up in app.js (submitResource).
export const PUBLISH_TEACHER_UPLOADS_IMMEDIATELY = false;

// --- Storage keys -----------------------------------------------------------
export const APPS_STORAGE_KEY = 'schoolcloud_apps';
export const SUBMISSIONS_STORAGE_KEY = 'schoolcloud_submissions';
export const UPLOAD_PREFS_KEY = 'schoolcloud_upload_prefs';
// Administrator's device-local override of the teacher login (username +
// salted digest only, never the plaintext password). See lib/credentials.js.
export const TEACHER_OVERRIDE_KEY = 'schoolcloud_teacher_override';
export const GITHUB_CONFIG_KEY = 'schoolcloud_github_config';
export const LIBRARY_CACHE_KEY = 'schoolcloud_library_cache';

// Dashboard preferences for the "Library data safety" panel: whether the
// error/warning list is collapsed, and which individual messages an
// administrator has dismissed. Device-local and purely cosmetic — dismissing
// a message never changes the library itself, and a dismissed message comes
// back if the underlying problem is still there after "Restore hidden".
export const INTEGRITY_UI_KEY = 'schoolcloud_integrity_ui';

// Records the moment each cloud file was first seen by this browser, so the
// dashboard can show "Latest" / "Yesterday" badges even when a resource has no
// curated addedAt date in library.json.
export const FIRST_SEEN_KEY = 'schoolcloud_first_seen';
// The administrator's fine-grained GitHub token for auto-publishing approved
// submissions (Contents: Read and write on the public repository only). Kept
// in sessionStorage — never localStorage — so closing the tab forgets it, and
// it is never embedded in this public site. See assets/js/lib/githubPublish.js.
export const GITHUB_TOKEN_SESSION_KEY = 'schoolcloud_github_token';
// Records whether the token in this session was pasted by hand ('manual') or
// unlocked from the shared cloud vault ('vault'), so the UI can say which.
export const GITHUB_TOKEN_SOURCE_SESSION_KEY = 'schoolcloud_github_token_source';

// --- Shared cloud publishing token ------------------------------------------
//
// Settings → GitHub Auto-Publish can save the administrator's fine-grained
// token *into the repository*, so every device shares one publishing token
// instead of each administrator pasting their own.
//
// The committed file never contains the token. It holds AES-GCM ciphertext
// whose key is derived from the shared teacher password (PBKDF2-SHA256), so
// signing in with the teacher login unlocks it automatically and the public
// file on its own is useless. See assets/js/lib/tokenVault.js.
export const CLOUD_TOKEN_PATH = 'assets/data/cloud-token.json';

// --- Cross-device review queue ----------------------------------------------
//
// A teacher's upload goes straight into the repository so an administrator on
// any device can review it — but into a staging area, never into the library.
// `apps.json` is built from `apps/` alone, so nothing here is listed,
// searchable or linked on the site until it is approved.
//
//   submissions/pending/<id>__<file>   bytes waiting for review
//   submissions/queue.json             metadata + status of every upload
//
// See assets/js/lib/reviewQueue.js.
export const CLOUD_QUEUE_PATH = 'submissions/queue.json';
// Short, non-reversible fingerprint of the unlocked token, remembered for the
// tab so the status panel survives a reload.
export const CLOUD_TOKEN_FINGERPRINT_SESSION_KEY = 'schoolcloud_cloud_token_fingerprint';
