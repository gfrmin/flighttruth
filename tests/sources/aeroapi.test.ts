import { describe, it, expect, vi } from 'vitest';
import { makeAeroApiSource, aeroApiWindow, type AeroApiFlight } from '../../src/sources/aeroapi.js';

// Shape per AeroAPI v4 OpenAPI spec (GET /flights/{ident}).
const flight = (over: Partial<AeroApiFlight> = {}): AeroApiFlight => ({
  ident: 'ETD103',
  ident_iata: 'EY103',
  operator_iata: 'EY',
  codeshares_iata: ['AF6612'],
  origin: { code_iata: 'HKG', timezone: 'Asia/Hong_Kong' },
  destination: { code_iata: 'AUH', timezone: 'Asia/Dubai' },
  scheduled_out: '2026-11-05T16:35:00Z',
  estimated_out: '2026-11-05T16:50:00Z',
  actual_out: null,
  scheduled_in: '2026-11-06T01:15:00Z',
  estimated_in: '2026-11-06T01:20:00Z',
  actual_in: null,
  status: 'Scheduled / Delayed',
  registration: 'A6-XBB',
  aircraft_type: 'B789',
  gate_origin: '23',
  terminal_origin: '1',
  gate_destination: null,
  terminal_destination: 'A',
  baggage_claim: '7',
  cancelled: false,
  diverted: false,
  ...over,
});

const okResponse = (flights: AeroApiFlight[]) => ({ ok: true, status: 200, json: async () => ({ flights }) });

describe('aeroApiWindow', () => {
  it('spans every timezone whose local date could be the query date', () => {
    expect(aeroApiWindow('2026-11-06')).toEqual({ start: '2026-11-05T10:00:00Z', end: '2026-11-07T14:00:00Z' });
  });
});

describe('makeAeroApiSource', () => {
  it('maps a flight into the mosaic fields, keeping estimates separate from actuals', async () => {
    const fetchImpl = vi.fn(async () => okResponse([flight()]));
    const result = await makeAeroApiSource('k', fetchImpl as unknown as typeof fetch).fetch({ type: 'number', query: 'EY103', date: '2026-11-06' });

    expect(result.error).toBeUndefined();
    const v = (f: keyof typeof result.fields) => result.fields[f]?.value;
    expect(v('origin')).toBe('HKG');
    expect(v('destination')).toBe('AUH');
    expect(v('scheduledDeparture')).toBe('2026-11-05T16:35:00Z');
    expect(v('estimatedDeparture')).toBe('2026-11-05T16:50:00Z');
    expect(v('actualDeparture')).toBeUndefined();
    expect(v('estimatedArrival')).toBe('2026-11-06T01:20:00Z');
    expect(v('tailNumber')).toBe('A6-XBB');
    expect(v('aircraftType')).toBe('B789');
    expect(v('departureGate')).toBe('23');
    expect(v('departureTerminal')).toBe('1');
    expect(v('arrivalGate')).toBeUndefined();
    expect(v('arrivalTerminal')).toBe('A');
    expect(v('baggage')).toBe('7');
    expect(v('status')).toBe('Scheduled / Delayed');
    expect(result.codeshareFlightNumbers).toEqual(['AF6612']);
  });

  it('sends the key header, a designator ident and a date window', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => okResponse([flight()]));
    await makeAeroApiSource('secret', fetchImpl as unknown as typeof fetch).fetch({ type: 'number', query: 'ey 103', date: '2026-11-06' });

    const [url, init] = fetchImpl.mock.calls[0];
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://aeroapi.flightaware.com/aeroapi/flights/EY103');
    expect(u.searchParams.get('ident_type')).toBe('designator');
    expect(u.searchParams.get('start')).toBe('2026-11-05T10:00:00Z');
    expect((init?.headers as Record<string, string>)['x-apikey']).toBe('secret');
  });

  it('picks the instance whose departure falls on the query date in the origin timezone', async () => {
    const yesterday = flight({ scheduled_out: '2026-11-04T16:35:00Z', registration: 'A6-OLD' });
    const today = flight({ scheduled_out: '2026-11-05T16:35:00Z', registration: 'A6-NEW' }); // 00:35 6 Nov in HKG
    const fetchImpl = vi.fn(async () => okResponse([yesterday, today]));
    const result = await makeAeroApiSource('k', fetchImpl as unknown as typeof fetch).fetch({ type: 'number', query: 'EY103', date: '2026-11-06' });

    expect(result.fields.tailNumber?.value).toBe('A6-NEW');
  });

  it('reports cancellation and diversion through status', async () => {
    const fetchImpl = vi.fn(async () => okResponse([flight({ cancelled: true, status: 'Scheduled' })]));
    const result = await makeAeroApiSource('k', fetchImpl as unknown as typeof fetch).fetch({ type: 'number', query: 'EY103', date: '2026-11-06' });

    expect(result.fields.status?.value).toBe('Cancelled');
  });

  it('records an error when no instance departs on the query date', async () => {
    const fetchImpl = vi.fn(async () => okResponse([flight({ scheduled_out: '2026-11-01T16:35:00Z' })]));
    const result = await makeAeroApiSource('k', fetchImpl as unknown as typeof fetch).fetch({ type: 'number', query: 'EY103', date: '2026-11-06' });

    expect(result.error).toMatch(/no EY103 departing 2026-11-06/);
    expect(result.fields).toEqual({});
  });

  it('records HTTP failures as errors', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }));
    const result = await makeAeroApiSource('bad', fetchImpl as unknown as typeof fetch).fetch({ type: 'number', query: 'EY103', date: '2026-11-06' });

    expect(result.error).toBe('HTTP 401');
  });

  it('looks up by registration for tail queries', async () => {
    const fetchImpl = vi.fn(async (_url: string) => okResponse([flight()]));
    await makeAeroApiSource('k', fetchImpl as unknown as typeof fetch).fetch({ type: 'tail', query: 'a6-xbb', date: '2026-11-06' });

    const u = new URL(fetchImpl.mock.calls[0][0]);
    expect(u.pathname).toBe('/aeroapi/flights/A6XBB');
    expect(u.searchParams.get('ident_type')).toBe('registration');
  });
});
