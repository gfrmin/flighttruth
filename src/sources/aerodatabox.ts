import type { FieldName, FieldValue, FlightQuery, SourceFetcher, SourceResult } from '../types.js';

// AeroDataBox via RapidAPI (free Basic plan). Field names follow its OpenAPI spec
// (FlightContract / FlightAirportMovementContract). Times come as "YYYY-MM-DD HH:mmZ" (utc)
// and "YYYY-MM-DD HH:mm+hh:mm" (local); normalize.ts canonicalises the utc form.
interface AdbTime {
  utc: string;
  local: string;
}

interface AdbMovement {
  airport?: { iata?: string | null } | null;
  scheduledTime?: AdbTime | null;
  revisedTime?: AdbTime | null;
  predictedTime?: AdbTime | null;
  runwayTime?: AdbTime | null;
  terminal?: string | null;
  gate?: string | null;
  checkInDesk?: string | null;
  baggageBelt?: string | null;
}

export interface AdbFlight {
  number?: string;
  status?: string;
  airline?: { name?: string | null } | null;
  aircraft?: { reg?: string | null; model?: string | null } | null;
  departure: AdbMovement;
  arrival: AdbMovement;
}

const HOST = 'aerodatabox.p.rapidapi.com';

// AeroDataBox's revisedTime is "the latest known" gate time: an estimate before the movement,
// the actual (pushback / on-blocks) after it; runwayTime is wheels-off / touchdown. The flight
// status says which side of the movement we are on.
const DEPARTED = new Set(['Departed', 'EnRoute', 'Approaching', 'Arrived', 'Diverted']);
const ARRIVED = new Set(['Arrived']);

const STATUS_LABEL: Record<string, string> = {
  EnRoute: 'En Route',
  CheckIn: 'Check-in',
  GateClosed: 'Gate Closed',
  Canceled: 'Cancelled',
  CanceledUncertain: 'Cancelled (uncertain)',
};

const latest = (m: AdbMovement) => m.revisedTime?.utc ?? m.predictedTime?.utc ?? null;

function fieldGetters(f: AdbFlight): [FieldName, string | null | undefined][] {
  const status = f.status ?? 'Unknown';
  const departed = DEPARTED.has(status);
  const arrived = ARRIVED.has(status);
  return [
    ['airline', f.airline?.name],
    ['origin', f.departure.airport?.iata],
    ['destination', f.arrival.airport?.iata],
    ['scheduledDeparture', f.departure.scheduledTime?.utc],
    [departed ? 'gateDeparture' : 'estimatedDeparture', latest(f.departure)],
    ['actualDeparture', f.departure.runwayTime?.utc],
    ['scheduledArrival', f.arrival.scheduledTime?.utc],
    [arrived ? 'gateArrival' : 'estimatedArrival', latest(f.arrival)],
    ['actualArrival', f.arrival.runwayTime?.utc],
    ['status', status === 'Unknown' ? null : STATUS_LABEL[status] ?? status],
    ['tailNumber', f.aircraft?.reg],
    ['aircraftType', f.aircraft?.model],
    ['departureTerminal', f.departure.terminal],
    ['departureGate', f.departure.gate],
    ['arrivalTerminal', f.arrival.terminal],
    ['arrivalGate', f.arrival.gate],
    ['baggage', f.arrival.baggageBelt],
  ];
}

export function extractAdbFields(f: AdbFlight): SourceResult['fields'] {
  return Object.fromEntries(
    fieldGetters(f).flatMap(([field, value]): [FieldName, FieldValue][] =>
      value ? [[field, { value, paywalled: false, raw: value }]] : []
    )
  );
}

const compact = (s: string) => s.toUpperCase().replace(/[\s-]+/g, '');

export function makeAeroDataBoxSource(apiKey: string, fetchImpl: typeof fetch = fetch): SourceFetcher {
  return {
    id: 'aerodatabox',
    async fetch(query: FlightQuery): Promise<SourceResult> {
      const fetchedAt = new Date().toISOString();
      const fail = (error: string): SourceResult => ({ source: 'aerodatabox', fetchedAt, fields: {}, error });
      try {
        const ident = compact(query.query);
        const searchBy = query.type === 'tail' ? 'reg' : 'number';
        const url = new URL(`https://${HOST}/flights/${searchBy}/${encodeURIComponent(ident)}/${query.date}`);
        url.searchParams.set('dateLocalRole', 'Departure');
        url.searchParams.set('withAircraftImage', 'false');
        url.searchParams.set('withLocation', 'false');

        const res = await fetchImpl(url.toString(), { headers: { 'X-RapidAPI-Key': apiKey, 'X-RapidAPI-Host': HOST } });
        if (!res.ok) return fail(`HTTP ${res.status}`);
        // 204 No Content is how AeroDataBox says "no such flight on that date".
        const flights = res.status === 204 ? [] : ((await res.json()) as AdbFlight[]);

        const match = flights.find((f) => f.departure.scheduledTime?.local.startsWith(query.date));
        if (!match) return fail(`no ${ident} departing ${query.date}`);
        return { source: 'aerodatabox', fetchedAt, fields: extractAdbFields(match) };
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  };
}
