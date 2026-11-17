import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  extractFlightStatsFields,
  extractOperatingFlightNumber,
  extractCodeshareNumbers,
  flightstatsSource,
} from '../../src/sources/flightstats.js';
import { scrapeHtml } from '../../src/scrape.js';

vi.mock('../../src/scrape.js', () => ({ scrapeHtml: vi.fn() }));

const FIXTURE = readFileSync('tests/fixtures/flightstats-ba183-departed.html', 'utf-8');
const AA1_FIXTURE = readFileSync('tests/fixtures/flightstats-aa1-landed.html', 'utf-8');
const MARKETING_CODESHARE_FIXTURE = readFileSync(
  'tests/fixtures/flightstats-aa6942-codeshare.html',
  'utf-8'
);

describe('extractFlightStatsFields', () => {
  it('extracts fields from the embedded __NEXT_DATA__ flight object', () => {
    // Fixture captured live for BA183 on 2026-11-17, en route LHR -> JFK, already departed.
    const fields = extractFlightStatsFields(FIXTURE);

    expect(fields.airline?.value).toBe('British Airways');
    expect(fields.origin?.value).toBe('LHR');
    expect(fields.destination?.value).toBe('JFK');
    expect(fields.status?.value).toBe('Departed');
    expect(fields.aircraftType?.value).toBe('Boeing 777-200 / 200ER');
    expect(fields.tailNumber?.value).toBe('G-VIIW');
    expect(fields.scheduledDeparture?.value).toBe('2026-11-17T19:20:00.000Z');
    expect(fields.scheduledArrival?.value).toBe('2026-11-18T03:25:00.000Z');
  });

  it('files a gate-time "Actual" as gateDeparture and an "Estimated" one as an estimate', () => {
    const fields = extractFlightStatsFields(FIXTURE);

    // Confirmed live: departure had already happened (title "Actual", runway: false = gate
    // time), arrival was still in-flight (title "Estimated").
    expect(fields.gateDeparture?.value).toBe('2026-11-17T19:56:00.000Z');
    expect(fields.actualDeparture).toBeUndefined();
    expect(fields.actualArrival).toBeUndefined();
    expect(fields.gateArrival).toBeUndefined();
    expect(fields.estimatedArrival?.value).toMatch(/^2026-11-18T/);
    expect(fields.departureGate?.value).toBe('A10');
    expect(fields.departureTerminal?.value).toBe('5');
  });

  it('reads gate times, arrival gate, baggage belt and callsign for a landed flight', () => {
    // Fixture captured live for AA1 JFK -> LAX on 2026-11-17, after it reached the gate.
    const fields = extractFlightStatsFields(AA1_FIXTURE);
    expect(fields.gateDeparture?.value).toBe('2026-11-17T13:55:00.000Z');
    expect(fields.gateArrival?.value).toBe('2026-11-17T19:31:00.000Z');
    expect(fields.arrivalTerminal?.value).toBe('TBIT');
    expect(fields.arrivalGate?.value).toBe('153');
    expect(fields.baggage?.value).toBe('T4C2');
    expect(fields.callsign?.value).toBe('AAL1');
  });

  it('returns an empty object when no __NEXT_DATA__ is present', () => {
    const fields = extractFlightStatsFields('<html><body>no data here</body></html>');
    expect(fields).toEqual({});
  });
});

describe('extractOperatingFlightNumber', () => {
  it('reads the operating carrier + flight number from positional.flexTrack', () => {
    // flexTrack always carries the true operating identity (BA183), even though this fixture
    // happens to have been queried under that same number.
    expect(extractOperatingFlightNumber(FIXTURE)).toBe('BA183');
  });

  it('returns null when no __NEXT_DATA__ is present', () => {
    expect(extractOperatingFlightNumber('<html></html>')).toBeNull();
  });

  it('still resolves to the operating number when queried under the marketing number', () => {
    // Querying FlightStats as "AA6942" (American Airlines' marketing number) resolves to the
    // same flightId, with flexTrack still reporting the true operator (BA183).
    expect(extractOperatingFlightNumber(MARKETING_CODESHARE_FIXTURE)).toBe('BA183');
  });
});

describe('extractCodeshareNumbers', () => {
  it('lists other marketing-carrier numbers for the same physical flight', () => {
    // BA183 is also sold under five partners' numbers.
    expect(extractCodeshareNumbers(FIXTURE)).toEqual(['AA6942', 'AS5265', 'AY5483', 'EI8883', 'IB3567']);
  });

  it('returns an empty array when no __NEXT_DATA__ is present', () => {
    expect(extractCodeshareNumbers('<html></html>')).toEqual([]);
  });
});

describe('flightstatsSource.fetch', () => {
  beforeEach(() => {
    vi.mocked(scrapeHtml).mockReset();
  });

  it('reports an error when tail-number lookup is requested', async () => {
    const result = await flightstatsSource.fetch({ type: 'tail', query: 'G-VIIW', date: '2026-11-17' });
    expect(result.error).toBeTruthy();
    expect(scrapeHtml).not.toHaveBeenCalled();
  });

  it('builds the URL from the split flight number and date', async () => {
    vi.mocked(scrapeHtml).mockResolvedValue(FIXTURE);

    await flightstatsSource.fetch({ type: 'number', query: 'BA183', date: '2026-11-17' });

    expect(scrapeHtml).toHaveBeenCalledWith(
      'https://www.flightstats.com/v2/flight-tracker/BA/183?year=2026&month=11&date=17'
    );
  });

  it('reports an error when the page has no extractable flight data', async () => {
    vi.mocked(scrapeHtml).mockResolvedValue('<html>no data</html>');
    const result = await flightstatsSource.fetch({ type: 'number', query: 'BA183', date: '2026-11-17' });
    expect(result.error).toBeTruthy();
  });

  it('sets operatingFlightNumber and codeshareFlightNumbers on a successful result', async () => {
    vi.mocked(scrapeHtml).mockResolvedValue(FIXTURE);
    const result = await flightstatsSource.fetch({ type: 'number', query: 'BA183', date: '2026-11-17' });
    expect(result.operatingFlightNumber).toBe('BA183');
    expect(result.codeshareFlightNumbers).toEqual(['AA6942', 'AS5265', 'AY5483', 'EI8883', 'IB3567']);
  });
});
