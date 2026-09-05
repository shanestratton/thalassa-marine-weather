/**
 * useVesselTracker — Live vessel position layer using BgGeoManager.
 *
 * Shows a rotatable vessel icon on the map that updates in real-time.
 * Includes heading indicator, SOG display, accuracy ring, and a fading
 * wake trail.
 *
 * Position goes through the ownship arbiter — the NMEA feed while it is
 * fresh, phone GPS as the fallback. This marker is literally labelled
 * "vessel" and yet it watched only the phone, which parked the arrow on
 * the skipper's HOUSE while the boat sat on her marina berth streaming
 * her real position the whole time (Shane, 2026-08-31: "the obs is STILL
 * showing my home"). When NMEA wins, the badge shows the boat's actual
 * SOG and the arrow her COG — not the phone jiggling in a pocket.
 */
import mapboxgl from 'mapbox-gl';
import { useEffect, useRef, useCallback, type MutableRefObject } from 'react';
import { BgGeoManager, type CachedPosition } from '../../services/BgGeoManager';
import { GpsService } from '../../services/GpsService';
import { NmeaGpsProvider } from '../../services/NmeaGpsProvider';
import { NmeaListenerService } from '../../services/NmeaListenerService';
import { NmeaStore } from '../../services/NmeaStore';
import { resolveOwnshipPosition } from '../../services/ownshipPosition';
import { LocationStore } from '../../stores/LocationStore';
import { GPS_STALE_LIMIT_MS, GPS_VERY_STALE_MS } from '../../services/shiplog/PositionResolver';
import { formatAge } from '../../services/GpsReceiverStatusService';
import { createLogger } from '../../utils/createLogger';
import { calculateDistance } from '../../utils/navigationCalculations';
import { convexHull, hullRing, type LonLat } from '../../utils/convexHull';
import { AnchorWatchService } from '../../services/AnchorWatchService';

const log = createLogger('VesselTracker');

// ── Trail config ──
const MAX_TRAIL_POINTS = 500; // Trim beyond this to keep memory in check
const MIN_TRAIL_DISTANCE_M = 5; // Don't add points closer than 5m (noise filter)

// ── Source/layer IDs ──
const TRAIL_SOURCE = 'vessel-trail';
const TRAIL_LAYER = 'vessel-trail-line';
const TRAIL_GLOW_LAYER = 'vessel-trail-glow';
const SWING_SOURCE = 'vessel-swing';
const SWING_FILL_LAYER = 'vessel-swing-fill';
const SWING_EDGE_LAYER = 'vessel-swing-edge';
const SWING_DOTS_SOURCE = 'vessel-swing-dots';
const SWING_DOTS_LAYER = 'vessel-swing-dots-circle';

/**
 * AT ANCHOR THE CONNECTED LINE IS THE WRONG PRIMITIVE.
 *
 * A stationary GNSS receiver wanders 5–15 m, and worse alongside a marina
 * where the fix bounces off the rigging and the neighbouring hulls. The trail
 * filter only skipped fixes closer than 5 m, so that wander sailed straight
 * through and was drawn as a path — a zigzag that reads like the boat
 * sprinting back and forth (Shane 2026-09-05, at z20.2 with a 0.003 nm scale
 * bar: "this happens a lot claude. i take it it GPS jump").
 *
 * It is a GPS jump, and it is not fixable at source — that part is physics and
 * receiver design. What we DRAW is our choice, so while the anchor watch is
 * armed the trail becomes a swing envelope: the hull of where the boat has
 * actually been, with every raw fix still drawn as a faint dot underneath.
 *
 * Smoothing was the other option and is worse here. It draws a prettier
 * wander, and it DELAYS the moment genuine movement becomes visible — the
 * wrong trade on the surface a skipper checks at 0300. The envelope hides
 * nothing: a real drag stretches it toward the alarm ring immediately.
 *
 * THE ALARM NEVER SEES ANY OF THIS. Drag detection stays on raw fixes with
 * anchorGpsWatchdog's 3-strike hysteresis. Smooth the drawing, never the alarm.
 */
const SWING_STATES: ReadonlySet<string> = new Set(['setting', 'watching', 'paused', 'alarm']);
const MAX_SWING_POINTS = 600;

/**
 * Build the vessel marker DOM element.
 * Directional arrow + accuracy ring + SOG badge.
 */
function createVesselElement(): HTMLDivElement {
    const el = document.createElement('div');
    el.className = 'vessel-tracker-marker';
    el.style.cssText = `
        width: 48px; height: 48px;
        position: relative;
        display: flex; align-items: center; justify-content: center;
        pointer-events: none;
    `;

    // Accuracy ring (outer pulse)
    const ring = document.createElement('div');
    ring.className = 'vessel-accuracy-ring';
    ring.style.cssText = `
        position: absolute; inset: -8px;
        border-radius: 50%;
        border: 2px solid rgba(56, 189, 248, 0.2);
        background: rgba(56, 189, 248, 0.06);
        animation: vesselPulse 3s ease-in-out infinite;
    `;
    el.appendChild(ring);

    // Vessel arrow (rotates with heading)
    const arrow = document.createElement('div');
    arrow.className = 'vessel-arrow';
    arrow.style.cssText = `
        width: 28px; height: 28px;
        position: relative; z-index: 2;
        transition: transform 0.5s ease-out;
    `;
    arrow.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M12 2L4 20L12 16L20 20L12 2Z" fill="url(#vesselGrad)" stroke="white" stroke-width="1.5" stroke-linejoin="round"/>
            <defs>
                <linearGradient id="vesselGrad" x1="12" y1="2" x2="12" y2="20" gradientUnits="userSpaceOnUse">
                    <stop offset="0" stop-color="#38bdf8"/>
                    <stop offset="1" stop-color="#0284c7"/>
                </linearGradient>
            </defs>
        </svg>
    `;
    el.appendChild(arrow);

    // SOG badge (bottom)
    const badge = document.createElement('div');
    badge.className = 'vessel-sog-badge';
    badge.style.cssText = `
        position: absolute; bottom: -20px; left: 50%;
        transform: translateX(-50%);
        background: rgba(15, 23, 42, 0.9);
        border: 1px solid rgba(56, 189, 248, 0.3);
        border-radius: 8px;
        padding: 1px 6px;
        font-size: 12px; font-weight: 800;
        color: #38bdf8;
        white-space: nowrap;
        letter-spacing: 0.05em;
        backdrop-filter: blur(8px);
        z-index: 3;
    `;
    badge.textContent = '0.0 kts';
    el.appendChild(badge);

    // GPS-age chip (top) — hidden while the fix is fresh. Surfaces the
    // audit's "own-ship marker freezes silently on GPS loss" finding:
    // a stale position must never be indistinguishable from a live one.
    const ageChip = document.createElement('div');
    ageChip.className = 'vessel-age-chip';
    ageChip.style.cssText = `
        position: absolute; top: -22px; left: 50%;
        transform: translateX(-50%);
        background: rgba(15, 23, 42, 0.9);
        border: 1px solid rgba(245, 158, 11, 0.5);
        border-radius: 8px;
        padding: 1px 6px;
        font-size: 12px; font-weight: 800;
        color: #f59e0b;
        white-space: nowrap;
        letter-spacing: 0.05em;
        backdrop-filter: blur(8px);
        z-index: 3;
        display: none;
    `;
    el.appendChild(ageChip);

    return el;
}

/**
 * Apply the GPS-age tier to the marker element. Styles are mutated
 * directly (the element is built with inline cssText, so CSS classes
 * would lose the specificity fight without !important).
 *
 *   locked (<60s): normal cyan, chip hidden
 *   stale (60s–5min): greyed arrow/ring, amber "GPS 2m" chip
 *   lost (>5min): greyed, red chip — position is history, not truth
 */
function applyGpsAgeTier(el: HTMLDivElement, ageMs: number): void {
    const tier = ageMs >= GPS_VERY_STALE_MS ? 'lost' : ageMs >= GPS_STALE_LIMIT_MS ? 'stale' : 'locked';
    const arrow = el.querySelector('.vessel-arrow') as HTMLElement | null;
    const ring = el.querySelector('.vessel-accuracy-ring') as HTMLElement | null;
    const chip = el.querySelector('.vessel-age-chip') as HTMLElement | null;
    if (!arrow || !ring || !chip) return;

    if (tier === 'locked') {
        arrow.style.filter = '';
        ring.style.borderColor = 'rgba(56, 189, 248, 0.2)';
        ring.style.background = 'rgba(56, 189, 248, 0.06)';
        chip.style.display = 'none';
        return;
    }

    arrow.style.filter = 'grayscale(1) brightness(0.85)';
    ring.style.borderColor = 'rgba(148, 163, 184, 0.3)';
    ring.style.background = 'rgba(148, 163, 184, 0.08)';
    chip.style.display = 'block';
    chip.textContent = `GPS ${formatAge(ageMs)}`;
    const colour = tier === 'lost' ? '#ef4444' : '#f59e0b';
    chip.style.color = colour;
    chip.style.borderColor = tier === 'lost' ? 'rgba(239, 68, 68, 0.6)' : 'rgba(245, 158, 11, 0.5)';
}

// ── Trail layer setup ──

function ensureTrailLayers(map: mapboxgl.Map) {
    if (map.getSource(TRAIL_SOURCE)) return;

    map.addSource(TRAIL_SOURCE, {
        type: 'geojson',
        lineMetrics: true,
        data: { type: 'FeatureCollection', features: [] },
    });

    // Glow layer (wide, soft, behind the main line)
    map.addLayer({
        id: TRAIL_GLOW_LAYER,
        type: 'line',
        source: TRAIL_SOURCE,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
            'line-color': '#38bdf8',
            'line-width': 8,
            'line-opacity': 0.15,
            'line-blur': 6,
        },
    });

    // Main trail line
    map.addLayer({
        id: TRAIL_LAYER,
        type: 'line',
        source: TRAIL_SOURCE,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
            'line-color': '#38bdf8',
            'line-width': 2.5,
            'line-opacity': 0.8,
            'line-gradient': [
                'interpolate',
                ['linear'],
                ['line-progress'],
                0,
                'rgba(56, 189, 248, 0.1)', // oldest — nearly transparent
                1,
                'rgba(56, 189, 248, 1)', // newest — fully opaque
            ],
        },
    });
}

function ensureSwingLayers(map: mapboxgl.Map) {
    if (map.getSource(SWING_SOURCE)) return;

    map.addSource(SWING_SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addSource(SWING_DOTS_SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });

    map.addLayer({
        id: SWING_FILL_LAYER,
        type: 'fill',
        source: SWING_SOURCE,
        paint: { 'fill-color': '#38bdf8', 'fill-opacity': 0.12 },
    });
    map.addLayer({
        id: SWING_EDGE_LAYER,
        type: 'line',
        source: SWING_SOURCE,
        layout: { 'line-join': 'round' },
        paint: { 'line-color': '#38bdf8', 'line-width': 1.5, 'line-opacity': 0.7 },
    });
    // The raw fixes stay visible. An envelope that replaced them would be a
    // claim about where the boat has been with the evidence painted out.
    map.addLayer({
        id: SWING_DOTS_LAYER,
        type: 'circle',
        source: SWING_DOTS_SOURCE,
        paint: {
            'circle-radius': 2,
            'circle-color': '#7dd3fc',
            'circle-opacity': 0.55,
        },
    });
}

function removeSwingLayers(map: mapboxgl.Map) {
    try {
        for (const id of [SWING_DOTS_LAYER, SWING_EDGE_LAYER, SWING_FILL_LAYER]) {
            if (map.getLayer(id)) map.removeLayer(id);
        }
        for (const id of [SWING_DOTS_SOURCE, SWING_SOURCE]) {
            if (map.getSource(id)) map.removeSource(id);
        }
    } catch {
        // The owning map may already have removed its style during teardown.
    }
}

function updateSwingData(map: mapboxgl.Map, points: LonLat[]) {
    const dots = map.getSource(SWING_DOTS_SOURCE) as mapboxgl.GeoJSONSource | undefined;
    if (dots) {
        dots.setData({
            type: 'FeatureCollection',
            features: points.map((p) => ({
                type: 'Feature',
                properties: {},
                geometry: { type: 'Point', coordinates: p },
            })),
        });
    }

    const src = map.getSource(SWING_SOURCE) as mapboxgl.GeoJSONSource | undefined;
    if (!src) return;
    const ring = hullRing(points);
    // Fewer than three distinct fixes has no area to shade — the dots above
    // are the whole truth at that point, and drawing nothing is honest.
    src.setData(
        ring
            ? {
                  type: 'FeatureCollection',
                  features: [
                      {
                          type: 'Feature',
                          properties: { vertices: convexHull(points).length },
                          geometry: { type: 'Polygon', coordinates: [ring] },
                      },
                  ],
              }
            : { type: 'FeatureCollection', features: [] },
    );
}

function removeTrailLayers(map: mapboxgl.Map) {
    try {
        if (map.getLayer(TRAIL_LAYER)) map.removeLayer(TRAIL_LAYER);
        if (map.getLayer(TRAIL_GLOW_LAYER)) map.removeLayer(TRAIL_GLOW_LAYER);
        if (map.getSource(TRAIL_SOURCE)) map.removeSource(TRAIL_SOURCE);
    } catch {
        // The owning map may already have removed its style during teardown.
    }
}

function updateTrailData(map: mapboxgl.Map, coords: [number, number][]) {
    const src = map.getSource(TRAIL_SOURCE) as mapboxgl.GeoJSONSource;
    if (!src || coords.length < 2) return;

    src.setData({
        type: 'FeatureCollection',
        features: [
            {
                type: 'Feature',
                properties: {},
                geometry: {
                    type: 'LineString',
                    coordinates: coords,
                },
            },
        ],
    });
}

// ── Hook ──

export function useVesselTracker(mapRef: MutableRefObject<mapboxgl.Map | null>, mapReady: boolean, visible: boolean) {
    const markerRef = useRef<mapboxgl.Marker | null>(null);
    const elementRef = useRef<HTMLDivElement | null>(null);
    const lastHeadingRef = useRef<number>(0);
    const trailCoordsRef = useRef<[number, number][]>([]);
    const swingPointsRef = useRef<LonLat[]>([]);
    // receivedAt of the newest fix — read by the staleness ticker. A ref,
    // not state: a frozen GPS means the watch callback stops firing
    // entirely, so staleness MUST come from an interval, not callbacks.
    const lastFixAtRef = useRef<number | null>(null);

    const updateMarker = useCallback(
        (pos: CachedPosition, viaVessel = false) => {
            const map = mapRef.current;
            if (!map || !visible) return;

            const { latitude, longitude, heading, speed } = pos;
            // BEFORE the trail-noise early-return below — a stationary
            // vessel still refreshes its fix age on every callback.
            //
            // The fix's OWN timestamp, forward-only (shiplog invariant, and
            // the same guard AnchorWatchService's watchdog applies): NOT
            // receivedAt, because GpsService replays the cached last
            // position on every (re)subscribe — a 30-min-old fix arriving
            // "now" must not reset the staleness clock and re-present a
            // stale position as live. Min() clamps device clock skew.
            lastFixAtRef.current = Math.max(lastFixAtRef.current ?? 0, Math.min(pos.timestamp, Date.now()));

            // ── Marker ──
            if (!markerRef.current) {
                const el = createVesselElement();
                elementRef.current = el;
                markerRef.current = new mapboxgl.Marker({
                    element: el,
                    anchor: 'center',
                    rotationAlignment: 'map',
                    pitchAlignment: 'map',
                })
                    .setLngLat([longitude, latitude])
                    .addTo(map);
                log.info('Vessel marker created');
            } else {
                markerRef.current.setLngLat([longitude, latitude]);
            }
            // A quiet tell for anyone debugging which truth the arrow is on.
            if (elementRef.current) elementRef.current.dataset.source = viaVessel ? 'vessel' : 'phone';

            // Heading
            const arrowEl = elementRef.current?.querySelector('.vessel-arrow') as HTMLElement;
            if (arrowEl) {
                const h = heading ?? lastHeadingRef.current;
                if (heading !== null) lastHeadingRef.current = heading;
                arrowEl.style.transform = `rotate(${h}deg)`;
            }

            // SOG badge
            const badgeEl = elementRef.current?.querySelector('.vessel-sog-badge') as HTMLElement;
            if (badgeEl) {
                const sogKts = (speed ?? 0) * 1.94384;
                badgeEl.textContent = sogKts < 0.3 ? 'Anchored' : `${sogKts.toFixed(1)} kts`;
                badgeEl.style.color = sogKts < 0.3 ? '#94a3b8' : '#38bdf8';
            }

            // ── Trail, or swing envelope at anchor ──
            const newPt: LonLat = [longitude, latitude];
            const anchored = SWING_STATES.has(AnchorWatchService.getSnapshot().state);

            if (anchored) {
                // See SWING_STATES above. No distance filter here on purpose:
                // the envelope is BUILT from the wander, so throwing away the
                // close fixes would shrink the very shape being measured.
                const swing = swingPointsRef.current;
                swing.push(newPt);
                if (swing.length > MAX_SWING_POINTS) swing.splice(0, swing.length - MAX_SWING_POINTS);
                ensureSwingLayers(map);
                updateSwingData(map, swing);

                // The under-way trail must not grow a chord across the swing
                // while she lies to her anchor, so it is frozen, not extended.
                return;
            }

            // Under way. The envelope belongs to the anchorage just left.
            if (swingPointsRef.current.length > 0) {
                swingPointsRef.current = [];
                removeSwingLayers(map);
            }

            const trail = trailCoordsRef.current;

            // Noise filter: skip if too close to last point
            if (trail.length > 0) {
                const last = trail[trail.length - 1];
                const dist = calculateDistance(last[1], last[0], latitude, longitude) * 1852; // NM → metres
                if (dist < MIN_TRAIL_DISTANCE_M) return;
            }

            trail.push(newPt);

            // Trim old points
            if (trail.length > MAX_TRAIL_POINTS) {
                trail.splice(0, trail.length - MAX_TRAIL_POINTS);
            }

            // Ensure trail source exists
            ensureTrailLayers(map);
            updateTrailData(map, trail);
        },
        [mapRef, visible],
    );

    useEffect(() => {
        if (!mapReady || !visible) {
            // Remove marker + trail when layer is toggled off
            if (markerRef.current) {
                markerRef.current.remove();
                markerRef.current = null;
                elementRef.current = null;
            }
            const map = mapRef.current;
            if (map) {
                removeTrailLayers(map);
                removeSwingLayers(map);
            }
            // Keep trail coords in memory so they reappear on re-toggle
            return;
        }
        const map = mapRef.current;

        // The NMEA store only ingests once something starts it. Boot claims
        // it when a gateway is saved, but this marker must not depend on that
        // ordering — same belt-and-braces as TheGlassPage and the location
        // dot. Idempotent, and the config gate means a phone that has never
        // met a gateway opens no sockets.
        if (NmeaListenerService.getSavedConfig()) NmeaStore.start();

        // Every paint goes through the ownship arbiter. The phone watch stays
        // as both the fallback position and a repaint tick; NMEA repaints
        // through its own subscription below.
        const paint = (phone?: {
            latitude: number;
            longitude: number;
            accuracy?: number | null;
            altitude?: number | null;
            heading?: number | null;
            speed?: number | null;
            timestamp?: number | null;
        }) => {
            const own = resolveOwnshipPosition(NmeaStore.getState(), LocationStore.getState());
            if (own && own.source === 'nmea') {
                updateMarker(
                    {
                        latitude: own.lat,
                        longitude: own.lon,
                        accuracy: 15,
                        altitude: null,
                        // COG of exactly 0 is also the arbiter's "unknown" —
                        // keep the last heading rather than snapping north.
                        heading: own.cog > 0 ? own.cog : null,
                        // The arbiter speaks knots; the marker eats m/s.
                        speed: own.sog / 1.94384,
                        timestamp: own.timestamp,
                        receivedAt: Date.now(),
                    },
                    true,
                );
                return;
            }
            if (!phone) return;
            updateMarker({
                latitude: phone.latitude,
                longitude: phone.longitude,
                accuracy: phone.accuracy ?? 50,
                altitude: phone.altitude ?? null,
                heading: phone.heading ?? null,
                speed: phone.speed ?? 0,
                timestamp: phone.timestamp ?? Date.now(),
                receivedAt: Date.now(),
            });
        };

        // Passive foreground watch: it consumes an existing Location grant
        // but never initializes background tracking or raises permission UI
        // merely because the chart was restored at launch.
        const unsub = GpsService.watchPosition((pos) => paint(pos));
        const unsubNmea = NmeaGpsProvider.onPosition(() => paint());
        paint();

        // Staleness ticker — the only path that can grey the marker once
        // fixes STOP arriving (see lastFixAtRef comment).
        const staleTicker = window.setInterval(() => {
            const el = elementRef.current;
            const last = lastFixAtRef.current;
            if (!el || last == null) return;
            applyGpsAgeTier(el, Date.now() - last);
        }, 1000);

        return () => {
            window.clearInterval(staleTicker);
            unsub?.();
            unsubNmea();
            if (markerRef.current) {
                markerRef.current.remove();
                markerRef.current = null;
                elementRef.current = null;
            }
            if (map) {
                removeTrailLayers(map);
                removeSwingLayers(map);
            }
        };
    }, [mapReady, visible, updateMarker, mapRef]);

    // Fly-to-vessel
    const flyToVessel = useCallback(() => {
        const map = mapRef.current;
        if (!map) return;

        // The boat's own answer first — flying "to the vessel" must not mean
        // flying to the phone while the NMEA feed is live.
        const own = resolveOwnshipPosition(NmeaStore.getState(), LocationStore.getState());
        if (own && own.source === 'nmea') {
            map.flyTo({
                center: [own.lon, own.lat],
                zoom: 14,
                duration: 1200,
                essential: true,
            });
            return;
        }

        const pos = BgGeoManager.getLastPosition();
        if (pos) {
            map.flyTo({
                center: [pos.longitude, pos.latitude],
                zoom: 14,
                duration: 1200,
                essential: true,
            });
        } else {
            GpsService.requestCurrentForegroundPosition({ staleLimitMs: 30_000, timeoutSec: 10 }).then((p) => {
                if (p) {
                    map.flyTo({
                        center: [p.longitude, p.latitude],
                        zoom: 14,
                        duration: 1200,
                        essential: true,
                    });
                }
            });
        }
    }, [mapRef]);

    // Clear the trail history
    const clearTrail = useCallback(() => {
        trailCoordsRef.current = [];
        swingPointsRef.current = [];
        const map = mapRef.current;
        if (map) {
            const src = map.getSource(TRAIL_SOURCE) as mapboxgl.GeoJSONSource;
            if (src) src.setData({ type: 'FeatureCollection', features: [] });
            removeSwingLayers(map);
        }
    }, [mapRef]);

    return { flyToVessel, clearTrail };
}
