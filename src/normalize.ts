import type { FieldName } from './types.js';

const AIRCRAFT_TYPE_ALIASES: Record<string, string> = {
  'b738': 'Boeing 737-800',
  'boeing 737-800': 'Boeing 737-800',
  '737-800': 'Boeing 737-800',
  'b38m': 'Boeing 737 MAX 8',
  '737 max 8': 'Boeing 737 MAX 8',
  '737max8': 'Boeing 737 MAX 8',
  'a320': 'Airbus A320',
  'airbus a320': 'Airbus A320',
  'a321': 'Airbus A321',
  'airbus a321': 'Airbus A321',
  'a333': 'Airbus A330-300',
  'airbus a330-300': 'Airbus A330-300',
  'a359': 'Airbus A350-900',
  'airbus a350-900': 'Airbus A350-900',
  'b789': 'Boeing 787-9',
  'boeing 787-9': 'Boeing 787-9',
  'b77w': 'Boeing 777-300ER',
  'boeing 777-300er': 'Boeing 777-300ER',
  'a21n': 'Airbus A321neo',
  'airbus a321-251nx': 'Airbus A321neo',
};

function normalizeAircraftType(raw: string): string {
  const key = raw.trim().toLowerCase();
  return AIRCRAFT_TYPE_ALIASES[key] ?? raw.trim();
}

function normalizeTailNumber(raw: string): string {
  return raw.trim().toUpperCase();
}

const INSTANT_FIELDS: ReadonlySet<FieldName> = new Set([
  'scheduledDeparture', 'gateDeparture', 'actualDeparture', 'estimatedDeparture',
  'scheduledArrival', 'actualArrival', 'gateArrival', 'estimatedArrival',
]);

const CODE_FIELDS: ReadonlySet<FieldName> = new Set([
  'origin', 'destination', 'departureTerminal', 'departureGate', 'arrivalTerminal', 'arrivalGate', 'baggage', 'callsign',
]);

// Sources format the same instant differently ("...T16:35:00Z", "... 16:35Z", ms precision) and
// disagree by seconds on actuals; truncating to the minute lets agreeing sources group together.
function normalizeInstant(raw: string): string {
  const trimmed = raw.trim();
  const time = Date.parse(trimmed.replace(/^(\d{4}-\d{2}-\d{2}) /, '$1T'));
  if (Number.isNaN(time)) return trimmed;
  return new Date(time - (time % 60_000)).toISOString();
}

export function normalizeValue(field: FieldName, raw: string): string {
  if (field === 'aircraftType') return normalizeAircraftType(raw);
  if (field === 'tailNumber') return normalizeTailNumber(raw);
  if (INSTANT_FIELDS.has(field)) return normalizeInstant(raw);
  if (CODE_FIELDS.has(field)) return raw.trim().toUpperCase();
  return raw.trim();
}
