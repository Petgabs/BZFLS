// ---------------------------------------------------------------------------
// Teacher credential rotation rules (administrator task). Pure validation and
// snippet generation — the interactive side lives in app.js.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import {
  validateTeacherCredentials,
  teacherConfigSnippet,
  MIN_TEACHER_PASSWORD_LENGTH
} from '../assets/js/lib/credentials.js';

describe('validateTeacherCredentials', () => {
  it('accepts a complete, strong change', () => {
    expect(validateTeacherCredentials({
      username: 'staff-2027',
      password: 'Sunshine-Cloud-9',
      confirm: 'Sunshine-Cloud-9'
    })).toEqual({});
  });

  it('requires a username', () => {
    const errors = validateTeacherCredentials({ username: '', password: 'long-enough', confirm: 'long-enough' });
    expect(errors.username).toBeTruthy();
  });

  it('rejects usernames that are too short or contain symbols', () => {
    expect(validateTeacherCredentials({ username: 'ab', password: 'long-enough', confirm: 'long-enough' }).username).toBeTruthy();
    expect(validateTeacherCredentials({ username: 'staff 2027!', password: 'long-enough', confirm: 'long-enough' }).username).toBeTruthy();
    expect(validateTeacherCredentials({ username: '_starts_with_symbol', password: 'long-enough', confirm: 'long-enough' }).username).toBeTruthy();
  });

  it('enforces a minimum password length', () => {
    const short = 'a'.repeat(MIN_TEACHER_PASSWORD_LENGTH - 1);
    const errors = validateTeacherCredentials({ username: 'staff-2027', password: short, confirm: short });
    expect(errors.password).toMatch(new RegExp(`at least ${MIN_TEACHER_PASSWORD_LENGTH} characters`, 'i'));
  });

  it('rejects a password equal to the username', () => {
    const errors = validateTeacherCredentials({ username: 'staff-2027', password: 'staff-2027', confirm: 'staff-2027' });
    expect(errors.password).toMatch(/cannot be the same/i);
  });

  it('rejects padded passwords', () => {
    const errors = validateTeacherCredentials({ username: 'staff-2027', password: ' padded-pass ', confirm: ' padded-pass ' });
    expect(errors.password).toBeTruthy();
  });

  it('requires the confirmation to match', () => {
    const errors = validateTeacherCredentials({ username: 'staff-2027', password: 'Sunshine-Cloud-9', confirm: 'different' });
    expect(errors.confirm).toBeTruthy();
  });

  it('reports every problem at once', () => {
    const errors = validateTeacherCredentials({ username: '', password: 'x', confirm: 'y' });
    expect(Object.keys(errors).sort()).toEqual(['confirm', 'password', 'username']);
  });
});

describe('teacherConfigSnippet', () => {
  it('produces the exact config.js lines to publish', () => {
    const snippet = teacherConfigSnippet('staff-2027', 'a'.repeat(64));
    expect(snippet).toBe(
      'export const TEACHER_USERNAME = \'staff-2027\';\n' +
      'export const TEACHER_PASSWORD_SHA256 =\n' +
      `  '${'a'.repeat(64)}';`
    );
  });

  it('never emits quotes or symbols into the generated code', () => {
    const snippet = teacherConfigSnippet("o'brien\\x", "digest'test");
    expect(snippet).not.toContain("o'brien");
    expect(snippet).not.toContain("digest'test");
  });

  it('is valid JavaScript when pasted', () => {
    const snippet = teacherConfigSnippet('staff-2027', 'f'.repeat(64));
    // `export` is module syntax; strip it so the lines run as a plain script.
    const run = new Function(`${snippet.replace(/export /g, '')}; return TEACHER_USERNAME + ':' + TEACHER_PASSWORD_SHA256.length;`);
    expect(run()).toBe(`staff-2027:64`);
  });
});
