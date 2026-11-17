export type LookupType = 'number' | 'tail';

export interface FlightQuery {
  type: LookupType;
  query: string;
  date: string;
  /** Where the flight goes, when known; filled in by lookupFlight for sources with needsRoute. */
  route?: { origin: string | null; destination: string | null };
}

export interface FieldValue {
  value: string | null;
  paywalled: boolean;
  raw: string | null;
}

export type FlightFieldName =
  | 'airline'
  | 'origin'
  | 'destination'
  | 'scheduledDeparture'
  | 'actualDeparture'
  | 'scheduledArrival'
  | 'actualArrival'
  | 'status'
  // Runway times are actualDeparture (wheels-off) / actualArrival (touchdown); these are the
  // gate times (pushback / on-blocks), which is what airline schedules are written in.
  | 'gateDeparture'
  | 'gateArrival'
  | 'estimatedDeparture'
  | 'estimatedArrival'
  | 'departureTerminal'
  | 'departureGate'
  | 'arrivalTerminal'
  | 'arrivalGate'
  | 'baggage'
  | 'callsign';

export type AircraftFieldName =
  | 'aircraftType'
  | 'tailNumber'
  | 'age'
  | 'seatConfiguration';

export type FieldName = FlightFieldName | AircraftFieldName;

export const FIELD_NAMES: FieldName[] = [
  'airline', 'origin', 'destination',
  'scheduledDeparture', 'actualDeparture', 'scheduledArrival', 'actualArrival', 'status',
  'gateDeparture', 'gateArrival', 'estimatedDeparture', 'estimatedArrival',
  'departureTerminal', 'departureGate', 'arrivalTerminal', 'arrivalGate', 'baggage', 'callsign',
  'aircraftType', 'tailNumber', 'age', 'seatConfiguration',
];

export type SourceId =
  | 'openSky' | 'adsbExchange' | 'flightaware' | 'flightradar24' | 'flightstats' | 'seatguru'
  | 'aeroapi' | 'aerodatabox' | 'googleSerp' | 'benGurion' | 'etihad' | 'aena';

export const SOURCE_WEIGHTS: Record<SourceId, number> = {
  openSky: 0.9,
  adsbExchange: 0.8,
  flightaware: 0.85,
  flightradar24: 0.8,
  flightstats: 0.7,
  seatguru: 0.8,
  // Licensed JSON APIs, not scraped pages: the most trustworthy schedule/status data we have.
  aeroapi: 0.95,
  aerodatabox: 0.9,
  // Google's flight card (Cirium data) via Bright Data SERP: licensed data, scraped presentation.
  googleSerp: 0.85,
  // The airport authority's own board (TLV only): authoritative for its end of the flight.
  benGurion: 0.9,
  aena: 0.9,
  // The operating airline's own status: authoritative for its own flights.
  etihad: 0.95,
};

export interface SourceResult {
  source: SourceId;
  fetchedAt: string;
  fields: Partial<Record<FieldName, FieldValue>>;
  error?: string;
  /** The true *operating* flight identity (e.g. "BA183"), when a source can resolve it --
   *  may differ from a possibly-marketing query.query. */
  operatingFlightNumber?: string;
  /** Other marketing-carrier codeshare numbers for this same physical flight. */
  codeshareFlightNumbers?: string[];
  /** Set when this result came from a second-pass retry under a resolved operating number
   *  rather than the originally-queried one -- see lookupFlight.ts. */
  retriedAs?: string;
}

export interface SourceFetcher {
  id: SourceId;
  fetch: (query: FlightQuery) => Promise<SourceResult>;
  /** True only for sources that match live traffic by resolving the queried flight number
   *  into an ICAO callsign against a free public API (openSky, adsbExchange), making it safe
   *  for lookupFlight to retry them under a resolved operating number at no extra cost. */
  retryOnIdentityResolution?: boolean;
  /** True for per-airport boards: lookupFlight runs these after the others, passing the route they reported. */
  needsRoute?: boolean;
}

export interface RouteQuery {
  origin: string;
  destination: string;
  date: string;
}

export interface RouteCandidate {
  flightNumber: string;
  airline: string;
  /** ISO UTC instant. */
  scheduledDeparture: string | null;
  /** Destination-local "HH:MM" -- FlightStats' route search doesn't give a UTC arrival
   *  instant, only a local clock time, so this isn't directly comparable to scheduledDeparture. */
  scheduledArrival: string | null;
  operatingFlightNumber?: string;
  codeshareFlightNumbers?: string[];
}

export interface RouteSearchResult {
  query: RouteQuery;
  fetchedAt: string;
  candidates: RouteCandidate[];
  error?: string;
}
