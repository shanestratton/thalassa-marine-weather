/**
 * useLightningLayer — Real-time lightning overlay.
 *
 * Replaced Xweather raster tiles with the free Blitzortung WebSocket
 * feed on 2026-04-22. Why:
 *   - Xweather burned through its daily quota in a single dev session
 *     and was extraordinarily expensive at the next subscription tier.
 *   - Blitzortung is volunteer-detector-network data, free for our use,
 *     no quota, and has good Australian coverage (where most users are).
 *   - Real-time animated points > static 15-min raster aggregation.
 *
 * Visual: each strike appears as a bright cyan circle the moment it
 * arrives, then fades over 16 minutes through yellow → orange → faint
 * red, then disappears. Recent strikes (< 1 min old) get a brief pulse
 * animation so active storm cells visibly twinkle.
 *
 * Tactical overlay: additive, can coexist with base weather layers.
 */

import { useEffect, useRef } from 'react';
import mapboxgl from 'mapbox-gl';
import { createLogger } from '../../utils/createLogger';
import {
    subscribeLightningStrikes,
    setLightningViewportStats,
    type LightningStrike,
} from '../../services/weather/api/blitzortungLightning';

const log = createLogger('LightningLayer');

// ── Layer/Source IDs ──
//
// Visual recipe is a 4-layer stack designed to look like a meteorite
// impact, not a faint pixel:
//   1. SHOCKWAVE   (bottom)  — hollow ring that expands + fades in the
//                              first ~1.5s, the "boom" of a fresh hit
//   2. BLAST HALO            — large soft yellow-orange glow, full TTL
//   3. HIT CORE              — bright white-hot centre dot
//   4. BOLT       (top)      — ⚡ glyph that sits on the impact point
const LIGHTNING_SOURCE = 'lightning-blitz-source';
const LIGHTNING_LAYER_SHOCKWAVE = 'lightning-blitz-layer-shockwave';
const LIGHTNING_LAYER_HALO = 'lightning-blitz-layer-halo';
const LIGHTNING_LAYER_HIT = 'lightning-blitz-layer-hit';
const LIGHTNING_LAYER_BOLT = 'lightning-blitz-layer-bolt';

// How long the expanding shockwave ring takes to play out. Short
// enough to read as "BANG" not "shimmer", long enough to actually
// catch the eye on a 60Hz device.
const SHOCKWAVE_MS = 1500;

// How long a strike stays visible on the chart. User-tuned to 10 min
// (2026-04-25) — long enough that a passing thunderstorm leaves a visible
// trail of its track, short enough that the chart doesn't get cluttered
// with hour-old strikes that no longer represent active danger. The
// first 1-min "pulse" gives newly-arrived strikes a brief flicker so
// active cells visibly twinkle.
const STRIKE_TTL_MS = 10 * 60 * 1000;
const PULSE_MS = 60 * 1000;

// Trim the buffer at this size — defensive cap so a heavy storm doesn't
// chew unbounded memory if the user leaves the layer on for hours.
// Hard cap on the strike buffer. 2000 (was 5000) — at the typical
// 50-100 strikes/min rate during a Texas-grade storm and a 10-min
// TTL, natural steady-state is 500-1000. 5000 was overkill and just
// gave us extra memory pressure during long sessions in heavy
// lightning territory. 2000 keeps a 2× safety margin without the
// pressure that was triggering iOS WKWebView to force-close the
// WebSocket during peak activity.
const MAX_STRIKES = 2000;

// Strike data shape stored on each Mapbox feature.
interface StrikeFeatureProps {
    /** Unix ms when the strike happened (used for fade calculation). */
    t: number;
    /** Polarity for optional colour-by-polarity styling. */
    pol: 'positive' | 'negative' | 'unknown';
    /** Pre-computed alpha (0..1) — refreshed on the repaint loop. */
    alpha: number;
    /** 0..1 — how much the shockwave ring has expanded (1 = full radius).
     *  Drives the data-driven `circle-radius` expression on the
     *  shockwave layer so each strike's ring grows independently. */
    shockExpand: number;
    /** 0..1 — opacity for the shockwave ring (peaks early, fades fast). */
    shockAlpha: number;
}

export function useLightningLayer(
    mapRef: React.MutableRefObject<mapboxgl.Map | null>,
    mapReady: boolean,
    visible: boolean,
) {
    // Strike ring buffer kept in a ref so the repaint loop doesn't
    // trigger React re-renders.
    const strikesRef = useRef<Map<string, LightningStrike>>(new Map());
    const unsubRef = useRef<(() => void) | null>(null);
    const rafRef = useRef<number | null>(null);
    const isSetUp = useRef(false);

    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady) return;

        if (visible && !isSetUp.current) {
            try {
                // Empty GeoJSON source we'll mutate as strikes arrive.
                if (!map.getSource(LIGHTNING_SOURCE)) {
                    map.addSource(LIGHTNING_SOURCE, {
                        type: 'geojson',
                        data: { type: 'FeatureCollection', features: [] },
                        // Cluster=false intentional — even the densest storms only
                        // produce ~50 strikes/min globally we'd care about, and
                        // clustering hurts the "twinkle" feel of individual hits.
                        cluster: false,
                        attribution: '⚡ Lightning data: Blitzortung.org',
                    });
                }

                const styleLayers = map.getStyle()?.layers ?? [];
                const beforeId =
                    styleLayers.find((l) => l.type === 'symbol')?.id ??
                    (map.getLayer('route-line-layer') ? 'route-line-layer' : undefined);

                // 1. SHOCKWAVE — hollow ring that expands and fades in
                //    the first ~1.5s of each strike. This is the
                //    "meteorite hit" visual cue: a brief expanding ring
                //    that tells the eye SOMETHING JUST HAPPENED HERE.
                //    Stays invisible (opacity 0) for the rest of the
                //    strike's life so it doesn't clutter old strikes.
                if (!map.getLayer(LIGHTNING_LAYER_SHOCKWAVE)) {
                    map.addLayer(
                        {
                            id: LIGHTNING_LAYER_SHOCKWAVE,
                            type: 'circle',
                            source: LIGHTNING_SOURCE,
                            paint: {
                                // Base radius scales with zoom; per-strike
                                // expansion factor (0..1) multiplies it
                                // so each ring grows independently from
                                // the others on screen.
                                'circle-radius': [
                                    '*',
                                    ['interpolate', ['linear'], ['zoom'], 2, 18, 5, 28, 10, 48, 14, 72],
                                    ['+', 0.4, ['*', 0.6, ['get', 'shockExpand']]],
                                ],
                                'circle-color': 'rgba(0,0,0,0)',
                                'circle-stroke-color': '#fbbf24', // amber lightning glow
                                'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 2, 1.5, 10, 2.5, 14, 3.5],
                                'circle-stroke-opacity': ['get', 'shockAlpha'],
                            },
                        },
                        beforeId,
                    );
                }

                // 2. BLAST HALO — soft warm glow that persists through
                //    the whole TTL. Gives every strike spatial presence
                //    so a stationary chart still reads "thunderstorm
                //    here" between expansions. Polarity tints the glow
                //    subtly so a burst of -CG vs +CG looks distinct.
                if (!map.getLayer(LIGHTNING_LAYER_HALO)) {
                    map.addLayer(
                        {
                            id: LIGHTNING_LAYER_HALO,
                            type: 'circle',
                            source: LIGHTNING_SOURCE,
                            paint: {
                                'circle-radius': ['interpolate', ['linear'], ['zoom'], 2, 8, 5, 14, 10, 22, 14, 32],
                                'circle-color': [
                                    'match',
                                    ['get', 'pol'],
                                    'positive',
                                    '#fb923c', // warm orange for +CG
                                    'negative',
                                    '#fbbf24', // amber for -CG (most common)
                                    /* unknown */ '#facc15', // bright yellow
                                ],
                                'circle-blur': 0.65,
                                // Halo at ~40% of the strike's overall alpha — present
                                // but subordinate to the bright core.
                                'circle-opacity': ['*', 0.45, ['get', 'alpha']],
                            },
                        },
                        beforeId,
                    );
                }

                // 3. HIT CORE — bright white-hot centre. Bumped 3-4×
                //    from the previous radius (1.5–6px → 5–18px) so a
                //    single strike actually reads at hand-held viewing
                //    distance. White stroke turns the core into a
                //    visibly-glowing dot rather than a dark pixel.
                if (!map.getLayer(LIGHTNING_LAYER_HIT)) {
                    map.addLayer(
                        {
                            id: LIGHTNING_LAYER_HIT,
                            type: 'circle',
                            source: LIGHTNING_SOURCE,
                            paint: {
                                'circle-radius': ['interpolate', ['linear'], ['zoom'], 2, 5, 5, 8, 10, 12, 14, 18],
                                'circle-color': '#fef3c7', // pale yellow-white core
                                'circle-stroke-color': '#ffffff',
                                'circle-stroke-width': 1.5,
                                'circle-opacity': ['get', 'alpha'],
                                'circle-stroke-opacity': ['get', 'alpha'],
                            },
                        },
                        beforeId,
                    );
                }

                // 4. BOLT — white ⚡ glyph rendered via Mapbox's text-field.
                //    Using the unicode glyph means we don't need to ship a
                //    PNG/SVG icon image and register it with the map; iOS's
                //    built-in emoji fonts handle the rasterising. Bottom-
                //    anchored + a small upward offset so the base of the
                //    bolt visually touches the hit-spot dot. Bumped ~50%
                //    larger to match the new core/halo scale.
                if (!map.getLayer(LIGHTNING_LAYER_BOLT)) {
                    map.addLayer(
                        {
                            id: LIGHTNING_LAYER_BOLT,
                            type: 'symbol',
                            source: LIGHTNING_SOURCE,
                            layout: {
                                'text-field': '⚡',
                                'text-size': ['interpolate', ['linear'], ['zoom'], 2, 18, 5, 24, 10, 34, 14, 44],
                                'text-anchor': 'bottom',
                                'text-offset': [0, -0.1],
                                'text-allow-overlap': true,
                                'text-ignore-placement': true,
                                // Keep upright on rotated maps so a bolt
                                // doesn't look weird if user tilts/rotates.
                                'text-rotation-alignment': 'viewport',
                                'text-pitch-alignment': 'viewport',
                            },
                            paint: {
                                'text-color': '#ffffff',
                                'text-halo-color': 'rgba(0, 0, 0, 0.55)',
                                'text-halo-width': 1.5,
                                'text-opacity': ['get', 'alpha'],
                            },
                        },
                        beforeId,
                    );
                }

                // Subscribe to the WebSocket. New strikes go straight
                // into the buffer; the RAF loop pushes them onto the map.
                unsubRef.current = subscribeLightningStrikes((strike) => {
                    strikesRef.current.set(strike.id, strike);
                    // Trim oldest if over cap. Since the Map preserves
                    // insertion order and strikes arrive roughly in time
                    // order from Blitzortung, keys().next().value gives
                    // us the oldest entry in O(1) — no need to spread
                    // and sort 2000 items on every incoming strike like
                    // the previous implementation did. That sort was
                    // running 50-100×/sec during heavy storms and was
                    // a meaningful contributor to the WebView load that
                    // triggered the WebSocket disconnects.
                    if (strikesRef.current.size > MAX_STRIKES) {
                        const oldestKey = strikesRef.current.keys().next().value;
                        if (oldestKey !== undefined) strikesRef.current.delete(oldestKey);
                    }
                });

                // Repaint loop — recomputes alpha for each strike based on
                // age, prunes expired ones, and pushes the updated FeatureCollection
                // to the source. ~4Hz is plenty smooth for a fade animation
                // and keeps Mapbox's diff light.
                //
                // Also computes viewport-filtered strike count + rate every
                // second and pushes to the service so the BlitzortungAttribution
                // pill can show "12/min in view" — answers the user's question
                // "is the storm I'm watching intensifying?". The viewport
                // window for rate is the last 60s.
                const VIEWPORT_RATE_WINDOW_MS = 60 * 1000;
                // ADAPTIVE REPAINT CADENCE — was a fixed 16Hz (60ms) which
                // looked great for a single-strike shockwave but broke
                // down hard during a real storm (Texas/Mexico, hundreds
                // of strikes/min). At 16Hz × 2000 features × Mapbox
                // setData/tessellation, iOS WKWebView ran out of GPU
                // memory and force-closed the WebSocket (code 1005,
                // "markAllLayersVolatile: Failed" in the console).
                //
                // The cure: scale the repaint interval inversely with
                // buffer size. Quiet conditions still get the smooth
                // 16Hz shockwave; busy conditions degrade gracefully:
                //
                //   buffer    interval   effective rate
                //   <200      60ms       16.7Hz   (smooth shockwaves)
                //   200-800   120ms      8.3Hz    (still snappy)
                //   800-1500  200ms      5Hz      (fade still smooth)
                //   >1500     333ms      3Hz      (stays alive in chaos)
                //
                // Pulse animations still look fine at 3Hz because the
                // pulse phase is sampled per-strike based on age, not
                // synchronised with the repaint clock.
                const repaintIntervalMs = (count: number) =>
                    count < 200 ? 60 : count < 800 ? 120 : count < 1500 ? 200 : 333;
                let lastTick = 0;
                let lastViewportPush = 0;
                const tick = (now: number) => {
                    if (!rafRef.current) return;
                    const interval = repaintIntervalMs(strikesRef.current.size);
                    if (now - lastTick > interval) {
                        lastTick = now;
                        repaintStrikes(map, strikesRef.current);
                    }
                    // Viewport stats at 1Hz — much cheaper than every paint
                    // and already covers user panning at human speed.
                    if (now - lastViewportPush > 1000) {
                        lastViewportPush = now;
                        try {
                            const bounds = map.getBounds();
                            if (!bounds) return;
                            const wallNow = Date.now();
                            const recentCutoff = wallNow - VIEWPORT_RATE_WINDOW_MS;
                            let inView = 0;
                            let recentInView = 0;
                            // bounds may straddle the antimeridian; Mapbox handles
                            // the wraparound internally for contains() so we just
                            // ask it directly.
                            strikesRef.current.forEach((s) => {
                                if (bounds.contains([s.lon, s.lat])) {
                                    inView++;
                                    if (s.time >= recentCutoff) recentInView++;
                                }
                            });
                            setLightningViewportStats(recentInView, inView);
                        } catch {
                            /* getBounds can throw mid-style-load — best effort */
                        }
                    }
                    rafRef.current = requestAnimationFrame(tick);
                };
                rafRef.current = requestAnimationFrame(tick);

                isSetUp.current = true;
                // Use warn so this survives prod builds — without it,
                // "user toggled lightning and nothing happened" is
                // completely invisible in Xcode's device console.
                log.warn('Lightning layer added (Blitzortung WebSocket) — subscribing to strike feed');
            } catch (err) {
                log.warn('Failed to add lightning layer:', err);
            }
        }

        if (!visible && isSetUp.current) {
            // Teardown: stop animating, drop subscription, remove layers.
            if (rafRef.current !== null) {
                cancelAnimationFrame(rafRef.current);
                rafRef.current = null;
            }
            unsubRef.current?.();
            unsubRef.current = null;
            strikesRef.current.clear();
            try {
                if (map.getLayer(LIGHTNING_LAYER_BOLT)) map.removeLayer(LIGHTNING_LAYER_BOLT);
            } catch {
                /* already removed */
            }
            try {
                if (map.getLayer(LIGHTNING_LAYER_HIT)) map.removeLayer(LIGHTNING_LAYER_HIT);
            } catch {
                /* already removed */
            }
            try {
                if (map.getLayer(LIGHTNING_LAYER_HALO)) map.removeLayer(LIGHTNING_LAYER_HALO);
            } catch {
                /* already removed */
            }
            try {
                if (map.getLayer(LIGHTNING_LAYER_SHOCKWAVE)) map.removeLayer(LIGHTNING_LAYER_SHOCKWAVE);
            } catch {
                /* already removed */
            }
            try {
                if (map.getSource(LIGHTNING_SOURCE)) map.removeSource(LIGHTNING_SOURCE);
            } catch {
                /* already removed */
            }
            isSetUp.current = false;
            log.warn('Lightning layer removed — unsubscribed from strike feed');
        }

        return () => {
            // Only the toggle-driven cleanup runs the disconnect — this
            // unmount cleanup just nukes any residual RAF.
            if (rafRef.current !== null) {
                cancelAnimationFrame(rafRef.current);
                rafRef.current = null;
            }
        };
    }, [mapRef, mapReady, visible]);
}

/** Compute alpha for a strike given its age. Newer = brighter; the
 *  first 60s is held near full opacity to give a "pulse" appearance. */
function computeAlpha(ageMs: number): number {
    if (ageMs < 0) return 0;
    if (ageMs > STRIKE_TTL_MS) return 0;
    if (ageMs < PULSE_MS) {
        // Pulse: 0.85 → 1.0 → 0.95 in the first minute (small flicker).
        const phase = (ageMs / PULSE_MS) * Math.PI;
        return 0.85 + 0.15 * Math.abs(Math.sin(phase));
    }
    // After the pulse, linear fade from 0.85 → 0 over the remaining TTL.
    const remaining = (STRIKE_TTL_MS - ageMs) / (STRIKE_TTL_MS - PULSE_MS);
    return Math.max(0, 0.85 * remaining);
}

/** Compute the shockwave-ring expansion + alpha for a strike given its
 *  age. Plays for the first SHOCKWAVE_MS of a strike's life, then
 *  collapses to zero so old strikes don't carry rings. */
function computeShockwave(ageMs: number): { expand: number; alpha: number } {
    if (ageMs < 0 || ageMs > SHOCKWAVE_MS) return { expand: 0, alpha: 0 };
    const t = ageMs / SHOCKWAVE_MS; // 0..1
    // Ease-out expansion — fast at first, slower as it spreads. Final
    // factor reaches 1 at SHOCKWAVE_MS; the layer expression then
    // multiplies it with the zoom-scaled max radius.
    const expand = 1 - Math.pow(1 - t, 2);
    // Alpha peaks early (at ~15% in) then fades to zero. Gives the
    // ring a brief BANG of brightness before it dissipates outward.
    const alpha = t < 0.15 ? t / 0.15 : 1 - (t - 0.15) / 0.85;
    return { expand, alpha: Math.max(0, alpha) };
}

function repaintStrikes(map: mapboxgl.Map, strikes: Map<string, LightningStrike>): void {
    const now = Date.now();
    const expired: string[] = [];
    const features: GeoJSON.Feature<GeoJSON.Point, StrikeFeatureProps>[] = [];

    strikes.forEach((s) => {
        const age = now - s.time;
        if (age > STRIKE_TTL_MS) {
            expired.push(s.id);
            return;
        }
        const sw = computeShockwave(age);
        features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
            properties: {
                t: s.time,
                pol: s.polarity,
                alpha: computeAlpha(age),
                shockExpand: sw.expand,
                shockAlpha: sw.alpha,
            },
        });
    });

    expired.forEach((id) => strikes.delete(id));

    const src = map.getSource(LIGHTNING_SOURCE) as mapboxgl.GeoJSONSource | undefined;
    if (src) {
        src.setData({ type: 'FeatureCollection', features });
    }
}
