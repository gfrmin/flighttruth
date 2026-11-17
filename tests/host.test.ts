import { describe, it, expect } from 'vitest';
import { resolveHost } from '../src/server.js';

describe('resolveHost', () => {
  it('defaults to loopback when HOST is unset', () => {
    expect(resolveHost(undefined)).toBe('127.0.0.1');
  });

  it('uses an explicit address', () => {
    expect(resolveHost('100.64.0.1')).toBe('100.64.0.1'); // PII-OK: the first address of the range, not a real host
  });

  it('refuses an empty HOST rather than binding every interface', () => {
    expect(() => resolveHost('')).toThrow(/HOST is set but empty/);
  });
});
