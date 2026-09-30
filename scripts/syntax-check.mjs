// ---------------------------------------------------------------------------
// Parse every first-party JS file with `node --check` and fail on any syntax
// error. Because package.json sets "type": "module", Node parses .js files as
// ES modules, so import/export are validated correctly.
//
// Vendored third-party bundles are skipped: they are minified UMD builds we do
// not author, and some are not valid ESM.
// ---------------------------------------------------------------------------

import { readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, dirname, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const ROOTS = ['assets/js', 'scripts', 'tests'];
// Root-level scripts that are not inside a scanned directory.
const EXTRA_FILES = ['sw.js'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'vendor']);

async function walk(dir, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (['.js', '.mjs'].includes(extname(entry.name))) out.push(full);
  }
  return out;
}

const scanned = (await Promise.all(ROOTS.map(dir => walk(resolve(root, dir))))).flat();
const files = [...scanned, ...EXTRA_FILES.map(name => resolve(root, name))].sort();

if (!files.length) {
  console.error('No JavaScript files found to check.');
  process.exit(1);
}

let failed = 0;
for (const file of files) {
  const label = relative(root, file);
  try {
    await run(process.execPath, ['--check', file]);
    console.log(`  ok    ${label}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL  ${label}\n${error.stderr || error.message}`);
  }
}

console.log(`\nChecked ${files.length} file${files.length === 1 ? '' : 's'}, ${failed} failure${failed === 1 ? '' : 's'}.`);
process.exit(failed ? 1 : 0);
