import { describe, it, expect } from 'vitest';
import { airportTimezone } from '../src/airports.js';
import { deriveTripView, formatLocal, snapshotFromLookup, type LegSnapshot } from '../src/trip.js';
import type { FlightLookupResult } from '../src/lookupFlight.js';

const emptyLeg = (flightNumber: string): LegSnapshot => ({
  flightNumber, date: '2026-10-10', origin: null, destination: null,
  scheduledDeparture: null, actualDeparture: null, scheduledArrival: null, actualArrival: null,
  status: null, tailNumber: null, aircraftType: null,
});

const legA: LegSnapshot = {
  ...emptyLeg('EY101'), origin: 'TLV', destination: 'AUH',
  scheduledDeparture: '2026-10-10T12:05:00.000Z', scheduledArrival: '2026-10-10T15:20:00.000Z',
  status: 'Scheduled', tailNumber: 'A6-XAA', aircraftType: 'Airbus A321neo',
};
const legB: LegSnapshot = {
  ...emptyLeg('EY102'), origin: 'AUH', destination: 'HKG',
  scheduledDeparture: '2026-10-10T17:10:00.000Z', scheduledArrival: '2026-10-11T01:00:00.000Z',
  status: 'Scheduled', tailNumber: 'A6-XBB', aircraftType: 'Boeing 787-9',
};

describe('airportTimezone', () => {
  it('maps IATA codes to IANA zones', () => {
    expect(airportTimezone('HKG')).toBe('Asia/Hong_Kong');
    expect(airportTimezone('tlv')).toBe('Asia/Jerusalem');
    expect(airportTimezone('ZZZ')).toBeNull();
  });
});

describe('formatLocal', () => {
  it('renders the departure airport local time', () => {
    expect(formatLocal('2026-10-10T12:05:00.000Z', 'TLV')).toEqual({
      utc: '2026-10-10T12:05:00.000Z', local: '15:05 Sat 10 Oct', tz: 'Asia/Jerusalem',
    });
  });

  it('rolls an overnight arrival onto the next local day', () => {
    expect(formatLocal('2026-10-11T01:00:00.000Z', 'HKG').local).toBe('09:00 Sun 11 Oct');
  });

  it('falls back to UTC for unknown airports', () => {
    const t = formatLocal('2026-10-10T12:05:00.000Z', 'ZZZ');
    expect(t.tz).toBe('UTC');
    expect(t.local).toBe('12:05 Sat 10 Oct');
  });
});

describe('deriveTripView', () => {
  it('computes total journey and connection from the schedule', () => {
    const view = deriveTripView([legA, legB]);
    expect(view.totalMinutes).toBe(775);
    expect(view.connections[0]).toEqual({ atAirport: 'AUH', scheduledMinutes: 110, bestMinutes: 110, riskMinutes: 55, atRisk: false });
    expect(view.state).toBe('upcoming');
    expect(view.legs[1].arrival.best?.local).toBe('09:00 Sun 11 Oct');
  });

  it('uses actual times and flags a connection under 60 minutes', () => {
    const landedLate: LegSnapshot = { ...legA, actualDeparture: '2026-10-10T11:30:00.000Z', actualArrival: '2026-10-10T16:30:00.000Z' };
    const view = deriveTripView([landedLate, legB]);
    expect(view.connections[0].bestMinutes).toBe(40);
    expect(view.connections[0].atRisk).toBe(true);
    expect(view.legs[0].phase).toBe('landed');
    expect(view.state).toBe('in-progress');
  });

  it('shows pushback, takeoff, landing and gate arrival, and connects on gate times', () => {
    const flown: LegSnapshot = {
      ...legA,
      gateDeparture: '2026-10-10T11:16:00.000Z', actualDeparture: '2026-10-10T11:30:22.000Z',
      actualArrival: '2026-10-10T14:43:54.000Z', gateArrival: '2026-10-10T14:52:00.000Z',
      arrivalTerminal: 'A', arrivalGate: 'C27', baggage: '10',
    };
    const view = deriveTripView([flown, legB]);
    const { milestones } = view.legs[0];
    expect(milestones.pushback?.local).toBe('14:16 Sat 10 Oct');
    expect(milestones.takeoff?.local).toBe('14:30 Sat 10 Oct');
    expect(milestones.landing?.local).toBe('18:43 Sat 10 Oct');
    expect(milestones.atGate?.local).toBe('18:52 Sat 10 Oct');
    expect(view.legs[0].phase).toBe('landed');
    expect(view.connections[0].bestMinutes).toBe(138);
  });

  it('counts a pushback alone as departed', () => {
    const view = deriveTripView([{ ...legA, gateDeparture: '2026-10-10T12:10:00.000Z' }, legB]);
    expect(view.legs[0].phase).toBe('departed');
    expect(view.legs[0].milestones.takeoff).toBeNull();
  });

  it('uses an estimate as the best time until an actual one arrives', () => {
    const view = deriveTripView([legA, { ...legB, estimatedArrival: '2026-10-11T01:20:00.000Z' }]);
    expect(view.legs[1].arrival.best?.local).toBe('09:20 Sun 11 Oct');
    expect(view.legs[1].arrival.estimated?.local).toBe('09:20 Sun 11 Oct');
  });

  it('treats a departed status without times as departed', () => {
    const view = deriveTripView([{ ...legA, status: 'Departed' }, legB]);
    expect(view.legs[0].phase).toBe('departed');
  });

  it('is complete when every leg has landed', () => {
    const view = deriveTripView([{ ...legA, status: 'Arrived' }, { ...legB, status: 'Landed' }]);
    expect(view.state).toBe('complete');
  });

  it('renders legs with no data yet as unknown, without totals or risk', () => {
    const view = deriveTripView([emptyLeg('EY101'), emptyLeg('EY102')]);
    expect(view.legs[0].phase).toBe('unknown');
    expect(view.totalMinutes).toBeNull();
    expect(view.connections[0]).toEqual({ atAirport: null, scheduledMinutes: null, bestMinutes: null, riskMinutes: 55, atRisk: false });
  });
});

describe('snapshotFromLookup', () => {
  it('takes the top-weighted value per field and null when missing', () => {
    const result = {
      distributions: [
        { field: 'tailNumber', values: [{ value: 'A6-XEE', weight: 1, sources: ['flightradar24'] }], unconfirmed: false, paywalledAt: [] },
        {
          field: 'actualDeparture',
          values: [
            { value: '2026-10-09T12:34:35.000Z', weight: 0.53, sources: ['flightradar24'] },
            { value: '2026-10-09T12:20:00.000Z', weight: 0.47, sources: ['flightstats'] },
          ],
          unconfirmed: false, paywalledAt: [],
        },
        { field: 'actualArrival', values: [], unconfirmed: false, paywalledAt: [] },
      ],
    } as unknown as FlightLookupResult;
    const snap = snapshotFromLookup('EY101', '2026-10-09', result);
    expect(snap.tailNumber).toBe('A6-XEE');
    expect(snap.actualDeparture).toBe('2026-10-09T12:34:35.000Z');
    expect(snap.actualArrival).toBeNull();
    expect(snap.origin).toBeNull();
    expect(snap.flightNumber).toBe('EY101');
  });
});

describe('deriveTripView consistency and connection risk', () => {
  const lx300: LegSnapshot = {
    ...emptyLeg('LX300'), origin: 'HKG', destination: 'ZRH',
    scheduledDeparture: '2026-11-04T15:30:00.000Z', scheduledArrival: '2026-11-05T05:10:00.000Z',
  };
  const lx400: LegSnapshot = {
    ...emptyLeg('LX400'), origin: 'ZRH', destination: 'LGW',
    scheduledDeparture: '2026-11-05T06:00:00.000Z', scheduledArrival: '2026-11-05T07:40:00.000Z',
  };

  it('ignores an at-gate time before landing and a pushback after takeoff', () => {
    const view = deriveTripView([{
      ...lx400, actualDeparture: '2026-11-05T06:16:00.000Z', gateDeparture: '2026-11-05T06:20:00.000Z',
      actualArrival: '2026-11-05T07:34:00.000Z', gateArrival: '2026-11-05T07:33:00.000Z',
    }]);
    expect(view.legs[0].milestones.atGate).toBeNull();
    expect(view.legs[0].milestones.pushback).toBeNull();
    expect(view.legs[0].milestones.landing?.utc).toBe('2026-11-05T07:34:00.000Z');
  });

  it("judges a connection against the airport's minimum connecting time", () => {
    const at = (gateArrival: string) => deriveTripView([{ ...lx300, gateArrival }, lx400]).connections[0];
    expect(at('2026-11-05T05:06:00.000Z')).toMatchObject({ bestMinutes: 54, atRisk: false });
    expect(at('2026-11-05T05:30:00.000Z')).toMatchObject({ bestMinutes: 30, atRisk: true });
  });
});

describe('gate times that only repeat the schedule', () => {
  it('does not take a pushback exactly at the scheduled time as real until the plane takes off', () => {
    const copied = { ...legA, gateDeparture: legA.scheduledDeparture };
    const leg = deriveTripView([copied]).legs[0];
    expect(leg.milestones.pushback).toBeNull();
    expect(leg.phase).toBe('scheduled');
    const flown = deriveTripView([{ ...copied, actualDeparture: '2026-10-10T12:20:00.000Z' }]).legs[0];
    expect(flown.milestones.pushback?.utc).toBe('2026-10-10T12:05:00.000Z');
  });

  it('keeps a pushback a minute off the schedule', () => {
    const leg = deriveTripView([{ ...legA, gateDeparture: '2026-10-10T12:06:00.000Z' }]).legs[0];
    expect(leg.milestones.pushback?.utc).toBe('2026-10-10T12:06:00.000Z');
  });

  it('does not take arrival at the gate exactly at the scheduled time as real until it lands', () => {
    const leg = deriveTripView([{ ...legA, actualDeparture: '2026-10-10T12:20:00.000Z', gateArrival: legA.scheduledArrival }]).legs[0];
    expect(leg.milestones.atGate).toBeNull();
    expect(leg.phase).toBe('departed');
  });
});

describe('airport ICAO codes', () => {
  it('knows them from the airport table and puts them on each leg', async () => {
    const { airportIcao } = await import('../src/airports.js');
    expect(airportIcao('LGW')).toBe('EGKK');
    expect(airportIcao('zrh')).toBe('LSZH');
    expect(airportIcao('ZZZ')).toBeNull();
    const leg = deriveTripView([legA]).legs[0];
    expect([leg.originIcao, leg.destinationIcao]).toEqual(['LLBG', 'OMAA']);
  });
});

describe('connection risk line', () => {
  it('tells the page where at risk starts, so it can call the next half hour tight', () => {
    const c = deriveTripView([legA, legB]).connections[0];
    expect(c.riskMinutes).toBeGreaterThan(0);
    expect(c.atRisk).toBe(c.bestMinutes! < c.riskMinutes);
  });
});
