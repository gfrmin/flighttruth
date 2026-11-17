// Optional local refresh: writes data/airlines.local.json ({ IATA: ICAO }), which overlays the
// shipped table and is gitignored -- this is Flightradar24's data, for your own install only.
// Needs BRIGHTDATA_API_KEY: FR24 blocks plain fetches.
//
// Source: Flightradar24's airline directory, an Inertia.js page whose #app data-page JSON lists
// ~2,100 airlines with their current codes. IATA codes get reassigned, so a few are listed for
// two airlines; the one with the bigger fleet wins.
import { writeFileSync } from 'node:fs';
import * as cheerio from 'cheerio';
import { scrapeHtml } from '../src/scrape.js';

interface Fr24Airline {
  iata: string | null;
  icao: string | null;
  aircraft: number | null;
}

const html = await scrapeHtml('https://www.flightradar24.com/data/airlines');
const airlines: Fr24Airline[] = JSON.parse(cheerio.load(html)('#app').attr('data-page') ?? '{}')?.props?.airlines ?? [];
if (airlines.length === 0) throw new Error('no airline list on the page');

const table = Object.fromEntries(
  airlines
    .filter((a) => /^[A-Z0-9]{2}$/.test(a.iata ?? '') && /^[A-Z]{3}$/.test(a.icao ?? ''))
    .sort((a, b) => (a.aircraft ?? 0) - (b.aircraft ?? 0)) // bigger fleets last, so they win
    .map((a) => [a.iata!, a.icao!])
    .sort(([a], [b]) => a.localeCompare(b))
);
writeFileSync('data/airlines.local.json', JSON.stringify(table, null, 0) + '\n');
console.log(`wrote ${Object.keys(table).length} airlines`);
