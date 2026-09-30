import { describe, it, expect } from 'vitest';
import { previewMode, canPreview, previewDescriptor, absoluteUrl, OFFICE_VIEWER } from '../assets/js/lib/preview.js';

const pdf = {
  name: 'Schedule',
  fileName: 'schedule.pdf',
  downloadUrl: 'https://example.com/apps/schedule.pdf',
  meta: { extension: 'pdf' }
};

const htmlRemote = {
  name: 'Quiz',
  fileName: 'quiz.html',
  downloadUrl: 'https://example.com/apps/quiz.html',
  meta: { extension: 'html' }
};

const htmlLocal = {
  name: 'Draft',
  fileName: 'draft.html',
  content: '<h1>Hi</h1>',
  meta: { extension: 'html' }
};

const docx = {
  name: 'Notes',
  fileName: 'notes.docx',
  downloadUrl: 'https://example.com/apps/notes.docx',
  meta: { extension: 'docx' }
};

const zip = { name: 'Bundle', fileName: 'bundle.zip', downloadUrl: 'https://example.com/a.zip', meta: { extension: 'zip' } };

describe('absoluteUrl', () => {
  it('leaves absolute URLs alone', () => {
    expect(absoluteUrl('https://a.test/x.pdf')).toBe('https://a.test/x.pdf');
  });

  it('resolves a relative URL against the origin', () => {
    expect(absoluteUrl('apps/x.pdf', 'https://a.test/site/')).toBe('https://a.test/site/apps/x.pdf');
  });

  it('returns an empty string for nothing', () => {
    expect(absoluteUrl('')).toBe('');
  });
});

describe('previewMode', () => {
  it('uses an iframe for PDFs and HTML', () => {
    expect(previewMode(pdf)).toBe('iframe');
    expect(previewMode(htmlRemote)).toBe('iframe');
  });

  it('uses the Office viewer for Office documents', () => {
    expect(previewMode(docx)).toBe('office');
  });

  it('refuses unknown types', () => {
    expect(previewMode(zip)).toBe('none');
    expect(previewMode({})).toBe('none');
  });
});

describe('canPreview', () => {
  it('accepts previewable items that have a source', () => {
    expect(canPreview(pdf)).toBe(true);
    expect(canPreview(htmlLocal)).toBe(true);
  });

  it('rejects unsupported types', () => {
    expect(canPreview(zip)).toBe(false);
  });

  it('rejects a previewable type with no content or URL', () => {
    expect(canPreview({ fileName: 'a.pdf', meta: { extension: 'pdf' } })).toBe(false);
  });
});

describe('previewDescriptor', () => {
  it('builds a PDF descriptor with a fit-width hint', () => {
    const descriptor = previewDescriptor(pdf);
    expect(descriptor.mode).toBe('iframe');
    expect(descriptor.src).toContain('schedule.pdf#view=FitH');
    expect(descriptor.requiresPublicUrl).toBe(false);
  });

  it('renders a local HTML draft from srcdoc', () => {
    const descriptor = previewDescriptor(htmlLocal);
    expect(descriptor.srcdoc).toBe('<h1>Hi</h1>');
    expect(descriptor.src).toBeUndefined();
  });

  it('denies same-origin to untrusted mini apps', () => {
    // Mini apps are third-party code; they must not reach our localStorage.
    expect(previewDescriptor(htmlLocal).sandbox).not.toContain('allow-same-origin');
    expect(previewDescriptor(htmlRemote).sandbox).not.toContain('allow-same-origin');
  });

  it('routes Office documents through the public viewer', () => {
    const descriptor = previewDescriptor(docx);
    expect(descriptor.mode).toBe('office');
    expect(descriptor.src).toContain(OFFICE_VIEWER);
    expect(descriptor.src).toContain(encodeURIComponent(docx.downloadUrl));
    expect(descriptor.requiresPublicUrl).toBe(true);
  });

  it('refuses an Office preview without a public URL', () => {
    expect(previewDescriptor({ fileName: 'a.docx', meta: { extension: 'docx' } })).toBeNull();
  });

  it('returns null for unsupported types', () => {
    expect(previewDescriptor(zip)).toBeNull();
  });

  it('always supplies an accessible label', () => {
    for (const candidate of [pdf, htmlRemote, htmlLocal, docx]) {
      expect(previewDescriptor(candidate).label).toMatch(/Preview of/);
    }
  });
});
