import { describe, it, expect, vi, afterEach } from 'vitest';
import { adsbExchangeSource } from '../../src/sources/adsbExchange.js';

describe('adsbExchangeSource', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('extracts registration and aircraft type for a matching callsign', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        ac: [
          { hex: '7380ca', flight: 'ELY091  ', r: '4X-EDL', t: 'B789' },
        ],
      }),
    })));

    const result = await adsbExchangeSource.fetch({ type: 'number', query: 'LY91', date: '2026-07-28' });

    expect(result.error).toBeUndefined();
    expect(result.fields.tailNumber?.value).toBe('4X-EDL');
    expect(result.fields.aircraftType?.value).toBe('B789');
  });

  it('prefers the descriptive type name when present', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        ac: [{ hex: '7380ca', flight: 'ELY091  ', r: '4X-EDL', t: 'B789', desc: 'Boeing 787-9' }],
      }),
    })));

    const result = await adsbExchangeSource.fetch({ type: 'number', query: 'LY91', date: '2026-07-28' });

    expect(result.fields.aircraftType?.value).toBe('Boeing 787-9');
  });

  it('records an error when no aircraft matches the callsign', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ ac: [] }) })));

    const result = await adsbExchangeSource.fetch({ type: 'number', query: 'LY91', date: '2026-07-28' });

    expect(result.error).toBeTruthy();
  });

  it('sends a descriptive User-Agent, since adsb.lol 403s the default fetch UA', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, json: async () => ({ ac: [] }) }));
    vi.stubGlobal('fetch', fetchMock);

    await adsbExchangeSource.fetch({ type: 'number', query: 'LY91', date: '2026-07-28' });

    const [, init] = fetchMock.mock.calls[0];
    expect(init?.headers?.['User-Agent' as keyof HeadersInit]).toBeTruthy();
  });
});
