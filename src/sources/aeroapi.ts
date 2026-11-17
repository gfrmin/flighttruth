import type { FieldName, FieldValue, FlightQuery, SourceFetcher, SourceResult } from '../types.js';

// FlightAware AeroAPI v4 (licensed JSON API; the Personal tier has a small free monthly
// allowance). Field names follow the published OpenAPI spec for GET /flights/{ident}.
interface AeroApiAirport {
  code_iata?: string | null;
  timezone?: string | null;
}

export interface AeroApiFlight {
  ident?: string;
  ident_iata?: string | null;
  operator_iata?: string | null;
  codeshares_iata?: string[] | null;
  origin?: AeroApiAirport | null;
  destination?: AeroApiAirport | null;
  scheduled_out?: string | null;
  estimated_out?: string | null;
  actual_out?: string | null;
  actual_off?: string | null;
  scheduled_in?: string | null;
  estimated_in?: string | null;
  actual_in?: string | null;
  actual_on?: string | null;
  status?: string | null;
  registration?: string | null;
  aircraft_type?: string | null;
  gate_origin?: string | null;
  terminal_origin?: string | null;
  gate_destination?: string | null;
  terminal_destination?: string | null;
  baggage_claim?: string | null;
  cancelled?: boolean;
  diverted?: boolean;
}

const BASE_URL = 'https://aeroapi.flightaware.com/aeroapi';
const DAY_MS = 24 * 60 * 60 * 1000;

const isoNoMillis = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');

/** A UTC window wide enough to hold the query date's local day in any timezone (UTC-12..+14). */
export function aeroApiWindow(date: string): { start: string; end: string } {
  const midnight = Date.parse(`${date}T00:00:00Z`);
  return { start: isoNoMillis(midnight - 14 * 3600_000), end: isoNoMillis(midnight + DAY_MS + 14 * 3600_000) };
}

const localDate = (utc: string, tz: string | null | undefined): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(utc));

const departsOn = (date: string) => (f: AeroApiFlight): boolean =>
  !!f.scheduled_out && localDate(f.scheduled_out, f.origin?.timezone) === date;

const statusOf = (f: AeroApiFlight): string | null =>
  f.cancelled ? 'Cancelled' : f.diverted ? 'Diverted' : f.status ?? null;

const FIELD_MAP: [FieldName, (f: AeroApiFlight) => string | null | undefined][] = [
  ['origin', (f) => f.origin?.code_iata],
  ['destination', (f) => f.destination?.code_iata],
  ['scheduledDeparture', (f) => f.scheduled_out],
  ['estimatedDeparture', (f) => f.estimated_out],
  // *_out/*_in are gate times (pushback, on-blocks); *_off/*_on are runway times.
  ['gateDeparture', (f) => f.actual_out],
  ['actualDeparture', (f) => f.actual_off],
  ['scheduledArrival', (f) => f.scheduled_in],
  ['estimatedArrival', (f) => f.estimated_in],
  ['gateArrival', (f) => f.actual_in],
  ['actualArrival', (f) => f.actual_on],
  ['status', statusOf],
  ['tailNumber', (f) => f.registration],
  ['aircraftType', (f) => f.aircraft_type],
  ['departureGate', (f) => f.gate_origin],
  ['departureTerminal', (f) => f.terminal_origin],
  ['arrivalGate', (f) => f.gate_destination],
  ['arrivalTerminal', (f) => f.terminal_destination],
  ['baggage', (f) => f.baggage_claim],
];

export function extractAeroApiFields(f: AeroApiFlight): SourceResult['fields'] {
  return Object.fromEntries(
    FIELD_MAP.flatMap(([field, get]): [FieldName, FieldValue][] => {
      const value = get(f);
      return value ? [[field, { value, paywalled: false, raw: value }]] : [];
    })
  );
}

const identFor = (q: FlightQuery) => q.query.toUpperCase().replace(/[\s-]+/g, '');

export function makeAeroApiSource(apiKey: string, fetchImpl: typeof fetch = fetch): SourceFetcher {
  return {
    id: 'aeroapi',
    async fetch(query: FlightQuery): Promise<SourceResult> {
      const fetchedAt = new Date().toISOString();
      const fail = (error: string): SourceResult => ({ source: 'aeroapi', fetchedAt, fields: {}, error });
      try {
        const ident = identFor(query);
        const url = new URL(`${BASE_URL}/flights/${encodeURIComponent(ident)}`);
        url.searchParams.set('ident_type', query.type === 'tail' ? 'registration' : 'designator');
        const { start, end } = aeroApiWindow(query.date);
        url.searchParams.set('start', start);
        url.searchParams.set('end', end);

        const res = await fetchImpl(url.toString(), { headers: { 'x-apikey': apiKey, Accept: 'application/json' } });
        if (!res.ok) return fail(`HTTP ${res.status}`);
        const { flights = [] } = (await res.json()) as { flights?: AeroApiFlight[] };

        const match = flights.find(departsOn(query.date));
        if (!match) return fail(`no ${ident} departing ${query.date} (${flights.length} instances in window)`);

        return {
          source: 'aeroapi',
          fetchedAt,
          fields: extractAeroApiFields(match),
          ...(match.ident_iata ? { operatingFlightNumber: match.ident_iata } : {}),
          codeshareFlightNumbers: match.codeshares_iata ?? [],
        };
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  };
}
