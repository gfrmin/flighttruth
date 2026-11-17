// Wording and derivations for the trip pages. Pure: no DOM, no fetch. Every sentence uses the tense
// its state supports, so nothing says "in the air" or "landed" before a source does.

/** "16:46" from a LocalTime whose `local` is "16:46 Tue 17 Nov". */
export const hhmm = (t) => (t ? t.local.split(' ')[0] : null);

/** "on time" within 5 min, else "n min early" / "n min late". */
export const lateness = (m) => (m == null ? '' : Math.abs(m) < 5 ? 'on time' : m > 0 ? `${m} min late` : `${-m} min early`);

const minutesBetween = (fromIso, toIso) => Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 60_000);

/** One way of writing a length of time everywhere: "45 min" under an hour, "1h 05m" from there. */
export const duration = (minutes) => {
  if (minutes == null) return '—';
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
};
const span = duration;

const arrivalLateness = (leg) =>
  leg.arrival?.best && leg.arrival?.scheduled ? lateness(minutesBetween(leg.arrival.scheduled.utc, leg.arrival.best.utc)) : null;

const TONE_WORD = { ok: 'OK', tight: 'tight', 'at-risk': 'at risk' };

const TIGHT_BAND_MINUTES = 30;

/**
 * How a connection looks: at risk (the API's call, from the airport's minimum connection time),
 * tight within half an hour above that line, ok beyond, or unknown. Without the line (older
 * views), tight is under 60 min, the v2 spec's buffer indicator.
 */
export function connectionTone(conn) {
  if (conn.bestMinutes == null) return 'unknown';
  if (conn.atRisk) return 'at-risk';
  const tightBelow = conn.riskMinutes != null ? conn.riskMinutes + TIGHT_BAND_MINUTES : 60;
  return conn.bestMinutes < tightBelow ? 'tight' : 'ok';
}

// The leg the traveller is facing: the first one that hasn't landed, else the last.
const focusIndex = (legs) => {
  const i = legs.findIndex((l) => l.phase !== 'landed');
  return i === -1 ? legs.length - 1 : i;
};

const landsAt = (leg) => `lands ${leg.destination ?? '?'} ${hhmm(leg.arrival?.best) ?? '?'}`;

function legLine(leg) {
  const m = leg.milestones ?? {};
  if (leg.phase === 'unknown') return `No data yet for ${leg.flightNumber}`;
  if (leg.phase === 'landed') {
    if (m.atGate) return `At the gate, ${leg.destination ?? '?'} ${hhmm(m.atGate)}`;
    // Without a touchdown time the status alone says landed; any other time would be a forecast.
    return m.landing ? `Landed ${leg.destination ?? '?'} ${hhmm(m.landing)}` : `Landed ${leg.destination ?? '?'}`;
  }
  if (leg.phase === 'departed') {
    if (m.takeoff) return `In the air · ${landsAt(leg)}`;
    if (m.pushback) return `Left the gate at ${leg.origin ?? '?'} ${hhmm(m.pushback)} · ${landsAt(leg)}`;
    return `Departed ${leg.origin ?? '?'} · ${landsAt(leg)}`;
  }
  return `Leaves ${leg.origin ?? '?'} ${hhmm(leg.departure?.best) ?? '?'} · ${landsAt(leg)}`;
}

function legDetail(leg, now) {
  if (leg.phase === 'unknown') return null;
  if (leg.phase === 'landed') return leg.milestones?.atGate && leg.baggage ? `belt ${leg.baggage}` : arrivalLateness(leg) || null;
  const late = arrivalLateness(leg);
  if (leg.phase === 'departed' && leg.milestones?.takeoff && leg.arrival?.best) {
    const left = minutesBetween(now.toISOString(), leg.arrival.best.utc);
    if (left > 0) return [`in ${span(left)}`, late].filter(Boolean).join(', ');
  }
  return late || null;
}

/** One sentence for the top of the trip page and the trip's card on the homepage. */
export function headline(view, now) {
  if (!view || !view.legs?.length) return { line: 'Waiting for the first check', detail: null };
  const i = focusIndex(view.legs);
  const leg = view.legs[i];
  // The connection still ahead: the one into this leg if it hasn't left yet, else the one after it.
  const conn = (i > 0 && leg.phase === 'scheduled' ? view.connections?.[i - 1] : view.connections?.[i]) ?? null;
  const connText = conn && conn.bestMinutes != null
    ? `connection at ${conn.atAirport ?? '?'}: ${duration(conn.bestMinutes)}, ${TONE_WORD[connectionTone(conn)]}`
    : null;
  return { line: legLine(leg), detail: [legDetail(leg, now), connText].filter(Boolean).join(' · ') || null };
}

/** Share of the flight flown, from takeoff to the best arrival; null unless in the air. */
export function progress(leg, now) {
  const takeoff = leg.milestones?.takeoff?.utc;
  const arrival = leg.arrival?.best?.utc;
  if (leg.phase !== 'departed' || !takeoff || !arrival) return null;
  const total = Date.parse(arrival) - Date.parse(takeoff);
  if (total <= 0) return null;
  return Math.min(1, Math.max(0, (now.getTime() - Date.parse(takeoff)) / total));
}

const OVERNIGHT_MS = 6 * 3600_000;

/**
 * The plane's flights (most recent first) back to its last overnight stop: a gap over 6 hours,
 * counting the gap before our own departure, so a plane that slept before our flight has none.
 */
export function rotationToday(previous, ourStd) {
  const kept = [];
  let laterStd = ourStd;
  for (const f of previous) {
    if (!f.arrival || !laterStd || Date.parse(laterStd) - Date.parse(f.arrival) > OVERNIGHT_MS) break;
    kept.push(f);
    laterStd = f.std;
  }
  return kept;
}

/** The ICAO flight ident, unless it is the callsign the strip already shows. */
export const radioIdent = (leg) => {
  const ident = leg.extras?.icaoIdent ?? null;
  return ident && ident !== leg.callsign ? ident : null;
};

/** "just now", "8 min ago", "3 h ago", "5 days ago". */
export function ago(iso, now) {
  const minutes = Math.round((now.getTime() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} h ago`;
  const days = Math.floor(minutes / (24 * 60));
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

/** When an alert reached the phone, in the viewer's zone: "12:51" today, "Thu 12 Nov 09:39" before. */
export function sentLabel(iso, now, timeZone = undefined) {
  const fmt = (opts) => new Intl.DateTimeFormat('en-GB', { timeZone, ...opts }).format(new Date(iso));
  const day = (d) => new Intl.DateTimeFormat('en-CA', { timeZone }).format(d);
  const clock = fmt({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return day(new Date(iso)) === day(now) ? clock : `${fmt({ weekday: 'short', day: 'numeric', month: 'short' }).replace(',', '')} ${clock}`;
}

/** The plane's day before this flight, oldest first, then the traveller's own leg; null if none. */
export function itsDay(day, leg) {
  if (day.length === 0) return null;
  const places = [day[0].origin, ...day.map((f) => f.destination)].map((c) => c ?? '?');
  return `${places.join(' → ')}, then yours: ${leg.origin ?? '?'} → ${leg.destination ?? '?'}`;
}

const EVENT_GAP_MS = 5 * 60_000;

/** When an alert's event happened and, if it was pushed noticeably later, when it was sent. */
export function alertTime(alert, now, timeZone = undefined) {
  const sent = sentLabel(alert.sentAt, now, timeZone);
  if (!alert.at || Math.abs(Date.parse(alert.sentAt) - Date.parse(alert.at)) <= EVENT_GAP_MS) return sent;
  return `${sentLabel(alert.at, now, timeZone)} · sent ${sent}`;
}

/** "LGW (EGKK) → ZRH (LSZH)": the IATA code people read and the ICAO code ATC and ADS-B tools use. */
export function airportsLine(leg) {
  const end = (iata, icao) => (iata ? (icao ? `${iata} (${icao})` : iata) : '?');
  return `${end(leg.origin, leg.originIcao)} → ${end(leg.destination, leg.destinationIcao)}`;
}

/** The banner when the server can't be reached; the page keeps what it last showed. */
export const unreachable = (status) =>
  `Couldn't reach flighttruth${status ? ` (HTTP ${status})` : ''}. Showing the last data.`;
