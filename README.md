# BZFLS-SchoolCloud

Public library of classroom mini apps and resources, published with GitHub Pages.

Students browse, preview and download files. Teachers publish by dropping files
into `apps/`. There is no server to run and no secret to manage.

---

## Phase 1 — strengthened public library

| Area | What changed |
| --- | --- |
| Search & metadata | Full-text search, subject / year / type facets, sortable results, shareable filter URLs |
| Previews | In-browser preview for PDFs, mini apps and Office documents; richer resource cards |
| Dependencies | Alpine, Lucide and Tailwind are bundled locally — no CDN at runtime |
| States | Skeleton loaders, explicit error + retry, offline banner, service-worker caching |
| Quality | 158 automated tests including axe-core accessibility checks |
| Counters | Pluggable backend with a managed Postgres (Supabase) adapter |

---

## Local development

```bash
npm install          # install build + test tooling
npm run build        # vendor dependencies and compile CSS
npm test             # unit, integration and accessibility tests
npm run lint:js      # node --check on every first-party script
npx serve .          # or any static server
```

`npm run watch:css` rebuilds the stylesheet while you edit.

### Committed build output

`assets/css/app.css` and `assets/vendor/*.js` are **committed on purpose**.
GitHub Pages serves this repository directly and does not run a build step, so
the compiled artefacts must be in the tree.

Re-run `npm run build` and commit the result whenever you change markup,
Tailwind config, or a pinned dependency version. Pinned versions are recorded
in `assets/vendor/versions.json`.

---

## Adding files to the library

Drop the file into `apps/`. Supported types: `.html`, `.pdf`, `.doc(x)`,
`.xls(x)`, `.ppt(x)`.

Jekyll regenerates `apps.json` on every deployment and the site reads that
manifest, so nothing else is required.

### Curating metadata

Subject, year group and tags are **inferred from the file name** — for example
`Year 10 & 11  class schedule.pdf` becomes *Administration, Years 10 & 11*.

To override the guess, add an entry to `library.json`:

```json
{
  "apps/Year 9 algebra.pdf": {
    "subject": "Mathematics",
    "years": [9],
    "tags": ["revision", "worksheet"],
    "description": "Practice questions covering linear equations."
  }
}
```

Keys are the repository path or the bare file name. Every field is optional;
anything omitted falls back to inference. A curated `description` always wins
over the placeholder generated during sync.

---

## Counters: moving to the managed database

Counts previously lived in a free, anonymous third-party counter with no
owner, no backups and no recovery path. Phase 1 adds a Supabase adapter and
keeps the old service only as a transitional fallback.

The client tries each backend in order and never lets a failure break the page:

```
supabase  ->  managed Postgres, the source of truth
abacus    ->  legacy shared counter (transitional)
local     ->  per-browser mirror in localStorage
```

### Switching over

1. Create a Supabase project (the free tier is sufficient).
2. Run [`db/schema.sql`](db/schema.sql) in the SQL editor. It creates the
   `counters` table, the atomic `increment_counter()` function, and the
   row-level-security policies.
3. Put the project URL and the **anon / publishable** key into
   `assets/js/config.js`:

   ```js
   export const COUNTER_CONFIG = {
     supabase: {
       url: 'https://YOUR-PROJECT.supabase.co',
       anonKey: 'eyJ...',
       timeoutMs: 6000
     },
     ...
   };
   ```

4. Commit and push. The dashboard reports which backend served the numbers.

Leaving `url` empty keeps the legacy behaviour, so the switch is reversible.

**On exposing the anon key:** it ships to the browser by design and is safe to
publish. Row-level security grants it `SELECT` on `counters` and `EXECUTE` on
`increment_counter()` and nothing else — it cannot set arbitrary values,
delete rows, or create keys outside `^[a-z0-9][a-z0-9-]*$`. Never put the
`service_role` key in this repository.

---

## Offline behaviour

`sw.js` caches with a strategy per resource class:

- **App shell** — stale-while-revalidate, so the site opens instantly.
- **`apps.json` / `library.json`** — network-first, cache fallback.
- **Files in `apps/`** — cache-first once fetched, so a file opened at school
  is still available at home.
- **Counter and GitHub API traffic** — never cached.

`offline.html` is shown when a navigation fails with nothing cached.

---

## Testing

```bash
npm test
```

| Suite | Covers |
| --- | --- |
| `tests/metadata.test.js` | Subject/year inference, curated overrides |
| `tests/search.test.js` | Query parsing, ranking, facets, sorting |
| `tests/counters.test.js` | All three backends and the fallback chain |
| `tests/format.test.js` | Display formatting |
| `tests/preview.test.js` | Preview strategy and iframe sandboxing |
| `tests/accessibility.test.js` | axe-core over the expanded markup |
| `tests/integration.test.js` | Real Alpine + real `index.html` in jsdom |

The accessibility suite expands `<template x-for>` blocks and resolves Alpine
bindings before running axe, so it checks the DOM users actually get rather
than the un-hydrated template. A guard test fails if that expansion ever stops
working, so the suite cannot pass vacuously.

`color-contrast` and `region` are disabled: the first needs the compiled
stylesheet loaded in a real renderer, and the second is asserted directly
instead.

---

## Security notes

- No GitHub Personal Access Token exists anywhere in this site. Uploads and
  deletions link out to github.com, where GitHub performs the authorisation.
- The admin password is stored only as a salted SHA-256 digest.
- Mini-app previews run in an iframe **without** `allow-same-origin`, so
  third-party HTML cannot reach this site's storage or admin session.
