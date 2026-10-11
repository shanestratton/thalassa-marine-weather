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
    setEncOverviewMode,
    setEncVectorVisibility,
    unmountEncVectorLayer,
    updateEncDepthStyle,
} from './EncVectorLayer';
import {
    GLAZE_MIN_ZOOM,
    getMergedVectorData,
    hasAnyDisplayCells,
    setMergeInteractionProbe,
    subscribe as subscribeToEnc,
    subscribeGeometryUpgrades,
    type EncMergedVectorData,
} from '../../services/enc/EncHazardService';
import { encDisplayScale, ENC_MERGE_MIN_ZOOM } from './encDisplayScale';
import { setEncDisplayState } from './encDisplayState';
import { chartTurning } from './chartOrientation';

const log = createLogger('useEncVectorLayer');

// Browsing retains its z6.5 compute gate: a country-wide z4 boot once
// stalled while merging geometry that could not draw. Active plotting also
// supports bounded z5+ passage overviews (encDisplayScale), with base-layer
// render floors aligned to that compute policy rather than disappearing at z7.
let prewarmInFlight: Promise<unknown> | null = null;
let lastPrewarmAt = 0;

type Bbox = [number, number, number, number];

/**
 * The merge window round the view. North up, and while plotting: the view's
 * box x the window factor about its centre. In a turning mode (127-11a, audit
 * A7) getBounds is the box round the TURNED view, so that window grew with
 * the bearing (about 2.3x the area at 45° on a portrait phone, against the
 * 2 GB WebContent cap), and a turn alone could carry the view out of it and
 * start a merge, the kill chain's expensive step. There it is a square on
 * the camera instead, side max(1.05 x the view's diagonal, factor x
 * sqrt(w x h)) px: today's area, with every bearing inside it.
 */
export function windowFor(map: mapboxgl.Map, plotting = false): Bbox {
    const factor = encDisplayScale(map.getZoom(), plotting).windowFactor;
    if (chartTurning() && !plotting) {
        const box = map.getContainer();
        const w = box.clientWidth;
        const h = box.clientHeight;
        const c = map.getCenter();
        // Half the side in mercator units (Mapbox's world is 512 x 2^zoom px).
        const half = Math.max(1.05 * Math.hypot(w, h), factor * Math.sqrt(w * h)) / (1024 * Math.pow(2, map.getZoom()));
        const y = 0.5 - Math.log(Math.tan(Math.PI / 4 + (c.lat * Math.PI) / 360)) / (2 * Math.PI);
        const lat = (my: number) => (360 / Math.PI) * Math.atan(Math.exp((0.5 - my) * 2 * Math.PI)) - 90;
        return [c.lng - half * 360, Math.max(lat(y + half), -85), c.lng + half * 360, Math.min(lat(y - half), 85)];
    }
    const b = map.getBounds()!;
    const cx = (b.getWest() + b.getEast()) / 2;
    const cy = (b.getSouth() + b.getNorth()) / 2;
    const hw = ((b.getEast() - b.getWest()) / 2) * factor;
    const hh = ((b.getNorth() - b.getSouth()) / 2) * factor;
    return [cx - hw, Math.max(cy - hh, -85), cx + hw, Math.min(cy + hh, 85)];
}

/**
 * Boot pre-warm (z10-boot audit #4): fire the FIRST merge the moment the map
 * object exists, so its blob reads + parses + glaze clip run UNDER Mapbox's
 * style/tile network wait instead of after it. Fire-and-forget: the result
 * lands in getMergedVectorData's selection-keyed memo (single-flight guards
 * coalesce with the real apply()), so the mount at mapReady is a cache hit.
 * Zoom-gated like every other merge trigger — never fires on the wide
 * no-fix fallback boot (the zoom-gate lesson); worst case (user pans before
 * load) is one wasted time-sliced merge.
 */
export function prewarmEncMerge(map: mapboxgl.Map): void {
    try {
        if (map.getZoom() < ENC_MERGE_MIN_ZOOM || !hasAnyDisplayCells()) return;
        const now = Date.now();
        if (prewarmInFlight || now - lastPrewarmAt < 2_000) return;
        lastPrewarmAt = now;
        const win = windowFor(map);
        log.info(`[prewarm] boot merge start z=${map.getZoom().toFixed(1)}`);
        prewarmInFlight = getMergedVectorData(win, map.getZoom(), { includeReferences: true })
            .catch(() => undefined)
            .finally(() => {
                prewarmInFlight = null;
            });
    } catch {
        /* prewarm is best-effort — the normal apply path still runs */
    }
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
    /** The router's grounding threshold (draft×1.5 + UKC). Drives the glaze's
     *  [safety, hazard) caution band so the hand-piloting surface agrees with
     *  the router (cycle-5 re-audit). Omitted → the two-band glaze look. */
    hazardDepthM?: number,
    /**
     * Tracer is up. Forces the pipeline to MOUNT even with the chart toggled
     * off, because the plotting keel floor cannot work on layers that do not
     * exist — see the `visible!` early-return below.
     */
    plotting: boolean = false,
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
     *  14 wholesale setData uploads for it was pure waste (2026-07-12
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
    const hazardDepthRef = useRef(hazardDepthM);
    hazardDepthRef.current = hazardDepthM;

    useEffect(() => {
        // DEBOUNCED (2026-07-11, Shane: "takes a long time for our new
        // layer to show up"): every putCell notify used to trigger a
        // FULL re-merge — a 171-cell cloud/Pi sync fired up to 171
        // merges back to back, each re-clipping and re-laddering the
        // whole coast. Trailing 800 ms coalesces a registration storm
        // into one merge once the dust settles.
        // MAX-WAIT (z10-boot audit, 2026-07-16): trailing-only reset starved
        // the fast-network cold boot — every arriving cell reset the 800 ms
        // timer, so nothing painted until the whole hydration walk finished.
        // Keep the coalesce, but force a bump when ~3 s have passed since the
        // FIRST uncoalesced notify: the chart paints in waves while cells land.
        let t: number | null = null;
        let firstNotifyMs: number | null = null;
        const unsub = subscribeToEnc(() => {
            const now = Date.now();
            if (firstNotifyMs === null) firstNotifyMs = now;
            const fire = () => {
                t = null;
                firstNotifyMs = null;
                setBumpCounter((c) => c + 1);
            };
            if (now - firstNotifyMs >= 3_000) {
                if (t !== null) window.clearTimeout(t);
                fire();
                return;
            }
            if (t !== null) window.clearTimeout(t);
            t = window.setTimeout(fire, 800);
        });
        return () => {
            if (t !== null) window.clearTimeout(t);
            unsub();
        };
    }, []);

    // Geometry-upgrade watch: encGeometryWorker finished the hole-free
    // glaze / derived contours for the CACHED merge object — the same
    // object we last pushed (its collections were swapped in place), so
    // re-push just the source(s) whose features array actually changed
    // (refreshEncAsyncLayers skips the rest), and only once the camera has
    // settled — never mid-gesture.
    useEffect(() => {
        if (!mapReady) return;
        const map = mapRef.current;
        if (!map) return;
        let deferred = false;
        const apply = () => {
            deferred = false;
            const data = lastAppliedRef.current as EncMergedVectorData | null;
            if (!data || !mountedRef.current) return;
            try {
                refreshEncAsyncLayers(map, data);
            } catch {
                /* style mid-swap — the next full refresh re-applies */
            }
        };
        const unsub = subscribeGeometryUpgrades(() => {
            // Defer the heavy DEPARE_GLAZE re-serialize past an active gesture —
            // the merge time-slicer already parks on isMoving (setMergeInteraction
            // Probe below), but this worker-upgrade re-push did NOT, landing
            // mid-pan/zoom and dropping frames (cycle-4 audit #5). One coalesced
            // moveend apply, not one per straggling upgrade.
            if (map.isMoving()) {
                if (!deferred) {
                    deferred = true;
                    map.once('moveend', apply);
                }
            } else {
                apply();
            }
        });
        return () => {
            unsub();
            map.off('moveend', apply);
        };
    }, [mapRef, mapReady]);

    // Gesture probe for the merge's time-slicer: while the camera is
    // moving, merge slices park instead of stealing frame time from the
    // pan/zoom ("a little jerky", 2026-07-14).
    useEffect(() => {
        if (!mapReady) return;
        const map = mapRef.current;
        if (!map) return;
        setMergeInteractionProbe(() => map.isMoving());
        return () => setMergeInteractionProbe(null);
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
            // No ENC below the render floor → no merge to schedule (kills the
            // z4 boot stall). Crossing UP past the floor fires a normal moveend.
            const scale = encDisplayScale(map.getZoom(), plotting);
            if (!scale.merge) {
                setEncDisplayState(map, {
                    phase: !visible && !plotting ? 'off' : 'zoom-in',
                    overview: scale.overview,
                    loadedCells: 0,
                });
                // Cancel a queued/in-flight close-up apply before it can
                // publish stale "loaded" state below the compute floor.
                setBumpCounter((c) => c + 1);
                return;
            }
            const win = mergedWindowRef.current;
            // Stale when the ZOOM BUCKET changes, not when raw |dz| ≥ 1:
            // the merge's cull threshold and sounding LOD key off
            // Math.round(zoom), so a merge at z10.49 reused at z11.4
            // (raw delta 0.91) was showing bucket-10 culls at bucket-11
            // sizes — visibly missing islets/scraps (review 2026-07-14).
            // Crossing GLAZE_MIN_ZOOM is likewise a merge-parameter edge:
            // a z9.6 merge carries NO glaze, and without this a z10.2
            // view sat glaze-less until a full zoom of travel.
            const zNow = map.getZoom();
            const zMerged = mergedZoomRef.current;
            const paramsFresh =
                Math.round(zNow) === Math.round(zMerged) &&
                scale.overview === encDisplayScale(zMerged, plotting).overview &&
                zNow >= GLAZE_MIN_ZOOM === zMerged >= GLAZE_MIN_ZOOM;
            if (win && viewportInside(map, win) && paramsFresh) {
                const previous = lastAppliedRef.current as EncMergedVectorData | null;
                if (mountedRef.current && previous) {
                    setEncOverviewMode(map, scale.overview);
                    setEncDisplayState(map, {
                        phase: !visible && !plotting ? 'off' : previous.cellCount > 0 ? 'loaded' : 'unavailable',
                        overview: scale.overview,
                        loadedCells: !visible && !plotting ? 0 : previous.cellCount,
                    });
                }
                return;
            }
            // FIRST merge of the session: nothing on screen to protect, so
            // skip the pan-coalescing debounce and go now — the 250 ms was
            // pure added time-to-chart on boot (z10-boot audit, 2026-07-16).
            if (win === null) {
                if (t !== null) window.clearTimeout(t);
                t = null;
                setBumpCounter((c) => c + 1);
                return;
            }
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
    }, [mapRef, mapReady, plotting, visible]);

    useEffect(() => {
        if (!mapReady) return;
        const map = mapRef.current;
        if (!map) return;

        let cancelled = false;

        const apply = async () => {
            const zoom = map.getZoom();
            const scale = encDisplayScale(zoom, plotting);
            const report = (phase: 'loading' | 'loaded' | 'unavailable' | 'zoom-in' | 'off', loadedCells = 0) =>
                setEncDisplayState(map, { phase, overview: scale.overview, loadedCells });
            if (mountedRef.current) {
                // Never lower an old harbour dataset's floor before a valid
                // overview merge exists. A fine-only library can be excluded
                // at this scale; that is not permission to render its cached
                // close-up geometry as an overview fallback.
                if (!scale.overview) setEncOverviewMode(map, false);
                if (!visible && !plotting) setEncVectorVisibility(map, false);
            }
            if (!hasAnyDisplayCells()) {
                if (mountedRef.current) {
                    detachEncFeatureClickHandlers(map);
                    unmountEncVectorLayer(map);
                    mountedRef.current = false;
                    lastAppliedRef.current = null;
                }
                report('unavailable');
                return;
            }

            // Country-wide views still do no merge work. Plotting passage
            // overviews have a separate bounded floor; ordinary browsing and
            // prewarm keep their original gate.
            if (!scale.merge) {
                log.info(
                    `[apply] skipped — z=${zoom.toFixed(1)} below ${plotting ? 'plotting' : 'browsing'} merge floor`,
                );
                report(!visible && !plotting ? 'off' : 'zoom-in');
                return;
            }

            // Chart switched OFF: skip the whole pipeline, not just the paint.
            // The toggle used to hide the layers at the END of this function
            // while the merge, the 14-source setData and the cloud-hydration
            // walk all still ran on every pan — so turning the chart off cost
            // exactly as much memory as leaving it on, and was useless as a
            // diagnostic lever. `visible` is in this effect's dep array, so
            // switching back on re-enters here and merges immediately.
            // ...UNLESS the tracer is up. The plotting keel floor
            // (EncVectorLayer.ts:1662) exists precisely so no furniture toggle
            // can strip the depth read you are plotting against — but the
            // composer skips layers that do not exist (`if (!map.getLayer(id))
            // continue`, :1654), so skipping the MOUNT here silently voided
            // that guarantee rather than merely hiding pixels.
            //
            // How it surfaced: ChartModes' "Clear All" preset sets enc:false
            // and persists it, so one tap at any point in the past left the
            // planner with no white water for good (Shane 2026-07-22: "I have
            // lost my white areas in the water"). Worse than cosmetic — while
            // plotting, the imagery base is forced on (MapHub.tsx:2989) and
            // syncDepareBaseTreatment then drives the paper DEPARE to
            // fill-opacity 0, so the glaze is the ONLY depth painter and there
            // is no fallback. The mark re-assert kept buoys on screen, so the
            // chart still looked populated while the soundings were gone.
            if (!visible && !plotting) {
                if (mountedRef.current) setEncVectorVisibility(map, false);
                log.info('[apply] skipped — ENC chart toggled off');
                report('off');
                return;
            }

            try {
                const win = windowFor(map, plotting);
                report('loading');
                log.info(
                    `[apply] merge start z=${map.getZoom().toFixed(1)} win=${win.map((v) => v.toFixed(2)).join(',')}`,
                );
                const data = await getMergedVectorData(win, zoom, { includeReferences: true });
                log.info(
                    `[apply] merge done: ${
                        data
                            ? `${data.cellCount} cells, depare=${data.DEPARE.features.length}, glaze=${data.DEPARE_GLAZE.features.length}, cancelled=${cancelled}`
                            : // null means EITHER no cells in the window OR the merge
                              // was superseded by a newer one — and while panning it
                              // is nearly always the latter. Saying "no cells" for
                              // both actively misleads anyone reading a pan log.
                              'NULL (no cells in window, or superseded)'
                    }`,
                );
                if (cancelled) return;
                const currentScale = encDisplayScale(map.getZoom(), plotting);
                if (!currentScale.merge || currentScale.overview !== scale.overview || !viewportInside(map, win))
                    return;
                if (!data) {
                    report('unavailable');
                    return;
                }
                mergedWindowRef.current = win;
                mergedZoomRef.current = zoom;
                if (mountedRef.current) {
                    // refreshEncVectorData re-applies the depth style from
                    // the per-map state it seeded at mount, so the safety
                    // contour survives cell-list bumps without re-passing.
                    // Identity check: the selection-keyed merge cache hands
                    // back the same object when the cell set didn't change
                    // (zoom crossings, visibility toggles) — skip the
                    // 14-source re-upload entirely.
                    if (data !== lastAppliedRef.current) refreshEncVectorData(map, data);
                } else {
                    mountEncVectorLayer(map, data, {
                        safetyDepthM: safetyDepthRef.current,
                        hazardDepthM: hazardDepthRef.current,
                    });
                    // Click handlers reference the layer IDs that
                    // mount() just registered. Attach is idempotent
                    // so repeat-mounts on cell-list bumps don't pile
                    // up listeners.
                    attachEncFeatureClickHandlers(map);
                    mountedRef.current = true;
                }
                lastAppliedRef.current = data;
                setEncOverviewMode(map, scale.overview);
                // Always-on by default — explicit toggle from the FAB flips it.
                setEncVectorVisibility(map, visible);
                // Detail mode independently controls the busy fills + coastlines.
                // Apply AFTER visibility so the detail-hide stays effective.
                setEncChartDetail(map, chartDetail);
                report(data.cellCount > 0 ? 'loaded' : 'unavailable', data.cellCount);
            } catch (err) {
                if (!cancelled) report('unavailable');
                log.warn('failed to mount vector layer', err);
            }
        };

        // Defer the heavy ENC merge + mount one idle tick past first paint:
        // getMergedVectorData reads/parses/clones multi-MB cell blobs and
        // mountEncVectorLayer adds ~14 sources + ~30 layers, all main-thread.
        // Running it synchronously on mapReady blocked the first frame, so a
        // cold Charts open stalled before the basemap even showed. Idle-gating
        // lets the basemap + ocean tiles paint first; the chart fades in a
        // beat later, exactly as it already does. `timeout` bounds it so a
        // visibility/detail toggle still applies promptly under load.
        // setTimeout fallback for WKWebView (no requestIdleCallback).
        // timeout 50 (was 300): at a busy boot the callback effectively fires
        // AT the ceiling, so 300 was ~300 ms of guaranteed added time-to-chart
        // (z10-boot audit, 2026-07-16). 50 still lets the basemap's first
        // frame through — the merge itself is time-sliced, so it can't freeze.
        const ric = window.requestIdleCallback;
        const handle: number = ric
            ? ric(() => void apply(), { timeout: 50 })
            : (setTimeout(() => void apply(), 1) as unknown as number);

        return () => {
            cancelled = true;
            if (window.cancelIdleCallback) window.cancelIdleCallback(handle);
            else clearTimeout(handle);
        };
    }, [mapRef, mapReady, bumpCounter, visible, chartDetail, plotting]);

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
        updateEncDepthStyle(map, safetyDepthM, hazardDepthM);
    }, [mapRef, mapReady, safetyDepthM, hazardDepthM]);
}
