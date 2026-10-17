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
    const reader = ownerReader,
        snapshot = currentOwner(),
        epoch = snapshot.epoch;
    let captured = snapshot.entry;
    const checkedAt = captured?.checkedAt;
    const sameOwner = () => {
        const now = currentOwner();
        return ownerReader === reader && now.entry === captured && now.epoch === epoch;
    };
    const fresh = () => !!captured && sameOwner() && captured.checkedAt === checkedAt && retainedFresh(captured);
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
    const release = () => {
        active = false;
        data = undefined;
        captured = null;
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
        isCurrent: () =>
            active &&
            !signal?.aborted &&
            sameOwner() &&
            captured?.checkedAt === checkedAt &&
            (status === 'absent' || status === 'expired' ? !captured || !fresh() : fresh()),
        release,
    };
}
