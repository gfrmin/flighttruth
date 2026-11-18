import { inboundSentence } from './rotationText.js';
import { headline, connectionTone, rotationToday, progress, hhmm, lateness, ago, radioIdent, duration, itsDay, alertTime, airportsLine, unreachable, flightTime, place } from './tripText.js';
import { el, fetchOrReport } from './dom.js';

const tripId = new URLSearchParams(location.search).get('id');

const joined = (parts, sep = ' · ') => parts.filter(Boolean).join(sep);
const signed = (m) => (m == null ? '—' : m > 0 ? `+${m}` : m < 0 ? `−${-m}` : '0');
// "U21234" -> "U2 1234"
const spaced = (flightNumber) => flightNumber.replace(/^([A-Z0-9]{2})(\d)/, '$1 $2');
// The viewer's own clock, 24h: the timeline and footer are about when things reached the phone.
const viewerClock = (iso) => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
const PHASE_LABEL = { unknown: 'no data yet', scheduled: 'scheduled', departed: 'departed', landed: 'landed' };

const minutesAgo = (iso) => ago(iso, new Date());

// One end of the strip: the big best time, the schedule struck through when it moved, and where.
function endCell(label, times, where, events) {
  const moved = times.scheduled && times.best && times.scheduled.utc !== times.best.utc;
  const isEstimate = times.estimated && times.best && times.estimated.utc === times.best.utc;
  return el('div', { class: 'strip-end' },
    el('span', { class: 'strip-label' }, label),
    el('span', { class: 'strip-time' }, hhmm(times.best) ?? '—'),
    el('span', { class: 'strip-sub' },
      moved ? el('s', { 'aria-label': `scheduled ${hhmm(times.scheduled)}` }, hhmm(times.scheduled)) : '',
      moved && isEstimate && !events ? ' ' : '',
      isEstimate && !events ? 'estimate' : '',
      times.best?.tz === 'UTC' ? ' UTC' : ''),
    where ? el('span', { class: 'strip-sub' }, where) : '',
    events ? el('span', { class: 'strip-events' }, events) : '');
}

function strip(leg, now, places) {
  const m = leg.milestones ?? {};
  const share = progress(leg, now);
  const plane = joined([leg.tailNumber, leg.aircraftType]) || 'aircraft not assigned yet';
  const city = (code) => (code && places[code] ? ` ${places[code]}` : '');
  const time = flightTime(leg);
  return el('article', { class: `strip phase-${leg.phase}` },
    el('div', { class: 'strip-ident' },
      el('span', { class: 'strip-flight' }, spaced(leg.flightNumber)),
      leg.callsign ? el('span', { class: 'strip-callsign', title: 'callsign' }, leg.callsign) : '',
      el('span', { class: 'strip-status' }, leg.status ?? PHASE_LABEL[leg.phase])),
    el('div', { class: 'strip-route' },
      el('span', { class: 'strip-airport' }, leg.origin ?? '?'),
      el('span', share == null
        ? { class: 'strip-track' }
        : { class: 'strip-track', role: 'progressbar', 'aria-valuenow': Math.round(share * 100), 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': 'Share of the flight flown' },
        share == null ? '' : el('span', { class: 'strip-flown', style: `width:${(share * 100).toFixed(1)}%` })),
      el('span', { class: 'strip-airport' }, leg.destination ?? '?')),
    time ? el('div', { class: 'strip-duration' }, time) : '',
    el('div', { class: 'strip-ends' },
      endCell(`Departs${city(leg.origin)}`, leg.departure,
        joined([leg.departureTerminal && `terminal ${leg.departureTerminal}`, leg.departureGate && `gate ${leg.departureGate}`], ', '),
        joined([m.pushback && `left gate ${hhmm(m.pushback)}`, m.takeoff && `took off ${hhmm(m.takeoff)}`], ', ')),
      endCell(`Arrives${city(leg.destination)}`, leg.arrival,
        joined([leg.arrivalTerminal && `terminal ${leg.arrivalTerminal}`, leg.arrivalGate && `gate ${leg.arrivalGate}`, leg.baggage && `belt ${leg.baggage}`], ', '),
        joined([m.landing && `landed ${hhmm(m.landing)}`, m.atGate && `at gate ${hhmm(m.atGate)}`], ', '))),
    el('div', { class: 'strip-plane' }, plane));
}

function connectionChip(conn) {
  const tone = connectionTone(conn);
  const text = conn.bestMinutes == null
    ? `Connection at ${conn.atAirport ?? '?'}: not known yet`
    : `Connection at ${conn.atAirport ?? '?'}: ${duration(conn.bestMinutes)}` +
      (conn.scheduledMinutes != null && conn.scheduledMinutes !== conn.bestMinutes ? `, was ${duration(conn.scheduledMinutes)}` : '') +
      (tone === 'at-risk' ? ', at risk' : tone === 'tight' ? ', tight' : '');
  return el('div', { class: `connection tone-${tone}` }, text);
}

const fact = (label, ...value) => (value.some(Boolean) ? [el('dt', {}, label), el('dd', {}, ...value)] : []);

function positionFact(leg) {
  const p = leg.position;
  if (!p) return [];
  const where = p.onGround ? 'on the ground' : joined(['in the air', p.altitudeFt != null && `${p.altitudeFt.toLocaleString('en-GB')} ft`, p.groundSpeedKt != null && `${p.groundSpeedKt} kt`]);
  const as = p.callsign && p.callsign !== leg.callsign ? ` as ${p.callsign}` : '';
  return fact('Plane now', `${where}${as}, seen ${minutesAgo(p.seenAt)} · `,
    el('a', { href: `https://globe.adsb.lol/?icao=${p.hex}`, target: '_blank', rel: 'noopener' }, 'map'));
}

function rotationFacts(leg, places) {
  const rot = leg.extras?.rotation;
  if (!rot || rot.previous.length === 0) return [];
  const [inbound] = rot.previous;
  const { lead, verb } = inboundSentence(inbound, { ...leg, flightNumber: spaced(leg.flightNumber) });
  const turn = rot.turnMinutes == null ? '' : `; ${duration(rot.turnMinutes)} on the ground before ${spaced(leg.flightNumber)}, needs about ${rot.minTurnMinutes} min`;
  const day = itsDay([...rotationToday(rot.previous, leg.scheduledDeparture)].reverse(), leg, places);
  return [
    ...fact('Inbound', el('span', { class: rot.tight ? 'warn' : '' },
      `${lead} ${inbound.flight ?? '?'} ${place(inbound.origin, places)} → ${place(inbound.destination, places)}, ${verb} ${inbound.arrivalLocal ?? '?'}`,
      inbound.arrivalDelay != null ? ` (${lateness(inbound.arrivalDelay)})` : '', turn)),
    ...fact('Its day', day
      ?? `no other flights before this one; it waited ${duration(rot.turnMinutes)} at ${place(inbound.destination ?? leg.origin, places)}`),
  ];
}

function trackRecordFacts(leg) {
  const t = leg.extras?.trackRecord;
  if (!t || t.flights === 0) return [];
  const chips = t.recent.slice(0, 10).map((r) =>
    el('span', { class: `chip${r.arrivalDelay > 15 ? ' late' : r.arrivalDelay < -5 ? ' early' : ''}`, title: `${r.date} · ${r.tail ?? ''} · took off ${signed(r.departureDelay)} min` },
      signed(r.arrivalDelay)));
  return fact(`Last ${t.flights} flights`,
    `lands ${lateness(t.medianArrivalDelay)} typically, worst ${signed(t.worstArrivalDelay)} min, ${t.onTimePct}% within 15 min`,
    t.medianDepartureDelay != null ? `; wheels up typically ${signed(t.medianDepartureDelay)} min vs schedule, taxi included` : '',
    el('span', { class: 'chips', 'aria-label': 'Arrival minutes against schedule, newest first' }, ...chips));
}

function legDetails(leg, places) {
  return el('section', { class: 'leg-details' },
    el('h2', {}, `${spaced(leg.flightNumber)}, ${place(leg.origin, places)} to ${place(leg.destination, places)}`),
    el('dl', { class: 'facts' },
      ...fact('Airports', airportsLine(leg)),
      ...fact('Radio ident', radioIdent(leg) ?? ''),
      ...fact('Also sold as', (leg.codeshares ?? []).map(spaced).join(', ')),
      ...fact('Transponder', leg.position?.hex?.toUpperCase() ?? ''),
      ...positionFact(leg),
      ...rotationFacts(leg, places),
      ...trackRecordFacts(leg)));
}

function timelineItem(alert) {
  return el('li', { class: alert.pushed ? null : 'not-pushed' },
    el('time', { datetime: alert.at ?? alert.sentAt }, alertTime(alert, new Date())),
    el('div', {},
      alert.title ? el('strong', {}, alert.title) : '',
      el('div', { class: alert.title ? 'hint' : null }, alert.message),
      alert.pushed ? '' : el('div', { class: 'hint' }, 'Not pushed: it was already old news when first seen.')));
}

function footerText(trip) {
  const fetched = (trip.lastView?.legs ?? []).map((l) => l.extras?.fetchedAt).filter(Boolean).sort().pop();
  return joined([
    fetched && `Checked ${minutesAgo(fetched)}`,
    trip.nextPollAt ? `next check ${viewerClock(trip.nextPollAt)}` : trip.active ? '' : 'no longer watched',
  ]);
}

async function showTrip() {
  const res = await fetchOrReport(`/api/trips/${tripId}`, {}, [404], unreachable);
  if (!res) return;
  if (res.status === 404) {
    document.getElementById('trip-title').textContent = 'Trip not found';
    return;
  }
  const trip = await res.json();
  const view = trip.lastView;
  const places = trip.places ?? {};
  const now = new Date();
  const { line, detail } = headline(view, now);
  document.title = `${trip.label} · flighttruth`;
  document.getElementById('trip-title').textContent = trip.label;
  document.getElementById('headline').textContent = line;
  document.getElementById('headline-detail').textContent = joined([detail, view?.totalMinutes != null && `${duration(view.totalMinutes)} door to door`]);

  const strips = document.getElementById('strips');
  strips.replaceChildren();
  (view?.legs ?? []).forEach((leg, i) => {
    if (i > 0) strips.append(connectionChip(view.connections[i - 1]));
    strips.append(strip(leg, now, places));
  });
  document.getElementById('details').replaceChildren(...(view?.legs ?? []).map((leg) => legDetails(leg, places)));

  const alerts = trip.alerts ?? [];
  document.getElementById('timeline').hidden = alerts.length === 0;
  document.getElementById('timeline-list').replaceChildren(...alerts.map(timelineItem));
  document.getElementById('poll-status').textContent = footerText(trip);
}

if (tripId) {
  document.getElementById('poll-now').addEventListener('click', async (e) => {
    e.target.disabled = true;
    document.getElementById('poll-status').textContent = 'Checking every source…';
    const polled = await fetchOrReport(`/api/trips/${tripId}/poll`, { method: 'POST' }, [], unreachable);
    e.target.disabled = false;
    if (polled) await showTrip();
    else document.getElementById('poll-status').textContent = '';
  });
  showTrip();
  // New data shows up as soon as a poll saves it; the minute timer keeps "checked 3 min ago"
  // honest and covers a dropped stream. After a reconnect, catch up on anything missed.
  const events = new EventSource(`/api/trips/${tripId}/events`);
  let dropped = false;
  events.addEventListener('updated', () => showTrip());
  events.addEventListener('error', () => { dropped = true; });
  events.addEventListener('open', () => { if (dropped) { dropped = false; showTrip(); } });
  setInterval(showTrip, 60_000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') showTrip(); });
} else {
  location.replace('/');
}
