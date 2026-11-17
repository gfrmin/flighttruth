// Generator for data/airlines.json ({ IATA: ICAO }), the shipped airline table. Re-run to refresh.
//
// Source: Wikidata (CC0), airlines with both an IATA designator (P229) and an ICAO code (P230)
// that are not dissolved (P576) or ended (P582). IATA codes get reassigned, so some are listed
// for several airlines; the one with the most Wikipedia articles wins, which keeps the big
// carriers right. Small ones can lag: scripts/build-airlines-fr24.ts writes a local overlay.
import { writeFileSync } from 'node:fs';

const QUERY = `SELECT ?iata ?icao ?links WHERE {
  ?item wdt:P229 ?iata; wdt:P230 ?icao; wikibase:sitelinks ?links.
  FILTER NOT EXISTS { ?item wdt:P576 ?dissolved }
  FILTER NOT EXISTS { ?item wdt:P582 ?ended }
}`;

type Binding = Record<'iata' | 'icao' | 'links', { value: string }>;

const url = `https://query.wikidata.org/sparql?query=${encodeURIComponent(QUERY)}`;
const res = await fetch(url, { headers: { Accept: 'application/sparql-results+json', 'User-Agent': 'flighttruth-build-airlines' } });
if (!res.ok) throw new Error(`Wikidata HTTP ${res.status}`);
const rows: Binding[] = (await res.json()).results.bindings;

const best = new Map<string, { icao: string; links: number }>();
for (const r of rows) {
  const iata = r.iata.value.trim().toUpperCase();
  const icao = r.icao.value.trim().toUpperCase();
  const links = Number(r.links.value);
  if (!/^[A-Z0-9]{2}$/.test(iata) || !/^[A-Z]{3}$/.test(icao)) continue;
  if ((best.get(iata)?.links ?? -1) < links) best.set(iata, { icao, links });
}
const table = Object.fromEntries([...best].map(([iata, { icao }]) => [iata, icao]).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync('data/airlines.json', JSON.stringify(table) + '\n');
console.log(`wrote ${Object.keys(table).length} airlines`);
