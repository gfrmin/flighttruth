import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store, type Trip } from '../src/store.js';
import { createTripPoller, nextPollAt, pollTrip, type PollerDeps } from '../src/poller.js';
import { deriveTripView, type LegSnapshot } from '../src/trip.js';
import type { AlertEvent } from '../src/alerts.js';
import type { FlightLookupResult } from '../src/lookupFlight.js';
import type { FlightQuery } from '../src/types.js';

const legs = [
  { flightNumber: 'EY101', date: '2026-10-10' },
  { flightNumber: 'EY102', date: '2026-10-10' },
];

const FLIGHTS: Record<string, Record<string, string>> = {
  EY101: { origin: 'TLV', destination: 'AUH', scheduledDeparture: '2026-10-10T12:05:00.000Z', scheduledArrival: '2026-10-10T15:20:00.000Z', tailNumber: 'A6-XAA' },
  EY102: { origin: 'AUH', destination: 'HKG', scheduledDeparture: '2026-10-10T17:10:00.000Z', scheduledArrival: '2026-10-11T01:00:00.000Z' },
};

const fakeResult = (q: FlightQuery): FlightLookupResult => ({
  query: q,
  fetchedAt: '2026-10-10T08:00:00.000Z',
  distributions: Object.entries(FLIGHTS[q.query]).map(([field, value]) => ({
    field: field as never, values: [{ value, weight: 1, sources: ['flightstats'] }], unconfirmed: true, paywalledAt: [],
  })),
  sourceResults: [{
    source: 'flightstats', fetchedAt: '2026-10-10T08:00:00.000Z',
    fields: Object.fromEntries(Object.entries(FLIGHTS[q.query]).map(([f, v]) => [f, { value: v, paywalled: false, raw: v }])),
  }],
  codeshareFlightNumbers: [],
});

function makeDeps(store: Store, overrides: Partial<PollerDeps> = {}) {
  const sent: AlertEvent[] = [];
  const deps: PollerDeps = {
    store,
    lookup: async (q) => fakeResult(q),
    notify: async (e) => { sent.push(e); },
    now: () => new Date('2026-10-10T08:00:00.000Z'),
    log: () => {},
    ...overrides,
  };
  return { deps, sent };
}

const scheduledView = () =>
  deriveTripView(legs.map((l) => ({
    flightNumber: l.flightNumber, date: l.date, origin: null, destination: null, actualDeparture: null, actualArrival: null,
    status: null, tailNumber: null, aircraftType: null, scheduledArrival: null,
    scheduledDeparture: FLIGHTS[l.flightNumber].scheduledDeparture,
  }) as LegSnapshot));

const tripWith = (overrides: Partial<Trip> = {}): Trip => ({
  id: 1, label: 't', createdAt: '', active: true, legs: legs.map((l, seq) => ({ ...l, seq })), lastView: null, nextPollAt: null, ...overrides,
});

describe('nextPollAt', () => {
  it('polls hourly until 3h before the first departure', () => {
    expect(nextPollAt(tripWith(), scheduledView(), new Date('2026-10-10T08:00:00.000Z'))).toBe('2026-10-10T09:00:00.000Z');
  });

  it('polls every 10 minutes from 3h before the first departure', () => {
    expect(nextPollAt(tripWith(), scheduledView(), new Date('2026-10-10T10:00:00.000Z'))).toBe('2026-10-10T10:10:00.000Z');
  });

  it('goes fast for a later leg even when an earlier leg has no data', () => {
    const view = scheduledView();
    const blind = { ...view, legs: [{ ...view.legs[0], departure: { ...view.legs[0].departure, scheduled: null } }, ...view.legs.slice(1)] };
    const second = Date.parse(view.legs[1].departure.scheduled!.utc);
    const now = new Date(second - 2 * 3600_000);
    expect(nextPollAt(tripWith(), blind, now)).toBe(new Date(now.getTime() + 10 * 60_000).toISOString());
  });

  it('keeps polling for an hour after the last landing, then stops', () => {
    const view = scheduledView();
    const last = view.legs.at(-1)!;
    const landedAt = '2026-10-10T20:00:00.000Z';
    const complete = {
      ...view,
      state: 'complete' as const,
      legs: [...view.legs.slice(0, -1), { ...last, arrival: { ...last.arrival, best: { ...last.arrival.best!, utc: landedAt } } }],
    };
    expect(nextPollAt(tripWith(), complete, new Date('2026-10-10T20:30:00.000Z'))).toBe('2026-10-10T20:40:00.000Z');
    expect(nextPollAt(tripWith(), complete, new Date('2026-10-10T21:00:00.000Z'))).toBeNull();
  });

  it('polls every 10 minutes on the travel day even before any schedule is known', () => {
    const blank = deriveTripView(legs.map((l) => ({
      flightNumber: l.flightNumber, date: l.date, origin: null, destination: null, scheduledDeparture: null,
      actualDeparture: null, scheduledArrival: null, actualArrival: null, status: null, tailNumber: null, aircraftType: null,
    })));
    expect(nextPollAt(tripWith(), blank, new Date('2026-10-10T15:00:00.000Z'))).toBe('2026-10-10T15:10:00.000Z');
  });

  it('polls every 5 min while a landed leg awaits the gate, then 10 min, until an hour after landing', () => {
    const landed = deriveTripView(legs.map((l) => ({
      ...FLIGHTS[l.flightNumber], flightNumber: l.flightNumber, date: l.date,
      actualArrival: l.flightNumber === 'EY102' ? '2026-10-11T00:57:50.000Z' : '2026-10-10T14:43:54.000Z',
      gateArrival: l.flightNumber === 'EY102' ? null : '2026-10-10T14:52:00.000Z',
    }) as unknown as LegSnapshot));
    expect(landed.state).toBe('complete');
    expect(nextPollAt(tripWith(), landed, new Date('2026-10-11T01:01:00.000Z'))).toBe('2026-10-11T01:06:00.000Z');
    expect(nextPollAt(tripWith(), landed, new Date('2026-10-11T02:00:00.000Z'))).toBeNull();
    const atGate = deriveTripView(landed.legs.map((l) => ({ ...l, gateArrival: l.gateArrival ?? '2026-10-11T01:05:00.000Z' })));
    expect(nextPollAt(tripWith(), atGate, new Date('2026-10-11T01:06:00.000Z'))).toBe('2026-10-11T01:16:00.000Z');
    expect(nextPollAt(tripWith(), atGate, new Date('2026-10-11T01:58:00.000Z'))).toBeNull();
  });

  it('stops when the trip is complete', () => {
    const complete = { ...scheduledView(), state: 'complete' as const };
    expect(nextPollAt(tripWith(), complete, new Date('2026-10-11T02:00:00.000Z'))).toBeNull();
  });

  it('stops for a trip whose last leg date is more than three days past', () => {
    expect(nextPollAt(tripWith(), scheduledView(), new Date('2026-10-13T08:00:00.000Z'))).toBeNull();
  });
});

describe('pollTrip', () => {
  let store: Store;
  let dir: string | null = null;
  afterEach(() => {
    store?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('records observations, notifies once per new event and saves state', async () => {
    store = openStore(':memory:');
    const trip = store.addTrip('t', legs);
    const { deps, sent } = makeDeps(store);
    await pollTrip(trip, deps);
    expect(sent.map((e) => e.dedupeKey)).toEqual(['t1:EY101:tail:A6-XAA']);
    expect(store.countObservations()).toBeGreaterThan(0);
    const reloaded = store.getTrip(trip.id)!;
    expect(reloaded.lastView?.connections[0].scheduledMinutes).toBe(110);
    expect(reloaded.nextPollAt).toBe('2026-10-10T09:00:00.000Z');
    await pollTrip(reloaded, deps);
    expect(sent).toHaveLength(1);
  });

  it('tells listeners once the new view is saved', async () => {
    store = openStore(':memory:');
    const trip = store.addTrip('t', legs);
    const saved: Array<[number, boolean]> = [];
    const s = store;
    await pollTrip(trip, makeDeps(store, { onSaved: (id) => saved.push([id, s.getTrip(id)!.lastView !== null]) }).deps);
    expect(saved).toEqual([[trip.id, true]]);
  });

  it('does not resend alerts after a restart even without a saved view', async () => {
    dir = mkdtempSync(join(tmpdir(), 'flighttruth-poller-'));
    const path = join(dir, 'ft.db');
    store = openStore(path);
    const trip = store.addTrip('t', legs);
    await pollTrip(trip, makeDeps(store).deps);
    store.close();
    store = openStore(path);
    const { deps, sent } = makeDeps(store);
    await pollTrip({ ...store.getTrip(trip.id)!, lastView: null }, deps);
    expect(sent).toEqual([]);
  });

  it('keeps going when one leg lookup throws', async () => {
    store = openStore(':memory:');
    const trip = store.addTrip('t', legs);
    const { deps } = makeDeps(store, {
      lookup: async (q) => {
        if (q.query === 'EY102') throw new Error('bdata timeout');
        return fakeResult(q);
      },
    });
    const view = await pollTrip(trip, deps);
    expect(store.countObservations()).toBeGreaterThan(0);
    expect(view.legs[0].tailNumber).toBe('A6-XAA');
    expect(view.legs[1].phase).toBe('unknown');
  });

  it('carries a failed leg over from the previous view', async () => {
    store = openStore(':memory:');
    const trip = store.addTrip('t', legs);
    const first = await pollTrip(trip, makeDeps(store).deps);
    const { deps } = makeDeps(store, { lookup: async () => { throw new Error('down'); } });
    const view = await pollTrip({ ...store.getTrip(trip.id)!, lastView: first }, deps);
    expect(view.legs[0].tailNumber).toBe('A6-XAA');
  });

  it('does not mark an alert sent when notify fails', async () => {
    store = openStore(':memory:');
    const trip = store.addTrip('t', legs);
    const { deps } = makeDeps(store, { notify: async () => { throw new Error('ntfy down'); } });
    await pollTrip(trip, deps);
    expect(store.hasAlert('t1:EY101:tail:A6-XAA')).toBe(false);
  });

  it('keeps a landed trip active to let sources settle, then deactivates it', async () => {
    store = openStore(':memory:');
    const trip = store.addTrip('t', legs);
    const arrivedLookup = async (q: Parameters<PollerDeps['lookup']>[0]) => {
      const r = fakeResult(q);
      r.distributions.push({ field: 'status', values: [{ value: 'Arrived', weight: 1, sources: ['flightstats'] }], unconfirmed: true, paywalledAt: [] });
      return r;
    };
    const view = await pollTrip(trip, makeDeps(store, { lookup: arrivedLookup }).deps);
    const landed = Date.parse(view.legs.at(-1)!.arrival.best!.utc);

    await pollTrip(trip, makeDeps(store, { lookup: arrivedLookup, now: () => new Date(landed + 30 * 60_000) }).deps);
    expect(store.getTrip(trip.id)!.active).toBe(true);
    await pollTrip(trip, makeDeps(store, { lookup: arrivedLookup, now: () => new Date(landed + 61 * 60_000) }).deps);
    expect(store.getTrip(trip.id)!.active).toBe(false);
  });

  it('reactivates a stopped trip when a poll finds it still has something to wait for', async () => {
    store = openStore(':memory:');
    const trip = store.addTrip('t', legs);
    store.setTripActive(trip.id, false);
    const { deps } = makeDeps(store);
    await pollTrip(store.getTrip(trip.id)!, deps);
    expect(store.getTrip(trip.id)!.active).toBe(true);
  });

  it('retries a push whose send failed on the next poll', async () => {
    store = openStore(':memory:');
    const trip = store.addTrip('t', legs);
    let fail = true;
    const sent: string[] = [];
    const { deps } = makeDeps(store, {
      notify: async (e) => {
        if (fail) throw new Error('ntfy down');
        sent.push(e.dedupeKey);
      },
    });
    await pollTrip(trip, deps);
    fail = false;
    await pollTrip(store.getTrip(trip.id)!, deps);
    expect(sent).toEqual(['t1:EY101:tail:A6-XAA']);
  });

  it('keeps the last known leg state when every source fails without throwing', async () => {
    store = openStore(':memory:');
    const trip = store.addTrip('t', legs);
    const first = await pollTrip(trip, makeDeps(store).deps);
    const { deps } = makeDeps(store, {
      lookup: async (q) => ({ ...fakeResult(q), distributions: [], sourceResults: [{ source: 'flightstats', fetchedAt: '', fields: {}, error: 'blocked' }] }),
    });
    const view = await pollTrip({ ...store.getTrip(trip.id)!, lastView: first }, deps);
    expect(view.legs[0].tailNumber).toBe('A6-XAA');
    expect(view.legs[0].departure.scheduled).not.toBeNull();
  });
});

describe('pollTrip blind-leg alerts', () => {
  const blindLookup = async (q: FlightQuery): Promise<FlightLookupResult> => q.query === 'EY102'
    ? { ...fakeResult(q), distributions: [], sourceResults: [
      { source: 'aeroapi', fetchedAt: '', fields: {}, error: 'HTTP 401' },
      { source: 'openSky', fetchedAt: '', fields: {}, error: 'not airborne' },
    ] }
    : fakeResult(q);

  it('pushes once when no source has anything on a leg around its date', async () => {
    const store = openStore(':memory:');
    const trip = store.addTrip('t', legs);
    const { deps, sent } = makeDeps(store, { lookup: blindLookup });
    await pollTrip(trip, deps);
    await pollTrip(store.getTrip(trip.id)!, deps);
    const blind = sent.filter((e) => e.dedupeKey.endsWith(':blind'));
    expect(blind).toHaveLength(1);
    expect(blind[0]).toMatchObject({ dedupeKey: 't1:EY102:2026-10-10:blind', priority: 4 });
    expect(blind[0].message).toContain('aeroapi: HTTP 401');
    store.close();
  });

  it('also pushes when the lookup itself throws', async () => {
    const store = openStore(':memory:');
    const trip = store.addTrip('t', legs);
    const { deps, sent } = makeDeps(store, { lookup: async () => { throw new Error('boom'); } });
    await pollTrip(trip, deps);
    expect(sent.filter((e) => e.dedupeKey.endsWith(':blind')).map((e) => e.message)).toEqual([
      expect.stringContaining('boom'), expect.stringContaining('boom'),
    ]);
    store.close();
  });

  it('stays quiet while the flight is still days away', async () => {
    const store = openStore(':memory:');
    const trip = store.addTrip('t', legs);
    const { deps, sent } = makeDeps(store, { lookup: blindLookup, now: () => new Date('2026-10-07T08:00:00.000Z') });
    await pollTrip(trip, deps);
    expect(sent.filter((e) => e.dedupeKey.endsWith(':blind'))).toEqual([]);
    store.close();
  });
});

describe('pollTrip stale events', () => {
  it('records but does not push milestones that happened more than two hours ago', async () => {
    const store = openStore(':memory:');
    const trip = store.addTrip('t', legs);
    const tookOff = { ...FLIGHTS.EY101, actualDeparture: '2026-10-10T11:30:00.000Z' };
    const sent: string[] = [];
    const { deps } = makeDeps(store, {
      lookup: async (q) => {
        const r = fakeResult(q);
        if (q.query === 'EY101') {
          r.distributions.push({ field: 'actualDeparture', values: [{ value: tookOff.actualDeparture, weight: 1, sources: ['flightradar24'] }], unconfirmed: true, paywalledAt: [] });
        }
        return r;
      },
      notify: async (e) => { sent.push(e.dedupeKey); },
      now: () => new Date('2026-10-10T15:00:00.000Z'),
    });
    await pollTrip(trip, deps);
    expect(sent).not.toContain('t1:EY101:takeoff');
    expect(store.hasAlert('t1:EY101:takeoff')).toBe(true);
    store.close();
  });
});

describe('pollTrip live position', () => {
  const position = { hex: '89669a', callsign: 'ETD75C', lat: 24.4, lon: 54.7, altitudeFt: 1275, groundSpeedKt: 145, trackDeg: 310, onGround: false, seenAt: '2026-10-10T14:40:10.000Z', source: 'adsb.lol' };

  it('attaches the live position of each assigned plane that has not landed, and records it', async () => {
    const store = openStore(':memory:');
    const trip = store.addTrip('t', legs);
    const asked: string[] = [];
    const recorded: string[] = [];
    const record = store.recordObservations;
    store.recordObservations = (kind, key, source, ...rest) => { recorded.push(`${kind}:${key}:${source}`); record(kind, key, source, ...rest); };
    const { deps } = makeDeps(store, { position: async (reg) => { asked.push(reg); return position; } });
    const view = await pollTrip(trip, deps);
    expect(asked).toEqual(['A6-XAA']);
    expect(view.legs[0].position).toEqual(position);
    expect(view.legs[1].position ?? null).toBeNull();
    expect(recorded).toEqual(['aircraft:A6-XAA:adsb.lol']);
    const before = store.countObservations();
    await pollTrip(store.getTrip(trip.id)!, deps);
    expect(store.countObservations()).toBeGreaterThan(before);
    store.close();
  });

  it('keeps polling when the position lookup fails', async () => {
    const store = openStore(':memory:');
    const trip = store.addTrip('t', legs);
    const logs: string[] = [];
    const { deps } = makeDeps(store, { position: async () => { throw new Error('opensky down'); }, log: (m) => logs.push(m) });
    const view = await pollTrip(trip, deps);
    expect(view.legs[0].tailNumber).toBe('A6-XAA');
    expect(logs.some((l) => l.includes('opensky down'))).toBe(true);
    store.close();
  });
});

describe('pollTrip position by callsign', () => {
  const dist = (field: string, value: string) =>
    ({ field, values: [{ value, weight: 1, sources: ['flightradar24'] }], unconfirmed: true, paywalledAt: [] }) as unknown as FlightLookupResult['distributions'][number];
  const position = { hex: '400a1b', callsign: 'EZY12AB', lat: 48.3, lon: -3.2, altitudeFt: 37975, groundSpeedKt: 510, trackDeg: 37, onGround: false, seenAt: '2026-10-10T14:00:00.000Z', source: 'adsb.lol' };
  const airborneNoTail = (q: FlightQuery): FlightLookupResult => {
    const base = fakeResult(q);
    if (q.query !== 'EY101') return base;
    const extra = { callsign: 'EZY12AB', actualDeparture: '2026-10-10T12:20:00.000Z' };
    return {
      ...base,
      distributions: [
        ...base.distributions.filter((d) => d.field !== 'tailNumber'),
        ...Object.entries(extra).map(([field, value]) => dist(field, value)),
      ],
    };
  };

  it('finds a departed plane with no known registration by the callsign it broadcasts', async () => {
    const store = openStore(':memory:');
    const trip = store.addTrip('t', legs);
    const asked: string[] = [];
    const { deps } = makeDeps(store, {
      lookup: async (q) => airborneNoTail(q),
      position: async () => { throw new Error('registration lookup should not run'); },
      positionByCallsign: async (cs) => { asked.push(cs); return position; },
      now: () => new Date('2026-10-10T14:00:00.000Z'),
    });
    const view = await pollTrip(trip, deps);
    expect(asked).toEqual(['EZY12AB']);
    expect(view.legs[0].position).toEqual(position);
    store.close();
  });

  it('does not search by callsign before the flight has left', async () => {
    const store = openStore(':memory:');
    const trip = store.addTrip('t', legs);
    const asked: string[] = [];
    const { deps } = makeDeps(store, {
      lookup: async (q) => ({ ...fakeResult(q), distributions: [...fakeResult(q).distributions.filter((d) => d.field !== 'tailNumber'),
        dist('callsign', 'ETD75C')] }),
      positionByCallsign: async (cs) => { asked.push(cs); return position; },
    });
    await pollTrip(trip, deps);
    expect(asked).toEqual([]);
    store.close();
  });

  it('falls back to the callsign when the registration lookup finds nothing for a departed flight', async () => {
    const store = openStore(':memory:');
    const trip = store.addTrip('t', legs);
    const asked: string[] = [];
    const { deps } = makeDeps(store, {
      lookup: async (q) => {
        const r = fakeResult(q);
        if (q.query !== 'EY101') return r;
        return { ...r, distributions: [...r.distributions,
          dist('callsign', 'ETD75C'),
          dist('actualDeparture', '2026-10-10T12:20:00.000Z')] };
      },
      position: async () => { throw new Error('no transponder code for A6-XAA'); },
      positionByCallsign: async (cs) => { asked.push(cs); return position; },
      now: () => new Date('2026-10-10T14:00:00.000Z'),
    });
    const view = await pollTrip(trip, deps);
    expect(asked).toEqual(['ETD75C']);
    expect(view.legs[0].position).toEqual(position);
    store.close();
  });
});

describe('createTripPoller', () => {
  it('runs concurrent polls of the same trip only once', async () => {
    const store = openStore(':memory:');
    const trip = store.addTrip('t', legs);
    let lookups = 0;
    const sent: string[] = [];
    const { deps } = makeDeps(store, {
      lookup: async (q) => {
        lookups += 1;
        await new Promise((r) => setTimeout(r, 20));
        return fakeResult(q);
      },
      notify: async (e) => { sent.push(e.dedupeKey); },
    });
    const poller = createTripPoller(deps);
    await Promise.all([poller.pollNow(trip.id), poller.pollNow(trip.id)]);
    expect(lookups).toBe(2);
    expect(sent).toEqual(['t1:EY101:tail:A6-XAA']);
    store.close();
  });
});
