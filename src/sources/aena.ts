import { airportTimezone, estimatedBlockMinutes } from '../airports.js';
import { iataToIcaoAirlineCode, splitFlightNumber } from '../airlineCodes.js';
import { localDate, localToUtc } from '../time.js';
import type { FieldName, FieldValue, FlightQuery, SourceFetcher, SourceResult } from '../types.js';

// Aena's own flight boards, for the airports it runs: every Spanish commercial airport, mainland,
// Balearics and Canaries. One unauthenticated POST per airport and direction returns that board
// for roughly two weeks ahead (a few MB). Field names are Aena's:
//   iataCompania/oaciCompania + numVuelo the flight, tipoVuelo "S"alida or "L"legada,
//   iataAena this airport, iataOtro the other end, fecha dd/mm/yyyy + horaProgramada/horaEstimada
//   in this airport's local time, puertaPrimera gate, cintaPrimera belt, estado a status code.
// Boards are per airport, so this source needs the route: lookupFlight runs it second, once the
// other sources have said where the flight goes.

export interface AenaRecord {
  numVuelo: string;
  iataAena: string;
  fecha: string;
  horaProgramada: string;
  horaEstimada?: string | null;
  iataOtro: string;
  estado: string;
  tipoVuelo: 'S' | 'L';
  terminal?: string | null;
  puertaPrimera?: string | null;
  cintaPrimera?: string | null;
  compania?: string | null;
  iataCompania?: string | null;
  oaciCompania?: string | null;
  iatasCompaniaSecundarios?: string | null;
}

const AENA_TIMEZONES = new Set(['Europe/Madrid', 'Atlantic/Canary', 'Africa/Ceuta']);
export const isAenaAirport = (iata: string): boolean => AENA_TIMEZONES.has(airportTimezone(iata) ?? '');

// Only the codes whose meaning is clear from the boards; others (INI, NPR, HOR) say nothing.
const STATUS: Record<string, string> = {
  SCH: 'Scheduled',
  RET: 'Delayed',
  EMB: 'Boarding',
  ULL: 'Last call',
  CER: 'Gate closed',
  FLY: 'Airborne',
  LND: 'Landed',
  CAN: 'Cancelled',
  DES: 'Diverted',
};

const present = (v: string | null | undefined): string | null => (v && v !== 'null' ? v.trim() || null : null);
const isoDate = (fecha: string) => fecha.split('/').reverse().join('-');
const toUtc = (r: AenaRecord, time: string) => localToUtc(isoDate(r.fecha), time.slice(0, 5), airportTimezone(r.iataAena)!);

export function extractAenaFields(r: AenaRecord): SourceResult['fields'] {
  const arriving = r.tipoVuelo === 'L';
  const kind = arriving ? 'Arrival' : 'Departure';
  const scheduled = toUtc(r, r.horaProgramada);
  const latest = present(r.horaEstimada) ? toUtc(r, r.horaEstimada!) : null;
  // After landing the latest time is the landing itself; before, an estimate equal to the
  // schedule says nothing new.
  const latestField: [FieldName, string | null][] = !latest
    ? []
    : r.estado === 'LND'
      ? [['actualArrival', latest]]
      : latest !== scheduled
        ? [[`estimated${kind}` as FieldName, latest]]
        : [];
  const entries: [FieldName, string | null][] = [
    ['origin', arriving ? r.iataOtro : r.iataAena],
    ['destination', arriving ? r.iataAena : r.iataOtro],
    [`scheduled${kind}` as FieldName, scheduled],
    ...latestField,
    ['status', STATUS[r.estado] ?? null],
    [arriving ? 'arrivalTerminal' : 'departureTerminal', present(r.terminal)],
    ...(arriving ? [['baggage', present(r.cintaPrimera)] as [FieldName, string | null]] : [['departureGate', present(r.puertaPrimera)] as [FieldName, string | null]]),
  ];
  return Object.fromEntries(
    entries.flatMap(([k, v]): [FieldName, FieldValue][] => (v ? [[k, { value: v, paywalled: false, raw: v }]] : []))
  );
}

const sameFlight = (r: AenaRecord, code: string, number: string): boolean => {
  if (Number(r.numVuelo) !== Number(number)) return false;
  const codes = [r.iataCompania, r.oaciCompania, r.compania, ...(present(r.iatasCompaniaSecundarios)?.split(',') ?? [])]
    .map(present).filter(Boolean);
  return codes.includes(code) || codes.includes(iataToIcaoAirlineCode(code) ?? '');
};

/** The local departure date at the origin; for arrivals, estimated from a distance-based flight time. */
function departureDateOf(r: AenaRecord): string | null {
  if (r.tipoVuelo === 'S') return isoDate(r.fecha);
  const block = estimatedBlockMinutes(r.iataOtro, r.iataAena);
  const tz = airportTimezone(r.iataOtro);
  if (block === null || !tz) return null;
  return localDate(Date.parse(toUtc(r, r.horaProgramada)) - block * 60_000, tz);
}

const boardUrl = (airport: string, type: 'S' | 'L') =>
  `https://www.aena.es/sites/Satellite?pagename=AENA_ConsultarVuelos&airport=${airport}&flightType=${type}`;

export function makeAenaSource(fetchImpl: typeof fetch = fetch): SourceFetcher {
  const board = async (airport: string, type: 'S' | 'L'): Promise<AenaRecord[]> => {
    const res = await fetchImpl(boardUrl(airport, type), { method: 'POST', body: '', signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`${airport} board HTTP ${res.status}`);
    return (await res.json()) as AenaRecord[];
  };

  return {
    id: 'aena',
    needsRoute: true,
    async fetch(query: FlightQuery): Promise<SourceResult> {
      const fetchedAt = new Date().toISOString();
      const fail = (error: string): SourceResult => ({ source: 'aena', fetchedAt, fields: {}, error });
      const split = query.type === 'number' ? splitFlightNumber(query.query.toUpperCase().replace(/[\s-]+/g, '')) : null;
      if (!split) return fail('only flight-number queries are supported');
      const { origin, destination } = query.route ?? {};
      if (!origin && !destination) return fail('needs the route, which no other source reported');
      const wanted: [string, 'S' | 'L'][] = [
        ...(origin && isAenaAirport(origin) ? [[origin, 'S'] as [string, 'S']] : []),
        ...(destination && isAenaAirport(destination) ? [[destination, 'L'] as [string, 'L']] : []),
      ];
      if (wanted.length === 0) return fail(`no Aena airport on ${origin ?? '?'}-${destination ?? '?'}`);
      try {
        const found = await Promise.all(wanted.map(async ([airport, type]) =>
          (await board(airport, type)).find((r) => sameFlight(r, split.code, split.number) && departureDateOf(r) === query.date)));
        const records = found.filter((r): r is AenaRecord => !!r);
        if (records.length === 0) return fail(`${split.code}${split.number} on ${query.date} is not on the ${wanted.map(([a]) => a).join('/')} board`);
        // Departure board first, so its origin/destination win; the arrival board adds the rest.
        const fields = Object.assign({}, ...records.reverse().map(extractAenaFields));
        return { source: 'aena', fetchedAt, fields };
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  };
}
