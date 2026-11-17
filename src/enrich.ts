import * as cheerio from 'cheerio';
import { flightNumberToIcaoCallsign } from './airlineCodes.js';
import { airportTimezone } from './airports.js';

// Extras beyond "where is my flight": how this flight has run on recent days, and what the
// assigned plane has been doing (its inbound flight decides whether ours can leave on time).
// Both come from Flightradar24's server-rendered tables -- /data/flights/<ident> (one row per
// date) and /data/aircraft/<reg> (one row per flight the plane flew), which share a row format.

export interface Fr24Row {
  flight: string | null;
  tail: string | null;
  origin: string | null;
  destination: string | null;
  std: string | null;
  atd: string | null;
  sta: string | null;
  /** "Landed", "Estimated", "Scheduled", "Diverted", "Canceled", ... */
  status: string | null;
  /** Touchdown for Landed, the estimate for Estimated (dep or arr, see estimateIsDeparture). */
  statusTime: string | null;
  estimateIsDeparture: boolean;
}

const cellIso = (ts: string | undefined): string | null => {
  const n = Number(ts);
  return n ? new Date(n * 1000).toISOString() : null;
};

export function parseFr24Table(html: string): Fr24Row[] {
  const $ = cheerio.load(html);
  return $('#tbl-datatable tr[class*="data-row"]').toArray().map((row) => {
    const $row = $(row);
    const desk = $row.find('td.hidden-xs.hidden-sm');
    const airports = desk.find('a[href^="/data/airports/"]');
    const code = (i: number) => airports.eq(i).text().replace(/[()]/g, '').trim() || null;
    const timed = desk.filter((_, el) => $(el).is('[data-timestamp]') && !$(el).is('[data-time-format]') && !$(el).is('[data-prefix]'));
    const statusCell = desk.filter((_, el) => /^(Landed|Estimated|Scheduled|Diverted|Cancell?ed|Unknown)/.test($(el).text().trim())).first();
    const statusText = statusCell.text().replace(/\s+/g, ' ').trim();
    return {
      flight: desk.find('a[href^="/data/flights/"]').first().text().trim() || null,
      tail: desk.find('a[href^="/data/aircraft/"]').first().text().replace(/[()]/g, '').trim() || null,
      origin: code(0),
      destination: code(1),
      std: cellIso(timed.eq(0).attr('data-timestamp')),
      atd: cellIso(timed.eq(1).attr('data-timestamp')),
      sta: cellIso(timed.eq(2).attr('data-timestamp')),
      status: statusText.split(' ')[0] || null,
      statusTime: cellIso(statusCell.attr('data-timestamp')),
      estimateIsDeparture: /^Estimated dep/.test(statusText),
    };
  });
}

const localLabel = (iso: string, airport: string | null): string =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: (airport && airportTimezone(airport)) || 'UTC', hour: '2-digit', minute: '2-digit', weekday: 'short',
  }).format(new Date(iso)).replace(/^(\w+) (.*)$/, '$2 $1');

const minutesBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 60_000);

export interface TrackRecord {
  /** Completed flights the numbers are based on. */
  flights: number;
  /** Runway touchdown minus scheduled (gate) arrival, so slightly flattering; negative = early. */
  medianArrivalDelay: number | null;
  worstArrivalDelay: number | null;
  /** Share of flights landing no more than 15 minutes after schedule. */
  onTimePct: number | null;
  medianDepartureDelay: number | null;
  recent: { date: string; departureDelay: number | null; arrivalDelay: number | null; tail: string | null }[];
}

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
};

export function trackRecord(rows: Fr24Row[], beforeIso: string): TrackRecord {
  const done = rows.filter((r) => r.std && r.std < beforeIso && r.status === 'Landed' && r.statusTime && r.sta);
  const recent = done.map((r) => ({
    date: r.origin && airportTimezone(r.origin)
      ? new Intl.DateTimeFormat('en-CA', { timeZone: airportTimezone(r.origin)! }).format(new Date(r.std!))
      : r.std!.slice(0, 10),
    departureDelay: r.atd ? minutesBetween(r.std!, r.atd) : null,
    arrivalDelay: minutesBetween(r.sta!, r.statusTime!),
    tail: r.tail,
  }));
  const arr = recent.map((r) => r.arrivalDelay!).filter((x) => x != null);
  const dep = recent.flatMap((r) => (r.departureDelay == null ? [] : [r.departureDelay]));
  return {
    flights: recent.length,
    medianArrivalDelay: median(arr),
    worstArrivalDelay: arr.length ? Math.max(...arr) : null,
    onTimePct: arr.length ? Math.round((100 * arr.filter((d) => d <= 15).length) / arr.length) : null,
    medianDepartureDelay: median(dep),
    recent,
  };
}

export interface RotationFlight {
  flight: string | null;
  origin: string | null;
  destination: string | null;
  std: string | null;
  atd: string | null;
  sta: string | null;
  status: string | null;
  /** Landing time if landed, else the best arrival estimate, else scheduled arrival. */
  arrival: string | null;
  arrivalDelay: number | null;
  /** e.g. "16:26 Wed" at the destination, for display. */
  arrivalLocal: string | null;
}

export interface Rotation {
  /** The plane's flights before ours, most recent first (its inbound is [0]). */
  previous: RotationFlight[];
  /** Minutes on the ground between the inbound's arrival and our scheduled departure. */
  turnMinutes: number | null;
  /** Rough minimum turnaround for the type; below it, our departure will likely slip. */
  minTurnMinutes: number;
  tight: boolean;
}

// Rough minimum turnarounds by size: widebodies need ~75-90 min, narrowbodies ~35-45.
export function minTurnFor(aircraftType: string | null): number {
  return /7[4678]7|7[4678][0-9A-Z]\b|A3[3-8]\d|A3[3-8][0-9A-Z]?\b|B7[4-8]\d|77W/i.test(aircraftType ?? '') ? 75 : 35;
}

const asRotationFlight = (r: Fr24Row): RotationFlight => {
  const arrival = r.status === 'Landed' ? r.statusTime
    : r.status === 'Estimated' && !r.estimateIsDeparture ? r.statusTime
    : r.sta;
  return {
    flight: r.flight, origin: r.origin, destination: r.destination, std: r.std, atd: r.atd, sta: r.sta,
    status: r.status, arrival, arrivalDelay: arrival && r.sta ? minutesBetween(r.sta, arrival) : null,
    arrivalLocal: arrival ? localLabel(arrival, r.destination) : null,
  };
};

export function rotation(rows: Fr24Row[], flightNumber: string, scheduledDeparture: string, aircraftType: string | null): Rotation | null {
  // Rows are newest first; ours is the one with our number and scheduled departure.
  const ours = rows.findIndex((r) => r.flight?.toUpperCase() === flightNumber.toUpperCase() && r.std === scheduledDeparture);
  const earlier = ours >= 0
    ? rows.slice(ours + 1)
    : rows.filter((r) => r.std && r.std < scheduledDeparture);
  if (earlier.length === 0) return null;
  const previous = earlier.slice(0, 6).map(asRotationFlight);
  const inbound = previous[0];
  const turnMinutes = inbound.arrival ? minutesBetween(inbound.arrival, scheduledDeparture) : null;
  const minTurnMinutes = minTurnFor(aircraftType);
  return { previous, turnMinutes, minTurnMinutes, tight: turnMinutes != null && turnMinutes < minTurnMinutes };
}

export interface LegExtras {
  /** ICAO-style ident, which is what the plane broadcasts as its callsign, e.g. SWR300. */
  icaoIdent: string | null;
  codeshares: string[];
  trackRecord?: TrackRecord | null;
  rotation?: Rotation | null;
  fetchedAt: string;
}

export interface EnrichInput {
  flightNumber: string;
  scheduledDeparture: string | null;
  tailNumber: string | null;
  aircraftType: string | null;
  codeshares: string[];
}

/**
 * Builds extras for a leg. The flight's history barely changes so it is cached for hours; the
 * aircraft's page is cached briefly, since the inbound flight's progress is the point of it.
 * A failed fetch leaves that part out rather than failing the poll.
 */
export function createEnricher(
  scrape: (url: string) => Promise<string>,
  { now = () => new Date(), log = (_: string) => {} }: { now?: () => Date; log?: (m: string) => void } = {}
) {
  const cache = new Map<string, { at: number; rows: Fr24Row[] }>();
  const rowsFor = async (path: string, ttlMs: number): Promise<Fr24Row[] | null> => {
    const hit = cache.get(path);
    if (hit && now().getTime() - hit.at < ttlMs) return hit.rows;
    try {
      const rows = parseFr24Table(await scrape(`https://www.flightradar24.com/data/${path}`));
      if (rows.length > 0) cache.set(path, { at: now().getTime(), rows });
      return rows.length > 0 ? rows : hit?.rows ?? null;
    } catch (err) {
      log(`enrich ${path} failed: ${(err as Error).message}`);
      return hit?.rows ?? null;
    }
  };

  return async (leg: EnrichInput): Promise<LegExtras> => {
    const ident = leg.flightNumber.toLowerCase();
    const history = await rowsFor(`flights/${ident}`, 3 * 3600_000);
    const aircraft = leg.tailNumber ? await rowsFor(`aircraft/${leg.tailNumber.toLowerCase()}`, 8 * 60_000) : null;
    const std = leg.scheduledDeparture;
    return {
      icaoIdent: flightNumberToIcaoCallsign(leg.flightNumber),
      codeshares: leg.codeshares,
      trackRecord: history && std ? trackRecord(history, std) : null,
      rotation: aircraft && std ? rotation(aircraft, leg.flightNumber, std, leg.aircraftType) : null,
      fetchedAt: now().toISOString(),
    };
  };
}
