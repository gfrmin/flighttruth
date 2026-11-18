// In-process notice that a trip's saved state changed, so open trip pages can refresh at once
// instead of waiting for their next timed check.

export interface TripUpdates {
  /** Tells every listener for this trip; a listener that throws is skipped, never the caller's problem. */
  publish(tripId: number): void;
  /** Calls `listener` after each publish for this trip; returns the unsubscribe function. */
  subscribe(tripId: number, listener: () => void): () => void;
  listenerCount(tripId: number): number;
}

export function createTripUpdates(): TripUpdates {
  const listeners = new Map<number, Set<() => void>>();
  return {
    publish: (tripId) => listeners.get(tripId)?.forEach((fn) => {
      try { fn(); } catch { /* a closed stream; its own close handler unsubscribes it */ }
    }),
    subscribe: (tripId, listener) => {
      const set = listeners.get(tripId) ?? new Set();
      listeners.set(tripId, set.add(listener));
      return () => {
        set.delete(listener);
        // Only drop the entry if it is still this set: a repeat call must not drop a newer one.
        if (set.size === 0 && listeners.get(tripId) === set) listeners.delete(tripId);
      };
    },
    listenerCount: (tripId) => listeners.get(tripId)?.size ?? 0,
  };
}
