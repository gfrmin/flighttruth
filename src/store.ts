import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SourceResult } from './types.js';
import type { TripView } from './trip.js';
import type { AlertEvent } from './alerts.js';

export interface TripLeg {
  seq: number;
  flightNumber: string;
  date: string;
}

export interface Trip {
  id: number;
  label: string;
  createdAt: string;
  active: boolean;
  legs: TripLeg[];
  lastView: TripView | null;
  nextPollAt: string | null;
}

/** An alert as the trip page's timeline shows it. Rows from before 2026-11-17 have no title or event time. */
export interface TripAlert {
  sentAt: string;
  title: string | null;
  message: string;
  at: string | null;
  pushed: boolean;
}

export interface Store {
  addTrip(label: string, legs: Omit<TripLeg, 'seq'>[]): Trip;
  getTrip(id: number): Trip | null;
  /** Newest first. */
  listTrips(): Trip[];
  setTripActive(id: number, active: boolean): void;
  saveTripState(id: number, view: TripView, nextPollAt: string | null): void;
  /** Append-only: one row per reported field, plus one row (field NULL) per errored source. */
  recordSourceResults(subjectKey: string, results: SourceResult[]): void;
  /** One observation row per field, e.g. an aircraft's live position under its registration. */
  recordObservations(kind: 'flight' | 'aircraft', subjectKey: string, source: string, observedAt: string, fields: Record<string, string | null>): void;
  countObservations(): number;
  hasAlert(dedupeKey: string): boolean;
  /** First record per dedupe key wins; `pushed` is false for events marked sent without a push. */
  recordAlert(event: Pick<AlertEvent, 'dedupeKey' | 'title' | 'message' | 'at'>, pushed: boolean): void;
  /** Newest first. */
  listAlerts(tripId: number): TripAlert[];
  close(): void;
}

// Loaded via require: vitest 2's resolver doesn't know node:sqlite and strips the prefix.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS trip (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  last_view TEXT,
  next_poll_at TEXT
);
CREATE TABLE IF NOT EXISTS trip_leg (
  trip_id INTEGER NOT NULL REFERENCES trip(id),
  seq INTEGER NOT NULL,
  flight_number TEXT NOT NULL,
  date TEXT NOT NULL,
  PRIMARY KEY (trip_id, seq)
);
CREATE TABLE IF NOT EXISTS observation (
  observed_at TEXT NOT NULL,
  source TEXT NOT NULL,
  subject_kind TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  field TEXT,
  value TEXT,
  paywalled INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX IF NOT EXISTS observation_subject ON observation (subject_kind, subject_key, observed_at);
CREATE TABLE IF NOT EXISTS alert (
  dedupe_key TEXT PRIMARY KEY,
  sent_at TEXT NOT NULL,
  body TEXT NOT NULL
);
`;

interface AlertRow {
  sent_at: string;
  title: string | null;
  event_at: string | null;
  pushed: number | null;
  body: string;
}

const NOT_PUSHED_PREFIX = '[not pushed, stale] ';

// Alert keys start "t<tripId>:" (see alerts.ts and poller.ts).
const tripIdOf = (dedupeKey: string): number | null => {
  const m = /^t(\d+):/.exec(dedupeKey);
  return m ? Number(m[1]) : null;
};

// Rows from before the timeline existed carry only the body, with stale ones prefixed.
const toTripAlert = (r: AlertRow): TripAlert => {
  const legacyUnpushed = r.pushed === null && r.body.startsWith(NOT_PUSHED_PREFIX);
  return {
    sentAt: r.sent_at,
    title: r.title,
    message: legacyUnpushed ? r.body.slice(NOT_PUSHED_PREFIX.length) : r.body,
    at: r.event_at,
    pushed: r.pushed === null ? !legacyUnpushed : r.pushed === 1,
  };
};

function migrateAlertTable(db: InstanceType<typeof DatabaseSync>): void {
  const have = new Set((db.prepare('PRAGMA table_info(alert)').all() as { name: string }[]).map((c) => c.name));
  for (const [name, type] of [['trip_id', 'INTEGER'], ['title', 'TEXT'], ['event_at', 'TEXT'], ['pushed', 'INTEGER']]) {
    if (!have.has(name)) db.exec(`ALTER TABLE alert ADD COLUMN ${name} ${type}`);
  }
}

interface TripRow {
  id: number;
  label: string;
  created_at: string;
  active: number;
  last_view: string | null;
  next_poll_at: string | null;
}

interface LegRow {
  seq: number;
  flight_number: string;
  date: string;
}

export function openStore(path: string): Store {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  migrateAlertTable(db);

  const legsOf = (tripId: number): TripLeg[] =>
    (db.prepare('SELECT seq, flight_number, date FROM trip_leg WHERE trip_id = ? ORDER BY seq').all(tripId) as unknown as LegRow[])
      .map((r) => ({ seq: r.seq, flightNumber: r.flight_number, date: r.date }));

  const toTrip = (row: TripRow): Trip => ({
    id: row.id,
    label: row.label,
    createdAt: row.created_at,
    active: row.active === 1,
    legs: legsOf(row.id),
    lastView: row.last_view ? JSON.parse(row.last_view) : null,
    nextPollAt: row.next_poll_at,
  });

  const getTrip = (id: number): Trip | null => {
    const row = db.prepare('SELECT * FROM trip WHERE id = ?').get(id) as unknown as TripRow | undefined;
    return row ? toTrip(row) : null;
  };

  const insertObservation = db.prepare(
    `INSERT INTO observation (observed_at, source, subject_kind, subject_key, field, value, paywalled, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );

  return {
    addTrip(label, legs) {
      const { lastInsertRowid } = db
        .prepare('INSERT INTO trip (label, created_at) VALUES (?, ?)')
        .run(label, new Date().toISOString());
      const id = Number(lastInsertRowid);
      const insertLeg = db.prepare('INSERT INTO trip_leg (trip_id, seq, flight_number, date) VALUES (?, ?, ?, ?)');
      legs.forEach((leg, seq) => insertLeg.run(id, seq, leg.flightNumber, leg.date));
      return getTrip(id)!;
    },
    getTrip,
    listTrips: () =>
      (db.prepare('SELECT * FROM trip ORDER BY id DESC').all() as unknown as TripRow[]).map(toTrip),
    setTripActive(id, active) {
      db.prepare('UPDATE trip SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
    },
    saveTripState(id, view, nextPollAt) {
      db.prepare('UPDATE trip SET last_view = ?, next_poll_at = ? WHERE id = ?').run(JSON.stringify(view), nextPollAt, id);
    },
    recordSourceResults(subjectKey, results) {
      for (const r of results) {
        const fields = Object.entries(r.fields).filter(([, v]) => v !== undefined);
        if (r.error && fields.length === 0) {
          insertObservation.run(r.fetchedAt, r.source, 'flight', subjectKey, null, null, 0, r.error);
        }
        for (const [field, v] of fields) {
          insertObservation.run(r.fetchedAt, r.source, 'flight', subjectKey, field, v!.value, v!.paywalled ? 1 : 0, r.error ?? null);
        }
      }
    },
    recordObservations(kind, subjectKey, source, observedAt, fields) {
      for (const [field, value] of Object.entries(fields)) {
        insertObservation.run(observedAt, source, kind, subjectKey, field, value, 0, null);
      }
    },
    countObservations: () => (db.prepare('SELECT count(*) AS n FROM observation').get() as { n: number }).n,
    hasAlert: (key) => db.prepare('SELECT 1 FROM alert WHERE dedupe_key = ?').get(key) !== undefined,
    recordAlert(event, pushed) {
      db.prepare('INSERT OR IGNORE INTO alert (dedupe_key, sent_at, body, trip_id, title, event_at, pushed) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(event.dedupeKey, new Date().toISOString(), event.message, tripIdOf(event.dedupeKey), event.title, event.at ?? null, pushed ? 1 : 0);
    },
    listAlerts: (tripId) =>
      (db.prepare(
        `SELECT sent_at, title, event_at, pushed, body FROM alert
         WHERE trip_id = ? OR (trip_id IS NULL AND dedupe_key LIKE ?)
         ORDER BY sent_at DESC, rowid DESC`
      ).all(tripId, `t${tripId}:%`) as unknown as AlertRow[]).map(toTripAlert),
    close: () => db.close(),
  };
}
