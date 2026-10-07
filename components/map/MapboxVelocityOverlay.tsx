/**
 * MapboxVelocityOverlay — Bridges leaflet-velocity-ts onto a Mapbox GL map.
 *
 * Data pipeline:
 *   1. Receives the selected model's reactive WindStore grid
 *   2. Converts its current (possibly fractional) forecast frame to U/V records
 *   3. Renders a static wind-speed heatmap below labels
 *   4. Optionally renders animated particles via leaflet-velocity-ts
 *
 * Cleanup: removes the heatmap plus the optional velocity layer/Leaflet overlay.
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
 * The two cross-fade, with hysteresis, and the leaflet engine
 * is torn down rather than left animating underneath.
 *
 * Usage:
 *   <MapboxVelocityOverlay mapboxMap={mapboxInstance} visible />
 */

import React, { useEffect, useRef, useState } from 'react';
import type { WindGrid } from '../../services/weather/windGridEncoding';
import { createLogger } from '../../utils/createLogger';
import { particleScale } from '../../utils/deviceTier';
import { NmeaStore } from '../../services/NmeaStore';
import { BoatLinkService } from '../../services/boatLink/BoatLinkService';
import { resolveOwnshipPosition } from '../../services/ownshipPosition';
import { LocationStore } from '../../stores/LocationStore';
import { WEATHER_FOLLOW_TARGET_EVENT } from '../../services/weatherPosition';
import { boatInstrumentsFollowed, followedBoatCloudWind, lookUpFollowedBoatWind } from './obsBoatInstruments';
import { WIND_MAX_MS, WIND_PARTICLE_COLORS } from './windRamp';
import { windGridFrameToVelocityData, type VelocityGribRecord } from './windVelocityFrame';
import { CloseInWindLayer } from './CloseInWindLayer';
import {
    closeInModeFor,
    isWindScrubAtNow,
    pickBoatTrueWind,
    resolveCloseInWind,
    sampleWindGridAt,
    setCloseInWindReadout,
    windFromVector,
    type CloseInWindSource,
} from './closeInWind';

const log = createLogger('MapboxVelocityOverlay');
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// NOTE: leaflet-velocity-ts is dynamically imported inside useEffect
// because it expects window.L to exist at import time.
// Type declaration is in src/leaflet-velocity-ts.d.ts

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
 * accumulate toward white where they cross.
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
// Direction is essential even in the broad synoptic view, so Wind begins at
// z3 rather than falling back to a speed-only heatmap. The startup guard below
// protects the third-party renderer from the old delayed-start zoom race.
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

// ── Helper: Create velocity layer ─────────────────────────────

function createVelocityLayer(data: VelocityGribRecord[], velocityScale: number, particleMultiplier: number): L.Layer {
    const layer = (L as unknown as Record<string, (...args: unknown[]) => L.Layer>).velocityLayer({
        displayValues: false, // No mouse readout (overlay has pointer-events: none)
        data,
        maxVelocity: WIND_MAX_MS,
        velocityScale,
        particleAge: 60,
        opacity: PARTICLE_FADE,
        particleMultiplier,
        // 30, was 15: a 66 ms particle step is visible judder on a 60 Hz
        // panel — half of Shane's "shaky" (2026-08-21). 33 ms reads as
        // motion. Still throttled: full-rate RAF measurably warms phones.
        frameRate: 30,
        particlelineWidth: PARTICLE_LINE_WIDTH,
        // White below 20 kt, warning hues from the reef line up (windRamp).
        colorScale: WIND_PARTICLE_COLORS,
    });
    // Keep the third-party delayed-start guard attached to every creation
    // path, including a replacement after an unsupported data update.
    guardVelocityLayerStartup(layer);
    return layer;
}

type MutableVelocityLayer = L.Layer & {
    _windy?: { setData: (data: VelocityGribRecord[]) => void; velocityScale?: number; particleMultiplier?: number };
    setData?: (data: VelocityGribRecord[]) => void;
};

/**
 * `leaflet-velocity-ts` creates its Windy instance before it creates the
 * animation bucket used by `Windy.stop()`. A Mapbox zoom can arrive in that
 * small window (particularly when Wind opens at z3), causing the plugin to
 * call `this.animationBucket.clear()` while the bucket is still undefined.
 *
 * The plugin does not expose a lifecycle hook for this, so guard its private
 * startup seam at the one place we create a velocity layer. Once `start()`
 * has run, the original stop implementation remains completely unchanged.
 */
type VelocityWindyInternals = {
    animationBucket?: { clear?: () => void };
    stop?: () => void;
    __thalassaSafeStop?: boolean;
};

type VelocityLayerInternals = MutableVelocityLayer & {
    _windy?: VelocityWindyInternals;
    onDrawLayer?: (...args: unknown[]) => unknown;
    __thalassaStartupGuarded?: boolean;
};

export function guardVelocityLayerStartup(layer: L.Layer): void {
    const internalLayer = layer as VelocityLayerInternals;
    if (internalLayer.__thalassaStartupGuarded || typeof internalLayer.onDrawLayer !== 'function') return;

    internalLayer.__thalassaStartupGuarded = true;
    const originalOnDrawLayer = internalLayer.onDrawLayer;

    internalLayer.onDrawLayer = (...args: unknown[]) => {
        const result = originalOnDrawLayer.call(internalLayer, ...args);
        const windy = internalLayer._windy;
        if (!windy || windy.__thalassaSafeStop || typeof windy.stop !== 'function') return result;

        const originalStop = windy.stop;
        windy.__thalassaSafeStop = true;
        windy.stop = () => {
            // Before the plugin's delayed `start()` call there is no running
            // animation to stop. Returning here avoids its unsafe clear().
            if (!windy.animationBucket) return;
            originalStop.call(windy);
        };

        return result;
    };
}

function removeVelocityLayer(map: L.Map, layer: L.Layer | null): void {
    if (layer && map.hasLayer(layer)) map.removeLayer(layer);
}

function applyVelocityData(
    map: L.Map,
    layer: L.Layer | null,
    data: VelocityGribRecord[],
    velocityScale: number,
    particleMultiplier: number,
): L.Layer {
    if (!layer) {
        const created = createVelocityLayer(data, velocityScale, particleMultiplier);
        created.addTo(map);
        return created;
    }

    const mutableLayer = layer as MutableVelocityLayer;
    if (mutableLayer._windy) {
        mutableLayer._windy.velocityScale = velocityScale;
        // Re-read on the next start() via the particuleCount getter.
        mutableLayer._windy.particleMultiplier = particleMultiplier;
        mutableLayer._windy.setData(data);
        return layer;
    }
    if (mutableLayer.setData) {
        mutableLayer.setData(data);
        return layer;
    }

    removeVelocityLayer(map, layer);
    const replacement = createVelocityLayer(data, velocityScale, particleMultiplier);
    replacement.addTo(map);
    return replacement;
}

// ── Close-in helpers ─────────────────────────────────────────

/** Both overlays fade over 0.4 s (the container transition). */
const CROSSFADE_MS = 400;
/** The leaflet field fades in 600 ms after setup; the close-in field holds until then. */
const LEAFLET_FADE_IN_DELAY_MS = 600;
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
 * phone on the boat's own network and no VPN up stands in.
 */
function boatPosition(): { lat: number; lon: number } | null {
    const location = LocationStore.getState();
    const aboard = BoatLinkService.phoneStandsInForBoat();
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
function storeBoatWind(): ReturnType<typeof pickBoatTrueWind> {
    const state = NmeaStore.getState();
    if (state.remote?.via === 'cloud' || !boatInstrumentsFollowed()) return null;
    return pickBoatTrueWind(state);
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
}) => {
    const overlayRef = useRef<HTMLDivElement | null>(null);
    const leafletMapRef = useRef<L.Map | null>(null);
    const velocityLayerRef = useRef<L.Layer | null>(null);
    const syncRef = useRef<(() => void) | null>(null);
    const moveRef = useRef<(() => void) | null>(null);
    const resizeRef = useRef<(() => void) | null>(null);
    const zoomEndRef = useRef<(() => void) | null>(null);
    const [particleZoomSupported, setParticleZoomSupported] = useState(() =>
        Boolean(mapboxMap && mapboxMap.getZoom() >= MIN_PARTICLE_ZOOM),
    );
    // Close-in is decided from the settled camera. Seeded on mount, so Obs
    // opening at z14 never starts the leaflet engine just to park it.
    const [closeIn, setCloseIn] = useState(() =>
        Boolean(mapboxMap && visible && particlesEnabled && closeInFor(mapboxMap, windGrid, false)),
    );
    // Leaflet stays up through the cross-fade into close-in, then is torn down.
    const [leafletParked, setLeafletParked] = useState(closeIn);
    // Track latest values so the async setup can apply the correct hour
    const windHourRef = useRef(windHour);
    const windGridPropRef = useRef(windGrid);
    const windNowIdxRef = useRef(windNowIdx);
    const boatInstrumentsRef = useRef(boatInstruments);
    windHourRef.current = windHour;
    windGridPropRef.current = windGrid;
    windNowIdxRef.current = windNowIdx;
    boatInstrumentsRef.current = boatInstruments;

    // The OBS wind read is directional at every supported zoom. Wait for the
    // camera to settle before mounting/unmounting the second map so a z3
    // transition cannot fight Mapbox's zoom animation. The same settle decides
    // close-in, so a mode switch never lands mid-pinch either.
    useEffect(() => {
        if (!mapboxMap || !visible || !particlesEnabled) {
            setParticleZoomSupported(false);
            setCloseIn(false);
            return;
        }

        const updateParticleZoomSupport = () => {
            setParticleZoomSupported(mapboxMap.getZoom() >= MIN_PARTICLE_ZOOM);
            setCloseIn((was) => closeInFor(mapboxMap, windGridPropRef.current, was));
        };

        updateParticleZoomSupport();
        // Wait for the camera to settle before starting/stopping the second
        // map. That keeps an animation-layer transition out of Mapbox's zoom
        // animation.
        mapboxMap.on('zoomend', updateParticleZoomSupport);
        return () => {
            mapboxMap.off('zoomend', updateParticleZoomSupport);
        };
        // windGrid: close-in needs a grid, so a cleared or arriving grid
        // re-decides. The threshold itself is the camera's alone, so a grid
        // swap at the same camera never flips the mode.
    }, [mapboxMap, visible, particlesEnabled, windGrid]);

    const closeInWanted = Boolean(mapboxMap && visible && particlesEnabled && particleZoomSupported && closeIn);
    const closeInWantedRef = useRef(closeInWanted);
    closeInWantedRef.current = closeInWanted;
    const particlesActive = particlesEnabled && particleZoomSupported && !leafletParked;

    // Leaflet's half of the cross-fade. Into close-in: fade its overlay out,
    // and park (tear down) the engine once that has run. Out of close-in: it
    // starts again at once and fades in on its own 600 ms timer.
    useEffect(() => {
        const overlay = overlayRef.current;
        if (!closeInWanted) {
            setLeafletParked(false);
            if (overlay && velocityLayerRef.current) overlay.style.opacity = '1';
            return;
        }
        const wasShowing = overlay?.style.opacity === '1';
        if (overlay) overlay.style.opacity = '0';
        if (!wasShowing) {
            setLeafletParked(true);
            return;
        }
        const park = setTimeout(() => setLeafletParked(true), CROSSFADE_MS + 50);
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
        // Her live store wind first (the bus, or the Pi over the LAN); else, as
        // ashore on Obs where nothing feeds the store (Shane 2026-10-07), her
        // own cloud row through the boat chain, placed where that row puts her,
        // and that even while a screen holds the store's cloud lane.
        const storeBoat = boatInstrumentsRef.current ? storeBoatWind() : null;
        const cloud = !storeBoat && boatInstrumentsRef.current ? followedBoatCloudWind() : null;
        const boat = storeBoat ?? cloud?.wind ?? null;
        const position = storeBoat ? boatPosition() : cloud ? { lat: cloud.lat, lon: cloud.lon } : null;
        const wind = resolveCloseInWind({
            boat,
            boatInView: !!position && onScreen(mapboxMap, position.lat, position.lon),
            scrubAtNow: isWindScrubAtNow(windHourRef.current, windNowIdxRef.current),
            model: vector ? windFromVector(vector.u, vector.v) : null,
        });
        sampledGridRef.current = windGridPropRef.current;
        closeInSourceRef.current = wind?.source ?? null;
        layer.setWind(wind);
        setCloseInWindReadout(wind);
    };

    useEffect(() => {
        if (!closeInWanted || !mapboxMap) return;
        let layer = closeInLayerRef.current;
        if (layer && layer.map !== mapboxMap) {
            layer.destroy();
            layer = null;
        }
        if (!layer) {
            layer = new CloseInWindLayer(mapboxMap, {
                filter: PARTICLE_HALO,
                fade: PARTICLE_FADE,
                lineWidth: PARTICLE_LINE_WIDTH,
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
            if (closeInSourceRef.current === 'boat') refresh();
        }, BOAT_RECHECK_MS);
        const owned = layer;
        return () => {
            mapboxMap.off('moveend', refresh);
            unsubscribe();
            window.removeEventListener(WEATHER_FOLLOW_TARGET_EVENT, refresh);
            clearInterval(recheck);
            closeInSourceRef.current = null;
            setCloseInWindReadout(null);
            const forget = () => {
                if (closeInLayerRef.current === owned) closeInLayerRef.current = null;
            };
            const sameModel = !!windGridPropRef.current && windGridPropRef.current === sampledGridRef.current;
            if (!unmountedRef.current && handOverRef.current && sameModel) {
                // Zoomed out: hold until leaflet has faded in, then fade.
                owned.release(LEAFLET_FADE_IN_DELAY_MS, forget);
            } else {
                owned.destroy();
                forget();
            }
        };
    }, [closeInWanted, mapboxMap]);

    // A new hour, a new grid, or the scrubber leaving now: re-read the local wind.
    useEffect(() => {
        if (closeInWanted) refreshCloseInRef.current();
    }, [closeInWanted, windHour, windGrid, windNowIdx, boatInstruments]);

    // Ashore the followed boat's wind is her cloud row (Shane 2026-10-07):
    // ask for it at once and on every re-check, while close-in is showing on
    // Obs and the box follows a receiver; the chain reads at most once per
    // 30 s and nothing while the box follows the phone. Each answer re-reads
    // the wind, so a reading past its 60 s gate hands back to the model.
    useEffect(() => {
        if (!closeInWanted || !boatInstruments || !boatLookUp) return;
        let live = true;
        const ask = () => {
            // Her own wind is already in the store (aboard: the bus, or the Pi
            // over the LAN), and it wins: no cloud read for a row that cannot show.
            if (storeBoatWind()) {
                refreshCloseInRef.current();
                return;
            }
            void lookUpFollowedBoatWind().then(() => {
                if (live) refreshCloseInRef.current();
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
    }, [closeInWanted, boatInstruments, boatLookUp]);

    // The selected WindStore grid is the sole particle source. This effect
    // covers grid/hour updates after Leaflet setup, including the first frame.
    // If a model switch clears the grid, remove the old model immediately
    // rather than leaving plausible-looking but incorrectly labelled wind.
    useEffect(() => {
        if (!particlesActive) return;
        const leafletMap = leafletMapRef.current;
        if (!leafletMap) return;

        const nextData = windGridFrameToVelocityData(windGrid, windHour);
        if (!nextData) {
            removeVelocityLayer(leafletMap, velocityLayerRef.current);
            velocityLayerRef.current = null;
            if (overlayRef.current) overlayRef.current.style.opacity = '0';
            return;
        }

        try {
            velocityLayerRef.current = applyVelocityData(
                leafletMap,
                velocityLayerRef.current,
                nextData,
                zoomCompensatedVelocityScale(mapboxMap?.getZoom() ?? VELOCITY_SCALE_REF_ZOOM),
                zoomScaledParticleMultiplier(mapboxMap?.getZoom() ?? VELOCITY_SCALE_REF_ZOOM),
            );
            if (overlayRef.current) overlayRef.current.style.opacity = closeInWantedRef.current ? '0' : '1';
            syncRef.current?.();
        } catch (err) {
            // Never leave the previous model painted after a renderer update
            // fails. A plausible old field with a newly-selected model label is
            // more dangerous than an honestly empty overlay.
            removeVelocityLayer(leafletMap, velocityLayerRef.current);
            velocityLayerRef.current = null;
            if (overlayRef.current) overlayRef.current.style.opacity = '0';
            log.error('[VelocityOverlay] Failed to apply selected wind grid:', err);
        }
    }, [windHour, windGrid, particlesActive, mapboxMap]);

    // ── Create/destroy particle overlay ──────────────────────────
    useEffect(() => {
        if (!mapboxMap || !visible || !particlesActive) return;

        let cancelled = false;
        let snapTimer: ReturnType<typeof setTimeout> | null = null;
        let sizeObserver: ResizeObserver | null = null;
        let lateBootTimer: ReturnType<typeof setTimeout> | null = null;

        const setup = async () => {
            // Ensure Leaflet is on window BEFORE the plugin loads

            window.L = L;
            await import('leaflet-velocity-ts');

            // leaflet-velocity-ts includes `zoomanim: undefined` in its
            // CanvasLayer event map whenever Leaflet animations are disabled.
            // Leaflet warns once on bind and again on unbind for every mount.
            // Filter only non-functions at the plugin boundary; all valid
            // resize/move/zoom callbacks remain untouched.
            const canvasLayerProto = (
                L as unknown as {
                    CanvasLayer?: {
                        prototype?: {
                            getEvents?: () => Record<string, unknown>;
                            __thalassaFiltersInvalidEvents?: boolean;
                        };
                    };
                }
            ).CanvasLayer?.prototype;
            if (canvasLayerProto?.getEvents && !canvasLayerProto.__thalassaFiltersInvalidEvents) {
                const originalGetEvents = canvasLayerProto.getEvents;
                canvasLayerProto.getEvents = function () {
                    return Object.fromEntries(
                        Object.entries(originalGetEvents.call(this)).filter(
                            ([, listener]) => typeof listener === 'function',
                        ),
                    );
                };
                canvasLayerProto.__thalassaFiltersInvalidEvents = true;
            }

            if (cancelled) return;

            const container = mapboxMap.getContainer();

            // Create overlay div on top of Mapbox
            const div = document.createElement('div');
            div.style.cssText = `position:absolute;inset:0;z-index:400;pointer-events:none;opacity:0;transition:opacity 0.4s ease;filter:${PARTICLE_HALO};`;
            container.appendChild(div);
            overlayRef.current = div;

            // Create headless Leaflet map (transparent, no tiles, no controls)
            const center = mapboxMap.getCenter();
            const zoom = mapboxMap.getZoom();
            const lMap = L.map(div, {
                center: [center.lat, center.lng],
                zoom: zoom + 1,
                zoomControl: false,
                attributionControl: false,
                dragging: false,
                touchZoom: false,
                doubleClickZoom: false,
                scrollWheelZoom: false,
                boxZoom: false,
                keyboard: false,
                zoomAnimation: false,
                zoomSnap: 0,
            });
            leafletMapRef.current = lMap;

            // Make Leaflet fully transparent
            div.style.background = 'transparent';
            const leafletContainer = div.querySelector('.leaflet-container') as HTMLElement;
            if (leafletContainer) leafletContainer.style.background = 'transparent';
            const tilePane = lMap.getPane('tilePane');
            if (tilePane) tilePane.style.display = 'none';
            const mapPane = lMap.getPane('mapPane');
            if (mapPane) mapPane.style.background = 'transparent';

            // The grid/hour effect may have run before the async Leaflet plugin
            // was ready. Read the refs here to cover that race, including hour 0.
            const initialData = windGridFrameToVelocityData(windGridPropRef.current, windHourRef.current);
            if (initialData) {
                velocityLayerRef.current = applyVelocityData(
                    lMap,
                    null,
                    initialData,
                    zoomCompensatedVelocityScale(mapboxMap.getZoom()),
                    zoomScaledParticleMultiplier(mapboxMap.getZoom()),
                );
            }

            // ── Anchor-point geo-locking (performance optimised) ──
            // MOVE/ZOOM events (every frame during a gesture):
            //   → Lightweight: CSS translate+scale against the last synced view
            //     (no setView — a setView per zoom frame made the plugin kill
            //     and re-seed every particle dozens of times per pinch)
            // MOVEEND (end of gesture — Mapbox fires it after zooms too):
            //   → Full: setView() + measure + record the new baseline
            let _syncing = false;

            // The Leaflet view the canvas was last truly projected at, plus
            // the sub-pixel residual Leaflet rendered it off-centre by.
            let lastSync: { lat: number; lng: number; zoom: number; rx: number; ry: number } | null = null;

            // Full sync — expensive, only at gesture end
            const syncFull = () => {
                if (_syncing || !leafletMapRef.current || !mapboxMap || !overlayRef.current) return;
                _syncing = true;
                try {
                    const c = mapboxMap.getCenter();
                    const zRaw = mapboxMap.getZoom();
                    // The restart this setView triggers re-reads velocityScale,
                    // so hand it the zoom-compensated value first.
                    const windy = (velocityLayerRef.current as MutableVelocityLayer | null)?._windy;
                    if (windy) {
                        windy.velocityScale = zoomCompensatedVelocityScale(zRaw);
                        // The restart re-reads particuleCount, so the density
                        // ramp has to be handed over in the same breath as the
                        // speed one — otherwise zooming in thins the motion
                        // but leaves the swarm.
                        windy.particleMultiplier = zoomScaledParticleMultiplier(zRaw);
                    }
                    leafletMapRef.current.setView([c.lat, c.lng], zRaw + 1, { animate: false });

                    // Measure residual error and correct
                    const mapboxPx = mapboxMap.project([c.lng, c.lat]);
                    const leafletPx = leafletMapRef.current.latLngToContainerPoint([c.lat, c.lng]);
                    let dx = mapboxPx.x - leafletPx.x;
                    let dy = mapboxPx.y - leafletPx.y;
                    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
                        // A genuine sub-pixel residual is <1 px. Tens of px
                        // means Leaflet is projecting against a STALE cached
                        // container size — the startup half-render band
                        // (Shane's screenshot, 2026-08-21): boot measured the
                        // container while layout was transiently short, and
                        // no resize event ever arrived to heal it (mapbox-gl
                        // resize() early-returns without firing when its own
                        // transform already matches). Re-measure and
                        // re-project HERE, which turns every gesture end into
                        // a heal opportunity instead of a re-application of
                        // the bad translate.
                        leafletMapRef.current.invalidateSize();
                        leafletMapRef.current.setView([c.lat, c.lng], zRaw + 1, { animate: false });
                        const healedPx = leafletMapRef.current.latLngToContainerPoint([c.lat, c.lng]);
                        dx = mapboxPx.x - healedPx.x;
                        dy = mapboxPx.y - healedPx.y;
                    }
                    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
                        overlayRef.current.style.transform = `translate(${dx}px, ${dy}px)`;
                    } else {
                        overlayRef.current.style.transform = '';
                    }
                    lastSync = { lat: c.lat, lng: c.lng, zoom: zRaw, rx: -dx, ry: -dy };
                } catch (_) {
                    /* velocity canvas not ready yet */
                }
                _syncing = false;
            };

            // Lightweight camera tracking — cheap, runs on every move/zoom
            // frame. Scales+translates the whole canvas so the field stays
            // geo-locked through a pinch without touching Leaflet (one real
            // re-projection then happens at moveend).
            const trackCamera = () => {
                if (!leafletMapRef.current || !mapboxMap || !overlayRef.current || !lastSync) return;
                try {
                    const cam = mapboxMap.getCenter();
                    const camPx = mapboxMap.project([cam.lng, cam.lat]);
                    const anchorPx = mapboxMap.project([lastSync.lng, lastSync.lat]);
                    const s = Math.pow(2, mapboxMap.getZoom() - lastSync.zoom);
                    const tx = anchorPx.x - camPx.x - s * lastSync.rx;
                    const ty = anchorPx.y - camPx.y - s * lastSync.ry;
                    // transform-origin is the div centre, which is exactly
                    // where the camera centre projects (the div is inset:0).
                    overlayRef.current.style.transform =
                        Math.abs(s - 1) > 0.001
                            ? `translate(${tx}px, ${ty}px) scale(${s})`
                            : `translate(${tx}px, ${ty}px)`;
                } catch (_) {
                    /* ok */
                }
            };

            const onResize = () => {
                leafletMapRef.current?.invalidateSize();
                syncFull();
            };

            // Lightweight tracking on every gesture frame, full sync only at end
            mapboxMap.on('move', trackCamera);
            mapboxMap.on('moveend', syncFull);
            mapboxMap.on('zoom', trackCamera);
            mapboxMap.on('resize', onResize);

            // Observe the container DIRECTLY. The Mapbox 'resize' event alone
            // is not a reliable heal signal: useMapInit's own ResizeObserver
            // calls map.resize(), but mapbox-gl early-returns WITHOUT firing
            // 'resize' when its transform already matches the container — so
            // a boot-time short-layout transient could leave Leaflet's cached
            // size stale forever. invalidateSize() no-ops when nothing
            // changed, so a chatty observer costs nothing.
            if (typeof ResizeObserver !== 'undefined') {
                sizeObserver = new ResizeObserver(() => onResize());
                sizeObserver.observe(container);
            }

            // Single deferred re-sync after zoom/move ends (replaces heavy 200ms×10 interval)
            const onViewEnd = () => {
                if (snapTimer) clearTimeout(snapTimer);
                snapTimer = setTimeout(() => {
                    if (cancelled) return;
                    syncFull();
                    snapTimer = null;
                }, 300);
            };
            mapboxMap.on('zoomend', onViewEnd);
            mapboxMap.on('moveend', onViewEnd);

            syncRef.current = syncFull;
            moveRef.current = trackCamera;
            resizeRef.current = onResize;
            zoomEndRef.current = onViewEnd;

            // Initial sync
            lMap.invalidateSize();
            syncFull();

            // Delayed re-sync — container may not have final dimensions on first mount.
            // Fade in AFTER this final sync so particles don't visibly jump.
            setTimeout(() => {
                if (cancelled) return;
                lMap.invalidateSize();
                syncFull();
                // Fade in only when a selected-model grid has produced a layer.
                // Not while close-in holds the screen (a zoom-in mid-boot).
                if (overlayRef.current && velocityLayerRef.current && !closeInWantedRef.current)
                    overlayRef.current.style.opacity = '1';
            }, 600);

            // Second boot pass: a cold-start layout transient that OUTLIVES
            // the 600 ms retry was exactly the half-render window. Cheap
            // insurance on top of the ResizeObserver + syncFull self-heal.
            lateBootTimer = setTimeout(() => {
                if (cancelled) return;
                lMap.invalidateSize();
                syncFull();
                lateBootTimer = null;
            }, 2000);
        };

        setup().catch((err) => log.error('[VelocityOverlay] Setup failed:', err));

        // ── Cleanup ──────────────────────────────────────────────
        return () => {
            cancelled = true;
            if (snapTimer) {
                clearTimeout(snapTimer);
                snapTimer = null;
            }
            if (lateBootTimer) {
                clearTimeout(lateBootTimer);
                lateBootTimer = null;
            }
            if (sizeObserver) {
                sizeObserver.disconnect();
                sizeObserver = null;
            }

            try {
                if (moveRef.current) {
                    mapboxMap.off('move', moveRef.current);
                    mapboxMap.off('zoom', moveRef.current);
                }
                if (syncRef.current) mapboxMap.off('moveend', syncRef.current);
                if (resizeRef.current) mapboxMap.off('resize', resizeRef.current);
                if (zoomEndRef.current) {
                    mapboxMap.off('zoomend', zoomEndRef.current);
                    mapboxMap.off('moveend', zoomEndRef.current);
                }
            } catch (_) {
                /* ok */
            }
            syncRef.current = null;
            moveRef.current = null;
            resizeRef.current = null;
            zoomEndRef.current = null;

            // Remove heat map from Mapbox
            // Heat map has its own useEffect lifecycle — don't touch it here

            // Remove velocity layer
            try {
                if (velocityLayerRef.current && leafletMapRef.current?.hasLayer(velocityLayerRef.current)) {
                    leafletMapRef.current.removeLayer(velocityLayerRef.current);
                }
            } catch (_) {
                /* ok */
            }
            velocityLayerRef.current = null;

            // Destroy Leaflet map (also detaches its container div)
            try {
                if (leafletMapRef.current) {
                    leafletMapRef.current.remove();
                }
            } catch (_) {
                /* ok */
            }
            leafletMapRef.current = null;

            // Remove overlay div (may already be gone after lMap.remove())
            try {
                if (overlayRef.current?.parentNode) {
                    overlayRef.current.parentNode.removeChild(overlayRef.current);
                }
            } catch (_) {
                /* ok */
            }
            overlayRef.current = null;
        };
    }, [mapboxMap, visible, particlesActive]);

    return null;
};
