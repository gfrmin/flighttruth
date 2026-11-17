import type { SourceFetcher } from '../types.js';
import { openSkySource } from './openSky.js';
import { adsbExchangeSource } from './adsbExchange.js';
import { flightawareSource } from './flightaware.js';
import { flightradar24Source } from './flightradar24.js';
import { flightstatsSource } from './flightstats.js';
import { makeAeroApiSource } from './aeroapi.js';
import { makeAeroDataBoxSource } from './aerodatabox.js';
import { makeGoogleSerpSource } from './googleSerp.js';
import { makeBenGurionSource } from './benGurion.js';
import { makeAenaSource } from './aena.js';
import { browserLookup, makeEtihadSource } from './etihad.js';
import { quotaInterval, throttled } from './throttle.js';

type Env = Record<string, string | undefined>;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Optional sources: each is enabled by one env var, with what you lose without it. */
// `opt-in` sources are extras you sign up for deliberately, so their absence isn't warned about.
const OPTIONAL: { envVar: string; without: string; optIn?: true; build: (key: string, env: Env) => SourceFetcher[] }[] = [
  {
    envVar: 'AEROAPI_KEY',
    without: 'no FlightAware AeroAPI (schedule, estimates, gates, tail)',
    optIn: true,
    // Billed per call against a small free monthly credit.
    build: (key) => [throttled(makeAeroApiSource(key), quotaInterval({ nearMs: 10 * MINUTE, farMs: 3 * HOUR }))],
  },
  {
    envVar: 'AERODATABOX_KEY',
    without: 'no AeroDataBox (schedule, estimates, gates, belts, tail)',
    optIn: true,
    // The free RapidAPI plan allows only a few hundred calls a month.
    build: (key) => [throttled(makeAeroDataBoxSource(key), quotaInterval({ nearMs: 20 * MINUTE, farMs: 12 * HOUR }))],
  },
  {
    envVar: 'BRIGHTDATA_API_KEY',
    without: 'no Google flight card (SERP) and no scraped FlightAware/Flightradar24/FlightStats pages',
    // SERP requests are billed per call; the card changes slowly except around departure.
    build: (key, env) => [
      throttled(makeGoogleSerpSource(key, env.BRIGHTDATA_SERP_ZONE || 'serp_api1'), quotaInterval({ nearMs: 5 * MINUTE, farMs: 2 * HOUR })),
      flightawareSource, flightradar24Source, flightstatsSource,
    ],
  },
  {
    envVar: 'BRIGHTDATA_BROWSER_WSS',
    without: "no Etihad's own flight status (needs a real browser: Bright Data Browser API)",
    // Each lookup is a remote browser session, billed by traffic and slower than plain HTTP.
    build: (wss) => [throttled(makeEtihadSource(browserLookup(wss)), quotaInterval({ nearMs: 10 * MINUTE, farMs: 3 * HOUR }))],
  },
];

/** Free sources need no key and are always on: live ADS-B, and the Ben Gurion and Aena airport boards. */
export function buildSources(env: Env): SourceFetcher[] {
  return [
    openSkySource,
    adsbExchangeSource,
    throttled(makeBenGurionSource(), quotaInterval({ nearMs: 5 * MINUTE, farMs: HOUR })),
    throttled(makeAenaSource(), quotaInterval({ nearMs: 5 * MINUTE, farMs: HOUR })),
    ...OPTIONAL.flatMap(({ envVar, build }) => (env[envVar] ? build(env[envVar]!, env) : [])),
  ];
}

export function missingSourceWarnings(env: Env): string[] {
  return OPTIONAL.filter(({ envVar, optIn }) => !optIn && !env[envVar]).map(({ envVar, without }) => `${envVar} is not set: ${without}`);
}
