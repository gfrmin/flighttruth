import type { FlightQuery, SourceFetcher, SourceResult } from '../types.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long a successful result for this query may be reused, given the current time. */
export type IntervalFor = (query: FlightQuery, nowMs: number) => number;

/**
 * Quota-metered APIs: refetch every `nearMs` from the day before the flight date to the day
 * after (when gates, delays and tails actually change), and every `farMs` otherwise.
 */
export const quotaInterval = ({ nearMs, farMs }: { nearMs: number; farMs: number }): IntervalFor =>
  (query, nowMs) => {
    const day = Date.parse(`${query.date}T00:00:00Z`);
    return nowMs >= day - DAY_MS && nowMs < day + 2 * DAY_MS ? nearMs : farMs;
  };

const keyOf = (q: FlightQuery) => `${q.type}:${q.query.toUpperCase().replace(/[\s-]+/g, '')}:${q.date}`;

/**
 * Wraps a source so repeated lookups of the same query reuse its last successful result for
 * `intervalFor` ms. Errors are not remembered, and concurrent identical calls share one fetch.
 */
export function throttled(source: SourceFetcher, intervalFor: IntervalFor, now: () => number = Date.now): SourceFetcher {
  const done = new Map<string, { at: number; result: SourceResult }>();
  const pending = new Map<string, Promise<SourceResult>>();

  const fetchFresh = (key: string, query: FlightQuery): Promise<SourceResult> => {
    const run = source.fetch(query).then((result) => {
      if (!result.error) done.set(key, { at: now(), result });
      return result;
    }).finally(() => pending.delete(key));
    pending.set(key, run);
    return run;
  };

  return {
    ...source,
    fetch(query) {
      const key = keyOf(query);
      const hit = done.get(key);
      if (hit && now() - hit.at < intervalFor(query, now())) return Promise.resolve(hit.result);
      return pending.get(key) ?? fetchFresh(key, query);
    },
  };
}
