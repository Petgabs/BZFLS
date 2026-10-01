// ---------------------------------------------------------------------------
// Cloud publishing token vault.
//
// The administrator can save the GitHub fine-grained Personal Access Token
// *into the repository itself*, so the whole site shares one publishing
// token instead of every administrator pasting their own into every tab.
//
// A raw token must never be committed to a public repository: GitHub's secret
// scanning revokes a plaintext PAT within seconds of it appearing in a public
// repo, and until it does, anyone can read it and write to the repository.
// So the file that is committed never contains the token — it contains
// AES-GCM ciphertext whose key is derived (PBKDF2-SHA256) from the shared
// teacher password:
//
//     teacher password ──PBKDF2(salt, 310k)──▶ AES-256 key ──▶ decrypt token
//
// Signing in with the teacher login therefore unlocks the token automatically
// on any device, which is exactly how the rest of the site is gated, and the
// published file on its own is useless: without the teacher password it is
// 90-odd bytes of random-looking base64.
//
// Rotating the teacher password re-encrypts the vault (see app.js), and
// deleting the vault removes the file from the repository entirely.
//
// Pure functions only — no DOM, no fetch, no storage — so every step is
// unit-testable. The interactive side lives in app.js and the committing side
// in lib/githubPublish.js.
// ---------------------------------------------------------------------------

/** Where the encrypted vault lives in the repository (and on the Pages site). */
export const CLOUD_TOKEN_PATH = 'assets/data/cloud-token.json';

export const VAULT_VERSION = 1;
export const VAULT_CIPHER = 'AES-GCM-256';
export const VAULT_KDF = 'PBKDF2-SHA256';

/** OWASP's 2023 floor for PBKDF2-SHA256. Roughly a third of a second. */
export const DEFAULT_ITERATIONS = 310000;
/** A published vault claiming fewer iterations than this is rejected. */
export const MIN_ITERATIONS = 100000;

const SALT_BYTES = 16;
const IV_BYTES = 12;

/** Error with a message that is safe and useful to show a human. */
export class TokenVaultError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TokenVaultError';
  }
}

function subtle() {
  const api = globalThis.crypto?.subtle;
  if (!api) {
    throw new TokenVaultError(
      'This browser cannot encrypt the token (Web Crypto is unavailable — the site must be served over HTTPS).'
    );
  }
  return api;
}

// --- Encoding ---------------------------------------------------------------

/** Uint8Array → base64. Chunked so large inputs cannot blow the call stack. */
export function bytesToBase64(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < view.length; i += CHUNK) {
    binary += String.fromCharCode(...view.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** base64 (whitespace tolerated) → Uint8Array. */
export function base64ToBytes(value) {
  const text = String(value || '').replace(/\s+/g, '');
  if (!text) return new Uint8Array(0);
  let binary;
  try {
    binary = atob(text);
  } catch {
    throw new TokenVaultError('The saved token file is corrupt (invalid base64).');
  }
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

function randomBytes(length) {
  const bytes = new Uint8Array(length);
  if (!globalThis.crypto?.getRandomValues) {
    throw new TokenVaultError('This browser cannot generate secure random values.');
  }
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

// --- Key derivation ----------------------------------------------------------

async function deriveKey(password, salt, iterations) {
  const material = await subtle().importKey(
    'raw',
    new TextEncoder().encode(String(password ?? '')),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return subtle().deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * A short, non-reversible identifier for a token, so the administrator can
 * confirm *which* token is live without the site ever showing it. Safe to
 * publish: it is the first 12 hex characters of SHA-256(token).
 */
export async function tokenFingerprint(token) {
  const value = String(token || '');
  if (!value) return '';
  const digest = await subtle().digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 12);
}

// --- Encrypt / decrypt --------------------------------------------------------

/**
 * Encrypt a GitHub token for publication in the repository.
 *
 * @param {object} options {
 *          token,        the fine-grained PAT to protect
 *          password,     the shared teacher password that will unlock it
 *          savedBy,      label recorded in the file (cosmetic)
 *          iterations,   PBKDF2 rounds (defaults to DEFAULT_ITERATIONS)
 *          now,          Date, for deterministic tests
 *          salt, iv      Uint8Array overrides, for deterministic tests
 *        }
 * @returns {Promise<object>} the exact JSON object to commit.
 */
export async function encryptCloudToken(options = {}) {
  const token = String(options.token || '').trim();
  const password = String(options.password ?? '');

  if (!token) throw new TokenVaultError('There is no token to save.');
  if (/\s/.test(token)) throw new TokenVaultError('The token contains spaces, so it is not a valid GitHub token.');
  if (!password) throw new TokenVaultError('Enter the teacher password that will unlock the token.');

  const iterations = Math.max(MIN_ITERATIONS, Number(options.iterations) || DEFAULT_ITERATIONS);
  const salt = options.salt instanceof Uint8Array ? options.salt : randomBytes(SALT_BYTES);
  const iv = options.iv instanceof Uint8Array ? options.iv : randomBytes(IV_BYTES);

  const key = await deriveKey(password, salt, iterations);
  const ciphertext = await subtle().encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(token)
  );

  return {
    _comment:
      'School Cloud System — encrypted GitHub publishing token. This file contains ' +
      'AES-GCM ciphertext, never the token itself. It can only be unlocked with the ' +
      'shared teacher password, and is managed from Settings → GitHub Auto-Publish. ' +
      'Do not edit it by hand.',
    version: VAULT_VERSION,
    cipher: VAULT_CIPHER,
    kdf: VAULT_KDF,
    iterations,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    fingerprint: await tokenFingerprint(token),
    unlockedBy: 'teacher-password',
    savedAt: (options.now instanceof Date ? options.now : new Date()).toISOString(),
    savedBy: String(options.savedBy || 'administrator')
  };
}

/** True when `value` looks like a vault file this version can open. */
export function isVaultPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Boolean(value.ciphertext && value.salt && value.iv && Number(value.iterations) > 0);
}

/**
 * Decrypt a vault with the shared teacher password.
 * Throws a TokenVaultError with a human-readable reason on any failure.
 */
export async function decryptCloudToken(payload, password) {
  if (!isVaultPayload(payload)) {
    throw new TokenVaultError('No encrypted token is saved in the repository.');
  }
  if (Number(payload.version) > VAULT_VERSION) {
    throw new TokenVaultError('The saved token was written by a newer version of this site. Refresh the page and try again.');
  }
  if (payload.kdf && payload.kdf !== VAULT_KDF) {
    throw new TokenVaultError(`Unsupported key derivation (${payload.kdf}).`);
  }
  if (payload.cipher && payload.cipher !== VAULT_CIPHER) {
    throw new TokenVaultError(`Unsupported cipher (${payload.cipher}).`);
  }

  const iterations = Number(payload.iterations);
  if (!Number.isFinite(iterations) || iterations < MIN_ITERATIONS) {
    throw new TokenVaultError('The saved token file specifies too few key-derivation rounds and was refused.');
  }
  if (!String(password ?? '')) {
    throw new TokenVaultError('Enter the teacher password to unlock the saved token.');
  }

  const key = await deriveKey(password, base64ToBytes(payload.salt), iterations);

  let plaintext;
  try {
    plaintext = await subtle().decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(payload.iv) },
      key,
      base64ToBytes(payload.ciphertext)
    );
  } catch {
    throw new TokenVaultError(
      'That password does not unlock the saved token. It must be the teacher password that was in force when the administrator saved it.'
    );
  }

  const token = new TextDecoder().decode(plaintext).trim();
  if (!token) throw new TokenVaultError('The saved token is empty.');
  return token;
}

// --- File helpers --------------------------------------------------------------

/** The exact JSON text to commit (2-space indent, trailing newline). */
export function serialiseVault(payload) {
  return `${JSON.stringify(payload, null, 2)}\n`;
}

/** Parse a committed vault file; returns null when it is missing or unusable. */
export function parseVault(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  return isVaultPayload(data) ? data : null;
}

/** Display-safe summary of a vault, for the administrator's status panel. */
export function vaultSummary(payload) {
  if (!isVaultPayload(payload)) {
    return { exists: false, fingerprint: '', savedAt: '', savedBy: '', iterations: 0 };
  }
  return {
    exists: true,
    fingerprint: String(payload.fingerprint || ''),
    savedAt: String(payload.savedAt || ''),
    savedBy: String(payload.savedBy || ''),
    iterations: Number(payload.iterations) || 0
  };
}
