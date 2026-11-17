import express from 'express';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { lookupFlight } from './lookupFlight.js';
import { searchRoutes } from './routeSearch.js';
import { buildSources, missingSourceWarnings } from './sources/index.js';
import { openStore, type Store } from './store.js';
import { parseTripInput } from './tripInput.js';
import { createCallsignLookup, createPositionLookup } from './livePosition.js';
import { createEnricher } from './enrich.js';
import { scrapeHtml } from './scrape.js';
import { createTripPoller, type PollerDeps } from './poller.js';
import { sendNtfy } from './alerts.js';
import type { LookupType, SourceFetcher } from './types.js';

export interface AppDeps {
  store?: Store;
  pollNow?: (tripId: number) => Promise<void>;
  /** Shared with the poller so throttled API sources reuse one quota-saving memory. */
  sources?: SourceFetcher[];
}

function tripsRouter({ store, pollNow }: AppDeps): express.Router {
  const router = express.Router();
  router.use((_req, res, next) => {
    if (!store || !pollNow) {
      res.status(503).json({ error: 'trip tracking is not configured' });
      return;
    }
    next();
  });

  const findTrip = (req: express.Request, res: express.Response) => {
    const trip = store!.getTrip(Number(req.params.id));
    if (!trip) res.status(404).json({ error: 'no such trip' });
    return trip;
  };

  router.get('/', (_req, res) => {
    res.json(store!.listTrips());
  });

  router.post('/', (req, res) => {
    const input = req.body?.input;
    if (typeof input !== 'string') {
      res.status(400).json({ error: 'input is required' });
      return;
    }
    const parsed = parseTripInput(input);
    if ('error' in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const label = typeof req.body.label === 'string' && req.body.label.trim()
      ? req.body.label.trim()
      : parsed.legs.map((l) => l.flightNumber).join(' → ');
    const trip = store!.addTrip(label, parsed.legs);
    void pollNow!(trip.id).catch(() => {});
    res.status(201).json(trip);
  });

  router.get('/:id', (req, res) => {
    const trip = findTrip(req, res);
    if (trip) res.json({ ...trip, alerts: store!.listAlerts(trip.id) });
  });

  router.post('/:id/poll', async (req, res) => {
    const trip = findTrip(req, res);
    if (!trip) return;
    await pollNow!(trip.id);
    res.json(store!.getTrip(trip.id));
  });

  router.delete('/:id', (req, res) => {
    const trip = findTrip(req, res);
    if (!trip) return;
    store!.setTripActive(trip.id, false);
    res.json(store!.getTrip(trip.id));
  });

  return router;
}

export function createApp(deps: AppDeps = {}) {
  const app = express();
  app.use(express.static('public'));
  app.use(express.json());
  app.use('/api/trips', tripsRouter(deps));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/api/flight', async (req, res) => {
    const type = req.query.type;
    const queryValue = req.query.query;
    const date = req.query.date;
    const refresh = req.query.refresh === 'true';

    if ((type !== 'number' && type !== 'tail') || typeof queryValue !== 'string' || typeof date !== 'string') {
      res.status(400).json({ error: 'type must be "number" or "tail"; query and date are required' });
      return;
    }

    const result = await lookupFlight(
      { type: type as LookupType, query: queryValue, date },
      deps.sources ?? buildSources(process.env),
      { forceRefresh: refresh }
    );

    const allFailed = result.sourceResults.every((r) => r.error);
    if (allFailed) {
      res.status(502).json({ error: 'all sources failed', result });
      return;
    }

    res.json(result);
  });

  app.get('/api/routes', async (req, res) => {
    const origin = req.query.origin;
    const destination = req.query.destination;
    const date = req.query.date;
    const refresh = req.query.refresh === 'true';

    if (typeof origin !== 'string' || typeof destination !== 'string' || typeof date !== 'string') {
      res.status(400).json({ error: 'origin, destination, and date are required' });
      return;
    }

    const result = await searchRoutes({ origin, destination, date }, { forceRefresh: refresh });
    if (result.error && result.candidates.length === 0) {
      res.status(502).json({ error: result.error, result });
      return;
    }

    res.json(result);
  });

  return app;
}

/** Bind address. An empty HOST would make listen() bind every interface, so it is an error. */
export function resolveHost(host: string | undefined): string {
  if (host === undefined) return '127.0.0.1';
  if (host.trim() === '') throw new Error('HOST is set but empty; refusing to bind every interface');
  return host;
}


function main() {
  if (existsSync('.env')) process.loadEnvFile('.env');
  missingSourceWarnings(process.env).forEach((w) => console.warn(`warning: ${w}`));
  const sources = buildSources(process.env);
  const store = openStore(process.env.FLIGHTTRUTH_DB ?? join(homedir(), '.local/share/flighttruth/flighttruth.db'));
  const topic = process.env.NTFY_TOPIC;
  const baseUrl = process.env.FLIGHTTRUTH_URL ?? null;
  const log = (msg: string) => console.log(msg);

  const deps: PollerDeps = {
    store,
    lookup: (q) => lookupFlight(q, sources, { forceRefresh: true }),
    notify: topic
      ? (e, tripId) => sendNtfy(topic, e, baseUrl ? `${baseUrl}/trips.html?id=${tripId}` : null)
      : async (e) => log(`[no NTFY_TOPIC] ${e.title}: ${e.message}`),
    now: () => new Date(),
    log,
    position: createPositionLookup(),
    positionByCallsign: createCallsignLookup(),
    enrich: process.env.BRIGHTDATA_API_KEY ? createEnricher((url) => scrapeHtml(url), { log }) : undefined,
  };
  const poller = createTripPoller(deps);
  const host = resolveHost(process.env.HOST);
  poller.start();
  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  createApp({ store, pollNow: poller.pollNow, sources }).listen(port, host, () => {
    console.log(`flighttruth listening on http://${host}:${port}`);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) main();
