import type { FieldName, FieldValue, FlightQuery, SourceFetcher, SourceResult } from '../types.js';
import { scrapeHtml } from '../scrape.js';
import { iataToIcaoAirlineCode, splitFlightNumber } from '../airlineCodes.js';

// FlightAware's flight page embeds its full client state as `var trackpollBootstrap = {...}`:
// the current instance plus an activity log of recent and upcoming instances, each with gate
// and runway times (scheduled/estimated/actual, epoch seconds), terminals, gates and aircraft.
// Verified live 2026-11-17 against UAL1; the old SEO <meta> tags are no longer rendered.
//
// The page must be requested by ICAO ident (UAL1). Through the Web Unlocker the IATA form
// (e.g. UA1) is not redirected and serves an "Unknown Flight" page with an INVALID placeholder.

interface FaTimes {
  scheduled: number | null;
  estimated: number | null;
  actual: number | null;
}

interface FaAirport {
  TZ?: string | null; // ":Asia/Hong_Kong"
  iata?: string | null;
  gate?: string | null;
  terminal?: string | null;
}

export interface FaFlight {
  origin: FaAirport;
  destination: FaAirport;
  flightStatus?: string | null;
  cancelled?: boolean;
  diverted?: boolean;
  gateDepartureTimes?: FaTimes | null;
  gateArrivalTimes?: FaTimes | null;
  takeoffTimes?: FaTimes | null;
  landingTimes?: FaTimes | null;
  aircraft?: { type?: string | null; tail?: string | null; friendlyType?: string | null } | null;
  aircraftType?: string | null;
  activityLog?: { flights?: FaFlight[] } | null;
}

/** The current instance followed by the activity log's instances. */
export function parseTrackpoll(html: string): FaFlight[] {
  const m = html.match(/var trackpollBootstrap = (\{.*?\});\s*<\/script>/s);
  if (!m) return [];
  const { flights = {} } = JSON.parse(m[1]) as { flights?: Record<string, FaFlight> };
  return Object.values(flights)
    .filter((f) => f.origin && f.destination)
    .flatMap((f) => [f, ...(f.activityLog?.flights ?? [])]);
}

const iso = (s: number | null | undefined) => (s ? new Date(s * 1000).toISOString() : null);

const localDate = (epochS: number, tz: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(epochS * 1000));

const departsOn = (date: string) => (f: FaFlight): boolean => {
  const std = f.gateDepartureTimes?.scheduled;
  return !!std && localDate(std, (f.origin.TZ ?? 'UTC').replace(/^:/, '')) === date;
};

const statusOf = (f: FaFlight): string | null => {
  if (f.cancelled) return 'Cancelled';
  if (f.diverted) return 'Diverted';
  const s = f.flightStatus?.trim();
  return s ? s[0].toUpperCase() + s.slice(1) : null;
};

/** Estimated times only while there is no actual, matching what the other sources report. */
const estimate = (t: FaTimes | null | undefined) => (t?.actual ? null : iso(t?.estimated));

export function extractFlightAwareFields(f: FaFlight): SourceResult['fields'] {
  const entries: [FieldName, string | null | undefined][] = [
    ['origin', f.origin.iata],
    ['destination', f.destination.iata],
    ['scheduledDeparture', iso(f.gateDepartureTimes?.scheduled)],
    ['estimatedDeparture', estimate(f.gateDepartureTimes)],
    ['gateDeparture', iso(f.gateDepartureTimes?.actual)],
    ['actualDeparture', iso(f.takeoffTimes?.actual)],
    ['scheduledArrival', iso(f.gateArrivalTimes?.scheduled)],
    ['estimatedArrival', estimate(f.gateArrivalTimes)],
    ['gateArrival', iso(f.gateArrivalTimes?.actual)],
    ['actualArrival', iso(f.landingTimes?.actual)],
    ['status', statusOf(f)],
    ['aircraftType', f.aircraft?.type ?? f.aircraftType],
    ['tailNumber', f.aircraft?.tail],
    ['departureTerminal', f.origin.terminal],
    ['departureGate', f.origin.gate],
    ['arrivalTerminal', f.destination.terminal],
    ['arrivalGate', f.destination.gate],
  ];
  return Object.fromEntries(
    entries.flatMap(([k, v]): [FieldName, FieldValue][] => (v ? [[k, { value: v, paywalled: false, raw: v }]] : []))
  );
}

/** "UA1" → "UAL1"; anything unmappable (already ICAO, unknown airline) is used as given. */
export function flightAwareIdent(query: string): string {
  const ident = query.toUpperCase().replace(/[\s-]+/g, '');
  const split = splitFlightNumber(ident);
  const icao = split && iataToIcaoAirlineCode(split.code);
  return split && icao ? `${icao}${split.number.replace(/^0+(?=\d)/, '')}` : ident;
}

// The Web Unlocker occasionally returns an incompletely rendered page (proxy-session
// variance); retry a fixed number of times when the embedded state is missing.
const MAX_ATTEMPTS = 3;

export const flightawareSource: SourceFetcher = {
  id: 'flightaware',
  async fetch(query: FlightQuery): Promise<SourceResult> {
    const fetchedAt = new Date().toISOString();
    const fail = (error: string): SourceResult => ({ source: 'flightaware', fetchedAt, fields: {}, error });
    if (query.type === 'tail') return fail('tail-number lookup not supported');
    const ident = flightAwareIdent(query.query);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        const instances = parseTrackpoll(await scrapeHtml(`https://www.flightaware.com/live/flight/${ident}`));
        if (instances.length > 0) {
          const match = instances.find(departsOn(query.date));
          return match
            ? { source: 'flightaware', fetchedAt, fields: extractFlightAwareFields(match) }
            : fail(`no ${ident} departing ${query.date} among ${instances.length} instances`);
        }
        if (attempt === MAX_ATTEMPTS) return fail(`no flight data on the page after ${MAX_ATTEMPTS} attempts`);
      } catch (err) {
        if (attempt === MAX_ATTEMPTS) return fail((err as Error).message);
      }
    }
    return fail('unreachable');
  },
};
