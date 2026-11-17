import { existsSync, readFileSync } from 'node:fs';

// Maps IATA airline codes to their ICAO code, which is what live ADS-B callsigns and
// FlightAware idents use (flight "LY91" is broadcast as "ELY091"). The bulk comes from
// data/airlines.json, generated from Wikidata by scripts/build-airlines.ts. An optional,
// gitignored data/airlines.local.json (scripts/build-airlines-fr24.ts) overlays it, and the
// overrides cover what both get wrong.
const readTable = (name: string): Record<string, string> => {
  const url = new URL(`../data/${name}`, import.meta.url);
  return existsSync(url) ? JSON.parse(readFileSync(url, 'utf-8')) : {};
};
const GENERATED = readTable('airlines.json');
const LOCAL = readTable('airlines.local.json');

const OVERRIDES: Record<string, string> = {
  DY: 'NAX', // Norwegian Air Shuttle
  DS: 'EZS', // easyJet Switzerland
  EC: 'EJU', // easyJet Europe
  D8: 'NSZ', // Norwegian Air Sweden AOC (as Aena's boards show it)
  FS: 'AYN', // FlyArystan, not the near-dormant Airfast
  PS: 'AUI', // Ukraine International
  UK: 'VTI', // Vistara
};

const IATA_TO_ICAO: Record<string, string> = { ...GENERATED, ...LOCAL, ...OVERRIDES };

export function iataToIcaoAirlineCode(iataCode: string): string | null {
  return IATA_TO_ICAO[iataCode.toUpperCase()] ?? null;
}

export function normalizeFlightNumber(raw: string): string {
  return raw.toUpperCase().replace(/\s+/g, '');
}

/**
 * Splits a flight number like "BA183" into its airline code ("BA") and flight number ("183").
 */
export function splitFlightNumber(flightNumber: string): { code: string; number: string } | null {
  // An airline code is a 3-letter ICAO code or a 2-character IATA one, which can end in a
  // digit (U2, W6), so the code can't be "everything before the first digit".
  const match = /^([A-Z]{3}|[A-Z0-9]{2})(\d+)$/.exec(normalizeFlightNumber(flightNumber));
  if (!match) return null;
  return { code: match[1], number: match[2] };
}

/**
 * Given an IATA-style flight number like "LY91", returns the ICAO callsign
 * pattern actually broadcast over ADS-B (e.g. "ELY091"). Real-world numbering
 * padding conventions vary by airline; this covers the common 3-digit-padded
 * case confirmed against a live flight (LY91 -> ELY091) but is not universal.
 */
export function flightNumberToIcaoCallsign(flightNumber: string): string | null {
  const split = splitFlightNumber(flightNumber);
  if (!split) return null;
  const icaoAirline = iataToIcaoAirlineCode(split.code);
  if (!icaoAirline) return null;
  return `${icaoAirline}${split.number.padStart(3, '0')}`;
}
