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
import {
    isBasePlaceLabelLayer,
    isSettlementPlaceFeature,
    OWNSHIP_LABEL_STATE,
    readsOwnshipFade,
    withOwnshipLabelFade,
    type LabelLayerIdentity,
} from './ownshipLabelFade';

export { isBasePlaceLabelLayer, isSettlementPlaceFeature, withOwnshipLabelFade } from './ownshipLabelFade';

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

// ── Own-ship footprint: a label-collision obstacle (NOT PLACED) ──
//
// The marker is a DOM element, and Mapbox's label placement cannot see DOM,
// so at a marina the town's place label was drawn straight through the dot
// and its chip: "Gla◯to Stopped" (UX scorecard run 8). An invisible symbol at
// the fix, sized to the dot plus the chip beside it, takes that box in the
// collision index. Nothing is drawn: the image is fully transparent.
//
// The hook no longer places it. useMapInit runs crossSourceCollisions:false
// (smooth panning, Shane 2026-07-14), so a symbol alone in its own source
// collides with nothing at all, and its per-fix setData was a worker round
// trip and a re-placement every second at a berth for no effect. The hook
// only removes a leftover one; syncOwnshipPlaceLabel below does the job. This
// stays for the day cross-source collisions come back.
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
                    // NOTE: inert against the base style's place names while
                    // useMapInit sets crossSourceCollisions:false (smooth
                    // panning, Shane 2026-07-14): Mapbox then collides each
                    // source's symbols only with its own, so 'Gladstone' never
                    // sees this box however the layers are ordered (UX
                    // scorecard runs 8-10; layer raising was tried and backed
                    // out). syncOwnshipPlaceLabel below is what clears that
                    // label, without touching collisions or layer order.
                    'icon-allow-overlap': true,
                    'icon-ignore-placement': false,
                    // The marker turns and tilts with the map; so does its box.
                    'icon-rotation-alignment': 'map',
                    'icon-pitch-alignment': 'map',
                },
            });
        }
    } catch {
        // Mid style swap: the next fix, or the staleness tick, puts it back.
    }
}

// ── Own-ship vs the base style's town name ──
//
// The obstacle above cannot move a base-style place name while the map runs
// with crossSourceCollisions:false, and layer order does not help either (UX
// scorecard runs 8-10: "Gla◯to Stopped" at a Gladstone berth). So the ONE
// settlement label whose placed text or icon runs under the dot or its chip is
// faded out, just that feature, and faded back in once own-ship is clear of
// it. Collision settings and layer order stay exactly as they are.
//
// Only the base style's own settlement layers (Mapbox `composite`, MapTiler
// `openmaptiles`) and only town and suburb names are ever touched: never ENC,
// seamark, navaid, AIS, route, waypoint, MOB or hazard labels, and never an
// island name (ownshipLabelFade). The fade is a feature-state switch on their
// opacity, so the label keeps its placement: the next look still sees it under
// the boat, and a name the dot merely sits near is left alone.
//
// The switch is written into those layers' opacity ONCE, when the map is ready
// (armOwnshipPlaceLabels), whether or not own-ship is showing: turning a
// constant into a feature-state value re-parses the whole base source in
// mapbox-gl 3.x, so it happens at load and never mid-session. Nothing changes
// it after that: the isobar code only ever hands it back to 1 through the same
// wrapper (a no-op once there) and ghosts town names by their ink instead. A
// fade or a release is then one feature's state, nothing else.
//
// NOT COVERED: the Hybrid base. satellite-streets is drawn from raster tiles,
// so its town names are baked into the pixels, and MapHub hides the vector
// settlement layers while Hybrid is on (they would print twice). There is
// nothing here to fade; paint and feature state cannot remove raster pixels.
// This covers the Map, Satellite and Ocean bases, where dark-v11's vector
// names are the ones drawn.

/** Glyph boxes this close to the dot or its chip count as printing through it. */
const PLACE_LABEL_CLEAR_PAD_PX = 4;
/**
 * The faded name stays faded until its glyphs are this far clear. Leaving is
 * harder than arriving: at a berth at z15-16 each fix's jitter moves the dot a
 * pixel or two, and a box at the edge of the 4 px pad would otherwise blink on
 * and off every second.
 */
const PLACE_LABEL_EXIT_PAD_PX = PLACE_LABEL_CLEAR_PAD_PX + 8;
/** The dot plus its glow, each side of the fix. */
const OWNSHIP_DOT_HALF_PX = GLOW_DIAMETER_PX / 2 + 2;
/**
 * The faded label stays faded while it still touches own-ship, unless another
 * is nearer by more than this: GPS jitter must not swap two names back and
 * forth under the chip.
 */
const PLACE_LABEL_SWITCH_MARGIN_PX = 12;

export interface ScreenRect {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

interface HiddenPlaceLabel {
    source: string;
    sourceLayer?: string;
    id: string | number;
    /** The layer it was found drawn on: its opacity must still read the state. */
    layer: string;
}

const hiddenPlaceLabels = new WeakMap<object, HiddenPlaceLabel>();
const placeLabelLayerCache = new WeakMap<object, { ids: string[]; at: number }>();

function basePlaceLabelLayers(map: mapboxgl.Map): string[] {
    const cached = placeLabelLayerCache.get(map);
    // Reading the style is costly, so the list is kept until one of its
    // layers goes (a style swap). An empty list is re-read at most every 10 s.
    if (cached && (cached.ids.length ? cached.ids.every((id) => map.getLayer(id)) : Date.now() - cached.at < 10_000)) {
        return cached.ids;
    }
    const ids = (map.getStyle()?.layers ?? [])
        .filter((layer) => isBasePlaceLabelLayer(layer as LabelLayerIdentity))
        .map((layer) => layer.id);
    placeLabelLayerCache.set(map, { ids, at: Date.now() });
    return ids;
}

/** Arm one layer's text and icon opacity for the fade. False when it can't be. */
function armPlaceLabelLayer(map: mapboxgl.Map, id: string): boolean {
    let armed = true;
    for (const property of ['text-opacity', 'icon-opacity'] as const) {
        const current = map.getPaintProperty(id, property);
        if (readsOwnshipFade(current)) continue;
        const next = withOwnshipLabelFade(current);
        if (next === null) {
            armed = false;
            continue;
        }
        map.setPaintProperty(id, property, next as number);
    }
    return armed;
}

/**
 * Write the fade switch into every base place layer, once. Called as soon as
 * the map is ready, whether own-ship is showing or not, so the one
 * constant-to-feature-state change (a full base-source re-parse in mapbox-gl
 * 3.x) happens at load, not in the middle of a pan. A layer already armed is
 * not written again. False only while the style is still loading: the visible
 * tracker's ticker tries again.
 */
export function armOwnshipPlaceLabels(map: mapboxgl.Map): boolean {
    if (
        typeof map.getStyle !== 'function' ||
        typeof map.getPaintProperty !== 'function' ||
        typeof map.setPaintProperty !== 'function'
    ) {
        return true; // A map (or test double) with no style to arm.
    }
    try {
        for (const id of basePlaceLabelLayers(map)) armPlaceLabelLayer(map, id);
        return true;
    } catch {
        // "Style is not done loading": the staleness tick tries again.
        placeLabelLayerCache.delete(map);
        return false;
    }
}

function setPlaceLabelHidden(map: mapboxgl.Map, label: HiddenPlaceLabel, hidden: boolean): void {
    const target = { source: label.source, sourceLayer: label.sourceLayer, id: label.id };
    if (hidden) map.setFeatureState(target, { [OWNSHIP_LABEL_STATE]: true });
    else map.removeFeatureState(target, OWNSHIP_LABEL_STATE);
}

function placeLabelStillHidden(map: mapboxgl.Map, label: HiddenPlaceLabel): boolean {
    const target = { source: label.source, sourceLayer: label.sourceLayer, id: label.id };
    // A style swap can drop the state, or reset the opacity that reads it.
    return (
        map.getFeatureState(target)?.[OWNSHIP_LABEL_STATE] === true &&
        !!map.getLayer(label.layer) &&
        readsOwnshipFade(map.getPaintProperty(label.layer, 'text-opacity'))
    );
}

const sameLabel = (a: Omit<HiddenPlaceLabel, 'layer'>, b: Omit<HiddenPlaceLabel, 'layer'>) =>
    a.id === b.id && a.source === b.source && a.sourceLayer === b.sourceLayer;

/**
 * Fade out the one base-style town name that own-ship prints through, and
 * bring it back once the boat is clear of it.
 *
 * `lngLat` is where the marker is DRAWN: the Marker's own smart-wrapped
 * position, not the raw fix, or near the antimeridian the dot would project
 * a world-width away from the chip. `footprint` is the dot and each chip it
 * wears, in map pixels, one rect each: the empty corners of a box around all
 * of them are not own-ship and must not hide a name. Without it, the dot
 * alone. Null `lngLat` restores.
 */
export function syncOwnshipPlaceLabel(
    map: mapboxgl.Map,
    lngLat: [number, number] | null,
    footprint: ScreenRect | readonly ScreenRect[] | null = null,
): void {
    try {
        // A map (or a test double) that cannot query or hold feature state has no labels to clear.
        if (
            typeof map.queryRenderedFeatures !== 'function' ||
            typeof map.setFeatureState !== 'function' ||
            typeof map.removeFeatureState !== 'function' ||
            typeof map.getFeatureState !== 'function' ||
            typeof map.project !== 'function' ||
            typeof map.getStyle !== 'function'
        ) {
            return;
        }
        const hidden = hiddenPlaceLabels.get(map);
        const release = () => {
            if (!hidden) return;
            hiddenPlaceLabels.delete(map);
            try {
                setPlaceLabelHidden(map, hidden, false);
            } catch {
                // Its source went with a style swap: nothing left to restore.
            }
        };
        if (!lngLat) {
            release();
            return;
        }
        const layers = basePlaceLabelLayers(map);
        if (layers.length === 0) {
            release();
            return;
        }

        const dot = map.project(lngLat);
        const dotRect: ScreenRect = {
            left: dot.x - OWNSHIP_DOT_HALF_PX,
            top: dot.y - OWNSHIP_DOT_HALF_PX,
            right: dot.x + OWNSHIP_DOT_HALF_PX,
            bottom: dot.y + OWNSHIP_DOT_HALF_PX,
        };
        const parts: readonly ScreenRect[] = !footprint ? [dotRect] : 'left' in footprint ? [footprint] : footprint;
        // Symbol queries hit placed glyph and icon boxes, so this returns the
        // labels actually drawn under the dot or a chip, the faded one included.
        const collect = (pad: number) => {
            const candidates: Array<HiddenPlaceLabel & { distance: number }> = [];
            for (const part of parts) {
                const features = map.queryRenderedFeatures(
                    [
                        [part.left - pad, part.top - pad],
                        [part.right + pad, part.bottom + pad],
                    ],
                    { layers },
                );
                for (const feature of features) {
                    const id = feature.id;
                    if (id === undefined || id === null || typeof feature.source !== 'string') continue;
                    // Town and suburb names only: never an island or islet.
                    if (!isSettlementPlaceFeature(feature.properties as Record<string, unknown> | null)) continue;
                    const raw = feature as unknown as { sourceLayer?: string; 'source-layer'?: string };
                    const label = { source: feature.source, sourceLayer: raw.sourceLayer ?? raw['source-layer'], id };
                    if (candidates.some((c) => sameLabel(c, label))) continue;
                    const geometry = feature.geometry;
                    let at = dot;
                    if (geometry?.type === 'Point') {
                        const [lon, lat] = geometry.coordinates as [number, number];
                        // Into the marker's world copy before measuring.
                        at = map.project([lon + 360 * Math.round((lngLat[0] - lon) / 360), lat]);
                    }
                    candidates.push({
                        ...label,
                        layer: feature.layer?.id ?? '',
                        distance: Math.hypot(at.x - dot.x, at.y - dot.y),
                    });
                }
            }
            return candidates;
        };
        const candidates = collect(PLACE_LABEL_CLEAR_PAD_PX);
        let current = hidden ? candidates.find((c) => sameLabel(c, hidden)) : undefined;
        if (hidden && !current) {
            // Out of the entry pad, but it keeps its fade inside the wider
            // exit pad (only this one label is looked for there).
            current = collect(PLACE_LABEL_EXIT_PAD_PX).find((c) => sameLabel(c, hidden));
            if (current) candidates.push(current);
        }
        // The label anchored nearest the fix is the one the boat sits on. The
        // one already faded keeps it while it still touches own-ship, unless
        // another is clearly nearer: jitter never swaps them back and forth.
        let best: (HiddenPlaceLabel & { distance: number }) | null = null;
        for (const candidate of candidates) if (!best || candidate.distance < best.distance) best = candidate;
        if (current && best && best.distance > current.distance - PLACE_LABEL_SWITCH_MARGIN_PX) best = current;

        const same = !!hidden && !!best && sameLabel(best, hidden);
        if (hidden && same && placeLabelStillHidden(map, hidden)) return;
        if (!same) release();
        if (!best) return;
        // Armed at load (armOwnshipPlaceLabels); this only catches a layer
        // that was not there then. Every place layer on that source layer,
        // since a town moves between the minor and major layers with zoom.
        for (const id of layers) {
            const layer = map.getLayer(id) as unknown as { 'source-layer'?: string; sourceLayer?: string } | undefined;
            const sourceLayer = layer?.['source-layer'] ?? layer?.sourceLayer;
            if (best.sourceLayer && sourceLayer !== best.sourceLayer) continue;
            if (!readsOwnshipFade(map.getPaintProperty(id, 'text-opacity'))) armPlaceLabelLayer(map, id);
        }
        // An opacity this cannot wrap keeps its label, and nothing is recorded:
        // a hidden label on an unarmed layer reads as reset to the 1 s ticker,
        // which would write its state again every second.
        if (!readsOwnshipFade(map.getPaintProperty(best.layer, 'text-opacity'))) {
            if (same) release();
            return;
        }
        const label: HiddenPlaceLabel = {
            source: best.source,
            sourceLayer: best.sourceLayer,
            id: best.id,
            layer: best.layer,
        };
        setPlaceLabelHidden(map, label, true);
        hiddenPlaceLabels.set(map, label);
    } catch {
        // Mid style swap: the next settle or fix tries again.
    }
}

/** True when a label was faded but a style swap has since dropped its state. */
export function ownshipPlaceLabelWasReset(map: mapboxgl.Map): boolean {
    const hidden = hiddenPlaceLabels.get(map);
    if (!hidden) return false;
    try {
        return !placeLabelStillHidden(map, hidden);
    } catch {
        return true;
    }
}

/**
 * What own-ship is wearing, from text alone: the badge's words, and the age
 * chip's display and words. Reading text and inline style forces no layout,
 * so the 1 s ticker can compare it every tick. Digits are rounded away ('Last
 * fix 46 s' and 'Last fix 47 s' cover the same pixels), so a counting chip is
 * one footprint until its length or its words change, not a new one a second.
 */
export function ownshipChipSignature(el: HTMLElement): string {
    const badge = el.querySelector<HTMLElement>('.vessel-sog-badge');
    const chip = el.querySelector<HTMLElement>('.vessel-age-chip');
    const words = (text: string | null | undefined) => (text ?? '').replace(/\d/g, '0');
    return `${words(badge?.textContent)}|${chip?.style.display ?? ''}|${words(chip?.textContent)}`;
}

/**
 * The badge and a showing age chip, as rects relative to the marker's centre
 * (which is the drawn fix). Measured only when what the chips say changes, or
 * the camera settles, never per fix: that is a forced layout.
 */
function measureChipOffsets(el: HTMLElement): ScreenRect[] {
    const origin = el.getBoundingClientRect();
    const cx = origin.left + origin.width / 2;
    const cy = origin.top + origin.height / 2;
    const out: ScreenRect[] = [];
    for (const part of el.querySelectorAll<HTMLElement>('.vessel-sog-badge, .vessel-age-chip')) {
        const box = part.getBoundingClientRect();
        if (box.width <= 0 || box.height <= 0) continue;
        out.push({ left: box.left - cx, top: box.top - cy, right: box.right - cx, bottom: box.bottom - cy });
    }
    return out;
}

/** The dot and each chip, in map pixels, around the drawn dot. */
function ownshipFootprintParts(dot: { x: number; y: number }, chips: readonly ScreenRect[]): ScreenRect[] {
    return [
        {
            left: dot.x - OWNSHIP_DOT_HALF_PX,
            top: dot.y - OWNSHIP_DOT_HALF_PX,
            right: dot.x + OWNSHIP_DOT_HALF_PX,
            bottom: dot.y + OWNSHIP_DOT_HALF_PX,
        },
        ...chips.map((c) => ({
            left: dot.x + c.left,
            top: dot.y + c.top,
            right: dot.x + c.right,
            bottom: dot.y + c.bottom,
        })),
    ];
}

/**
 * MapHub's base imagery. Showing Satellite lifts the settlement layers above
 * it and Hybrid hides them, with no camera move and no fix; this is how the
 * ticker notices without reading the whole style.
 */
const BASE_IMAGERY_LAYERS = ['satellite-base-layer', 'hybrid-base-layer', 'maptiler-ocean-layer'] as const;

/** Which base place layers and which imagery are showing, cheaply. */
function basePlaceLabelViewSignature(map: mapboxgl.Map): string {
    try {
        if (typeof map.getLayoutProperty !== 'function' || typeof map.getStyle !== 'function') return '';
        const visibility = (id: string) =>
            map.getLayer(id) ? ((map.getLayoutProperty(id, 'visibility') as string | undefined) ?? 'visible') : '-';
        return [...basePlaceLabelLayers(map), ...BASE_IMAGERY_LAYERS].map(visibility).join(',');
    } catch {
        return '';
    }
}

/** True once the base style's label tiles for this view have arrived. */
function basePlaceLabelTilesLoaded(map: mapboxgl.Map): boolean {
    try {
        if (typeof map.isSourceLoaded !== 'function' || typeof map.getSource !== 'function') return true;
        return ['composite', 'openmaptiles'].every((id) => !map.getSource(id) || map.isSourceLoaded(id));
    } catch {
        return true;
    }
}

// ── The marker's spoken name ──

/**
 * The badge's words as VoiceOver should hear them. The marker is one img, so
 * its visible chip is not read unless its name carries it (UX scorecard run
 * 10): 'Last fix 54 s' becomes 'last fix 54 seconds ago'. The words themselves
 * come from the badge (gpsFixState's one wording); this only spells out units.
 */
export function spokenOwnshipBadge(label: string): string {
    const unit = (n: string, one: string, many: string) => `${n} ${n === '1' ? one : many}`;
    const age = /^Last fix (\d+) (s|min|h)$/.exec(label);
    if (age) {
        const [, n, u] = age;
        const words =
            u === 's'
                ? unit(n, 'second', 'seconds')
                : u === 'min'
                  ? unit(n, 'minute', 'minutes')
                  : unit(n, 'hour', 'hours');
        return `last fix ${words} ago`;
    }
    const speed = /^(\d+(?:\.\d+)?) kts$/.exec(label);
    if (speed) return `${speed[1]} knots`;
    if (label === 'SOG —') return 'speed over ground unavailable';
    return label.charAt(0).toLowerCase() + label.slice(1);
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
    /** The two halves of the marker's spoken name: what its chip says, and which way she points. */
    const spokenStatusRef = useRef('');
    const spokenDirectionRef = useRef('heading unavailable');
    /** Set by the effect: re-checks the one place label own-ship would print through. */
    const placeLabelSyncRef = useRef<(() => void) | null>(null);

    // One img, one name: its status chip is a child the name must carry, or
    // VoiceOver never hears 'Stopped' or that the fix is 54 s old (UX scorecard
    // run 10). 'Own ship, last fix 54 seconds ago; heading unavailable': the
    // chip's own words and nothing more, so the name can never say something
    // the chip and gpsFixState do not.
    const nameMarker = useCallback((el: HTMLElement) => {
        const status = spokenStatusRef.current;
        const label = `Own ship${status ? `, ${status}` : ''}; ${spokenDirectionRef.current}`;
        el.setAttribute('role', 'img');
        el.setAttribute('aria-label', label);
        el.title = label;
    }, []);

    const updateDirection = useCallback(() => {
        const last = lastMarkerPositionRef.current;
        const el = elementRef.current;
        const arrow = el?.querySelector('.vessel-arrow') as HTMLElement | null;
        if (!last || !el || !arrow) return;
        const direction = resolveOwnshipDirection(last.position, last.viaVessel, NmeaStore.getState());
        el.dataset.directionSource = direction.source;
        spokenDirectionRef.current =
            direction.source === 'heading'
                ? `bow heading ${Math.round(direction.degrees)}° true`
                : direction.source === 'course'
                  ? `course over ground ${Math.round(direction.degrees)}° true; bow heading unavailable`
                  : 'heading unavailable';
        nameMarker(el);
        arrow.style.transform = `rotate(${direction.degrees ?? 0}deg)`;
        const shape = arrow.querySelector('.vessel-directional-shape') as SVGElement;
        const dot = arrow.querySelector('.vessel-neutral-shape') as SVGElement;
        shape.style.display = direction.degrees === null ? 'none' : '';
        dot.style.display = direction.degrees === null ? '' : 'none';
    }, [nameMarker]);

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
        const chipText = anchorLabel ? ownshipFixLabel(fix) : null;
        applyGpsAgeTier(el, tier, chipText);
        // What the badge and chip show, in their own words: 'Last fix 46 s'
        // already says the position is old, and a softer hedge on top ('may
        // be stale') would be a second wording for the one fix state.
        const spoken = [spokenOwnshipBadge(label)];
        if (chipText) spoken.push(spokenOwnshipBadge(chipText));
        spokenStatusRef.current = spoken.join(', ');
        nameMarker(el);
    }, [nameMarker]);

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
            // A quiet tell for anyone debugging which truth the arrow is on.
            if (elementRef.current) elementRef.current.dataset.source = viaVessel ? 'vessel' : 'phone';

            // Anchor state is explicit, never inferred from a low GPS speed.
            lastMarkerPositionRef.current = { position: pos, viaVessel };
            updateDirection();
            updateStatusBadge();
            // After the badge: its width is part of what a town name must clear.
            placeLabelSyncRef.current?.();

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
                syncOwnshipPlaceLabel(map, null);
                // Armed at load even with own-ship hidden (turned off, or the
                // Plan page / a passage up at launch), so the one base-source
                // re-parse lands with the load, not the moment the chart
                // appears and the skipper starts panning. Idempotent; if the
                // style is still loading, the visible path's ticker retries.
                if (mapReady) armOwnshipPlaceLabels(map);
            }
            // Keep trail coords in memory so they reappear on re-toggle
            return;
        }
        const map = mapRef.current;

        // ── The one town name own-ship sits on (see syncOwnshipPlaceLabel) ──
        // Looked at when what own-ship covers on screen changes (the fix moved
        // a pixel, a chip changed its words, the base changed) or the camera
        // settles; never per frame, and never mid-gesture. Only a change of
        // faded label writes anything, and that is one feature's state.
        let disposed = false;
        const canLook = !!map && typeof map.project === 'function' && typeof map.queryRenderedFeatures === 'function';
        // The switch goes into the place layers' opacity now, at load, so the
        // one base-source re-parse it costs never lands mid-pan.
        let placeLabelsArmed = !map || armOwnshipPlaceLabels(map);
        /** Chip words + drawn dot pixel + zoom at the last look; null before the first. */
        let lastLookKey: string | null = null;
        /** The chips' rects around the dot, and the chip words they were measured for. */
        let chipOffsets: { signature: string; rects: ScreenRect[] } | null = null;
        /** Which base place layers and imagery were showing at the last look. */
        let baseViewSignature: string | null = null;
        const isMoving = () => !!map && typeof map.isMoving === 'function' && map.isMoving();
        /** Where the marker is DRAWN: its own smart-wrapped position, not the raw fix. */
        const drawnLngLat = (): [number, number] | null => {
            const marker = markerRef.current as (mapboxgl.Marker & { getLngLat?: () => mapboxgl.LngLat }) | null;
            const wrapped = marker && typeof marker.getLngLat === 'function' ? marker.getLngLat() : null;
            if (wrapped && Number.isFinite(wrapped.lng) && Number.isFinite(wrapped.lat))
                return [wrapped.lng, wrapped.lat];
            const last = lastMarkerPositionRef.current;
            return last ? [last.position.longitude, last.position.latitude] : null;
        };
        /**
         * One look. `settled` re-measures the chips and looks again even when
         * nothing on screen moved, because the labels under the boat may have
         * been placed since; otherwise an unchanged footprint costs one
         * project() and nothing else.
         */
        const lookAtPlaceLabel = (settled: boolean) => {
            const el = elementRef.current;
            if (disposed || !map || !el || typeof map.project !== 'function') return;
            const lngLat = drawnLngLat();
            if (!lngLat) return;
            const signature = ownshipChipSignature(el);
            const dot = map.project(lngLat);
            const zoom = typeof map.getZoom === 'function' ? map.getZoom().toFixed(2) : '';
            // Whole pixels: GPS jitter under a pixel is not a change on screen.
            const key = `${signature}|${Math.round(dot.x)}|${Math.round(dot.y)}|${zoom}`;
            if (!settled && key === lastLookKey) return;
            lastLookKey = key;
            baseViewSignature = basePlaceLabelViewSignature(map);
            if (settled || !chipOffsets || chipOffsets.signature !== signature) {
                chipOffsets = { signature, rects: measureChipOffsets(el) };
            }
            syncOwnshipPlaceLabel(map, lngLat, ownshipFootprintParts(dot, chipOffsets.rects));
        };

        // After the camera settles, a first fix, a base change or a style swap
        // that put the label back: look once the map has drawn the new view and
        // placed its labels (at moveend itself it has not). ONE idle listener
        // at most, kept until idle comes, and a 1.5 s fallback for when it
        // does not: mapbox fires 'idle' at the end of a drawn frame, so a
        // static map that already idled before the listener went on draws no
        // more frames and never fires it (while tiles keep loading it does not
        // either). The fallback's look is provisional: it never cancels the
        // idle look, and if the base label tiles were still loading it looks
        // once more when they arrive.
        let settlePending = false;
        let confirmAtIdle = false;
        let recheckWhenTilesLoad = false;
        let labelSettleTimer: number | null = null;
        let labelIdleRun: (() => void) | null = null;
        const clearSettleTimer = () => {
            if (labelSettleTimer !== null) window.clearTimeout(labelSettleTimer);
            labelSettleTimer = null;
        };
        const dropLabelIdleRun = () => {
            if (labelIdleRun && map && typeof map.off === 'function') map.off('idle', labelIdleRun);
            labelIdleRun = null;
        };
        const onLabelIdle = () => {
            labelIdleRun = null; // once: it is gone
            if (!settlePending && !confirmAtIdle && !recheckWhenTilesLoad) return;
            if (isMoving()) return; // its moveend asks again
            settlePending = confirmAtIdle = recheckWhenTilesLoad = false;
            clearSettleTimer();
            lookAtPlaceLabel(true);
        };
        const onLabelSettleTimer = () => {
            labelSettleTimer = null;
            // Mid-gesture: the gesture's own moveend restarts this, and the
            // idle listener stays where it is.
            if (!settlePending || isMoving()) return;
            settlePending = false;
            confirmAtIdle = true;
            recheckWhenTilesLoad = !!map && !basePlaceLabelTilesLoaded(map);
            lookAtPlaceLabel(true);
        };
        /**
         * `restart` (a camera settle, a first fix): the fallback runs 1.5 s
         * after the LAST settle, not the first. The 1 s ticker passes false:
         * it only starts a fallback when none is pending, or a condition it
         * re-notices every second (a reset label) would push the fallback
         * back forever on a map that never idles.
         */
        const syncPlaceLabelWhenIdle = (restart = true) => {
            if (!map || !canLook || disposed) return;
            settlePending = true;
            if (!labelIdleRun && typeof map.once === 'function') {
                labelIdleRun = onLabelIdle;
                map.once('idle', onLabelIdle);
            }
            if (!restart && labelSettleTimer !== null) return;
            clearSettleTimer();
            labelSettleTimer = window.setTimeout(onLabelSettleTimer, 1500);
        };
        placeLabelSyncRef.current = () => {
            // Mid-gesture, the moveend after it does the work once.
            if (!map || !canLook || isMoving()) return;
            const first = lastLookKey === null;
            lookAtPlaceLabel(false);
            if (first) syncPlaceLabelWhenIdle();
        };
        const onMoveEnd = () => syncPlaceLabelWhenIdle();
        if (map && typeof map.on === 'function') map.on('moveend', onMoveEnd);

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

        // Staleness ticker — the only path that can grey the marker once
        // fixes STOP arriving (see lastFixAtRef comment). The badge update
        // applies the tier from the same fix state as its words.
        const staleTicker = window.setInterval(() => {
            if (!elementRef.current || !lastMarkerPositionRef.current) return;
            updateStatusBadge();
            updateDirection();
            if (!map || !canLook) return;
            // The style was still loading at mount: arm as soon as it is not.
            if (!placeLabelsArmed) placeLabelsArmed = armOwnshipPlaceLabels(map);
            // What own-ship covers, and what is drawn under it, can change with
            // no fix and no camera move: the base changed (Hybrid hides the
            // town names, Satellite lifts them), a style swap put the hidden
            // name back, the label tiles arrived after a provisional look, or
            // a chip changed its words ('Anchored' gains 'Last fix 46 s' above
            // the dot). Each is a cheap check here; only a change looks.
            const view = basePlaceLabelViewSignature(map);
            if (baseViewSignature !== null && view !== baseViewSignature) {
                baseViewSignature = view;
                syncPlaceLabelWhenIdle(false);
            } else if (ownshipPlaceLabelWasReset(map)) {
                syncPlaceLabelWhenIdle(false);
            } else if (recheckWhenTilesLoad && !isMoving() && basePlaceLabelTilesLoaded(map)) {
                recheckWhenTilesLoad = false;
                lookAtPlaceLabel(true);
            } else {
                placeLabelSyncRef.current?.();
            }
        }, 1000);

        return () => {
            window.clearInterval(staleTicker);
            disposed = true;
            clearSettleTimer();
            dropLabelIdleRun();
            placeLabelSyncRef.current = null;
            if (map && typeof map.off === 'function') map.off('moveend', onMoveEnd);
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
                syncOwnshipPlaceLabel(map, null);
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
