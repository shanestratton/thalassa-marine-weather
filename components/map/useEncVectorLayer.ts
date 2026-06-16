/**
 * useEncVectorLayer — React lifecycle wrapper around
 * EncVectorLayer.
 *
 * Auto-loads + mounts the user's imported S-57 cells as a real
 * vector chart overlay (depth-graduated water, tan land, white
 * coastline, magenta hazard symbols) whenever ANY cell is imported.
 *
 * Phase 8 v1: simple "all cells, all layers, all the time, zoom-
 * gated". Sufficient for the typical 1-10 cell user. Phase 9 can
 * add viewport-filtered loading for fleet users.
 *
 * Reactivity:
 *   - Mounts once when map ready and cells exist.
 *   - Subscribes to EncHazardService cell-list changes; on bump
 *     reloads merged data + setData on the existing sources
 *     (cheaper than tearing down layers).
 *   - Unmounts when the last cell is removed.
 */

import { useEffect, useRef, useState } from 'react';
import type mapboxgl from 'mapbox-gl';

import { createLogger } from '../../utils/createLogger';
import {
    attachEncFeatureClickHandlers,
    detachEncFeatureClickHandlers,
    mountEncVectorLayer,
    refreshEncVectorData,
    setEncChartDetail,
    setEncVectorVisibility,
    unmountEncVectorLayer,
    updateEncDepthStyle,
} from './EncVectorLayer';
import { getMergedVectorData, hasAnyCells, subscribe as subscribeToEnc } from '../../services/enc/EncHazardService';

const log = createLogger('useEncVectorLayer');

export function useEncVectorLayer(
    mapRef: React.MutableRefObject<mapboxgl.Map | null>,
    mapReady: boolean,
    /**
     * Whether the user has toggled ENC vector display on in the layer FAB.
     * Defaults to `true` for backwards compat — older callers without a toggle
     * get the previous always-on behaviour.
     */
    visible: boolean = true,
    /**
     * Whether to show full chart detail (depth fills + coastlines) or just
     * land + markers. Defaults to `false` — clean view per user preference.
     */
    chartDetail: boolean = false,
    /**
     * Safety depth S in METRES = vesselDraftMetres(vessel) + tide margin.
     * Drives the DEPARE day-palette bands and the bold safety contour —
     * "the single most prominent line on the water" (EncVectorLayer). The
     * caller (MapHub) computes it from the live vessel profile; left
     * undefined the renderer falls back to its own keel-safe default, but
     * a real safety contour against a fake draft is worse than none, so
     * MapHub always passes the live value.
     */
    safetyDepthM?: number,
): void {
    const mountedRef = useRef(false);
    const [bumpCounter, setBumpCounter] = useState(0);

    // Latest safety depth, read inside the async apply() so the FIRST mount
    // always uses the live value — WITHOUT putting safetyDepthM in the mount
    // effect's deps. In the deps it would re-fire the whole mount/refresh
    // path (a full 6-source setData re-upload of the merged multi-cell
    // dataset) on every draft edit; the dedicated effect below restyles the
    // depth bands + safety contour in place via setPaintProperty/setFilter
    // instead. The ref keeps the during-mount window correct: a draft that
    // changes while the first apply() is still awaiting is picked up by
    // ref.current when mount runs.
    const safetyDepthRef = useRef(safetyDepthM);
    safetyDepthRef.current = safetyDepthM;

    useEffect(() => {
        const unsub = subscribeToEnc(() => setBumpCounter((c) => c + 1));
        return unsub;
    }, []);

    useEffect(() => {
        if (!mapReady) return;
        const map = mapRef.current;
        if (!map) return;

        let cancelled = false;

        const apply = async () => {
            if (!hasAnyCells()) {
                if (mountedRef.current) {
                    detachEncFeatureClickHandlers(map);
                    unmountEncVectorLayer(map);
                    mountedRef.current = false;
                }
                return;
            }

            try {
                const data = await getMergedVectorData();
                if (cancelled || !data) return;
                if (mountedRef.current) {
                    // refreshEncVectorData re-applies the depth style from
                    // the per-map state it seeded at mount, so the safety
                    // contour survives cell-list bumps without re-passing.
                    refreshEncVectorData(map, data);
                } else {
                    mountEncVectorLayer(map, data, { safetyDepthM: safetyDepthRef.current });
                    // Click handlers reference the layer IDs that
                    // mount() just registered. Attach is idempotent
                    // so repeat-mounts on cell-list bumps don't pile
                    // up listeners.
                    attachEncFeatureClickHandlers(map);
                    mountedRef.current = true;
                }
                // Always-on by default — explicit toggle from the FAB flips it.
                setEncVectorVisibility(map, visible);
                // Detail mode independently controls the busy fills + coastlines.
                // Apply AFTER visibility so the detail-hide stays effective.
                setEncChartDetail(map, chartDetail);
            } catch (err) {
                log.warn('failed to mount vector layer', err);
            }
        };

        // Defer the heavy ENC merge + mount one idle tick past first paint:
        // getMergedVectorData reads/parses/clones multi-MB cell blobs and
        // mountEncVectorLayer adds ~6 sources + ~18 layers, all main-thread.
        // Running it synchronously on mapReady blocked the first frame, so a
        // cold Charts open stalled before the basemap even showed. Idle-gating
        // lets the basemap + ocean tiles paint first; the chart fades in a
        // beat later, exactly as it already does. `timeout` bounds it so a
        // visibility/detail toggle still applies promptly under load.
        // setTimeout fallback for WKWebView (no requestIdleCallback).
        const ric = window.requestIdleCallback;
        const handle: number = ric
            ? ric(() => void apply(), { timeout: 300 })
            : (setTimeout(() => void apply(), 1) as unknown as number);

        return () => {
            cancelled = true;
            if (window.cancelIdleCallback) window.cancelIdleCallback(handle);
            else clearTimeout(handle);
        };
    }, [mapRef, mapReady, bumpCounter, visible, chartDetail]);

    // Live draft changes: re-band the depth fills + move the safety contour
    // in place (setPaintProperty/setFilter), no re-mount or re-upload. Mount
    // seeds the initial value via opts (from safetyDepthRef); this only fires
    // for a *changed* draft on an already-mounted map (guarded on mountedRef
    // so it no-ops before the layers exist — the in-flight mount picks up the
    // latest value through the ref).
    useEffect(() => {
        if (!mapReady || safetyDepthM === undefined || !mountedRef.current) return;
        const map = mapRef.current;
        if (!map) return;
        updateEncDepthStyle(map, safetyDepthM);
    }, [mapRef, mapReady, safetyDepthM]);
}
