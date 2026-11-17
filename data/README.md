# Reference data

| File | What | Source | Licence |
|---|---|---|---|
| `airports.json` | IATA code → [IANA time zone, latitude, longitude, ICAO code] | [mwgg/Airports](https://github.com/mwgg/Airports), built by `scripts/build-airports.ts` | MIT |
| `airlines.json` | Airline IATA code → ICAO code | [Wikidata](https://www.wikidata.org/) (P229/P230), built by `scripts/build-airlines.ts` | CC0 |
| `airlines.local.json` | Optional overlay, not shipped (gitignored) | Your own refresh, e.g. `scripts/build-airlines-fr24.ts` | Yours |

IATA airline codes get reassigned, and Wikidata can lag for small carriers. Corrections that
should hold for everyone belong in `OVERRIDES` in `src/airlineCodes.ts`.
