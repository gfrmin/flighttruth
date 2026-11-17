import { chromium } from 'playwright-core';
import { splitFlightNumber } from '../airlineCodes.js';
import type { FieldName, FieldValue, FlightQuery, SourceFetcher, SourceResult } from '../types.js';

// Etihad's own flight status (etihad.com/en/manage/flight-status). The page's JSON API sits
// behind Akamai bot protection, so it is called from inside a real page opened through Bright
// Data's Browser API: the page load earns the cookies, then a same-origin fetch asks for any
// date. Times come with their UTC offset, so they convert exactly.
const PAGE = 'https://www.etihad.com/en/manage/flight-status';
const API = '/ada-services/bff-flight-status/service/flight-status/v1/by-flight-number?languageCode=en';

interface EyMovement {
  locationCode?: string;
  scheduledDate?: string; // "2026-11-07"
  scheduledTime?: string; // "03:25:00.000"
  estimatedDate?: string;
  estimatedTime?: string;
  actualDate?: string;
  actualTime?: string;
  terminal?: string;
  gate?: string;
  timeZone?: string; // "+0400"
}

export interface EyFlight {
  carrier?: string;
  flightNumber?: string;
  engFlightStatus?: string;
  flightStatusCode?: string;
  equipment?: string;
  departure: EyMovement;
  arrival: EyMovement;
}

export interface EyResponse {
  flightStatus?: { onds?: { flights?: EyFlight[] }[] };
}

/** "2026-11-07" + "03:25:00.000" + "+0400" → UTC ISO. */
const instant = (date?: string, time?: string, tz?: string): string | null => {
  if (!date || !time || !tz) return null;
  const offset = `${tz.slice(0, 3)}:${tz.slice(3)}`;
  const ms = Date.parse(`${date}T${time.slice(0, 5)}:00${offset}`);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
};

const times = (m: EyMovement) => {
  const scheduled = instant(m.scheduledDate, m.scheduledTime, m.timeZone);
  const actual = instant(m.actualDate, m.actualTime, m.timeZone);
  const estimated = instant(m.estimatedDate, m.estimatedTime, m.timeZone);
  return { scheduled, actual, estimated: actual || estimated === scheduled ? null : estimated };
};

const statusOf = (f: EyFlight): string | null => {
  const s = f.engFlightStatus?.trim();
  if (!s) return null;
  return /cancel/i.test(s) ? 'Cancelled' : s;
};

export function extractEtihadFields(f: EyFlight): SourceResult['fields'] {
  const dep = times(f.departure);
  const arr = times(f.arrival);
  const entries: [FieldName, string | null | undefined][] = [
    ['airline', 'Etihad Airways'],
    ['origin', f.departure.locationCode],
    ['destination', f.arrival.locationCode],
    ['scheduledDeparture', dep.scheduled],
    ['estimatedDeparture', dep.estimated],
    // Etihad's actuals are gate times: they match FlightAware's gate times, not its runway times.
    ['gateDeparture', dep.actual],
    ['scheduledArrival', arr.scheduled],
    ['estimatedArrival', arr.estimated],
    ['gateArrival', arr.actual],
    ['status', statusOf(f)],
    ['aircraftType', f.equipment],
    ['departureTerminal', f.departure.terminal],
    ['departureGate', f.departure.gate],
    ['arrivalTerminal', f.arrival.terminal],
    ['arrivalGate', f.arrival.gate],
  ];
  return Object.fromEntries(
    entries.flatMap(([k, v]): [FieldName, FieldValue][] => (v ? [[k, { value: v, paywalled: false, raw: v }]] : []))
  );
}

/** Asks Etihad for one flight number on one departure date; returns the parsed JSON. */
export type EtihadLookup = (flightNumber: string, date: string) => Promise<EyResponse>;

/** The real lookup: one Browser API session per call (a few seconds; throttled upstream). */
export const browserLookup = (wsEndpoint: string): EtihadLookup => async (flightNumber, date) => {
  const browser = await chromium.connectOverCDP(wsEndpoint, { timeout: 60_000 });
  try {
    const page = await browser.newPage();
    await page.goto(PAGE, { timeout: 90_000, waitUntil: 'domcontentloaded' });
    await page.waitForSelector('input[name="flightNumber"]', { timeout: 60_000 });
    const { status, body } = await page.evaluate(
      async ({ api, payload }) => {
        const r = await fetch(api, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        return { status: r.status, body: await r.text() };
      },
      { api: API, payload: { flightNumber, departureDate: date, betaFlag: true } }
    );
    if (status !== 200) throw new Error(`Etihad API HTTP ${status}`);
    return JSON.parse(body) as EyResponse;
  } finally {
    await browser.close();
  }
};

export function makeEtihadSource(lookup: EtihadLookup): SourceFetcher {
  return {
    id: 'etihad',
    async fetch(query: FlightQuery): Promise<SourceResult> {
      const fetchedAt = new Date().toISOString();
      const fail = (error: string): SourceResult => ({ source: 'etihad', fetchedAt, fields: {}, error });
      const split = query.type === 'number' ? splitFlightNumber(query.query.toUpperCase().replace(/[\s-]+/g, '')) : null;
      if (!split || split.code !== 'EY') return fail('only Etihad (EY) flight numbers');
      try {
        const number = split.number.replace(/^0+(?=\d)/, '');
        const flights = (await lookup(number, query.date)).flightStatus?.onds?.flatMap((o) => o.flights ?? []) ?? [];
        const match = flights.find((f) => f.departure.scheduledDate === query.date) ?? flights[0];
        if (!match) return fail(`Etihad has no EY${number} on ${query.date}`);
        return { source: 'etihad', fetchedAt, fields: extractEtihadFields(match) };
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  };
}
