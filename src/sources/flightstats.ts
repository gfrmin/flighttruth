import type { FieldName, FlightQuery, SourceFetcher, SourceResult } from '../types.js';
import { splitFlightNumber } from '../airlineCodes.js';
import { scrapeHtml } from '../scrape.js';

// FlightStats' v2 flight-tracker page is a Next.js app; the full flight object it hydrates
// with is embedded server-side as `__NEXT_DATA__ = {...};__NEXT_LOADED_PAGES__=...`, so it's
// extracted as JSON rather than scraped from rendered markup -- confirmed live against BA183
// to hold clean UTC timestamps, IATA airport codes, and a descriptive aircraft name directly
// (no meta-tag or DOM-position guessing needed, unlike flightaware/flightradar24).
//
// It also carries a `codeshares` array (e.g. BA183 listed as American Airlines AA6942) and a
// `positional.flexTrack` object whose carrier/flight-number pair is the true *operating*
// identity regardless of which marketing or operating number reached this page -- used by
// extractOperatingFlightNumber/extractCodeshareNumbers below for codeshare resolution.
interface FlightStatsFlight {
  schedule?: {
    scheduledDepartureUTC?: string;
    estimatedActualDepartureUTC?: string;
    estimatedActualDepartureTitle?: string;
    estimatedActualDepartureRunway?: boolean;
    scheduledArrivalUTC?: string;
    estimatedActualArrivalUTC?: string;
    estimatedActualArrivalTitle?: string;
    estimatedActualArrivalRunway?: boolean;
  };
  departureAirport?: { terminal?: string | null; gate?: string | null };
  arrivalAirport?: { terminal?: string | null; gate?: string | null; baggage?: string | null };
  status?: { status?: string };
  resultHeader?: {
    carrier?: { name?: string };
    departureAirportFS?: string;
    arrivalAirportFS?: string;
  };
  additionalFlightInfo?: { equipment?: { name?: string; iata?: string } };
  positional?: { flexTrack?: { tailNumber?: string; callsign?: string; carrierFsCode?: string; flightNumber?: string } };
  codeshares?: { fs?: string; flightNumber?: string; name?: string }[];
}

function extractNextData(html: string): FlightStatsFlight | null {
  const startMarker = '__NEXT_DATA__ = ';
  const endMarker = ';__NEXT_LOADED_PAGES__';
  const start = html.indexOf(startMarker);
  const end = html.indexOf(endMarker);
  if (start === -1 || end === -1) return null;

  try {
    const data = JSON.parse(html.slice(start + startMarker.length, end));
    return data?.props?.initialState?.flightTracker?.flight ?? null;
  } catch {
    return null;
  }
}

export function extractFlightStatsFields(html: string): SourceResult['fields'] {
  const fields: SourceResult['fields'] = {};
  const flight = extractNextData(html);
  if (!flight) return fields;
  const set = (field: FieldName, value: string | null | undefined) => {
    if (value) fields[field] = { value, paywalled: false, raw: value };
  };

  const airline = flight.resultHeader?.carrier?.name;
  if (airline) fields.airline = { value: airline, paywalled: false, raw: airline };

  const origin = flight.resultHeader?.departureAirportFS;
  if (origin) fields.origin = { value: origin, paywalled: false, raw: origin };

  const destination = flight.resultHeader?.arrivalAirportFS;
  if (destination) fields.destination = { value: destination, paywalled: false, raw: destination };

  const status = flight.status?.status;
  if (status) fields.status = { value: status, paywalled: false, raw: status };

  const aircraftType = flight.additionalFlightInfo?.equipment?.name ?? flight.additionalFlightInfo?.equipment?.iata;
  if (aircraftType) fields.aircraftType = { value: aircraftType, paywalled: false, raw: aircraftType };

  const tailNumber = flight.positional?.flexTrack?.tailNumber;
  if (tailNumber) fields.tailNumber = { value: tailNumber, paywalled: false, raw: tailNumber };

  const schedule = flight.schedule;
  if (schedule?.scheduledDepartureUTC) {
    fields.scheduledDeparture = { value: schedule.scheduledDepartureUTC, paywalled: false, raw: schedule.scheduledDepartureUTC };
  }
  if (schedule?.scheduledArrivalUTC) {
    fields.scheduledArrival = { value: schedule.scheduledArrivalUTC, paywalled: false, raw: schedule.scheduledArrivalUTC };
  }
  // "estimatedActual*" holds either a true actual time or a forward-looking estimate, told apart
  // only by its sibling "*Title"; "*Runway" says whether it is a runway or a gate time.
  const timeField = (title?: string, runway?: boolean, kind?: 'Departure' | 'Arrival'): FieldName | null => {
    if (title === 'Estimated') return `estimated${kind!}`;
    if (title === 'Actual') return runway ? `actual${kind!}` : `gate${kind!}`;
    return null;
  };
  const depField = timeField(schedule?.estimatedActualDepartureTitle, schedule?.estimatedActualDepartureRunway, 'Departure');
  if (depField && schedule?.estimatedActualDepartureUTC) set(depField, schedule.estimatedActualDepartureUTC);
  const arrField = timeField(schedule?.estimatedActualArrivalTitle, schedule?.estimatedActualArrivalRunway, 'Arrival');
  if (arrField && schedule?.estimatedActualArrivalUTC) set(arrField, schedule.estimatedActualArrivalUTC);

  set('departureTerminal', flight.departureAirport?.terminal);
  set('departureGate', flight.departureAirport?.gate);
  set('arrivalTerminal', flight.arrivalAirport?.terminal);
  set('arrivalGate', flight.arrivalAirport?.gate);
  set('baggage', flight.arrivalAirport?.baggage);
  set('callsign', flight.positional?.flexTrack?.callsign);

  return fields;
}

export function extractOperatingFlightNumber(html: string): string | null {
  const flexTrack = extractNextData(html)?.positional?.flexTrack;
  if (!flexTrack?.carrierFsCode || !flexTrack?.flightNumber) return null;
  return `${flexTrack.carrierFsCode}${flexTrack.flightNumber}`;
}

export function extractCodeshareNumbers(html: string): string[] {
  const codeshares = extractNextData(html)?.codeshares ?? [];
  return codeshares
    .map((cs) => (cs.fs && cs.flightNumber ? `${cs.fs}${cs.flightNumber}` : null))
    .filter((v): v is string => v !== null);
}

export const flightstatsSource: SourceFetcher = {
  id: 'flightstats',
  async fetch(query: FlightQuery): Promise<SourceResult> {
    const fetchedAt = new Date().toISOString();
    if (query.type !== 'number') {
      return { source: 'flightstats', fetchedAt, fields: {}, error: 'tail-number lookup not implemented for flightstats' };
    }

    const split = splitFlightNumber(query.query);
    if (!split) {
      return { source: 'flightstats', fetchedAt, fields: {}, error: `could not parse flight number "${query.query}"` };
    }

    const [year, month, day] = query.date.split('-').map(Number);
    if (!year || !month || !day) {
      return { source: 'flightstats', fetchedAt, fields: {}, error: `could not parse date "${query.date}"` };
    }

    try {
      const html = await scrapeHtml(
        `https://www.flightstats.com/v2/flight-tracker/${split.code}/${split.number}?year=${year}&month=${month}&date=${day}`
      );
      const fields = extractFlightStatsFields(html);
      if (Object.keys(fields).length === 0) {
        return { source: 'flightstats', fetchedAt, fields, error: 'no flight data found on page' };
      }
      const operatingFlightNumber = extractOperatingFlightNumber(html) ?? undefined;
      const codeshareFlightNumbers = extractCodeshareNumbers(html);
      return {
        source: 'flightstats',
        fetchedAt,
        fields,
        operatingFlightNumber,
        ...(codeshareFlightNumbers.length ? { codeshareFlightNumbers } : {}),
      };
    } catch (err) {
      return { source: 'flightstats', fetchedAt, fields: {}, error: (err as Error).message };
    }
  },
};
