import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFlightAwareFields, flightAwareIdent, flightawareSource, parseTrackpoll } from '../../src/sources/flightaware.js';
import { scrapeHtml } from '../../src/scrape.js';

vi.mock('../../src/scrape.js', () => ({ scrapeHtml: vi.fn() }));

// Trimmed from the live UAL1 page on 2026-11-17: the current instance (airborne) plus an
// activity log of four instances. SFO departs 22:40 local, so each is dated the day before UTC.
const FIXTURE = readFileSync('tests/fixtures/flightaware-ual1.html', 'utf-8');
const run = (date: string, query = 'UA1') => flightawareSource.fetch({ type: 'number', query, date });

describe('parseTrackpoll', () => {
  it('returns the current instance followed by the activity log', () => {
    expect(parseTrackpoll(FIXTURE)).toHaveLength(5);
  });

  it('returns nothing when the page has no embedded state', () => {
    expect(parseTrackpoll('<html>no data</html>')).toEqual([]);
  });
});

describe('extractFlightAwareFields', () => {
  it('maps a completed instance with gate and runway times, gates and terminals', () => {
    const done = parseTrackpoll(FIXTURE).find((f) => f.gateDepartureTimes?.actual === Date.parse('2026-11-14T07:13:00Z') / 1000)!;
    const v = Object.fromEntries(Object.entries(extractFlightAwareFields(done)).map(([k, x]) => [k, x!.value]));
    expect(v).toMatchObject({
      origin: 'SFO',
      destination: 'SIN',
      scheduledDeparture: '2026-11-14T06:40:00.000Z',
      gateDeparture: '2026-11-14T07:13:00.000Z',
      actualDeparture: '2026-11-14T07:39:00.000Z', // takeoff
      actualArrival: '2026-11-15T00:06:00.000Z', // touchdown
      gateArrival: '2026-11-15T00:18:00.000Z',
      status: 'Arrived',
      aircraftType: 'B789',
      departureGate: 'G6',
      departureTerminal: 'I',
      arrivalGate: 'F41',
    });
    expect(v.estimatedArrival).toBeUndefined();
  });
});

describe('flightAwareIdent', () => {
  it('converts IATA flight numbers to the ICAO ident FlightAware needs', () => {
    expect(flightAwareIdent('UA1')).toBe('UAL1');
    expect(flightAwareIdent('ba 117')).toBe('BAW117');
    expect(flightAwareIdent('UAL1')).toBe('UAL1');
  });
});

describe('flightawareSource.fetch', () => {
  beforeEach(() => vi.mocked(scrapeHtml).mockReset());

  it('requests the ICAO page and picks the instance departing on the local query date', async () => {
    vi.mocked(scrapeHtml).mockResolvedValue(FIXTURE);
    const result = await run('2026-11-13');

    expect(scrapeHtml).toHaveBeenCalledWith('https://www.flightaware.com/live/flight/UAL1');
    expect(result.error).toBeUndefined();
    expect(result.fields.gateArrival?.value).toBe('2026-11-15T00:18:00.000Z');
  });

  it('reports a date with no instance', async () => {
    vi.mocked(scrapeHtml).mockResolvedValue(FIXTURE);
    expect((await run('2026-10-01')).error).toBe('no UAL1 departing 2026-10-01 among 5 instances');
  });

  it('retries a page without embedded state, then reports it', async () => {
    vi.mocked(scrapeHtml).mockResolvedValue('<html>never renders</html>');
    const result = await run('2026-11-13');
    expect(scrapeHtml).toHaveBeenCalledTimes(3);
    expect(result.error).toBe('no flight data on the page after 3 attempts');
  });

  it('recovers when a retry returns the full page', async () => {
    vi.mocked(scrapeHtml).mockResolvedValueOnce('<html></html>').mockResolvedValueOnce(FIXTURE);
    const result = await run('2026-11-13');
    expect(scrapeHtml).toHaveBeenCalledTimes(2);
    expect(result.fields.departureGate?.value).toBe('G6');
  });

  it('rejects tail-number queries', async () => {
    const result = await flightawareSource.fetch({ type: 'tail', query: 'N12345', date: '2026-11-13' });
    expect(result.error).toMatch(/tail/);
    expect(scrapeHtml).not.toHaveBeenCalled();
  });
});
