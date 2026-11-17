import { FIELD_NAMES, SOURCE_WEIGHTS } from './types.js';
import type { FlightQuery, SourceFetcher, SourceResult } from './types.js';
import { computeFieldDistribution, type FieldDistribution } from './aggregate.js';
import { cacheKey, readCache, writeCache } from './cache.js';
import { normalizeFlightNumber } from './airlineCodes.js';

export interface FlightLookupResult {
  query: FlightQuery;
  fetchedAt: string;
  distributions: FieldDistribution[];
  sourceResults: SourceResult[];
  resolvedOperatingFlightNumber?: string;
  codeshareFlightNumbers: string[];
}

export interface LookupOptions {
  forceRefresh?: boolean;
  cacheDir?: string;
  ttlMs?: number;
}

// Scans all results (not just flightstats by name) for a reported operating number that
// differs from what was actually queried, so any future source that learns to populate
// operatingFlightNumber plugs into this without an orchestration change.
function findResolvedOperatingNumber(query: FlightQuery, results: SourceResult[]): string | null {
  if (query.type !== 'number') return null;
  const original = normalizeFlightNumber(query.query);
  for (const result of results) {
    if (result.operatingFlightNumber && normalizeFlightNumber(result.operatingFlightNumber) !== original) {
      return result.operatingFlightNumber;
    }
  }
  return null;
}

function collectCodeshareNumbers(query: FlightQuery, results: SourceResult[]): string[] {
  const original = normalizeFlightNumber(query.query);
  const seen = new Set<string>();
  for (const result of results) {
    for (const num of result.codeshareFlightNumbers ?? []) {
      if (normalizeFlightNumber(num) !== original) seen.add(num.toUpperCase());
    }
  }
  return [...seen];
}

// The origin and destination most sources agree on, for the per-airport boards' second pass.
function routeOf(results: SourceResult[]): { origin: string | null; destination: string | null } {
  const top = (field: 'origin' | 'destination'): string | null => {
    const counts = new Map<string, number>();
    for (const r of results) {
      const v = r.fields[field]?.value?.toUpperCase();
      if (v && /^[A-Z]{3}$/.test(v)) counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  };
  return { origin: top('origin'), destination: top('destination') };
}

// Retries only the sources flagged retryOnIdentityResolution (free-API live-tracking sources)
// that errored on the first pass, using the resolved operating number instead of the
// originally-queried (possibly marketing) one. A successful retry replaces that source's
// result, tagged with retriedAs; a still-failing retry keeps the original, more relevant
// error. Sources that already succeeded, or don't opt in, are never re-fetched.
async function resolveCodeshareIdentity(
  query: FlightQuery,
  sourceList: SourceFetcher[],
  firstPass: SourceResult[]
): Promise<SourceResult[]> {
  const resolved = findResolvedOperatingNumber(query, firstPass);
  if (!resolved) return firstPass;

  const retryTargets = sourceList.filter(
    (source) => source.retryOnIdentityResolution && !!firstPass.find((r) => r.source === source.id)?.error
  );
  if (retryTargets.length === 0) return firstPass;

  const retryQuery: FlightQuery = { ...query, query: resolved };
  const retryResults = await Promise.all(retryTargets.map((source) => source.fetch(retryQuery)));

  return firstPass.map((result) => {
    const retried = retryResults.find((r) => r.source === result.source);
    return retried && !retried.error ? { ...retried, retriedAs: resolved } : result;
  });
}

export async function lookupFlight(
  query: FlightQuery,
  sourceList: SourceFetcher[],
  options: LookupOptions = {}
): Promise<FlightLookupResult> {
  const { forceRefresh = false, cacheDir = 'cache', ttlMs = 60 * 60 * 1000 } = options;
  const key = cacheKey(query);
  const cached = !forceRefresh ? readCache(cacheDir, key, ttlMs) : null;

  let sourceResults: SourceResult[];
  if (cached) {
    sourceResults = cached.results;
  } else {
    const [boards, others] = [sourceList.filter((s) => s.needsRoute), sourceList.filter((s) => !s.needsRoute)];
    const firstPass = await resolveCodeshareIdentity(query, others, await Promise.all(others.map((source) => source.fetch(query))));
    const routed = { ...query, route: routeOf(firstPass) };
    sourceResults = [...firstPass, ...(await Promise.all(boards.map((source) => source.fetch(routed))))];
    writeCache(cacheDir, key, { fetchedAt: new Date().toISOString(), results: sourceResults });
  }

  const distributions = FIELD_NAMES.map((field) =>
    computeFieldDistribution(field, sourceResults, SOURCE_WEIGHTS)
  );

  return {
    query,
    fetchedAt: cached?.fetchedAt ?? new Date().toISOString(),
    distributions,
    sourceResults,
    resolvedOperatingFlightNumber: findResolvedOperatingNumber(query, sourceResults) ?? undefined,
    codeshareFlightNumbers: collectCodeshareNumbers(query, sourceResults),
  };
}
