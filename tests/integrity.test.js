import { describe, it, expect } from 'vitest';
import {
  buildIntegrityReport,
  normaliseMetadataPath,
  normaliseRepoPath,
  serialiseIntegrityReport
} from '../assets/js/lib/integrity.js';

describe('library integrity report', () => {
  it('normalises repository and metadata paths consistently', () => {
    expect(normaliseRepoPath('/Apps/My File.pdf')).toBe('apps/my file.pdf');
    expect(normaliseMetadataPath('My File.pdf')).toBe('apps/my file.pdf');
    expect(normaliseMetadataPath('apps/My File.pdf')).toBe('apps/my file.pdf');
  });

  it('passes when files, metadata and queue records line up', () => {
    const report = buildIntegrityReport({
      apps: [{ source: 'github', githubPath: 'apps/worksheet.pdf', fileName: 'worksheet.pdf', name: 'Worksheet' }],
      metadataPaths: ['apps/worksheet.pdf'],
      queueEntries: [{ status: 'approved', published: true, publishedPath: 'apps/worksheet.pdf', title: 'Worksheet' }]
    });

    expect(report.status).toBe('ok');
    expect(report.counts.errors).toBe(0);
    expect(report.counts.warnings).toBe(0);
    expect(report.issues).toEqual([]);
  });

  it('flags stale metadata and stale published queue records as errors', () => {
    const report = buildIntegrityReport({
      apps: [{ source: 'github', githubPath: 'apps/live.pdf', fileName: 'live.pdf', name: 'Live file' }],
      metadataPaths: ['apps/live.pdf', 'apps/missing.pdf'],
      queueEntries: [
        { status: 'approved', published: true, publishedPath: 'apps/missing.pdf', title: 'Missing file' }
      ]
    });

    expect(report.status).toBe('error');
    expect(report.groups.metadataMissingFiles.map(item => item.path)).toEqual(['apps/missing.pdf']);
    expect(report.groups.publishedQueueMissingFiles.map(item => item.path)).toEqual(['apps/missing.pdf']);
    expect(report.counts.errors).toBe(2);
  });

  it('flags live files without curated metadata as warnings', () => {
    const report = buildIntegrityReport({
      apps: [{ source: 'github', githubPath: 'apps/new.xlsx', fileName: 'new.xlsx', name: 'New Sheet' }],
      metadataPaths: [],
      queueEntries: []
    });

    expect(report.status).toBe('warning');
    expect(report.groups.filesMissingMetadata).toHaveLength(1);
    expect(report.counts.warnings).toBe(1);
  });

  it('flags pending queue entries without staged bytes', () => {
    const report = buildIntegrityReport({
      apps: [],
      metadataPaths: [],
      queueEntries: [{ id: 'sub-1', status: 'pending', title: 'No bytes' }]
    });

    expect(report.status).toBe('error');
    expect(report.groups.pendingQueueMissingStagedPath).toHaveLength(1);
  });

  it('serialises a human-readable report', () => {
    const report = buildIntegrityReport({
      apps: [{ source: 'github', githubPath: 'apps/new.xlsx', fileName: 'new.xlsx', name: 'New Sheet' }]
    });
    const text = serialiseIntegrityReport(report);

    expect(text).toContain('Library integrity: Needs review');
    expect(text).toContain('Published files: 1');
    expect(text).toContain('Published file has no curated metadata');
  });
});
