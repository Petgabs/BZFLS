// ---------------------------------------------------------------------------
// Accessibility checks.
//
// index.html is rendered by Alpine at runtime, so a static jsdom parse only
// ever sees the initial markup. To check the states that matter we strip the
// Alpine directives that hide things (x-show / x-cloak) and expand the
// <template x-for> blocks with one sample row, then run axe-core over the
// result. That covers the header, search controls, cards, tables and modals
// in the shape a real user meets them.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import axe from 'axe-core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Rules that cannot be judged from a static, un-hydrated snapshot. */
const DISABLED_RULES = {
  // Contrast needs real CSS; the compiled Tailwind file is not loaded here.
  'color-contrast': { enabled: false },
  // Alpine moves content into place at runtime; landmark structure is
  // asserted explicitly below instead.
  'region': { enabled: false }
};

let dom;
let document;

beforeAll(async () => {
  const html = await readFile(resolve(root, 'index.html'), 'utf8');

  dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  document = dom.window.document;

  // Reveal everything Alpine would hide, so axe can see each state.
  for (const element of document.querySelectorAll('[x-cloak]')) {
    element.removeAttribute('x-cloak');
  }

  // Expand `<template x-for>` with a single representative instance.
  for (const template of [...document.querySelectorAll('template[x-for]')]) {
    template.parentNode.insertBefore(template.content.cloneNode(true), template);
  }

  // `<template x-if>` blocks are empty states; surface them too.
  for (const template of [...document.querySelectorAll('template[x-if]')]) {
    template.parentNode.insertBefore(template.content.cloneNode(true), template);
  }

  // Resolve the Alpine bindings that affect the accessibility tree, using
  // values of the right *shape* so axe judges the runtime DOM, not the
  // template. Anything left unresolved would produce false positives.
  const ARIA_SAMPLES = {
    'aria-pressed': 'false',
    'aria-expanded': 'false',
    'aria-selected': 'false',
    'aria-checked': 'false',
    'aria-disabled': 'false',
    'aria-hidden': 'true',
    'aria-current': 'false',
    'aria-invalid': 'false'
  };

  for (const node of document.querySelectorAll('*')) {
    for (const attribute of [...node.attributes]) {
      const match = attribute.name.match(/^(?::|x-bind:)(.+)$/);
      if (!match) continue;
      const target = match[1];

      if (target.startsWith('aria-')) {
        node.setAttribute(target, ARIA_SAMPLES[target] ?? 'Sample item');
      } else if (target === 'href') {
        node.setAttribute('href', 'https://example.test/sample');
      } else if (target === 'title') {
        node.setAttribute('title', 'Sample title');
      } else if (target === 'data-lucide') {
        node.setAttribute('data-lucide', 'file');
      } else if (target === 'src' || target === 'srcdoc' || target === 'sandbox') {
        // Leave the iframe source unset; only its name matters here.
        continue;
      }
      node.removeAttribute(attribute.name);
    }

    // x-text injects the element's content at runtime.
    if (node.hasAttribute('x-text') && !node.textContent.trim()) {
      node.textContent = 'Sample';
    }
  }

  // Lucide swaps <i data-lucide> for an <svg>; emulate that so axe does not
  // see empty inline elements where an icon belongs.
  for (const placeholder of document.querySelectorAll('[data-lucide]')) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    placeholder.replaceWith(svg);
  }
});

async function runAxe(context) {
  const { window } = dom;
  window.eval(axe.source);
  return window.axe.run(context || window.document, {
    rules: DISABLED_RULES,
    resultTypes: ['violations']
  });
}

describe('index.html accessibility', () => {
  // Guard: if the harness stopped expanding templates or resolving bindings,
  // axe would scan a nearly empty page and pass for the wrong reason.
  it('scans a fully expanded page', () => {
    expect(document.querySelectorAll('button').length).toBeGreaterThan(20);
    expect(document.querySelectorAll('table').length).toBe(3);
    expect(document.querySelectorAll('[role="dialog"]').length).toBe(2);
    expect(document.querySelector('iframe')).not.toBeNull();
    // No unresolved Alpine binding may remain on the accessibility tree.
    expect(document.querySelectorAll('[\\:aria-label], [\\:aria-pressed], [\\:title]').length).toBe(0);
  });

  it('has no axe-core violations', async () => {
    const results = await runAxe();

    // Print a readable report before failing, so CI output is actionable.
    if (results.violations.length) {
      const report = results.violations.map(violation =>
        `\n[${violation.impact}] ${violation.id}: ${violation.help}\n` +
        violation.nodes.slice(0, 3).map(node => `    ${node.html.slice(0, 160)}`).join('\n')
      ).join('\n');
      console.error(report);
    }

    expect(results.violations.map(violation => violation.id)).toEqual([]);
  });

  it('declares a page language', () => {
    expect(document.documentElement.getAttribute('lang')).toBe('en');
  });

  it('has exactly one h1', () => {
    expect(document.querySelectorAll('h1')).toHaveLength(1);
  });

  it('provides a skip link to the main content', () => {
    const skip = document.querySelector('a[href="#main-content"]');
    expect(skip).not.toBeNull();
    expect(document.getElementById('main-content')).not.toBeNull();
  });

  it('gives every form control an accessible name', () => {
    const controls = document.querySelectorAll('input:not([type="hidden"]), select, textarea');
    expect(controls.length).toBeGreaterThan(0);

    for (const control of controls) {
      const id = control.getAttribute('id');
      const named = Boolean(
        (id && document.querySelector(`label[for="${id}"]`)) ||
        control.getAttribute('aria-label') ||
        control.getAttribute('aria-labelledby') ||
        control.closest('label')
      );
      expect(named, `control missing a label: ${control.outerHTML.slice(0, 120)}`).toBe(true);
    }
  });

  it('marks decorative icons as hidden from assistive technology', () => {
    // Every icon placeholder became an aria-hidden <svg> in the setup above.
    for (const svg of document.querySelectorAll('svg')) {
      const hidden = svg.getAttribute('aria-hidden') === 'true';
      const labelled = svg.getAttribute('aria-label') || svg.querySelector('title');
      expect(hidden || Boolean(labelled)).toBe(true);
    }
  });

  it('gives icon-only buttons an accessible name', () => {
    for (const button of document.querySelectorAll('button')) {
      const text = button.textContent.replace(/\s+/g, ' ').trim();
      const named = Boolean(text || button.getAttribute('aria-label') || button.getAttribute('aria-labelledby'));
      expect(named, `button missing a name: ${button.outerHTML.slice(0, 120)}`).toBe(true);
    }
  });

  it('gives every button an explicit type so none submits a form by accident', () => {
    for (const button of document.querySelectorAll('button')) {
      expect(['button', 'submit'].includes(button.getAttribute('type'))).toBe(true);
    }
  });

  it('marks both modals as dialogs', () => {
    const dialogs = document.querySelectorAll('[role="dialog"]');
    expect(dialogs.length).toBe(2);
    for (const dialog of dialogs) {
      expect(dialog.getAttribute('aria-modal')).toBe('true');
      expect(dialog.getAttribute('aria-labelledby')).toBeTruthy();
      // The element the dialog points at must exist.
      expect(document.getElementById(dialog.getAttribute('aria-labelledby'))).not.toBeNull();
    }
  });

  it('titles the preview iframe', () => {
    for (const frame of document.querySelectorAll('iframe')) {
      const titled = frame.getAttribute('title') || frame.getAttribute(':title');
      expect(titled).toBeTruthy();
    }
  });

  it('announces search results politely', () => {
    const live = document.querySelector('#search-results-count');
    expect(live).not.toBeNull();
    expect(live.getAttribute('aria-live')).toBe('polite');
  });

  it('associates the search box with its result count', () => {
    const search = document.getElementById('library-search');
    expect(search.getAttribute('aria-describedby')).toBe('search-results-count');
  });

  it('uses scoped headers in every data table', () => {
    const tables = document.querySelectorAll('table');
    expect(tables.length).toBeGreaterThan(0);
    for (const table of tables) {
      expect(table.querySelector('caption')).not.toBeNull();
      for (const header of table.querySelectorAll('th')) {
        expect(header.getAttribute('scope')).toBeTruthy();
      }
    }
  });

  it('opens external links safely', () => {
    for (const link of document.querySelectorAll('a[target="_blank"]')) {
      expect(link.getAttribute('rel')).toContain('noopener');
    }
  });

  it('sandboxes the preview frame without granting same-origin to mini apps', () => {
    const frame = document.querySelector('iframe');
    // The sandbox attribute is bound by Alpine; the descriptor tests assert
    // the per-type values. Here we only confirm the binding is present.
    expect(frame.hasAttribute(':sandbox') || frame.hasAttribute('sandbox')).toBe(true);
  });
});
