import type { FlightQuery, SourceFetcher, SourceResult } from '../types.js';
import { flightNumberToIcaoCallsign } from '../airlineCodes.js';

// ADS-B Exchange's own live feed (globe.adsbexchange.com/data/aircraft.json) returned
// 403 Forbidden even through Bright Data's Web Unlocker -- it appears to require a
// signed session from their own map page. adsb.lol is a free, no-key, community-run
// feed with the same open-ADS-B-data spirit and the same "ac" array / "r"+"t" field
// shape (confirmed live against LY91 -> registration 4X-EDL, type B789). This source
// keeps the `adsbExchange` SourceId from the spec since it serves the same purpose,
// but the actual data comes from adsb.lol.
interface AdsbLolAircraft {
  hex?: string;
  flight?: string;
  r?: string;
  t?: string;
  desc?: string;
}

interface AdsbLolResponse {
  ac?: AdsbLolAircraft[];
}

export const adsbExchangeSource: SourceFetcher = {
  id: 'adsbExchange',
  retryOnIdentityResolution: true,
  async fetch(query: FlightQuery): Promise<SourceResult> {
    const fetchedAt = new Date().toISOString();
    try {
      if (query.type !== 'number') {
        return { source: 'adsbExchange', fetchedAt, fields: {}, error: 'tail-number lookup not implemented for this feed' };
      }

      const callsign = flightNumberToIcaoCallsign(query.query);
      if (!callsign) {
        return { source: 'adsbExchange', fetchedAt, fields: {}, error: `could not resolve ICAO callsign for "${query.query}"` };
      }

      const res = await fetch(`https://api.adsb.lol/v2/callsign/${callsign}`, {
        headers: { 'User-Agent': 'flighttruth (https://github.com/gfrmin/flighttruth)' },
      });
      if (!res.ok) {
        return { source: 'adsbExchange', fetchedAt, fields: {}, error: `HTTP ${res.status}` };
      }
      const data = (await res.json()) as AdsbLolResponse;
      const match = (data.ac ?? [])[0];

      if (!match) {
        return { source: 'adsbExchange', fetchedAt, fields: {}, error: 'flight not currently airborne / not found in live feed' };
      }

      const fields: SourceResult['fields'] = {};
      if (match.r) {
        fields.tailNumber = { value: match.r, paywalled: false, raw: match.r };
      }
      const aircraftTypeRaw = match.desc || match.t;
      if (aircraftTypeRaw) {
        fields.aircraftType = { value: aircraftTypeRaw, paywalled: false, raw: aircraftTypeRaw };
      }

      return { source: 'adsbExchange', fetchedAt, fields };
    } catch (err) {
      return { source: 'adsbExchange', fetchedAt, fields: {}, error: (err as Error).message };
    }
  },
};
