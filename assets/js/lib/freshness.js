// ---------------------------------------------------------------------------
// Freshness: how recently a resource joined the library.
//
// The dashboard shows a green "Latest" badge with the time a resource was
// added (first 24 hours), a "Yesterday" badge for the day after, and the plain
// date for everything older. Pure functions, so they can be unit tested.
// ---------------------------------------------------------------------------

export const DAY_MS = 24 * 60 * 60 * 1000;

export const FRESHNESS_LATEST = 'latest';
export const FRESHNESS_YESTERDAY = 'yesterday';
export const FRESHNESS_OLDER = 'older';
export const FRESHNESS_UNKNOWN = 'unknown';

/** Parse anything date-like into a Date, or null when it is unusable. */
export function toDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * The date a resource joined the library.
 * Curated metadata (library.json → addedAt / publishedAt) wins, then the
 * record's own addedAt, then createdAt.
 */
export function addedAtOf(item) {
  return (
    toDate(item?.meta?.addedAt) ||
    toDate(item?.addedAt) ||
    toDate(item?.publishedAt) ||
    toDate(item?.createdAt) ||
    null
  );
}

/** 'latest' | 'yesterday' | 'older' | 'unknown' for a given date. */
export function freshnessStatus(value, now = new Date()) {
  const date = toDate(value);
  if (!date) return FRESHNESS_UNKNOWN;
  const age = toDate(now).getTime() - date.getTime();
  // A clock skew that puts the date slightly in the future still counts as new.
  if (age < DAY_MS) return FRESHNESS_LATEST;
  if (age < 2 * DAY_MS) return FRESHNESS_YESTERDAY;
  return FRESHNESS_OLDER;
}

/** Short clock time, e.g. "9:05 AM". */
export function formatTime(value) {
  const date = toDate(value);
  if (!date) return '';
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** Short date, e.g. "1 Oct 2026". */
export function formatDay(value) {
  const date = toDate(value);
  if (!date) return '';
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** "just now" / "3 hours ago" for items added within the last day. */
export function relativeTime(value, now = new Date()) {
  const date = toDate(value);
  if (!date) return '';
  const minutes = Math.max(0, Math.round((toDate(now).getTime() - date.getTime()) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'} ago`;
}

/**
 * Everything the dashboard needs to render an "added" badge.
 *
 * @returns {{status:string, label:string, detail:string, title:string,
 *            badgeClass:string, iconName:string, rank:number, time:number}}
 */
export function freshnessBadge(item, now = new Date()) {
  const date = addedAtOf(item);
  const status = freshnessStatus(date, now);
  const time = date ? date.getTime() : 0;

  if (status === FRESHNESS_LATEST) {
    return {
      status,
      label: 'Latest',
      detail: `Added ${formatTime(date)} · ${relativeTime(date, now)}`,
      title: `Added today at ${formatTime(date)}`,
      badgeClass: 'bg-emerald-100 text-emerald-800 ring-emerald-300',
      iconName: 'sparkles',
      rank: 0,
      time
    };
  }

  if (status === FRESHNESS_YESTERDAY) {
    return {
      status,
      label: 'Yesterday',
      detail: `Added yesterday at ${formatTime(date)}`,
      title: `Added yesterday at ${formatTime(date)}`,
      badgeClass: 'bg-amber-50 text-amber-700 ring-amber-200',
      iconName: 'clock',
      rank: 1,
      time
    };
  }

  if (status === FRESHNESS_OLDER) {
    return {
      status,
      label: formatDay(date),
      detail: `Added ${formatDay(date)}`,
      title: `Added ${formatDay(date)}`,
      badgeClass: 'bg-slate-100 text-slate-600 ring-slate-200',
      iconName: 'calendar',
      rank: 2,
      time
    };
  }

  return {
    status,
    label: 'Added earlier',
    detail: 'Added before the library started tracking dates',
    title: 'Date added is not recorded for this resource',
    badgeClass: 'bg-slate-100 text-slate-500 ring-slate-200',
    iconName: 'calendar',
    rank: 3,
    time: 0
  };
}

/**
 * Comparator putting the newest resources at the top and the oldest (and
 * undated) at the bottom.
 */
export function compareByFreshness(a, b, now = new Date()) {
  const left = freshnessBadge(a, now);
  const right = freshnessBadge(b, now);
  return (
    left.rank - right.rank ||
    right.time - left.time ||
    String(a?.name || '').localeCompare(String(b?.name || ''))
  );
}

/** Newest first, oldest last. Does not mutate the input. */
export function sortByFreshness(items, now = new Date()) {
  return [...(items || [])].sort((a, b) => compareByFreshness(a, b, now));
}

/** How many items are "Latest" (added within the last 24 hours). */
export function countLatest(items, now = new Date()) {
  return (items || []).filter(item => freshnessStatus(addedAtOf(item), now) === FRESHNESS_LATEST).length;
}
