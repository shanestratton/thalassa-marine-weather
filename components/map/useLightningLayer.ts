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
import { subscribeLightningStrikes, type LightningStrike } from '../../services/weather/api/blitzortungLightning';

const log = createLogger('LightningLayer');

// ── Layer/Source IDs ──
const LIGHTNING_SOURCE = 'lightning-blitz-source';
const LIGHTNING_LAYER_GLOW = 'lightning-blitz-layer-glow';
const LIGHTNING_LAYER_CORE = 'lightning-blitz-layer-core';

// How long a strike stays visible. Matches the visual convention from
// most weather apps — 15-min decay window with a 1-min "pulse" at start.
const STRIKE_TTL_MS = 16 * 60 * 1000;
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

                // Outer glow — wider, soft, fades faster. Gives the
                // "halo" around each strike that makes them visible
                // against busy satellite imagery.
                if (!map.getLayer(LIGHTNING_LAYER_GLOW)) {
                    map.addLayer(
                        {
                            id: LIGHTNING_LAYER_GLOW,
                            type: 'circle',
                            source: LIGHTNING_SOURCE,
                            paint: {
                                // Radius grows with zoom — visible at z=2 and z=14.
                                'circle-radius': ['interpolate', ['linear'], ['zoom'], 2, 6, 5, 10, 10, 18, 14, 28],
                                'circle-color': [
                                    'match',
                                    ['get', 'pol'],
                                    'positive',
                                    '#fbbf24', // amber for +CG
                                    'negative',
                                    '#22d3ee', // cyan for -CG (most strikes)
                                    /* unknown */ '#a78bfa', // violet
                                ],
                                'circle-blur': 1.0,
                                'circle-opacity': ['get', 'alpha'],
                            },
                        },
                        beforeId,
                    );
                }

                // Inner core — bright sharp dot at the strike point.
                if (!map.getLayer(LIGHTNING_LAYER_CORE)) {
                    map.addLayer(
                        {
                            id: LIGHTNING_LAYER_CORE,
                            type: 'circle',
                            source: LIGHTNING_SOURCE,
                            paint: {
                                'circle-radius': ['interpolate', ['linear'], ['zoom'], 2, 1.5, 5, 2.5, 10, 4, 14, 6],
                                'circle-color': '#ffffff',
                                'circle-stroke-color': [
                                    'match',
                                    ['get', 'pol'],
                                    'positive',
                                    '#fcd34d',
                                    'negative',
                                    '#67e8f9',
                                    /* unknown */ '#c4b5fd',
                                ],
                                'circle-stroke-width': 1,
                                'circle-opacity': ['get', 'alpha'],
                                'circle-stroke-opacity': ['get', 'alpha'],
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
                let lastTick = 0;
                const tick = (now: number) => {
                    if (!rafRef.current) return;
                    if (now - lastTick > 250) {
                        lastTick = now;
                        repaintStrikes(map, strikesRef.current);
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
                if (map.getLayer(LIGHTNING_LAYER_CORE)) map.removeLayer(LIGHTNING_LAYER_CORE);
            } catch {
                /* already removed */
            }
            try {
                if (map.getLayer(LIGHTNING_LAYER_GLOW)) map.removeLayer(LIGHTNING_LAYER_GLOW);
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
