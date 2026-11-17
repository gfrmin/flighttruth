import { describe, it, expect, vi } from 'vitest';
import { parseGoogleCard, extractGoogleFields, makeGoogleSerpSource } from '../../src/sources/googleSerp.js';
import { localToUtc } from '../../src/time.js';

// Real card text captured 2026-11-07 (whitespace-collapsed body text of the results page).
const EY104_EN_ROUTE =
  'Search Results Flight status Etihad EY 104 Abu Dhabi to Tel Aviv-Yafo Fri, Nov 6Sat, Nov 7Sun, Nov 8Mon, Nov 9 3:25 AM EY 104 to Tel Aviv-Yafo TLV Arriving late AUH Airport info TLV Airport info Abu Dhabi · Sat, Nov 7 Departed 3:29 AM Originally scheduled departure: 3:25 AM 3:25 AM Terminal A Gate A1 Tel Aviv-Yafo · Sat, Nov 7 Estimated arrival 5:37 AM Originally scheduled arrival: 5:05 AM 5:05 AM Terminal 3 Gate - Updated 25m ago · Source: Cirium Showing local airport times Web results';
const EY103_SCHEDULED =
  'Search Results Flight status Etihad EY 103 Hong Kong to Abu Dhabi Fri, Nov 6Sat, Nov 7Sun, Nov 8Mon, Nov 9 19:45 EY 103 to Abu Dhabi AUH Departing on time HKG Airport info 8h 45m flight. 8h 45m AUH Airport info Hong Kong · Sat, Nov 7 Scheduled departure 19:45 Terminal 1 Gate - Abu Dhabi · Sun, Nov 8 Scheduled arrival 00:30 Terminal A Gate - Updated 1h 24m ago · Source: Cirium Showing local airport times';

const values = (fields: ReturnType<typeof extractGoogleFields>) =>
  Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v!.value]));

describe('localToUtc', () => {
  it('converts 12h and 24h wall-clock times in the airport zone', () => {
    expect(localToUtc('2026-11-07', '3:29 AM', 'Asia/Dubai')).toBe('2026-11-06T23:29:00.000Z');
    expect(localToUtc('2026-11-07', '19:45', 'Asia/Hong_Kong')).toBe('2026-11-07T11:45:00.000Z');
    expect(localToUtc('2026-11-07', '12:10 AM', 'Asia/Jerusalem')).toBe('2026-11-06T22:10:00.000Z');
    expect(localToUtc('2026-11-07', '12:10 PM', 'UTC')).toBe('2026-11-07T12:10:00.000Z');
    expect(localToUtc('2026-11-07', '3:25 am', 'Asia/Dubai')).toBe('2026-11-06T23:25:00.000Z');
    expect(localToUtc('2026-11-07', '03.25', 'Asia/Dubai')).toBe('2026-11-06T23:25:00.000Z');
  });
});

describe('parseGoogleCard', () => {
  it('reads an airborne flight: gate departure, estimated arrival, gates', () => {
    const card = parseGoogleCard(EY104_EN_ROUTE, '2026-11-07')!;
    expect(values(extractGoogleFields(card))).toEqual({
      origin: 'AUH',
      destination: 'TLV',
      scheduledDeparture: '2026-11-06T23:25:00.000Z',
      gateDeparture: '2026-11-06T23:29:00.000Z',
      scheduledArrival: '2026-11-07T03:05:00.000Z',
      estimatedArrival: '2026-11-07T03:37:00.000Z',
      status: 'En Route',
      departureTerminal: 'A',
      departureGate: 'A1',
      arrivalTerminal: '3',
    });
  });

  it('reads a scheduled flight with 24h times arriving the next day', () => {
    const card = parseGoogleCard(EY103_SCHEDULED, '2026-11-07')!;
    expect(card.departure.date).toBe('2026-11-07');
    expect(card.arrival.date).toBe('2026-11-08');
    expect(values(extractGoogleFields(card))).toEqual({
      origin: 'HKG',
      destination: 'AUH',
      scheduledDeparture: '2026-11-07T11:45:00.000Z',
      scheduledArrival: '2026-11-07T20:30:00.000Z',
      status: 'Scheduled',
      departureTerminal: '1',
      arrivalTerminal: 'A',
    });
  });

  it('places the card date in the year nearest the query date', () => {
    const jan = EY103_SCHEDULED.replace('Sat, Nov 7 Scheduled', 'Fri, Jan 1 Scheduled');
    expect(parseGoogleCard(jan, '2026-12-31')!.departure.date).toBe('2027-01-01');
  });

  it('reads UK-style dates and lowercase/dotted times from other exit-node locales', () => {
    const uk = EY104_EN_ROUTE.replaceAll('Sat, Nov 7', 'Sat, 7 Nov').replaceAll(' AM', ' am');
    const dotted = EY104_EN_ROUTE.replaceAll('3:29 AM', '03.29').replaceAll('3:25 AM', '03.25');
    for (const text of [uk, dotted]) {
      const fields = values(extractGoogleFields(parseGoogleCard(text, '2026-11-07')!));
      expect(fields.gateDeparture).toBe('2026-11-06T23:29:00.000Z');
      expect(fields.scheduledDeparture).toBe('2026-11-06T23:25:00.000Z');
    }
  });

  it('returns null when there is no flight card', () => {
    expect(parseGoogleCard('Web results EY103 - Flightradar24', '2026-11-07')).toBeNull();
  });
});

const page = (text: string) => `<html><body><div>${text}</div><script>var x="Flight status"</script></body></html>`;
const response = (body: string, headers: Record<string, string> = {}) =>
  ({ ok: true, status: 200, headers: new Headers(headers), text: async () => body }) as unknown as Response;

describe('extractGoogleFields', () => {
  it('puts a departure just after midnight on the day after a late-evening schedule', () => {
    const mv = (o: object) => ({ date: '2026-11-11', terminal: null, gate: null, baggage: null, ...o });
    const fields = extractGoogleFields({
      origin: 'HKG', destination: 'ZRH', cancelled: false,
      departure: mv({ label: 'Departed', time: '00:00', scheduled: '23:30' }),
      arrival: mv({ date: '2026-11-12', label: 'Estimated arrival', time: '06:30', scheduled: '06:10' }),
    } as any);
    expect(fields.gateDeparture?.value).toBe('2026-11-11T16:00:00.000Z');
    expect(fields.estimatedArrival?.value).toBe('2026-11-12T05:30:00.000Z');
  });
});

describe('makeGoogleSerpSource', () => {
  it('posts the Google URL to the SERP zone and parses the card', async () => {
    const fetchImpl = vi.fn(async (_u: string, _i?: RequestInit) => response(page(EY104_EN_ROUTE)));
    const result = await makeGoogleSerpSource('k', 'serp_api1', fetchImpl as unknown as typeof fetch)
      .fetch({ type: 'number', query: 'ey 104', date: '2026-11-07' });

    expect(result.error).toBeUndefined();
    expect(result.fields.estimatedArrival?.value).toBe('2026-11-07T03:37:00.000Z');
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.brightdata.com/request');
    const body = JSON.parse(init!.body as string);
    expect(body.zone).toBe('serp_api1');
    expect(new URL(body.url).searchParams.get('q')).toBe('EY104 flight status');
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer k');
  });

  it('refuses a card for a different day than the query', async () => {
    const result = await makeGoogleSerpSource('k', 'z', vi.fn(async () => response(page(EY104_EN_ROUTE))) as unknown as typeof fetch)
      .fetch({ type: 'number', query: 'EY104', date: '2026-11-08' });
    expect(result.error).toBe('card shows the 2026-11-07 flight');
  });

  it('surfaces Bright Data errors that arrive as headers on a 200', async () => {
    const result = await makeGoogleSerpSource('k', 'z', vi.fn(async () => response('', { 'x-brd-error': 'Auth Failed (code: ip_forbidden)' })) as unknown as typeof fetch)
      .fetch({ type: 'number', query: 'EY104', date: '2026-11-07' });
    expect(result.error).toBe('Bright Data: Auth Failed (code: ip_forbidden)');
  });
});
