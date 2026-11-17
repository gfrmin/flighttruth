import type { LegView, LocalTime, TripView } from './trip.js';

export interface AlertEvent {
  dedupeKey: string;
  title: string;
  message: string;
  priority: 3 | 4;
  /** When the thing being reported happened (UTC), for events about a moment in time. */
  at?: string;
}

function delayPhrase(scheduled: LocalTime | null, best: LocalTime | null): string {
  if (!scheduled || !best) return '';
  const minutes = Math.round((Date.parse(best.utc) - Date.parse(scheduled.utc)) / 60_000);
  if (Math.abs(minutes) < 5) return ' (on time)';
  return minutes > 0 ? ` (${minutes} min late)` : ` (${-minutes} min early)`;
}

function tailEvents(tripId: number, prev: LegView | undefined, next: LegView): AlertEvent[] {
  if (!next.tailNumber || next.tailNumber === prev?.tailNumber) return [];
  const swapped = !!prev?.tailNumber;
  const type = next.aircraftType ? ` (${next.aircraftType})` : '';
  return [{
    dedupeKey: `t${tripId}:${next.flightNumber}:tail:${next.tailNumber}`,
    title: swapped ? `${next.flightNumber} aircraft swapped` : `${next.flightNumber} aircraft assigned`,
    message: swapped
      ? `${next.flightNumber} now flies on ${next.tailNumber}${type}, was ${prev!.tailNumber}`
      : `${next.flightNumber} will fly on ${next.tailNumber}${type}`,
    priority: swapped ? 4 : 3,
  }];
}

const atGate = (gate: string | null | undefined, terminal: string | null | undefined): string =>
  [gate && `gate ${gate}`, terminal && `terminal ${terminal}`].filter(Boolean).join(', ');

// One event per milestone, each pushed once: pushback and arrival at the gate are compared with
// the (gate-time) schedule; takeoff and landing are runway times, so they get no delay phrase.
function milestoneEvents(tripId: number, prev: LegView | undefined, next: LegView): AlertEvent[] {
  const { flightNumber: f, milestones: m } = next;
  const was = prev?.milestones;
  const event = (kind: string, title: string, message: string, time: LocalTime): AlertEvent => ({
    dedupeKey: `t${tripId}:${f}:${kind}`, title: `${f} ${title}`, message, priority: 3, at: time.utc,
  });
  const events: AlertEvent[] = [];
  if (m.pushback && !was?.pushback) {
    const gate = next.departureGate ? ` gate ${next.departureGate} at` : '';
    events.push(event('pushback', 'left the gate', `${f} left${gate} ${next.origin ?? ''} ${m.pushback.local}${delayPhrase(next.departure.scheduled, m.pushback)}`, m.pushback));
  }
  if (m.takeoff && !was?.takeoff) {
    events.push(event('takeoff', 'took off', `${f} took off from ${next.origin ?? ''} ${m.takeoff.local}`, m.takeoff));
  }
  if (m.landing && !was?.landing) {
    events.push(event('landed', 'landed', `${f} landed at ${next.destination ?? ''} ${m.landing.local}`, m.landing));
  }
  if (m.atGate && !was?.atGate) {
    const where = atGate(next.arrivalGate, next.arrivalTerminal);
    const belt = next.baggage ? `. Baggage belt ${next.baggage}` : '';
    events.push(event('at-gate', 'at the gate', `${f} at ${where ? `${where}, ` : ''}${next.destination ?? ''} ${m.atGate.local}${delayPhrase(next.arrival.scheduled, m.atGate)}${belt}`, m.atGate));
  }
  return events;
}

const ESTIMATE_STEP_MS = 15 * 60_000;
const estimateBucket = (iso: string) =>
  new Date(Math.floor(Date.parse(iso) / ESTIMATE_STEP_MS) * ESTIMATE_STEP_MS).toISOString().slice(0, 16);

// A moved arrival estimate, pushed when it is 15+ min off schedule and has moved to a new
// 15-minute step since the last view -- so drift of a few minutes doesn't buzz the phone.
function estimateEvents(tripId: number, prev: LegView | undefined, next: LegView): AlertEvent[] {
  const eta = next.arrival.estimated;
  const scheduled = next.arrival.scheduled;
  if (!eta || !scheduled || next.phase === 'landed') return [];
  if (Math.abs(Date.parse(eta.utc) - Date.parse(scheduled.utc)) < ESTIMATE_STEP_MS) return [];
  const bucket = estimateBucket(eta.utc);
  const prevEta = prev?.arrival?.estimated;
  if (prevEta && estimateBucket(prevEta.utc) === bucket) return [];
  return [{
    dedupeKey: `t${tripId}:${next.flightNumber}:eta:${bucket}`,
    title: `${next.flightNumber} arrival estimate moved`,
    message: `${next.flightNumber} now expected ${next.destination ?? ''} ${eta.local}${delayPhrase(scheduled, eta)}`,
    priority: 3,
  }];
}

const DISRUPTIONS = [
  { kind: 'cancelled', pattern: /cancel/i },
  { kind: 'diverted', pattern: /divert/i },
] as const;

function disruptionEvents(tripId: number, prev: LegView | undefined, next: LegView): AlertEvent[] {
  return DISRUPTIONS.filter(({ pattern }) => pattern.test(next.status ?? '') && !pattern.test(prev?.status ?? ''))
    .map(({ kind }) => ({
      dedupeKey: `t${tripId}:${next.flightNumber}:status:${kind}`,
      title: `${next.flightNumber} ${kind}`,
      message: `${next.flightNumber} ${next.origin ?? '?'} → ${next.destination ?? '?'} is reported ${next.status}`,
      priority: 4 as const,
    }));
}

function connectionEvents(tripId: number, prev: TripView | null, next: TripView): AlertEvent[] {
  return next.connections.flatMap<AlertEvent>((conn, i) => {
    const wasAtRisk = prev?.connections[i]?.atRisk ?? false;
    if (conn.atRisk === wasAtRisk || conn.bestMinutes === null) return [];
    const bucket = Math.floor(conn.bestMinutes / 15) * 15;
    return conn.atRisk
      ? [{
          dedupeKey: `t${tripId}:conn${i}:risk:${bucket}`,
          title: `Connection at ${conn.atAirport ?? '?'} is tight`,
          message: `Only ${conn.bestMinutes} min to connect at ${conn.atAirport ?? '?'} (scheduled ${conn.scheduledMinutes ?? '?'} min)`,
          priority: 4 as const,
        }]
      : [{
          dedupeKey: `t${tripId}:conn${i}:ok:${bucket}`,
          title: `Connection at ${conn.atAirport ?? '?'} looks OK again`,
          message: `${conn.bestMinutes} min to connect at ${conn.atAirport ?? '?'}`,
          priority: 3 as const,
        }];
  });
}

/** Pure diff of two trip views into alert events. Deduping against already-sent alerts is the poller's job. */
export function diffTripViews(tripId: number, prev: TripView | null, next: TripView): AlertEvent[] {
  const legEvents = next.legs.flatMap((leg, i) => [
    ...tailEvents(tripId, prev?.legs[i], leg),
    ...milestoneEvents(tripId, prev?.legs[i], leg),
    ...estimateEvents(tripId, prev?.legs[i], leg),
    ...disruptionEvents(tripId, prev?.legs[i], leg),
  ]);
  return [...legEvents, ...connectionEvents(tripId, prev, next)];
}

export async function sendNtfy(
  topic: string,
  event: AlertEvent,
  clickUrl: string | null,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const headers: Record<string, string> = { Title: event.title, Priority: String(event.priority) };
  if (clickUrl) headers.Click = clickUrl;
  const res = await fetchImpl(`https://ntfy.sh/${topic}`, { method: 'POST', body: event.message, headers });
  if (!res.ok) throw new Error(`ntfy responded ${res.status}`);
}
