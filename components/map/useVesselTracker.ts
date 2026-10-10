/**
 * useVesselTracker — the own-ship marker: a little boat where the vessel is,
 * with her status beside it.
 *
 * Whose position it draws comes from ownshipBoatFix: the boat's OWN chain,
 * the same one the Obs camera centres on (her bus, her Pi, her cloud row, then
 * her held fix), so the camera and the marker cannot disagree. Build 121
 * moved the camera onto that chain and left this marker on the ownship
 * arbiter, which ashore falls back to the phone: Obs opened on the boat in
 * her marina and the marker sat on the skipper's phone at home (Shane
 * 2026-10-07: "there is no longer a dot for where the vessel is ... it could
 * be a nice little boat ... With either anchored or stopped ... Also it would
 * have sog"). A punter whose phone is all the boat has keeps the old path: the
 * arbiter, NMEA while it is fresh, the phone as the fallback.
 *
 * The badge reads the one anchor-watch truth (presentAnchorWatchRow) for this
 * boat, then 'Stopped' or her SOG while the fix is live, and 'Last fix 3 h'
 * once it is not. The bow follows a fresh true heading, or the course over
 * ground only while she is moving; without either, an upright side-on boat
 * never invents a bow bearing.
 *
 * Under the boat, her own wind as a small arrow and number wherever Obs's wind
 * field is not showing it (build 123, W1-WC): the overlay publishes it
 * (boatWindReadout), and the marker wears it only when it draws that boat.
 */
import mapboxgl from 'mapbox-gl';
import { useEffect, useRef, useCallback, useState, type MutableRefObject } from 'react';
import type { CachedPosition } from '../../services/BgGeoManager';
import { GpsService } from '../../services/GpsService';
import { NmeaGpsProvider } from '../../services/NmeaGpsProvider';
import { NmeaListenerService } from '../../services/NmeaListenerService';
import { NmeaStore } from '../../services/NmeaStore';
import { freshMovementMetric, resolveOwnshipPosition } from '../../services/ownshipPosition';
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
import { AnchorPiWatchKeeper } from '../../services/anchorPiWatchKeeper';
import { getAuthIdentityScope, subscribeAuthIdentityScope } from '../../services/authIdentityScope';
import { subscribeSharedBinders } from '../../services/vessel/sharedBinders';
import { WEATHER_FOLLOW_TARGET_EVENT } from '../../services/weatherPosition';
import { SKIPPER_BOAT_FALLBACK } from '../vessel/skipperBoatFallback';
import type { ObsBoatNames } from './obsCentre';
import { ownshipStatus, type OwnshipMarkerIdentity, type OwnshipStatusPresentation } from './ownshipStatus';
import { boatWindChipFor, getBoatWindReadout, subscribeBoatWindReadout, type BoatWindChip } from './boatWindReadout';
import { resolveOwnshipDirection, type DirectionInstruments, type OwnshipDirection } from './ownshipDirection';
import {
    REMOTE_LANE_LIVE_MAX_AGE_MS,
    lookUpVesselMarkerFix,
    ownBoatLookedUp,
    ownshipMarkerSubject,
    rememberSeenVesselFix,
    sameOwnshipSubject,
    seenVesselFix,
    vesselMarkerFixNow,
    type OwnshipSubject,
    type VesselMarkerFix,
} from './ownshipBoatFix';
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
/**
 * Her wind chip's top edge below the fix: the 28 px boat's half (14), which a
 * bow heading south reaches with its halo, + 4 px air. Its 21 px then end 43 px
 * below the fix, under the badge's foot (10.5 px) and the boat.
 */
const WIND_CHIP_TOP_PX = 18;
/**
 * Her wind chip wears the badge's own chip classes, so daylight turns both
 * light together (styles/daylight.css). Each tone holds 4.5:1 on that chip
 * (12 px bold is not large text): slate-100 live, which daylight inks
 * slate-900; the stale tier dimmed to slate-400 (slate-600 in daylight) on a
 * dashed edge (browser-tests/ownship-boat-marker.spec.ts).
 */
const WIND_CHIP_TONE_CLASS = {
    live: ['text-slate-100', 'border-sky-400/30'],
    stale: ['text-slate-400', 'border-slate-400/50', 'border-dashed'],
} as const;
/**
 * Theme text classes: .display-light darkens each for a light chip. Each
 * holds 4.5:1 on the badge's own chip (12 px bold is not large text): red-500
 * read 4.0:1 on the dark chip, so the reds are red-400 (6.2:1), which daylight
 * darkens to red-700 as before (browser-tests/ownship-boat-marker.spec.ts).
 */
const STATUS_TONE_CLASS = {
    live: 'text-sky-400',
    anchored: 'text-emerald-400',
    /** An anchor watch that is expiring, waiting or not updating this phone (the row's amber). */
    caution: 'text-amber-400',
    alarm: 'text-red-400',
    /** 'Last fix 46 s': amber, then red once the position is history (5 min). */
    stale: 'text-amber-400',
    lost: 'text-red-400',
} as const;

/** Top-down hull, bow up: a pointed bow, full quarters, a flat transom. */
const HULL_PATH =
    'M12 1.6C15.9 5.2 17.6 9.6 17.6 13.8C17.6 17.2 16.9 20 16.1 21.6Q15.8 22.4 14.9 22.4H9.1Q8.2 22.4 7.9 21.6C7.1 20 6.4 17.2 6.4 13.8C6.4 9.6 8.1 5.2 12 1.6Z';
/** The side-on boat: a hull, her mainsail aft of the mast and a jib forward. */
const SIDE_HULL_PATH = 'M2.8 15.9H21.2L18.9 19.9Q18.5 20.6 17.7 20.6H6.3Q5.5 20.6 5.1 19.9Z';
const MAINSAIL_PATH = 'M12.8 2.4V14.3H19.6Z';
const JIB_PATH = 'M11.2 4.6V14.3H5.4Z';
/** A dark hairline round the white edge: legible on light bases and bright imagery. */
const GLYPH_HALO = 'drop-shadow(0 0 0.8px rgba(2, 6, 23, 0.95)) drop-shadow(0 1px 1.5px rgba(2, 6, 23, 0.55))';
let vesselElementSeq = 0;

/**
 * How the marker sits on the chart: on her fix, and upright on screen however
 * the chart is turned (127-11a, audit A4). Mapbox turned a 'map'-aligned root
 * by minus the bearing, and everything inside it: at 90° 'Stopped' read
 * vertically above the boat. turnOwnshipArrows turns her arrows instead.
 * Exported for the layout specs, which draw the production marker.
 */
export const OWNSHIP_MARKER_OPTIONS = {
    anchor: 'center',
    rotationAlignment: 'viewport',
    pitchAlignment: 'map',
} as const;

/**
 * Build the vessel marker DOM element: the boat, its halo, the status badge
 * beside it and the fix-age chip above.
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

    // The boat (rotates with heading). No CSS angle tween: 359° → 1° would
    // otherwise sweep through the wrong 358° around the compass.
    //
    // Two drawings in one 28 px box. With a direction (a fresh true heading,
    // or the course while she moves): a top-down hull, bow along it. Without
    // one (stopped, anchored, an old fix): a small side-on sailing boat, kept
    // upright on screen, which reads as "a boat" and claims no bow bearing.
    // Both carry a white edge and a dark hairline halo, so they hold on the
    // dark chart, the light Relief base and satellite imagery alike.
    const id = `vesselHull${++vesselElementSeq}`;
    const arrow = document.createElement('div');
    arrow.className = 'vessel-arrow';
    arrow.style.cssText = `
        width: 28px; height: 28px;
        position: relative; z-index: 2;
    `;
    arrow.innerHTML = `
        <svg viewBox="0 0 24 24" width="28" height="28" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="display:block;overflow:visible;filter:${GLYPH_HALO}">
            <defs>
                <linearGradient id="${id}" x1="12" y1="2" x2="12" y2="22" gradientUnits="userSpaceOnUse">
                    <stop offset="0" stop-color="#38bdf8"/>
                    <stop offset="1" stop-color="#0284c7"/>
                </linearGradient>
            </defs>
            <g class="vessel-directional-shape" style="display:none">
                <path d="${HULL_PATH}" fill="url(#${id})" stroke="white" stroke-width="1.5" stroke-linejoin="round"/>
                <rect x="9.6" y="10.4" width="4.8" height="6.6" rx="1.7" fill="rgba(255,255,255,0.32)"/>
                <circle cx="12" cy="8.4" r="1.15" fill="white"/>
            </g>
            <g class="vessel-neutral-shape">
                <path d="${MAINSAIL_PATH}" fill="#f0f9ff" stroke="#0369a1" stroke-width="1.1" stroke-linejoin="round"/>
                <path d="${JIB_PATH}" fill="#f0f9ff" stroke="#0369a1" stroke-width="1.1" stroke-linejoin="round"/>
                <path d="${SIDE_HULL_PATH}" fill="url(#${id})" stroke="white" stroke-width="1.4" stroke-linejoin="round"/>
            </g>
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

    // Her own wind (build 123, W1-WC) — hidden until the overlay publishes a
    // reading the field is not showing (below zoom 14, or the leaflet field
    // further out). Its own chip, never part of the badge, so the badge's
    // words, colours and precedence stay exactly theirs. Under the boat,
    // centred on her fix: beside the badge it ran under the right-rail zoom
    // control, which on a 320 px phone sits level with the centred boat. Only
    // the chip is offset; Mapbox keeps the root's exact GPS anchor.
    const windChip = document.createElement('div');
    windChip.className = `vessel-wind-chip rounded-lg border bg-slate-900/94 ${WIND_CHIP_TONE_CLASS.live.join(' ')}`;
    windChip.dataset.tone = 'live';
    windChip.style.cssText = `
        position: absolute; top: calc(50% + ${WIND_CHIP_TOP_PX}px); left: 50%;
        transform: translateX(-50%);
        align-items: center; gap: 3px;
        padding: 1px 6px;
        font-size: 12px; font-weight: 800;
        line-height: 1.25;
        white-space: nowrap;
        letter-spacing: 0.03em;
        z-index: 3;
        display: none;
    `;
    // The arrow points north at rest and turns to where the wind blows TO, the
    // way the streaks fly, less the chart's bearing (turnOwnshipArrows).
    windChip.innerHTML =
        '<span class="vessel-wind-arrow" aria-hidden="true" style="display:block;width:12px;height:12px;flex:none">' +
        '<svg viewBox="0 0 12 12" width="12" height="12" fill="currentColor" style="display:block">' +
        '<path d="M6 0.6 10.4 6.4H7.3V11.4H4.7V6.4H1.6Z"/></svg></span>' +
        '<span class="vessel-wind-text"></span>';
    el.appendChild(windChip);

    return el;
}

/**
 * Paint her wind chip, or hide it (null), and return the marker's spoken words
 * for it ('' when hidden). Touches the DOM only when its words, its arrow's
 * 5 degree step or its tone change: the overlay re-reads her instruments every
 * tick, and a marker repainting per tick is the WebContent memory history this
 * app has. Exported for the layout spec.
 */
export function presentOwnshipWind(el: HTMLElement, chip: BoatWindChip | null, mapBearing = 0): string {
    const node = el.querySelector<HTMLElement>('.vessel-wind-chip');
    if (!node) return '';
    const spoken = chip ? chip.label.charAt(0).toLowerCase() + chip.label.slice(1) : '';
    const signature = chip ? `${chip.text}|${chip.arrowDeg ?? '-'}|${chip.stale ? 'stale' : 'live'}` : '';
    if ((node.dataset.signature ?? '') === signature) return spoken;
    node.dataset.signature = signature;
    if (!chip) {
        node.style.display = 'none';
        node.removeAttribute('role');
        node.removeAttribute('aria-label');
        return '';
    }
    const arrow = node.querySelector<HTMLElement>('.vessel-wind-arrow');
    const text = node.querySelector<HTMLElement>('.vessel-wind-text');
    if (text && text.textContent !== chip.text) text.textContent = chip.text;
    if (arrow) {
        arrow.style.display = chip.arrowDeg === null ? 'none' : 'block';
        arrow.dataset.deg = chip.arrowDeg === null ? '' : String(chip.arrowDeg);
        turnOwnshipArrows(el, mapBearing);
    }
    const tone = chip.stale ? 'stale' : 'live';
    if (node.dataset.tone !== tone) {
        node.dataset.tone = tone;
        node.classList.remove(...WIND_CHIP_TONE_CLASS.live, ...WIND_CHIP_TONE_CLASS.stale);
        node.classList.add(...WIND_CHIP_TONE_CLASS[tone]);
    }
    node.setAttribute('role', 'img');
    node.setAttribute('aria-label', chip.label);
    node.style.display = 'flex';
    return spoken;
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

/** The badge's anchor words: they hold the badge, and the fix age moves to the chip. */
const ANCHOR_LABELS: ReadonlySet<string> = new Set(['Anchor alarm', 'Drifting', 'Anchored']);

/**
 * Paint the badge, its colour and the marker's grey from the one fix state,
 * and return what the marker's spoken name says of them. The words come from
 * ownshipStatus; this only presents them. An anchor word takes the anchor
 * watch row's own colour (green only while it holds; red when it has lost its
 * data; amber while it expires, waits or has no updates here). Exported for
 * the layout spec.
 */
export function presentOwnshipStatus(el: HTMLElement, status: OwnshipStatusPresentation, fix: GpsFixState): string {
    const badge = el.querySelector('.vessel-sog-badge') as HTMLElement | null;
    if (!badge) return '';
    const { label, anchorTone, anchorNote } = status;
    badge.textContent = label;
    const tier = gpsAgeTier(fix);
    const anchorLabel = ANCHOR_LABELS.has(label);
    const tone = anchorLabel
        ? anchorTone === 'green'
            ? 'anchored'
            : anchorTone === 'amber'
              ? 'caution'
              : // An anchor word with no tone of its own is never the calm green.
                'alarm'
        : tier === 'locked'
          ? 'live'
          : tier;
    badge.classList.remove(...Object.values(STATUS_TONE_CLASS));
    badge.classList.add(STATUS_TONE_CLASS[tone]);
    badge.dataset.tone = tone;
    const chipText = anchorLabel ? ownshipFixLabel(fix) : null;
    applyGpsAgeTier(el as HTMLDivElement, tier, chipText);
    // What the badge and chip show, in their own words: 'Last fix 46 s'
    // already says the position is old, and a softer hedge on top ('may be
    // stale') would be a second wording for the one fix state. The watch's
    // note is the row's own words for what the colour says.
    const spoken = [spokenOwnshipBadge(label)];
    if (anchorLabel && anchorNote) spoken.push(anchorNote);
    if (chipText) spoken.push(spokenOwnshipBadge(chipText));
    return spoken.join(', ');
}

/**
 * The marker's root stands upright on screen (OWNSHIP_MARKER_OPTIONS), so her
 * words never turn with the chart (127-11a, audit A4). Only her two arrows
 * do: the hull by its true bearing and her wind by where it blows to, each
 * less the chart's bearing. Each holds its true bearing in data-deg (empty:
 * no direction, so upright); this writes only a transform that changed.
 */
export function turnOwnshipArrows(el: HTMLElement, mapBearing: number): void {
    const bearing = Number.isFinite(mapBearing) ? mapBearing : 0;
    for (const arrow of el.querySelectorAll<HTMLElement>('.vessel-arrow, .vessel-wind-arrow')) {
        const deg = arrow.dataset.deg;
        const next = deg
            ? `rotate(${Number(deg) - bearing}deg)`
            : arrow.classList.contains('vessel-arrow')
              ? 'rotate(0deg)'
              : '';
        if (arrow.style.transform !== next) arrow.style.transform = next;
    }
}

/**
 * Point the boat: the top-down hull along a known direction, else the upright
 * side-on boat. Returns the spoken half of the marker's name. Exported for the
 * layout spec.
 */
export function presentOwnshipDirection(el: HTMLElement, direction: OwnshipDirection, mapBearing = 0): string {
    const arrow = el.querySelector('.vessel-arrow') as HTMLElement | null;
    if (!arrow) return 'heading unavailable';
    el.dataset.directionSource = direction.source;
    arrow.dataset.deg = direction.degrees === null ? '' : String(direction.degrees);
    turnOwnshipArrows(el, mapBearing);
    const shape = arrow.querySelector('.vessel-directional-shape') as SVGElement | null;
    const neutral = arrow.querySelector('.vessel-neutral-shape') as SVGElement | null;
    if (shape) shape.style.display = direction.degrees === null ? 'none' : '';
    if (neutral) neutral.style.display = direction.degrees === null ? '' : 'none';
    return direction.source === 'heading'
        ? `bow heading ${Math.round(direction.degrees)}° true`
        : direction.source === 'course'
          ? `course over ground ${Math.round(direction.degrees)}° true; bow heading unavailable`
          : 'heading unavailable';
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
                    // The marker stands upright on a turned chart (127-11a); so does its box.
                    'icon-rotation-alignment': 'viewport',
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
// Only the base style's own settlement layers (Mapbox `composite`, an
// OpenMapTiles-schema style's `openmaptiles`) and only town and suburb names
// are ever touched: never ENC, seamark, navaid, AIS, route, waypoint, MOB or
// hazard labels, and never an
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
    const wind = el.querySelector<HTMLElement>('.vessel-wind-chip');
    const words = (text: string | null | undefined) => (text ?? '').replace(/\d/g, '0');
    // Her wind chip (W1-WC) is part of what a town name must clear too.
    const windWords = wind && wind.style.display !== 'none' ? words(wind.textContent) : '-';
    return `${words(badge?.textContent)}|${chip?.style.display ?? ''}|${words(chip?.textContent)}|${windWords}`;
}

/**
 * The badge, a showing age chip and her showing wind chip, as rects relative to the marker's centre
 * (which is the drawn fix). Measured only when what the chips say changes, or
 * the camera settles, never per fix: that is a forced layout.
 */
function measureChipOffsets(el: HTMLElement): ScreenRect[] {
    const origin = el.getBoundingClientRect();
    const cx = origin.left + origin.width / 2;
    const cy = origin.top + origin.height / 2;
    const out: ScreenRect[] = [];
    for (const part of el.querySelectorAll<HTMLElement>('.vessel-sog-badge, .vessel-age-chip, .vessel-wind-chip')) {
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
const BASE_IMAGERY_LAYERS = ['satellite-base-layer', 'hybrid-base-layer'] as const;

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

export interface VesselTrackerOptions {
    /** The boats Obs can name: the marker is spoken as her ('Kittiwake, stopped'). */
    names?: ObsBoatNames;
    /**
     * Ask the boat's chain (her Pi, her cloud row) while her bus is not here.
     * MapHub sets it while Obs is on screen; off it, the marker shows what
     * this device already holds and asks no one.
     */
    lookUp?: boolean;
    /** The user's speed unit (settings.units.speed) for her wind chip (W1-WC); knots when unset. */
    windSpeedUnit?: string;
}

/** How often the marker asks her chain while her bus is not here; the chain throttles each lane to 30 s. */
export const OWNSHIP_LOOKUP_EVERY_MS = 5_000;

/**
 * On Obs, signed in, before the own boat's chain has answered once this
 * session, the phone is not drawn as own ship for at most this long: it would
 * flash up as 'Own ship' at the phone and hand the marker to the boat a moment
 * later. A phone-only punter's marker waits for that one look (or this cap).
 */
export const OWNSHIP_FIRST_LOOK_HOLD_MS = 2_000;

/** The marker's own receiver of last resort: none. The boat's branch hands the arbiter no phone. */
const NO_PHONE_LOCATION = { lat: Number.NaN, lon: Number.NaN, source: 'none', timestamp: 0 } as const;

/** What the marker last drew, and from whom. */
interface MarkerDrawn {
    position: TrackerPosition;
    /** The boat's receivers, not the phone. */
    viaVessel: boolean;
    identity: OwnshipMarkerIdentity;
    /** Her row's own speed, course and heading (Pi and cloud lanes); the bus reads the store. */
    instruments: DirectionInstruments | null;
}

/**
 * The bus's speed in m/s for the marker while the store's SOG is fresh, else
 * null: unknown ('SOG —'). The arbiter's own `sog` is 0 when the reading is
 * missing or stale, which the badge would call 'Stopped' on a moving boat.
 */
function busSpeedMs(store: Parameters<typeof resolveOwnshipPosition>[0], now: number): number | null {
    const knots = freshMovementMetric(store.sog, now);
    return knots === null ? null : knots / 1.94384;
}

const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Her row's speed, course and heading as dated readings, for the direction resolver. */
function laneInstruments(fix: VesselMarkerFix): DirectionInstruments {
    const reading = (value: number | null, at: number | null) =>
        value === null || at === null ? undefined : { value, lastUpdated: at, freshness: 'live' };
    return {
        headingTrue: reading(fix.headingTrueDeg, fix.headingTrueAt),
        sog: reading(fix.sogKts, fix.timestamp),
        cog: reading(fix.cogDeg, fix.timestamp),
    };
}

/** How long the drawn fix counts as live, by the lane it came down (gpsFixState's gates). */
function laneLiveMaxAgeMs(lane: OwnshipMarkerIdentity['lane']): number {
    if (lane === 'bus') return boatLiveFixMaxAgeMs(NmeaStore.getState());
    if (lane === 'pi' || lane === 'cloud') return REMOTE_LANE_LIVE_MAX_AGE_MS;
    // History is never live: a held fix always reads 'Last fix 3 h'.
    if (lane === 'held') return -1;
    return PHONE_LIVE_FIX_MAX_AGE_MS;
}

const UNKNOWN_DIRECTION: OwnshipDirection = { degrees: null, source: 'unknown' };

export function useVesselTracker(
    mapRef: MutableRefObject<mapboxgl.Map | null>,
    mapReady: boolean,
    visible: boolean,
    options: VesselTrackerOptions = {},
) {
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
    const lastMarkerPositionRef = useRef<MarkerDrawn | null>(null);
    /** The two halves of the marker's spoken name: what its chip says, and which way she points. */
    const spokenStatusRef = useRef('');
    const spokenDirectionRef = useRef('heading unavailable');
    /** Set by the effect: re-checks the one place label own-ship would print through. */
    const placeLabelSyncRef = useRef<(() => void) | null>(null);
    /** Whose position the marker draws (ownshipMarkerSubject); the trail, swing and clocks are this subject's. */
    const subjectRef = useRef<OwnshipSubject>({ kind: 'phone' });
    /** The subject the trail, the swing and the fix clocks belong to; null before the first. */
    const trailSubjectRef = useRef<OwnshipSubject | null>(null);
    /** The boat's last fix the trail took, so a repaint of the same fix never adds it twice. */
    const lastTrailFixRef = useRef<string | null>(null);
    const namesRef = useRef<ObsBoatNames | undefined>(options.names);
    namesRef.current = options.names;
    const lookUpRef = useRef(options.lookUp === true);
    lookUpRef.current = options.lookUp === true;
    const windUnitRef = useRef(options.windSpeedUnit);
    windUnitRef.current = options.windSpeedUnit;
    /** Her wind chip's spoken words (W1-WC), '' while it is hidden. */
    const spokenWindRef = useRef('');
    /** For MapHub: the phone gets a dot of its own only while the marker is a boat. */
    const [subjectKind, setSubjectKind] = useState<OwnshipSubject['kind']>('phone');

    /** What the marker is called: her name, or 'Own ship'. */
    const markerName = useCallback(() => {
        const subject = subjectRef.current;
        if (subject.kind === 'phone') return 'Own ship';
        const names = namesRef.current;
        if (subject.crewOwnerId) {
            const name = names?.crew?.ownerId === subject.crewOwnerId ? names.crew.name?.trim() : null;
            return name || capitalise(SKIPPER_BOAT_FALLBACK);
        }
        return names?.own?.trim() || 'Own ship';
    }, []);

    // One img, one name: its status chip is a child the name must carry, or
    // VoiceOver never hears 'Stopped' or that the fix is 54 s old (UX scorecard
    // run 10). 'Kittiwake, last fix 54 seconds ago; heading unavailable': the
    // chip's own words and nothing more, so the name can never say something
    // the chip and gpsFixState do not. Her wind chip, when it shows, follows
    // after them ('; boat wind 14 knots from south-south-west'): it never
    // takes the badge's place in the name.
    const nameMarker = useCallback(
        (el: HTMLElement) => {
            const status = spokenStatusRef.current;
            const wind = spokenWindRef.current;
            const label = `${markerName()}${status ? `, ${status}` : ''}; ${spokenDirectionRef.current}${wind ? `; ${wind}` : ''}`;
            if (el.getAttribute('aria-label') === label) return;
            el.setAttribute('role', 'img');
            el.setAttribute('aria-label', label);
            el.title = label;
        },
        [markerName],
    );

    const mapBearing = useCallback(() => {
        const map = mapRef.current as (mapboxgl.Map & { getBearing?: () => number }) | null;
        try {
            return map && typeof map.getBearing === 'function' ? map.getBearing() : 0;
        } catch {
            return 0;
        }
    }, [mapRef]);

    const updateDirection = useCallback(() => {
        const last = lastMarkerPositionRef.current;
        const el = elementRef.current;
        if (!last || !el) return;
        const { lane } = last.identity;
        // History has no bow; her row's readings are as old as its position;
        // the bus and the phone read their own live sources.
        const direction =
            lane === 'held'
                ? UNKNOWN_DIRECTION
                : lane === 'pi' || lane === 'cloud'
                  ? resolveOwnshipDirection(
                        last.position,
                        true,
                        last.instruments ?? {},
                        Date.now(),
                        REMOTE_LANE_LIVE_MAX_AGE_MS,
                    )
                  : resolveOwnshipDirection(last.position, last.viaVessel, NmeaStore.getState());
        spokenDirectionRef.current = presentOwnshipDirection(el, direction, mapBearing());
        nameMarker(el);
    }, [nameMarker, mapBearing]);

    // The badge's words, its colour and the marker's grey all come from ONE
    // fix state: lastFixAtRef through the lane's live gate — the gates the
    // System status box uses (components/gpsFixState.ts). A fix past its gate
    // is 'Last fix 46 s' on a grey marker, never a live-looking 'Stopped'.
    const updateStatusBadge = useCallback(() => {
        const last = lastMarkerPositionRef.current;
        const el = elementRef.current;
        if (!last || !el) return;
        const now = Date.now();
        const fix = gpsFixState(
            lastFixAtRef.current[last.viaVessel ? 'vessel' : 'phone'],
            laneLiveMaxAgeMs(last.identity.lane),
            now,
        );
        const status = ownshipStatus(
            last.position,
            last.identity,
            {
                local: AnchorWatchService.getSnapshot(),
                shore: ShoreWatchAlarmService.getSnapshot(),
                // No listener: the 1 s ticker re-reads it.
                piSessionCode: AnchorPiWatchKeeper.keepingSessionCode(),
            },
            now,
            fix,
        );
        spokenStatusRef.current = presentOwnshipStatus(el, status, fix);
        nameMarker(el);
    }, [nameMarker]);

    // Her own wind (W1-WC), as the overlay publishes it, only on the boat it
    // is for and only where the field is not showing it (boatWindChipFor).
    // The painter writes the DOM only when what the chip says changes.
    const updateWindChip = useCallback(() => {
        const el = elementRef.current;
        if (!el) return;
        spokenWindRef.current = presentOwnshipWind(
            el,
            boatWindChipFor(getBoatWindReadout(), subjectRef.current, windUnitRef.current),
            mapBearing(),
        );
        nameMarker(el);
    }, [nameMarker, mapBearing]);

    const updateMarker = useCallback(
        (
            pos: TrackerPosition,
            identity: OwnshipMarkerIdentity = { owner: 'phone', lane: 'phone' },
            fixAt: number | null = pos.timestamp,
            instruments: DirectionInstruments | null = null,
        ) => {
            const map = mapRef.current;
            if (!map || !visible) return;

            const viaVessel = identity.lane !== 'phone';
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
                markerRef.current = new mapboxgl.Marker({ element: el, ...OWNSHIP_MARKER_OPTIONS })
                    .setLngLat([longitude, latitude])
                    .addTo(map);
                log.info('Vessel marker created');
                // A new marker wears her wind at once, not at the next reading.
                updateWindChip();
            } else {
                markerRef.current.setLngLat([longitude, latitude]);
            }
            // A quiet tell for anyone debugging which truth the boat is on.
            if (elementRef.current) {
                elementRef.current.dataset.source = viaVessel ? 'vessel' : 'phone';
                elementRef.current.dataset.lane = identity.lane;
            }

            // Anchor state is explicit, never inferred from a low GPS speed.
            lastMarkerPositionRef.current = { position: pos, viaVessel, identity, instruments };
            updateDirection();
            updateStatusBadge();
            // After the badge: its width is part of what a town name must clear.
            placeLabelSyncRef.current?.();

            // History never draws a wake: her held fix is where she WAS.
            if (identity.lane === 'held') return;
            // The boat's chain is re-read every second; the same fix is one point.
            if (subjectRef.current.kind === 'boat') {
                const key = `${longitude},${latitude},${fixAt ?? ''}`;
                if (key === lastTrailFixRef.current) return;
                lastTrailFixRef.current = key;
            }

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
        [mapRef, visible, updateStatusBadge, updateDirection, updateWindChip],
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

        /** The marker goes: no position for its subject (a boat with no fix is never drawn at the phone). */
        const dropMarker = () => {
            if (markerRef.current) {
                markerRef.current.remove();
                markerRef.current = null;
                elementRef.current = null;
            }
            lastMarkerPositionRef.current = null;
            lastLookKey = null;
            if (map) {
                syncOwnshipObstacle(map, null);
                syncOwnshipPlaceLabel(map, null);
            }
        };

        /** A new subject's story starts clean: its own trail, swing, fix clocks and last fix. */
        const startSubjectStory = () => {
            trailCoordsRef.current = [];
            swingPointsRef.current = [];
            lastSourceRef.current = null;
            vesselSpokeRef.current = false;
            lastFixAtRef.current = { vessel: null, phone: null };
            lastTrailFixRef.current = null;
            if (map) {
                removeTrailLayers(map);
                removeSwingLayers(map);
            }
        };

        // ── The boat: her own chain, exactly as the Obs camera reads it ──
        // Never the phone, wherever it is: no position from her is no marker.
        const paintBoat = (crewOwnerId: string | null) => {
            const now = Date.now();
            const owner: OwnshipMarkerIdentity['owner'] = crewOwnerId ? 'crew' : 'own';
            let fix: VesselMarkerFix | null = vesselMarkerFixNow(crewOwnerId, now);
            // Her lane went quiet this session: she is where she last reported,
            // as history, never an older held fix (ownshipBoatFix keeps her
            // newest dated fix per boat for the session, across remounts).
            const seen = seenVesselFix(crewOwnerId);
            if (seen && (!fix || (fix.lane === 'held' && (fix.timestamp ?? 0) < seen.timestamp))) {
                fix = { ...seen, lane: 'held', sogKts: null, cogDeg: null, headingTrueDeg: null, headingTrueAt: null };
            }
            if (!fix) {
                dropMarker();
                return;
            }
            if (fix.lane === 'bus') {
                // Her bus on this phone (a gateway socket, or the Pi over the
                // boat LAN): the instruments themselves, as always.
                const store = NmeaStore.getState();
                const own = NmeaStore.isBoatFeed() ? resolveOwnshipPosition(store, NO_PHONE_LOCATION) : null;
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
                    // Another device's shared row keeps its receipt time.
                    const remote = store.connectionStatus === 'remote' ? store.remote : null;
                    const sampleAt = remote?.positionSampleAt;
                    const fixAt = !remote
                        ? own.timestamp
                        : typeof sampleAt === 'number' && Number.isFinite(sampleAt)
                          ? Math.min(sampleAt, own.timestamp)
                          : remote.source === 'pi'
                            ? null
                            : own.timestamp;
                    rememberSeenVesselFix(crewOwnerId, {
                        lat: own.lat,
                        lon: own.lon,
                        timestamp: fixAt,
                        lane: 'bus',
                        sogKts: null,
                        cogDeg: null,
                        headingTrueDeg: null,
                        headingTrueAt: null,
                    });
                    updateMarker(
                        {
                            latitude: own.lat,
                            longitude: own.lon,
                            accuracy: 15,
                            altitude: null,
                            // Direction comes from independently timestamped
                            // metrics, not the arbiter's numeric-zero fallback.
                            heading: null,
                            // Her store's own SOG while it is fresh; unknown is
                            // 'SOG —', never the arbiter's stand-in 0 ('Stopped').
                            speed: busSpeedMs(store, now),
                            timestamp: own.timestamp,
                            receivedAt: now,
                        },
                        { owner, lane: 'bus' },
                        fixAt,
                    );
                    return;
                }
            }
            rememberSeenVesselFix(crewOwnerId, fix);
            updateMarker(
                {
                    latitude: fix.lat,
                    longitude: fix.lon,
                    accuracy: 15,
                    altitude: null,
                    heading: null,
                    // Her row speaks knots; the marker eats m/s. No speed is unknown, never 0.
                    speed: fix.sogKts === null ? null : fix.sogKts / 1.94384,
                    // Undated (her row without the Pi's sample time): no bow, and
                    // fixAt null leaves the fix clock alone, so the badge says
                    // 'No fix' or 'Last fix' on a grey boat, never a live 'Stopped'.
                    timestamp: fix.timestamp ?? 0,
                    receivedAt: now,
                },
                { owner, lane: fix.lane },
                fix.timestamp,
                fix.lane === 'held' ? null : laneInstruments(fix),
            );
        };
        // ── end paintBoat

        // ── The phone's first-look hold (OWNSHIP_FIRST_LOOK_HOLD_MS) ──
        // Until the own boat's chain has been asked once this session, the
        // phone is not yet known to be all the boat has: drawing it as own ship
        // flashed the phone up as 'Own ship · Stopped' where the chart centres,
        // then the marker jumped to the boat a second later. Off Obs (nothing
        // asks), signed out (no boat to ask for), or past the cap: no hold.
        const holdPhoneUntil = Date.now() + OWNSHIP_FIRST_LOOK_HOLD_MS;
        let phoneReleased = false;
        /** The phone watch's newest position, for the paint the hold's release owes it. */
        let lastPhone: Parameters<typeof paintPhone>[0];
        const phoneHeld = () => {
            if (phoneReleased) return false;
            const holding =
                lookUpRef.current &&
                getAuthIdentityScope().userId !== null &&
                !ownBoatLookedUp() &&
                Date.now() < holdPhoneUntil;
            if (!holding) phoneReleased = true;
            return holding;
        };
        const releasePhone = () => {
            if (phoneReleased || disposed) return;
            phoneReleased = true;
            if (subjectRef.current.kind === 'phone' && lastPhone) paint(lastPhone);
        };
        const phoneHoldTimer = window.setTimeout(releasePhone, OWNSHIP_FIRST_LOOK_HOLD_MS);

        // A punter whose phone is all the boat has: the ownship arbiter, as
        // it always was. The phone watch is both the fallback position and a
        // repaint tick; NMEA repaints through its own subscription below.
        const paintPhone = (phone?: {
            latitude: number;
            longitude: number;
            accuracy?: number | null;
            altitude?: number | null;
            heading?: number | null;
            speed?: number | null;
            timestamp?: number | null;
        }) => {
            if (phone) lastPhone = phone;
            const store = NmeaStore.getState();
            const own = resolveOwnshipPosition(store, LocationStore.getState());
            if (own && own.source === 'nmea') {
                // Dated as the boat's branch dates her bus (see paintBoat).
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
                        heading: null,
                        speed: busSpeedMs(store, Date.now()),
                        timestamp: own.timestamp,
                        receivedAt: Date.now(),
                    },
                    { owner: 'own', lane: 'bus' },
                    fixAt,
                );
                return;
            }
            if (!phone || phoneHeld()) return;
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

        const paint = (phone?: Parameters<typeof paintPhone>[0]) => {
            const subject = subjectRef.current;
            if (subject.kind === 'boat') paintBoat(subject.crewOwnerId);
            else paintPhone(phone);
        };

        // Passive foreground watch, held only while the marker IS the phone:
        // it consumes an existing Location grant but never initializes
        // background tracking or raises permission UI merely because the
        // chart was restored at launch. A boat's marker never reads it.
        let unsubPhone: (() => void) | null = null;
        const syncPhoneWatch = () => {
            const wanted = subjectRef.current.kind === 'phone';
            if (wanted && !unsubPhone) unsubPhone = GpsService.watchPosition((pos) => paint(pos));
            else if (!wanted && unsubPhone) {
                unsubPhone();
                unsubPhone = null;
            }
        };

        /** Re-read whose position the marker draws; a new subject starts its own story. `force`: an account change. */
        const resolveSubject = (force = false) => {
            let next: OwnshipSubject;
            try {
                next = ownshipMarkerSubject(Date.now());
            } catch {
                next = { kind: 'phone' };
            }
            const before = trailSubjectRef.current;
            subjectRef.current = next;
            if (force || !before || !sameOwnshipSubject(before, next)) {
                if (before) {
                    startSubjectStory();
                    dropMarker();
                }
                trailSubjectRef.current = next;
            }
            setSubjectKind(next.kind);
            syncPhoneWatch();
            // Whose marker this is decides whose wind it may wear.
            updateWindChip();
        };
        resolveSubject();

        // Ask her chain while her bus is not here (Obs on screen only), on
        // every re-check: the chain throttles each lane itself (30 s). A phone
        // subject keeps asking for the own boat too, so an own boat whose only
        // receiver is her cloud row is found whenever she answers, and once she
        // has, ownshipBoatFix keeps her the subject for the session (a failed
        // read shows her where she was, never the phone in her place).
        let asking = false;
        const askChain = () => {
            if (disposed || asking || !lookUpRef.current) return;
            const subject = subjectRef.current;
            if (subject.kind === 'boat' && vesselMarkerFixNow(subject.crewOwnerId, Date.now())?.lane === 'bus') return;
            asking = true;
            void lookUpVesselMarkerFix(subject.kind === 'boat' ? subject.crewOwnerId : null).finally(() => {
                asking = false;
                if (disposed) return;
                resolveSubject();
                paint();
                if (ownBoatLookedUp()) releasePhone();
            });
        };

        // The box moved (a pick, Switch boat, the crewing ending), or another
        // account signed in: whose boat this is may have changed.
        const onFollowChange = () => {
            resolveSubject();
            paint();
            askChain();
        };
        const onAccountChange = () => {
            resolveSubject(true);
            paint();
            askChain();
        };
        window.addEventListener(WEATHER_FOLLOW_TARGET_EVENT, onFollowChange);
        const unsubScope = subscribeAuthIdentityScope(onAccountChange);
        const unsubBinders = subscribeSharedBinders(onFollowChange);

        // Her arrows stay true while the chart turns; her words stay upright.
        const onRotate = () => {
            if (elementRef.current) turnOwnshipArrows(elementRef.current, mapBearing());
        };
        if (map && typeof map.on === 'function') map.on('rotate', onRotate);

        const unsubNmea = NmeaGpsProvider.onPosition(() => paint());
        const unsubDirection = NmeaStore.subscribe(updateDirection);
        const unsubAnchor = AnchorWatchService.subscribe(updateStatusBadge);
        const unsubSync = AnchorWatchSyncService.onStateChange(updateStatusBadge);
        const unsubShore = ShoreWatchAlarmService.subscribe(updateStatusBadge);
        const unsubWind = subscribeBoatWindReadout(updateWindChip);
        paint();
        askChain();
        const lookUpTimer = window.setInterval(askChain, OWNSHIP_LOOKUP_EVERY_MS);

        // Staleness ticker — the only path that can grey the marker once
        // fixes STOP arriving (see lastFixAtRef comment). The badge update
        // applies the tier from the same fix state as its words. For a boat
        // it also re-reads her chain, which the Pi and cloud lanes refresh
        // without telling anyone.
        const staleTicker = window.setInterval(() => {
            resolveSubject();
            // A boat's repaint updates her badge and bow as it goes.
            if (subjectRef.current.kind === 'boat') paint();
            if (!elementRef.current || !lastMarkerPositionRef.current) return;
            if (subjectRef.current.kind === 'phone') {
                updateStatusBadge();
                updateDirection();
            }
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
            window.clearInterval(lookUpTimer);
            window.clearTimeout(phoneHoldTimer);
            disposed = true;
            clearSettleTimer();
            dropLabelIdleRun();
            placeLabelSyncRef.current = null;
            if (map && typeof map.off === 'function') {
                map.off('moveend', onMoveEnd);
                map.off('rotate', onRotate);
            }
            window.removeEventListener(WEATHER_FOLLOW_TARGET_EVENT, onFollowChange);
            unsubScope();
            unsubBinders();
            unsubPhone?.();
            unsubPhone = null;
            unsubNmea();
            unsubDirection();
            unsubAnchor();
            unsubSync();
            unsubShore();
            unsubWind();
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
    }, [mapReady, visible, updateMarker, updateStatusBadge, updateDirection, updateWindChip, mapRef, mapBearing]);

    // A new speed unit repaints her wind chip at once.
    useEffect(() => {
        updateWindChip();
    }, [options.windSpeedUnit, updateWindChip]);

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

    return { clearTrail, subject: subjectKind };
}
