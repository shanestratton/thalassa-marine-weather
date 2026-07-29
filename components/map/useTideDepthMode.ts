/**
 * useTideDepthMode — "Depth right now" and the night-dim treatment.
 *
 * Extracted from MapHub. This is the whole live-tide machine: the persisted
 * toggle, the acknowledgement gate, the tide curve for the waters under the
 * map centre, the quarter-hour scrubber, and the single depth offset those
 * feed into the paint layer.
 *
 * The hard rule this hook exists to protect: the offset is VISUAL ONLY. The
 * safety contour, the tracer and the router keep grading against chart datum,
 * always. Everything here paints; nothing here decides whether water is safe.
 *
 * Night dim rides along because it is the same shape of thing — a persisted
 * chart treatment applied to the live map — and because its cleanup has the
 * same failure mode: it renders to document.body, so it leaks app-wide if it
 * is not torn down with the map.
 *
 * The comments below travelled with the code. Each one records an audit or a
 * review finding, and none of them should be re-derived:
 *
 *   - the curve is KEPT when a refresh fails for the same waters, because a
 *     network blip mid-scrub silently dropped the chart to datum;
 *   - the scrub is RELATIVE (quarter-hours ahead), because an absolute
 *     instant drifted into the past and the thumb crept as time passed;
 *   - scrub application is throttled to ~150 ms trailing-edge, because
 *     soundings and contour labels are LAYOUT properties and every detent
 *     forced Mapbox to re-shape and re-collision-place every visible label;
 *   - the scrub instant rides along to the paint layer so the tap-the-water
 *     popup can never present a scrubbed tide as "right now".
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type mapboxgl from 'mapbox-gl';
import { usePersistedState } from '../../hooks/usePersistedState';
import { triggerHaptic } from '../../utils/system';
import { ENC_NIGHT_DIM_KEY, setEncNightDim, setEncTideOffset } from './EncVectorLayer';
import { TIDE_DEPTH_ACK_KEY } from './ChartDepthControls';
import {
    readTideCurveWindow,
    tideReadAt,
    type TideCurveWindow,
    type TideOffsetRead,
} from '../../services/TideOffsetService';

/** The instant the scrub currently points at (null = live). */
const scrubInstant = (q: number): number | null => (q > 0 ? Date.now() + q * 900_000 : null);

export interface TideDepthMode {
    tideDepthMode: boolean;
    setTideDepthMode: (v: boolean) => void;
    nightDim: boolean;
    setNightDim: (v: boolean) => void;
    tideOffsetInfo: TideOffsetRead | null;
    showTideAck: boolean;
    setShowTideAck: (v: boolean) => void;
    tideScrubQ: number;
    setTideScrubQ: (v: number) => void;
    onToggleTideDepth: () => void;
}

export function useTideDepthMode(
    mapRef: React.RefObject<mapboxgl.Map | null>,
    mapReady: boolean,
    planningSurface: boolean,
): TideDepthMode {
    // Charted depth + predicted tide, ONE offset applied at the paint
    // layer (band tints, sounding numbers, contour labels — see
    // setEncTideOffset). VISUAL ONLY by hard rule: the safety contour,
    // tracer and router keep grading against chart datum. Persisted:
    // the offset is re-read live on every boot, and the badge makes the
    // mode unmistakable, so stickiness is safe.
    const [tideDepthMode, setTideDepthMode] = usePersistedState('thalassa_tide_depth_mode', false);
    // Night dim — chartplotter-style red-tinted uniform dim (burn-down:
    // the white DEPARE ramp killed night vision at the helm).
    const [nightDim, setNightDim] = usePersistedState(ENC_NIGHT_DIM_KEY, false);
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady) return;
        try {
            // Night dim is implemented as a document.body overlay rather than
            // a Mapbox layer. Keep the saved Chart preference, but never let
            // that full-screen tint bleed into a clean planning surface.
            setEncNightDim(map, planningSurface ? false : nightDim);
        } catch {
            /* style mid-swap — the next mapReady pass reapplies */
        }
        // The dim div lives on document.body, so it leaks app-wide if MapHub
        // unmounts while ON (cycle-5 audit #5). This cleanup also runs on every
        // re-toggle (harmless: off-then-on nets to the correct state).
        return () => {
            try {
                setEncNightDim(map, false);
            } catch {
                /* map/style torn down */
            }
        };
    }, [mapRef, nightDim, mapReady, planningSurface]);
    const [tideOffsetInfo, setTideOffsetInfo] = useState<TideOffsetRead | null>(null);
    const [showTideAck, setShowTideAck] = useState(false);
    /** Scrubber position in QUARTER-HOURS AHEAD of now, 0 = live now
     *  (2026-07-11 #3: drag through the day, watch the banks flood and
     *  dry, park it on your ETA). RELATIVE, not an absolute instant — an
     *  absolute scrub drifted into the past and the thumb crept as time
     *  passed (review major). A ref mirrors it for async closures. */
    const [tideScrubQ, setTideScrubQ] = useState(0);
    const tideScrubRef = useRef(0);
    const tideCurveRef = useRef<TideCurveWindow | null>(null);
    const onToggleTideDepth = useCallback(() => {
        triggerHaptic('light');
        if (!tideDepthMode) {
            let acked = false;
            try {
                acked = !!localStorage.getItem(TIDE_DEPTH_ACK_KEY);
            } catch {
                /* storage unavailable — show the sheet every time, honest default */
            }
            if (!acked) {
                setShowTideAck(true);
                return;
            }
        }
        setTideDepthMode(!tideDepthMode);
    }, [tideDepthMode, setTideDepthMode]);
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady) return;
        if (!tideDepthMode) {
            setEncTideOffset(map, null);
            setTideOffsetInfo(null);
            setTideScrubQ(0);
            tideCurveRef.current = null;
            return;
        }
        let cancelled = false;
        let lastFix: { lat: number; lon: number } | null = null;
        const applyAtScrub = (): void => {
            const curve = tideCurveRef.current;
            const atMs = tideScrubRef.current > 0 ? Date.now() + tideScrubRef.current * 900_000 : null;
            const read = curve ? tideReadAt(curve, atMs ?? Date.now()) : null;
            setTideOffsetInfo(read);
            // Fail-safe: no curve / off the curve → chart datum, badge says
            // so. The scrub instant rides along so the tap-the-water popup
            // can never present a scrubbed tide as "right now".
            setEncTideOffset(map, read ? read.offsetM : null, atMs);
        };
        const refresh = async (): Promise<void> => {
            const c = map.getCenter();
            lastFix = { lat: c.lat, lon: c.lng };
            const curve = await readTideCurveWindow(c.lat, c.lng);
            if (cancelled) return;
            if (curve) {
                tideCurveRef.current = curve;
            } else {
                // Fetch failed — KEEP a still-valid curve for the same
                // waters (review major: a blip mid-scrub silently dropped
                // the chart to datum); drop it only when it's for
                // somewhere else or has expired.
                const old = tideCurveRef.current;
                const stillGood =
                    old &&
                    Math.abs(c.lat - old.fix.lat) <= 0.2 &&
                    Math.abs(c.lng - old.fix.lon) <= 0.2 &&
                    Date.now() < old.rangeMs[1];
                if (!stillGood) tideCurveRef.current = null;
            }
            applyAtScrub();
        };
        void refresh();
        // Tide moves ~1–2 cm/min at worst — 5 min keeps the live read
        // within a freeboard of truth without hammering the API (and
        // re-samples the curve at the scrub position either way).
        const iv = window.setInterval(() => void refresh(), 5 * 60_000);
        const onMoveEnd = (): void => {
            const c = map.getCenter();
            if (!lastFix) return;
            // ~0.2° ≈ 12–20 NM — far enough that a different station
            // governs; small pans keep the current read.
            if (Math.abs(c.lat - lastFix.lat) > 0.2 || Math.abs(c.lng - lastFix.lon) > 0.2) {
                void refresh();
            }
        };
        map.on('moveend', onMoveEnd);
        return () => {
            cancelled = true;
            window.clearInterval(iv);
            map.off('moveend', onMoveEnd);
            setEncTideOffset(map, null);
        };
    }, [mapRef, tideDepthMode, mapReady]);
    // Scrub moves re-sample the already-fetched curve — no network, no
    // rebuild. THROTTLED trailing-edge (2026-07-12 audit): the sounding
    // and contour-label text-fields are LAYOUT properties, so every
    // quarter-hour detent forced Mapbox to re-shape + re-collision-place
    // every visible label. Dragging dawn-to-dusk over a z13 sounding
    // field fired dozens of full symbol re-layouts; ~150 ms pacing keeps
    // the flooding-banks feel while the worker breathes. The final detent
    // always lands (trailing timer).
    const tideScrubAppliedAtRef = useRef(0);
    useEffect(() => {
        tideScrubRef.current = tideScrubQ;
        if (!tideDepthMode || !mapReady) return;
        const map = mapRef.current;
        if (!map) return;
        const apply = () => {
            tideScrubAppliedAtRef.current = Date.now();
            const curve = tideCurveRef.current;
            const atMs = scrubInstant(tideScrubRef.current);
            const read = curve ? tideReadAt(curve, atMs ?? Date.now()) : null;
            setTideOffsetInfo(read);
            setEncTideOffset(map, read ? read.offsetM : null, atMs);
        };
        const since = Date.now() - tideScrubAppliedAtRef.current;
        if (since >= 150) {
            apply();
            return;
        }
        const t = window.setTimeout(apply, 150 - since);
        return () => window.clearTimeout(t);
    }, [mapRef, tideScrubQ, tideDepthMode, mapReady]);

    return {
        tideDepthMode,
        setTideDepthMode,
        nightDim,
        setNightDim,
        tideOffsetInfo,
        showTideAck,
        setShowTideAck,
        tideScrubQ,
        setTideScrubQ,
        onToggleTideDepth,
    };
}
