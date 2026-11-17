// One-off generator for data/airports.json ({ IATA: [IANA tz, lat, lon, ICAO] }). Re-run only to
// refresh the table.
import { writeFileSync } from 'node:fs';

const SOURCE = 'https://raw.githubusercontent.com/mwgg/Airports/master/airports.json';

interface SourceAirport {
  iata?: string;
  icao?: string;
  tz?: string;
  lat?: number;
  lon?: number;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

const airports: Record<string, SourceAirport> = await (await fetch(SOURCE)).json();
const table = Object.fromEntries(
  Object.values(airports)
    .filter((a) => a.iata && a.tz && typeof a.lat === 'number' && typeof a.lon === 'number')
    .map((a) => [a.iata!.toUpperCase(), [a.tz!, round(a.lat!), round(a.lon!), a.icao?.toUpperCase() || null]])
    .sort(([a], [b]) => String(a).localeCompare(String(b)))
);
writeFileSync('data/airports.json', JSON.stringify(table) + '\n');
console.log(`wrote ${Object.keys(table).length} airports`);
