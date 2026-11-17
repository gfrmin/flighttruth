import { routeCacheKey, readCache, writeCache } from './cache.js';
import { searchFlightStatsRoutes } from './sources/flightstatsRoute.js';
import type { RouteQuery, RouteSearchResult, RouteCandidate } from './types.js';

export interface RouteSearchOptions {
  forceRefresh?: boolean;
  cacheDir?: string;
  ttlMs?: number;
  search?: (query: RouteQuery) => Promise<{ candidates: RouteCandidate[]; error?: string }>;
}

interface RouteCacheEntry {
  fetchedAt: string;
  candidates: RouteCandidate[];
  error?: string;
}

export async function searchRoutes(query: RouteQuery, options: RouteSearchOptions = {}): Promise<RouteSearchResult> {
  const {
    forceRefresh = false,
    cacheDir = 'cache',
    ttlMs = 60 * 60 * 1000,
    search = searchFlightStatsRoutes,
  } = options;

  const key = routeCacheKey(query);
  const cached = !forceRefresh ? readCache<RouteCacheEntry>(cacheDir, key, ttlMs) : null;
  if (cached) {
    return { query, fetchedAt: cached.fetchedAt, candidates: cached.candidates, error: cached.error };
  }

  const fetchedAt = new Date().toISOString();
  try {
    const { candidates, error } = await search(query);
    writeCache<RouteCacheEntry>(cacheDir, key, { fetchedAt, candidates, error });
    return { query, fetchedAt, candidates, error };
  } catch (err) {
    return { query, fetchedAt, candidates: [], error: (err as Error).message };
  }
}
