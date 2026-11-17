import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { openStore, type Store } from '../src/store.js';
import type { SourceResult } from '../src/types.js';
import type { TripView } from '../src/trip.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

const legs = [
  { flightNumber: 'EY101', date: '2026-10-10' },
  { flightNumber: 'EY102', date: '2026-10-10' },
];

const results: SourceResult[] = [
  {
    source: 'flightstats',
    fetchedAt: '2026-10-10T11:00:00.000Z',
    fields: { tailNumber: { value: 'A6-XAA', paywalled: false, raw: 'A6-XAA' } },
  },
  { source: 'openSky', fetchedAt: '2026-10-10T11:00:00.000Z', fields: {}, error: 'not airborne' },
];

describe('store', () => {
  let store: Store;
  let dir: string | null = null;
  afterEach(() => {
    store?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('adds a trip with ordered legs, active and without a view', () => {
    store = openStore(':memory:');
    const trip = store.addTrip('Wife HK', legs);
    const loaded = store.getTrip(trip.id)!;
    expect(loaded.legs.map((l) => l.seq)).toEqual([0, 1]);
    expect(loaded.legs.map((l) => l.flightNumber)).toEqual(['EY101', 'EY102']);
    expect(loaded.active).toBe(true);
    expect(loaded.lastView).toBeNull();
    expect(loaded.label).toBe('Wife HK');
  });

  it('records one observation per field and one per errored source', () => {
    store = openStore(':memory:');
    store.recordSourceResults('EY101@2026-10-10', results);
    expect(store.countObservations()).toBe(2);
  });

  it('is append-only across repeated recordings', () => {
    store = openStore(':memory:');
    store.recordSourceResults('EY101@2026-10-10', results);
    store.recordSourceResults('EY101@2026-10-10', results);
    expect(store.countObservations()).toBe(4);
  });

  it('round-trips the saved trip state', () => {
    store = openStore(':memory:');
    const trip = store.addTrip('t', legs);
    const view = { legs: [], connections: [], totalMinutes: 775, state: 'upcoming' } as unknown as TripView;
    store.saveTripState(trip.id, view, '2026-10-10T12:00:00Z');
    const loaded = store.getTrip(trip.id)!;
    expect(loaded.lastView).toEqual(view);
    expect(loaded.nextPollAt).toBe('2026-10-10T12:00:00Z');
  });

  it('tracks sent alerts idempotently', () => {
    store = openStore(':memory:');
    expect(store.hasAlert('k')).toBe(false);
    store.recordAlert({ dedupeKey: 'k', title: 't', message: 'b' }, true);
    expect(store.hasAlert('k')).toBe(true);
    expect(() => store.recordAlert({ dedupeKey: 'k', title: 't', message: 'b' }, true)).not.toThrow();
  });

  it('listAlerts returns a trip\'s alerts newest first, with title and event time', async () => {
    store = openStore(':memory:');
    store.recordAlert({ dedupeKey: 't1:U21234:pushback', title: 'U21234 left the gate', message: 'U21234 left gate D32 at LPA 12:46', at: '2026-11-10T12:46:00.000Z' }, true);
    await new Promise((r) => setTimeout(r, 5));
    store.recordAlert({ dedupeKey: 't1:U21234:takeoff', title: 'U21234 took off', message: 'U21234 took off from LPA 12:57', at: '2026-11-10T12:57:00.000Z' }, true);
    const alerts = store.listAlerts(1);
    expect(alerts).toHaveLength(2);
    expect(alerts[0].title).toBe('U21234 took off');
    expect(alerts[1].at).toBe('2026-11-10T12:46:00.000Z');
    expect(alerts[1].pushed).toBe(true);
    expect(store.listAlerts(2)).toEqual([]);
  });

  it('listAlerts puts the later of two alerts sent in the same instant first', () => {
    vi.useFakeTimers({ now: new Date('2026-11-10T12:58:00.000Z') });
    try {
      store = openStore(':memory:');
      store.recordAlert({ dedupeKey: 't1:U21234:pushback', title: 'left the gate', message: 'a' }, false);
      store.recordAlert({ dedupeKey: 't1:U21234:takeoff', title: 'took off', message: 'b' }, false);
      expect(store.listAlerts(1).map((a) => a.title)).toEqual(['took off', 'left the gate']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('recordAlert keeps the first record for a dedupe key', () => {
    store = openStore(':memory:');
    store.recordAlert({ dedupeKey: 't1:X:landed', title: 'X landed', message: 'first' }, true);
    store.recordAlert({ dedupeKey: 't1:X:landed', title: 'X landed', message: 'second' }, true);
    expect(store.listAlerts(1).map((a) => a.message)).toEqual(['first']);
  });

  it('alerts saved by the old schema still list', () => {
    dir = mkdtempSync(join(tmpdir(), 'ft-'));
    const path = join(dir, 'old.db');
    const old = new DatabaseSync(path);
    old.exec('CREATE TABLE alert (dedupe_key TEXT PRIMARY KEY, sent_at TEXT NOT NULL, body TEXT NOT NULL)');
    old.prepare('INSERT INTO alert VALUES (?, ?, ?)').run('t1:EY101:landed', '2026-10-10T14:50:00Z', '[not pushed, stale] EY101 landed at AUH 18:43');
    old.close();
    store = openStore(path);
    expect(store.listAlerts(1)).toEqual([
      { sentAt: '2026-10-10T14:50:00Z', title: null, message: 'EY101 landed at AUH 18:43', at: null, pushed: false },
    ]);
  });

  it('lists trips newest first and can deactivate', () => {
    store = openStore(':memory:');
    const a = store.addTrip('a', legs);
    const b = store.addTrip('b', legs);
    expect(store.listTrips().map((t) => t.id)).toEqual([b.id, a.id]);
    store.setTripActive(a.id, false);
    expect(store.getTrip(a.id)!.active).toBe(false);
  });

  it('creates the parent directory for a file path', () => {
    dir = mkdtempSync(join(tmpdir(), 'flighttruth-store-'));
    const path = join(dir, 'a/b/c.db');
    store = openStore(path);
    expect(existsSync(path)).toBe(true);
  });
});
