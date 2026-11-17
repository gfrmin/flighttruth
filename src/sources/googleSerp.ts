import * as cheerio from 'cheerio';
import { airportTimezone } from '../airports.js';
import { localToUtc } from '../time.js';
import type { FieldName, FieldValue, FlightQuery, SourceFetcher, SourceResult } from '../types.js';

// Google's "Flight status" card (data from Cirium), fetched as a rendered results page through
// Bright Data's SERP API. The card only shows the flight's current instance (yesterday's
// until it lands, then today's), so it can answer only when that instance is the query date.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// Exit-node locales vary: "3:25 AM", "3:25 am", "03.25", "19:45".
const TIME = String.raw`\d{1,2}[:.]\d{2}(?:\s?[AaPp][Mm])?`;

interface Movement {
  date: string; // YYYY-MM-DD, local to the airport
  label: string; // "Departed", "Scheduled departure", "Estimated arrival", ...
  time: string; // latest known local time
  scheduled: string; // scheduled local time
  terminal: string | null;
  gate: string | null;
  baggage: string | null;
}

export interface GoogleCard {
  origin: string;
  destination: string;
  departure: Movement;
  arrival: Movement;
  cancelled: boolean;
}

const dash = (s: string | undefined) => (!s || s === '-' ? null : s);

/** "Sat, Nov 7" → YYYY-MM-DD, choosing the year that puts it nearest the query date. */
function cardDate(monthName: string, day: string, near: string): string {
  const month = MONTHS.indexOf(monthName);
  const nearMs = Date.parse(`${near}T00:00:00Z`);
  const year = Number(near.slice(0, 4));
  const best = [year - 1, year, year + 1]
    .map((y) => Date.UTC(y, month, Number(day)))
    .reduce((a, b) => (Math.abs(a - nearMs) <= Math.abs(b - nearMs) ? a : b));
  return new Date(best).toISOString().slice(0, 10);
}

function parseMovement(section: string, near: string): Movement | null {
  // "Sat, Nov 7" (US) or "Sat, 7 Nov" (UK)
  const m = section.match(
    new RegExp(String.raw`\w{3}, (?:(\w{3}) (\d{1,2})|(\d{1,2}) (\w{3})) ([A-Za-z ]+?) (${TIME})(?: Originally scheduled \w+: (${TIME}))?`)
  );
  const monthName = m?.[1] ?? m?.[4];
  const day = m?.[2] ?? m?.[3];
  if (!m || !monthName || !day || !MONTHS.includes(monthName)) return null;
  const [, , , , , label, time, original] = m;
  return {
    date: cardDate(monthName, day, near),
    label,
    time,
    scheduled: original ?? time,
    terminal: dash(section.match(/Terminal (\S+)/)?.[1]),
    gate: dash(section.match(/Gate (\S+)/)?.[1]),
    baggage: dash(section.match(/Baggage(?: claim)? (\S+)/)?.[1]),
  };
}

/** Parses the card out of the page's visible text; null when Google showed no flight card. */
export function parseGoogleCard(text: string, near: string): GoogleCard | null {
  const start = text.indexOf('Flight status');
  if (start < 0) return null;
  const end = text.indexOf('Source:', start);
  const card = text.slice(start, end < 0 ? start + 2000 : end);
  const airports = [...card.matchAll(/\b([A-Z]{3}) Airport info/g)].map((m) => m[1]);
  // "<Origin city> · Sat, Nov 7 Departed ... <Destination city> · Sun, Nov 8 Estimated arrival ..."
  const [, depSection, arrSection] = card.split(' · ');
  if (airports.length < 2 || !depSection || !arrSection) return null;
  const departure = parseMovement(depSection, near);
  const arrival = parseMovement(arrSection, near);
  if (!departure || !arrival) return null;
  return { origin: airports[0], destination: airports[1], departure, arrival, cancelled: /\bCancel{1,2}ed\b/i.test(card) };
}

const isActual = (label: string) => /^(Departed|Arrived|Landed)$/.test(label);

function statusOf(c: GoogleCard): string {
  if (c.cancelled) return 'Cancelled';
  if (isActual(c.arrival.label)) return 'Arrived';
  if (isActual(c.departure.label)) return 'En Route';
  return 'Scheduled';
}

export function extractGoogleFields(c: GoogleCard): SourceResult['fields'] {
  const at = (iata: string, mv: Movement, t: string) => localToUtc(mv.date, t, airportTimezone(iata) ?? 'UTC');
  // The card's "Departed"/"Arrived" times are gate times (they match the airline's own).
  // The card gives a bare clock time for the latest time; it can fall on the day after (or
  // before) the scheduled date -- a 23:30 departure that leaves at "00:00" left the next day.
  const nearSchedule = (iata: string, mv: Movement, t: string): string => {
    const scheduled = Date.parse(at(iata, mv, mv.scheduled));
    const guess = Date.parse(at(iata, mv, t));
    const shift = guess - scheduled > 12 * 3600_000 ? -1 : scheduled - guess > 12 * 3600_000 ? 1 : 0;
    return new Date(guess + shift * 24 * 3600_000).toISOString();
  };
  const latest = (iata: string, mv: Movement, kind: 'Departure' | 'Arrival'): [FieldName, string][] =>
    mv.time === mv.scheduled && !isActual(mv.label)
      ? []
      : [[`${isActual(mv.label) ? 'gate' : 'estimated'}${kind}` as FieldName, nearSchedule(iata, mv, mv.time)]];
  const entries: [FieldName, string | null][] = [
    ['origin', c.origin],
    ['destination', c.destination],
    ['scheduledDeparture', at(c.origin, c.departure, c.departure.scheduled)],
    ...latest(c.origin, c.departure, 'Departure'),
    ['scheduledArrival', at(c.destination, c.arrival, c.arrival.scheduled)],
    ...latest(c.destination, c.arrival, 'Arrival'),
    ['status', statusOf(c)],
    ['departureTerminal', c.departure.terminal],
    ['departureGate', c.departure.gate],
    ['arrivalTerminal', c.arrival.terminal],
    ['arrivalGate', c.arrival.gate],
    ['baggage', c.arrival.baggage],
  ];
  return Object.fromEntries(
    entries.flatMap(([f, v]): [FieldName, FieldValue][] => (v ? [[f, { value: v, paywalled: false, raw: v }]] : []))
  );
}

export function makeGoogleSerpSource(apiKey: string, zone: string, fetchImpl: typeof fetch = fetch): SourceFetcher {
  return {
    id: 'googleSerp',
    async fetch(query: FlightQuery): Promise<SourceResult> {
      const fetchedAt = new Date().toISOString();
      const fail = (error: string): SourceResult => ({ source: 'googleSerp', fetchedAt, fields: {}, error });
      if (query.type === 'tail') return fail('Google has no flight card for tail numbers');
      try {
        const ident = query.query.toUpperCase().replace(/[\s-]+/g, '');
        const url = `https://www.google.com/search?q=${encodeURIComponent(`${ident} flight status`)}&hl=en&gl=us`;
        const res = await fetchImpl('https://api.brightdata.com/request', {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ zone, url, format: 'raw' }),
        });
        // Bright Data reports its own failures (captcha, IP allowlist) in headers on a 200.
        const brdError = res.headers.get('x-brd-error');
        if (brdError) return fail(`Bright Data: ${brdError}`);
        if (!res.ok) return fail(`HTTP ${res.status}`);

        const $ = cheerio.load(await res.text());
        $('script, style').remove();
        const card = parseGoogleCard($('body').text().replace(/\s+/g, ' '), query.date);
        if (!card) return fail('no flight card on the results page');
        if (card.departure.date !== query.date) return fail(`card shows the ${card.departure.date} flight`);
        return { source: 'googleSerp', fetchedAt, fields: extractGoogleFields(card) };
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  };
}
