import { describe, it, expect } from 'vitest';
import {
  addedAtOf,
  freshnessStatus,
  freshnessBadge,
  sortByFreshness,
  countLatest,
  relativeTime
} from '../assets/js/lib/freshness.js';

const NOW = new Date('2026-10-01T12:00:00Z');
const hoursAgo = h => new Date(NOW.getTime() - h * 3600 * 1000).toISOString();

describe('addedAtOf', () => {
  it('prefers curated metadata over the record date', () => {
    const item = { meta: { addedAt: '2026-09-01T00:00:00Z' }, createdAt: '2026-09-30T00:00:00Z' };
    expect(addedAtOf(item).toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  it('falls back to createdAt and tolerates junk', () => {
    expect(addedAtOf({ createdAt: '2026-09-30T00:00:00Z' })).toBeInstanceOf(Date);
    expect(addedAtOf({ createdAt: 'not a date' })).toBeNull();
    expect(addedAtOf(null)).toBeNull();
  });
});

describe('freshnessStatus', () => {
  it('marks anything added in the last 24 hours as latest', () => {
    expect(freshnessStatus(hoursAgo(1), NOW)).toBe('latest');
    expect(freshnessStatus(hoursAgo(23), NOW)).toBe('latest');
  });

  it('marks the following day as yesterday, then older', () => {
    expect(freshnessStatus(hoursAgo(25), NOW)).toBe('yesterday');
    expect(freshnessStatus(hoursAgo(47), NOW)).toBe('yesterday');
    expect(freshnessStatus(hoursAgo(72), NOW)).toBe('older');
  });

  it('reports unknown when there is no date', () => {
    expect(freshnessStatus('', NOW)).toBe('unknown');
  });
});

describe('freshnessBadge', () => {
  it('uses a green badge and the time added for new resources', () => {
    const badge = freshnessBadge({ createdAt: hoursAgo(2) }, NOW);
    expect(badge.label).toBe('Latest');
    expect(badge.badgeClass).toContain('emerald');
    expect(badge.detail).toContain('Added');
  });

  it('labels the previous day as Yesterday', () => {
    expect(freshnessBadge({ createdAt: hoursAgo(30) }, NOW).label).toBe('Yesterday');
  });

  it('shows the date for older resources', () => {
    const badge = freshnessBadge({ createdAt: '2026-01-05T09:00:00Z' }, NOW);
    expect(badge.status).toBe('older');
    expect(badge.label).toMatch(/2026/);
  });
});

describe('sortByFreshness', () => {
  it('puts the latest at the top and undated items at the bottom', () => {
    const items = [
      { name: 'old', createdAt: '2026-05-01T00:00:00Z' },
      { name: 'unknown' },
      { name: 'latest', createdAt: hoursAgo(1) },
      { name: 'yesterday', createdAt: hoursAgo(30) }
    ];
    expect(sortByFreshness(items, NOW).map(i => i.name)).toEqual(['latest', 'yesterday', 'old', 'unknown']);
  });

  it('does not mutate the input', () => {
    const items = [{ name: 'a', createdAt: hoursAgo(50) }, { name: 'b', createdAt: hoursAgo(1) }];
    sortByFreshness(items, NOW);
    expect(items[0].name).toBe('a');
  });
});

describe('countLatest / relativeTime', () => {
  it('counts only items added within a day', () => {
    const items = [{ createdAt: hoursAgo(1) }, { createdAt: hoursAgo(5) }, { createdAt: hoursAgo(40) }, {}];
    expect(countLatest(items, NOW)).toBe(2);
  });

  it('describes recency in words', () => {
    expect(relativeTime(hoursAgo(0), NOW)).toBe('just now');
    expect(relativeTime(hoursAgo(3), NOW)).toBe('3 hours ago');
  });
});
