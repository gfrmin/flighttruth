import { describe, it, expect, vi } from 'vitest';
import { extractEtihadFields, makeEtihadSource, type EyFlight, type EyResponse } from '../../src/sources/etihad.js';

// A response in the shape of Etihad's flight-status API, for an invented flight EY103 on 2026-11-06.
const EY103: EyFlight = {
  carrier: 'EY', flightNumber: '103', engFlightStatus: 'Arrived early', flightStatusCode: 'ARE', equipment: 'BOEING 787-9',
  departure: {
    locationCode: 'HKG', scheduledDate: '2026-11-06', scheduledTime: '19:45:00.000', estimatedDate: '2026-11-06', estimatedTime: '19:45:00',
    actualDate: '2026-11-06', actualTime: '19:43:00', terminal: '1', gate: '28', timeZone: '+0800',
  },
  arrival: {
    locationCode: 'AUH', scheduledDate: '2026-11-07', scheduledTime: '00:30:00.000', estimatedDate: '2026-11-06', estimatedTime: '23:59:00',
    actualDate: '2026-11-06', actualTime: '23:58:00', terminal: 'A', timeZone: '+0400',
  },
};
const response = (...flights: EyFlight[]): EyResponse => ({ flightStatus: { onds: [{ flights }] } });
const values = (f: EyFlight) => Object.fromEntries(Object.entries(extractEtihadFields(f)).map(([k, v]) => [k, v!.value]));

describe('extractEtihadFields', () => {
  it('maps a completed flight using each airport offset', () => {
    expect(values(EY103)).toEqual({
      airline: 'Etihad Airways',
      origin: 'HKG',
      destination: 'AUH',
      scheduledDeparture: '2026-11-06T11:45:00.000Z',
      gateDeparture: '2026-11-06T11:43:00.000Z',
      scheduledArrival: '2026-11-06T20:30:00.000Z',
      gateArrival: '2026-11-06T19:58:00.000Z',
      status: 'Arrived early',
      aircraftType: 'BOEING 787-9',
      departureTerminal: '1',
      departureGate: '28',
      arrivalTerminal: 'A',
    });
  });

  it('reports a changed time as an estimate until there is an actual', () => {
    const delayed: EyFlight = {
      ...EY103,
      engFlightStatus: 'Delayed',
      departure: { ...EY103.departure, actualDate: undefined, actualTime: undefined, estimatedTime: '20:30:00' },
    };
    expect(values(delayed).estimatedDeparture).toBe('2026-11-06T12:30:00.000Z');
    expect(values(delayed).gateDeparture).toBeUndefined();
  });

  it('spells cancellations the way the alert matcher expects', () => {
    expect(values({ ...EY103, engFlightStatus: 'Flight cancelled' }).status).toBe('Cancelled');
  });
});

describe('makeEtihadSource', () => {
  it('asks for the bare number on the query date', async () => {
    const lookup = vi.fn(async () => response(EY103));
    const result = await makeEtihadSource(lookup).fetch({ type: 'number', query: 'ey 0103', date: '2026-11-06' });
    expect(lookup).toHaveBeenCalledWith('103', '2026-11-06');
    expect(result.fields.departureGate?.value).toBe('28');
  });

  it('skips other airlines without a browser session', async () => {
    const lookup = vi.fn(async () => response());
    const result = await makeEtihadSource(lookup).fetch({ type: 'number', query: 'LY91', date: '2026-11-06' });
    expect(result.error).toBe('only Etihad (EY) flight numbers');
    expect(lookup).not.toHaveBeenCalled();
  });

  it('reports an empty result and lookup failures', async () => {
    expect((await makeEtihadSource(async () => response()).fetch({ type: 'number', query: 'EY103', date: '2026-11-06' })).error)
      .toBe('Etihad has no EY103 on 2026-11-06');
    expect((await makeEtihadSource(async () => { throw new Error('Etihad API HTTP 403'); }).fetch({ type: 'number', query: 'EY103', date: '2026-11-06' })).error)
      .toBe('Etihad API HTTP 403');
  });
});
