// ---------------------------------------------------------------------------
// Teacher credential management (administrator task).
//
// The site is static, so credentials ship in assets/js/config.js as salted
// SHA-256 digests — never in plaintext. Changing them has two layers:
//
//   1. Device override — saved in this browser's localStorage by the
//      administrator; applies immediately, on this device only.
//   2. Repository change — the administrator pastes the generated lines into
//      assets/js/config.js on GitHub and commits; after the next deploy the
//      new login applies everywhere.
//
// Pure helpers only, so the validation rules are unit-testable. The
// interactive side lives in app.js.
// ---------------------------------------------------------------------------

/** Minimum length for a new teacher password. Shared accounts need passphrases, not short passwords. */
export const MIN_TEACHER_PASSWORD_LENGTH = 14;

/** Teacher usernames: 3–32 characters of letters, numbers, dots, dashes. */
const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$/;

/**
 * Validate a credential change.
 * Returns a map of field → message; an empty object means the change is valid.
 */
export function validateTeacherCredentials({ username, password, confirm } = {}) {
  const errors = {};
  const user = String(username || '').trim();

  if (!user) errors.username = 'Enter a username for the teacher account.';
  else if (!USERNAME_PATTERN.test(user)) {
    errors.username = 'Usernames are 3–32 characters: letters, numbers, dots or dashes (and must start with a letter or number).';
  }

  const pass = String(password || '');
  if (!pass) errors.password = 'Enter a password.';
  else if (pass === user) {
    errors.password = 'The password cannot be the same as the username.';
  } else if (pass.length < MIN_TEACHER_PASSWORD_LENGTH) {
    errors.password = `Use at least ${MIN_TEACHER_PASSWORD_LENGTH} characters — teachers share this account, so use a strong passphrase.`;
  } else if (/^\s|\s$/.test(pass)) {
    errors.password = 'The password must not start or end with a space.';
  }

  if (String(confirm ?? '') !== pass) errors.confirm = 'The two passwords do not match.';

  return errors;
}

/**
 * The exact lines to paste into assets/js/config.js so the new teacher
 * credentials apply to every device after the next deployment.
 */
export function teacherConfigSnippet(username, digest) {
  const user = String(username || '').replace(/['\\]/g, '');
  const hash = String(digest || '').replace(/[^a-f0-9]/gi, '');
  return [
    `export const TEACHER_USERNAME = '${user}';`,
    `export const TEACHER_PASSWORD_SHA256 =`,
    `  '${hash}';`
  ].join('\n');
}
