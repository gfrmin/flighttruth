import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  extractRouteCandidates,
  buildFlightStatsRouteSearchUrl,
  searchFlightStatsRoutes,
} from '../../src/sources/flightstatsRoute.js';

const FIXTURE = readFileSync('tests/fixtures/flightstats-route-lhr-jfk.json', 'utf-8');

describe('buildFlightStatsRouteSearchUrl', () => {
  it('builds the numHours=24 whole-day URL from origin/destination/date', () => {
    expect(buildFlightStatsRouteSearchUrl({ origin: 'lhr', destination: 'jfk', date: '2026-11-17' })).toBe(
      'https://www.flightstats.com/v2/api-next/flight-tracker/route/LHR/JFK/2026/11/17?carrierCode=&numHours=24&hour=0'
    );
  });
});

describe('extractRouteCandidates', () => {
  it('finds the operating flight for the queried route/date', () => {
    // Fixture captured live for LHR->JFK, 2026-11-17. FlightStats' own route search shows a
    // 6-hour window by default; numHours=24 covers the whole day in one call, so an evening
    // departure like BA183 is not missed.
    const candidates = extractRouteCandidates(FIXTURE);
    const ba183 = candidates.find((c) => c.flightNumber === 'BA183');

    expect(ba183).toBeTruthy();
    expect(ba183?.airline).toBe('British Airways');
    expect(ba183?.scheduledDeparture).toBe('2026-11-17T19:20:00.000Z');
    expect(ba183?.operatingFlightNumber).toBeUndefined();
  });

  it('lists the codeshare number for the operating flight, and vice versa', () => {
    const candidates = extractRouteCandidates(FIXTURE);
    const ba183 = candidates.find((c) => c.flightNumber === 'BA183');
    const aa6942 = candidates.find((c) => c.flightNumber === 'AA6942');

    expect(ba183?.codeshareFlightNumbers).toEqual(['AA6942', 'AS5265', 'AY5483', 'EI8883', 'IB3567']);
    expect(aa6942?.operatingFlightNumber).toBe('BA183');
  });

  it('returns an empty array for invalid JSON', () => {
    expect(extractRouteCandidates('not json')).toEqual([]);
  });
});

describe('searchFlightStatsRoutes', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches the route URL and returns extracted candidates', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => FIXTURE })));

    const result = await searchFlightStatsRoutes({ origin: 'LHR', destination: 'JFK', date: '2026-11-17' });

    expect(result.error).toBeUndefined();
    expect(result.candidates.some((c) => c.flightNumber === 'BA183')).toBe(true);
  });

  it('reports an error on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, text: async () => '' })));

    const result = await searchFlightStatsRoutes({ origin: 'LHR', destination: 'JFK', date: '2026-11-17' });

    expect(result.error).toBeTruthy();
    expect(result.candidates).toEqual([]);
  });
});
