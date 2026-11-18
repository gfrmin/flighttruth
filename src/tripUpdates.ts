// In-process notice that a trip's saved state changed, so open trip pages can refresh at once
// instead of waiting for their next timed check.

export interface TripUpdates {
  publish(tripId: number): void;
  /** Calls `listener` after each publish for this trip; returns the unsubscribe function. */
  subscribe(tripId: number, listener: () => void): () => void;
}

export function createTripUpdates(): TripUpdates {
  const listeners = new Map<number, Set<() => void>>();
  return {
    publish: (tripId) => listeners.get(tripId)?.forEach((fn) => fn()),
    subscribe: (tripId, listener) => {
      const set = listeners.get(tripId) ?? new Set();
      listeners.set(tripId, set.add(listener));
      return () => {
        set.delete(listener);
        if (set.size === 0) listeners.delete(tripId);
      };
    },
  };
}
