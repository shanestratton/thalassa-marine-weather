import { useSyncExternalStore } from 'react';

export interface SquallStatus {
    phase: 'idle' | 'loading' | 'ready' | 'error';
    /** Rainbow forecast=0 snapshot time, NOT the time its ID was fetched. */
    snapshotTimeMs: number | null;
    fetchedAtMs: number | null;
    tilesReady: boolean;
    error: string | null;
}

const initial: SquallStatus = {
    phase: 'idle',
    snapshotTimeMs: null,
    fetchedAtMs: null,
    tilesReady: false,
    error: null,
};
let state = initial;
const listeners = new Set<() => void>();
export const squallStatusStore = {
    get: () => state,
    set: (patch: Partial<SquallStatus>) => {
        state = { ...state, ...patch };
        listeners.forEach((listener) => listener());
    },
    reset: () => {
        state = initial;
        listeners.forEach((listener) => listener());
    },
};
const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
};
export const useSquallStatus = () => useSyncExternalStore(subscribe, squallStatusStore.get, squallStatusStore.get);

/** Rainbow's documented snapshot_timestamp is Unix seconds. An opaque ID
 * must remain unknown; old but plausible timestamps must retain their age. */
export function squallSnapshotTimeMs(snapshot: number, now = Date.now()): number | null {
    if (!Number.isSafeInteger(snapshot)) return null;
    const ms = snapshot * 1000;
    return ms >= Date.UTC(2000, 0, 1) && ms <= now + 10 * 60_000 ? ms : null;
}

export function squallStatusText(status: SquallStatus, now = Date.now()): string {
    if (status.error) return status.error;
    if (status.phase === 'idle') return 'Not loaded';
    if (status.phase === 'loading' || !status.tilesReady) return 'Loading precipitation…';
    if (status.snapshotTimeMs === null) return 'Snapshot time unknown';
    if (status.snapshotTimeMs > now) return 'Snapshot time is ahead of device clock';
    const minutes = Math.floor((now - status.snapshotTimeMs) / 60_000);
    return minutes >= 60 ? `Snapshot ${Math.floor(minutes / 60)}h ${minutes % 60}m old` : `Snapshot ${minutes}m old`;
}
