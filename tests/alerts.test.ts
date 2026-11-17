import { describe, it, expect } from 'vitest';
import { diffTripViews, sendNtfy, type AlertEvent } from '../src/alerts.js';
import { deriveTripView, type LegSnapshot } from '../src/trip.js';

const emptyLeg = (flightNumber: string): LegSnapshot => ({
  flightNumber, date: '2026-10-10', origin: null, destination: null,
  scheduledDeparture: null, actualDeparture: null, scheduledArrival: null, actualArrival: null,
  status: null, tailNumber: null, aircraftType: null,
});

const legA: LegSnapshot = {
  ...emptyLeg('EY101'), origin: 'TLV', destination: 'AUH',
  scheduledDeparture: '2026-10-10T12:05:00.000Z', scheduledArrival: '2026-10-10T15:20:00.000Z',
  status: 'Scheduled', aircraftType: 'Airbus A321neo',
};
const legB: LegSnapshot = {
  ...emptyLeg('EY102'), origin: 'AUH', destination: 'HKG',
  scheduledDeparture: '2026-10-10T17:10:00.000Z', scheduledArrival: '2026-10-11T01:00:00.000Z',
  status: 'Scheduled', tailNumber: 'A6-XBB',
};

const view = (a: LegSnapshot, b: LegSnapshot = legB) => deriveTripView([a, b]);

describe('diffTripViews', () => {
  it('emits nothing for a first view with no data', () => {
    expect(diffTripViews(1, null, deriveTripView([emptyLeg('EY101'), emptyLeg('EY102')]))).toEqual([]);
  });

  it('announces an aircraft assignment', () => {
    const events = diffTripViews(1, view(legA), view({ ...legA, tailNumber: 'A6-XAA' }));
    expect(events).toHaveLength(1);
    expect(events[0].dedupeKey).toBe('t1:EY101:tail:A6-XAA');
    expect(events[0].message).toContain('A6-XAA');
    expect(events[0].priority).toBe(3);
  });

  it('raises priority for an aircraft swap', () => {
    const events = diffTripViews(1, view({ ...legA, tailNumber: 'A6-XAA' }), view({ ...legA, tailNumber: 'A6-XCC' }));
    expect(events.map((e) => e.priority)).toEqual([4]);
    expect(events[0].dedupeKey).toBe('t1:EY101:tail:A6-XCC');
  });

  it('reports a departure in local time with its delay', () => {
    const events = diffTripViews(1, view(legA), view({ ...legA, actualDeparture: '2026-10-10T11:30:00.000Z' }));
    const takeoff = events.find((e) => e.dedupeKey === 't1:EY101:takeoff')!;
    expect(takeoff.title).toBe('EY101 took off');
    expect(takeoff.message).toContain('14:30');
    expect(takeoff.at).toBe('2026-10-10T11:30:00.000Z');
  });

  it('reports a landing', () => {
    const events = diffTripViews(
      1,
      view({ ...legA, actualDeparture: '2026-10-10T12:20:00.000Z' }),
      view({ ...legA, actualDeparture: '2026-10-10T12:20:00.000Z', actualArrival: '2026-10-10T15:50:00.000Z' })
    );
    const landed = events.find((e) => e.dedupeKey === 't1:EY101:landed')!;
    expect(landed.message).toBe('EY101 landed at AUH 19:50 Sat 10 Oct');
  });

  it('reports pushback with its delay against the schedule', () => {
    const events = diffTripViews(1, view(legA), view({ ...legA, gateDeparture: '2026-10-10T12:25:00.000Z', departureGate: 'B4' }));
    const pushback = events.find((e) => e.dedupeKey === 't1:EY101:pushback')!;
    expect(pushback.message).toBe('EY101 left gate B4 at TLV 15:25 Sat 10 Oct (20 min late)');
  });

  it('reports arrival at the gate with gate and baggage belt', () => {
    const landed = { ...legA, actualArrival: '2026-10-10T15:10:00.000Z' };
    const events = diffTripViews(1, view(landed), view({ ...landed, gateArrival: '2026-10-10T15:18:00.000Z', arrivalTerminal: 'A', arrivalGate: 'C27', baggage: '10' }));
    const atGate = events.find((e) => e.dedupeKey === 't1:EY101:at-gate')!;
    expect(atGate.message).toBe('EY101 at gate C27, terminal A, AUH 19:18 Sat 10 Oct (on time). Baggage belt 10');
  });

  it('pushes a moved arrival estimate once per 15-minute step', () => {
    const late = (eta: string) => view(legA, { ...legB, estimatedArrival: eta });
    const first = diffTripViews(1, view(legA), late('2026-10-11T01:20:00.000Z'));
    expect(first.map((e) => e.dedupeKey)).toEqual(['t1:EY102:eta:2026-10-11T01:15']);
    expect(first[0].message).toBe('EY102 now expected HKG 09:20 Sun 11 Oct (20 min late)');
    expect(diffTripViews(1, late('2026-10-11T01:20:00.000Z'), late('2026-10-11T01:25:00.000Z'))).toEqual([]);
    expect(diffTripViews(1, view(legA), late('2026-10-11T01:05:00.000Z'))).toEqual([]);
  });

  it('warns when the connection becomes tight, and when it recovers', () => {
    const tight = view({ ...legA, actualDeparture: '2026-10-10T13:00:00.000Z', actualArrival: '2026-10-10T16:30:00.000Z' });
    const ok = view({ ...legA, actualDeparture: '2026-10-10T13:00:00.000Z' });
    const risk = diffTripViews(1, ok, tight).find((e) => e.dedupeKey.startsWith('t1:conn0:risk'))!;
    expect(risk.priority).toBe(4);
    expect(risk.dedupeKey).toBe('t1:conn0:risk:30');
    expect(diffTripViews(1, tight, ok).some((e) => e.dedupeKey.startsWith('t1:conn0:ok'))).toBe(true);
  });

  it('pushes a cancellation at high priority', () => {
    const events = diffTripViews(1, view(legA), view({ ...legA, status: 'Cancelled' }));
    expect(events.map((e) => [e.dedupeKey, e.priority])).toEqual([['t1:EY101:status:cancelled', 4]]);
  });

  it('pushes a diversion at high priority', () => {
    const events = diffTripViews(1, view(legA), view({ ...legA, status: 'Diverted' }));
    expect(events.map((e) => e.dedupeKey)).toContain('t1:EY101:status:diverted');
  });

  it('emits nothing when nothing changed', () => {
    const v = view({ ...legA, tailNumber: 'A6-XAA' });
    expect(diffTripViews(1, v, v)).toEqual([]);
  });
});

describe('sendNtfy', () => {
  const event: AlertEvent = { dedupeKey: 'k', title: 'EY101 departed', message: 'EY101 departed TLV', priority: 4 };

  it('posts the message with title, priority and click headers', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;
    await sendNtfy('topic', event, 'http://localhost:3917/trips.html?id=1', fakeFetch);
    expect(calls[0].url).toBe('https://ntfy.sh/topic');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.body).toBe('EY101 departed TLV');
    expect(calls[0].init.headers).toMatchObject({ Title: 'EY101 departed', Priority: '4', Click: 'http://localhost:3917/trips.html?id=1' });
  });

  it('rejects on a non-2xx response', async () => {
    const fakeFetch = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    await expect(sendNtfy('topic', event, null, fakeFetch)).rejects.toThrow(/500/);
  });
});
