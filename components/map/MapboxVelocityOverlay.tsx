/**
 * MapboxVelocityOverlay — Draws the selected wind on the existing Mapbox GL map.
 *
 * Data pipeline:
 *   1. Receives the selected model's reactive WindStore grid
 *   2. Converts its current (possibly fractional) forecast frame to U/V records
 *   3. Renders a static wind-speed heatmap below labels
 *   4. Optionally renders a native Canvas2D particle field
 *
 * Cleanup: removes owned canvases, listeners and animation frames.
 *
 * CLOSE-IN MODE (Shane 2026-10-06, z14 over Airlie: "i turned wind on, but
 * nothing showed up"). Once the screen spans under 1.5 cells of a fixed
 * 0.25 deg reference, the chart's finest fetch tier (about z10 on a phone,
 * whatever lattice is cached; closeInWind.ts), the geo field hands over to
 * CloseInWindLayer: the local wind as one screen-space flow, from the boat's
 * true-wind instruments when they are usable, the boat is on screen, the
 * scrubber is at now and the location box follows her (Shane 2026-10-06:
 * the phone's Current Location or a chosen place never borrows the boat's
 * gear), else the selected model at the screen centre for the scrubbed hour.
 * The instruments are hers from whichever lane carries them: the store (the
 * bus, or the Pi over the LAN), else her own cloud row through the boat chain,
 * which is the only lane Obs reads ashore (Shane 2026-10-07).
 * The two cross-fade, with hysteresis, and the geographic field
 * is torn down rather than left animating underneath.
 *
 * HER WIND ON HER ICON (build 123, W1-WC). Her own wind paints the field only
 * in at zoom 14; further out the model does (Shane 2026-10-07: "as soon as the
 * punter zooms out from there, then the wind models kick in"). So wherever the
 * field is not showing her wind, this publishes it for her own-ship marker
 * (boatWindReadout), from the very reading the close-in field takes, with
 * whether the field is painting it: the two never both claim it.
 *
 * Usage:
 *   <MapboxVelocityOverlay mapboxMap={mapboxInstance} visible />
 */

import React, { useEffect, useRef, useState } from 'react';
import type { WindGrid } from '../../services/weather/windGridEncoding';
import { createLogger } from '../../utils/createLogger';
import { particleScale } from '../../utils/deviceTier';
import { NmeaStore, type TimestampedMetric } from '../../services/NmeaStore';
import { boatLinkIfConfigured } from '../../services/boatLink/boatLinkGate';
import { resolveOwnshipPosition } from '../../services/ownshipPosition';
import { LocationStore } from '../../stores/LocationStore';
import { WEATHER_FOLLOW_TARGET_EVENT } from '../../services/weatherPosition';
import {
    boatInstrumentsFollowed,
    followedBoatCloudWind,
    followedBoatSubject,
    lookUpFollowedBoatWind,
} from './obsBoatInstruments';
import type { WindPalette } from './windRamp';
import { MapboxWindField } from './MapboxWindField';
import { windGridFrameToVelocityData } from './windVelocityFrame';
import { CloseInWindLayer } from './CloseInWindLayer';
import {
    boatWindZoomFor,
    closeInModeFor,
    isWindScrubAtNow,
    PI_LAN_WIND_MAX_AGE_MS,
    pickBoatTrueWind,
    resolveCloseInWind,
    sampleWindGridAt,
    setCloseInWindReadout,
    windFromVector,
    type BoatWind,
    type CloseInWindSource,
    type LocalWind,
} from './closeInWind';
import { getBoatWindReadout, resolveBoatWindReadout, setBoatWindReadout } from './boatWindReadout';
import { chartBearing } from './chartOrientation';
import type { WindParticleLayer } from './WindParticleLayer';
import { WindStore } from '../../stores/WindStore';

const log = createLogger('MapboxVelocityOverlay');
interface MapboxVelocityOverlayProps {
    mapboxMap: mapboxgl.Map | null;
    visible: boolean;
    /** Static wind speed stays on; this controls only the animated overlay. */
    particlesEnabled?: boolean;
    windHour?: number;
    windGrid?: WindGrid;
    /** The scrubber frame labelled Near now: the boat's instruments speak only there. */
    windNowIdx?: number;
    /**
     * The location box follows a receiver (Current Location). The boat's
     * instruments speak only then, and only when the box follows her
     * (obsBoatInstruments). A chosen place, or false: the model, always.
     */
    boatInstruments?: boolean;
    /**
     * Obs is on screen, so the followed boat's cloud row may be read for her
     * wind (on the boat chain's shared 30 s throttle). MapHub, and this
     * overlay with it, stays mounted behind other views: it must not read
     * the cloud for a chart nobody is looking at.
     */
    boatLookUp?: boolean;
    /**
     * The streak palette for the base under the field (127-DESKMAP-b): 'light'
     * draws dark ink under a white rim on the desk's Light chart by day; every
     * other base, and Obs, keeps today's white streaks and dark rim.
     */
    palette?: WindPalette;
}

// Speed-graded wind particle scale — blue → cyan → green → orange → red →
// pink → magenta → violet. Band table + bucket maths live in ./windRamp so the
// legend shares one definition instead of a hand-mirrored copy.

/**
 * Particle stroke width, in px. THE DIAL — change this one number if the wind
 * field wants more or less presence.
 *
 * Keep it thin, and know why. This canvas is a DOM overlay at z-index 400
 * spanning the whole map (see the container style below), so it draws over
 * LAND as well as water — and it sits above the Mapbox canvas that renders
 * place names. The library also composites additively ('lighter'), so trails
 * accumulate toward white where they cross (on the dark bases; Light's dark
 * ink is drawn normally, drawInkOver below).
 *
 * The option key is `particlelineWidth` — lowercase 'l' in "line":
 *   leaflet-velocity.js → `this.particleLineWidth = t.particlelineWidth || 1`
 * The code passed `lineWidth: 3.5` for months, which matched nothing, so it
 * silently rendered at the library default of 1. Correcting the key to the
 * literal 3.5 tripled the stroke and swamped every land label (Shane
 * 2026-07-21: "i have lost all of my names from the land area").
 *
 * So 1 is not a fallback here, it is the CHOSEN value: it is what the chart
 * looked like in the screenshot Shane asked to have restored, and it lets the
 * place names read through. The vivid speed ramp is what makes the wind stand
 * out now; the stroke does not have to.
 */
const PARTICLE_LINE_WIDTH = 1;
/** The chosen thin Light stroke remains 1.5 CSS px; native Retina backing keeps its core crisp. */
const lineWidthFor = (palette: WindPalette) => (palette === 'light' ? 1.5 : PARTICLE_LINE_WIDTH);

/**
 * How much of each trail survives a frame. leaflet-velocity's `opacity` is
 * the fade: every frame it keeps this fraction of what is already drawn
 * ('destination-in'), and draws new segments at 0.9 x this alpha. 0.97 is the
 * library default. The fade fill is drawn at the previous frame's globalAlpha
 * (0.9 x opacity), so the per-frame keep is 0.98 x 0.882 = 0.864 (was
 * 0.97 x 0.873 = 0.847): trails about 15% longer, not the 1.5x first claimed. Shane 2026-10-06: "make the wind sperm a bit longer and
 * a bit darker. but no extras".
 */
const PARTICLE_FADE = 0.98;

/**
 * A light dark edge on every streak, drawn by the browser over the whole
 * overlay. The overlay stays above every base layer (z-index 400); the wind
 * vanished on the Relief seas only because the 5-15 kt blues sat on Relief's
 * blues (contrast about 1.0-1.5; Shane 2026-10-06: "i cannot see it at all on
 * the relief + sat layer"). The streaks are now white below 20 kt (windRamp's
 * WIND_PARTICLE_COLORS), which reads on every Relief depth and on satellite;
 * this faint rim keeps them visible on the ENC chart's white deep water too.
 * Picked from side-by-sides over Relief 2-60 m, satellite and ENC white: a
 * heavier double rim made white streaks look muddy in the shallows.
 */
const PARTICLE_HALO = 'drop-shadow(0 0 0.75px rgba(0, 0, 0, 0.55))';
/** The same rim for dark ink on a pale base: white, a touch stronger. */
const haloFor = (palette: WindPalette) =>
    palette === 'light' ? 'drop-shadow(0 0 0.75px rgba(255, 255, 255, 0.7))' : PARTICLE_HALO;
// Direction is essential even in the broad synoptic view, so Wind begins at
// z3 rather than falling back to a speed-only heatmap. The field owns and
// cancels its RAF synchronously when a mode or viewport changes.
const MIN_PARTICLE_ZOOM = 3;

/** Preserve the existing z3 synoptic pace as the reference. */
const BASE_VELOCITY_SCALE = 0.015;
const VELOCITY_SCALE_REF_ZOOM = 3;

/** Smooth screen-speed taper, including the renderer's projection term. */
export function zoomCompensatedVelocityScale(mapboxZoom: number): number {
    const z = Number.isFinite(mapboxZoom)
        ? Math.min(22, Math.max(VELOCITY_SCALE_REF_ZOOM, mapboxZoom))
        : VELOCITY_SCALE_REF_ZOOM;
    return BASE_VELOCITY_SCALE * Math.pow(2, -VELOCITY_ZOOM_COMPENSATION * (z - VELOCITY_SCALE_REF_ZOOM));
}

// The renderer also projects degrees to pixels (×2 per zoom level). Combined
// with its area^0.4 term (×2^-0.8), apparent speed grows ×2^0.2 without a
// correction. The former POSITIVE compensation accelerated it further.
// A negative 0.4 exponent cancels that growth and slows screen motion smoothly
// ×2^-0.2 per level, retaining visible motion at z22 instead of freezing.
const VELOCITY_ZOOM_COMPENSATION = 0.4;

/**
 * PARTICLE COUNT, the ramp that never existed.
 *
 * leaflet-velocity sizes its population from CANVAS PIXEL AREA:
 *   particuleCount = round(canvas.width * canvas.height * particleMultiplier)
 * That has no zoom term at all, so the same number of particles is drawn
 * whether they cover an ocean or a bay — which is exactly why the tight end
 * looks like a swarm and the wide end looks like texture. Zooming in was
 * concentrating a fixed population into less and less sea.
 *
 * The multiplier now falls to a quarter across z3 -> z9, matching the count
 * ramp's intent. The wide end is untouched: at z3 this is exactly the
 * density that shipped.
 */
const BASE_PARTICLE_MULTIPLIER = 1 / 150;
const PARTICLE_ZOOM_TIGHT = 9;
const PARTICLE_MIN_DENSITY = 0.25;

export function zoomScaledParticleMultiplier(mapboxZoom: number): number {
    if (!Number.isFinite(mapboxZoom)) return BASE_PARTICLE_MULTIPLIER;
    if (mapboxZoom > PARTICLE_ZOOM_TIGHT) {
        // Continue thinning beyond the old z9 ceiling. At z22 a phone retains
        // dozens of particles, not thousands; no reallocations per pinch frame.
        return (
            BASE_PARTICLE_MULTIPLIER *
            PARTICLE_MIN_DENSITY *
            Math.pow(2, -(Math.min(22, mapboxZoom) - PARTICLE_ZOOM_TIGHT) / 4)
        );
    }
    const span = PARTICLE_ZOOM_TIGHT - VELOCITY_SCALE_REF_ZOOM;
    const t = Math.min(1, Math.max(0, (mapboxZoom - VELOCITY_SCALE_REF_ZOOM) / span));
    return BASE_PARTICLE_MULTIPLIER * (1 - (1 - PARTICLE_MIN_DENSITY) * t);
}

const CROSSFADE_MS = 400;
/** Close-in holds through the geographic field startup/cross-fade. */
const FIELD_FADE_IN_DELAY_MS = 600;
/**
 * While the boat is the source, re-read it this often. Its freshness tiers run
 * on the sample clock, but the store only notifies on a sample or a watchdog
 * tick, and the watchdog is not running without a Pi pairing or a saved
 * gateway: a feed that stopped would otherwise hold its last value until the
 * next pan. Her cloud row is asked for on the same tick while Obs is showing;
 * the boat chain throttles the actual read to one per 30 s.
 */
const BOAT_RECHECK_MS = 2000;

/** Does the camera, as it has settled, call for close-in? (with hysteresis; the grid need only be there) */
function closeInFor(map: mapboxgl.Map, grid: WindGrid | undefined, wasCloseIn: boolean): boolean {
    try {
        const container = map.getContainer();
        return closeInModeFor(
            wasCloseIn,
            {
                zoom: map.getZoom(),
                widthPx: container.clientWidth,
                heightPx: container.clientHeight,
                centreLat: map.getCenter().lat,
            },
            grid,
        );
    } catch {
        return false;
    }
}

/**
 * The chart is not laid out: another page hides it (display:none) or split
 * view folds it to 0x0, while MapHub and this overlay stay mounted. A 0x0
 * container answers nothing about the view, so nothing is decided from it
 * (Shane 2026-10-09: her z14 wind gone after other pages, the model in its
 * place). A map that cannot be asked counts as measured, as before.
 */
function chartUnmeasured(map: mapboxgl.Map): boolean {
    try {
        const container = map.getContainer();
        return !(container.clientWidth > 0 && container.clientHeight > 0);
    } catch {
        return false;
    }
}

function prefersReducedMotion(): boolean {
    try {
        return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    } catch {
        return false;
    }
}

/**
 * Where the boat is, for "is the boat on screen": its own GPS through the
 * store (any lane: the Pi reports the boat's fix), else this phone's GPS but
 * only when this phone is WITH her by position (services/boatLink). Reading
 * her directly is not enough: the gateway or the Pi answers from 900 km away
 * over a VPN that carries her network (Shane 2026-10-07), and the phone's fix
 * then is the kitchen table's. The one exception is a bus with wind but no
 * GPS, where "aboard" can never be decided: a live direct feed with this
 * phone on the boat's own network and no VPN up stands in. With no Pi and no
 * gateway the boat link is not loaded (131-01), and while it loads nothing
 * says she is with this phone.
 */
function boatPosition(): { lat: number; lon: number } | null {
    const location = LocationStore.getState();
    const aboard = boatLinkIfConfigured()?.phoneStandsInForBoat() ?? false;
    const fix = resolveOwnshipPosition(NmeaStore.getState(), aboard ? location : { ...location, source: 'initial' });
    return fix ? { lat: fix.lat, lon: fix.lon } : null;
}

/**
 * Her live wind from the store: the gateway socket or the Pi over the boat
 * LAN, and only when the store's instruments are hers. Never the store's
 * cloud lane: the store stamps a cloud reading with the time this phone
 * received it, so a wind the Pi could not date (Signal K's cached value from
 * an instrument that is off) would read live while a screen holds the lane,
 * and the pill would flip between it and the model as that screen opened and
 * closed. Her cloud row is read through the boat chain instead, with the Pi's
 * own sample time (followedBoatCloudWind).
 */
function storeBoatWind(now: number = Date.now()): ReturnType<typeof pickBoatTrueWind> {
    const state = NmeaStore.getState();
    if (state.remote?.via === 'cloud' || !boatInstrumentsFollowed()) return null;
    // The model check's own gates (components/map/boatModelCheck assessHerWind),
    // so the field never paints 'Boat' from a reading that card would refuse.
    if (state.connectionStatus === 'connected') {
        // The store keeps a replaced remote feed's values for their 13 s,
        // stamped on receipt and perhaps never dated by the Pi: not the socket's.
        const after = NmeaStore.getRemoteFeedEndedAt();
        const own = (m: TimestampedMetric): TimestampedMetric => (m.lastUpdated > after ? m : { ...m, value: null });
        return pickBoatTrueWind(
            {
                tws: own(state.tws),
                twd: own(state.twd),
                twaSigned: own(state.twaSigned),
                headingTrue: own(state.headingTrue),
            },
            now,
        );
    }
    if (state.remote?.via === 'lan') {
        // Only a TWS the Pi itself dated: an undated one may be Signal K's
        // cached value from an instrument that is off, re-stamped on receipt.
        const sample = NmeaStore.getRemoteWindSample();
        if (!sample || sample.via !== 'lan' || sample.kts !== state.tws.value) return null;
        const age = now - sample.at;
        if (age < -1_000 || age > PI_LAN_WIND_MAX_AGE_MS) return null;
    }
    return pickBoatTrueWind(state, now);
}

/**
 * Her own wind now, read ONCE for both the close-in field and her icon, and
 * where its lane puts her (asked only by the close-in field, for "is she on
 * screen"). Her live store wind first (the bus, or the Pi over the LAN); else,
 * as ashore on Obs where nothing feeds the store (Shane 2026-10-07), her own
 * cloud row through the boat chain, placed where that row puts her, and that
 * even while a screen holds the store's cloud lane.
 */
function readHerWind(): { wind: BoatWind; at: () => { lat: number; lon: number } | null } | null {
    const storeBoat = storeBoatWind();
    if (storeBoat) return { wind: storeBoat, at: boatPosition };
    const cloud = followedBoatCloudWind();
    return cloud ? { wind: cloud.wind, at: () => ({ lat: cloud.lat, lon: cloud.lon }) } : null;
}

/** The model's wind at the camera's centre for this hour; null with no centre, or no grid there. */
function modelWindAtCentre(map: mapboxgl.Map, grid: WindGrid | null | undefined, hour: number): LocalWind | null {
    try {
        const centre = map.getCenter();
        const vector = sampleWindGridAt(grid, hour, centre.lat, centre.lng);
        return vector ? windFromVector(vector.u, vector.v) : null;
    } catch {
        // A torn-down map: no centre to sample.
        return null;
    }
}

/** Where she and the camera were when "is she on screen" was last measured. */
interface SeenAt {
    lat: number;
    lon: number;
    centre: { lat: number; lng: number };
    zoom: number;
    /** A turn alone moves her on screen (127-11a, A3). */
    bearing: number;
}

/** About 20 m: GPS jitter at a berth, a few pixels at z14. Any real move waits for a measurement. */
const SEEN_AT_SLACK_DEG = 0.0002;

/** She is where she was, under the same camera (a resize keeps centre, zoom and bearing); another boat followed is elsewhere. */
export function sameSeenAt(a: SeenAt, b: SeenAt): boolean {
    const near = (x: number, y: number) => Math.abs(x - y) <= SEEN_AT_SLACK_DEG;
    return (
        near(a.lat, b.lat) &&
        near(a.lon, b.lon) &&
        near(a.centre.lat, b.centre.lat) &&
        near(a.centre.lng, b.centre.lng) &&
        Math.abs(a.zoom - b.zoom) < 1e-6 &&
        Math.abs(a.bearing - b.bearing) < 1e-6
    );
}

function onScreen(map: mapboxgl.Map, lat: number, lon: number): boolean {
    try {
        const container = map.getContainer();
        const p = map.project([lon, lat]);
        return p.x >= 0 && p.y >= 0 && p.x <= container.clientWidth && p.y <= container.clientHeight;
    } catch {
        return false;
    }
}

// ── Component ─────────────────────────────────────────────────

export const MapboxVelocityOverlay: React.FC<MapboxVelocityOverlayProps> = ({
    mapboxMap,
    visible,
    particlesEnabled = true,
    windHour = 0,
    windGrid,
    windNowIdx,
    boatInstruments = false,
    boatLookUp = false,
    palette = 'dark',
}) => {
    const imported = windGrid?.importedGrib === true;
    const importedLayer = useRef<WindParticleLayer | null>(null);
    const overlayRef = useRef<HTMLDivElement | null>(null);
    const fieldRef = useRef<MapboxWindField | null>(null);
    const [particleZoomSupported, setParticleZoomSupported] = useState(() =>
        Boolean(mapboxMap && mapboxMap.getZoom() >= MIN_PARTICLE_ZOOM),
    );
    // Close-in is decided from the settled camera. Seeded on mount, so Obs
    // opening at z14 never starts the geographic field just to park it.
    const [closeIn, setCloseIn] = useState(() =>
        Boolean(mapboxMap && visible && particlesEnabled && closeInFor(mapboxMap, windGrid, false)),
    );
    // The field stays up through the cross-fade into close-in, then is torn down.
    const [fieldParked, setFieldParked] = useState(closeIn);
    // Track latest values so the async setup can apply the correct hour
    const windHourRef = useRef(windHour);
    const windGridPropRef = useRef(windGrid);
    const windNowIdxRef = useRef(windNowIdx);
    const boatInstrumentsRef = useRef(boatInstruments);
    windHourRef.current = windHour;
    windGridPropRef.current = windGrid;
    windNowIdxRef.current = windNowIdx;
    boatInstrumentsRef.current = boatInstruments && !imported;
    // Imported GRIB retains its WebGL renderer, bitmap coverage and separate
    // particle controls; it never borrows the boat's local instruments.
    const importedParticles = useRef(particlesEnabled);
    importedParticles.current = particlesEnabled;
    useEffect(() => {
        if (!mapboxMap || !visible || !imported) return;
        let live = true;
        let owned: WindParticleLayer | null = null;
        const id = 'imported-grib-wind';
        void import('./WindParticleLayer')
            .then(({ WindParticleLayer }) => {
                if (!live) return;
                owned = new WindParticleLayer(id);
                const attach = () => {
                    if (!live || !owned || !mapboxMap.isStyleLoaded() || mapboxMap.getLayer(id)) return;
                    try {
                        owned.setParticlesEnabled(importedParticles.current);
                        owned.setGrid(windGridPropRef.current!, windHourRef.current);
                        const labels = mapboxMap.getStyle()?.layers?.find((layer) => layer.type === 'symbol')?.id;
                        mapboxMap.addLayer(owned, labels);
                        importedLayer.current = owned;
                    } catch {
                        if (live) WindStore.setError('Imported wind could not be displayed on this chart.');
                    }
                };
                attach();
                mapboxMap.on('style.load', attach);
                if (!live) mapboxMap.off('style.load', attach);
                detach = () => mapboxMap.off('style.load', attach);
            })
            .catch(() => {
                if (live) WindStore.setError('Imported wind display is unavailable.');
            });
        let detach = () => {};
        return () => {
            live = false;
            detach();
            if (importedLayer.current === owned) importedLayer.current = null;
            try {
                if (owned && mapboxMap.getLayer(id)) mapboxMap.removeLayer(id);
            } catch {
                /* Map already removed. */
            }
        };
    }, [mapboxMap, visible, imported]);
    useEffect(() => {
        if (imported && windGrid) importedLayer.current?.setGrid(windGrid, windHour);
        // A changed frame is uploaded separately without rebuilding the grid.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [windGrid, imported]);
    useEffect(() => {
        importedLayer.current?.setForecastHour(windHour);
    }, [windHour]);
    useEffect(() => {
        importedLayer.current?.setParticlesEnabled(particlesEnabled);
    }, [particlesEnabled]);

    // The zoom gate's own memory (boatWindZoomFor's hysteresis), kept apart
    // from the source shown: a scrub away and back, a feed gap, her leaving
    // the screen or a mode flip the camera did not cause (a model switch)
    // must not cost her the slack while the camera sits still. Judged only
    // for a settled camera, here and in refreshCloseIn; mid-flight it holds
    // its last answer. Forgotten only when the camera goes unwatched.
    const boatZoomRef = useRef(false);

    // The OBS wind read is directional at every supported zoom. Wait for the
    // camera to settle before mounting/unmounting the particle engine so a z3
    // transition cannot fight Mapbox's zoom animation. The same settle decides
    // close-in, so a mode switch never lands mid-pinch either.
    useEffect(() => {
        if (!mapboxMap || !visible || !particlesEnabled) {
            setParticleZoomSupported(false);
            setCloseIn(false);
            // Nothing watches the camera now (wind off, MOB): a slack it
            // earned before cannot speak for wherever it settles meanwhile.
            boatZoomRef.current = false;
            return;
        }

        const updateParticleZoomSupport = () => {
            setParticleZoomSupported(mapboxMap.getZoom() >= MIN_PARTICLE_ZOOM);
            // A hidden chart holds the mode it had: off would hand her z14
            // field to the model, and nothing on the way back would undo it.
            setCloseIn((was) =>
                chartUnmeasured(mapboxMap) ? was : closeInFor(mapboxMap, windGridPropRef.current, was),
            );
        };
        // The zoom has settled, even with a pan's inertia still running (a
        // flick out): the gate's memory follows it in or out of close-in.
        const zoomSettled = () => {
            try {
                boatZoomRef.current = boatWindZoomFor(boatZoomRef.current, mapboxMap.getZoom());
            } catch {
                boatZoomRef.current = false;
            }
            updateParticleZoomSupport();
        };

        updateParticleZoomSupport();
        // Wait for the camera to settle before starting/stopping the particle
        // engine. That keeps an animation-layer transition out of Mapbox's zoom
        // animation.
        mapboxMap.on('zoomend', zoomSettled);
        // The chart shown again (or resized): its resize fires a moveend,
        // never a zoomend, so the mode is decided here from the real size.
        mapboxMap.on('resize', updateParticleZoomSupport);
        return () => {
            mapboxMap.off('zoomend', zoomSettled);
            mapboxMap.off('resize', updateParticleZoomSupport);
        };
        // windGrid: close-in needs a grid, so a cleared or arriving grid
        // re-decides. The threshold itself is the camera's alone, so a grid
        // swap at the same camera never flips the mode.
    }, [mapboxMap, visible, particlesEnabled, windGrid]);

    const closeInWanted = Boolean(
        !imported && mapboxMap && visible && particlesEnabled && particleZoomSupported && closeIn,
    );
    const closeInWantedRef = useRef(closeInWanted);
    closeInWantedRef.current = closeInWanted;
    const particlesActive = !imported && particlesEnabled && particleZoomSupported && !fieldParked;

    // The geographic field's half of the cross-fade. Into close-in: fade its overlay out,
    // and park (tear down) the engine once that has run. Out of close-in: it
    // starts again at once and fades in on its own 600 ms timer.
    useEffect(() => {
        const overlay = overlayRef.current;
        if (!closeInWanted) {
            setFieldParked(false);
            if (overlay && fieldRef.current) overlay.style.opacity = '1';
            return;
        }
        const wasShowing = overlay?.style.opacity === '1';
        if (overlay) overlay.style.opacity = '0';
        if (!wasShowing) {
            setFieldParked(true);
            return;
        }
        const park = setTimeout(() => setFieldParked(true), CROSSFADE_MS + 50);
        return () => clearTimeout(park);
    }, [closeInWanted]);

    // ── Close-in field ──────────────────────────────────────────
    const closeInLayerRef = useRef<CloseInWindLayer | null>(null);
    const unmountedRef = useRef(false);
    // Hidden (MOB, Wind off) means gone now; only a zoom-out hands over with a fade.
    const handOverRef = useRef(false);
    handOverRef.current = Boolean(mapboxMap && visible && particlesEnabled);
    useEffect(() => {
        unmountedRef.current = false;
        return () => {
            unmountedRef.current = true;
            closeInLayerRef.current?.destroy();
            closeInLayerRef.current = null;
        };
    }, []);

    // The grid the close-in field last sampled: a different (or no) grid at
    // hand-over means a model switch, and the old model's wind must not linger.
    const sampledGridRef = useRef<WindGrid | undefined>(undefined);
    const closeInSourceRef = useRef<CloseInWindSource | null>(null);
    // "Is she on screen?" as last measured, with where she and the camera were.
    // A hidden chart measures 0x0, which is no answer, so its 2 s re-checks
    // keep this one: her wind does not go to the model for a screen nobody is
    // looking at, and still goes the moment it ages or is lost. Only for the
    // same spot under the same camera: another boat followed, or her moving or
    // the camera moving while hidden, is not on screen until measured.
    const boatInViewRef = useRef<(SeenAt & { inView: boolean }) | null>(null);

    // ── Her wind on her icon (W1-WC) ──────────────────────────────
    // Wherever the field is not showing her wind (below 14 in close-in, in the
    // geographic field further out, or under z3), her own-ship marker carries it.
    // In close-in refreshCloseIn publishes it with the field's own reading;
    // outside it the field is the model's alone, and refreshHerWind does.
    const herWindOn = Boolean(!imported && mapboxMap && visible);
    const herWindOnRef = useRef(herWindOn);
    herWindOnRef.current = herWindOn;
    /** Her icon's readout: hers, for the followed boat, only at now. */
    const herIconReadout = (wind: BoatWind | null, scrubAtNow: boolean, fieldShowsHers: boolean) =>
        resolveBoatWindReadout({
            wind,
            boat: boatInstrumentsRef.current ? followedBoatSubject() : null,
            scrubAtNow,
            fieldShowsHers,
        });

    const refreshCloseInRef = useRef<() => void>(() => {});
    refreshCloseInRef.current = () => {
        const layer = closeInLayerRef.current;
        if (!layer || !mapboxMap || !closeInWantedRef.current) return;
        let centre: { lat: number; lng: number };
        try {
            centre = mapboxMap.getCenter();
        } catch {
            return;
        }
        const vector = sampleWindGridAt(windGridPropRef.current, windHourRef.current, centre.lat, centre.lng);
        // Shane 2026-10-06: the vessel's wind gear when the box is her and
        // there is a reading; the phone's Current Location or a place, the model.
        // Her store wind first, else her cloud row (readHerWind).
        const hers = boatInstrumentsRef.current ? readHerWind() : null;
        const boat = hers?.wind ?? null;
        const position = hers ? hers.at() : null;
        // A flyTo's arc dips under 14 on its way to her; an instrument tick or
        // the re-check landing mid-flight must not flip the field and back.
        let moving = false;
        let zoom = Number.NaN;
        try {
            moving = typeof mapboxMap.isMoving === 'function' && mapboxMap.isMoving();
            zoom = mapboxMap.getZoom();
        } catch {
            // A torn-down map: no zoom, so no boat wind.
        }
        if (!moving) boatZoomRef.current = boatWindZoomFor(boatZoomRef.current, zoom);
        const scrubAtNow = isWindScrubAtNow(windHourRef.current, windNowIdxRef.current);
        const seenAt: SeenAt | null = position
            ? {
                  lat: position.lat,
                  lon: position.lon,
                  centre: { lat: centre.lat, lng: centre.lng },
                  zoom,
                  bearing: chartBearing(mapboxMap),
              }
            : null;
        let boatInView = false;
        if (!chartUnmeasured(mapboxMap)) {
            boatInView = !!position && onScreen(mapboxMap, position.lat, position.lon);
            boatInViewRef.current = seenAt ? { ...seenAt, inView: boatInView } : null;
        } else if (seenAt && boatInViewRef.current && sameSeenAt(boatInViewRef.current, seenAt)) {
            boatInView = boatInViewRef.current.inView;
        }
        const wind = resolveCloseInWind({
            boat,
            boatInView,
            // Her wind paints the field only in at the boat view's zoom (14);
            // further out the model takes over (Shane 2026-10-07).
            boatZoom: boatZoomRef.current,
            scrubAtNow,
            model: vector ? windFromVector(vector.u, vector.v) : null,
        });
        sampledGridRef.current = windGridPropRef.current;
        closeInSourceRef.current = wind?.source ?? null;
        // Her icon (W1-WC) takes the same reading, with the field's own answer.
        // Whichever lets go of her wind goes first, so there is no moment, for
        // any listener, where the field and her icon both claim it.
        const icon = herIconReadout(boat, scrubAtNow, wind?.source === 'boat');
        if (icon?.fieldShowsHers) setBoatWindReadout(icon);
        layer.setWind(wind);
        setCloseInWindReadout(wind);
        if (!icon?.fieldShowsHers) setBoatWindReadout(icon);
    };

    const refreshHerWindRef = useRef<() => void>(() => {});
    refreshHerWindRef.current = () => {
        if (closeInWantedRef.current && closeInLayerRef.current) {
            refreshCloseInRef.current();
            return;
        }
        if (!herWindOnRef.current || !boatInstrumentsRef.current) {
            setBoatWindReadout(null);
            return;
        }
        const scrubAtNow = isWindScrubAtNow(windHourRef.current, windNowIdxRef.current);
        setBoatWindReadout(herIconReadout(readHerWind()?.wind ?? null, scrubAtNow, false));
    };

    useEffect(() => {
        if (!closeInWanted || !mapboxMap) return;
        let layer = closeInLayerRef.current;
        if (layer && (layer.map !== mapboxMap || layer.palette !== palette)) {
            layer.destroy();
            layer = null;
        }
        if (!layer) {
            layer = new CloseInWindLayer(mapboxMap, {
                filter: haloFor(palette),
                palette,
                fade: PARTICLE_FADE,
                lineWidth: lineWidthFor(palette),
                tierScale: particleScale(),
                reducedMotion: prefersReducedMotion(),
            });
            closeInLayerRef.current = layer;
        }
        layer.show();
        const refresh = () => refreshCloseInRef.current();
        refresh();
        // The centre sample and "is the boat on screen" move with the camera;
        // the instruments arrive every few seconds.
        mapboxMap.on('moveend', refresh);
        const unsubscribe = NmeaStore.subscribe(refresh);
        // A new follow target (Switch boat included) changes whose wind it is.
        window.addEventListener(WEATHER_FOLLOW_TARGET_EVENT, refresh);
        const recheck = setInterval(() => {
            // Her wind ages on its own clock, on the field or on her icon (W1-WC).
            if (closeInSourceRef.current === 'boat' || getBoatWindReadout() !== null) refresh();
        }, BOAT_RECHECK_MS);
        const owned = layer;
        return () => {
            mapboxMap.off('moveend', refresh);
            unsubscribe();
            window.removeEventListener(WEATHER_FOLLOW_TARGET_EVENT, refresh);
            clearInterval(recheck);
            const heldHers = closeInSourceRef.current === 'boat';
            closeInSourceRef.current = null;
            // boatZoomRef stays: a zoom-out has already judged it at its
            // zoomend, and any other way out (a model switch) left the camera
            // where it was, slack and all.
            boatInViewRef.current = null;
            setCloseInWindReadout(null);
            const forget = () => {
                if (closeInLayerRef.current === owned) closeInLayerRef.current = null;
            };
            const sameModel = !!windGridPropRef.current && windGridPropRef.current === sampledGridRef.current;
            if (!unmountedRef.current && handOverRef.current && sameModel) {
                // A flick out past close-in can leave the field on her wind
                // (held mid-gesture, boatZoomRef), and her icon takes it in
                // this same flush (W1-WC). The field lets go first, as in
                // refreshCloseIn: for its last second it fades out on the
                // model at the centre, the geographic field's own wind.
                if (heldHers) owned.setWind(modelWindAtCentre(mapboxMap, windGridPropRef.current, windHourRef.current));
                // Zoomed out: hold until the geographic field has faded in, then fade.
                owned.release(FIELD_FADE_IN_DELAY_MS, forget);
            } else {
                owned.destroy();
                forget();
            }
        };
    }, [closeInWanted, mapboxMap, palette]);

    // A new hour, a new grid, or the scrubber leaving now: re-read the local
    // wind (in close-in) and her icon's (W1-WC, anywhere).
    useEffect(() => {
        refreshHerWindRef.current();
    }, [closeInWanted, windHour, windGrid, windNowIdx, boatInstruments]);

    // Ashore the followed boat's wind is her cloud row (Shane 2026-10-07):
    // ask for it at once and on every re-check, while the wind layer is on
    // Obs (close-in paints it in at 14; her icon carries it further out,
    // W1-WC) and the box follows a receiver; the chain reads at most once per
    // 30 s, shared with the camera and the marker, and nothing while the box
    // follows the phone. Each answer re-reads the wind, so a reading past its
    // 60 s gate hands back to the model and leaves her icon.
    useEffect(() => {
        if (!herWindOn || !boatInstruments || !boatLookUp) return;
        let live = true;
        const ask = () => {
            // Her own wind is already in the store (aboard: the bus, or the Pi
            // over the LAN), and it wins: no cloud read for a row that cannot show.
            if (storeBoatWind()) {
                refreshHerWindRef.current();
                return;
            }
            void lookUpFollowedBoatWind().then(() => {
                if (live) refreshHerWindRef.current();
            });
        };
        ask();
        const recheck = setInterval(ask, BOAT_RECHECK_MS);
        // A new follow target (Switch boat included) is a different boat's row.
        window.addEventListener(WEATHER_FOLLOW_TARGET_EVENT, ask);
        return () => {
            live = false;
            clearInterval(recheck);
            window.removeEventListener(WEATHER_FOLLOW_TARGET_EVENT, ask);
        };
    }, [herWindOn, boatInstruments, boatLookUp]);

    // Her icon outside close-in (W1-WC): the geographic field, or none under z3.
    // The field there is the model's alone, so her reading rides on her icon:
    // re-read on her instruments' own notifications, a new follow target, and
    // the 2 s re-check while she has a reading out (it ages on its own clock).
    // In close-in the field's own refresh publishes it.
    useEffect(() => {
        if (!herWindOn || !boatInstruments) {
            setBoatWindReadout(null);
            return;
        }
        if (closeInWanted) return;
        const refresh = () => refreshHerWindRef.current();
        refresh();
        const unsubscribe = NmeaStore.subscribe(refresh);
        window.addEventListener(WEATHER_FOLLOW_TARGET_EVENT, refresh);
        const recheck = setInterval(() => {
            if (getBoatWindReadout() !== null) refresh();
        }, BOAT_RECHECK_MS);
        return () => {
            unsubscribe();
            window.removeEventListener(WEATHER_FOLLOW_TARGET_EVENT, refresh);
            clearInterval(recheck);
        };
    }, [herWindOn, boatInstruments, closeInWanted]);

    // Off with the overlay: nothing of hers is left on her icon.
    useEffect(() => () => setBoatWindReadout(null), []);

    // Each field owns its canvas and RAF. A missing/replaced grid clears old ink immediately.
    useEffect(() => {
        if (!mapboxMap || !visible || !particlesActive) return;
        const field = new MapboxWindField(mapboxMap, {
            palette,
            filter: haloFor(palette),
            lineWidth: lineWidthFor(palette),
            fade: PARTICLE_FADE,
            velocityScale: zoomCompensatedVelocityScale,
            particleMultiplier: zoomScaledParticleMultiplier,
        });
        fieldRef.current = field;
        overlayRef.current = field.element;
        const show = setTimeout(() => {
            if (windGridPropRef.current && !closeInWantedRef.current) field.element.style.opacity = '1';
        }, FIELD_FADE_IN_DELAY_MS);
        return () => {
            clearTimeout(show);
            field.destroy();
            if (fieldRef.current === field) fieldRef.current = null;
            if (overlayRef.current === field.element) overlayRef.current = null;
        };
    }, [mapboxMap, visible, particlesActive, palette]);

    useEffect(() => {
        const field = fieldRef.current;
        if (!field) return;
        try {
            const data = windGridFrameToVelocityData(windGrid, windHour);
            field.setData(data);
            field.element.style.opacity = data && !closeInWantedRef.current ? '1' : '0';
        } catch (error) {
            field.setData(null);
            field.element.style.opacity = '0';
            log.error('Selected wind could not be displayed', error);
        }
    }, [windGrid, windHour, particlesActive, palette, mapboxMap, visible]);

    return null;
};
