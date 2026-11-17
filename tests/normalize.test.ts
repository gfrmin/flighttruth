import { describe, it, expect } from 'vitest';
import { normalizeValue } from '../src/normalize.js';

describe('normalizeValue', () => {
  it('maps known aircraft type codes to a canonical label', () => {
    expect(normalizeValue('aircraftType', 'B738')).toBe('Boeing 737-800');
    expect(normalizeValue('aircraftType', 'Boeing 737-800')).toBe('Boeing 737-800');
  });

  it('maps flightradar24 and adsb.lol type codes for the same aircraft to one canonical label', () => {
    // Confirmed live: adsb.lol reported "A21N" and flightradar24 "Airbus A321-251NX" for the
    // same BA183 airframe (G-VIIW) -- without this, aggregation would show a false disagreement.
    expect(normalizeValue('aircraftType', 'A21N')).toBe('Airbus A321neo');
    expect(normalizeValue('aircraftType', 'Airbus A321-251NX')).toBe('Airbus A321neo');
  });

  it('leaves unrecognized aircraft type values unchanged', () => {
    expect(normalizeValue('aircraftType', 'Concorde')).toBe('Concorde');
  });

  it('uppercases and trims tail numbers', () => {
    expect(normalizeValue('tailNumber', ' 4x-eda ')).toBe('4X-EDA');
  });

  it('trims other fields without transforming case', () => {
    expect(normalizeValue('status', '  On Time  ')).toBe('On Time');
  });

  it('canonicalises instants from different sources to the same minute-precision UTC ISO string', () => {
    // AeroAPI "2026-11-05T16:35:00Z", AeroDataBox "2026-11-05 16:35Z", FlightStats ms precision.
    const canonical = '2026-11-05T16:35:00.000Z';
    expect(normalizeValue('scheduledDeparture', '2026-11-05T16:35:00Z')).toBe(canonical);
    expect(normalizeValue('scheduledDeparture', '2026-11-05 16:35Z')).toBe(canonical);
    expect(normalizeValue('estimatedArrival', '2026-11-05T16:35:42.123Z')).toBe(canonical);
  });

  it('leaves unparseable time values trimmed but otherwise unchanged', () => {
    expect(normalizeValue('actualDeparture', ' soon ')).toBe('soon');
  });

  it('uppercases airport codes, gates and terminals', () => {
    expect(normalizeValue('origin', ' hkg ')).toBe('HKG');
    expect(normalizeValue('departureGate', 'b12')).toBe('B12');
    expect(normalizeValue('arrivalTerminal', 't1')).toBe('T1');
  });
});
