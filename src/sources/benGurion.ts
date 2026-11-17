import { estimatedBlockMinutes, airportTimezone } from '../airports.js';
import { splitFlightNumber } from '../airlineCodes.js';
import { localDate, localToUtc } from '../time.js';
import type { FieldName, FieldValue, FlightQuery, SourceFetcher, SourceResult } from '../types.js';

// Ben Gurion (TLV) flight board, published by the Israel Airports Authority as open data on
// data.gov.il (CKAN datastore, no key, refreshed every few minutes). It covers only flights
// to and from TLV, a few days either side of today. Field names are the IAA's own:
//   CHOPER/CHFLTN airline + number, CHAORD "A"rrival or "D"eparture, CHLOC1 the other airport,
//   CHSTOL scheduled and CHPTOL latest time (Israel local, no offset), CHTERM terminal,
//   CHRMINE status in English.
const RESOURCE = 'e83f763b-b7d7-479e-b172-ae981ddc6de5';
const TLV = 'TLV';
const TLV_TZ = 'Asia/Jerusalem';

export interface IaaRecord {
  CHOPER: string;
  CHFLTN: string;
  CHAORD: 'A' | 'D';
  CHLOC1: string;
  CHSTOL: string; // "2026-11-07T05:05:00"
  CHPTOL: string | null;
  CHTERM: number | string | null;
  CHRMINE: string | null;
}

const toUtc = (local: string) => localToUtc(local.slice(0, 10), local.slice(11, 16), TLV_TZ);

/**
 * The query date is the local departure date at the origin. For departures from TLV that is
 * just the scheduled date; for arrivals the departure is estimated from the arrival minus a
 * distance-based flight time (good to about an hour, enough to tell daily flights apart).
 */
export function departureDateOf(r: IaaRecord): string | null {
  if (r.CHAORD === 'D') return r.CHSTOL.slice(0, 10);
  const block = estimatedBlockMinutes(r.CHLOC1, TLV);
  const tz = airportTimezone(r.CHLOC1);
  if (block === null || !tz) return null;
  return localDate(Date.parse(toUtc(r.CHSTOL)) - block * 60_000, tz);
}

const STATUS: Record<string, string> = {
  LANDED: 'Arrived',
  DEPARTED: 'Departed',
  CANCELED: 'Cancelled',
  CANCELLED: 'Cancelled',
};
const titleCase = (s: string) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
const statusOf = (r: IaaRecord) => (r.CHRMINE ? STATUS[r.CHRMINE.trim()] ?? titleCase(r.CHRMINE.trim()) : null);

export function extractIaaFields(r: IaaRecord): SourceResult['fields'] {
  const arriving = r.CHAORD === 'A';
  const done = ['LANDED', 'DEPARTED'].includes(r.CHRMINE?.trim() ?? '');
  const scheduled = toUtc(r.CHSTOL);
  const latest = r.CHPTOL ? toUtc(r.CHPTOL) : null;
  const kind = arriving ? 'Arrival' : 'Departure';
  // CHPTOL is the actual runway time once landed/departed (e.g. 05:15 touchdown, 05:21 at the
  // gate per four other sources), otherwise the current estimate (equal to the schedule when
  // nothing has changed, which says nothing new).
  const latestField: [FieldName, string | null][] = !latest
    ? []
    : done
      ? [[`actual${kind}` as FieldName, latest]]
      : latest !== scheduled
        ? [[`estimated${kind}` as FieldName, latest]]
        : [];
  const entries: [FieldName, string | null][] = [
    ['origin', arriving ? r.CHLOC1 : TLV],
    ['destination', arriving ? TLV : r.CHLOC1],
    [`scheduled${kind}` as FieldName, scheduled],
    ...latestField,
    ['status', statusOf(r)],
    [arriving ? 'arrivalTerminal' : 'departureTerminal', r.CHTERM == null || r.CHTERM === '' ? null : String(r.CHTERM)],
  ];
  return Object.fromEntries(
    entries.flatMap(([k, v]): [FieldName, FieldValue][] => (v ? [[k, { value: v, paywalled: false, raw: v }]] : []))
  );
}

export function makeBenGurionSource(fetchImpl: typeof fetch = fetch): SourceFetcher {
  return {
    id: 'benGurion',
    async fetch(query: FlightQuery): Promise<SourceResult> {
      const fetchedAt = new Date().toISOString();
      const fail = (error: string): SourceResult => ({ source: 'benGurion', fetchedAt, fields: {}, error });
      const split = query.type === 'number' ? splitFlightNumber(query.query.toUpperCase().replace(/[\s-]+/g, '')) : null;
      if (!split) return fail('only flight-number queries are supported');
      try {
        const url = new URL('https://data.gov.il/api/3/action/datastore_search');
        url.searchParams.set('resource_id', RESOURCE);
        url.searchParams.set('filters', JSON.stringify({ CHOPER: split.code, CHFLTN: split.number.replace(/^0+(?=\d)/, '') }));
        url.searchParams.set('limit', '50');
        const res = await fetchImpl(url.toString());
        if (!res.ok) return fail(`HTTP ${res.status}`);
        const body = (await res.json()) as { success?: boolean; result?: { records?: IaaRecord[] } };
        const records = body.result?.records ?? [];
        // A flight number that doesn't touch TLV is the normal case, not a fault.
        if (records.length === 0) return fail(`${split.code}${split.number} does not fly to or from TLV`);
        const match = records.find((r) => departureDateOf(r) === query.date);
        if (!match) return fail(`no ${split.code}${split.number} departing ${query.date} on the TLV board`);
        return { source: 'benGurion', fetchedAt, fields: extractIaaFields(match) };
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  };
}
