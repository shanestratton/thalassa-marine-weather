/**
 * The two chart floors the tracer raises while it is up: the WYSIWYG mark
 * re-assert, and the plotting keel floor.
 *
 * Moved out of MapHub.tsx verbatim. CALL POSITION AND INTERNAL ORDER ARE BOTH
 * LOAD-BEARING — the marks effect runs before the keel-floor effect exactly as
 * it did in the body, and both must stay below useEncVectorLayer, which is
 * what mounts the layers they reassert.
 */
import { useEffect } from 'react';
import mapboxgl from 'mapbox-gl';
import {
    setEncVectorVisibility as encApplyLayerVisibility,
    setEncChartDetail as encApplyChartDetailLayers,
    setEncPlottingMode as encSetPlottingMode,
    ENC_VEC_LAYERS,
} from '../EncVectorLayer';
import { isScrubHidden } from '../encDetailScrubber';

export function useTracerChartFloors(
    mapRef: React.RefObject<mapboxgl.Map | null>,
    mapReady: boolean,
    coordCaptureMode: boolean,
    encVisible: boolean,
    encChartDetail: boolean,
): void {
    // Tracer WYSIWYG (Shane 2026-07-09 "show markers, leads, laterals
    // and cardinals"): while tracing, every mark the grader checks
    // must be ON SCREEN — laterals, cardinals, specials, lights and
    // the RECTRC leads — even if the punter has flipped the ENC
    // master toggle off or a mode hid them. styledata re-asserts
    // because cell loads re-add layers asynchronously; on exit,
    // visibility goes back to the master toggle + chart-detail owners.
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady || !coordCaptureMode) return;
        const MARK_LAYERS = [
            ENC_VEC_LAYERS.BOYLAT,
            ENC_VEC_LAYERS.BCNLAT,
            ENC_VEC_LAYERS.BOYCAR,
            ENC_VEC_LAYERS.BCNCAR,
            ENC_VEC_LAYERS.BOYSPP,
            ENC_VEC_LAYERS.BCNSPP,
            ENC_VEC_LAYERS.LIGHTS,
            ENC_VEC_LAYERS.RECTRC,
            ENC_VEC_LAYERS.RECTRC_LABEL,
            ENC_VEC_LAYERS.SOUNDG,
            ENC_VEC_LAYERS.NAVAIDS_LABEL,
        ];
        const apply = (): void => {
            try {
                for (const id of MARK_LAYERS) {
                    if (!map.getLayer(id)) continue;
                    // The detail scrubber outranks the tracer's re-assert
                    // (Shane 2026-07-15: "at the clean end of the scrubber
                    // I have flashing leads as well as markers" — this
                    // effect force-showed what the scrubber had cut, 120 ms
                    // apart, forever). Scrubbing clean is explicit intent;
                    // scrub back left and the marks return for plotting.
                    if (isScrubHidden(id)) continue;
                    // Conditional write — an unconditional setLayoutProperty
                    // emits a styledata that re-invokes this handler, and
                    // this effect is active during PLOTTING (coordCaptureMode)
                    // exactly when the user reported zoom locking up. Setting
                    // only when actually hidden lets steady state emit nothing.
                    const cur = (map.getLayoutProperty(id, 'visibility') as string | undefined) ?? 'visible';
                    if (cur !== 'visible') map.setLayoutProperty(id, 'visibility', 'visible');
                }
            } catch {
                /* style mid-swap — styledata re-applies */
            }
        };
        apply();
        // Coalesce the styledata burst a zoom/tile-load fires into ONE
        // trailing pass so the re-assert can't pin the thread mid-zoom.
        let pending: number | null = null;
        const scheduleApply = () => {
            if (pending !== null) return;
            pending = window.setTimeout(() => {
                pending = null;
                apply();
            }, 120);
        };
        map.on('styledata', scheduleApply);
        return () => {
            if (pending !== null) window.clearTimeout(pending);
            map.off('styledata', scheduleApply);
            try {
                encApplyLayerVisibility(map, encVisible);
                encApplyChartDetailLayers(map, encChartDetail);
            } catch {
                /* layers unmounted — nothing to restore */
            }
        };
    }, [coordCaptureMode, mapReady, encVisible, encChartDetail, mapRef]);

    // Raise the PLOTTING KEEL FLOOR for as long as the tracer is up. The
    // effect above force-shows the MARKS you steer by; this one guarantees the
    // DEPTH you clear by (glaze/bands + safety contour + wrecks, rocks and
    // obstructions), which no furniture toggle may strip from the one surface
    // that exists to answer "does this leg float my keel?". Lowered on unmount
    // so the browsing chart honours the skipper's own toggles again.
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady) return;
        encSetPlottingMode(map, coordCaptureMode);
        return () => {
            try {
                encSetPlottingMode(map, false);
            } catch {
                /* layers unmounted — nothing to lower */
            }
        };
    }, [mapReady, coordCaptureMode, mapRef]);
}
