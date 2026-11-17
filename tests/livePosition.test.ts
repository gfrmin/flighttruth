import { describe, it, expect } from 'vitest';
import { createPositionLookup, createCallsignLookup } from '../src/livePosition.js';

const routes = (table: Record<string, () => Response>) => {
  const calls: string[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push(url);
    signals.push(init?.signal ?? undefined);
    const hit = Object.entries(table).find(([prefix]) => url.startsWith(prefix));
    return hit ? hit[1]() : new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
  return { impl, calls, signals };
};

// One OpenSky state vector for A6-XAA on final approach into AUH (shape per /api/states/all).
const STATE = ['89669a', 'ETD75C  ', 'United Arab Emirates', 1792248000, 1792248010, 54.7183, 24.3855, 388.62, false, 74.6, 310.2, -3.1, null, 400, '1234', false, 0];

describe('createPositionLookup', () => {
  it('resolves the registration to a transponder hex and returns its live position', async () => {
    const { impl, calls } = routes({
      'https://hexdb.io/reg-hex?reg=A6-XAA': () => new Response('89669A'),
      'https://api.adsb.lol/': () => Response.json({ now: 1, ac: [] }),
      'https://opendata.adsb.fi/': () => Response.json({ now: 1, ac: [] }),
      'https://opensky-network.org/api/states/all?icao24=89669a': () => Response.json({ time: 1792248020, states: [STATE] }),
    });
    const position = await createPositionLookup(impl)('A6-XAA');
    expect(position).toEqual({
      hex: '89669a', callsign: 'ETD75C', lat: 24.3855, lon: 54.7183, altitudeFt: 1275, groundSpeedKt: 145,
      trackDeg: 310, onGround: false, seenAt: '2026-10-17T14:40:10.000Z', source: 'OpenSky',
    });
    expect(calls).toHaveLength(4);
  });

  it('remembers the hex so later lookups skip hexdb.io', async () => {
    const { impl, calls } = routes({
      'https://hexdb.io/': () => new Response('89669A'),
      'https://api.adsb.lol/': () => Response.json({ now: 1, ac: [] }),
      'https://opendata.adsb.fi/': () => Response.json({ now: 1, ac: [] }),
      'https://opensky-network.org/': () => Response.json({ time: 1, states: [STATE] }),
    });
    const lookup = createPositionLookup(impl);
    await lookup('A6-XAA');
    await lookup('A6-XAA');
    expect(calls.filter((u) => u.includes('hexdb'))).toHaveLength(1);
  });

  it('prefers adsb.lol, reading its readsb-format aircraft record', async () => {
    const { impl, calls } = routes({
      'https://hexdb.io/': () => new Response('896a1b'),
      'https://api.adsb.lol/v2/hex/896a1b': () => Response.json({
        now: 1792260000000,
        ac: [{ hex: '896a1b', flight: 'ETD102  ', lat: 25.1, lon: 60.2, alt_baro: 39000, gs: 492.3, track: 78.4, seen_pos: 4.2 }],
      }),
    });
    expect(await createPositionLookup(impl)('A6-XBB')).toEqual({
      hex: '896a1b', callsign: 'ETD102', lat: 25.1, lon: 60.2, altitudeFt: 39000, groundSpeedKt: 492,
      trackDeg: 78, onGround: false, seenAt: '2026-10-17T17:59:55.800Z', source: 'adsb.lol',
    });
    expect(calls.some((u) => u.includes('opensky'))).toBe(false);
  });

  it('reads alt_baro "ground" as on the ground', async () => {
    const { impl } = routes({
      'https://hexdb.io/': () => new Response('896a1b'),
      'https://api.adsb.lol/': () => Response.json({ now: 1792260000000, ac: [{ hex: '896a1b', lat: 24.4, lon: 54.6, alt_baro: 'ground', gs: 12, seen_pos: 1 }] }),
    });
    const p = await createPositionLookup(impl)('A6-XBB');
    expect(p?.onGround).toBe(true);
    expect(p?.altitudeFt).toBe(0);
  });

  it('falls back to the next provider when one errors or does not see the plane', async () => {
    const { impl, calls } = routes({
      'https://hexdb.io/': () => new Response('89669A'),
      'https://api.adsb.lol/': () => new Response('busy', { status: 503 }),
      'https://opendata.adsb.fi/': () => Response.json({ now: 1, ac: [] }),
      'https://opensky-network.org/': () => Response.json({ time: 1792248020, states: [STATE] }),
    });
    expect((await createPositionLookup(impl)('A6-XAA'))?.callsign).toBe('ETD75C');
    expect(calls.map((u) => new URL(u).host)).toEqual(['hexdb.io', 'api.adsb.lol', 'opendata.adsb.fi', 'opensky-network.org']);
  });

  it('throws when every provider errors', async () => {
    const { impl } = routes({ 'https://hexdb.io/': () => new Response('89669A') });
    await expect(createPositionLookup(impl)('A6-XAA')).rejects.toThrow(/adsb\.lol.*404/);
  });

  it('returns null when the plane is not transmitting', async () => {
    const { impl } = routes({
      'https://hexdb.io/': () => new Response('896a1b'),
      'https://api.adsb.lol/': () => Response.json({ now: 1, ac: [] }),
      'https://opendata.adsb.fi/': () => Response.json({ now: 1, ac: [] }),
      'https://opensky-network.org/': () => Response.json({ time: 1, states: null }),
    });
    expect(await createPositionLookup(impl)('A6-XBB')).toBeNull();
  });

  it('puts a timeout on every request, so a hung feed cannot stall polling', async () => {
    const { impl, signals } = routes({
      'https://hexdb.io/': () => new Response('896a1b'),
      'https://api.adsb.lol/': () => Response.json({ now: 1, ac: [] }),
      'https://opendata.adsb.fi/': () => Response.json({ now: 1, ac: [] }),
      'https://opensky-network.org/': () => Response.json({ time: 1, states: null }),
    });
    await createPositionLookup(impl)('A6-XBB');
    expect(signals).toHaveLength(4);
    expect(signals.every((s) => s instanceof AbortSignal)).toBe(true);
  });

  it('rejects an unknown registration', async () => {
    const { impl } = routes({ 'https://hexdb.io/': () => new Response('n/a') });
    await expect(createPositionLookup(impl)('ZZ-NOPE')).rejects.toThrow(/no transponder code for ZZ-NOPE/);
  });
});

describe('createCallsignLookup', () => {
  it('finds a plane by the callsign it broadcasts, which need not be the flight number', async () => {
    const { impl, calls } = routes({
      'https://api.adsb.lol/v2/callsign/EZY12AB': () => Response.json({
        now: 1792260000000,
        ac: [{ hex: '400a1b', flight: 'EZY12AB ', lat: 48.29, lon: -3.23, alt_baro: 37975, gs: 510, track: 37, seen_pos: 0 }],
      }),
    });
    expect(await createCallsignLookup(impl)('EZY12AB')).toEqual({
      hex: '400a1b', callsign: 'EZY12AB', lat: 48.29, lon: -3.23, altitudeFt: 37975, groundSpeedKt: 510,
      trackDeg: 37, onGround: false, seenAt: '2026-10-17T18:00:00.000Z', source: 'adsb.lol',
    });
    expect(calls).toEqual(['https://api.adsb.lol/v2/callsign/EZY12AB']);
  });

  it('falls through to adsb.fi and answers null when no feed hears it', async () => {
    const { impl, calls } = routes({
      'https://api.adsb.lol/': () => Response.json({ now: 1, ac: [] }),
      'https://opendata.adsb.fi/': () => Response.json({ now: 1, ac: [] }),
    });
    expect(await createCallsignLookup(impl)('EZY12AB')).toBeNull();
    expect(calls).toEqual(['https://api.adsb.lol/v2/callsign/EZY12AB', 'https://opendata.adsb.fi/api/v2/callsign/EZY12AB']);
  });
});
