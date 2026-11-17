import { describe, it, expect, vi, afterEach } from 'vitest';
import { openSkySource } from '../../src/sources/openSky.js';

describe('openSkySource', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports airborne status when the ICAO callsign is found in the live state vector', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        time: 1700000000,
        states: [
          ['7380ca', 'ELY091  ', 'Israel', 1700000000, 1700000000, 34.9, 32.0, 11000, false, 250, 90, 0, null, 11500, null, false, 0],
        ],
      }),
    })));

    const result = await openSkySource.fetch({ type: 'number', query: 'LY91', date: '2026-07-28' });

    expect(result.error).toBeUndefined();
    expect(result.fields.status?.value).toBe('Airborne (live ADS-B)');
  });

  it('does not call a taxiing plane airborne', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        time: 1700000000,
        states: [['4b1a1b', 'SWR300  ', 'Switzerland', 1700000000, 1700000000, 113.93, 22.31, null, true, 3.6, 90, 0, null, null, null, false, 0]],
      }),
    })));

    const result = await openSkySource.fetch({ type: 'number', query: 'LX300', date: '2026-11-11' });

    expect(result.fields.status).toBeUndefined();
    expect(result.error).toMatch(/on the ground/);
  });

  it('records an error when the callsign is not found', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ time: 1700000000, states: [] }),
    })));

    const result = await openSkySource.fetch({ type: 'number', query: 'LY91', date: '2026-07-28' });

    expect(result.error).toBeTruthy();
    expect(result.fields.status).toBeUndefined();
  });

  it('records an error when the airline code cannot be resolved', async () => {
    const result = await openSkySource.fetch({ type: 'number', query: 'ZZ91', date: '2026-07-28' });

    expect(result.error).toBeTruthy();
  });
});
