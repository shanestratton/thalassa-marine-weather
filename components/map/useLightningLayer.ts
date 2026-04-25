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
const LIGHTNING_SOURCE = 'lightning-blitz-source';
// Hit-spot — small dark dot at the lat/lon where the lightning grounded.
// Lives UNDER the bolt symbol so the bolt visually "lands" on the dot.
const LIGHTNING_LAYER_HIT = 'lightning-blitz-layer-hit';
// Bolt — white ⚡ glyph rendered as a Mapbox text-symbol. Bottom-anchored
// so the base of the bolt sits at the hit-spot.
const LIGHTNING_LAYER_BOLT = 'lightning-blitz-layer-bolt';

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
const MAX_STRIKES = 5000;

// Strike data shape stored on each Mapbox feature.
interface StrikeFeatureProps {
    /** Unix ms when the strike happened (used for fade calculation). */
    t: number;
    /** Polarity for optional colour-by-polarity styling. */
    pol: 'positive' | 'negative' | 'unknown';
    /** Pre-computed alpha (0..1) — refreshed on the repaint loop. */
    alpha: number;
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

                // Hit-spot — small dark dot at the lat/lon where the
                // lightning grounded. Sits UNDER the bolt so the bolt
                // appears to land on it. Polarity tints (subtle) so a
                // burst of -CG strikes looks tonally distinct from a
                // burst of +CG strikes.
                if (!map.getLayer(LIGHTNING_LAYER_HIT)) {
                    map.addLayer(
                        {
                            id: LIGHTNING_LAYER_HIT,
                            type: 'circle',
                            source: LIGHTNING_SOURCE,
                            paint: {
                                'circle-radius': ['interpolate', ['linear'], ['zoom'], 2, 1.5, 5, 2.5, 10, 4, 14, 6],
                                'circle-color': [
                                    'match',
                                    ['get', 'pol'],
                                    'positive',
                                    '#7c2d12', // deep amber-brown for +CG
                                    'negative',
                                    '#0c4a6e', // deep navy for -CG (most strikes)
                                    /* unknown */ '#312e81', // deep indigo
                                ],
                                'circle-stroke-color': '#ffffff',
                                'circle-stroke-width': 0.5,
                                'circle-opacity': ['get', 'alpha'],
                                'circle-stroke-opacity': ['get', 'alpha'],
                            },
                        },
                        beforeId,
                    );
                }

                // Bolt — white ⚡ glyph rendered via Mapbox's text-field.
                // Using the unicode glyph means we don't need to ship a
                // PNG/SVG icon image and register it with the map; iOS's
                // built-in emoji fonts handle the rasterising. Bottom-
                // anchored + a small upward offset so the base of the
                // bolt visually touches the hit-spot dot.
                if (!map.getLayer(LIGHTNING_LAYER_BOLT)) {
                    map.addLayer(
                        {
                            id: LIGHTNING_LAYER_BOLT,
                            type: 'symbol',
                            source: LIGHTNING_SOURCE,
                            layout: {
                                'text-field': '⚡',
                                // Size grows with zoom so a strike is visible
                                // at world-view but not absurd at z14.
                                'text-size': ['interpolate', ['linear'], ['zoom'], 2, 12, 5, 16, 10, 22, 14, 28],
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
                                'text-halo-width': 1.2,
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
                    // Trim oldest if over cap.
                    if (strikesRef.current.size > MAX_STRIKES) {
                        const oldest = [...strikesRef.current.values()].sort((a, b) => a.time - b.time)[0];
                        if (oldest) strikesRef.current.delete(oldest.id);
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
                let lastTick = 0;
                let lastViewportPush = 0;
                const tick = (now: number) => {
                    if (!rafRef.current) return;
                    if (now - lastTick > 250) {
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
        features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
            properties: {
                t: s.time,
                pol: s.polarity,
                alpha: computeAlpha(age),
            },
        });
    });

    expired.forEach((id) => strikes.delete(id));

    const src = map.getSource(LIGHTNING_SOURCE) as mapboxgl.GeoJSONSource | undefined;
    if (src) {
        src.setData({ type: 'FeatureCollection', features });
    }
}
