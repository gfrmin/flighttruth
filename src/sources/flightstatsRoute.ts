import type { RouteCandidate, RouteQuery } from '../types.js';

// FlightStats' route/schedule-search UI (flight-tracker/route/<ORIGIN>/<DEST>) defaults to a
// 6-hour time window and requires manually stepping through 4 windows to see a whole day, so a
// flight genuinely on the route can be missed just outside the default window. The page's own "Refine
// Search" action calls a clean, unauthenticated JSON API instead, which accepts numHours=24
// to return the entire day in one request. It needs no Bright Data scrape -- confirmed
// reachable with a plain fetch() and no special headers, like openSky/adsbExchange.
interface RouteApiFlight {
  sortTime: string;
  departureTime?: { time24?: string };
  arrivalTime?: { time24?: string };
  carrier: { fs: string; name: string; flightNumber: string };
  operatedBy: string | null;
  url: string;
  isCodeshare?: boolean;
}

function flightNumberOf(f: RouteApiFlight): string {
  return `${f.carrier.fs}${f.carrier.flightNumber}`;
}

function flightGroupKey(f: RouteApiFlight): string {
  return /flightId=(\d+)/.exec(f.url)?.[1] ?? f.url;
}

export function buildFlightStatsRouteSearchUrl(query: RouteQuery): string {
  const [year, month, day] = query.date.split('-').map(Number);
  const origin = query.origin.toUpperCase();
  const destination = query.destination.toUpperCase();
  return `https://www.flightstats.com/v2/api-next/flight-tracker/route/${origin}/${destination}/${year}/${month}/${day}?carrierCode=&numHours=24&hour=0`;
}

export function extractRouteCandidates(rawJson: string): RouteCandidate[] {
  let flights: RouteApiFlight[];
  try {
    flights = JSON.parse(rawJson)?.data?.flights ?? [];
  } catch {
    return [];
  }

  const byGroup = new Map<string, RouteApiFlight[]>();
  for (const f of flights) {
    const key = flightGroupKey(f);
    const group = byGroup.get(key) ?? [];
    group.push(f);
    byGroup.set(key, group);
  }

  return flights.map((f) => {
    const flightNumber = flightNumberOf(f);
    const group = byGroup.get(flightGroupKey(f)) ?? [f];
    const operating = group.find((g) => !g.isCodeshare) ?? group[0];
    const operatingFlightNumber = flightNumberOf(operating);
    const codeshareFlightNumbers = group.filter((g) => g !== f).map(flightNumberOf);

    return {
      flightNumber,
      airline: f.carrier.name,
      scheduledDeparture: f.sortTime ?? null,
      scheduledArrival: f.arrivalTime?.time24 ?? null,
      ...(operatingFlightNumber !== flightNumber ? { operatingFlightNumber } : {}),
      ...(codeshareFlightNumbers.length ? { codeshareFlightNumbers } : {}),
    };
  });
}

export async function searchFlightStatsRoutes(query: RouteQuery): Promise<{ candidates: RouteCandidate[]; error?: string }> {
  const res = await fetch(buildFlightStatsRouteSearchUrl(query));
  if (!res.ok) {
    return { candidates: [], error: `HTTP ${res.status}` };
  }
  const text = await res.text();
  return { candidates: extractRouteCandidates(text) };
}
