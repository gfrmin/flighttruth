import { describe, it, expect, vi } from 'vitest';
import { makeAeroDataBoxSource, type AdbFlight } from '../../src/sources/aerodatabox.js';

// Shape per AeroDataBox OpenAPI (FlightContract / FlightAirportMovementContract); times as
// the API returns them: "YYYY-MM-DD HH:mmZ" UTC and "YYYY-MM-DD HH:mm+hh:mm" local.
const flight = (over: Partial<AdbFlight> = {}): AdbFlight => ({
  number: 'EY 103',
  status: 'Expected',
  airline: { name: 'Etihad' },
  aircraft: { reg: 'A6-XBB', model: 'Boeing 787-9' },
  departure: {
    airport: { iata: 'HKG' },
    scheduledTime: { utc: '2026-11-05 16:35Z', local: '2026-11-06 00:35+08:00' },
    revisedTime: { utc: '2026-11-05 16:50Z', local: '2026-11-06 00:50+08:00' },
    terminal: '1',
    gate: '23',
    checkInDesk: 'J',
  },
  arrival: {
    airport: { iata: 'AUH' },
    scheduledTime: { utc: '2026-11-06 01:15Z', local: '2026-11-06 05:15+04:00' },
    predictedTime: { utc: '2026-11-06 01:22Z', local: '2026-11-06 05:22+04:00' },
    terminal: 'A',
    baggageBelt: '7',
  },
  ...over,
});

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const run = (fetchImpl: unknown, date = '2026-11-06', type: 'number' | 'tail' = 'number', query = 'EY103') =>
  makeAeroDataBoxSource('k', fetchImpl as typeof fetch).fetch({ type, query, date });

describe('makeAeroDataBoxSource', () => {
  it('maps a not-yet-departed flight, treating revised times as estimates', async () => {
    const result = await run(vi.fn(async () => ok([flight()])));

    expect(result.error).toBeUndefined();
    const v = (f: keyof typeof result.fields) => result.fields[f]?.value;
    expect(v('airline')).toBe('Etihad');
    expect(v('origin')).toBe('HKG');
    expect(v('destination')).toBe('AUH');
    expect(v('scheduledDeparture')).toBe('2026-11-05 16:35Z');
    expect(v('estimatedDeparture')).toBe('2026-11-05 16:50Z');
    expect(v('actualDeparture')).toBeUndefined();
    expect(v('estimatedArrival')).toBe('2026-11-06 01:22Z');
    expect(v('departureGate')).toBe('23');
    expect(v('departureTerminal')).toBe('1');
    expect(v('arrivalTerminal')).toBe('A');
    expect(v('baggage')).toBe('7');
    expect(v('tailNumber')).toBe('A6-XBB');
    expect(v('aircraftType')).toBe('Boeing 787-9');
    expect(v('status')).toBe('Expected');
  });

  it('treats the departure revised time as the gate time once the flight has left', async () => {
    const result = await run(vi.fn(async () => ok([flight({ status: 'EnRoute' })])));

    expect(result.fields.gateDeparture?.value).toBe('2026-11-05 16:50Z');
    expect(result.fields.estimatedDeparture).toBeUndefined();
    expect(result.fields.actualArrival).toBeUndefined();
    expect(result.fields.status?.value).toBe('En Route');
  });

  it('treats the arrival revised time as the gate time once arrived', async () => {
    const arrived = flight({ status: 'Arrived' });
    arrived.arrival.revisedTime = { utc: '2026-11-06 01:19Z', local: '2026-11-06 05:19+04:00' };
    const result = await run(vi.fn(async () => ok([arrived])));

    expect(result.fields.gateArrival?.value).toBe('2026-11-06 01:19Z');
    expect(result.fields.estimatedArrival).toBeUndefined();
    expect(result.fields.status?.value).toBe('Arrived');
  });

  it('spells cancellations the way the alert matcher expects', async () => {
    const result = await run(vi.fn(async () => ok([flight({ status: 'Canceled' })])));
    expect(result.fields.status?.value).toBe('Cancelled');
  });

  it('picks the instance departing on the query date (local)', async () => {
    const other = flight({ aircraft: { reg: 'A6-OLD' } });
    other.departure = { ...other.departure, scheduledTime: { utc: '2026-11-04 16:35Z', local: '2026-11-05 00:35+08:00' } };
    const result = await run(vi.fn(async () => ok([other, flight()])));

    expect(result.fields.tailNumber?.value).toBe('A6-XBB');
  });

  it('calls the RapidAPI endpoint with key headers', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => ok([flight()]));
    await run(fetchImpl, '2026-11-06', 'number', 'ey 103');

    const [url, init] = fetchImpl.mock.calls[0];
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://aerodatabox.p.rapidapi.com/flights/number/EY103/2026-11-06');
    expect(u.searchParams.get('dateLocalRole')).toBe('Departure');
    const headers = init?.headers as Record<string, string>;
    expect(headers['X-RapidAPI-Key']).toBe('k');
    expect(headers['X-RapidAPI-Host']).toBe('aerodatabox.p.rapidapi.com');
  });

  it('uses the reg search for tail queries', async () => {
    const fetchImpl = vi.fn(async (_url: string) => ok([flight()]));
    await run(fetchImpl, '2026-11-06', 'tail', 'A6-XBB');
    expect(new URL(fetchImpl.mock.calls[0][0]).pathname).toBe('/flights/reg/A6XBB/2026-11-06');
  });

  it('treats 204 No Content and empty lists as not found', async () => {
    const noContent = await run(vi.fn(async () => ({ ok: true, status: 204, json: async () => { throw new Error('no body'); } })));
    expect(noContent.error).toMatch(/no EY103 departing 2026-11-06/);
    const empty = await run(vi.fn(async () => ok([])));
    expect(empty.error).toMatch(/no EY103 departing/);
  });

  it('records HTTP failures as errors', async () => {
    const result = await run(vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) })));
    expect(result.error).toBe('HTTP 429');
  });
});
