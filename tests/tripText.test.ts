import { describe, it, expect } from 'vitest';
// @ts-expect-error -- plain browser ES module, no type declarations
import { headline, connectionTone, rotationToday, progress, hhmm, ago, sentLabel, radioIdent, duration, itsDay, alertTime, airportsLine, unreachable } from '../public/tripText.js';

// Shapes of GET /api/trips/:id (only the fields the module reads).
const t = (utc: string, local: string) => ({ utc, local, tz: 'x' });
const noMilestones = { pushback: null, takeoff: null, landing: null, atGate: null };

const u2Scheduled = {
  flightNumber: 'U21234', origin: 'LPA', destination: 'LGW', phase: 'scheduled', baggage: null,
  departure: { best: t('2026-11-10T12:45:00Z', '12:45 Tue 10 Nov') },
  arrival: { scheduled: t('2026-11-10T17:05:00Z', '17:05 Tue 10 Nov'), best: t('2026-11-10T16:54:00Z', '16:54 Tue 10 Nov') },
  milestones: noMilestones,
};
const u2Airborne = {
  ...u2Scheduled, phase: 'departed',
  departure: { best: t('2026-11-10T12:46:00Z', '12:46 Tue 10 Nov') },
  arrival: { ...u2Scheduled.arrival, best: t('2026-11-10T16:46:00Z', '16:46 Tue 10 Nov') },
  milestones: { ...noMilestones, pushback: t('2026-11-10T12:46:00Z', '12:46 Tue 10 Nov'), takeoff: t('2026-11-10T12:57:00Z', '12:57 Tue 10 Nov') },
};
const view = (legs: unknown[], connections: unknown[] = []) => ({ legs, connections, totalMinutes: null, state: 'in-progress' });
const now = new Date('2026-11-10T14:36:00Z');

describe('headline', () => {
  it('waits for the first check', () => {
    expect(headline(null, now)).toEqual({ line: 'Waiting for the first check', detail: null });
  });

  it('says there is no data for a leg nobody reports', () => {
    expect(headline(view([{ ...u2Scheduled, phase: 'unknown' }]), now).line).toBe('No data yet for U21234');
  });

  it('gives a scheduled flight its departure and arrival', () => {
    expect(headline(view([u2Scheduled]), now)).toEqual({ line: 'Leaves LPA 12:45 · lands LGW 16:54', detail: '11 min early' });
  });

  it('says in the air only after takeoff', () => {
    expect(headline(view([u2Airborne]), now)).toEqual({ line: 'In the air · lands LGW 16:46', detail: 'in 2h 10m, 19 min early' });
  });

  it('says left the gate when there is a pushback but no takeoff', () => {
    const taxiing = { ...u2Airborne, milestones: { ...u2Airborne.milestones, takeoff: null } };
    expect(headline(view([taxiing]), now).line).toBe('Left the gate at LPA 12:46 · lands LGW 16:46');
  });

  it('says landed, then at the gate with the baggage belt', () => {
    const landed = { ...u2Airborne, phase: 'landed', milestones: { ...u2Airborne.milestones, landing: t('2026-11-10T16:40:00Z', '16:40 Tue 10 Nov') } };
    expect(headline(view([landed]), now).line).toBe('Landed LGW 16:40');
    const statusOnly = { ...u2Airborne, phase: 'landed' };
    expect(headline(view([statusOnly]), now).line).toBe('Landed LGW');
    const atGate = { ...landed, baggage: '7', milestones: { ...landed.milestones, atGate: t('2026-11-10T16:49:00Z', '16:49 Tue 10 Nov') } };
    expect(headline(view([atGate]), now)).toEqual({ line: 'At the gate, LGW 16:49', detail: 'belt 7' });
  });

  it('talks about the next leg and its connection once the first has landed', () => {
    const legA = { ...u2Scheduled, flightNumber: 'LX100', origin: 'LGW', destination: 'ZRH', phase: 'landed', milestones: { ...noMilestones, landing: t('2026-11-11T20:20:00Z', '21:20 Wed 11 Nov') } };
    const legB = {
      ...u2Scheduled, flightNumber: 'LX200', origin: 'ZRH', destination: 'HKG',
      departure: { best: t('2026-11-11T21:30:00Z', '22:30 Wed 11 Nov') },
      arrival: { scheduled: t('2026-11-12T09:35:00Z', '17:35 Thu 12 Nov'), best: t('2026-11-12T09:35:00Z', '17:35 Thu 12 Nov') },
    };
    const conn = { atAirport: 'ZRH', scheduledMinutes: 65, bestMinutes: 65, atRisk: false };
    expect(headline(view([legA, legB], [conn]), now)).toEqual({ line: 'Leaves ZRH 22:30 · lands HKG 17:35', detail: 'on time · connection at ZRH: 1h 05m, OK' });
  });

  it('mentions the connection ahead while the first leg is still flying', () => {
    const late = { ...u2Airborne, flightNumber: 'LX100', destination: 'ZRH', arrival: { scheduled: t('2026-11-10T16:16:00Z', '17:16 Tue 10 Nov'), best: t('2026-11-10T16:46:00Z', '17:46 Tue 10 Nov') } };
    const next = { ...u2Scheduled, flightNumber: 'LX200', origin: 'ZRH' };
    const conn = { atAirport: 'ZRH', scheduledMinutes: 65, bestMinutes: 35, atRisk: true };
    expect(headline(view([late, next], [conn]), now).detail).toBe('in 2h 10m, 30 min late · connection at ZRH: 35 min, at risk');
  });
});

describe('connectionTone', () => {
  it('grades a connection', () => {
    expect(connectionTone({ bestMinutes: 30, atRisk: true })).toBe('at-risk');
    expect(connectionTone({ bestMinutes: 55, atRisk: false })).toBe('tight');
    expect(connectionTone({ bestMinutes: 65, atRisk: false })).toBe('ok');
    expect(connectionTone({ bestMinutes: null, atRisk: false })).toBe('unknown');
    expect(connectionTone({ bestMinutes: 95, atRisk: false })).toBe('ok');
  });
});

describe('rotationToday', () => {
  // G-EZXX before U21234 on 2026-11-10, most recent first.
  const previous = [
    { flight: 'U21233', std: '2026-11-10T07:20:00.000Z', arrival: '2026-11-10T11:45:26.000Z' },
    { flight: 'U28184', std: '2026-11-08T19:20:00.000Z', arrival: '2026-11-08T23:37:37.000Z' },
    { flight: 'U28183', std: '2026-11-08T14:50:00.000Z', arrival: '2026-11-08T18:27:06.000Z' },
  ];
  it('keeps only the plane flights since its last overnight stop', () => {
    expect(rotationToday(previous, '2026-11-10T12:45:00.000Z').map((f: { flight: string }) => f.flight)).toEqual(['U21233']);
  });

  it('keeps same-day turns together', () => {
    expect(rotationToday(previous.slice(1), '2026-11-09T01:00:00.000Z').map((f: { flight: string }) => f.flight)).toEqual(['U28184', 'U28183']);
  });

  it('is empty when the plane stayed overnight right before our flight', () => {
    // HB-JXA: LX500 landed ZRH 11 Nov 20:26, LX400 left 12 Nov 07:00.
    const jxa = [{ flight: 'LX500', std: '2026-11-04T18:50:00.000Z', arrival: '2026-11-04T20:26:00.000Z' }];
    expect(rotationToday(jxa, '2026-11-05T06:00:00.000Z')).toEqual([]);
  });
});

describe('progress', () => {
  it('runs from takeoff to the best arrival', () => {
    expect(progress(u2Airborne, new Date('2026-11-10T14:51:30Z'))).toBeCloseTo(0.5, 2);
    expect(progress(u2Scheduled, now)).toBeNull();
  });
});

describe('hhmm', () => {
  it('takes the clock time from a local time', () => {
    expect(hhmm(t('2026-11-10T16:46:00Z', '16:46 Tue 10 Nov'))).toBe('16:46');
    expect(hhmm(null)).toBeNull();
  });
});

describe('ago', () => {
  const at = new Date('2026-11-10T15:00:00Z');
  it('says how long ago in the largest sensible unit', () => {
    expect(ago('2026-11-10T14:59:40Z', at)).toBe('just now');
    expect(ago('2026-11-10T14:52:00Z', at)).toBe('8 min ago');
    expect(ago('2026-11-10T12:00:00Z', at)).toBe('3 h ago');
    expect(ago('2026-11-05T11:47:00Z', at)).toBe('5 days ago');
    expect(ago('2026-11-09T09:00:00Z', at)).toBe('1 day ago');
  });
});

describe('sentLabel', () => {
  const at = new Date('2026-11-10T15:00:00Z');
  it('gives the clock time for today and adds the day for anything older', () => {
    expect(sentLabel('2026-11-10T12:51:00Z', at, 'UTC')).toBe('12:51');
    expect(sentLabel('2026-11-05T09:39:00Z', at, 'UTC')).toBe('Thu 5 Nov 09:39');
  });
});

describe('radioIdent', () => {
  it('is left out when it is the callsign already shown on the strip', () => {
    expect(radioIdent({ callsign: 'SWR300', extras: { icaoIdent: 'SWR300' } })).toBeNull();
    expect(radioIdent({ callsign: 'EZY12AB', extras: { icaoIdent: 'EZY1234' } })).toBe('EZY1234');
    expect(radioIdent({ callsign: null, extras: null })).toBeNull();
  });
});

describe('duration', () => {
  it('says minutes under an hour and hours with padded minutes above', () => {
    expect(duration(45)).toBe('45 min');
    expect(duration(65)).toBe('1h 05m');
    expect(duration(120)).toBe('2h 00m');
    expect(duration(null)).toBe('—');
  });
});

describe('connectionTone against the airport risk line', () => {
  it('is tight within 30 min above the point it becomes at risk, ok beyond', () => {
    expect(connectionTone({ bestMinutes: 70, atRisk: false, riskMinutes: 45 })).toBe('tight');
    expect(connectionTone({ bestMinutes: 75, atRisk: false, riskMinutes: 45 })).toBe('ok');
    expect(connectionTone({ bestMinutes: 40, atRisk: true, riskMinutes: 45 })).toBe('at-risk');
  });
});

describe('itsDay', () => {
  const day = [
    { origin: 'LGW', destination: 'LPA', arrival: '2026-11-10T11:45:00Z', std: '2026-11-10T07:20:00Z' },
  ];
  it('names the plane day and marks the traveller’s own flight', () => {
    expect(itsDay(day, { origin: 'LPA', destination: 'LGW' })).toBe('LGW → LPA, then yours: LPA → LGW');
  });
  it('says the plane flew nothing earlier that day', () => {
    expect(itsDay([], { origin: 'LPA', destination: 'LGW' })).toBe(null);
  });
});

describe('alertTime', () => {
  const now = new Date('2026-11-10T18:00:00Z');
  it('shows the sent time alone when it is close to the event', () => {
    expect(alertTime({ sentAt: '2026-11-10T12:51:47Z', at: '2026-11-10T12:48:00Z' }, now, 'UTC')).toBe('12:51');
  });
  it('shows when it happened, then when it was sent, when they are far apart', () => {
    expect(alertTime({ sentAt: '2026-11-10T13:20:00Z', at: '2026-11-10T12:57:00Z' }, now, 'UTC')).toBe('12:57 · sent 13:20');
  });
  it('copes with alerts that have no event time', () => {
    expect(alertTime({ sentAt: '2026-11-10T13:20:00Z', at: null }, now, 'UTC')).toBe('13:20');
  });
});

describe('airportsLine', () => {
  it('gives both codes for each end', () => {
    expect(airportsLine({ origin: 'LGW', originIcao: 'EGKK', destination: 'ZRH', destinationIcao: 'LSZH' })).toBe('LGW (EGKK) → ZRH (LSZH)');
    expect(airportsLine({ origin: 'LGW', originIcao: null, destination: null, destinationIcao: null })).toBe('LGW → ?');
  });
});

describe('unreachable', () => {
  it('says what failed and that the page still shows the last data', () => {
    expect(unreachable(502)).toBe("Couldn't reach flighttruth (HTTP 502). Showing the last data.");
    expect(unreachable(null)).toBe("Couldn't reach flighttruth. Showing the last data.");
  });
});
