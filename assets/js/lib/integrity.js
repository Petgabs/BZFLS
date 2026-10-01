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

/**
 * A stable identifier for one issue, so the dashboard can remember which
 * messages an administrator dismissed ("deleted") between renders — the
 * report itself is rebuilt from scratch on every keystroke.
 */
export function issueId(type, subject = '') {
  return `${String(type || 'issue')}::${normaliseRepoPath(subject) || 'general'}`;
}

function issue(type, severity, title, detail, action, subject = '', fix = null) {
  return {
    id: issueId(type, subject),
    type,
    severity,
    title,
    detail,
    action,
    subject,
    fix: fix ? { ...fix } : null,
    fixable: Boolean(fix)
  };
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
      item.path,
      {
        action: 'remove-metadata-entry',
        scope: 'repository',
        target: 'library.json',
        path: item.path,
        label: `Remove the stale library.json entry for ${item.path}`
      }
    ));
  }

  for (const item of groups.publishedQueueMissingFiles) {
    issues.push(issue(
      'queue-published-missing-file',
      'error',
      'Review queue says a file is published, but it is missing',
      `${item.title} is marked published at ${item.path}, but that file is not in apps/.`,
      'Restore the file, or clear/update the queue entry so statistics stay accurate.',
      item.title,
      {
        action: 'reset-queue-published-flag',
        scope: 'queue',
        target: 'submissions/queue.json',
        id: item.id,
        title: item.title,
        path: item.path,
        label: `Clear the published marker on “${item.title}”`
      }
    ));
  }

  for (const item of groups.pendingQueueMissingStagedPath) {
    issues.push(issue(
      'pending-queue-missing-staged-file',
      'error',
      'Pending submission has no staged file path',
      `${item.title} is pending review, but no staged upload path is recorded.`,
      'Ask the teacher to resubmit, or remove the broken queue entry.',
      item.title,
      {
        action: 'remove-queue-entry',
        scope: 'queue',
        target: 'submissions/queue.json',
        id: item.id,
        title: item.title,
        label: `Remove the unusable queue entry “${item.title}”`
      }
    ));
  }

  for (const item of groups.reviewedQueueStillHasStagedPath) {
    issues.push(issue(
      'reviewed-queue-still-staged',
      'warning',
      'Reviewed submission still has a staged upload path',
      `${item.title} is no longer pending, but still references ${item.path}.`,
      'Delete the staged file and clear the queue path after approval/rejection.',
      item.title,
      {
        action: 'clear-queue-staged-path',
        scope: 'queue',
        target: 'submissions/queue.json',
        id: item.id,
        title: item.title,
        path: item.path,
        label: `Delete ${item.path} and clear the staged path`
      }
    ));
  }

  for (const item of groups.filesMissingMetadata) {
    issues.push(issue(
      'file-missing-metadata',
      'warning',
      'Published file has no curated metadata',
      `${item.path} is live, but library.json has no curated entry for it.`,
      'Add a title, subject, year level, owner and review date to improve search and statistics.',
      item.path,
      {
        action: 'add-metadata-entry',
        scope: 'repository',
        target: 'library.json',
        path: item.path,
        fileName: item.fileName,
        title: item.title,
        label: `Create a starter library.json entry for ${item.path}`
      }
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

// ---------------------------------------------------------------------------
// Troubleshooter.
//
// The report above says *what* is inconsistent. The troubleshooter explains
// *why* it probably happened and *what can be done about it automatically*,
// so a non-technical administrator can press one button instead of reading
// five issue cards and guessing.
//
// Still pure: it takes the report plus a snapshot of the running app
// (connection, cache and sign-in state) and returns a plain description that
// the dashboard renders and the tests can lock.
// ---------------------------------------------------------------------------

/** Which fixes can be carried out without a GitHub write token. */
export function fixRequiresGithub(fix, context = {}) {
  if (!fix) return false;
  if (fix.scope === 'repository') return true;
  // Queue entries that only exist in this browser can be repaired offline.
  const localIds = context.localQueueIds instanceof Set
    ? context.localQueueIds
    : new Set(Array.isArray(context.localQueueIds) ? context.localQueueIds : []);
  return !localIds.has(fix.id);
}

const CAUSES = {
  'metadata-missing-file': {
    label: 'Stale curated metadata',
    cause: 'A file was deleted from apps/ (or renamed) without its library.json entry being removed, usually after a manual delete on github.com or an interrupted publish.',
    remedy: 'Delete the orphaned library.json entries. Nothing students can open is touched — the files are already gone.'
  },
  'queue-published-missing-file': {
    label: 'Review queue out of step with the library',
    cause: 'A submission was marked published, but the published file is no longer in apps/ — the file was removed after approval, or the publish commit failed halfway.',
    remedy: 'Clear the published marker so the submission returns to the review queue and the statistics stop counting a file that does not exist.'
  },
  'pending-queue-missing-staged-file': {
    label: 'Broken pending submission',
    cause: 'An upload was interrupted before its bytes reached submissions/, so the queue entry points at nothing. Usually a dropped connection mid-upload.',
    remedy: 'Remove the empty queue entry and ask the teacher to upload the file again.'
  },
  'reviewed-queue-still-staged': {
    label: 'Leftover staged upload',
    cause: 'A submission was approved or rejected while the connection dropped, so the temporary copy in submissions/ was never cleaned up.',
    remedy: 'Delete the staged copy and clear the path on the queue entry. The published file is unaffected.'
  },
  'file-missing-metadata': {
    label: 'Published file without curated metadata',
    cause: 'A file was added straight to apps/ on github.com instead of through the upload workflow, so library.json never received a curated entry.',
    remedy: 'Create a starter entry (title and subject inferred from the file name) that an administrator can refine later.'
  }
};

function finding(id, state, label, cause, remedy, extra = {}) {
  return { id, state, label, cause, remedy, count: 0, autoFixable: false, ...extra };
}

/**
 * Diagnose the library: environment checks first (they explain most false
 * alarms), then one finding per kind of data inconsistency.
 *
 * @param {object} report  From buildIntegrityReport().
 * @param {object} context {
 *          githubConnected, offline, usingCachedLibrary, libraryError,
 *          metadataLoaded, syncing, localQueueIds
 *        }
 */
export function diagnoseIntegrity(report = emptyIntegrityReport(), context = {}) {
  const issues = Array.isArray(report.issues) ? report.issues : [];
  const counts = report.counts || {};
  const findings = [];

  // --- Environment: the usual cause of "everything looks broken" ----------
  if (context.offline) {
    findings.push(finding(
      'offline',
      'error',
      'This device is offline',
      'The browser reports no network connection, so the library, metadata and review queue may all be read from an old cache.',
      'Reconnect to the school network, then run the troubleshooter again before repairing anything.'
    ));
  }

  if (context.libraryError) {
    findings.push(finding(
      'library-load',
      'error',
      'The library list failed to load',
      `Loading the published files failed: ${context.libraryError}`,
      'Press “Refresh Stats”/reload once the connection is back. Repairs are unsafe while the file list is incomplete.'
    ));
  }

  if (context.usingCachedLibrary) {
    findings.push(finding(
      'cached-library',
      'warning',
      'Showing a cached copy of the library',
      'The live file list was unavailable, so a cached snapshot is in use. Files published since then look "missing".',
      'Reload the page (or press Refresh Site) to pull the live list before trusting these results.'
    ));
  }

  if (context.metadataLoaded === false && Number(counts.publishedFiles) > 0) {
    findings.push(finding(
      'metadata-load',
      'warning',
      'Curated metadata did not load',
      'library.json could not be read, so every published file appears to be missing its curated entry.',
      'Reload the page. If it keeps failing, check that library.json is valid JSON on github.com.'
    ));
  }

  // --- Data inconsistencies ------------------------------------------------
  const byType = new Map();
  for (const item of issues) {
    if (!byType.has(item.type)) byType.set(item.type, []);
    byType.get(item.type).push(item);
  }

  for (const [type, items] of byType.entries()) {
    const info = CAUSES[type] || {
      label: items[0]?.title || type,
      cause: 'This combination of records is inconsistent.',
      remedy: items[0]?.action || 'Review the affected records manually.'
    };
    const fixes = items.map(item => item.fix).filter(Boolean);
    findings.push(finding(
      type,
      items.some(item => item.severity === 'error') ? 'error' : 'warning',
      info.label,
      info.cause,
      info.remedy,
      {
        count: items.length,
        autoFixable: fixes.length > 0,
        fixes,
        issueIds: items.map(item => item.id),
        subjects: items.map(item => item.subject).filter(Boolean)
      }
    ));
  }

  const plan = planIntegrityRepairs(report, context);
  const environmentBlocked = findings.some(item => item.id === 'offline' || item.id === 'library-load');

  if (!findings.length) {
    findings.push(finding(
      'healthy',
      'ok',
      'No problems detected',
      'Published files, curated metadata and the review queue all agree, and the live data loaded normally.',
      'Nothing to do. Run this again after a bulk upload or a manual change on github.com.'
    ));
  }

  const status = findings.some(item => item.state === 'error')
    ? 'error'
    : (findings.some(item => item.state === 'warning') ? 'warning' : 'ok');

  const headline = status === 'ok'
    ? 'Everything checks out'
    : (plan.steps.length
      ? `${plan.steps.length} ${plan.steps.length === 1 ? 'problem' : 'problems'} can be fixed automatically`
      : 'Problems found that need a manual decision');

  return {
    checkedAt: new Date().toISOString(),
    status,
    headline,
    findings,
    steps: plan.steps,
    blocked: plan.blocked,
    autoFixable: plan.steps.length,
    manualOnly: plan.blocked.length,
    canRepair: plan.steps.length > 0 && !environmentBlocked,
    environmentBlocked
  };
}

/**
 * Turn the report into an ordered list of repair steps.
 *
 * Order matters: queue clean-ups run before metadata changes so a repair that
 * removes a metadata entry cannot strand a queue record mid-way.
 *
 * Returns { steps, blocked } where `blocked` holds the fixes that cannot run
 * in the current context (for example, a repository edit without a token).
 */
export function planIntegrityRepairs(report = emptyIntegrityReport(), context = {}) {
  const order = [
    'pending-queue-missing-staged-file',
    'reviewed-queue-still-staged',
    'queue-published-missing-file',
    'metadata-missing-file',
    'file-missing-metadata'
  ];

  const issues = (Array.isArray(report.issues) ? report.issues : []).filter(item => item.fix);
  const dismissed = new Set(Array.isArray(context.dismissed) ? context.dismissed : []);
  const sorted = [...issues].sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));

  const steps = [];
  const blocked = [];

  for (const item of sorted) {
    if (dismissed.has(item.id)) continue;
    const needsGithub = fixRequiresGithub(item.fix, context);
    const step = {
      issueId: item.id,
      type: item.type,
      severity: item.severity,
      label: item.fix.label,
      action: item.fix.action,
      scope: item.fix.scope,
      target: item.fix.target,
      requiresGithub: needsGithub,
      fix: item.fix
    };
    if (needsGithub && !context.githubConnected) {
      blocked.push({
        ...step,
        reason: 'Connect GitHub Auto-Publish in Settings so the repository can be edited from here.'
      });
      continue;
    }
    steps.push(step);
  }

  return { steps, blocked };
}

/** Human-readable troubleshooting summary, for copying into a handover note. */
export function serialiseDiagnosis(diagnosis) {
  if (!diagnosis) return 'No troubleshooting run yet.\n';
  const lines = [
    `Troubleshooting: ${diagnosis.headline}`,
    `Checked at: ${diagnosis.checkedAt}`,
    `Automatic fixes available: ${diagnosis.autoFixable}`,
    `Needs a manual step: ${diagnosis.manualOnly}`,
    '',
    'Findings:'
  ];
  for (const item of diagnosis.findings || []) {
    lines.push(`- [${String(item.state).toUpperCase()}] ${item.label}${item.count ? ` (${item.count})` : ''}`);
    lines.push(`  Likely cause: ${item.cause}`);
    lines.push(`  Fix: ${item.remedy}`);
  }
  return `${lines.join('\n')}\n`;
}
