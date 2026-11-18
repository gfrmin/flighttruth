import { describe, it, expect } from 'vitest';
import { airportCity, placeNames } from '../src/airports.js';

describe('airportCity', () => {
  it('names the city an airport serves', () => {
    expect(airportCity('lgw')).toBe('London');
    expect(airportCity('HKG')).toBe('Hong Kong');
  });
  it('is null for an unknown code', () => {
    expect(airportCity('QQQ')).toBe(null);
  });
});

describe('placeNames', () => {
  it('names every airport in a trip view, its plane’s earlier flights included', () => {
    const view = {
      legs: [
        { origin: 'LGW', destination: 'ZRH', extras: { rotation: { previous: [{ origin: 'TLV', destination: 'LGW' }] } } },
        { origin: 'ZRH', destination: 'QQQ', extras: null },
      ],
    };
    expect(placeNames(view as never)).toEqual({ LGW: 'London', ZRH: 'Zurich', TLV: 'Tel Aviv' });
  });
  it('is empty without a view', () => {
    expect(placeNames(null)).toEqual({});
  });
});
