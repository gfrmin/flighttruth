import { describe, it, expect, vi } from 'vitest';
import { departureDateOf, extractIaaFields, makeBenGurionSource, type IaaRecord } from '../../src/sources/benGurion.js';
import { estimatedBlockMinutes } from '../../src/airports.js';

// Real records from the data.gov.il TLV board, 2026-11-07.
const rec = (over: Partial<IaaRecord>): IaaRecord => ({
  CHOPER: 'EY', CHFLTN: '104', CHAORD: 'A', CHLOC1: 'AUH',
  CHSTOL: '2026-11-07T05:05:00', CHPTOL: '2026-11-07T05:15:00', CHTERM: 3, CHRMINE: 'LANDED', ...over,
});
const LANDED = rec({});
const NEXT_DAY = rec({ CHSTOL: '2026-11-08T05:05:00', CHPTOL: '2026-11-08T05:05:00', CHRMINE: 'NOT FINAL' });
const DEPARTING = rec({ CHOPER: 'IZ', CHAORD: 'D', CHLOC1: 'HAN', CHSTOL: '2026-11-10T00:30:00', CHPTOL: '2026-11-10T00:30:00', CHRMINE: 'ON TIME' });

const values = (r: IaaRecord) => Object.fromEntries(Object.entries(extractIaaFields(r)).map(([k, v]) => [k, v!.value]));

describe('estimatedBlockMinutes', () => {
  it('is within an hour of real schedules', () => {
    expect(Math.abs(estimatedBlockMinutes('AUH', 'TLV')! - 220)).toBeLessThan(60); // EY104: 3h40
    expect(Math.abs(estimatedBlockMinutes('HKG', 'AUH')! - 525)).toBeLessThan(60); // EY103: 8h45
  });
});

describe('departureDateOf', () => {
  it('backs an arrival out to its local departure date at the origin', () => {
    expect(departureDateOf(LANDED)).toBe('2026-11-07');
    expect(departureDateOf(NEXT_DAY)).toBe('2026-11-08');
  });

  it('uses the scheduled date for departures from TLV', () => {
    expect(departureDateOf(DEPARTING)).toBe('2026-11-10');
  });

  it('picks the previous day for an overnight arrival', () => {
    // JFK 17:00 EST on 6 Nov → TLV about 10:00 on 7 Nov: departed the day before it arrived.
    expect(departureDateOf(rec({ CHLOC1: 'JFK', CHSTOL: '2026-11-07T10:00:00' }))).toBe('2026-11-06');
  });
});

describe('extractIaaFields', () => {
  it('maps a landed arrival, taking the latest time as actual', () => {
    expect(values(LANDED)).toEqual({
      origin: 'AUH',
      destination: 'TLV',
      scheduledArrival: '2026-11-07T03:05:00.000Z',
      actualArrival: '2026-11-07T03:15:00.000Z',
      status: 'Arrived',
      arrivalTerminal: '3',
    });
  });

  it('maps a departure, with no estimate when it matches the schedule', () => {
    expect(values(DEPARTING)).toEqual({
      origin: 'TLV',
      destination: 'HAN',
      scheduledDeparture: '2026-11-09T22:30:00.000Z',
      status: 'On Time',
      departureTerminal: '3',
    });
  });

  it('reports a changed time before the movement as an estimate', () => {
    expect(values(rec({ CHPTOL: '2026-11-07T05:40:00', CHRMINE: 'DELAYED' })).estimatedArrival).toBe('2026-11-07T03:40:00.000Z');
  });

  it('spells cancellations the way the alert matcher expects', () => {
    expect(values(rec({ CHRMINE: 'CANCELED' })).status).toBe('Cancelled');
  });
});

const ok = (records: IaaRecord[]) => ({ ok: true, status: 200, json: async () => ({ success: true, result: { records } }) });

describe('makeBenGurionSource', () => {
  it('filters the datastore by airline and number and picks the query date', async () => {
    const fetchImpl = vi.fn(async (_u: string) => ok([NEXT_DAY, LANDED]));
    const result = await makeBenGurionSource(fetchImpl as unknown as typeof fetch).fetch({ type: 'number', query: 'ey 104', date: '2026-11-07' });

    expect(result.fields.actualArrival?.value).toBe('2026-11-07T03:15:00.000Z');
    const url = new URL(fetchImpl.mock.calls[0][0]);
    expect(url.origin + url.pathname).toBe('https://data.gov.il/api/3/action/datastore_search');
    expect(JSON.parse(url.searchParams.get('filters')!)).toEqual({ CHOPER: 'EY', CHFLTN: '104' });
  });

  it('says so when the flight does not touch TLV', async () => {
    const result = await makeBenGurionSource(vi.fn(async () => ok([])) as unknown as typeof fetch).fetch({ type: 'number', query: 'EY103', date: '2026-11-06' });
    expect(result.error).toBe('EY103 does not fly to or from TLV');
  });

  it('reports a date missing from the board', async () => {
    const result = await makeBenGurionSource(vi.fn(async () => ok([LANDED])) as unknown as typeof fetch).fetch({ type: 'number', query: 'EY104', date: '2026-11-20' });
    expect(result.error).toMatch(/no EY104 departing 2026-11-20/);
  });
});
