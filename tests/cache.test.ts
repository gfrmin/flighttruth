import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cacheKey, readCache, writeCache, routeCacheKey } from '../src/cache.js';

describe('cache', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flighttruth-cache-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('builds a stable key from a flight query', () => {
    expect(cacheKey({ type: 'number', query: 'ly91', date: '2026-07-28' })).toBe('number-LY91-2026-07-28');
  });

  it('returns null when nothing is cached', () => {
    expect(readCache(dir, 'number-LY91-2026-07-28', 60_000)).toBeNull();
  });

  it('returns a written entry when still within TTL', () => {
    const entry = { fetchedAt: new Date().toISOString(), results: [] };
    writeCache(dir, 'number-LY91-2026-07-28', entry);
    expect(readCache(dir, 'number-LY91-2026-07-28', 60_000)).toEqual(entry);
  });

  it('returns null once the entry is older than the TTL', () => {
    const entry = { fetchedAt: new Date(Date.now() - 120_000).toISOString(), results: [] };
    writeCache(dir, 'number-LY91-2026-07-28', entry);
    expect(readCache(dir, 'number-LY91-2026-07-28', 60_000)).toBeNull();
  });

  it('builds a stable route cache key, distinct from the flight-lookup key prefixes', () => {
    expect(routeCacheKey({ origin: 'lhr', destination: 'jfk', date: '2026-11-17' })).toBe(
      'route-LHR-JFK-2026-11-17'
    );
  });

  it('reads and writes a differently-shaped entry via the generic type parameter', () => {
    const entry = { fetchedAt: new Date().toISOString(), candidates: [{ flightNumber: 'BA183' }] };
    writeCache(dir, 'route-LHR-JFK-2026-11-17', entry);
    expect(readCache<typeof entry>(dir, 'route-LHR-JFK-2026-11-17', 60_000)).toEqual(entry);
  });
});
