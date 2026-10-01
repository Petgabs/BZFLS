// ---------------------------------------------------------------------------
// Library integrity checks.
//
// The public library is assembled from three files/areas that can drift apart
// when a resource is deleted manually or a publish operation is interrupted:
//
//   apps/                  the files students can actually open
//   library.json           curated metadata for those files
//   submissions/queue.json review/publishing status for teacher uploads
//
// This module is deliberately pure. The dashboard can run it on every render,
// and tests can lock the safety rules without a browser or network.
// ---------------------------------------------------------------------------

/** Normalise a repository path for comparison. */
export function normaliseRepoPath(value) {
  return String(value || '')
    .trim()
    .replace(/^\/+/, '')
    .replace(/\\+/g, '/')
    .replace(/\/+/g, '/')
    .toLowerCase();
}

/** Metadata keys may be either `apps/file.pdf` or just `file.pdf`. */
export function normaliseMetadataPath(value) {
  const path = normaliseRepoPath(value);
  if (!path || path.startsWith('_')) return '';
  return path.includes('/') ? path : `apps/${path}`;
}

/** Best-effort public path for a resource record. */
export function pathForResource(resource) {
  const direct = normaliseRepoPath(resource?.githubPath || resource?.path);
  if (direct) return direct;
  const fileName = String(resource?.fileName || resource?.name || '').trim();
  return fileName ? normaliseMetadataPath(fileName) : '';
}

function displayPath(value) {
  return String(value || '').trim().replace(/^\/+/, '');
}

function issue(type, severity, title, detail, action, subject = '') {
  return { type, severity, title, detail, action, subject };
}

/** Empty report shape, useful for tests and initial UI states. */
export function emptyIntegrityReport() {
  return {
    status: 'ok',
    statusLabel: 'Healthy',
    checkedAt: new Date().toISOString(),
    counts: {
      publishedFiles: 0,
      metadataEntries: 0,
      queueEntries: 0,
      errors: 0,
      warnings: 0,
      issues: 0
    },
    groups: {
      filesMissingMetadata: [],
      metadataMissingFiles: [],
      publishedQueueMissingFiles: [],
      pendingQueueMissingStagedPath: [],
      reviewedQueueStillHasStagedPath: []
    },
    issues: []
  };
}

/**
 * Build a dashboard-friendly integrity report.
 *
 * @param {object} input {
 *   apps: published resource records from the live library,
 *   metadataPaths: keys from library.json after `_comment` is excluded,
 *   queueEntries: submissions/review queue records
 * }
 */
export function buildIntegrityReport(input = {}) {
  const apps = Array.isArray(input.apps) ? input.apps : [];
  const metadataPaths = Array.isArray(input.metadataPaths) ? input.metadataPaths : [];
  const queueEntries = Array.isArray(input.queueEntries) ? input.queueEntries : [];

  const appPaths = new Map();
  for (const app of apps) {
    const path = pathForResource(app);
    if (path) appPaths.set(path, app);
  }

  const metadataSet = new Set();
  const metadataDisplay = new Map();
  for (const rawPath of metadataPaths) {
    const path = normaliseMetadataPath(rawPath);
    if (!path) continue;
    metadataSet.add(path);
    metadataDisplay.set(path, displayPath(rawPath).includes('/') ? displayPath(rawPath) : `apps/${displayPath(rawPath)}`);
  }

  const groups = {
    filesMissingMetadata: [],
    metadataMissingFiles: [],
    publishedQueueMissingFiles: [],
    pendingQueueMissingStagedPath: [],
    reviewedQueueStillHasStagedPath: []
  };

  for (const [path, app] of appPaths.entries()) {
    if (!metadataSet.has(path)) {
      groups.filesMissingMetadata.push({
        path: displayPath(app.githubPath || `apps/${app.fileName || app.name || path}`),
        title: app.name || app.fileName || path,
        fileName: app.fileName || ''
      });
    }
  }

  for (const path of metadataSet) {
    if (!appPaths.has(path)) {
      groups.metadataMissingFiles.push({ path: metadataDisplay.get(path) || path });
    }
  }

  for (const entry of queueEntries) {
    if (!entry || typeof entry !== 'object') continue;
    const status = String(entry.status || '').toLowerCase();
    const title = entry.title || entry.fileName || entry.id || 'Untitled submission';
    const publishedPath = normaliseMetadataPath(entry.publishedPath || '');
    const stagedPath = normaliseRepoPath(entry.path || entry.cloudPath || '');
    const published = Boolean(entry.published || publishedPath);

    if (status === 'pending' && !stagedPath) {
      groups.pendingQueueMissingStagedPath.push({
        id: entry.id || '',
        title,
        fileName: entry.fileName || ''
      });
    }

    if (status !== 'pending' && stagedPath) {
      groups.reviewedQueueStillHasStagedPath.push({
        id: entry.id || '',
        title,
        path: displayPath(entry.path || entry.cloudPath)
      });
    }

    if ((status === 'approved' || published) && publishedPath && !appPaths.has(publishedPath)) {
      groups.publishedQueueMissingFiles.push({
        id: entry.id || '',
        title,
        path: displayPath(entry.publishedPath),
        status: status || 'approved'
      });
    }
  }

  groups.filesMissingMetadata.sort((a, b) => a.path.localeCompare(b.path));
  groups.metadataMissingFiles.sort((a, b) => a.path.localeCompare(b.path));
  groups.publishedQueueMissingFiles.sort((a, b) => a.path.localeCompare(b.path));
  groups.pendingQueueMissingStagedPath.sort((a, b) => a.title.localeCompare(b.title));
  groups.reviewedQueueStillHasStagedPath.sort((a, b) => a.path.localeCompare(b.path));

  const issues = [];

  for (const item of groups.metadataMissingFiles) {
    issues.push(issue(
      'metadata-missing-file',
      'error',
      'Metadata points to a missing file',
      `${item.path} exists in library.json, but no matching file is published in apps/.`,
      'Remove the metadata entry or restore the file to apps/.',
      item.path
    ));
  }

  for (const item of groups.publishedQueueMissingFiles) {
    issues.push(issue(
      'queue-published-missing-file',
      'error',
      'Review queue says a file is published, but it is missing',
      `${item.title} is marked published at ${item.path}, but that file is not in apps/.`,
      'Restore the file, or clear/update the queue entry so statistics stay accurate.',
      item.title
    ));
  }

  for (const item of groups.pendingQueueMissingStagedPath) {
    issues.push(issue(
      'pending-queue-missing-staged-file',
      'error',
      'Pending submission has no staged file path',
      `${item.title} is pending review, but no staged upload path is recorded.`,
      'Ask the teacher to resubmit, or remove the broken queue entry.',
      item.title
    ));
  }

  for (const item of groups.reviewedQueueStillHasStagedPath) {
    issues.push(issue(
      'reviewed-queue-still-staged',
      'warning',
      'Reviewed submission still has a staged upload path',
      `${item.title} is no longer pending, but still references ${item.path}.`,
      'Delete the staged file and clear the queue path after approval/rejection.',
      item.title
    ));
  }

  for (const item of groups.filesMissingMetadata) {
    issues.push(issue(
      'file-missing-metadata',
      'warning',
      'Published file has no curated metadata',
      `${item.path} is live, but library.json has no curated entry for it.`,
      'Add a title, subject, year level, owner and review date to improve search and statistics.',
      item.path
    ));
  }

  const errors = issues.filter(item => item.severity === 'error').length;
  const warnings = issues.filter(item => item.severity === 'warning').length;
  const status = errors ? 'error' : (warnings ? 'warning' : 'ok');
  const statusLabel = status === 'error'
    ? 'Needs repair'
    : (status === 'warning' ? 'Needs review' : 'Healthy');

  return {
    status,
    statusLabel,
    checkedAt: new Date().toISOString(),
    counts: {
      publishedFiles: appPaths.size,
      metadataEntries: metadataSet.size,
      queueEntries: queueEntries.filter(Boolean).length,
      errors,
      warnings,
      issues: issues.length
    },
    groups,
    issues
  };
}

/** Human-readable report for copying into an issue, email, or audit record. */
export function serialiseIntegrityReport(report = emptyIntegrityReport()) {
  const lines = [
    `Library integrity: ${report.statusLabel || 'Unknown'}`,
    `Published files: ${report.counts?.publishedFiles || 0}`,
    `Metadata entries: ${report.counts?.metadataEntries || 0}`,
    `Review queue entries: ${report.counts?.queueEntries || 0}`,
    `Errors: ${report.counts?.errors || 0}`,
    `Warnings: ${report.counts?.warnings || 0}`
  ];

  if (report.issues?.length) {
    lines.push('', 'Issues:');
    for (const item of report.issues) {
      lines.push(`- [${String(item.severity || '').toUpperCase()}] ${item.title}: ${item.detail} Action: ${item.action}`);
    }
  } else {
    lines.push('', 'No integrity issues found.');
  }

  return `${lines.join('\n')}\n`;
}
