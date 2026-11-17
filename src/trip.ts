import { airportIcao, airportTimezone } from './airports.js';
import type { LivePosition } from './livePosition.js';
import type { LegExtras } from './enrich.js';
import type { FlightLookupResult } from './lookupFlight.js';
import type { FieldName } from './types.js';

export interface LegSnapshot {
  flightNumber: string;
  date: string;
  origin: string | null;
  destination: string | null;
  scheduledDeparture: string | null;
  actualDeparture: string | null;
  scheduledArrival: string | null;
  actualArrival: string | null;
  status: string | null;
  tailNumber: string | null;
  aircraftType: string | null;
  // Optional so snapshots saved before these fields existed still load.
  gateDeparture?: string | null;
  gateArrival?: string | null;
  estimatedDeparture?: string | null;
  estimatedArrival?: string | null;
  departureTerminal?: string | null;
  departureGate?: string | null;
  arrivalTerminal?: string | null;
  arrivalGate?: string | null;
  baggage?: string | null;
  callsign?: string | null;
  /** Live position of the assigned plane, while the leg hasn't landed. */
  position?: LivePosition | null;
  codeshares?: string[];
  /** Track record, the plane's recent flights and identifiers; see enrich.ts. */
  extras?: LegExtras | null;
}

/** `local` is e.g. "15:05 Sat 17 Oct" in the airport's zone (UTC when the airport is unknown). */
export interface LocalTime {
  utc: string;
  local: string;
  tz: string;
}

export type LegPhase = 'unknown' | 'scheduled' | 'departed' | 'landed';

export interface LegView extends LegSnapshot {
  phase: LegPhase;
  originIcao: string | null;
  destinationIcao: string | null;
  /** best = gate actual ?? runway actual ?? estimated ?? scheduled (schedules are gate times) */
  departure: { scheduled: LocalTime | null; estimated: LocalTime | null; best: LocalTime | null };
  arrival: { scheduled: LocalTime | null; estimated: LocalTime | null; best: LocalTime | null };
  /** pushback/atGate are gate times, takeoff/landing runway times */
  milestones: { pushback: LocalTime | null; takeoff: LocalTime | null; landing: LocalTime | null; atGate: LocalTime | null };
}

export interface Connection {
  atAirport: string | null;
  /** Below this many minutes the connection is at risk (the airport's minimum plus a margin). */
  riskMinutes: number;
  scheduledMinutes: number | null;
  bestMinutes: number | null;
  atRisk: boolean;
}

export interface TripView {
  legs: LegView[];
  connections: Connection[];
  totalMinutes: number | null;
  state: 'upcoming' | 'in-progress' | 'complete';
}

// Published minimum connecting times at a few hubs; elsewhere a conservative default. A
// connection is at risk when the buffer drops within CONNECTION_MARGIN of the minimum.
const MIN_CONNECT_MINUTES: Record<string, number> = { ZRH: 40, LHR: 60 };
const DEFAULT_MIN_CONNECT = 45;
const CONNECTION_MARGIN = 10;
export const connectionRiskMinutes = (airport: string | null): number =>
  (airport && MIN_CONNECT_MINUTES[airport] ? MIN_CONNECT_MINUTES[airport] : DEFAULT_MIN_CONNECT) + CONNECTION_MARGIN;

const SNAPSHOT_FIELDS = [
  'origin', 'destination', 'scheduledDeparture', 'actualDeparture', 'scheduledArrival',
  'actualArrival', 'status', 'tailNumber', 'aircraftType',
  'gateDeparture', 'gateArrival', 'estimatedDeparture', 'estimatedArrival',
  'departureTerminal', 'departureGate', 'arrivalTerminal', 'arrivalGate', 'baggage', 'callsign',
] as const satisfies readonly FieldName[];

export function snapshotFromLookup(flightNumber: string, date: string, result: FlightLookupResult): LegSnapshot {
  const top = (field: FieldName): string | null =>
    result.distributions.find((d) => d.field === field)?.values[0]?.value ?? null;
  return {
    flightNumber,
    date,
    codeshares: result.codeshareFlightNumbers ?? [],
    ...(Object.fromEntries(SNAPSHOT_FIELDS.map((f) => [f, top(f)])) as Omit<LegSnapshot, 'flightNumber' | 'date' | 'codeshares' | 'extras' | 'position'>),
  };
}

export function formatLocal(utcIso: string, iata: string | null): LocalTime {
  const tz = (iata && airportTimezone(iata)) || 'UTC';
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', weekday: 'short', day: 'numeric', month: 'short', hourCycle: 'h23',
    })
      .formatToParts(new Date(utcIso))
      .map((p) => [p.type, p.value])
  );
  return { utc: utcIso, local: `${parts.hour}:${parts.minute} ${parts.weekday} ${parts.day} ${parts.month}`, tz };
}

const minutesBetween = (fromIso: string | null, toIso: string | null): number | null =>
  fromIso && toIso ? Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 60_000) : null;

function legPhase(leg: LegSnapshot): LegPhase {
  if (leg.actualArrival || leg.gateArrival || /arrived|landed/i.test(leg.status ?? '')) return 'landed';
  if (leg.actualDeparture || leg.gateDeparture || /departed|en route|airborne/i.test(leg.status ?? '')) return 'departed';
  if (leg.scheduledDeparture) return 'scheduled';
  return 'unknown';
}

const localOrNull = (iso: string | null | undefined, iata: string | null): LocalTime | null => (iso ? formatLocal(iso, iata) : null);

// Sources disagree for a while around each milestone; a gate time on the wrong side of its runway
// time (at the gate before landing, pushback after takeoff) is not trusted until they settle.
// Some sources also fill the gate time with the schedule before anything has happened, so a gate
// time to the minute of the schedule counts only once the runway time confirms the move.
const before = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && Date.parse(a) < Date.parse(b);
const sameMinute = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && Math.floor(Date.parse(a) / 60_000) === Math.floor(Date.parse(b) / 60_000);
function consistentGateTimes(leg: LegSnapshot): LegSnapshot {
  const copiedDeparture = sameMinute(leg.gateDeparture, leg.scheduledDeparture) && !leg.actualDeparture;
  const copiedArrival = sameMinute(leg.gateArrival, leg.scheduledArrival) && !leg.actualArrival;
  return {
    ...leg,
    gateDeparture: before(leg.actualDeparture, leg.gateDeparture) || copiedDeparture ? null : leg.gateDeparture,
    gateArrival: before(leg.gateArrival, leg.actualArrival) || copiedArrival ? null : leg.gateArrival,
  };
}

function toLegView(raw: LegSnapshot): LegView {
  const leg = consistentGateTimes(raw);
  return {
    ...leg,
    phase: legPhase(leg),
    originIcao: leg.origin ? airportIcao(leg.origin) : null,
    destinationIcao: leg.destination ? airportIcao(leg.destination) : null,
    departure: {
      scheduled: localOrNull(leg.scheduledDeparture, leg.origin),
      estimated: localOrNull(leg.estimatedDeparture, leg.origin),
      best: localOrNull(leg.gateDeparture ?? leg.actualDeparture ?? leg.estimatedDeparture ?? leg.scheduledDeparture, leg.origin),
    },
    arrival: {
      scheduled: localOrNull(leg.scheduledArrival, leg.destination),
      estimated: localOrNull(leg.estimatedArrival, leg.destination),
      best: localOrNull(leg.gateArrival ?? leg.actualArrival ?? leg.estimatedArrival ?? leg.scheduledArrival, leg.destination),
    },
    milestones: {
      pushback: localOrNull(leg.gateDeparture, leg.origin),
      takeoff: localOrNull(leg.actualDeparture, leg.origin),
      landing: localOrNull(leg.actualArrival, leg.destination),
      atGate: localOrNull(leg.gateArrival, leg.destination),
    },
  };
}

function connectionBetween(inbound: LegView, outbound: LegView): Connection {
  const bestMinutes = minutesBetween(inbound.arrival.best?.utc ?? null, outbound.departure.best?.utc ?? null);
  const atAirport = inbound.destination ?? outbound.origin;
  return {
    atAirport,
    scheduledMinutes: minutesBetween(inbound.scheduledArrival, outbound.scheduledDeparture),
    bestMinutes,
    riskMinutes: connectionRiskMinutes(atAirport),
    atRisk: bestMinutes !== null && bestMinutes < connectionRiskMinutes(atAirport),
  };
}

export function deriveTripView(snapshots: LegSnapshot[]): TripView {
  const legs = snapshots.map(toLegView);
  const phases = legs.map((l) => l.phase);
  return {
    legs,
    connections: legs.slice(1).map((outbound, i) => connectionBetween(legs[i], outbound)),
    totalMinutes: minutesBetween(legs[0]?.departure.best?.utc ?? null, legs.at(-1)?.arrival.best?.utc ?? null),
    state: phases.every((p) => p === 'landed')
      ? 'complete'
      : phases.some((p) => p === 'departed' || p === 'landed')
        ? 'in-progress'
        : 'upcoming',
  };
}
