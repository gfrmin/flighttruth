export interface LivePosition {
  hex: string;
  /** What the plane broadcasts, e.g. "ETD75C" -- airlines often don't use the flight number. */
  callsign: string | null;
  lat: number;
  lon: number;
  altitudeFt: number | null;
  groundSpeedKt: number | null;
  trackDeg: number | null;
  onGround: boolean;
  /** Last time the feed heard a position from the transponder. */
  seenAt: string;
  /** Which feed reported it, e.g. "adsb.lol". */
  source: string;
}

export type PositionLookup = (registration: string) => Promise<LivePosition | null>;
/** Live position by the callsign the plane broadcasts (e.g. EZY12AB, not EZY1234). */
export type CallsignLookup = (callsign: string) => Promise<LivePosition | null>;

const FEET_PER_METRE = 3.28084;
const KNOTS_PER_MPS = 1.94384;
// Each request gets its own deadline: polls are single-flight, so one hung feed would stall them all.
const REQUEST_TIMEOUT_MS = 15_000;
const get = (fetchImpl: typeof fetch, url: string) => fetchImpl(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });

const round = (n: unknown, factor = 1): number | null => (typeof n === 'number' ? Math.round(n * factor) : null);

type Provider = { name: string; fetchPosition: (hex: string) => Promise<LivePosition | null> };

// readsb-format feeds (adsb.lol, adsb.fi) answer the same record shape by hex or by callsign.
const READSB_FEEDS = [
  { name: 'adsb.lol', base: 'https://api.adsb.lol' },
  { name: 'adsb.fi', base: 'https://opendata.adsb.fi/api' },
];

async function readsbRecord(fetchImpl: typeof fetch, name: string, url: string): Promise<LivePosition | null> {
  const res = await get(fetchImpl, url);
  if (!res.ok) throw new Error(`${name} HTTP ${res.status}`);
  const body = (await res.json()) as { now?: number; ac?: Record<string, unknown>[] };
  const ac = body.ac?.find((a) => typeof a.lat === 'number' && typeof a.lon === 'number');
  if (!ac) return null;
  const onGround = ac.alt_baro === 'ground';
  return {
    hex: String(ac.hex ?? '').toLowerCase(),
    callsign: String(ac.flight ?? '').trim() || null,
    lat: ac.lat as number,
    lon: ac.lon as number,
    altitudeFt: onGround ? 0 : round(ac.alt_baro),
    groundSpeedKt: round(ac.gs),
    trackDeg: round(ac.track),
    onGround,
    seenAt: new Date((body.now ?? Date.now()) - Number(ac.seen_pos ?? 0) * 1000).toISOString(),
    source: name,
  };
}

const readsbProvider = (name: string, base: string, fetchImpl: typeof fetch): Provider => ({
  name,
  fetchPosition: async (hex) => {
    const position = await readsbRecord(fetchImpl, name, `${base}/v2/hex/${hex}`);
    return position && { ...position, hex };
  },
});

const openSkyProvider = (fetchImpl: typeof fetch): Provider => ({
  name: 'OpenSky',
  async fetchPosition(hex) {
    const res = await get(fetchImpl, `https://opensky-network.org/api/states/all?icao24=${hex}`);
    if (!res.ok) throw new Error(`OpenSky HTTP ${res.status}`);
    const state = ((await res.json()) as { states: unknown[][] | null }).states?.[0];
    if (!state || typeof state[5] !== 'number' || typeof state[6] !== 'number') return null;
    return {
      hex,
      callsign: String(state[1] ?? '').trim() || null,
      lat: state[6],
      lon: state[5],
      altitudeFt: round(state[7], FEET_PER_METRE),
      groundSpeedKt: round(state[9], KNOTS_PER_MPS),
      trackDeg: round(state[10]),
      onGround: state[8] === true,
      seenAt: new Date(Number(state[4]) * 1000).toISOString(),
      source: 'OpenSky',
    };
  },
});

// Finds a plane by its registration rather than by callsign: registration -> ICAO 24-bit
// transponder address via hexdb.io (memoized, it never changes), then the first free ADS-B feed
// that sees it. adsb.lol and adsb.fi are tried first; anonymous OpenSky is rate-limited.
export function createPositionLookup(fetchImpl: typeof fetch = fetch): PositionLookup {
  const hexByRegistration = new Map<string, string>();
  const providers = [...READSB_FEEDS.map((f) => readsbProvider(f.name, f.base, fetchImpl)), openSkyProvider(fetchImpl)];

  const hexFor = async (registration: string): Promise<string> => {
    const known = hexByRegistration.get(registration);
    if (known) return known;
    const res = await get(fetchImpl, `https://hexdb.io/reg-hex?reg=${encodeURIComponent(registration)}`);
    const hex = (await res.text()).trim().toLowerCase();
    if (!res.ok || !/^[0-9a-f]{6}$/.test(hex)) throw new Error(`no transponder code for ${registration}`);
    hexByRegistration.set(registration, hex);
    return hex;
  };

  return async (registration) => {
    const hex = await hexFor(registration);
    const errors: string[] = [];
    for (const provider of providers) {
      try {
        const position = await provider.fetchPosition(hex);
        if (position) return position;
      } catch (err) {
        errors.push((err as Error).message);
      }
    }
    // Not seen anywhere is an answer (parked, or out of coverage); every feed failing is not.
    if (errors.length === providers.length) throw new Error(errors.join('; '));
    return null;
  };
}

// Finds a plane by what it broadcasts. Airlines often fly under alphanumeric callsigns unrelated
// to the flight number, so this takes the callsign a schedule source reported, never one derived
// from the flight number. Only meaningful once the flight has left: before that the callsign is
// not on air, or belongs to the same flight number on another day.
export function createCallsignLookup(fetchImpl: typeof fetch = fetch): CallsignLookup {
  return async (callsign) => {
    const cs = encodeURIComponent(callsign.trim().toUpperCase());
    const errors: string[] = [];
    for (const feed of READSB_FEEDS) {
      try {
        const position = await readsbRecord(fetchImpl, feed.name, `${feed.base}/v2/callsign/${cs}`);
        if (position) return position;
      } catch (err) {
        errors.push((err as Error).message);
      }
    }
    if (errors.length === READSB_FEEDS.length) throw new Error(errors.join('; '));
    return null;
  };
}
