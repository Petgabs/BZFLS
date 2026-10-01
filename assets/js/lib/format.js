// ---------------------------------------------------------------------------
// Small display helpers, kept pure so they can be unit tested.
// ---------------------------------------------------------------------------

/** Thousands-separated count, tolerant of junk input. */
export function formatCount(value) {
  const number = Number(value);
  return (Number.isFinite(number) ? number : 0).toLocaleString();
}

/** "1 download" / "12 downloads". */
export function downloadLabel(count) {
  const number = Number(count) || 0;
  return `${formatCount(number)} ${number === 1 ? 'download' : 'downloads'}`;
}

/** Short human date, or a clear fallback for unparseable input. */
export function formatDate(isoString) {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return 'Unknown date';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Byte size as KB/MB, used on resource cards when the size is known. */
export function formatBytes(bytes) {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size <= 0) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/** "Year 10 & 11", "Years 7–9", or '' when no year is known. */
export function formatYears(years) {
  const list = [...new Set((years || []).map(Number).filter(Number.isFinite))].sort((a, b) => a - b);
  if (!list.length) return '';
  if (list.length === 1) return `Year ${list[0]}`;

  // Collapse a fully contiguous run into a range.
  const contiguous = list.every((year, index) => index === 0 || year === list[index - 1] + 1);
  if (contiguous && list.length > 2) return `Years ${list[0]}–${list[list.length - 1]}`;

  const head = list.slice(0, -1).join(', ');
  return `Years ${head} & ${list[list.length - 1]}`;
}

/** Lucide icon name for a file extension. */
export function iconForExtension(extension) {
  const value = String(extension || '').toLowerCase();
  if (value === 'pdf') return 'file-text';
  if (value === 'html' || value === 'htm') return 'file-code';
  if (['doc', 'docx'].includes(value)) return 'file-type-2';
  if (['xls', 'xlsx'].includes(value)) return 'sheet';
  if (['ppt', 'pptx'].includes(value)) return 'presentation';
  return 'file';
}

/** Tailwind colour classes per subject, so facets read consistently. */
export function subjectAccent(subject) {
  const palette = [
    'bg-indigo-50 text-indigo-700 ring-indigo-200',
    'bg-emerald-50 text-emerald-700 ring-emerald-200',
    'bg-amber-50 text-amber-700 ring-amber-200',
    'bg-sky-50 text-sky-700 ring-sky-200',
    'bg-rose-50 text-rose-700 ring-rose-200',
    'bg-violet-50 text-violet-700 ring-violet-200',
    'bg-teal-50 text-teal-700 ring-teal-200'
  ];
  const text = String(subject || '');
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  return palette[hash % palette.length];
}

/** Human summary of an active filter set, for the results line. */
export function describeFilters({ query = '', subject = '', year = '', kind = '' } = {}) {
  const parts = [];
  if (query.trim()) parts.push(`matching “${query.trim()}”`);
  if (subject) parts.push(`in ${subject}`);
  if (year !== '' && year !== null && year !== undefined) parts.push(`for Year ${year}`);
  if (kind === 'app') parts.push('that are mini apps');
  if (kind === 'document') parts.push('that are documents');
  return parts.join(' ');
}

/** Badge classes per visibility value, used on cards and detail rows. */
export function visibilityAccent(visibility) {
  if (visibility === 'school') return 'bg-amber-50 text-amber-700 ring-amber-200';
  if (visibility === 'class') return 'bg-violet-50 text-violet-700 ring-violet-200';
  return 'bg-emerald-50 text-emerald-700 ring-emerald-200';
}

/** Status badge classes for a submission's review state. */
export function submissionStatusAccent(status) {
  if (status === 'approved') return 'bg-emerald-50 text-emerald-700 ring-emerald-200';
  if (status === 'rejected') return 'bg-rose-50 text-rose-700 ring-rose-200';
  return 'bg-amber-50 text-amber-700 ring-amber-200';
}

/** Human label for a submission status. */
export function submissionStatusLabel(status) {
  if (status === 'approved') return 'Approved — in the library';
  if (status === 'rejected') return 'Not approved';
  return 'Pending review';
}
