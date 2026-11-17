import { describe, it, expect } from 'vitest';
import { parseTripInput } from '../src/tripInput.js';

const bothOn17 = { legs: [{ flightNumber: 'EY101', date: '2026-10-10' }, { flightNumber: 'EY102', date: '2026-10-10' }] };

describe('parseTripInput', () => {
  it('applies a trailing date to every leg before it', () => {
    expect(parseTripInput('EY101 EY102 2026-10-10')).toEqual(bothOn17);
  });

  it('tolerates case, commas, extra spaces and a space inside the flight number', () => {
    expect(parseTripInput('ey 101, EY102  2026-10-10')).toEqual(bothOn17);
  });

  it('supports a date per leg', () => {
    expect(parseTripInput('EY101 2026-10-10 EY102 2026-10-11')).toEqual({
      legs: [{ flightNumber: 'EY101', date: '2026-10-10' }, { flightNumber: 'EY102', date: '2026-10-11' }],
    });
  });

  it('rejects non-ISO dates', () => {
    expect(parseTripInput('EY101 17/10/2026')).toEqual({ error: 'dates must be YYYY-MM-DD' });
  });

  it('rejects impossible calendar dates', () => {
    expect(parseTripInput('EY101 2026-13-45')).toEqual({ error: 'not a real date: 2026-13-45' });
  });

  it('rejects input without flights', () => {
    expect(parseTripInput('2026-10-10')).toEqual({ error: 'no flight numbers found' });
  });

  it('rejects flights without a date', () => {
    expect(parseTripInput('EY101 2026-10-10 EY102')).toEqual({ error: 'no date given for EY102' });
  });

  it('rejects unrecognised words', () => {
    expect(parseTripInput('EY101 tomorrow')).toEqual({ error: 'not a flight number or date: TOMORROW' });
  });
});
