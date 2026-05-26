/**
 * VoyageTrackCache — local-first persistence for a voyage's recorded track.
 *
 * Why: viewing a voyage's track (TrackMapViewer) re-fetches every entry from
 * Supabase (getLogEntries, paginated, no timeout). On a flaky boat connection
 * — or on a SECOND device viewing another device's in-progress voyage — that
 * fetch hangs and the viewer spins forever (the "iPhone can't get the route
 * up, just the suggested routes" report). Caching the last-viewed track
 * locally lets the viewer paint instantly while the network refresh happens
 * in the background.
 *
 * Bounded on purpose: a single most-recently-viewed voyage, and skipped if it
 * serialises larger than MAX_BYTES so we never blow Capacitor Preferences.
 * Preferences already stores large payloads here (the ship-log offline queue),
 * so this is consistent with existing usage.
 */
import { Preferences } from '@capacitor/preferences';
import type { ShipLogEntry } from '../../types';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('VoyageTrackCache');
const KEY = 'thalassa_voyage_track_cache_v1';
/** ~4 MB guard — Preferences isn't a blob store; skip pathologically large tracks. */
const MAX_BYTES = 4_000_000;

interface CachedTrack {
    voyageId: string;
    at: number;
    entries: ShipLogEntry[];
}

/**
 * Pure: is this track worth caching, and small enough to safely persist?
 * A 1-point "track" isn't a line; anything over the byte guard is skipped.
 */
export function shouldCacheTrack(entryCount: number, serializedBytes: number): boolean {
    return entryCount >= 2 && serializedBytes <= MAX_BYTES;
}

/** Read the cached track for a voyage, or null if none/another voyage is cached. */
export async function getCachedVoyageTrack(voyageId: string | null | undefined): Promise<ShipLogEntry[] | null> {
    if (!voyageId) return null;
    try {
        const { value } = await Preferences.get({ key: KEY });
        if (!value) return null;
        const c = JSON.parse(value) as CachedTrack;
        return c.voyageId === voyageId && Array.isArray(c.entries) ? c.entries : null;
    } catch (e) {
        log.warn('read failed', e);
        return null;
    }
}

/** Persist a voyage's track (last-viewed wins). No-ops on empty/oversized tracks. */
export async function setCachedVoyageTrack(
    voyageId: string | null | undefined,
    entries: ShipLogEntry[],
): Promise<void> {
    if (!voyageId) return;
    try {
        const payload = JSON.stringify({ voyageId, at: Date.now(), entries } satisfies CachedTrack);
        if (!shouldCacheTrack(entries.length, payload.length)) return;
        await Preferences.set({ key: KEY, value: payload });
    } catch (e) {
        log.warn('write failed', e);
    }
}
