/**
 * The three things the Sightings page lists:
 *   - mine: this account's records on this phone (they sync themselves), plus
 *     any from other devices once pulled;
 *   - the boat's crew feed: live from the server (RLS: the skipper and his
 *     accepted crew), with this phone's own unsent ones merged in so a
 *     sighting shows the moment it is logged; offline, the last copy;
 *   - the public feed: everyone's, three hours late and on a grid, decided
 *     by the server.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { adoptSignedOutSightings, signedOutSightingCount } from '../../services/sightings/sightingService';
import { listLocalSightings, subscribeSightingRecords } from '../../services/sightings/sightingStore';
import {
    boxAround,
    ensureSightingSyncTriggers,
    fetchBoatSpecies,
    fetchCrewSightings,
    fetchPublicSightings,
    pullMySightings,
    scheduleSightingDrain,
    sightingsServerUnavailable,
    subscribeCrewSightings,
    type BoatSpeciesRow,
} from '../../services/sightings/sightingSync';
import type { LocalSighting, PublicSighting, ServerSightingRow } from '../../services/sightings/types';

export interface MySightingsState {
    records: LocalSighting[];
    /** Deleted here, the server not told yet: hidden from the crew feed too. */
    deletedIds: ReadonlySet<string>;
    loaded: boolean;
    /** Logged on this phone while signed out, offered for adoption once signed in. */
    signedOutCount: number;
    /** The server has no sightings yet (the migration is not pushed). */
    serverUnavailable: boolean;
    reload: () => void;
    adopt: () => Promise<number>;
}

export function useMySightings(userId: string | null): MySightingsState {
    const [records, setRecords] = useState<LocalSighting[]>([]);
    const [deletedIds, setDeletedIds] = useState<ReadonlySet<string>>(() => new Set());
    const [loaded, setLoaded] = useState(false);
    const [signedOutCount, setSignedOutCount] = useState(0);
    const [serverUnavailable, setServerUnavailable] = useState(sightingsServerUnavailable());

    const reload = useCallback(() => {
        void Promise.all([listLocalSightings(userId), userId ? signedOutSightingCount() : Promise.resolve(0)]).then(
            ([all, anonymous]) => {
                setRecords(all.filter((r) => r.sync.op !== 'delete'));
                setDeletedIds(new Set(all.filter((r) => r.sync.op === 'delete').map((r) => r.id)));
                setSignedOutCount(anonymous);
                setLoaded(true);
                setServerUnavailable(sightingsServerUnavailable());
            },
        );
    }, [userId]);

    useEffect(() => {
        setLoaded(false);
        reload();
        const unsubscribe = subscribeSightingRecords(reload);
        if (userId) {
            ensureSightingSyncTriggers();
            scheduleSightingDrain(1_000);
            void pullMySightings().then(() => setServerUnavailable(sightingsServerUnavailable()));
        }
        return unsubscribe;
    }, [userId, reload]);

    const adopt = useCallback(async () => {
        const n = await adoptSignedOutSightings();
        reload();
        return n;
    }, [reload]);

    return { records, deletedIds, loaded, signedOutCount, serverUnavailable, reload, adopt };
}

export interface CrewFeedState {
    rows: ServerSightingRow[];
    loading: boolean;
    unavailable: boolean;
    fromCache: boolean;
    fetchedAt: number | null;
    refresh: () => void;
}

export function useCrewSightings(ownerId: string | null, isOffline: boolean): CrewFeedState {
    const [rows, setRows] = useState<ServerSightingRow[]>([]);
    const [loading, setLoading] = useState(false);
    const [meta, setMeta] = useState({ unavailable: false, fromCache: false, fetchedAt: null as number | null });
    const generation = useRef(0);

    const refresh = useCallback(() => {
        if (!ownerId) return;
        const mine = ++generation.current;
        setLoading(true);
        void fetchCrewSightings(ownerId).then((result) => {
            if (mine !== generation.current) return;
            setRows(result.rows);
            setMeta({ unavailable: result.unavailable, fromCache: result.fromCache, fetchedAt: result.fetchedAt });
            setLoading(false);
        });
    }, [ownerId]);

    useEffect(() => {
        setRows([]);
        setMeta({ unavailable: false, fromCache: false, fetchedAt: null });
        if (!ownerId) return;
        let live = true;
        let unsubscribe: (() => void) | null = null;
        const mine = ++generation.current;
        setLoading(true);
        void fetchCrewSightings(ownerId).then((result) => {
            if (mine === generation.current) {
                setRows(result.rows);
                setMeta({ unavailable: result.unavailable, fromCache: result.fromCache, fetchedAt: result.fetchedAt });
                setLoading(false);
            }
            // Live only once the server has the table: before the migration
            // push a channel on a missing table would only churn.
            if (!live || result.unavailable) return;
            // RLS decides what arrives. A crew row made Private arrives as
            // nothing, so the next refresh (on mount, back online) drops it.
            unsubscribe = subscribeCrewSightings(ownerId, (change) => {
                setRows((prev) => {
                    if (change.type === 'delete') return prev.filter((r) => r.id !== change.id);
                    const row = change.row;
                    if (row.vessel_owner_id !== ownerId || row.visibility === 'private') {
                        return prev.filter((r) => r.id !== row.id);
                    }
                    const rest = prev.filter((r) => r.id !== row.id);
                    return [row, ...rest].sort((a, b) => (a.event_date < b.event_date ? 1 : -1));
                });
            });
        });
        return () => {
            live = false;
            generation.current += 1;
            unsubscribe?.();
        };
    }, [ownerId]);

    // Back online: catch up on what the live channel missed.
    useEffect(() => {
        if (!isOffline && ownerId && meta.fromCache) refresh();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOffline]);

    return { rows, loading, ...meta, refresh };
}

export interface BoatSpeciesState {
    rows: BoatSpeciesRow[];
    /** All time from the server; false = an offline copy, or none (the crew feed's 30 days stand in). */
    complete: boolean;
}

/** The boat's named sightings, all time, for its life list; fetched only while the life list shows. */
export function useBoatSpecies(ownerId: string | null, enabled: boolean): BoatSpeciesState {
    const [state, setState] = useState<BoatSpeciesState>({ rows: [], complete: false });
    useEffect(() => {
        setState({ rows: [], complete: false });
        if (!ownerId || !enabled) return;
        let live = true;
        void fetchBoatSpecies(ownerId).then((result) => {
            if (live) setState({ rows: result.rows, complete: result.complete });
        });
        return () => {
            live = false;
        };
    }, [ownerId, enabled]);
    return state;
}

export interface PublicFeedState {
    rows: PublicSighting[];
    loading: boolean;
    unavailable: boolean;
    failed: boolean;
}

export function usePublicSightings(
    centre: { lat: number; lon: number } | null,
    radiusKm: number,
    enabled: boolean,
): PublicFeedState {
    const [state, setState] = useState<PublicFeedState>({
        rows: [],
        loading: false,
        unavailable: false,
        failed: false,
    });
    const lat = centre ? Math.round(centre.lat * 100) / 100 : null;
    const lon = centre ? Math.round(centre.lon * 100) / 100 : null;
    useEffect(() => {
        if (!enabled || lat === null || lon === null) return;
        let live = true;
        setState((s) => ({ ...s, loading: true }));
        void fetchPublicSightings(boxAround(lat, lon, radiusKm), null, 200).then((result) => {
            if (!live) return;
            setState({
                rows: result.rows,
                loading: false,
                unavailable: result.unavailable,
                failed: !result.unavailable && result.fetchedAt === null,
            });
        });
        return () => {
            live = false;
        };
    }, [lat, lon, radiusKm, enabled]);
    return state;
}

/**
 * The crew feed with this phone's own records for that boat merged in: an
 * unsent sighting shows at once, and your own edits win over the server's
 * copy until they are sent.
 */
export function useMergedCrewFeed(
    serverRows: ServerSightingRow[],
    mine: LocalSighting[],
    ownerId: string | null,
    deletedIds: ReadonlySet<string> = new Set(),
): Array<{ server: ServerSightingRow | null; local: LocalSighting | null; id: string; eventDate: string }> {
    return useMemo(() => {
        if (!ownerId) return [];
        const byId = new Map<
            string,
            { server: ServerSightingRow | null; local: LocalSighting | null; id: string; eventDate: string }
        >();
        for (const row of serverRows) {
            if (deletedIds.has(row.id)) continue; // deleted here; the outbox tells the server
            byId.set(row.id, { server: row, local: null, id: row.id, eventDate: row.event_date });
        }
        for (const record of mine) {
            const r = record.row;
            const shared = r.vessel_owner_id === ownerId && (r.visibility === 'crew' || r.visibility === 'public');
            if (!shared) {
                byId.delete(record.id); // made Private here: gone from this phone's view of the feed
                continue;
            }
            byId.set(record.id, {
                server: byId.get(record.id)?.server ?? null,
                local: record,
                id: record.id,
                eventDate: r.event_date,
            });
        }
        return [...byId.values()].sort((a, b) => (a.eventDate < b.eventDate ? 1 : a.eventDate > b.eventDate ? -1 : 0));
    }, [serverRows, mine, ownerId, deletedIds]);
}
