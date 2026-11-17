import { describe, it, expect } from 'vitest';
import { buildSources, missingSourceWarnings } from '../../src/sources/index.js';

const ids = (env: Record<string, string>) => buildSources(env).map((s) => s.id);

describe('buildSources', () => {
  it('always includes the free live sources', () => {
    expect(ids({})).toEqual(['openSky', 'adsbExchange', 'benGurion', 'aena']);
  });

  it('enables each keyed source by its env var', () => {
    expect(ids({ AEROAPI_KEY: 'a', AERODATABOX_KEY: 'b' })).toEqual(['openSky', 'adsbExchange', 'benGurion', 'aena', 'aeroapi', 'aerodatabox']);
    expect(ids({ BRIGHTDATA_BROWSER_WSS: 'w' })).toEqual(['openSky', 'adsbExchange', 'benGurion', 'aena', 'etihad']);
    expect(ids({ BRIGHTDATA_API_KEY: 'c' })).toEqual(['openSky', 'adsbExchange', 'benGurion', 'aena', 'googleSerp', 'flightaware', 'flightradar24', 'flightstats']);
  });
});

describe('missingSourceWarnings', () => {
  it('names each missing key, skipping opt-in extras', () => {
    expect(missingSourceWarnings({}).map((w) => w.split(' ')[0])).toEqual(['BRIGHTDATA_API_KEY', 'BRIGHTDATA_BROWSER_WSS']);
  });

  it('is silent when every key is set', () => {
    expect(missingSourceWarnings({ BRIGHTDATA_API_KEY: 'c', BRIGHTDATA_BROWSER_WSS: 'w' })).toEqual([]);
  });
});
