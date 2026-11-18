import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/server.js';
import { openStore } from '../src/store.js';
import { createTripUpdates } from '../src/tripUpdates.js';
import type { AddressInfo } from 'node:net';

describe('server', () => {
  it('responds to health check', async () => {
    const app = createApp();
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('returns 400 when required query params are missing', async () => {
    const app = createApp();
    const res = await request(app).get('/api/flight').query({ type: 'number' });
    expect(res.status).toBe(400);
  });

  it('returns 503 for trips when no store is configured', async () => {
    const res = await request(createApp()).get('/api/trips');
    expect(res.status).toBe(503);
  });

  it('creates, lists, polls and deactivates a trip', async () => {
    const store = openStore(':memory:');
    const polled: number[] = [];
    const app = createApp({ store, pollNow: async (id) => { polled.push(id); } });

    const created = await request(app).post('/api/trips').send({ label: 'Wife HK', input: 'EY101 EY102 2026-10-10' });
    expect(created.status).toBe(201);
    expect(created.body.legs).toHaveLength(2);

    const fetched = await request(app).get(`/api/trips/${created.body.id}`);
    expect(fetched.body.label).toBe('Wife HK');
    expect((await request(app).get('/api/trips')).body).toHaveLength(1);

    expect((await request(app).post(`/api/trips/${created.body.id}/poll`)).status).toBe(200);
    expect(polled).toContain(created.body.id);

    await request(app).delete(`/api/trips/${created.body.id}`);
    expect(store.getTrip(created.body.id)!.active).toBe(false);
    store.close();
  });

  it('returns the parser error for bad trip input', async () => {
    const app = createApp({ store: openStore(':memory:'), pollNow: async () => {} });
    const res = await request(app).post('/api/trips').send({ input: 'EY101 17/10/2026' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('dates must be YYYY-MM-DD');
  });

  it('returns 404 for an unknown trip', async () => {
    const app = createApp({ store: openStore(':memory:'), pollNow: async () => {} });
    expect((await request(app).get('/api/trips/99')).status).toBe(404);
  });

  it('returns 400 when /api/routes is missing required query params', async () => {
    const app = createApp();
    const res = await request(app).get('/api/routes').query({ origin: 'HKG' });
    expect(res.status).toBe(400);
  });
  it('GET /api/trips/:id includes the trip\'s alerts', async () => {
    const store = openStore(':memory:');
    const app = createApp({ store, pollNow: async () => {} });
    const created = await request(app).post('/api/trips').send({ input: 'U21234 2026-11-10' });
    store.recordAlert({ dedupeKey: `t${created.body.id}:U21234:takeoff`, title: 'U21234 took off', message: 'U21234 took off from LPA 12:57' }, true);
    const res = await request(app).get(`/api/trips/${created.body.id}`);
    expect(res.body.alerts[0].message).toBe('U21234 took off from LPA 12:57');
  });
  it('GET /api/trips/:id names the places in its view', async () => {
    const store = openStore(':memory:');
    const app = createApp({ store, pollNow: async () => {} });
    const created = await request(app).post('/api/trips').send({ input: 'LX1 2026-11-18' });
    const leg = { origin: 'LGW', destination: 'ZRH', extras: { rotation: { previous: [{ origin: 'HKG', destination: 'LGW' }] } } };
    store.saveTripState(created.body.id, { legs: [leg], connections: [], totalMinutes: null, state: 'upcoming' } as never, null);
    const res = await request(app).get(`/api/trips/${created.body.id}`);
    expect(res.body.places).toEqual({ LGW: 'London', ZRH: 'Zurich', HKG: 'Hong Kong' });
  });

  it('GET /api/trips/:id/events tells the page when a poll saved new data', async () => {
    const store = openStore(':memory:');
    const updates = createTripUpdates();
    const app = createApp({ store, pollNow: async () => {}, updates });
    const id = (await request(app).post('/api/trips').send({ input: 'LX1 2026-11-18' })).body.id;
    const server = app.listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/api/trips/${id}/events`);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const reader = res.body!.getReader();
      const first = new TextDecoder().decode((await reader.read()).value);
      expect(first).toContain(': connected');
      updates.publish(id + 1);
      updates.publish(id);
      const next = new TextDecoder().decode((await reader.read()).value);
      expect(next).toBe('event: updated\ndata: {}\n\n');
      await reader.cancel();
    } finally {
      server.close();
    }
  });

  it('GET /api/trips/:id/events is 404 for an unknown trip', async () => {
    const app = createApp({ store: openStore(':memory:'), pollNow: async () => {}, updates: createTripUpdates() });
    expect((await request(app).get('/api/trips/99/events')).status).toBe(404);
  });

  it('GET / serves the trips home', async () => {
    const res = await request(createApp()).get('/');
    expect(res.text).toContain('id="add-trip"');
  });

  it('GET /lookup.html serves the flight lookup', async () => {
    const res = await request(createApp()).get('/lookup.html');
    expect(res.text).toContain('id="search-form"');
  });
});
