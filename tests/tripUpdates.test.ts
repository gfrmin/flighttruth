import { describe, it, expect } from 'vitest';
import { createTripUpdates } from '../src/tripUpdates.js';

describe('createTripUpdates', () => {
  it('a second unsubscribe does not drop a later subscriber', () => {
    const updates = createTripUpdates();
    const off = updates.subscribe(1, () => {});
    off();
    let heard = 0;
    updates.subscribe(1, () => { heard += 1; });
    off();
    updates.publish(1);
    expect(heard).toBe(1);
  });
  it('a listener that throws neither stops the others nor fails the publisher', () => {
    const updates = createTripUpdates();
    let heard = 0;
    updates.subscribe(1, () => { throw new Error('socket gone'); });
    updates.subscribe(1, () => { heard += 1; });
    expect(() => updates.publish(1)).not.toThrow();
    expect(heard).toBe(1);
  });
  it('counts listeners per trip', () => {
    const updates = createTripUpdates();
    const off = updates.subscribe(1, () => {});
    expect(updates.listenerCount(1)).toBe(1);
    off();
    expect(updates.listenerCount(1)).toBe(0);
  });
});
