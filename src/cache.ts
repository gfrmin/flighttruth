import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { FlightQuery, RouteQuery, SourceResult } from './types.js';

export interface CacheEntry {
  fetchedAt: string;
  results: SourceResult[];
}

export function cacheKey(query: FlightQuery): string {
  return `${query.type}-${query.query.toUpperCase()}-${query.date}`;
}

export function routeCacheKey(query: RouteQuery): string {
  return `route-${query.origin.toUpperCase()}-${query.destination.toUpperCase()}-${query.date}`;
}

export function readCache<T extends { fetchedAt: string } = CacheEntry>(
  cacheDir: string,
  key: string,
  ttlMs: number
): T | null {
  const path = join(cacheDir, `${key}.json`);
  if (!existsSync(path)) return null;

  const entry: T = JSON.parse(readFileSync(path, 'utf-8'));
  const age = Date.now() - new Date(entry.fetchedAt).getTime();
  if (age > ttlMs) return null;
  return entry;
}

export function writeCache<T extends { fetchedAt: string } = CacheEntry>(cacheDir: string, key: string, entry: T): void {
  if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
  writeFileSync(join(cacheDir, `${key}.json`), JSON.stringify(entry, null, 2));
}
