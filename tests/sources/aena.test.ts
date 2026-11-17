import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractAenaFields, isAenaAirport, makeAenaSource, type AenaRecord } from '../../src/sources/aena.js';

const departures: AenaRecord[] = JSON.parse(readFileSync('tests/fixtures/aena-mad-departures.json', 'utf8'));
const arrivals: AenaRecord[] = JSON.parse(readFileSync('tests/fixtures/aena-mad-arrivals.json', 'utf8'));
const find = (rs: AenaRecord[], code: string, num: string) => rs.find((r) => r.iataCompania === code && r.numVuelo === num)!;

const boards = (table: Record<string, AenaRecord[] | number>) => {
  const calls: string[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method} ${url}`);
    const key = Object.keys(table).find((k) => url.includes(k));
    const body = key ? table[key] : 404;
    return typeof body === 'number' ? new Response('', { status: body }) : Response.json(body);
  }) as unknown as typeof fetch;
  return { impl, calls };
};

describe('isAenaAirport', () => {
  it('knows Spanish airports, mainland and Canaries, and nothing else', () => {
    expect(isAenaAirport('LPA')).toBe(true);
    expect(isAenaAirport('MAD')).toBe(true);
    expect(isAenaAirport('LGW')).toBe(false);
    expect(isAenaAirport('GIB')).toBe(false);
  });
});

describe('extractAenaFields', () => {
  it('reads a departure: Madrid local times, gate, terminal, and a closed gate', () => {
    const f = extractAenaFields(find(departures, 'IB', '0657'));
    expect(f.origin?.value).toBe('MAD');
    expect(f.destination?.value).toBe('FCO');
    expect(f.scheduledDeparture?.value).toBe('2026-11-17T20:50:00.000Z');
    expect(f.estimatedDeparture?.value).toBe('2026-11-17T21:35:00.000Z');
    expect(f.departureGate?.value).toBe('J50');
    expect(f.departureTerminal?.value).toBe('T4');
    expect(f.status?.value).toBe('Gate closed');
  });

  it('reads a landed arrival: the latest time is the landing, and the belt', () => {
    const f = extractAenaFields(find(arrivals, 'FR', '2437'));
    expect(f.origin?.value).toBe('FCO');
    expect(f.destination?.value).toBe('MAD');
    expect(f.scheduledArrival?.value).toBe('2026-11-17T21:45:00.000Z');
    expect(f.actualArrival?.value).toBe('2026-11-17T21:59:00.000Z');
    expect(f.estimatedArrival).toBeUndefined();
    expect(f.baggage?.value).toBe('N502');
    expect(f.status?.value).toBe('Landed');
  });

  it('says nothing new when the estimate equals the schedule, and skips empty gates and "null" terminals', () => {
    const f = extractAenaFields(departures.find((r) => r.iataCompania === 'VL' && r.fecha === '18/11/2026')!);
    expect(f.estimatedDeparture).toBeUndefined();
    expect(f.departureGate).toBeUndefined();
    expect(f.departureTerminal).toBeUndefined();
    expect(f.status?.value).toBe('Scheduled');
  });
});

describe('makeAenaSource', () => {
  it('needs the route, which the lookup supplies in its second pass', async () => {
    const src = makeAenaSource(boards({}).impl);
    expect(src.needsRoute).toBe(true);
    expect((await src.fetch({ type: 'number', query: 'VL1801', date: '2026-11-18' })).error).toMatch(/route/);
  });

  it('does not ask Aena about a route that touches no Spanish airport', async () => {
    const { impl, calls } = boards({});
    const r = await makeAenaSource(impl).fetch({ type: 'number', query: 'LX100', date: '2026-11-18', route: { origin: 'LGW', destination: 'ZRH' } });
    expect(r.error).toMatch(/no Aena airport/);
    expect(calls).toEqual([]);
  });

  it("finds the flight on the origin's departure board by the local departure date", async () => {
    const { impl, calls } = boards({ 'airport=MAD&flightType=S': departures });
    const r = await makeAenaSource(impl).fetch({ type: 'number', query: 'VL1801', date: '2026-11-19', route: { origin: 'MAD', destination: 'MUC' } });
    expect(r.error).toBeUndefined();
    expect(r.fields.scheduledDeparture?.value).toBe('2026-11-19T11:00:00.000Z');
    expect(calls).toEqual(['POST https://www.aena.es/sites/Satellite?pagename=AENA_ConsultarVuelos&airport=MAD&flightType=S']);
  });

  it("reads the destination's arrival board when the flight lands in Spain", async () => {
    const { impl } = boards({ 'airport=MAD&flightType=L': arrivals });
    const r = await makeAenaSource(impl).fetch({ type: 'number', query: 'FR2437', date: '2026-11-17', route: { origin: 'FCO', destination: 'MAD' } });
    expect(r.fields.actualArrival?.value).toBe('2026-11-17T21:59:00.000Z');
    expect(r.fields.baggage?.value).toBe('N502');
  });

  it('reports a flight missing from the board as an error, not as empty data', async () => {
    const { impl } = boards({ 'airport=MAD&flightType=S': departures });
    const r = await makeAenaSource(impl).fetch({ type: 'number', query: 'VL1801', date: '2026-11-17', route: { origin: 'MAD', destination: 'MUC' } });
    expect(r.error).toMatch(/not on the MAD board/);
  });
});
