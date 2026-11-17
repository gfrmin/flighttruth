import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lookupFlight } from '../src/lookupFlight.js';
import type { SourceFetcher } from '../src/types.js';

describe('lookupFlight', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'flighttruth-lookup-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const fakeSource: SourceFetcher = {
    id: 'flightaware',
    fetch: async () => ({
      source: 'flightaware',
      fetchedAt: new Date().toISOString(),
      fields: { aircraftType: { value: 'B738', paywalled: false, raw: 'B738' } },
    }),
  };

  it('fetches from sources, caches, and returns a distribution per field', async () => {
    const result = await lookupFlight(
      { type: 'number', query: 'LY91', date: '2026-07-28' },
      [fakeSource],
      { cacheDir: dir }
    );
    const aircraftType = result.distributions.find((d) => d.field === 'aircraftType');
    expect(aircraftType?.values[0].value).toBe('Boeing 737-800');
  });

  it('serves from cache on the second call without re-fetching', async () => {
    let callCount = 0;
    const countingSource: SourceFetcher = {
      id: 'flightaware',
      fetch: async () => {
        callCount += 1;
        return { source: 'flightaware', fetchedAt: new Date().toISOString(), fields: {} };
      },
    };
    const query = { type: 'number' as const, query: 'LY91', date: '2026-07-28' };
    await lookupFlight(query, [countingSource], { cacheDir: dir });
    await lookupFlight(query, [countingSource], { cacheDir: dir });
    expect(callCount).toBe(1);
  });

  it('bypasses the cache when forceRefresh is true', async () => {
    let callCount = 0;
    const countingSource: SourceFetcher = {
      id: 'flightaware',
      fetch: async () => {
        callCount += 1;
        return { source: 'flightaware', fetchedAt: new Date().toISOString(), fields: {} };
      },
    };
    const query = { type: 'number' as const, query: 'LY91', date: '2026-07-28' };
    await lookupFlight(query, [countingSource], { cacheDir: dir });
    await lookupFlight(query, [countingSource], { cacheDir: dir, forceRefresh: true });
    expect(callCount).toBe(2);
  });

  describe('codeshare identity resolution', () => {
    // Mirrors the real BA183/AA6942 case: flightstats resolves the queried marketing
    // number to the true operating number, and openSky/adsbExchange-like sources only
    // find live data under the operating number.
    const flightstatsLike: SourceFetcher = {
      id: 'flightstats',
      fetch: async () => ({
        source: 'flightstats',
        fetchedAt: new Date().toISOString(),
        fields: { airline: { value: 'British Airways', paywalled: false, raw: 'British Airways' } },
        operatingFlightNumber: 'BA183',
      }),
    };

    function makeRetryableSource(callCounts: Record<string, number>): SourceFetcher {
      return {
        id: 'openSky',
        retryOnIdentityResolution: true,
        fetch: async (query) => {
          callCounts.openSky = (callCounts.openSky ?? 0) + 1;
          if (query.query !== 'BA183') {
            return { source: 'openSky', fetchedAt: new Date().toISOString(), fields: {}, error: 'not found' };
          }
          return {
            source: 'openSky',
            fetchedAt: new Date().toISOString(),
            fields: { status: { value: 'Airborne', paywalled: false, raw: 'Airborne' } },
          };
        },
      };
    }

    function makeNonRetryableFailingSource(callCounts: Record<string, number>): SourceFetcher {
      return {
        id: 'adsbExchange',
        fetch: async () => {
          callCounts.adsbExchange = (callCounts.adsbExchange ?? 0) + 1;
          return { source: 'adsbExchange', fetchedAt: new Date().toISOString(), fields: {}, error: 'not found' };
        },
      };
    }

    it('retries an identity-sensitive source under the resolved operating number and merges the success in', async () => {
      const callCounts: Record<string, number> = {};
      const result = await lookupFlight(
        { type: 'number', query: 'AA6942', date: '2026-11-17' },
        [flightstatsLike, makeRetryableSource(callCounts)],
        { cacheDir: dir }
      );

      expect(result.resolvedOperatingFlightNumber).toBe('BA183');
      const openSkyResult = result.sourceResults.find((r) => r.source === 'openSky');
      expect(openSkyResult?.error).toBeUndefined();
      expect(openSkyResult?.fields.status?.value).toBe('Airborne');
      expect(openSkyResult?.retriedAs).toBe('BA183');
      expect(callCounts.openSky).toBe(2); // once under AA6942 (failed), once under BA183 (succeeded)
    });

    it('does not retry a source without retryOnIdentityResolution, and keeps its original error', async () => {
      const callCounts: Record<string, number> = {};
      const result = await lookupFlight(
        { type: 'number', query: 'AA6942', date: '2026-11-17' },
        [flightstatsLike, makeNonRetryableFailingSource(callCounts)],
        { cacheDir: dir }
      );

      const adsbResult = result.sourceResults.find((r) => r.source === 'adsbExchange');
      expect(adsbResult?.error).toBe('not found');
      expect(callCounts.adsbExchange).toBe(1);
    });

    it('does not retry a source that already succeeded on the first pass', async () => {
      const callCounts: Record<string, number> = { openSky: 0 };
      const alwaysSucceedsSource: SourceFetcher = {
        id: 'openSky',
        retryOnIdentityResolution: true,
        fetch: async () => {
          callCounts.openSky += 1;
          return { source: 'openSky', fetchedAt: new Date().toISOString(), fields: { status: { value: 'Airborne', paywalled: false, raw: 'Airborne' } } };
        },
      };
      await lookupFlight(
        { type: 'number', query: 'AA6942', date: '2026-11-17' },
        [flightstatsLike, alwaysSucceedsSource],
        { cacheDir: dir }
      );
      expect(callCounts.openSky).toBe(1);
    });

    it('surfaces codeshare numbers reported by sources, excluding the queried number itself', async () => {
      const flightstatsWithCodeshares: SourceFetcher = {
        id: 'flightstats',
        fetch: async () => ({
          source: 'flightstats',
          fetchedAt: new Date().toISOString(),
          fields: {},
          codeshareFlightNumbers: ['AA6942'],
        }),
      };
      const result = await lookupFlight(
        { type: 'number', query: 'BA183', date: '2026-11-17' },
        [flightstatsWithCodeshares],
        { cacheDir: dir }
      );
      expect(result.codeshareFlightNumbers).toEqual(['AA6942']);
    });

    it('skips resolution/retry entirely on a cache hit', async () => {
      const callCounts: Record<string, number> = {};
      const query = { type: 'number' as const, query: 'AA6942', date: '2026-11-17' };
      const sources = [flightstatsLike, makeRetryableSource(callCounts)];
      await lookupFlight(query, sources, { cacheDir: dir });
      expect(callCounts.openSky).toBe(2);

      await lookupFlight(query, sources, { cacheDir: dir });
      expect(callCounts.openSky).toBe(2); // unchanged -- second lookup served entirely from cache
    });
  });

  it('runs route-needing sources second, with the origin and destination the others agreed on', async () => {
    const seen: unknown[] = [];
    const schedule = (source: 'flightstats' | 'flightaware', origin: string): SourceFetcher => ({
      id: source,
      fetch: async () => ({ source, fetchedAt: new Date().toISOString(), fields: {
        origin: { value: origin, paywalled: false, raw: origin },
        destination: { value: 'LGW', paywalled: false, raw: 'LGW' },
      } }),
    });
    const board: SourceFetcher = {
      id: 'aena',
      needsRoute: true,
      fetch: async (q) => { seen.push(q.route); return { source: 'aena', fetchedAt: new Date().toISOString(), fields: { departureGate: { value: 'D32', paywalled: false, raw: 'D32' } } }; },
    };
    const result = await lookupFlight({ type: 'number', query: 'U21234', date: '2026-11-17' },
      [board, schedule('flightstats', 'LPA'), schedule('flightaware', 'LPA')], { cacheDir: dir });
    expect(seen).toEqual([{ origin: 'LPA', destination: 'LGW' }]);
    expect(result.distributions.find((d) => d.field === 'departureGate')?.values[0].value).toBe('D32');
  });
});
