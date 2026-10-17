/** Read-only retained MPA view. This module cannot load or publish a dataset. */
import type { VerifiedMpaCollection } from './mpaDataset';
import {
    overlayPolygonOverlaps,
    validOverlayRouteBounds,
    OVERLAY_INPUT_BYTES,
    OVERLAY_MAX_FEATURES,
    OVERLAY_MAX_VERTICES,
    type OverlayRouteBounds,
} from '../../userOverlays/model';

export const MPA_CACHE_TTL_MS = 30 * 60 * 1000;
interface RetainedEntry {
    readonly data: VerifiedMpaCollection;
    readonly generation: string;
    readonly checkedAt: number;
    readonly sourceDate: string;
    readonly publishedAt: string;
}
type OwnerReader = () => { readonly entry: RetainedEntry | null; readonly epoch: number };
let ownerReader: OwnerReader | null = null;
let registrationRevision = 0;

/** Internal loader bootstrap: a read-only closure over its PRIVATE verified
 * cache, never a cache entry, metadata DTO or caller-supplied source flag.
 * Only mpaDataset calls this; routing imports no loader and has no publisher. */
export function registerVerifiedMpaRetainedOwner(read: OwnerReader): void {
    if (typeof read !== 'function') throw TypeError('A retained owner requires its private reader closure.');
    if (ownerReader && ownerReader !== read) throw Error('The verified MPA owner is already registered.');
    if (ownerReader === read) return;
    ownerReader = read;
    registrationRevision++;
}
const currentOwner = () => ownerReader?.() ?? { entry: null, epoch: 0 };
const retainedOwnerIds = new WeakMap<RetainedEntry, number>();
let nextRetainedOwnerId = 0;
function retainedFresh(entry: RetainedEntry, now = Date.now()): boolean {
    return (
        now >= entry.checkedAt &&
        now - entry.checkedAt < MPA_CACHE_TTL_MS &&
        now - Date.parse(entry.publishedAt) <= 14 * 24 * 60 * 60 * 1000
    );
}
/** Synchronous source/freshness identity. No renewal, retention or loader import. */
export function retainedMpaRoutingContextKey(): string {
    const { entry, epoch } = currentOwner();
    if (!entry) return JSON.stringify([registrationRevision, epoch, null]);
    let owner = retainedOwnerIds.get(entry);
    if (owner === undefined) {
        owner = ++nextRetainedOwnerId;
        retainedOwnerIds.set(entry, owner);
    }
    return JSON.stringify([
        registrationRevision,
        epoch,
        owner,
        entry.generation,
        entry.checkedAt,
        entry.sourceDate,
        entry.publishedAt,
        retainedFresh(entry),
    ]);
}

export interface RetainedMpaBorrow {
    readonly data: VerifiedMpaCollection | undefined;
    readonly status: 'available' | 'absent' | 'expired' | 'bounded-out';
    readonly generation?: string;
    readonly sourceDate?: string;
    isCurrent(): boolean;
    release(): void;
}
/** Complete selected features from the actual verified RAM owner only. No
 * fetch, TTL renewal, ownership extension or full-footprint copy. */
export function borrowRetainedMpaDataset({
    bbox,
    signal,
}: {
    bbox: OverlayRouteBounds;
    signal?: AbortSignal;
}): RetainedMpaBorrow {
    if (!validOverlayRouteBounds(bbox)) throw Error('Invalid route exclusion bounds.');
    const reader = ownerReader;
    let source: ReturnType<typeof currentOwner> | null = currentOwner();
    const epoch = source.epoch;
    let captured = source.entry;
    const originalEntry = captured ? new WeakRef(captured) : null;
    const checkedAt = captured?.checkedAt;
    source = null;
    const sameOwner = () => {
        const now = currentOwner(),
            original = originalEntry?.deref();
        return (
            ownerReader === reader &&
            now.epoch === epoch &&
            (originalEntry ? !!original && now.entry === original : now.entry === null)
        );
    };
    const fresh = () => {
        const original = originalEntry?.deref();
        return !!original && sameOwner() && original.checkedAt === checkedAt && retainedFresh(original);
    };
    let active = true,
        data: VerifiedMpaCollection | undefined;
    let status: RetainedMpaBorrow['status'] = !captured ? 'absent' : !fresh() ? 'expired' : 'available';
    if (status === 'available' && captured && !signal?.aborted) {
        const features: VerifiedMpaCollection['features'] = [];
        const encoder = new TextEncoder();
        let vertices = 0,
            bytes = encoder.encode(JSON.stringify({ type: 'FeatureCollection', features: [] })).byteLength;
        for (const feature of captured.data.features) {
            if (signal?.aborted) break;
            if (!overlayPolygonOverlaps(feature.geometry, bbox)) continue;
            const polygons =
                feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
            for (const polygon of polygons) for (const ring of polygon) vertices += ring.length;
            if (features.length >= OVERLAY_MAX_FEATURES || vertices > OVERLAY_MAX_VERTICES) {
                status = 'bounded-out';
                break;
            }
            // One already-validated bounded feature at a time. The complete
            // dataset is never serialized/cloned to measure this selection.
            bytes += encoder.encode(JSON.stringify(feature)).byteLength + 1;
            if (bytes > OVERLAY_INPUT_BYTES) {
                status = 'bounded-out';
                break;
            }
            features.push(feature);
        }
        if (status === 'available' && !signal?.aborted) data = { type: 'FeatureCollection', features };
    }
    const generation = captured?.generation,
        sourceDate = captured?.sourceDate;
    // Only the bounded selected feature references may cross a route await.
    // No closure below keeps the original potentially 16 MiB owner alive.
    captured = null;
    const release = () => {
        active = false;
        data = undefined;
        signal?.removeEventListener('abort', release);
    };
    signal?.addEventListener('abort', release, { once: true });
    if (signal?.aborted) release();
    return {
        get data() {
            return data;
        },
        status,
        generation,
        sourceDate,
        isCurrent: () => {
            const original = originalEntry?.deref();
            const current =
                active &&
                !signal?.aborted &&
                sameOwner() &&
                original?.checkedAt === checkedAt &&
                (status === 'absent' || status === 'expired' ? !originalEntry || !fresh() : fresh());
            if (!current) release();
            return current;
        },
        release,
    };
}
