import { describe, it, expect } from 'vitest';
import { computeFieldDistribution } from '../src/aggregate.js';
import type { SourceId, SourceResult } from '../src/types.js';

const weights: Record<SourceId, number> = {
  openSky: 0.9,
  adsbExchange: 0.8,
  flightaware: 0.85,
  flightradar24: 0.8,
  flightstats: 0.7,
  seatguru: 0.8,
  aeroapi: 0.95,
  aerodatabox: 0.9,
  googleSerp: 0.85,
  benGurion: 0.9,
  aena: 0.9,
  etihad: 0.95,
};

function result(source: SourceId, aircraftType: string | null, paywalled = false): SourceResult {
  return {
    source,
    fetchedAt: '2026-07-28T00:00:00.000Z',
    fields: {
      aircraftType: { value: aircraftType, paywalled, raw: aircraftType },
    },
  };
}

describe('computeFieldDistribution', () => {
  it('gives 100% weight when all sources agree', () => {
    const dist = computeFieldDistribution('aircraftType', [
      result('flightaware', 'B738'),
      result('flightradar24', 'Boeing 737-800'),
    ], weights);

    expect(dist.values).toHaveLength(1);
    expect(dist.values[0].value).toBe('Boeing 737-800');
    expect(dist.values[0].weight).toBeCloseTo(1);
    expect(dist.unconfirmed).toBe(false);
  });

  it('splits weight proportionally when sources disagree', () => {
    const dist = computeFieldDistribution('aircraftType', [
      result('flightaware', 'B738'),
      result('flightradar24', 'B38M'),
    ], weights);

    const total = weights.flightaware + weights.flightradar24;
    expect(dist.values).toHaveLength(2);
    expect(dist.values[0].value).toBe('Boeing 737-800');
    expect(dist.values[0].weight).toBeCloseTo(weights.flightaware / total);
    expect(dist.values[1].weight).toBeCloseTo(weights.flightradar24 / total);
  });

  it('flags a field reported by only one source as unconfirmed', () => {
    const dist = computeFieldDistribution('aircraftType', [
      result('flightaware', 'B738'),
    ], weights);

    expect(dist.unconfirmed).toBe(true);
    expect(dist.values[0].weight).toBeCloseTo(1);
  });

  it('excludes paywalled fields from the weighting but records the source', () => {
    const dist = computeFieldDistribution('aircraftType', [
      result('flightaware', null, true),
      result('flightradar24', 'B738'),
    ], weights);

    expect(dist.paywalledAt).toEqual(['flightaware']);
    expect(dist.values).toHaveLength(1);
    expect(dist.values[0].sources).toEqual(['flightradar24']);
  });

  it('returns an empty distribution when no source reports the field', () => {
    const dist = computeFieldDistribution('seatConfiguration', [
      result('flightaware', null),
    ], weights);

    expect(dist.values).toHaveLength(0);
  });
});
