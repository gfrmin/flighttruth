import type { Store, Trip, TripLeg } from './store.js';
import type { FlightLookupResult } from './lookupFlight.js';
import type { FlightQuery } from './types.js';
import { airportTimezone } from './airports.js';
import { deriveTripView, snapshotFromLookup, type LegSnapshot, type TripView } from './trip.js';
import { diffTripViews, type AlertEvent } from './alerts.js';
import type { CallsignLookup, LivePosition, PositionLookup } from './livePosition.js';
import type { EnrichInput, LegExtras } from './enrich.js';

export interface PollerDeps {
  store: Store;
  lookup: (q: FlightQuery) => Promise<FlightLookupResult>;
  notify: (e: AlertEvent, tripId: number) => Promise<void>;
  now: () => Date;
  log: (msg: string) => void;
  /** Live position by registration; optional so polling works without it. */
  position?: PositionLookup;
  /** Live position by the broadcast callsign, for departed legs whose plane the registration path can't find. */
  positionByCallsign?: CallsignLookup;
  /** Track record and the assigned plane's rotation; optional like position. */
  enrich?: (leg: EnrichInput) => Promise<LegExtras>;
  /** Called once a poll has saved the trip's new state (open trip pages refresh on it). */
  onSaved?: (tripId: number) => void;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** After the last landing, sources keep catching up (gate arrival, belt, corrected times). */
const SETTLE_AFTER_LANDING = HOUR;

// After touchdown the gate arrival is what matters for meeting someone, so a landed leg without
// an at-gate time is polled more often until the settle window closes.
const awaitingGate = (view: TripView): boolean =>
  view.legs.some((l) => l.milestones.landing && !l.milestones.atGate);

/** When to poll this trip next; null means it is finished (settled after landing, or long past). */
export function nextPollAt(trip: Trip, view: TripView, now: Date): string | null {
  if (view.state === 'complete') {
    const last = view.legs.at(-1);
    const landed = last?.milestones.landing?.utc ?? last?.arrival.best?.utc;
    const settled = !landed || now.getTime() >= Date.parse(landed) + SETTLE_AFTER_LANDING;
    return settled ? null : new Date(now.getTime() + (awaitingGate(view) ? 5 : 10) * MINUTE).toISOString();
  }
  const lastLegDate = trip.legs.at(-1)?.date;
  // More than three days after the last leg's date: give up rather than poll forever.
  if (lastLegDate && Date.parse(lastLegDate) + 3 * DAY < now.getTime()) return null;

  // Earliest departure any source knows of: a leg with no data (e.g. one that has already
  // dropped out of every source) must not hold a later, airborne leg at the slow cadence.
  // With no schedule at all, the start of the first leg's date stands in for its departure.
  const known = view.legs.flatMap((l) => (l.departure.scheduled?.utc ? [Date.parse(l.departure.scheduled.utc)] : []));
  const firstLegDate = trip.legs[0]?.date;
  const departures = known.length > 0 ? known : firstLegDate ? [Date.parse(`${firstLegDate}T00:00:00Z`)] : [];
  const close = departures.length > 0 && now.getTime() >= Math.min(...departures) - 3 * HOUR;
  return new Date(now.getTime() + (close ? 10 * MINUTE : HOUR)).toISOString();
}

const emptySnapshot = (leg: TripLeg): LegSnapshot => ({
  flightNumber: leg.flightNumber, date: leg.date, origin: null, destination: null,
  scheduledDeparture: null, actualDeparture: null, scheduledArrival: null, actualArrival: null,
  status: null, tailNumber: null, aircraftType: null,
});

// A failed lookup keeps the last known state of the leg rather than blanking it out.
function previousSnapshot(trip: Trip, leg: TripLeg): LegSnapshot {
  const prev = trip.lastView?.legs[leg.seq];
  if (!prev) return emptySnapshot(leg);
  const { phase: _phase, departure: _departure, arrival: _arrival, milestones: _milestones, ...snapshot } = prev;
  return snapshot;
}

// Codeshares, extras and position decorate a leg; they are not news about it.
const hasAnyData = ({ flightNumber: _f, date: _d, codeshares: _c, extras: _e, position: _p, ...fields }: LegSnapshot): boolean =>
  Object.values(fields).some((v) => v != null);

// Events from the change since last poll, plus every event the current state implies on its
// own: the second set re-raises anything whose push failed earlier (the alert table dedupes).
// On a key clash the change-based event wins, since it has the better wording ("swapped").
function pendingEvents(trip: Trip, view: TripView): AlertEvent[] {
  const byKey = new Map<string, AlertEvent>();
  for (const e of [...diffTripViews(trip.id, trip.lastView, view), ...diffTripViews(trip.id, null, view)]) {
    if (!byKey.has(e.dedupeKey)) byKey.set(e.dedupeKey, e);
  }
  return [...byKey.values()];
}

interface LegPoll {
  snapshot: LegSnapshot;
  /** Why no source had anything on this leg, or null when at least one did. */
  blindBecause: string | null;
}

const hasLanded = (s: LegSnapshot): boolean => !!(s.actualArrival || s.gateArrival || /arrived|landed/i.test(s.status ?? ''));

// Where the assigned plane is now -- before departure that is its inbound flight. A failed
// lookup keeps whatever position the snapshot already carried.
async function withPosition(trip: Trip, snapshot: LegSnapshot, deps: PollerDeps): Promise<LegSnapshot> {
  if (hasLanded(snapshot)) return snapshot;
  const byRegistration = async (): Promise<LivePosition | null> => {
    if (!deps.position || !snapshot.tailNumber) return null;
    try {
      return await deps.position(snapshot.tailNumber);
    } catch (err) {
      deps.log(`trip ${trip.id}: position ${snapshot.tailNumber} failed: ${(err as Error).message}`);
      return null;
    }
  };
  const byCallsign = async (): Promise<LivePosition | null> => {
    const departed = !!(snapshot.actualDeparture || snapshot.gateDeparture);
    if (!deps.positionByCallsign || !snapshot.callsign || !departed) return null;
    try {
      return await deps.positionByCallsign(snapshot.callsign);
    } catch (err) {
      deps.log(`trip ${trip.id}: position by callsign ${snapshot.callsign} failed: ${(err as Error).message}`);
      return null;
    }
  };
  const position = (await byRegistration()) ?? (await byCallsign());
  if (!position) return snapshot;
  const { source, seenAt, ...fields } = position;
  deps.store.recordObservations('aircraft', snapshot.tailNumber ?? position.hex, source, seenAt,
    Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v === null ? null : String(v)])));
  return { ...snapshot, position };
}

// A failed enrichment keeps whatever extras the snapshot already carried.
async function withExtras(trip: Trip, snapshot: LegSnapshot, deps: PollerDeps): Promise<LegSnapshot> {
  if (!deps.enrich) return snapshot;
  try {
    const extras = await deps.enrich({
      flightNumber: snapshot.flightNumber,
      scheduledDeparture: snapshot.scheduledDeparture,
      tailNumber: snapshot.tailNumber,
      aircraftType: snapshot.aircraftType,
      codeshares: snapshot.codeshares ?? [],
    });
    const previous = trip.lastView?.legs.find((l) => l.flightNumber === snapshot.flightNumber)?.extras;
    return {
      ...snapshot,
      extras: {
        ...extras,
        trackRecord: extras.trackRecord ?? previous?.trackRecord ?? null,
        // A rotation for a different plane (after a swap) is stale, so only reuse a matching one.
        rotation: extras.rotation ?? (snapshot.tailNumber && previous?.rotation && trip.lastView?.legs.find((l) => l.flightNumber === snapshot.flightNumber)?.tailNumber === snapshot.tailNumber ? previous.rotation : null),
      },
    };
  } catch (err) {
    deps.log(`trip ${trip.id}: enrich ${snapshot.flightNumber} failed: ${(err as Error).message}`);
    return snapshot;
  }
}

async function pollLeg(trip: Trip, leg: TripLeg, deps: PollerDeps): Promise<LegPoll> {
  const poll = await scheduleSnapshot(trip, leg, deps);
  const snapshot = await withPosition(trip, poll.snapshot, deps);
  return { ...poll, snapshot: await withExtras(trip, snapshot, deps) };
}

const hhmm = (iso: string, airport: string | null) => {
  const tz = (airport && airportTimezone(airport)) || 'UTC';
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
};

// The plane for our flight is still on (or late from) its previous flight, with less time on the
// ground than the type needs: our departure will probably slip before the airline says so.
function inboundEvents(trip: Trip, view: TripView): AlertEvent[] {
  return view.legs.flatMap((leg) => {
    const rot = leg.extras?.rotation;
    const inbound = rot?.previous[0];
    if (!rot?.tight || !inbound?.arrival || leg.phase !== 'scheduled') return [];
    const lands = `${inbound.status === 'Landed' ? 'landed' : 'lands'} ${inbound.destination ?? ''} ${hhmm(inbound.arrival, inbound.destination)}`;
    const late = inbound.arrivalDelay != null && inbound.arrivalDelay > 5 ? ` (${inbound.arrivalDelay} min late)` : '';
    return [{
      dedupeKey: `t${trip.id}:${leg.flightNumber}:${leg.date}:inbound-tight:${inbound.flight}`,
      title: `${leg.flightNumber}'s plane is running tight`,
      message: `${leg.tailNumber ?? 'The plane'} ${lands}${late} on ${inbound.flight ?? 'its previous flight'} from ${inbound.origin ?? '?'}: ${rot.turnMinutes} min to turn around before ${leg.flightNumber}, needs about ${rot.minTurnMinutes}. Expect a late departure.`,
      priority: 4,
    }];
  });
}

async function scheduleSnapshot(trip: Trip, leg: TripLeg, deps: PollerDeps): Promise<LegPoll> {
  try {
    const result = await deps.lookup({ type: 'number', query: leg.flightNumber, date: leg.date });
    deps.store.recordSourceResults(`${leg.flightNumber}@${leg.date}`, result.sourceResults);
    const snapshot = snapshotFromLookup(leg.flightNumber, leg.date, result);
    // Every source failing (blocked, timed out) is not news about the flight: keep what we knew.
    if (hasAnyData(snapshot)) return { snapshot, blindBecause: null };
    const reasons = result.sourceResults.map((r) => `${r.source}: ${r.error ?? 'nothing'}`).join('; ');
    return { snapshot: previousSnapshot(trip, leg), blindBecause: reasons || 'no sources configured' };
  } catch (err) {
    deps.log(`trip ${trip.id}: lookup ${leg.flightNumber} ${leg.date} failed: ${(err as Error).message}`);
    return { snapshot: previousSnapshot(trip, leg), blindBecause: `lookup failed: ${(err as Error).message}` };
  }
}

// Sources legitimately know nothing about a flight days away; from the day before its date,
// silence means the watcher is broken (key expired, quota gone, site blocking us) -- say so.
function blindEvent(trip: Trip, leg: TripLeg, poll: LegPoll, now: Date): AlertEvent[] {
  if (!poll.blindBecause) return [];
  const day = Date.parse(`${leg.date}T00:00:00Z`);
  if (now.getTime() < day - DAY || now.getTime() >= day + 2 * DAY) return [];
  return [{
    dedupeKey: `t${trip.id}:${leg.flightNumber}:${leg.date}:blind`,
    title: `No data on ${leg.flightNumber}`,
    message: `flighttruth can't see ${leg.flightNumber} on ${leg.date}: ${poll.blindBecause}`,
    priority: 4,
  }];
}

// A milestone older than this is history, not news: it is marked sent without a push (e.g. a
// trip added mid-journey, or a view saved before that milestone was tracked).
const STALE_EVENT_MS = 2 * HOUR;

export async function pollTrip(trip: Trip, deps: PollerDeps): Promise<TripView> {
  const polls: LegPoll[] = [];
  for (const leg of trip.legs) polls.push(await pollLeg(trip, leg, deps));
  const view = deriveTripView(polls.map((p) => p.snapshot));
  const blind = trip.legs.flatMap((leg, i) => blindEvent(trip, leg, polls[i], deps.now()));

  for (const event of [...pendingEvents(trip, view), ...blind, ...inboundEvents(trip, view)]) {
    if (deps.store.hasAlert(event.dedupeKey)) continue;
    if (event.at && deps.now().getTime() - Date.parse(event.at) > STALE_EVENT_MS) {
      deps.store.recordAlert(event, false);
      continue;
    }
    try {
      await deps.notify(event, trip.id);
      deps.store.recordAlert(event, true);
    } catch (err) {
      deps.log(`trip ${trip.id}: notify ${event.dedupeKey} failed: ${(err as Error).message}`);
    }
  }

  const next = nextPollAt(trip, view, deps.now());
  deps.store.saveTripState(trip.id, view, next);
  // A manual poll of a stopped trip that still has something to wait for resumes it.
  if ((next !== null) !== trip.active) deps.store.setTripActive(trip.id, next !== null);
  deps.onSaved?.(trip.id);
  return view;
}

export interface TripPoller {
  /** Polls one trip now; joins a poll of that trip already in flight instead of starting a second. */
  pollNow(tripId: number): Promise<void>;
  /** Polls due active trips every tick, one at a time. Returns a stop function. */
  start(tickMs?: number): () => void;
}

export function createTripPoller(deps: PollerDeps): TripPoller {
  const inFlight = new Map<number, Promise<void>>();

  const pollNow = (tripId: number): Promise<void> => {
    const running = inFlight.get(tripId);
    if (running) return running;
    const run = (async () => {
      const trip = deps.store.getTrip(tripId);
      if (trip) await pollTrip(trip, deps);
    })().finally(() => inFlight.delete(tripId));
    inFlight.set(tripId, run);
    return run;
  };

  const tick = async () => {
    const now = deps.now().getTime();
    const due = deps.store.listTrips().filter((t) => t.active && (!t.nextPollAt || Date.parse(t.nextPollAt) <= now));
    for (const trip of due) {
      try {
        await pollNow(trip.id);
      } catch (err) {
        deps.log(`trip ${trip.id}: poll failed: ${(err as Error).message}`);
      }
    }
  };

  const start = (tickMs = 60_000) => {
    let ticking = false;
    const guardedTick = async () => {
      if (ticking) return;
      ticking = true;
      try {
        await tick();
      } finally {
        ticking = false;
      }
    };
    const timer = setInterval(guardedTick, tickMs);
    void guardedTick();
    return () => clearInterval(timer);
  };

  return { pollNow, start };
}
