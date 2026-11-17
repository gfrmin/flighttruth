import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { searchRoutes } from '../src/routeSearch.js';

describe('searchRoutes', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'flighttruth-route-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const query = { origin: 'LHR', destination: 'JFK', date: '2026-11-17' };

  it('fetches candidates, caches, and returns them', async () => {
    let callCount = 0;
    const result = await searchRoutes(query, {
      cacheDir: dir,
      search: async () => {
        callCount += 1;
        return { candidates: [{ flightNumber: 'BA183', airline: 'British Airways', scheduledDeparture: null, scheduledArrival: null }] };
      },
    });
    expect(result.candidates[0].flightNumber).toBe('BA183');
    expect(callCount).toBe(1);
  });

  it('serves from cache on the second call without re-searching', async () => {
    let callCount = 0;
    const search = async () => {
      callCount += 1;
      return { candidates: [] };
    };
    await searchRoutes(query, { cacheDir: dir, search });
    await searchRoutes(query, { cacheDir: dir, search });
    expect(callCount).toBe(1);
  });

  it('bypasses the cache when forceRefresh is true', async () => {
    let callCount = 0;
    const search = async () => {
      callCount += 1;
      return { candidates: [] };
    };
    await searchRoutes(query, { cacheDir: dir, search });
    await searchRoutes(query, { cacheDir: dir, search, forceRefresh: true });
    expect(callCount).toBe(2);
  });

  it('returns an error result (not a cached one) when the search throws', async () => {
    const result = await searchRoutes(query, {
      cacheDir: dir,
      search: async () => {
        throw new Error('boom');
      },
    });
    expect(result.error).toBe('boom');
    expect(result.candidates).toEqual([]);
  });
});
