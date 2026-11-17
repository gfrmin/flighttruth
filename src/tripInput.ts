import { normalizeFlightNumber } from './airlineCodes.js';

export type TripInput = { legs: { flightNumber: string; date: string }[] } | { error: string };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_LIKE = /^\d{1,4}[/.-]\d{1,2}([/.-]\d{1,4})?$/;
const FLIGHT_NUMBER = /^(?=.*[A-Z])[A-Z0-9]{2,3}\d{1,4}[A-Z]?$/;

const isRealDate = (iso: string): boolean => {
  const time = Date.parse(`${iso}T00:00:00Z`);
  return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === iso;
};

/**
 * Parses free text like "EY101 EY102 2026-10-10" or "EY101 2026-10-10 EY102 2026-10-11".
 * Each ISO date applies to the flight numbers before it that don't have a date yet.
 */
export function parseTripInput(text: string): TripInput {
  // Join an airline code separated from its number ("EY 101" -> "EY101").
  const joined = text.toUpperCase().replace(/\b([A-Z][A-Z0-9]|[A-Z0-9][A-Z])\s+(\d{1,4}[A-Z]?)\b/g, '$1$2');
  const tokens = joined.split(/[\s,]+/).filter(Boolean);

  const legs: { flightNumber: string; date: string }[] = [];
  let pending: string[] = [];
  for (const token of tokens) {
    if (ISO_DATE.test(token)) {
      if (!isRealDate(token)) return { error: `not a real date: ${token}` };
      legs.push(...pending.map((flightNumber) => ({ flightNumber, date: token })));
      pending = [];
    } else if (DATE_LIKE.test(token)) {
      return { error: 'dates must be YYYY-MM-DD' };
    } else if (FLIGHT_NUMBER.test(token)) {
      pending.push(normalizeFlightNumber(token));
    } else {
      return { error: `not a flight number or date: ${token}` };
    }
  }

  if (pending.length > 0) return { error: `no date given for ${pending.join(', ')}` };
  if (legs.length === 0) return { error: 'no flight numbers found' };
  return { legs };
}
