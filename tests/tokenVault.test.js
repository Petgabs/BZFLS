// ---------------------------------------------------------------------------
// Cloud publishing token vault.
//
// This is the one place in the project where a real secret is written to a
// public repository, so the tests are deliberately paranoid: the committed
// file must never contain the token, a wrong password must never open it, and
// a tampered file must be refused rather than silently trusted.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import {
  CLOUD_TOKEN_PATH,
  VAULT_VERSION,
  VAULT_CIPHER,
  VAULT_KDF,
  DEFAULT_ITERATIONS,
  MIN_ITERATIONS,
  TokenVaultError,
  bytesToBase64,
  base64ToBytes,
  tokenFingerprint,
  encryptCloudToken,
  decryptCloudToken,
  isVaultPayload,
  serialiseVault,
  parseVault,
  vaultSummary
} from '../assets/js/lib/tokenVault.js';

const TOKEN = 'github_pat_11AAAAAAA0exampletokenvalue_ZZZ99';
const PASSWORD = 'staffroom-2026';

// Keep the suite quick: the production default is DEFAULT_ITERATIONS, which
// the "defaults" test asserts separately.
const FAST = { iterations: MIN_ITERATIONS };

describe('base64 helpers', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 255, 128, 64]);
    expect([...base64ToBytes(bytesToBase64(bytes))]).toEqual([...bytes]);
  });

  it('tolerates whitespace in base64 from the Contents API', () => {
    const encoded = bytesToBase64(new Uint8Array([1, 2, 3]));
    expect([...base64ToBytes(`${encoded}\n`)]).toEqual([1, 2, 3]);
  });

  it('treats an empty value as empty bytes', () => {
    expect(base64ToBytes('').length).toBe(0);
  });

  it('rejects values that are not base64', () => {
    expect(() => base64ToBytes('!!! not base64 !!!')).toThrow(TokenVaultError);
  });
});

describe('tokenFingerprint', () => {
  it('is stable, short and not the token', async () => {
    const fingerprint = await tokenFingerprint(TOKEN);
    expect(fingerprint).toHaveLength(12);
    expect(fingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(fingerprint).toBe(await tokenFingerprint(TOKEN));
    expect(TOKEN).not.toContain(fingerprint);
  });

  it('differs between tokens and is empty for nothing', async () => {
    expect(await tokenFingerprint(TOKEN)).not.toBe(await tokenFingerprint(`${TOKEN}x`));
    expect(await tokenFingerprint('')).toBe('');
  });
});

describe('encryptCloudToken', () => {
  it('never puts the token in the published file', async () => {
    const payload = await encryptCloudToken({ token: TOKEN, password: PASSWORD, ...FAST });
    const published = serialiseVault(payload);

    expect(published).not.toContain(TOKEN);
    // Not even the recognisable prefix GitHub's secret scanner looks for.
    expect(published).not.toContain('github_pat_');
    for (const chunk of [TOKEN.slice(0, 16), TOKEN.slice(-16)]) {
      expect(published).not.toContain(chunk);
    }
  });

  it('records the parameters needed to open it again', async () => {
    const payload = await encryptCloudToken({
      token: TOKEN,
      password: PASSWORD,
      savedBy: 'Petgabs',
      now: new Date('2026-10-01T08:30:00Z'),
      ...FAST
    });

    expect(payload.version).toBe(VAULT_VERSION);
    expect(payload.cipher).toBe(VAULT_CIPHER);
    expect(payload.kdf).toBe(VAULT_KDF);
    expect(payload.iterations).toBe(MIN_ITERATIONS);
    expect(payload.unlockedBy).toBe('teacher-password');
    expect(payload.savedBy).toBe('Petgabs');
    expect(payload.savedAt).toBe('2026-10-01T08:30:00.000Z');
    expect(payload.fingerprint).toBe(await tokenFingerprint(TOKEN));
    expect(payload._comment).toMatch(/never the token itself/i);
  });

  it('defaults to a slow key derivation', async () => {
    const payload = await encryptCloudToken({ token: TOKEN, password: PASSWORD });
    expect(payload.iterations).toBe(DEFAULT_ITERATIONS);
    expect(DEFAULT_ITERATIONS).toBeGreaterThanOrEqual(310000);
  });

  it('refuses a weakened iteration count', async () => {
    const payload = await encryptCloudToken({ token: TOKEN, password: PASSWORD, iterations: 1 });
    expect(payload.iterations).toBe(MIN_ITERATIONS);
  });

  it('uses a fresh salt and IV every time', async () => {
    const first = await encryptCloudToken({ token: TOKEN, password: PASSWORD, ...FAST });
    const second = await encryptCloudToken({ token: TOKEN, password: PASSWORD, ...FAST });
    expect(first.salt).not.toBe(second.salt);
    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it('needs both a token and a password', async () => {
    await expect(encryptCloudToken({ token: '', password: PASSWORD })).rejects.toThrow(TokenVaultError);
    await expect(encryptCloudToken({ token: TOKEN, password: '' })).rejects.toThrow(/teacher password/i);
    await expect(encryptCloudToken({ token: 'has spaces', password: PASSWORD })).rejects.toThrow(/spaces/i);
  });
});

describe('decryptCloudToken', () => {
  it('returns the token for the right password', async () => {
    const payload = await encryptCloudToken({ token: TOKEN, password: PASSWORD, ...FAST });
    expect(await decryptCloudToken(payload, PASSWORD)).toBe(TOKEN);
  });

  it('survives a JSON round trip through the repository', async () => {
    const payload = await encryptCloudToken({ token: TOKEN, password: PASSWORD, ...FAST });
    const reloaded = parseVault(serialiseVault(payload));
    expect(await decryptCloudToken(reloaded, PASSWORD)).toBe(TOKEN);
  });

  it('refuses the wrong password with a useful message', async () => {
    const payload = await encryptCloudToken({ token: TOKEN, password: PASSWORD, ...FAST });
    await expect(decryptCloudToken(payload, 'staffroom-2025')).rejects.toThrow(/does not unlock/i);
  });

  it('refuses an empty password', async () => {
    const payload = await encryptCloudToken({ token: TOKEN, password: PASSWORD, ...FAST });
    await expect(decryptCloudToken(payload, '')).rejects.toThrow(/Enter the teacher password/i);
  });

  it('detects a tampered ciphertext instead of returning rubbish', async () => {
    const payload = await encryptCloudToken({ token: TOKEN, password: PASSWORD, ...FAST });
    const bytes = base64ToBytes(payload.ciphertext);
    bytes[0] ^= 0xff;
    await expect(
      decryptCloudToken({ ...payload, ciphertext: bytesToBase64(bytes) }, PASSWORD)
    ).rejects.toThrow(TokenVaultError);
  });

  it('refuses a file whose iterations were lowered to make it crackable', async () => {
    const payload = await encryptCloudToken({ token: TOKEN, password: PASSWORD, ...FAST });
    await expect(decryptCloudToken({ ...payload, iterations: 10 }, PASSWORD)).rejects.toThrow(/too few/i);
  });

  it('refuses unknown ciphers, KDFs and future versions', async () => {
    const payload = await encryptCloudToken({ token: TOKEN, password: PASSWORD, ...FAST });
    await expect(decryptCloudToken({ ...payload, cipher: 'ROT13' }, PASSWORD)).rejects.toThrow(/cipher/i);
    await expect(decryptCloudToken({ ...payload, kdf: 'MD5' }, PASSWORD)).rejects.toThrow(/key derivation/i);
    await expect(decryptCloudToken({ ...payload, version: 99 }, PASSWORD)).rejects.toThrow(/newer version/i);
  });

  it('explains that nothing is saved when there is no vault', async () => {
    await expect(decryptCloudToken(null, PASSWORD)).rejects.toThrow(/No encrypted token/i);
    await expect(decryptCloudToken({}, PASSWORD)).rejects.toThrow(/No encrypted token/i);
  });
});

describe('vault file handling', () => {
  it('knows a vault from anything else', async () => {
    const payload = await encryptCloudToken({ token: TOKEN, password: PASSWORD, ...FAST });
    expect(isVaultPayload(payload)).toBe(true);
    expect(isVaultPayload(null)).toBe(false);
    expect(isVaultPayload([payload])).toBe(false);
    expect(isVaultPayload({ ciphertext: 'x', salt: 'y', iv: 'z', iterations: 0 })).toBe(false);
  });

  it('serialises as pretty JSON with a trailing newline', async () => {
    const text = serialiseVault(await encryptCloudToken({ token: TOKEN, password: PASSWORD, ...FAST }));
    expect(text.endsWith('\n')).toBe(true);
    expect(text).toContain('\n  "version": 1');
  });

  it('returns null for a missing, empty or unusable file', () => {
    expect(parseVault('')).toBeNull();
    expect(parseVault(null)).toBeNull();
    expect(parseVault('not json')).toBeNull();
    expect(parseVault('{"hello":"world"}')).toBeNull();
  });

  it('summarises a vault without exposing anything secret', async () => {
    const payload = await encryptCloudToken({
      token: TOKEN,
      password: PASSWORD,
      savedBy: 'Petgabs',
      now: new Date('2026-10-01T08:30:00Z'),
      ...FAST
    });
    const summary = vaultSummary(payload);

    expect(summary).toEqual({
      exists: true,
      fingerprint: payload.fingerprint,
      savedAt: '2026-10-01T08:30:00.000Z',
      savedBy: 'Petgabs',
      iterations: MIN_ITERATIONS
    });
    expect(JSON.stringify(summary)).not.toContain(payload.ciphertext);
    expect(vaultSummary(null).exists).toBe(false);
  });

  it('lives under assets/ so GitHub Pages serves it to every device', () => {
    expect(CLOUD_TOKEN_PATH).toBe('assets/data/cloud-token.json');
  });
});
