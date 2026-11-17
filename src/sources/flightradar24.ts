import * as cheerio from 'cheerio';
import type { FlightQuery, SourceFetcher, SourceResult } from '../types.js';
import { scrapeHtml } from '../scrape.js';

// Flightradar24's flight page (/data/flights/<ident>) is an Inertia.js app: the server embeds
// the whole flight history as JSON in `#app[data-page]` (props.flights), one entry per date the
// flight operates, a week either side of today. Times are Unix epoch seconds (UTC). Rewritten
// 2026-11-17 after FR24 dropped the old server-rendered #tbl-datatable table.
interface Fr24Flight {
  callsign: string | null;
  scheduledDeparture: number | null;
  actualDeparture: number | null;
  scheduledArrival: number | null;
  estimatedDeparture: number | null;
  /** Once landed, the touchdown time. */
  estimatedArrival: number | null;
  status: { name: string } | null;
  origin: { iata: string; timezone: string } | null;
  destination: { iata: string; timezone: string } | null;
  divertedTo: { iata: string } | null;
  /** Timetabled flights carry an IATA type code ("320") and no typeUrl until a plane is assigned. */
  aircraft: { type: string | null; registration: string | null; typeUrl: string | null } | null;
}

/** The flight list from the page's Inertia payload, or null when the page has none (a block page). */
export function parseFlightradar24History(html: string): Fr24Flight[] | null {
  const raw = cheerio.load(html)('#app').attr('data-page');
  if (!raw) return null;
  try {
    const flights = JSON.parse(raw)?.props?.flights;
    return Array.isArray(flights) ? flights : null;
  } catch {
    return null;
  }
}

const toIso = (epoch: number | null | undefined): string | null => (epoch ? new Date(epoch * 1000).toISOString() : null);

const localDate = (iso: string, tz: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));

/**
 * The flight's date is its local departure date at the origin (how airlines and FlightQuery
 * name it), which for early-morning departures east of UTC (an AUH 03:25 departure is 23:25Z the day
 * before) differs from the UTC date.
 */
const departsOn = (f: Fr24Flight, targetDate: string): boolean => {
  const std = toIso(f.scheduledDeparture);
  return !!std && localDate(std, f.origin?.timezone || 'UTC') === targetDate;
};

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function fieldsOf(f: Fr24Flight): SourceResult['fields'] {
  const statusName = f.status?.name ?? '';
  const landed = statusName === 'landed';
  const assigned = !!f.aircraft?.typeUrl;
  const status = f.divertedTo ? 'Diverted' : statusName && statusName !== 'estimated' ? capitalize(statusName) : null;
  const actualDeparture = toIso(f.actualDeparture);

  const entries: [keyof SourceResult['fields'], string | null | undefined][] = [
    ['origin', f.origin?.iata],
    ['destination', f.destination?.iata],
    ['tailNumber', f.aircraft?.registration],
    ['aircraftType', assigned ? f.aircraft?.type : null],
    ['callsign', f.callsign],
    ['scheduledDeparture', toIso(f.scheduledDeparture)],
    ['actualDeparture', actualDeparture],
    ['estimatedDeparture', actualDeparture ? null : toIso(f.estimatedDeparture)],
    ['scheduledArrival', toIso(f.scheduledArrival)],
    [landed ? 'actualArrival' : 'estimatedArrival', toIso(f.estimatedArrival)],
    ['status', status],
  ];
  return Object.fromEntries(
    entries.filter(([, v]) => !!v).map(([k, v]) => [k, { value: v as string, paywalled: false, raw: v as string }])
  );
}

export function extractFlightradar24Fields(html: string, targetDate: string): SourceResult['fields'] {
  const match = (parseFlightradar24History(html) ?? []).find((f) => departsOn(f, targetDate));
  return match ? fieldsOf(match) : {};
}

export const flightradar24Source: SourceFetcher = {
  id: 'flightradar24',
  async fetch(query: FlightQuery): Promise<SourceResult> {
    const fetchedAt = new Date().toISOString();
    if (query.type !== 'number') {
      return { source: 'flightradar24', fetchedAt, fields: {}, error: 'tail-number lookup not implemented for flightradar24' };
    }

    const ident = query.query.toLowerCase().replace(/\s+/g, '');
    try {
      const html = await scrapeHtml(`https://www.flightradar24.com/data/flights/${ident}`);
      if (!parseFlightradar24History(html)) {
        return { source: 'flightradar24', fetchedAt, fields: {}, error: 'no flight-history payload on the page' };
      }
      const fields = extractFlightradar24Fields(html, query.date);
      if (Object.keys(fields).length === 0) {
        return { source: 'flightradar24', fetchedAt, fields, error: `no flight history entry for ${query.date}` };
      }
      return { source: 'flightradar24', fetchedAt, fields };
    } catch (err) {
      return { source: 'flightradar24', fetchedAt, fields: {}, error: (err as Error).message };
    }
  },
};
