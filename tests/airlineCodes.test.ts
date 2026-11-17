import { describe, it, expect } from 'vitest';
import { flightNumberToIcaoCallsign, iataToIcaoAirlineCode, normalizeFlightNumber, splitFlightNumber } from '../src/airlineCodes.js';

describe('normalizeFlightNumber', () => {
  it('uppercases and strips whitespace', () => {
    expect(normalizeFlightNumber(' ba183 ')).toBe('BA183');
  });

  it('strips internal whitespace too', () => {
    expect(normalizeFlightNumber('BA 183')).toBe('BA183');
  });
});

describe('iataToIcaoAirlineCode', () => {
  it('maps a known IATA code to its ICAO code', () => {
    expect(iataToIcaoAirlineCode('LY')).toBe('ELY');
  });

  it('returns null for an unknown code', () => {
    expect(iataToIcaoAirlineCode('ZZ')).toBeNull();
  });

  it('knows airlines beyond the hand-picked majors, from the generated table', () => {
    expect(iataToIcaoAirlineCode('HX')).toBe('CRK'); // Hong Kong Airlines
    expect(iataToIcaoAirlineCode('FS')).toBe('AYN'); // FlyArystan, not the near-dormant Airfast
  });

  it('knows the easyJet subsidiaries flying under their own IATA codes', () => {
    expect(iataToIcaoAirlineCode('DS')).toBe('EZS');
    expect(iataToIcaoAirlineCode('EC')).toBe('EJU');
  });
});

describe('flightNumberToIcaoCallsign', () => {
  it('converts a real-world IATA flight number to its live ICAO callsign', () => {
    // Confirmed against a live flight: LY91 broadcasts as ELY091 over ADS-B.
    expect(flightNumberToIcaoCallsign('LY91')).toBe('ELY091');
  });

  it('returns null when the airline prefix is unknown', () => {
    expect(flightNumberToIcaoCallsign('ZZ91')).toBeNull();
  });

  it('returns null for a malformed flight number', () => {
    expect(flightNumberToIcaoCallsign('not-a-flight')).toBeNull();
  });
});

describe('splitFlightNumber', () => {
  it('takes a two-character IATA code even when it ends in a digit', () => {
    expect(splitFlightNumber('U21234')).toEqual({ code: 'U2', number: '1234' });
    expect(splitFlightNumber('W61234')).toEqual({ code: 'W6', number: '1234' });
  });

  it('handles IATA codes that start with a digit', () => {
    expect(splitFlightNumber('6E123')).toEqual({ code: '6E', number: '123' });
  });

  it('takes a three-letter ICAO code', () => {
    expect(splitFlightNumber('EZY1234')).toEqual({ code: 'EZY', number: '1234' });
  });

  it('splits an ordinary flight number', () => {
    expect(splitFlightNumber('LX 100')).toEqual({ code: 'LX', number: '100' });
  });
});
