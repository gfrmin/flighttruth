import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFlightradar24Fields, flightradar24Source } from '../../src/sources/flightradar24.js';
import { scrapeHtml } from '../../src/scrape.js';

vi.mock('../../src/scrape.js', () => ({ scrapeHtml: vi.fn() }));

// Captured live 2026-11-17 from /data/flights/<ident>; the page's #app data-page payload,
// trimmed to the flight list.
const KL1001 = readFileSync('tests/fixtures/flightradar24-kl1001-history.html', 'utf-8');
const EMPTY = readFileSync('tests/fixtures/flightradar24-empty-history.html', 'utf-8');

const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const page = (flights: unknown[]) =>
  `<div id="app" data-page="${escapeAttr(JSON.stringify({ component: 'Data/FlightHistory', props: { flights } }))}"></div>`;
const flight = (scheduledDeparture: string, registration: string) => ({
  activeDay: scheduledDeparture.slice(0, 10),
  scheduledDeparture: Date.parse(scheduledDeparture) / 1000,
  scheduledArrival: Date.parse(scheduledDeparture) / 1000 + 4 * 3600,
  actualDeparture: null, estimatedDeparture: null, estimatedArrival: null, callsign: null,
  status: { name: 'scheduled' },
  origin: { iata: 'AUH', timezone: 'Asia/Dubai' },
  destination: { iata: 'TLV', timezone: 'Asia/Jerusalem' },
  divertedTo: null,
  aircraft: { type: 'A21N', registration, typeUrl: 'a21n' },
});

describe('extractFlightradar24Fields', () => {
  it('reads a landed flight: aircraft, callsign, takeoff and touchdown', () => {
    const fields = extractFlightradar24Fields(KL1001, '2026-11-17');
    expect(fields.origin?.value).toBe('AMS');
    expect(fields.destination?.value).toBe('LHR');
    expect(fields.tailNumber?.value).toBe('PH-NXM');
    expect(fields.aircraftType?.value).toBe('E295');
    expect(fields.callsign?.value).toBe('KLM31A');
    expect(fields.scheduledDeparture?.value).toBe('2026-11-17T06:20:00.000Z');
    expect(fields.actualDeparture?.value).toBe('2026-11-17T07:50:54.000Z');
    expect(fields.scheduledArrival?.value).toBe('2026-11-17T07:40:00.000Z');
    expect(fields.actualArrival?.value).toBe('2026-11-17T08:57:13.000Z');
    expect(fields.status?.value).toBe('Landed');
    expect(fields.estimatedDeparture).toBeUndefined();
    expect(fields.estimatedArrival).toBeUndefined();
  });

  it('reads estimates for a flight that has not departed yet', () => {
    const fields = extractFlightradar24Fields(KL1001, '2026-11-18');
    expect(fields.origin?.value).toBe('AMS');
    expect(fields.tailNumber?.value).toBe('PH-NXZ');
    expect(fields.aircraftType?.value).toBe('E295');
    expect(fields.estimatedDeparture?.value).toBe('2026-11-18T06:20:00.000Z');
    expect(fields.actualDeparture).toBeUndefined();
    expect(fields.actualArrival).toBeUndefined();
    expect(fields.status).toBeUndefined();
  });

  it('leaves out the IATA type code of a timetabled flight with no aircraft assigned', () => {
    const fields = extractFlightradar24Fields(KL1001, '2026-11-24');
    expect(fields.status?.value).toBe('Scheduled');
    expect(fields.tailNumber).toBeUndefined();
    expect(fields.aircraftType).toBeUndefined();
  });

  it('matches on the local departure date at the origin, not the UTC date', () => {
    // AUH 03:25 local = 23:25Z the previous day.
    const html = page([flight('2026-11-07T23:25:00Z', 'A6-TOMORROW'), flight('2026-11-06T23:25:00Z', 'A6-XDD')]);
    expect(extractFlightradar24Fields(html, '2026-11-07').tailNumber?.value).toBe('A6-XDD');
  });

  it('returns an empty object when no flight matches the requested date', () => {
    expect(extractFlightradar24Fields(KL1001, '2099-01-01')).toEqual({});
    expect(extractFlightradar24Fields(EMPTY, '2026-11-17')).toEqual({});
  });
});

describe('flightradar24Source.fetch', () => {
  beforeEach(() => {
    vi.mocked(scrapeHtml).mockReset();
  });

  it('reports an error when tail-number lookup is requested', async () => {
    const result = await flightradar24Source.fetch({ type: 'tail', query: 'G-VIIW', date: '2026-11-17' });
    expect(result.error).toBeTruthy();
    expect(scrapeHtml).not.toHaveBeenCalled();
  });

  it('reports an error when no flight matches the requested date', async () => {
    vi.mocked(scrapeHtml).mockResolvedValue(KL1001);
    const result = await flightradar24Source.fetch({ type: 'number', query: 'KL1001', date: '2099-01-01' });
    expect(result.error).toBeTruthy();
    expect(result.fields).toEqual({});
  });

  it('reports an error when the page has no flight-history payload', async () => {
    vi.mocked(scrapeHtml).mockResolvedValue('<html><body>Just a moment...</body></html>');
    const result = await flightradar24Source.fetch({ type: 'number', query: 'KL1001', date: '2026-11-17' });
    expect(result.error).toMatch(/payload/);
  });

  it('extracts fields for a matching date', async () => {
    vi.mocked(scrapeHtml).mockResolvedValue(KL1001);
    const result = await flightradar24Source.fetch({ type: 'number', query: 'KL1001', date: '2026-11-17' });
    expect(result.error).toBeUndefined();
    expect(result.fields.tailNumber?.value).toBe('PH-NXM');
  });
});
