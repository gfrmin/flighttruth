import { describe, expect, it } from 'vitest';
import { minTurnFor, rotation, trackRecord, type Fr24Row } from '../src/enrich.js';

const row = (o: Partial<Fr24Row>): Fr24Row => ({
  flight: null, tail: null, origin: 'HKG', destination: 'ZRH', std: null, atd: null, sta: null,
  status: null, statusTime: null, estimateIsDeparture: false, ...o,
});

describe('trackRecord', () => {
  it('summarises landed flights before ours and ignores future ones', () => {
    const rows = [
      row({ std: '2026-11-12T15:30:00Z', sta: '2026-11-13T05:10:00Z', status: 'Scheduled' }),
      row({ std: '2026-11-10T15:30:00Z', atd: '2026-11-10T16:15:00Z', sta: '2026-11-11T05:10:00Z', status: 'Landed', statusTime: '2026-11-11T05:05:00Z' }),
      row({ std: '2026-11-09T15:30:00Z', atd: '2026-11-09T16:00:00Z', sta: '2026-11-10T05:10:00Z', status: 'Landed', statusTime: '2026-11-10T05:40:00Z' }),
    ];
    const t = trackRecord(rows, '2026-11-11T15:30:00.000Z');
    expect(t.flights).toBe(2);
    expect(t.worstArrivalDelay).toBe(30);
    expect(t.onTimePct).toBe(50);
    expect(t.recent[0]).toMatchObject({ date: '2026-11-10', departureDelay: 45, arrivalDelay: -5 });
  });
});

describe('rotation', () => {
  const ours = row({ flight: 'LX400', origin: 'ZRH', destination: 'LGW', std: '2026-11-12T06:00:00.000Z', sta: '2026-11-12T07:40:00.000Z', status: 'Scheduled' });
  it('flags an inbound landing too close to our departure', () => {
    const inbound = row({ flight: 'LX1', origin: 'LHR', destination: 'ZRH', std: '2026-11-12T04:00:00.000Z', sta: '2026-11-12T05:20:00.000Z', status: 'Estimated', statusTime: '2026-11-12T05:45:00.000Z' });
    const r = rotation([ours, inbound], 'LX400', '2026-11-12T06:00:00.000Z', 'BCS3')!;
    expect(r.previous[0]).toMatchObject({ flight: 'LX1', arrivalDelay: 25 });
    expect(r.turnMinutes).toBe(15);
    expect(r.tight).toBe(true);
  });
  it('does not treat an estimated departure as an arrival', () => {
    const inbound = row({ flight: 'LX1', std: '2026-11-12T03:00:00.000Z', sta: '2026-11-12T04:00:00.000Z', status: 'Estimated', statusTime: '2026-11-12T03:30:00.000Z', estimateIsDeparture: true });
    expect(rotation([ours, inbound], 'LX400', '2026-11-12T06:00:00.000Z', 'BCS3')!.previous[0].arrival).toBe('2026-11-12T04:00:00.000Z');
  });
});

describe('minTurnFor', () => {
  it('gives widebodies longer turns than narrowbodies', () => {
    expect(['Boeing 777-300ER', 'B77W', 'A333', 'Airbus A350-900'].map(minTurnFor)).toEqual([75, 75, 75, 75]);
    expect(['BCS3', 'Airbus A220-300 Passenger', 'A320', 'Boeing 737-800'].map(minTurnFor)).toEqual([35, 35, 35, 35]);
  });
});
