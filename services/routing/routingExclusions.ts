/** Current negative route context. Never grants depth, water, permission or clearance. */
import type { FeatureCollection, MultiPolygon, Polygon } from 'geojson';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent } from '../authIdentityScope';
import { loadUserOverlays, readUserOverlay, userOverlayGeneration } from '../userOverlays/store';
import { overlayPolygonOverlaps, validOverlayRouteBounds, type OverlayRouteBounds } from '../userOverlays/model';
import { borrowRetainedMpaDataset, retainedMpaRoutingContextKey } from '../weather/api/mpaDataset';

/** Source key only: callers separately bind the current route/vessel request. */
export function routingExclusionContextKey(): string {
    const auth = getAuthIdentityScope();
    return JSON.stringify([auth.key, auth.generation, userOverlayGeneration(), retainedMpaRoutingContextKey()]);
}

export interface CurrentRoutingExclusions {
    readonly manual: FeatureCollection<Polygon | MultiPolygon> | undefined;
    readonly marineParks: FeatureCollection | undefined;
    readonly advisories: readonly string[];
    isCurrent(): boolean;
    release(): void;
}
/** A corrupt hard-policy library/file throws: callers must not route with an empty substitute. */
export async function readCurrentRoutingExclusions({
    bbox,
    signal,
}: {
    bbox: OverlayRouteBounds;
    signal?: AbortSignal;
}): Promise<CurrentRoutingExclusions> {
    if (!validOverlayRouteBounds(bbox)) throw Error('Invalid route exclusion bounds.');
    const windowBounds = Object.freeze([...bbox]) as OverlayRouteBounds;
    const scope = getAuthIdentityScope(),
        generation = userOverlayGeneration(),
        contextKey = routingExclusionContextKey();
    let active = true,
        manual: CurrentRoutingExclusions['manual'],
        marineParks: FeatureCollection | undefined;
    const mpa = borrowRetainedMpaDataset({ bbox: windowBounds, signal });
    const current = () =>
        active &&
        !signal?.aborted &&
        isAuthIdentityScopeCurrent(scope) &&
        userOverlayGeneration() === generation &&
        routingExclusionContextKey() === contextKey &&
        mpa.isCurrent();
    const check = () => {
        if (!current()) throw Error('The route exclusion context changed or was cancelled. Review the route again.');
    };
    const release = () => {
        active = false;
        manual = undefined;
        marineParks = undefined;
        mpa.release();
        signal?.removeEventListener('abort', release);
    };
    signal?.addEventListener('abort', release, { once: true });
    try {
        check();
        if (scope.userId) {
            const library = await loadUserOverlays(scope);
            check();
            manual = { type: 'FeatureCollection', features: [] };
            for (const row of library.overlays) {
                check();
                if (row.avoidRouting !== true) continue;
                const data = await readUserOverlay(row, scope);
                check();
                const polygons = data.features.filter(
                    (feature): feature is typeof feature & { geometry: Polygon | MultiPolygon } =>
                        feature.geometry.type === 'Polygon' || feature.geometry.type === 'MultiPolygon',
                );
                if (!polygons.length)
                    throw Error('An enabled no-go overlay has no verified polygon. Review Your overlays.');
                for (const feature of polygons)
                    if (overlayPolygonOverlaps(feature.geometry, windowBounds))
                        manual.features.push({ type: 'Feature', properties: {}, geometry: feature.geometry });
            }
        }
        check();
        marineParks = mpa.data;
        const advisories = Object.freeze([
            ...(scope.userId ? [] : ['Signed out: no private routing polygons are available.']),
            mpa.status === 'available'
                ? 'Marine park footprints use indicative classifications and add caution only; check current local rules.'
                : mpa.status === 'expired'
                  ? 'Retained marine park data has expired; marine park caution is unavailable.'
                  : mpa.status === 'bounded-out'
                    ? 'Marine park geometry exceeds this route window’s bounded budget; marine park caution is unavailable.'
                    : 'No verified marine park dataset is retained; marine park caution is unavailable.',
        ]);
        return {
            get manual() {
                return manual;
            },
            get marineParks() {
                return marineParks;
            },
            advisories,
            isCurrent: current,
            release,
        };
    } catch (error) {
        release();
        throw error;
    }
}
