/**
 * useEncVectorLayer — React lifecycle wrapper around
 * EncVectorLayer.
 *
 * Auto-loads + mounts the user's imported S-57 cells as a real
 * vector chart overlay (depth-graduated water, tan land, white
 * coastline, magenta hazard symbols) whenever ANY cell is imported.
 *
 * Phase 9 (2026-07-12): VIEWPORT-WINDOWED. Phase 8's "all cells,
 * all layers, all the time" was sufficient for the 1-10 cell user;
 * the completed 172-cell cloud bucket turned it into a multi-GB
 * heap (every blob parsed + a full merged clone + Mapbox's worker
 * copies) and desktop Chrome's renderer OOM-crashed the moment the
 * satellite rasters stacked on top. The merge now takes the map
 * viewport expanded WINDOW_FACTOR× and only re-merges when the view
 * escapes that window (or the zoom band shifts) — panning inside a
 * bay costs nothing.
 *
 * Reactivity:
 *   - Mounts once when map ready and cells exist.
 *   - Subscribes to EncHazardService cell-list changes; on bump
 *     reloads merged data + setData on the existing sources
 *     (cheaper than tearing down layers).
 *   - moveend: bumps ONLY when the viewport leaves the merged
 *     window or crosses a whole zoom level.
 *   - Unmounts when the last cell is removed.
 */

import { useEffect, useRef, useState } from 'react';
import type mapboxgl from 'mapbox-gl';

import { createLogger } from '../../utils/createLogger';
import {
    attachEncFeatureClickHandlers,
    detachEncFeatureClickHandlers,
    mountEncVectorLayer,
    refreshEncAsyncLayers,
    refreshEncVectorData,
    setEncChartDetail,
    setEncVectorVisibility,
    unmountEncVectorLayer,
    updateEncDepthStyle,
} from './EncVectorLayer';
import {
    getMergedVectorData,
    hasAnyCells,
    subscribe as subscribeToEnc,
    subscribeGeometryUpgrades,
    type EncMergedVectorData,
} from '../../services/enc/EncHazardService';

const log = createLogger('useEncVectorLayer');

/** Merge window = viewport expanded this many × per side. Big enough
 *  that a normal pan stays inside it; small enough that the merged
 *  set stays a bay, not a coastline. */
const WINDOW_FACTOR = 2.5;

type Bbox = [number, number, number, number];

function windowFor(map: mapboxgl.Map): Bbox {
    const b = map.getBounds()!;
    const cx = (b.getWest() + b.getEast()) / 2;
    const cy = (b.getSouth() + b.getNorth()) / 2;
    const hw = ((b.getEast() - b.getWest()) / 2) * WINDOW_FACTOR;
    const hh = ((b.getNorth() - b.getSouth()) / 2) * WINDOW_FACTOR;
    return [cx - hw, Math.max(cy - hh, -85), cx + hw, Math.min(cy + hh, 85)];
}

function viewportInside(map: mapboxgl.Map, win: Bbox): boolean {
    const b = map.getBounds()!;
    return b.getWest() >= win[0] && b.getSouth() >= win[1] && b.getEast() <= win[2] && b.getNorth() <= win[3];
}

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
    /** Window + zoom the current merge was built for — moveend only
     *  re-merges once the view actually escapes them. */
    const mergedWindowRef = useRef<Bbox | null>(null);
    const mergedZoomRef = useRef(0);
    /** The exact merged-data object last pushed to Mapbox. The merge
     *  cache is selection-keyed, so window escapes and zoom crossings
     *  over the SAME cell set return the identical object — re-running
     *  9 wholesale setData uploads for it was pure waste (2026-07-12
     *  audit; visible as a hitch on every FAB toggle too). */
    const lastAppliedRef = useRef<unknown>(null);

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
        // DEBOUNCED (2026-07-11, Shane: "takes a long time for our new
        // layer to show up"): every putCell notify used to trigger a
        // FULL re-merge — a 171-cell cloud/Pi sync fired up to 171
        // merges back to back, each re-clipping and re-laddering the
        // whole coast. Trailing 800 ms coalesces a registration storm
        // into one merge once the dust settles.
        let t: number | null = null;
        const unsub = subscribeToEnc(() => {
            if (t !== null) window.clearTimeout(t);
            t = window.setTimeout(() => {
                t = null;
                setBumpCounter((c) => c + 1);
            }, 800);
        });
        return () => {
            if (t !== null) window.clearTimeout(t);
            unsub();
        };
    }, []);

    // Geometry-upgrade watch: encGeometryWorker finished the hole-free
    // glaze / derived contours for the CACHED merge object — the same
    // object we last pushed (its collections were swapped in place), so
    // re-push just those two sources. If the view has since moved to a
    // different merge, this re-sends unchanged data — a cheap no-op.
    useEffect(() => {
        if (!mapReady) return;
        const map = mapRef.current;
        if (!map) return;
        const unsub = subscribeGeometryUpgrades(() => {
            const data = lastAppliedRef.current as EncMergedVectorData | null;
            if (!data || !mountedRef.current) return;
            try {
                refreshEncAsyncLayers(map, data);
            } catch {
                /* style mid-swap — the next full refresh re-applies */
            }
        });
        return unsub;
    }, [mapRef, mapReady]);

    // Window escape watch: re-merge only when the view leaves the merged
    // window, or crosses a whole zoom level (zooming IN never escapes the
    // window geometrically, but it must still re-merge — the shrinking
    // window is what pulls fine harbour cells past WINDOW_MIN_DIAG_RATIO
    // into the selection).
    useEffect(() => {
        if (!mapReady) return;
        const map = mapRef.current;
        if (!map) return;
        let t: number | null = null;
        const onMoveEnd = () => {
            const win = mergedWindowRef.current;
            if (win && viewportInside(map, win) && Math.abs(map.getZoom() - mergedZoomRef.current) < 1) return;
            if (t !== null) window.clearTimeout(t);
            t = window.setTimeout(() => {
                t = null;
                setBumpCounter((c) => c + 1);
            }, 250);
        };
        map.on('moveend', onMoveEnd);
        return () => {
            if (t !== null) window.clearTimeout(t);
            map.off('moveend', onMoveEnd);
        };
    }, [mapRef, mapReady]);

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
                    lastAppliedRef.current = null;
                }
                return;
            }

            try {
                const win = windowFor(map);
                const data = await getMergedVectorData(win, map.getZoom());
                if (cancelled || !data) return;
                mergedWindowRef.current = win;
                mergedZoomRef.current = map.getZoom();
                if (mountedRef.current) {
                    // refreshEncVectorData re-applies the depth style from
                    // the per-map state it seeded at mount, so the safety
                    // contour survives cell-list bumps without re-passing.
                    // Identity check: the selection-keyed merge cache hands
                    // back the same object when the cell set didn't change
                    // (zoom crossings, visibility toggles) — skip the
                    // 9-source re-upload entirely.
                    if (data !== lastAppliedRef.current) refreshEncVectorData(map, data);
                } else {
                    mountEncVectorLayer(map, data, { safetyDepthM: safetyDepthRef.current });
                    // Click handlers reference the layer IDs that
                    // mount() just registered. Attach is idempotent
                    // so repeat-mounts on cell-list bumps don't pile
                    // up listeners.
                    attachEncFeatureClickHandlers(map);
                    mountedRef.current = true;
                }
                lastAppliedRef.current = data;
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
