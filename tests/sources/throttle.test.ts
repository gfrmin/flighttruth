import { describe, it, expect, vi } from 'vitest';
import { throttled, quotaInterval } from '../../src/sources/throttle.js';
import type { FlightQuery, SourceFetcher, SourceResult } from '../../src/types.js';

const q: FlightQuery = { type: 'number', query: 'EY103', date: '2026-11-06' };

function counting(results: Partial<SourceResult>[]): SourceFetcher & { calls: () => number } {
  let n = 0;
  return {
    id: 'aerodatabox',
    calls: () => n,
    fetch: async () => ({ source: 'aerodatabox', fetchedAt: 'x', fields: {}, ...results[Math.min(n++, results.length - 1)] }),
  };
}

describe('throttled', () => {
  it('serves a successful result from memory until the interval passes', async () => {
    let now = 0;
    const inner = counting([{ fields: { status: { value: 'A', paywalled: false, raw: 'A' } } }]);
    const source = throttled(inner, () => 10_000, () => now);

    await source.fetch(q);
    now = 9_999;
    await source.fetch(q);
    expect(inner.calls()).toBe(1);
    now = 10_000;
    await source.fetch(q);
    expect(inner.calls()).toBe(2);
  });

  it('keys by query, so different flights are fetched independently', async () => {
    const inner = counting([{}]);
    const source = throttled(inner, () => 10_000, () => 0);
    await source.fetch(q);
    await source.fetch({ ...q, query: 'EY104' });
    expect(inner.calls()).toBe(2);
  });

  it('does not remember errors, so a transient failure is retried next time', async () => {
    const inner = counting([{ error: 'HTTP 500' }, {}]);
    const source = throttled(inner, () => 10_000, () => 0);
    expect((await source.fetch(q)).error).toBe('HTTP 500');
    expect((await source.fetch(q)).error).toBeUndefined();
    expect(inner.calls()).toBe(2);
  });

  it('keeps the inner source id and retry flag', () => {
    const inner = { ...counting([{}]), retryOnIdentityResolution: true };
    const source = throttled(inner, () => 1, () => 0);
    expect(source.id).toBe('aerodatabox');
    expect(source.retryOnIdentityResolution).toBe(true);
  });

  it('collapses concurrent calls for the same query into one fetch', async () => {
    const fetch = vi.fn(async () => ({ source: 'aerodatabox' as const, fetchedAt: 'x', fields: {} }));
    const source = throttled({ id: 'aerodatabox', fetch }, () => 10_000, () => 0);
    await Promise.all([source.fetch(q), source.fetch(q)]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('quotaInterval', () => {
  const at = (iso: string) => Date.parse(iso);
  const interval = quotaInterval({ nearMs: 15 * 60_000, farMs: 6 * 3600_000 });

  it('refreshes often from the day before the flight date until the day after', () => {
    expect(interval(q, at('2026-11-05T00:00:00Z'))).toBe(15 * 60_000);
    expect(interval(q, at('2026-11-07T12:00:00Z'))).toBe(15 * 60_000);
  });

  it('refreshes rarely when the flight is days away or long past', () => {
    expect(interval(q, at('2026-11-02T00:00:00Z'))).toBe(6 * 3600_000);
    expect(interval(q, at('2026-11-09T00:00:00Z'))).toBe(6 * 3600_000);
  });
});
