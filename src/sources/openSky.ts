import type { FlightQuery, SourceFetcher, SourceResult } from '../types.js';
import { flightNumberToIcaoCallsign } from '../airlineCodes.js';

interface OpenSkyStatesResponse {
  time: number;
  states: unknown[][] | null;
}

export const openSkySource: SourceFetcher = {
  id: 'openSky',
  retryOnIdentityResolution: true,
  async fetch(query: FlightQuery): Promise<SourceResult> {
    const fetchedAt = new Date().toISOString();
    try {
      if (query.type !== 'number') {
        return { source: 'openSky', fetchedAt, fields: {}, error: 'tail-number lookup not supported by states/all' };
      }

      const callsign = flightNumberToIcaoCallsign(query.query);
      if (!callsign) {
        return { source: 'openSky', fetchedAt, fields: {}, error: `could not resolve ICAO callsign for "${query.query}"` };
      }

      const res = await fetch('https://opensky-network.org/api/states/all');
      if (!res.ok) {
        return { source: 'openSky', fetchedAt, fields: {}, error: `HTTP ${res.status}` };
      }
      const data = (await res.json()) as OpenSkyStatesResponse;

      const match = (data.states ?? []).find((state) => {
        const stateCallsign = String(state[1] ?? '').trim().toUpperCase();
        return stateCallsign === callsign;
      });

      if (!match) {
        return { source: 'openSky', fetchedAt, fields: {}, error: 'flight not currently airborne / not found in live state vector' };
      }

      // state[8] is on_ground: a plane taxiing or parked with its transponder on is not airborne.
      if (match[8] === true) {
        return { source: 'openSky', fetchedAt, fields: {}, error: 'on the ground (taxiing or parked)' };
      }

      return {
        source: 'openSky',
        fetchedAt,
        fields: {
          status: { value: 'Airborne (live ADS-B)', paywalled: false, raw: String(match[0]) },
        },
      };
    } catch (err) {
      return { source: 'openSky', fetchedAt, fields: {}, error: (err as Error).message };
    }
  },
};
