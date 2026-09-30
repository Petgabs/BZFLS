// ---------------------------------------------------------------------------
// Copy frontend dependencies out of node_modules and into assets/vendor/.
//
// The site previously loaded Alpine, Lucide and Tailwind from public CDNs.
// That made every page view depend on three third-party hosts, broke the
// site completely on a school network that blocks them, and pinned Alpine to
// a floating "3.x.x" tag. Vendoring the files gives us pinned, reviewable,
// same-origin assets that also work offline via the service worker.
// ---------------------------------------------------------------------------

import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vendorDir = resolve(root, 'assets/vendor');

const ASSETS = [
  { from: 'node_modules/alpinejs/dist/cdn.min.js', to: 'alpine.min.js', pkg: 'alpinejs' },
  { from: 'node_modules/lucide/dist/umd/lucide.min.js', to: 'lucide.min.js', pkg: 'lucide' }
];

async function versionOf(pkg) {
  try {
    const manifest = JSON.parse(await readFile(resolve(root, 'node_modules', pkg, 'package.json'), 'utf8'));
    return manifest.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

async function main() {
  await mkdir(vendorDir, { recursive: true });

  const versions = {};
  for (const asset of ASSETS) {
    const source = resolve(root, asset.from);
    if (!existsSync(source)) {
      throw new Error(`Missing dependency: ${asset.from}. Run "npm install" first.`);
    }
    await copyFile(source, resolve(vendorDir, asset.to));
    versions[asset.pkg] = await versionOf(asset.pkg);
    console.log(`vendored  ${asset.to}  (${asset.pkg}@${versions[asset.pkg]})`);
  }

  versions.tailwindcss = await versionOf('tailwindcss');

  // A manifest makes the pinned versions visible in review and in the repo.
  await writeFile(
    resolve(vendorDir, 'versions.json'),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), versions }, null, 2)}\n`,
    'utf8'
  );
  console.log(`vendored  versions.json  (tailwindcss@${versions.tailwindcss})`);
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
