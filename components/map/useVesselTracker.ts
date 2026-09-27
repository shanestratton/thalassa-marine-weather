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
 * SOG and the arrow her fresh true heading, or COG only while moving.
 * Without a reliable direction, a neutral dot never invents a bow bearing.
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
import { GPS_VERY_STALE_MS } from '../../services/shiplog/PositionResolver';
import {
    boatLiveFixMaxAgeMs,
    gpsFixState,
    ownshipFixLabel,
    PHONE_LIVE_FIX_MAX_AGE_MS,
    type GpsFixState,
} from '../gpsFixState';
import { createLogger } from '../../utils/createLogger';
import { calculateDistance } from '../../utils/navigationCalculations';
import { convexHull, hullRing, type LonLat } from '../../utils/convexHull';
import { AnchorWatchService } from '../../services/AnchorWatchService';
import { AnchorWatchSyncService } from '../../services/AnchorWatchSyncService';
import { ShoreWatchAlarmService } from '../../services/ShoreWatchAlarmService';
import { ownshipStatusLabel } from './ownshipStatus';
import { resolveOwnshipDirection } from './ownshipDirection';

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
type TrackerPosition = Omit<CachedPosition, 'speed'> & { speed: number | null };

// ── Marker furniture ──
/** Dot (~16 px with its white edge) plus a 4 px glow each side. */
const GLOW_DIAMETER_PX = 24;
const GLOW_BORDER_LIVE = 'rgba(56, 189, 248, 0.35)';
const GLOW_FILL_LIVE = 'rgba(56, 189, 248, 0.22)';
/** Badge's left edge from the fix: glow radius (12) + 6 px air. */
const BADGE_OFFSET_PX = 18;
/** Theme text classes: .display-light darkens each for a light chip. */
const STATUS_TONE_CLASS = {
    live: 'text-sky-400',
    anchored: 'text-emerald-400',
    alarm: 'text-red-500',
    /** 'Last fix 46 s': amber, then red once the position is history (5 min). */
    stale: 'text-amber-400',
    lost: 'text-red-500',
} as const;

/**
 * Build the vessel marker DOM element.
 * Directional arrow + accuracy ring + SOG badge.
 */
export function createVesselElement(): HTMLDivElement {
    const el = document.createElement('div');
    el.className = 'vessel-tracker-marker';
    // Mapbox owns position/transform on this root. Relative positioning puts
    // it in normal flow behind other markers: a fixed pixel displacement then
    // looks like hundreds of metres of GPS drift when zooming out.
    el.style.cssText = `
        width: 48px; height: 48px;
        display: flex; align-items: center; justify-content: center;
        pointer-events: none;
    `;

    // Glow: a still 4 px halo just past the dot. It was a 64 px pulsing ring,
    // which copies the platform's accuracy circle without being sized from
    // the fix (UX scorecard run 6). The class name stays for the stale-tier
    // greying below.
    const ring = document.createElement('div');
    ring.className = 'vessel-accuracy-ring';
    ring.style.cssText = `
        position: absolute; left: 50%; top: 50%;
        width: ${GLOW_DIAMETER_PX}px; height: ${GLOW_DIAMETER_PX}px;
        margin: -${GLOW_DIAMETER_PX / 2}px 0 0 -${GLOW_DIAMETER_PX / 2}px;
        border-radius: 50%;
        border: 2px solid ${GLOW_BORDER_LIVE};
        background: ${GLOW_FILL_LIVE};
    `;
    el.appendChild(ring);

    // Vessel arrow (rotates with heading). No CSS angle tween: 359° → 1°
    // would otherwise sweep through the wrong 358° around the compass.
    const arrow = document.createElement('div');
    arrow.className = 'vessel-arrow';
    arrow.style.cssText = `
        width: 28px; height: 28px;
        position: relative; z-index: 2;
    `;
    arrow.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path class="vessel-directional-shape" style="display:none" d="M12 2L4 20L12 16L20 20L12 2Z" fill="url(#vesselGrad)" stroke="white" stroke-width="1.5" stroke-linejoin="round"/>
            <circle class="vessel-neutral-shape" cx="12" cy="12" r="6" fill="url(#vesselGrad)" stroke="white" stroke-width="1.5"/>
            <defs>
                <linearGradient id="vesselGrad" x1="12" y1="2" x2="12" y2="20" gradientUnits="userSpaceOnUse">
                    <stop offset="0" stop-color="#38bdf8"/>
                    <stop offset="1" stop-color="#0284c7"/>
                </linearGradient>
            </defs>
        </svg>
    `;
    el.appendChild(arrow);

    // Status badge BESIDE the dot, vertically centred on the fix. Parked
    // 54 px below it, nothing tied the two together and it read as the
    // caption of whatever basemap place label sat under the boat ("Stopped"
    // under "Brisbane"; "Stopped ne" in landscape), and it had to dodge the
    // AIS name row there too. Here it starts 6 px past the glow, clear of the
    // bow arrow at any heading (UX scorecard run 6). Colours come from theme
    // classes so daylight remaps them like every other chart chip. Only the
    // badge moves; Mapbox must retain the root's exact GPS anchor.
    const badge = document.createElement('div');
    // Hidden while the layer menu's tiles are up: they cover the dot, and the
    // badge's tail stuck out beside them as a stray "topped" (UX scorecard run 7).
    badge.className = `vessel-sog-badge rounded-lg border border-sky-400/30 bg-slate-900/94 ${STATUS_TONE_CLASS.live}`;
    badge.style.cssText = `
        position: absolute; top: 50%; left: calc(50% + ${BADGE_OFFSET_PX}px);
        transform: translateY(-50%);
        padding: 2px 8px;
        font-size: 12px; font-weight: 800;
        line-height: 1.25;
        white-space: nowrap;
        letter-spacing: 0.05em;
        z-index: 3;
    `;
    badge.textContent = '0.0 kts';
    el.appendChild(badge);

    // GPS-age chip (top) — hidden while the fix is live, and while the badge
    // itself says 'Last fix …'. It carries the fix age only when an anchor
    // label holds the badge. Surfaces the audit's "own-ship marker freezes
    // silently on GPS loss" finding: a stale position must never be
    // indistinguishable from a live one.
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

type GpsAgeTier = 'locked' | 'stale' | 'lost';

/**
 * The marker's tier from its one fix state — the same state the badge's
 * words come from, so the dot and the label cannot disagree (UX referee run
 * 8, gps-one-truth: a live-looking 'Stopped' off a 46 s old fix).
 *
 *   locked (live):          normal cyan
 *   stale (past the gate):  greyed arrow/ring, amber 'Last fix 46 s'
 *   lost (>5min):           greyed, red — position is history, not truth
 */
function gpsAgeTier(fix: GpsFixState): GpsAgeTier {
    if (fix.kind === 'live') return 'locked';
    return fix.kind === 'none' || fix.ageMs >= GPS_VERY_STALE_MS ? 'lost' : 'stale';
}

/**
 * Apply the GPS-age tier to the marker element. Styles are mutated
 * directly (the element is built with inline cssText, so CSS classes
 * would lose the specificity fight without !important). `chipText` is the
 * fix age for the top chip, given only when the badge is busy with an anchor
 * label — otherwise the badge already says it, once.
 */
function applyGpsAgeTier(el: HTMLDivElement, tier: GpsAgeTier, chipText: string | null): void {
    const arrow = el.querySelector('.vessel-arrow') as HTMLElement | null;
    const ring = el.querySelector('.vessel-accuracy-ring') as HTMLElement | null;
    const chip = el.querySelector('.vessel-age-chip') as HTMLElement | null;
    if (!arrow || !ring || !chip) return;

    if (tier === 'locked') {
        arrow.style.filter = '';
        ring.style.borderColor = GLOW_BORDER_LIVE;
        ring.style.background = GLOW_FILL_LIVE;
        chip.style.display = 'none';
        return;
    }

    arrow.style.filter = 'grayscale(1) brightness(0.85)';
    ring.style.borderColor = 'rgba(148, 163, 184, 0.3)';
    ring.style.background = 'rgba(148, 163, 184, 0.08)';
    if (!chipText) {
        chip.style.display = 'none';
        return;
    }
    chip.style.display = 'block';
    chip.textContent = chipText;
    const colour = tier === 'lost' ? '#ef4444' : '#f59e0b';
    chip.style.color = colour;
    chip.style.borderColor = tier === 'lost' ? 'rgba(239, 68, 68, 0.6)' : 'rgba(245, 158, 11, 0.5)';
}

// ── Own-ship footprint: a label-collision obstacle ──
//
// The marker is a DOM element, and Mapbox's label placement cannot see DOM,
// so at a marina the town's place label was drawn straight through the dot
// and its chip: "Gla◯to Stopped" (UX scorecard run 8). An invisible symbol at
// the fix, sized to the dot plus the chip beside it, is placed first (it sits
// above the basemap's label layers) and takes that box in the collision
// index, so a place label that would run under the boat is dropped or moved
// instead. Nothing is drawn: the image is fully transparent.
const OBSTACLE_SOURCE = 'vessel-ownship-obstacle';
const OBSTACLE_LAYER = 'vessel-ownship-obstacle-symbol';
const OBSTACLE_IMAGE = 'vessel-ownship-obstacle';
/** From the glow's left edge to the end of a typical chip ('Last fix 46 s'). */
const OBSTACLE_LEFT_PX = GLOW_DIAMETER_PX / 2 + 2;
const OBSTACLE_WIDTH_PX = OBSTACLE_LEFT_PX + BADGE_OFFSET_PX + 112;
const OBSTACLE_HEIGHT_PX = 28;

export function syncOwnshipObstacle(map: mapboxgl.Map, lngLat: [number, number] | null, onlyIfMissing = false): void {
    try {
        // A map (or a test double) without an image registry has no symbol
        // placement to protect.
        if (typeof map.addImage !== 'function' || typeof map.hasImage !== 'function') return;
        if (!lngLat) {
            if (map.getLayer(OBSTACLE_LAYER)) map.removeLayer(OBSTACLE_LAYER);
            if (map.getSource(OBSTACLE_SOURCE)) map.removeSource(OBSTACLE_SOURCE);
            return;
        }
        if (!map.hasImage(OBSTACLE_IMAGE)) {
            map.addImage(OBSTACLE_IMAGE, {
                width: OBSTACLE_WIDTH_PX,
                height: OBSTACLE_HEIGHT_PX,
                data: new Uint8Array(OBSTACLE_WIDTH_PX * OBSTACLE_HEIGHT_PX * 4),
            });
        }
        const data: GeoJSON.FeatureCollection = {
            type: 'FeatureCollection',
            features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: lngLat } }],
        };
        const source = map.getSource(OBSTACLE_SOURCE) as mapboxgl.GeoJSONSource | undefined;
        if (source && onlyIfMissing && map.getLayer(OBSTACLE_LAYER)) return;
        if (source) source.setData(data);
        else map.addSource(OBSTACLE_SOURCE, { type: 'geojson', data });
        if (!map.getLayer(OBSTACLE_LAYER)) {
            map.addLayer({
                id: OBSTACLE_LAYER,
                type: 'symbol',
                source: OBSTACLE_SOURCE,
                layout: {
                    'icon-image': OBSTACLE_IMAGE,
                    // The chip sits to the right of the dot, so the box does
                    // too: its left edge just past the glow, left of the fix.
                    'icon-anchor': 'left',
                    'icon-offset': [-OBSTACLE_LEFT_PX, 0],
                    // Always placed, and always in the collision index.
                    'icon-allow-overlap': true,
                    'icon-ignore-placement': false,
                    // The marker turns and tilts with the map; so does its box.
                    'icon-rotation-alignment': 'map',
                    'icon-pitch-alignment': 'map',
                },
            });
            raiseOwnshipObstacle(map);
        }
    } catch {
        // Mid style swap: the next fix, or the staleness tick, puts it back.
    }
}

/** The base style's own labels (Mapbox `composite`, MapTiler `openmaptiles`). */
function isBasemapSymbolLayer(layer: { type?: string; source?: unknown }): boolean {
    return layer.type === 'symbol' && (layer.source === 'composite' || layer.source === 'openmaptiles');
}

/**
 * Keep the obstacle directly above the base style's highest label layer.
 *
 * Mapbox places symbols top layer first, so the obstacle only takes its box
 * before a label that sits BELOW it. MapHub lifts the base style's town names
 * over the satellite imagery, to the very top of the stack when no ENC cells
 * are loaded, which put 'Gladstone' above the obstacle: placed first, drawn
 * straight through the dot and its chip ("Gla◯to Stopped", UX scorecard run 9,
 * still there after run 8's obstacle). App layers above it (AIS names, route
 * and waypoint labels) keep their priority; only the base style's labels step
 * aside. Conditional, like MapHub's own ordering pass: it moves nothing when
 * no base label is above the obstacle, so it cannot feed a styledata loop.
 */
export function raiseOwnshipObstacle(map: mapboxgl.Map): void {
    try {
        if (typeof map.getStyle !== 'function' || typeof map.moveLayer !== 'function') return;
        if (!map.getLayer(OBSTACLE_LAYER)) return;
        const layers = map.getStyle()?.layers ?? [];
        const own = layers.findIndex((layer) => layer.id === OBSTACLE_LAYER);
        let topLabel = -1;
        layers.forEach((layer, index) => {
            if (isBasemapSymbolLayer(layer as { type?: string; source?: unknown })) topLabel = index;
        });
        if (own < 0 || topLabel < own) return;
        // Just above that label; undefined (the top) when it is the last layer.
        map.moveLayer(OBSTACLE_LAYER, layers[topLabel + 1]?.id);
    } catch {
        // Mid style swap: the next styledata pass tries again.
    }
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
    const trailCoordsRef = useRef<[number, number][]>([]);
    const swingPointsRef = useRef<LonLat[]>([]);
    /** Which receiver painted last — the trail and the swing belong to ONE receiver. */
    const lastSourceRef = useRef<'vessel' | 'phone' | null>(null);
    /** True once the boat's own receivers have painted in this session. */
    const vesselSpokeRef = useRef(false);
    // The newest fix time of EACH receiver — read by the staleness ticker. A
    // ref, not state: a frozen GPS means the watch callback stops firing
    // entirely, so staleness MUST come from an interval, not callbacks. One
    // clock per receiver: when the boat goes quiet and the phone replays an
    // older cached fix, the marker moves to the phone's position and must be
    // dated by the phone's fix, never by the boat's newer one (a 20-min-old
    // phone position must not borrow the boat's 'Stopped').
    const lastFixAtRef = useRef<Record<'vessel' | 'phone', number | null>>({ vessel: null, phone: null });
    const lastMarkerPositionRef = useRef<{ position: TrackerPosition; viaVessel: boolean } | null>(null);

    const updateDirection = useCallback(() => {
        const last = lastMarkerPositionRef.current;
        const el = elementRef.current;
        const arrow = el?.querySelector('.vessel-arrow') as HTMLElement | null;
        if (!last || !el || !arrow) return;
        const direction = resolveOwnshipDirection(last.position, last.viaVessel, NmeaStore.getState());
        el.dataset.directionSource = direction.source;
        const label =
            direction.source === 'heading'
                ? `Bow heading ${Math.round(direction.degrees)}° true`
                : direction.source === 'course'
                  ? `Course over ground ${Math.round(direction.degrees)}° true; bow heading unavailable`
                  : 'Position; heading unavailable';
        el.setAttribute('role', 'img');
        el.setAttribute('aria-label', label);
        el.title = label;
        arrow.style.transform = `rotate(${direction.degrees ?? 0}deg)`;
        const shape = arrow.querySelector('.vessel-directional-shape') as SVGElement;
        const dot = arrow.querySelector('.vessel-neutral-shape') as SVGElement;
        shape.style.display = direction.degrees === null ? 'none' : '';
        dot.style.display = direction.degrees === null ? '' : 'none';
    }, []);

    // The badge's words, its colour and the marker's grey all come from ONE
    // fix state: lastFixAtRef through the receiver's live gate — the gates the
    // System status box uses (components/gpsFixState.ts). A fix past its gate
    // is 'Last fix 46 s' on a grey marker, never a live-looking 'Stopped'.
    const updateStatusBadge = useCallback(() => {
        const last = lastMarkerPositionRef.current;
        const el = elementRef.current;
        const badge = el?.querySelector('.vessel-sog-badge') as HTMLElement | null;
        if (!last || !el || !badge) return;
        const now = Date.now();
        const fix = gpsFixState(
            lastFixAtRef.current[last.viaVessel ? 'vessel' : 'phone'],
            last.viaVessel ? boatLiveFixMaxAgeMs(NmeaStore.getState()) : PHONE_LIVE_FIX_MAX_AGE_MS,
            now,
        );
        const label = ownshipStatusLabel(
            last.position,
            last.viaVessel,
            AnchorWatchService.getSnapshot(),
            AnchorWatchSyncService.getState(),
            ShoreWatchAlarmService.getSnapshot(),
            now,
            fix,
        );
        badge.textContent = label;
        const tier = gpsAgeTier(fix);
        const anchorLabel = label === 'Anchor alarm' || label === 'Anchored';
        const tone =
            label === 'Anchor alarm' ? 'alarm' : label === 'Anchored' ? 'anchored' : tier === 'locked' ? 'live' : tier;
        badge.classList.remove(...Object.values(STATUS_TONE_CLASS));
        badge.classList.add(STATUS_TONE_CLASS[tone]);
        applyGpsAgeTier(el, tier, anchorLabel ? ownshipFixLabel(fix) : null);
    }, []);

    const updateMarker = useCallback(
        (pos: TrackerPosition, viaVessel = false, fixAt: number | null = pos.timestamp) => {
            const map = mapRef.current;
            if (!map || !visible) return;

            const { latitude, longitude } = pos;
            // BEFORE the trail-noise early-return below — a stationary
            // vessel still refreshes its fix age on every callback.
            //
            // The fix's OWN timestamp, forward-only (shiplog invariant, and
            // the same guard AnchorWatchService's watchdog applies): NOT
            // receivedAt, because GpsService replays the cached last
            // position on every (re)subscribe — a 30-min-old fix arriving
            // "now" must not reset the staleness clock and re-present a
            // stale position as live. Min() clamps device clock skew. Per
            // receiver (see lastFixAtRef), and an undated fix (null, or a NaN
            // that would poison Math.max for the rest of the session) leaves
            // the clock alone: the badge then keeps counting from the last
            // fix that WAS dated, or says 'No fix'.
            const clock = viaVessel ? 'vessel' : 'phone';
            if (fixAt !== null && Number.isFinite(fixAt) && fixAt > 0) {
                lastFixAtRef.current[clock] = Math.max(lastFixAtRef.current[clock] ?? 0, Math.min(fixAt, Date.now()));
            }

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
            // The footprint moves with the marker, so place labels step aside.
            syncOwnshipObstacle(map, [longitude, latitude]);
            // A quiet tell for anyone debugging which truth the arrow is on.
            if (elementRef.current) elementRef.current.dataset.source = viaVessel ? 'vessel' : 'phone';

            // Anchor state is explicit, never inferred from a low GPS speed.
            lastMarkerPositionRef.current = { position: pos, viaVessel };
            updateDirection();
            updateStatusBadge();

            // ── One receiver per trail ──
            // The wake trail and the swing envelope are a RECEIVER's story.
            // When the arbiter changes its mind — the boat feed goes quiet and
            // the phone takes over, or the Pi comes back — the next point is a
            // different object in a different place, and joining them drew a
            // thin blue chord from her berth to the skipper's house (Shane
            // 2026-09-09: "you get a thin blue line between both spots"). A
            // change of source starts both again.
            const source: 'vessel' | 'phone' = viaVessel ? 'vessel' : 'phone';
            if (viaVessel && lastSourceRef.current === 'phone') {
                // The boat takes over from the phone: whatever the phone drew
                // was never her wake. Start clean.
                trailCoordsRef.current = [];
                swingPointsRef.current = [];
                removeTrailLayers(map);
                removeSwingLayers(map);
            }
            lastSourceRef.current = source;
            if (viaVessel) vesselSpokeRef.current = true;
            // Once the boat has spoken, the phone is a stand-in for the ARROW
            // only: it never draws her wake or her swing, and what she drew
            // stays frozen until she reports again. A skipper walking to the
            // pub is not the yacht wandering at anchor. A boat with no
            // instruments (the phone is all she has) keeps both, as before.
            if (!viaVessel && vesselSpokeRef.current) return;

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
        [mapRef, visible, updateStatusBadge, updateDirection],
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
                syncOwnshipObstacle(map, null);
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
            const store = NmeaStore.getState();
            const own = resolveOwnshipPosition(store, LocationStore.getState());
            if (own && own.source === 'nmea') {
                // The Pi's lanes stamp lat/lon with the time THIS PHONE read
                // them; only the snapshot's position sample dates the
                // coordinates. The System status boat card dates them by it
                // (boatGpsDiagnosticSource) and Radio's vessel fix does too
                // (radioTelemetryPosition), so the badge does — or a Pi
                // republishing old coordinates reads 'Stopped' here while the
                // card says 'No live fix' and Radio says NO FIX. The Pi sends
                // that sample time whenever it can prove the fix's age, so a
                // Pi row without one is undated, exactly as Radio treats it.
                // Another device's shared row keeps its receipt time. The
                // arbiter's own gates, and the direction's, are untouched.
                const remote = store.connectionStatus === 'remote' ? store.remote : null;
                const sampleAt = remote?.positionSampleAt;
                const fixAt = !remote
                    ? own.timestamp
                    : typeof sampleAt === 'number' && Number.isFinite(sampleAt)
                      ? Math.min(sampleAt, own.timestamp)
                      : remote.source === 'pi'
                        ? null
                        : own.timestamp;
                updateMarker(
                    {
                        latitude: own.lat,
                        longitude: own.lon,
                        accuracy: 15,
                        altitude: null,
                        // Direction comes from independently timestamped
                        // metrics, not the arbiter's numeric-zero fallback.
                        heading: null,
                        // The arbiter speaks knots; the marker eats m/s.
                        speed: own.sog / 1.94384,
                        timestamp: own.timestamp,
                        receivedAt: Date.now(),
                    },
                    true,
                    fixAt,
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
                speed: phone.speed ?? null,
                timestamp: phone.timestamp ?? Date.now(),
                receivedAt: Date.now(),
            });
        };

        // Passive foreground watch: it consumes an existing Location grant
        // but never initializes background tracking or raises permission UI
        // merely because the chart was restored at launch.
        const unsub = GpsService.watchPosition((pos) => paint(pos));
        const unsubNmea = NmeaGpsProvider.onPosition(() => paint());
        const unsubDirection = NmeaStore.subscribe(updateDirection);
        const unsubAnchor = AnchorWatchService.subscribe(updateStatusBadge);
        const unsubSync = AnchorWatchSyncService.onStateChange(updateStatusBadge);
        const unsubShore = ShoreWatchAlarmService.subscribe(updateStatusBadge);
        paint();

        // MapHub reorders the base labels on style changes (the satellite
        // lift), so the obstacle is re-checked after them, coalesced: a burst
        // of layer edits costs one style read, not one each.
        let raiseTimer: number | null = null;
        const onStyleData = () => {
            if (raiseTimer !== null || !map) return;
            raiseTimer = window.setTimeout(() => {
                raiseTimer = null;
                raiseOwnshipObstacle(map);
            }, 250);
        };
        map?.on?.('styledata', onStyleData);

        // Staleness ticker — the only path that can grey the marker once
        // fixes STOP arriving (see lastFixAtRef comment). The badge update
        // applies the tier from the same fix state as its words.
        const staleTicker = window.setInterval(() => {
            if (!elementRef.current || !lastMarkerPositionRef.current) return;
            updateStatusBadge();
            updateDirection();
            // A base-map swap wipes custom layers; with no new fix arriving,
            // this is what puts the label obstacle back under the marker.
            const { latitude, longitude } = lastMarkerPositionRef.current.position;
            if (map) syncOwnshipObstacle(map, [longitude, latitude], true);
        }, 1000);

        return () => {
            window.clearInterval(staleTicker);
            if (raiseTimer !== null) window.clearTimeout(raiseTimer);
            map?.off?.('styledata', onStyleData);
            unsub?.();
            unsubNmea();
            unsubDirection();
            unsubAnchor();
            unsubSync();
            unsubShore();
            if (markerRef.current) {
                markerRef.current.remove();
                markerRef.current = null;
                elementRef.current = null;
            }
            if (map) {
                removeTrailLayers(map);
                removeSwingLayers(map);
                syncOwnshipObstacle(map, null);
            }
        };
    }, [mapReady, visible, updateMarker, updateStatusBadge, updateDirection, mapRef]);

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
