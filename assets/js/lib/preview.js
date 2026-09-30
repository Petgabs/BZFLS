// ---------------------------------------------------------------------------
// Preview strategy.
//
// Decides how (and whether) a library item can be shown without downloading:
//
//   iframe  - PDFs and HTML mini apps render natively in the browser.
//   office  - Word/Excel/PowerPoint go through Microsoft's public viewer,
//             which needs a publicly reachable absolute URL.
//   none    - anything else; the card offers download only.
// ---------------------------------------------------------------------------

export const OFFICE_VIEWER = 'https://view.officeapps.live.com/op/embed.aspx';

const IFRAME_EXTENSIONS = new Set(['pdf', 'html', 'htm']);
const OFFICE_EXTENSIONS = new Set(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx']);

/** Absolute URL for a possibly relative download path. */
export function absoluteUrl(url, origin) {
  const value = String(url || '');
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  const base = origin || globalThis.location?.href || '';
  try {
    return new URL(value, base).href;
  } catch {
    return value;
  }
}

/** Which preview mode applies to this item. */
export function previewMode(item) {
  const extension = item?.meta?.extension || '';
  if (IFRAME_EXTENSIONS.has(extension)) return 'iframe';
  if (OFFICE_EXTENSIONS.has(extension)) return 'office';
  return 'none';
}

/** True when the item can be previewed at all. */
export function canPreview(item) {
  if (previewMode(item) === 'none') return false;
  // Locally-stored HTML drafts carry their content inline; everything else
  // needs a URL the browser can load.
  return Boolean(item?.downloadUrl || item?.content);
}

/**
 * Build everything the preview modal needs.
 * Returns null when the item cannot be previewed.
 */
export function previewDescriptor(item, options = {}) {
  const mode = previewMode(item);
  if (mode === 'none') return null;

  const origin = options.origin;
  const extension = item?.meta?.extension || '';

  if (mode === 'office') {
    const absolute = absoluteUrl(item?.downloadUrl, origin);
    if (!absolute || !/^https?:\/\//i.test(absolute)) return null;
    return {
      mode: 'office',
      // The Office viewer will not load a localhost/file URL; callers should
      // check `requiresPublicUrl` before offering the preview offline.
      src: `${OFFICE_VIEWER}?src=${encodeURIComponent(absolute)}`,
      sandbox: 'allow-scripts allow-same-origin allow-popups',
      requiresPublicUrl: true,
      label: `Preview of ${item?.name || item?.fileName || 'document'}`
    };
  }

  // Inline HTML drafts are rendered from a blob so nothing touches the network.
  if (extension === 'html' || extension === 'htm') {
    if (item?.content) {
      return {
        mode: 'iframe',
        srcdoc: String(item.content),
        // Mini apps are third-party code: deny same-origin so they cannot
        // reach this site's localStorage or session.
        sandbox: 'allow-scripts allow-forms allow-popups',
        requiresPublicUrl: false,
        label: `Preview of ${item?.name || item?.fileName || 'mini app'}`
      };
    }
    if (item?.downloadUrl) {
      return {
        mode: 'iframe',
        src: item.downloadUrl,
        sandbox: 'allow-scripts allow-forms allow-popups',
        requiresPublicUrl: false,
        label: `Preview of ${item?.name || item?.fileName || 'mini app'}`
      };
    }
    return null;
  }

  // PDF.
  if (!item?.downloadUrl) return null;
  return {
    mode: 'iframe',
    // #view=FitH gives a sensible default zoom in most built-in PDF viewers.
    src: `${item.downloadUrl}#view=FitH`,
    sandbox: 'allow-scripts allow-same-origin allow-popups',
    requiresPublicUrl: false,
    label: `Preview of ${item?.name || item?.fileName || 'document'}`
  };
}
