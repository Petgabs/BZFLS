import { describe, it, expect } from 'vitest';
import {
  buildIntegrityReport,
  diagnoseIntegrity,
  fixRequiresGithub,
  issueId,
  normaliseMetadataPath,
  normaliseRepoPath,
  planIntegrityRepairs,
  serialiseDiagnosis,
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

describe('repairable issues', () => {
  const orphanReport = () => buildIntegrityReport({
    apps: [{ source: 'github', githubPath: 'apps/live.pdf', fileName: 'live.pdf', name: 'Live file' }],
    metadataPaths: ['apps/ghost.pdf'],
    queueEntries: [
      { id: 'sub-broken', status: 'pending', title: 'No bytes' },
      { id: 'sub-staged', status: 'approved', title: 'Leftover', path: 'submissions/pending/leftover.pdf' }
    ]
  });

  it('gives every message a stable id and a repair plan', () => {
    const report = orphanReport();
    const ids = report.issues.map(item => item.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(orphanReport().issues.map(item => item.id));
    expect(report.issues.every(item => item.fixable && item.fix.action)).toBe(true);
    expect(issueId('metadata-missing-file', 'apps/Ghost.pdf')).toBe('metadata-missing-file::apps/ghost.pdf');
  });

  it('describes the file-level repairs it would make', () => {
    const issues = orphanReport().issues;
    const stale = issues.find(item => item.type === 'metadata-missing-file');
    const staged = issues.find(item => item.type === 'reviewed-queue-still-staged');
    const broken = issues.find(item => item.type === 'pending-queue-missing-staged-file');
    const uncurated = issues.find(item => item.type === 'file-missing-metadata');

    expect(stale.fix).toMatchObject({ action: 'remove-metadata-entry', scope: 'repository', path: 'apps/ghost.pdf' });
    expect(staged.fix).toMatchObject({ action: 'clear-queue-staged-path', scope: 'queue', id: 'sub-staged' });
    expect(broken.fix).toMatchObject({ action: 'remove-queue-entry', scope: 'queue', id: 'sub-broken' });
    expect(uncurated.fix).toMatchObject({ action: 'add-metadata-entry', path: 'apps/live.pdf' });
  });

  it('orders repairs queue-first so no record is stranded', () => {
    const { steps } = planIntegrityRepairs(orphanReport(), {
      githubConnected: true,
      localQueueIds: new Set()
    });

    expect(steps.map(step => step.type)).toEqual([
      'pending-queue-missing-staged-file',
      'reviewed-queue-still-staged',
      'metadata-missing-file',
      'file-missing-metadata'
    ]);
  });

  it('blocks repository edits until GitHub is connected, but keeps local ones', () => {
    const { steps, blocked } = planIntegrityRepairs(orphanReport(), {
      githubConnected: false,
      localQueueIds: new Set(['sub-broken'])
    });

    expect(steps.map(step => step.fix.id)).toEqual(['sub-broken']);
    expect(blocked.map(step => step.type)).toEqual([
      'reviewed-queue-still-staged',
      'metadata-missing-file',
      'file-missing-metadata'
    ]);
    expect(blocked[0].reason).toMatch(/Settings/);
  });

  it('skips repairs for messages the administrator deleted from the panel', () => {
    const report = orphanReport();
    const dismissed = report.issues.filter(item => item.type !== 'metadata-missing-file').map(item => item.id);
    const { steps } = planIntegrityRepairs(report, { githubConnected: true, dismissed });

    expect(steps).toHaveLength(1);
    expect(steps[0].type).toBe('metadata-missing-file');
  });

  it('knows which repairs need a token', () => {
    expect(fixRequiresGithub({ scope: 'repository' }, { githubConnected: false })).toBe(true);
    expect(fixRequiresGithub({ scope: 'queue', id: 'a' }, { localQueueIds: ['a'] })).toBe(false);
    expect(fixRequiresGithub({ scope: 'queue', id: 'b' }, { localQueueIds: ['a'] })).toBe(true);
    expect(fixRequiresGithub(null)).toBe(false);
  });
});

describe('troubleshooter diagnosis', () => {
  it('reports a healthy library with nothing to do', () => {
    const diagnosis = diagnoseIntegrity(buildIntegrityReport({
      apps: [{ source: 'github', githubPath: 'apps/live.pdf', fileName: 'live.pdf', name: 'Live' }],
      metadataPaths: ['apps/live.pdf'],
      queueEntries: []
    }), { githubConnected: true, metadataLoaded: true });

    expect(diagnosis.status).toBe('ok');
    expect(diagnosis.findings.map(item => item.id)).toEqual(['healthy']);
    expect(diagnosis.autoFixable).toBe(0);
    expect(diagnosis.canRepair).toBe(false);
  });

  it('names the likely cause of each kind of problem', () => {
    const diagnosis = diagnoseIntegrity(buildIntegrityReport({
      apps: [],
      metadataPaths: ['apps/ghost.pdf'],
      queueEntries: []
    }), { githubConnected: true, metadataLoaded: true });

    const stale = diagnosis.findings.find(item => item.id === 'metadata-missing-file');
    expect(stale.state).toBe('error');
    expect(stale.cause).toMatch(/deleted from apps\//);
    expect(stale.autoFixable).toBe(true);
    expect(diagnosis.autoFixable).toBe(1);
    expect(diagnosis.canRepair).toBe(true);
    expect(diagnosis.headline).toMatch(/can be fixed automatically/);
  });

  it('blames the connection before the data when the device is offline', () => {
    const diagnosis = diagnoseIntegrity(buildIntegrityReport({
      apps: [],
      metadataPaths: ['apps/ghost.pdf'],
      queueEntries: []
    }), { offline: true, usingCachedLibrary: true, githubConnected: true, metadataLoaded: true });

    expect(diagnosis.findings[0].id).toBe('offline');
    expect(diagnosis.environmentBlocked).toBe(true);
    // Repairing against a stale file list could delete good records.
    expect(diagnosis.canRepair).toBe(false);
  });

  it('explains a failed library or metadata load', () => {
    const diagnosis = diagnoseIntegrity(buildIntegrityReport({
      apps: [{ source: 'github', githubPath: 'apps/live.pdf', fileName: 'live.pdf', name: 'Live' }],
      metadataPaths: [],
      queueEntries: []
    }), { libraryError: 'GitHub rate limit reached.', metadataLoaded: false, githubConnected: true });

    const ids = diagnosis.findings.map(item => item.id);
    expect(ids).toContain('library-load');
    expect(ids).toContain('metadata-load');
    expect(diagnosis.findings.find(item => item.id === 'library-load').cause).toMatch(/rate limit/);
  });

  it('counts repairs that are waiting on a GitHub connection', () => {
    const diagnosis = diagnoseIntegrity(buildIntegrityReport({
      apps: [],
      metadataPaths: ['apps/ghost.pdf'],
      queueEntries: []
    }), { githubConnected: false, metadataLoaded: true });

    expect(diagnosis.autoFixable).toBe(0);
    expect(diagnosis.manualOnly).toBe(1);
    expect(diagnosis.headline).toMatch(/manual decision/);
  });

  it('serialises a diagnosis for a handover note', () => {
    const text = serialiseDiagnosis(diagnoseIntegrity(buildIntegrityReport({
      apps: [],
      metadataPaths: ['apps/ghost.pdf'],
      queueEntries: []
    }), { githubConnected: true, metadataLoaded: true }));

    expect(text).toMatch(/Troubleshooting:/);
    expect(text).toMatch(/Likely cause:/);
    expect(serialiseDiagnosis(null)).toMatch(/No troubleshooting run yet/);
  });
});
