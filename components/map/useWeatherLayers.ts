/**
 * @filesize-justified useEmbeddedRain already extracted. Remaining hook manages 8+ map layer sources that share lifecycle.
 */
/**
 * useWeatherLayers — Weather layer toggle, isobars, rain, wind hooks.
 *
 * Manages the activeLayer state and the side-effects of switching between
 * weather overlays (rain, wind WebGL, synoptic pressure/isobars,
 * static tile overlays, velocity).
 */

import { useState, useRef, useEffect, useCallback, useMemo, type MutableRefObject } from 'react';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('WeatherLayers');
import mapboxgl from 'mapbox-gl';
import { generateIsobars, generateIsobarsFromGrid, FORECAST_HOURS } from '../../services/weather/isobars';
import { WindStore, useWindStore } from '../../stores/WindStore';
import { WindParticleLayer } from './WindParticleLayer';
import { type WindGrid } from '../../services/weather/windField';
import { WindDataController } from '../../services/weather/WindDataController';
import { piCache } from '../../services/PiCacheService';
import {
    type WeatherLayer,
    getActiveLayerFrameZoom,
    getTileUrl,
    getWindColor,
    isParkedLayer,
    LAYER_FRAME_ZOOM,
    SEA_STATE_LAYERS,
} from './mapConstants';
import { createWindLabelMarker } from '../../utils/createMarkerEl';
import {
    initIsobarLayers,
    hideIsobarLayers,
    showIsobarLayers,
    RAINVIEWER_COLOR_RAMP,
    promoteNavLayers,
} from './isobarLayerSetup';
import {
    buildRainViewerTileUrl,
    RAINVIEWER_MAP_TILE_SIZE,
    RAINVIEWER_NATIVE_MAX_ZOOM,
} from '../../services/weather/api/rainviewerTiles';
import { windForecastHoursForGrid } from './windTimeAxis';
import {
    RAIN_FRAME_CONTRAST,
    RAIN_FRAME_OPACITY,
    RAIN_FRAME_SATURATION,
    RainFrameTransitionController,
    type RainFrameMap,
} from './rainFrameTransition';
import { CMEMS_DATASETS } from '../../services/weather/api/cmemsGridTrust';
import { isWeatherLayerAvailable } from './cmemsFeatureAvailability';
// PrecipHeatmapResult removed — replaced by Rainbow.ai XYZ tiles

/** Remove every RainViewer/Rainbow frame from a map before a fresh session. */
function removeRainFrameLayers(map: mapboxgl.Map, maxFrames = 30): void {
    for (let i = 0; i < maxFrames; i++) {
        for (const prefix of ['radar-', 'rainbow-fc-']) {
            const id = `${prefix}${i}`;
            // Separate try blocks: a throwing removeLayer must not leave the
            // source behind, or the duplicate guard in the next session skips
            // recreating that frame and it can never paint again.
            try {
                if (map.getLayer(id)) map.removeLayer(id);
            } catch (error) {
                log.warn('[rain] frame layer cleanup failed', error);
            }
            try {
                if (map.getSource(id)) map.removeSource(id);
            } catch (error) {
                log.warn('[rain] frame source cleanup failed', error);
            }
        }
    }
}

const RAIN_FRAME_LAYER_RE = /^(?:radar|rainbow-fc)-\d+$/;
/** Layers that, when they end up above rain, make it read as "shows nothing". */
const RAIN_COVER_LAYER_IDS = [
    'hybrid-base-layer',
    'satellite-base-layer',
    'wind-heatmap-layer',
    'wind-heatmap-layer_r',
];

/**
 * Keep every rain frame above the opaque chart. Rain is anchored below the
 * label stack at creation, but two things legitimately move AFTER it exists:
 * the hybrid/satellite base is appended to the TOP of the style when no ENC
 * layer is mounted yet to anchor it (MapHub's imagery healer is a no-op
 * without an enc-vec-* layer), and a late ENC cell mount re-anchors its whole
 * stack at the same label rain used. Either way rain keeps painting —
 * underneath an opaque chart — which is exactly the reported "rain layer
 * sometimes shows nothing". Mirrors ensureWindHeatmapLayerOrder: writes only
 * when the invariant is violated, so the coalesced styledata pass terminates.
 */
function ensureRainLayerOrder(map: mapboxgl.Map): void {
    try {
        const layers = map.getStyle()?.layers ?? [];
        if (layers.length === 0) return;

        let minRainIdx = -1;
        let maxCoverIdx = -1;
        for (let i = 0; i < layers.length; i++) {
            const layer = layers[i] as { id: string; layout?: { visibility?: string } };
            if (RAIN_FRAME_LAYER_RE.test(layer.id)) {
                if (minRainIdx === -1) minRainIdx = i;
                continue;
            }
            if (RAIN_COVER_LAYER_IDS.includes(layer.id) || layer.id.startsWith('enc-vec-')) {
                let visible = layer.layout?.visibility !== 'none';
                try {
                    const visibility = map.getLayoutProperty(layer.id, 'visibility');
                    if (visibility != null) visible = visibility !== 'none';
                } catch {
                    /* keep the style-object reading */
                }
                if (visible) maxCoverIdx = i;
            }
        }
        if (minRainIdx === -1 || maxCoverIdx < minRainIdx) return;

        // Slot every rain frame (relative order preserved) immediately above
        // the topmost covering layer; undefined beforeId means top-of-style.
        const beforeId = layers.slice(maxCoverIdx + 1).find((layer) => !RAIN_FRAME_LAYER_RE.test(layer.id))?.id;
        for (const layer of layers) {
            if (RAIN_FRAME_LAYER_RE.test(layer.id)) map.moveLayer(layer.id, beforeId);
        }
        log.info('[rain] z-order healed — frames were under the chart');
    } catch {
        // Style in transit; the next styledata pass retries.
    }
}

/** Return the model-valid UTC instant represented by one pressure frame. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function pressureFrameValidAt(grid: any, frameIndex: number): number | null {
    const refTimeMs = new Date(grid?.refTime ?? '').getTime();
    const stepHours = Number(grid?.subFrameStepHours);
    if (!Number.isFinite(refTimeMs) || !Number.isFinite(stepHours) || stepHours <= 0) return null;

    return refTimeMs + Math.max(0, Math.round(frameIndex)) * stepHours * 60 * 60 * 1000;
}

/** Find the nearest frame in a refreshed pressure run for a valid UTC instant. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function pressureFrameForValidAt(grid: any, validAt: number | null): number | null {
    if (validAt === null) return null;
    const refTimeMs = new Date(grid?.refTime ?? '').getTime();
    const stepHours = Number(grid?.subFrameStepHours);
    const totalHours = Number(grid?.totalHours);
    if (
        !Number.isFinite(refTimeMs) ||
        !Number.isFinite(stepHours) ||
        stepHours <= 0 ||
        !Number.isFinite(totalHours) ||
        totalHours < 1
    ) {
        return null;
    }

    return Math.max(0, Math.min(Math.round((validAt - refTimeMs) / (stepHours * 60 * 60 * 1000)), totalHours - 1));
}

/**
 * The animated wind field is the chart page's signature look, so it is what
 * a first run opens on (Shane 2026-07-21: "that beautiful wind layer… i miss
 * it"). Nothing about it was ever deleted — the renderer has been
 * byte-identical since March. It went missing because the restore below used
 * to strip it on EVERY launch, so even after switching it on the next open
 * lost it again, and THE PURGE then wiped the layer set once per device.
 */
export const DEFAULT_LAYERS: WeatherLayer[] = ['wind'];

/** Keep decoded CMEMS ownership to one visible marine product at a time. */
export function enforceCmemsMarineExclusivity(
    layers: ReadonlySet<WeatherLayer>,
    preferred?: WeatherLayer,
): Set<WeatherLayer> {
    const next = new Set(layers);
    const activeMarine = SEA_STATE_LAYERS.filter((layer) => next.has(layer));
    if (activeMarine.length <= 1) return next;
    const keep = preferred && activeMarine.includes(preferred) ? preferred : activeMarine[activeMarine.length - 1];
    for (const layer of activeMarine) {
        if (layer !== keep) next.delete(layer);
    }
    return next;
}

const SESSION_LAYERS_KEY = 'thalassa_active_layers';

/**
 * The layer set a chart MOUNT opens with.
 *
 * Two rules, both Shane's, held at once (2026-08-21: "on first startup, we
 * have the wind, however if the punter has adjusted things (like ais on and
 * wind off for example) can it persist after going to another screen?"):
 *   - COLD APP START → wind only (the 2026-08-04 rule, unchanged). No
 *     localStorage restore — layer state must never haunt a later boot
 *     (house philosophy, MapHub satellite-base notes).
 *   - WITHIN A SESSION → the punter's own toggles win. sessionStorage is
 *     exactly that scope: it dies with the process, so a tab-switch or an
 *     error-boundary remount keeps their selection while every fresh launch
 *     still opens on the signature wind field.
 * (At HEAD the keep-alive chart rarely remounts in-session; this seam makes
 * the behaviour explicit and covers the remount paths that remain.)
 */
export function sessionInitialLayers(
    read: (key: string) => string | null = (key) => sessionStorage.getItem(key),
): Set<WeatherLayer> {
    // The read itself is guarded here, not in the default param — a webview
    // can throw on ANY storage access (private modes, quota lockouts), and a
    // chart that cannot read a preference must still open on wind.
    let stored: string | null = null;
    try {
        stored = read(SESSION_LAYERS_KEY);
    } catch {
        stored = null;
    }
    if (stored !== null) return restoreActiveLayers(stored);
    return new Set(DEFAULT_LAYERS);
}

/**
 * Which layers a stored preference should restore.
 *
 * The three cases are deliberately distinct:
 *   null / unparseable → first run, or pre-fix device → DEFAULT_LAYERS
 *   "[]"               → the user turned everything off → honour it
 *   ["wind", …]        → restore, minus any parked layer
 *
 * Parked layers drop because their pickers are gone: a persisted
 * 'waves'/'seaice'/'mld' would restore ON with no control left to turn it
 * off (Shane 2026-07-18). Wind is NOT filtered — it has a picker, and
 * discarding the user's own choice every launch was the bug.
 */
export function restoreActiveLayers(
    stored: string | null,
    layerAvailable: (layer: WeatherLayer) => boolean = isWeatherLayerAvailable,
): Set<WeatherLayer> {
    if (stored === null) return new Set(DEFAULT_LAYERS);
    try {
        const arr = JSON.parse(stored) as WeatherLayer[];
        if (!Array.isArray(arr)) return new Set(DEFAULT_LAYERS);
        return enforceCmemsMarineExclusivity(
            new Set(arr.filter((layer) => !isParkedLayer(layer) && layerAvailable(layer))),
        );
    } catch {
        return new Set(DEFAULT_LAYERS);
    }
}

/**
 * useWeatherLayers — all weather overlay state + side effects.
 */
export function useWeatherLayers(
    mapRef: MutableRefObject<mapboxgl.Map | null>,
    mapReady: boolean,
    embedded: boolean,
    location: { lat: number; lon: number },
    /**
     * PLAN PAGE (the tracer, MapHub's `coordCaptureMode`). The plan surface and
     * the browsing chart are ONE MapHub instance — nothing unmounts between
     * them — so without this every overlay the punter left on simply keeps
     * painting over the route they are trying to draw (Shane 2026-07-23: "any
     * layer that is on in the charts page, shows up on the planning page ... we
     * need our layer to show through").
     */
    planMode = false,
) {
    const windState = useWindStore();
    const windForecastHours = useMemo(() => windForecastHoursForGrid(windState.grid), [windState.grid]);

    // Multi-layer support — users can toggle multiple layers simultaneously.
    // Max 3 active layers for mobile performance.
    // Persisted to localStorage so selection survives app restart.
    const MAX_LAYERS = 4;
    const STORAGE_KEY = 'thalassa_active_layers';
    /**
     * THE PUNTER'S SELECTION — persisted, and the only thing the toggles write.
     * Distinct from `activeLayers` below, which is what is actually PAINTED.
     */
    const [userLayers, setUserLayers] = useState<Set<WeatherLayer>>(() => sessionInitialLayers());

    /**
     * WHAT IS ON THE MAP. Empty while plotting, so every add/remove effect below
     * tears its layer down through the SAME path it already uses when you switch
     * a layer off by hand — no second teardown to keep in sync.
     *
     * DERIVED, NEVER ASSIGNED. The obvious implementation is to snapshot and
     * `setActiveLayer('none')` on entry (which is what the pin-view suppressor
     * at MapHub.tsx:5166 does), but the persistence effect below writes on EVERY
     * change and `restoreActiveLayers` honours a stored "[]" as a deliberate
     * all-off. So a mutating suppressor writes "[]" to localStorage the moment
     * you start plotting, and a crash or force-quit mid-plot costs the punter
     * their whole chart selection permanently. Deriving cannot do that: the
     * suppression exists only for the render pass, and `userLayers` — the thing
     * that gets persisted — is never touched.
     */
    const EMPTY_LAYERS = useMemo(() => new Set<WeatherLayer>(), []);
    const activeLayers = planMode ? EMPTY_LAYERS : userLayers;
    const userKey = [...userLayers].sort().join(',');

    // Toggle a layer on/off. 'none' clears all layers.
    const toggleLayer = useCallback((layer: WeatherLayer) => {
        setUserLayers((prev) => {
            if (layer === 'none') return new Set<WeatherLayer>();
            const next = new Set(prev);
            if (next.has(layer)) {
                next.delete(layer);
            } else {
                if (next.size >= MAX_LAYERS) {
                    // At limit — prefer evicting static layers (temp, clouds, sea) over interactive (wind, rain)
                    const EVICTION_ORDER: WeatherLayer[] = [
                        'sea',
                        'clouds',
                        'temperature',
                        'pressure',
                        'rain',
                        'velocity',
                        'wind',
                    ];
                    let evicted = false;
                    for (const candidate of EVICTION_ORDER) {
                        if (next.has(candidate) && candidate !== layer) {
                            next.delete(candidate);
                            evicted = true;
                            break;
                        }
                    }
                    if (!evicted) {
                        // Fallback: remove the oldest (first)
                        const first = next.values().next().value;
                        if (first) next.delete(first);
                    }
                }
                next.add(layer);
            }
            return enforceCmemsMarineExclusivity(next, layer);
        });
    }, []);

    /** Explicit visibility setter used by fail-closed async layer boundaries. */
    const setLayerVisibility = useCallback((layer: WeatherLayer, visible: boolean) => {
        setUserLayers((prev) => {
            const next = new Set(prev);
            if (!visible) {
                next.delete(layer);
                return next;
            }
            next.add(layer);
            const exclusive = enforceCmemsMarineExclusivity(next, layer);
            while (exclusive.size > MAX_LAYERS) {
                const oldestOther = [...exclusive].find((candidate) => candidate !== layer);
                if (!oldestOther) break;
                exclusive.delete(oldestOther);
            }
            return exclusive;
        });
    }, []);

    // Select a layer with mutual exclusion within its group.
    // Other layers in the same group are turned off; cross-group layers stay.
    const selectInGroup = useCallback((layer: WeatherLayer, group: WeatherLayer[]) => {
        setUserLayers((prev) => {
            const next = new Set(prev);
            // Remove other layers in the same group
            for (const g of group) {
                if (g !== layer) next.delete(g);
            }
            // Toggle the selected layer (tap again to deselect)
            if (next.has(layer)) next.delete(layer);
            else next.add(layer);
            return enforceCmemsMarineExclusivity(next, layer);
        });
    }, []);

    // Persist layer selection to localStorage whenever it changes.
    // An empty selection WRITES "[]" rather than removing the key: with wind
    // as the first-run default, "no key" and "user turned everything off"
    // would otherwise be indistinguishable and every all-off would bounce
    // back to wind on the next launch.
    //
    // userLayers, NOT activeLayers — see the derivation above. Persisting the
    // rendered set would write "[]" for the whole time the tracer is open, and
    // that "[]" is honoured on next launch.
    useEffect(() => {
        try {
            const serialised = JSON.stringify([...userLayers]);
            localStorage.setItem(STORAGE_KEY, serialised);
            // The session mirror is what a same-session remount restores.
            sessionStorage.setItem(STORAGE_KEY, serialised);
        } catch {
            /* ignore */
        }
    }, [userLayers]);

    // Backward-compatible single-layer getter (priority: wind > rain > pressure > first)
    const activeLayer: WeatherLayer = (() => {
        if (activeLayers.size === 0) return 'none';
        if (activeLayers.has('velocity') || activeLayers.has('wind'))
            return activeLayers.has('velocity') ? 'velocity' : 'wind';
        if (activeLayers.has('rain')) return 'rain';
        if (activeLayers.has('pressure')) return 'pressure';
        return activeLayers.values().next().value ?? 'none';
    })();

    // Stable string key for useEffect deps — prevents re-fires from Set reference changes
    const activeKey = [...activeLayers].sort().join(',');
    // Fast boolean flags
    const _hasWind = activeLayers.has('wind') || activeLayers.has('velocity');
    const _hasRain = activeLayers.has('rain');
    // Legacy setter — sets exactly one layer (for backward compat with MapUI etc.)
    const setActiveLayer = useCallback((layer: WeatherLayer) => {
        if (layer === 'none') setUserLayers(new Set());
        else setUserLayers(new Set([layer]));
    }, []);

    // Wind GL engine
    const windEngineRef = useRef<WindParticleLayer | null>(null);
    const windGridRef = useRef<WindGrid | null>(null);
    const windMarkersRef = useRef<mapboxgl.Marker[]>([]);
    /** Actual forecast hours for each timeline index. The active grid owns
     *  this axis; plain Open-Meteo grids fall back to sequential hours. */
    const windForecastHoursRef = useRef<number[]>(windForecastHours);
    windForecastHoursRef.current = windForecastHours;

    // ── Unified Rain + Forecast scrubber ──
    interface UnifiedRainFrame {
        type: 'radar' | 'forecast';
        /** RainViewer tile path (radar only) */
        radarPath?: string;
        /** Provider-owned host published by the RainViewer index. */
        radarHost?: string;
        /** Unix timestamp (radar only) */
        radarTime?: number;
        /** Rainbow.ai XYZ tile URL template (forecast only) — contains {z}/{x}/{y} */
        forecastTileUrl?: string;
        /** Label for the scrubber */
        label: string;
    }
    const unifiedFramesRef = useRef<UnifiedRainFrame[]>([]);
    /** Timestamp of last rain-layer fetch. Used to auto-refresh the radar+forecast
     *  frames when the layer has been loaded for longer than RAIN_MAX_AGE_MS —
     *  otherwise the chart keeps showing hours-old radar while the weather has
     *  moved on. */
    const rainFetchedAtRef = useRef<number>(0);
    const RAIN_MAX_AGE_MS = 10 * 60 * 1000; // RainViewer publishes every 10 min
    /** Bumped by the self-heal timer to re-enter the rain build: a failed
     *  index fetch used to blank the layer for the whole session (nothing
     *  ever retried), and the 10-min staleness gate could only fire on a
     *  layer toggle — so long sessions kept tile URLs that had expired off
     *  RainViewer's ~2h window and silently 404'd. */
    const [rainRefreshNonce, setRainRefreshNonce] = useState(0);
    const rainLastAttemptRef = useRef(0);
    /** Session-scoped memo of the Rainbow.ai snapshot id. The snapshot endpoint
     *  is idempotent within a 5-minute window, so caching it here saves a
     *  ~200-500ms Supabase Edge Function roundtrip on quick rain re-toggles. */
    const rainbowSnapshotMemoRef = useRef<{ at: number; snapshot: number | null } | null>(null);
    const RAINBOW_SNAPSHOT_TTL_MS = 5 * 60 * 1000;
    /** Track which radar/forecast layer index is currently visible */
    const visibleRadarIdxRef = useRef<number | null>(null);
    const visibleForecastIdxRef = useRef<number | null>(null);
    const rainTransitionRef = useRef<RainFrameTransitionController | null>(null);
    if (rainTransitionRef.current === null) {
        rainTransitionRef.current = new RainFrameTransitionController((error) =>
            log.warn('[rain] frame transition failed', error),
        );
    }
    const cancelRainFrameTransition = useCallback((map: mapboxgl.Map | null) => {
        if (!map) return;
        rainTransitionRef.current?.cancel(map as unknown as RainFrameMap);
    }, []);
    const [rainFrameIndex, setRainFrameIndex] = useState(0);
    const [rainFrameCount, setRainFrameCount] = useState(0);
    const [rainPlaying, setRainPlaying] = useState(false);
    const [rainLoading, setRainLoading] = useState(false);
    /** True until the first visible radar tile has made it through a map render.
     *  The frame index can be ready before Mapbox has painted its pixels, so the
     *  OBS loading pill must use this separately from the metadata fetch state. */
    const [rainImageLoading, setRainImageLoading] = useState(false);
    const [rainReady, setRainReady] = useState(false);
    /** Index where radar frames end and forecast frames begin */
    const rainNowIdxRef = useRef(0);

    // Currents scrubber (CMEMS hourly forecast, h00..h12)
    const [currentsHour, setCurrentsHour] = useState(0);
    const [currentsPlaying, setCurrentsPlaying] = useState(false);
    // This value is a frame count, despite the retained public field name:
    // the inclusive h000..h012 forecast contains 13 selectable frames.
    const currentsTotalHours = CMEMS_DATASETS.currents.steps;
    /** Sub-frame index corresponding to wall-clock "Now". Updated on load
     *  and every minute while the layer is active so the Now marker creeps
     *  forward as real time marches on. */
    const currentsNowIdxRef = useRef(0);

    // Waves scrubber (CMEMS WAM, 3-hourly native, 48h window = 17 frames).
    // wavesHour is a STEP index (0..16); each step is +3h of forecast.
    const [wavesHour, setWavesHour] = useState(0);
    const [wavesPlaying, setWavesPlaying] = useState(false);
    const wavesTotalHours = CMEMS_DATASETS.waves.steps;
    const wavesNowIdxRef = useRef(0);

    // SST scrubber (CMEMS daily-mean, today + 5 forecast days = 6 frames
    // because the pipeline's start→end range is inclusive on both ends).
    const [sstStep, setSstStep] = useState(0);
    const [sstPlaying, setSstPlaying] = useState(false);
    const sstTotalSteps = CMEMS_DATASETS.sst.steps;
    const sstNowIdxRef = useRef(0);

    // Chlorophyll scrubber (CMEMS BGC daily, today + 5d = 6 frames).
    const [chlStep, setChlStep] = useState(0);
    const [chlPlaying, setChlPlaying] = useState(false);
    const chlTotalSteps = CMEMS_DATASETS.chl.steps;
    const chlNowIdxRef = useRef(0);

    // Sea-ice scrubber (CMEMS physics daily, today + 5d = 6 frames).
    const [seaiceStep, setSeaiceStep] = useState(0);
    const [seaicePlaying, setSeaicePlaying] = useState(false);
    const seaiceTotalSteps = CMEMS_DATASETS.seaice.steps;
    const seaiceNowIdxRef = useRef(0);

    // Mixed-layer depth scrubber (CMEMS physics daily, today + 5d = 6 frames).
    const [mldStep, setMldStep] = useState(0);
    const [mldPlaying, setMldPlaying] = useState(false);
    const mldTotalSteps = CMEMS_DATASETS.mld.steps;
    const mldNowIdxRef = useRef(0);

    // Marine Protected Areas (verified CAPAD-derived GeoJSON). Static overlay —
    // not time-scrubbed, can co-exist with any weather layer (a user
    // wants to see currents AND know where they can fish). Persisted
    // separately from the WeatherLayer set since it isn't mutually
    // exclusive with anything.
    const MPA_STORAGE_KEY = 'thalassa_mpa_visible';
    const [mpaVisible, setMpaVisibleState] = useState<boolean>(() => {
        try {
            return localStorage.getItem(MPA_STORAGE_KEY) === '1';
        } catch {
            return false;
        }
    });
    const setMpaVisible = useCallback((next: boolean) => {
        setMpaVisibleState(next);
        try {
            localStorage.setItem(MPA_STORAGE_KEY, next ? '1' : '0');
        } catch {
            /* private mode / quota — ignore */
        }
    }, []);

    // Wind scrubber
    const [windHour, setWindHourInternal] = useState(0);
    const [windTotalHours, setWindTotalHours] = useState(0);
    const [windPlaying, setWindPlaying] = useState(false);
    const [windReady, setWindReady] = useState(false);
    const [windMaxSpeed, setWindMaxSpeed] = useState(30);
    /** The wind scrubber index that corresponds to 'now' (current time) */
    const [windNowIdx, setWindNowIdx] = useState(0);
    const windNowIdxRef = useRef(0);
    /** GFS model run time for dynamic 'now' recomputation */
    const windRefTimeRef = useRef<string | null>(null);
    /** Whether the user has manually scrubbed (prevents auto-advance temporarily) */
    const windUserScrubbedRef = useRef(false);
    /** Timestamp of last manual scrub — auto-advance resumes after 5 min */
    const windUserScrubbedTimeRef = useRef(0);

    /** Wrapper for external callers — marks manual scrub */
    const setWindHour = useCallback((valOrFn: number | ((prev: number) => number)) => {
        windUserScrubbedRef.current = true;
        windUserScrubbedTimeRef.current = Date.now();
        setWindHourInternal((prev) => {
            const next = typeof valOrFn === 'function' ? valOrFn(prev) : valOrFn;
            WindStore.setState({ hour: next });
            return next;
        });
    }, []);

    /** Compute which forecast hour index best matches 'now' given the model refTime */
    const computeNowIndex = useCallback((refTime: string, fhrs: number[]): number => {
        const ageMs = Date.now() - new Date(refTime).getTime();
        const ageHours = ageMs / (60 * 60 * 1000);
        let bestIdx = 0;
        let bestDiff = Math.abs(fhrs[0] - ageHours);
        for (let i = 1; i < fhrs.length; i++) {
            const diff = Math.abs(fhrs[i] - ageHours);
            if (diff < bestDiff) {
                bestDiff = diff;
                bestIdx = i;
            }
        }
        return bestIdx;
    }, []);

    /**
     * Keep every wind timeline consumer attached to the grid that is actually
     * in WindStore. activate() is not the only publisher: viewport refreshes,
     * model switches and offline loads can replace the grid later.
     */
    useEffect(() => {
        const currentGrid = windState.grid;
        if (!currentGrid || windForecastHours.length === 0) {
            windGridRef.current = null;
            windRefTimeRef.current = null;
            windNowIdxRef.current = 0;
            setWindNowIdx(0);
            setWindTotalHours(0);
            setWindReady(false);
            setWindPlaying(false);
            setWindHourInternal(0);
            if (WindStore.getState().hour !== 0) WindStore.setState({ hour: 0 });
            return;
        }

        windGridRef.current = currentGrid;
        setWindTotalHours(windForecastHours.length);
        setWindReady(true);

        const refTimeMs = currentGrid.refTime ? new Date(currentGrid.refTime).getTime() : Number.NaN;
        const hasValidRefTime = Number.isFinite(refTimeMs);
        const nextNowIdx = hasValidRefTime ? computeNowIndex(currentGrid.refTime!, windForecastHours) : 0;
        windRefTimeRef.current = hasValidRefTime ? currentGrid.refTime! : null;
        windNowIdxRef.current = nextNowIdx;
        setWindNowIdx(nextNowIdx);

        const manualAge = Date.now() - windUserScrubbedTimeRef.current;
        const userRecentlyScrubbed = windUserScrubbedRef.current && manualAge < 5 * 60 * 1000;
        if (!userRecentlyScrubbed) windUserScrubbedRef.current = false;

        setWindHourInternal((previous) => {
            const clampedPrevious = Math.max(0, Math.min(previous, windForecastHours.length - 1));
            const next = userRecentlyScrubbed ? clampedPrevious : nextNowIdx;
            if (WindStore.getState().hour !== next) WindStore.setState({ hour: next });
            return next;
        });

        log.info(
            `[WindScrubber] Grid metadata synced: totalHours=${windForecastHours.length}, ` +
                `nowIndex=${nextNowIdx}, forecastHour=${windForecastHours[nextNowIdx]}`,
        );
    }, [windState.grid, windForecastHours, computeNowIndex]);

    // GRIB download
    const [isGribDownloading, setIsGribDownloading] = useState(false);
    const [gribProgress, setGribProgress] = useState(0);
    const [gribError, setGribError] = useState<string | null>(null);

    // ── Isobar state ──
    const isobarFetchRef = useRef<number>(0);
    const isobarFetchedAtRef = useRef(0);
    const isobarLoadingRef = useRef(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cachedFramesRef = useRef<any[]>([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cachedGridRef = useRef<any>(null); // Cache the raw grid to avoid re-fetching
    const [forecastHour, setForecastHour] = useState(0);
    const forecastHourRef = useRef(forecastHour);
    forecastHourRef.current = forecastHour;
    const [isPlaying, setIsPlaying] = useState(false);
    const [totalFrames, setTotalFrames] = useState(FORECAST_HOURS);
    const [framesReady, setFramesReady] = useState(0);
    const [pressureFrameStepHours, setPressureFrameStepHours] = useState(1);
    const [pressureSource, setPressureSource] = useState<'gfs' | 'open-meteo' | null>(null);
    /** Sub-frame index that corresponds to wall-clock "Now", computed from
     *  the GFS cycle refTime + keyframe fhrs + subFrameStepHours. When the
     *  GFS cycle is 4h old, this is the sub-frame that represents "+4h of
     *  model forecast" — i.e. the model's prediction for right now. */
    const pressureNowIdxRef = useRef(0);
    /** True while isobars ride another layer (wind, rain…) instead of owning
     *  the chart as the standalone synoptic view. Read by applyFrame so a
     *  freshly-created heatmap layer starts hidden in overlay mode. */
    const pressureOverlayModeRef = useRef(false);
    const playRafRef = useRef<number | null>(null);
    const lastFrameTimeRef = useRef(0);

    // Swap pre-computed isobar data into map sources
    const applyFrame = useCallback((hour: number) => {
        const map = mapRef.current;
        const frames = cachedFramesRef.current;
        if (!map || !frames[hour]) return;
        const result = frames[hour];
        const contourSrc = map.getSource('isobar-contours') as mapboxgl.GeoJSONSource;
        const centersSrc = map.getSource('isobar-centers') as mapboxgl.GeoJSONSource;
        const barbsSrc = map.getSource('wind-barbs') as mapboxgl.GeoJSONSource;
        const arrowsSrc = map.getSource('circulation-arrows') as mapboxgl.GeoJSONSource;
        const tracksSrc = map.getSource('movement-tracks') as mapboxgl.GeoJSONSource;
        if (contourSrc) contourSrc.setData(result.contours);
        if (centersSrc) centersSrc.setData(result.centers);
        if (barbsSrc) barbsSrc.setData(result.barbs);
        if (arrowsSrc) arrowsSrc.setData(result.arrows);
        if (tracksSrc) tracksSrc.setData(result.tracks);

        if (result.heatmapDataUrl && result.heatmapBounds) {
            const [west, south, east, north] = result.heatmapBounds;
            const coordinates: [[number, number], [number, number], [number, number], [number, number]] = [
                [west, north],
                [east, north],
                [east, south],
                [west, south],
            ];
            const existingSrc = map.getSource('pressure-heatmap') as mapboxgl.ImageSource;
            if (existingSrc) {
                existingSrc.updateImage({ url: result.heatmapDataUrl, coordinates });
            } else {
                map.addSource('pressure-heatmap', { type: 'image', url: result.heatmapDataUrl, coordinates });
                map.addLayer(
                    {
                        id: 'pressure-heatmap-layer',
                        type: 'raster',
                        source: 'pressure-heatmap',
                        // Born hidden in overlay mode: the heatmap belongs to
                        // the standalone synoptic chart only, and this layer
                        // is often first created by a scrub AFTER the mode
                        // was decided.
                        layout: { visibility: pressureOverlayModeRef.current ? 'none' : 'visible' },
                        // ONE transparency authority: the ramp's own per-value
                        // alpha (isobars.ts colorStops). A flat 0.82 on top of
                        // it double-dimmed the extremes — the part of the
                        // field that must carry — while doing nothing to make
                        // ordinary pressure recede, because JPEG had already
                        // thrown the alpha away. PNG restored it; this lets it
                        // do its job (2026-08-21).
                        paint: {
                            'raster-opacity': 1,
                            'raster-saturation': 0.08,
                            'raster-contrast': 0.08,
                            'raster-fade-duration': 0,
                        },
                    },
                    // Beneath the whole contour stack — the shadow layer is
                    // its new bottom.
                    map.getLayer('isobar-shadow')
                        ? 'isobar-shadow'
                        : map.getLayer('isobar-lines')
                          ? 'isobar-lines'
                          : undefined,
                );
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Pre-compute remaining isobar frames in background (frame 0 already shown).
    // Skip heatmap for interpolated sub-frames — they reuse the nearest keyframe's heatmap.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const precomputeFrames = useCallback((grid: any) => {
        const total = grid.totalHours as number;
        setTotalFrames(total);

        // Preserve any frames already seeded by updateIsobars (at minimum
        // frame 0; also the Now frame when the GFS cycle is stale).
        const existing = cachedFramesRef.current;
        cachedFramesRef.current = new Array(total);
        let seededCount = 0;
        for (let h = 0; h < existing.length; h++) {
            if (existing[h]) {
                cachedFramesRef.current[h] = existing[h];
                seededCount++;
            }
        }
        setFramesReady(seededCount);

        let idx = 1; // Start from frame 1 — frame 0 is already done
        // 2, was 3 (2026-08-21). Sub-frames borrow the previous keyframe's
        // pressure wash, so the interval IS the worst-case disagreement
        // between the colour field and the isobars drawn on it: at 3 with
        // subFrameStepHours=2 the wash could be 4 hours behind its own lines
        // and jumped every third frame during playback. At 2 every sub-frame
        // is adjacent to its keyframe, which is what isobars.ts's
        // MAX_HEATMAP_REUSE_FRAMES now enforces. Costs ~3 extra canvas
        // encodes across the batch; the FRAMES_PER_CHUNK tick keeps them off
        // the gesture path.
        const KEYFRAME_INTERVAL = 2;
        const FRAMES_PER_CHUNK = 3;
        const computeBatch = () => {
            // REAL chunks. `Math.min(idx + total, total)` always equalled
            // total, so all remaining frames computed in ONE synchronous
            // block and the setTimeout chaining below was dead code. That was
            // accepted when the grid had 13 frames ("completes in <200ms");
            // the 42h extension made it 22 frames — measured ~0.5s of
            // contouring plus the keyframe heatmap canvas/JPEG work, i.e. a
            // visible freeze of gestures and wind particles on combo
            // formation, recurring on every 30-minute grid refresh (audit
            // 2026-08-02). Three frames per tick keeps each block inside a
            // frame budget; framesReady already reports incremental progress
            // and the wind-sync effect re-fires on it.
            const batchEnd = Math.min(idx + FRAMES_PER_CHUNK, total);
            for (let h = idx; h < batchEnd; h++) {
                const isKeyframe = h % KEYFRAME_INTERVAL === 0 || h === total - 1;
                cachedFramesRef.current[h] = generateIsobarsFromGrid(grid, h, !isKeyframe);
            }
            setFramesReady(batchEnd);
            idx = batchEnd;
            if (idx < total) setTimeout(computeBatch, 0);
        };
        // Small delay to let frame 0 render first, then compute the rest
        setTimeout(computeBatch, 50);
    }, []);

    /** Compute which sub-frame corresponds to wall-clock "Now" for the
     *  pressure timeline. Mirrors the wind layer's computeNowIndex pattern:
     *  takes the age of the GFS cycle and divides by sub-frame step hours.
     *  Returns 0 if no refTime (e.g. Open-Meteo fallback) or if the data
     *  shape is unexpected. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const computePressureNowIndex = useCallback((grid: any): number => {
        if (!grid?.refTime || !grid?.subFrameStepHours) return 0;
        const ageMs = Date.now() - new Date(grid.refTime).getTime();
        const ageHours = ageMs / (60 * 60 * 1000);
        const idx = Math.round(ageHours / grid.subFrameStepHours);
        // Clamp to the valid range — if the GFS cycle is way out of date we
        // show the first frame rather than falling off the end.
        return Math.max(0, Math.min(idx, (grid.totalHours ?? 1) - 1));
    }, []);

    const updateIsobars = useCallback(
        async (map: mapboxgl.Map) => {
            const cacheAgeMs = Date.now() - isobarFetchedAtRef.current;
            const cacheIsFresh =
                cachedGridRef.current &&
                cachedFramesRef.current.length > 0 &&
                isobarFetchedAtRef.current > 0 &&
                cacheAgeMs < 30 * 60 * 1000;

            // The grid is global at 1° resolution, so pan/zoom can use the
            // same data. It must still be renewed for the next GFS cycle:
            // keeping an old run indefinitely makes a believable, stale chart.
            if (cacheIsFresh) {
                const nowIdx = computePressureNowIndex(cachedGridRef.current);
                const idx = Math.max(0, Math.min(forecastHourRef.current, cachedFramesRef.current.length - 1));
                pressureNowIdxRef.current = nowIdx;
                // Re-applying a cached chart after another layer toggles must
                // not erase the passage time the user deliberately selected.
                setForecastHour(idx);
                applyFrame(idx);
                return;
            }

            // Avoid competing full-globe requests when the main layer effect
            // and the periodic freshness check happen in the same render turn.
            if (isobarLoadingRef.current) return;
            isobarLoadingRef.current = true;
            const token = ++isobarFetchRef.current;
            const previousValidAt = pressureFrameValidAt(cachedGridRef.current, forecastHourRef.current);

            // Fetch ONCE: fixed global grid. At 1° resolution this is only ~65K
            // points per frame (~320K total for 5 frames) — fast to fetch and process.
            try {
                const data = await generateIsobars(85, -85, -180, 180, map.getZoom());
                if (token !== isobarFetchRef.current || !data) return;

                // Preserve the currently displayed *valid time* across a GFS
                // cycle refresh. Otherwise a user reading +6h can suddenly be
                // shown a different meteorological instant simply because the
                // model's reference clock advanced.
                const preservedFrame = pressureFrameForValidAt(data.grid, previousValidAt);

                cachedGridRef.current = data.grid;
                isobarFetchedAtRef.current = Date.now();
                setPressureFrameStepHours(data.grid.subFrameStepHours || 1);
                setPressureSource(data.grid.source);

                // Align the scrubber to wall-clock "Now" so a stale GFS cycle
                // (e.g. 4h old) shows the +4h sub-frame labelled Now, not the
                // cycle-0 sub-frame. Matches wind's computeNowIndex behaviour.
                const nowIdx = computePressureNowIndex(data.grid);
                const idx = preservedFrame ?? nowIdx;
                pressureNowIdxRef.current = nowIdx;

                // Seed the cached frames array with frame 0 (pre-computed as
                // part of the fetch) AND — if the selected frame isn't frame
                // 0 — synchronously compute it so the first render has real
                // isobars rather than waiting for the background batch.
                const seededFrames: unknown[] = [data.result];
                if (idx !== 0) {
                    seededFrames[idx] = generateIsobarsFromGrid(data.grid, idx, false);
                }
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                cachedFramesRef.current = seededFrames as any[];
                setForecastHour(idx);
                applyFrame(idx);

                // Precompute remaining frames in background (non-blocking)
                precomputeFrames(data.grid);
            } finally {
                if (token === isobarFetchRef.current) isobarLoadingRef.current = false;
            }
        },
        [applyFrame, precomputeFrames, computePressureNowIndex],
    );

    // Isobar playback RAF. Gated on the layer being active AND standalone:
    // the Baro timeline (the only pause control) is replaced by the wind
    // scrubber in the wind+pressure combo, so a playback started standalone
    // would otherwise keep time-lapsing the isobars every 350 ms with no
    // control left anywhere to stop it, fighting the wind→pressure sync
    // effect tick for tick (audit 2026-08-02).
    useEffect(() => {
        const comboActive = activeLayers.has('wind') || activeLayers.has('velocity');
        const standalonePressure = activeLayers.has('pressure') && !comboActive;
        if (!isPlaying || !standalonePressure) {
            if (playRafRef.current) cancelAnimationFrame(playRafRef.current);
            playRafRef.current = null;
            // Drop the flag too, so the timeline doesn't resume playing by
            // surprise when the layer combination changes back.
            if (isPlaying && !standalonePressure) setIsPlaying(false);
            return;
        }
        const animate = (timestamp: number) => {
            // Skip processing when app is backgrounded — saves battery
            if (document.hidden) {
                playRafRef.current = requestAnimationFrame(animate);
                return;
            }
            if (timestamp - lastFrameTimeRef.current >= 350) {
                lastFrameTimeRef.current = timestamp;
                setForecastHour((prev) => {
                    const max = cachedFramesRef.current.length;
                    const next = prev + 1;
                    if (next >= max || !cachedFramesRef.current[next]) return 0;
                    return next;
                });
            }
            playRafRef.current = requestAnimationFrame(animate);
        };
        lastFrameTimeRef.current = performance.now();
        playRafRef.current = requestAnimationFrame(animate);
        return () => {
            if (playRafRef.current) cancelAnimationFrame(playRafRef.current);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isPlaying, activeKey]);

    // Apply isobar frame on hour change
    useEffect(() => {
        if (activeLayers.has('pressure')) applyFrame(forecastHour);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [forecastHour, activeKey, applyFrame]);

    // ── Wind + pressure overlay: ONE timeline ──
    // When isobars ride the wind layer, the wind scrubber is the single time
    // authority and the isobar frame follows it. Both timelines are anchored
    // to wall-clock Now (windNowIdx / pressureNowIdx), so the mapping is
    // "hours from now" translated into pressure sub-frames and clamped to the
    // coverage the pressure grid actually has.
    useEffect(() => {
        if (!activeLayers.has('pressure')) return;
        if (!activeLayers.has('wind') && !activeLayers.has('velocity')) return;
        const grid = cachedGridRef.current;
        const frameCount = cachedFramesRef.current.length;
        if (!grid || frameCount === 0) return;
        const offs = windForecastHours;
        if (offs.length === 0) return;

        // windHour is fractional during playback — interpolate its offset.
        const i0 = Math.max(0, Math.min(Math.floor(windHour), offs.length - 1));
        const i1 = Math.min(i0 + 1, offs.length - 1);
        const t = Math.max(0, Math.min(windHour - i0, 1));
        const windOffset = (offs[i0] ?? 0) * (1 - t) + (offs[i1] ?? 0) * t;
        const hoursFromNow = windOffset - (offs[windNowIdx] ?? 0);

        const stepHours = grid.subFrameStepHours || 1;
        const target = pressureNowIdxRef.current + hoursFromNow / stepHours;
        const idx = Math.max(0, Math.min(Math.round(target), frameCount - 1));
        if (idx !== forecastHourRef.current) {
            setForecastHour(idx);
        } else if (cachedFramesRef.current[idx]) {
            // Same index, but the frame data may have JUST landed: on combo
            // formation this effect fires from framesReady while the target
            // frame is still uncomputed, forecastHour gets set, the
            // apply-on-hour-change effect no-ops on the missing frame — and
            // when the precompute batch finally delivers it, nothing
            // repainted, leaving the isobars showing "now" under a +30h wind
            // label (audit 2026-08-02). Re-applying is a cheap setData.
            applyFrame(idx);
        }
        // framesReady re-fires this once the background precompute lands.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [windHour, windNowIdx, windForecastHours, activeKey, framesReady, pressureFrameStepHours, applyFrame]);

    // ── Wind scrubber: update GL engine on hour change ──
    useEffect(() => {
        if (
            (!activeLayers.has('wind') && !activeLayers.has('velocity')) ||
            !windEngineRef.current ||
            !windGridRef.current
        )
            return;
        windEngineRef.current.setForecastHour(windHour);
        setWindMaxSpeed(windEngineRef.current.getMaxSpeed());

        const m = mapRef.current;
        const grid = windGridRef.current;
        if (!m || !grid) return;
        // CLAMP LOW TOO. `Math.min(floor(windHour), totalHours - 1)` alone goes
        // NEGATIVE when a grid arrives with totalHours 0 — an empty
        // wind_speed_10m array from Open-Meteo is enough — and speed[-1] is
        // undefined.
        const h = Math.max(0, Math.min(Math.floor(windHour), grid.totalHours - 1));
        const step = Math.max(2, Math.floor(Math.max(grid.width, grid.height) / 5));

        // READ BEFORE YOU DESTROY (Shane 2026-07-22: "when i press the arrow on
        // the scrubber, the wind disappears completely").
        //
        // This used to remove every marker and THEN index grid.speed[h] /
        // u[h] / v[h] unguarded, dereferencing sData[idx] on the next line. Any
        // hour the arrays do not cover threw a TypeError with the old markers
        // already gone — so the failure mode was a TOTAL WIPE rather than a
        // held frame, and it only showed once something advanced windHour,
        // i.e. on PLAY. An exception inside the effect also aborts the rebuild
        // for every later frame, so it never recovers on its own.
        //
        // Bail BEFORE clearing: keeping last frame's barbs is always better
        // than an empty ocean, and this cannot mask a real gap — the warning
        // names the hour and the grid.
        const sData = grid.speed[h];
        const uData = grid.u[h];
        const vData = grid.v[h];
        if (!sData || !uData || !vData) {
            log.warn(
                `[wind] no grid data at hour ${h} (totalHours=${grid.totalHours}, ` +
                    `speed=${grid.speed?.length ?? 0}) — keeping the last frame`,
            );
            return;
        }

        windMarkersRef.current.forEach((mk) => mk.remove());
        windMarkersRef.current = [];
        for (let r = 0; r < grid.height; r += step) {
            for (let c = 0; c < grid.width; c += step) {
                const idx = r * grid.width + c;
                const speedKts = Math.round(sData[idx] * 1.94384);
                const dir = ((Math.atan2(-uData[idx], -vData[idx]) * 180) / Math.PI + 360) % 360;
                const dirs = [
                    'N',
                    'NNE',
                    'NE',
                    'ENE',
                    'E',
                    'ESE',
                    'SE',
                    'SSE',
                    'S',
                    'SSW',
                    'SW',
                    'WSW',
                    'W',
                    'WNW',
                    'NW',
                    'NNW',
                ];
                const cardinal = dirs[Math.round(dir / 22.5) % 16];

                const el = createWindLabelMarker(speedKts, cardinal, getWindColor(speedKts));

                const marker = new mapboxgl.Marker({ element: el, anchor: 'center' })
                    .setLngLat([grid.lons[c], grid.lats[r]])
                    .addTo(m);
                windMarkersRef.current.push(marker);
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [windHour, activeKey]);

    // Wind auto-play — fractional steps for smooth morphing between hours
    useEffect(() => {
        if (!windPlaying || (!activeLayers.has('wind') && !activeLayers.has('velocity'))) return;
        const timer = setInterval(() => {
            setWindHour((prev) => {
                const next = prev + 0.1;
                if (next >= windTotalHours) {
                    setWindPlaying(false);
                    return 0;
                }
                return Math.round(next * 10) / 10; // avoid float drift
            });
        }, 100);
        return () => clearInterval(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [windPlaying, activeKey, windTotalHours]);

    // CMEMS autoplay is coordinated in MapHub after each hook reports that
    // the exact requested frame has been verified and handed to its renderer.
    // A fixed interval here would advance the scrubber while slow downloads
    // are still in flight, causing the next effect cleanup to abort them.

    // ── Wind forecast data loading (for scrubber — rendering handled by MapboxVelocityOverlay) ──
    useEffect(() => {
        if ((!activeLayers.has('wind') && !activeLayers.has('velocity')) || !mapReady) return;
        setWindHourInternal(0);
        windUserScrubbedRef.current = false;
        windUserScrubbedTimeRef.current = 0;
        if (WindStore.getState().hour !== 0) WindStore.setState({ hour: 0 });

        // 200 ms, was 800: the delay exists to let the geolock flyTo settle
        // before the viewport-bound fetch reads the camera — but the fetch
        // already pads the viewport ±30% and refetches on >40% drift, so a
        // still-moving camera costs at most a top-up, while 600 ms of every
        // single OBS open is pure waiting (Shane 2026-08-21: "make the wind
        // show up far quicker").
        const windTimer = setTimeout(() => {
            const m = mapRef.current;
            if (!m) return;
            void WindDataController.activate(m).catch((err) => {
                log.warn('activate() failed:', err);
            });
        }, 200);
        return () => clearTimeout(windTimer);
        // Re-runs on model/field switch too. Grid metadata is synchronised by
        // the windState.grid effect above, including later viewport refreshes.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeKey, mapReady, windState.model, windState.field]);

    // ── Periodically recompute "now" index (every 1 min) ──
    useEffect(() => {
        if (!windReady) return;
        const interval = setInterval(() => {
            const refTime = windRefTimeRef.current;
            const fhrs = windForecastHoursRef.current;
            if (!refTime || fhrs.length === 0) return;
            const newNowIdx = computeNowIndex(refTime, fhrs);
            const oldNowIdx = windNowIdxRef.current;

            // Always update the now-index reference
            if (newNowIdx !== oldNowIdx) {
                windNowIdxRef.current = newNowIdx;
                setWindNowIdx(newNowIdx);
            }

            // Auto-advance scrubber to track real time:
            // Skip if user manually scrubbed within the last 5 minutes
            const manualAge = Date.now() - windUserScrubbedTimeRef.current;
            const MANUAL_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
            if (windUserScrubbedRef.current && manualAge < MANUAL_COOLDOWN_MS) {
                return; // User recently scrubbed — leave their position alone
            }

            // Reset the manual flag after cooldown, then auto-advance
            windUserScrubbedRef.current = false;
            setWindHourInternal((prev) => {
                if (prev !== newNowIdx) {
                    log.info(
                        `[WindScrubber] Auto-tracking "now": ${prev} → ${newNowIdx} (forecast hour ${fhrs[newNowIdx]})`,
                    );
                    WindStore.setState({ hour: newNowIdx });
                    return newNowIdx;
                }
                return prev;
            });
        }, 60 * 1000); // Every 1 minute
        return () => clearInterval(interval);
    }, [windReady, computeNowIndex]);

    // ── CMEMS Now-alignment helpers ───────────────────────────────────
    // Shared by the six CMEMS layers (currents, waves, sst, chl, seaice,
    // mld). Each layer's verified loader attaches `refTime` (= manifest
    // data_start, the actual source time for step 0). We turn the
    // age-since-refTime into a step index using the layer's cadence.
    //
    // For hourly data (currents, 1h step), nowIdx = ageHours rounded.
    // For 3-hourly (waves), nowIdx = ageHours / 3 rounded.
    // For daily (sst/chl/seaice/mld), nowIdx = ageDays floored — "today"
    // is whatever day the wall clock is currently inside.
    //
    // Null means the verified source does not cover wall-clock now. We never
    // clamp stale/future data to an endpoint and label that endpoint "Now".
    const computeCmemsNowIndex = useCallback(
        (refTime: string | undefined, stepHours: number, totalSteps: number): number | null => {
            if (!refTime || totalSteps <= 0) return null;
            const ageMs = Date.now() - new Date(refTime).getTime();
            const ageHours = ageMs / (60 * 60 * 1000);
            if (!Number.isFinite(ageHours)) return null;
            // Daily data (stepHours === 24) uses floor so "today" stays on
            // day 0 until wall-clock crosses into tomorrow. Sub-day data
            // uses round so we snap to the closest step.
            const raw = stepHours >= 24 ? Math.floor(ageHours / stepHours) : Math.round(ageHours / stepHours);
            return raw >= 0 && raw < totalSteps ? raw : null;
        },
        [],
    );

    /** Manual-scrub backoff flags — shared across all six CMEMS layers so
     *  the minute-tick doesn't yank the scrubber away from where the user
     *  just placed it. Same 5-minute cooldown as wind/pressure. */
    const cmemsUserScrubbedRefs = useRef<
        Record<'currents' | 'waves' | 'sst' | 'chl' | 'seaice' | 'mld', { scrubbed: boolean; at: number }>
    >({
        currents: { scrubbed: false, at: 0 },
        waves: { scrubbed: false, at: 0 },
        sst: { scrubbed: false, at: 0 },
        chl: { scrubbed: false, at: 0 },
        seaice: { scrubbed: false, at: 0 },
        mld: { scrubbed: false, at: 0 },
    });
    const CMEMS_MANUAL_COOLDOWN_MS = 5 * 60 * 1000;

    // ── Currents: align scrubber to Now on load + every minute ────────
    useEffect(() => {
        if (!activeLayers.has('currents')) return;
        let cancelled = false;
        const align = async () => {
            const { fetchCurrentsManifest } = await import('../../services/weather/api/currentsGrid');
            const manifest = await fetchCurrentsManifest();
            if (cancelled) return;
            const idx = computeCmemsNowIndex(
                manifest?.data_start,
                manifest?.cadence_hours ?? 1,
                manifest?.files.length ?? currentsTotalHours,
            );
            currentsNowIdxRef.current = idx ?? -1;
            if (idx === null) return;
            const s = cmemsUserScrubbedRefs.current.currents;
            if (s.scrubbed && Date.now() - s.at < CMEMS_MANUAL_COOLDOWN_MS) return;
            s.scrubbed = false;
            setCurrentsHour((prev) => (prev !== idx ? idx : prev));
        };
        align();
        const interval = setInterval(align, 60 * 1000);
        return () => {
            cancelled = true;
            clearInterval(interval);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeKey, computeCmemsNowIndex]);

    // ── Waves: align scrubber to Now on load + every minute ───────────
    useEffect(() => {
        if (!activeLayers.has('waves')) return;
        let cancelled = false;
        const align = async () => {
            const { fetchWavesManifest } = await import('../../services/weather/api/wavesGrid');
            const manifest = await fetchWavesManifest();
            if (cancelled) return;
            const idx = computeCmemsNowIndex(
                manifest?.data_start,
                manifest?.cadence_hours ?? 3,
                manifest?.files.length ?? wavesTotalHours,
            );
            wavesNowIdxRef.current = idx ?? -1;
            if (idx === null) return;
            const s = cmemsUserScrubbedRefs.current.waves;
            if (s.scrubbed && Date.now() - s.at < CMEMS_MANUAL_COOLDOWN_MS) return;
            s.scrubbed = false;
            setWavesHour((prev) => (prev !== idx ? idx : prev));
        };
        align();
        const interval = setInterval(align, 60 * 1000);
        return () => {
            cancelled = true;
            clearInterval(interval);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeKey, computeCmemsNowIndex]);

    // ── SST / Chl / Seaice / MLD: daily cadence ───────────────────────
    // All four use manifest-only metadata for their 6-step, 24-hour axes.
    // Scrubber alignment must never download a full-resolution THCU frame.
    useEffect(() => {
        if (!activeLayers.has('sst')) return;
        let cancelled = false;
        const align = async () => {
            const { fetchSstManifest } = await import('../../services/weather/api/sstGrid');
            const manifest = await fetchSstManifest();
            if (cancelled) return;
            const idx = computeCmemsNowIndex(
                manifest?.data_start,
                manifest?.cadence_hours ?? 24,
                manifest?.files.length ?? sstTotalSteps,
            );
            sstNowIdxRef.current = idx ?? -1;
            if (idx === null) return;
            const s = cmemsUserScrubbedRefs.current.sst;
            if (s.scrubbed && Date.now() - s.at < CMEMS_MANUAL_COOLDOWN_MS) return;
            s.scrubbed = false;
            setSstStep((prev) => (prev !== idx ? idx : prev));
        };
        align();
        // Daily data — re-check once an hour is more than enough.
        const interval = setInterval(align, 60 * 60 * 1000);
        return () => {
            cancelled = true;
            clearInterval(interval);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeKey, computeCmemsNowIndex]);

    useEffect(() => {
        if (!activeLayers.has('chl')) return;
        let cancelled = false;
        const align = async () => {
            const { fetchChlManifest } = await import('../../services/weather/api/chlGrid');
            const manifest = await fetchChlManifest();
            if (cancelled) return;
            const idx = computeCmemsNowIndex(
                manifest?.data_start,
                manifest?.cadence_hours ?? 24,
                manifest?.files.length ?? chlTotalSteps,
            );
            chlNowIdxRef.current = idx ?? -1;
            if (idx === null) return;
            const s = cmemsUserScrubbedRefs.current.chl;
            if (s.scrubbed && Date.now() - s.at < CMEMS_MANUAL_COOLDOWN_MS) return;
            s.scrubbed = false;
            setChlStep((prev) => (prev !== idx ? idx : prev));
        };
        align();
        const interval = setInterval(align, 60 * 60 * 1000);
        return () => {
            cancelled = true;
            clearInterval(interval);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeKey, computeCmemsNowIndex]);

    useEffect(() => {
        if (!activeLayers.has('seaice')) return;
        let cancelled = false;
        const align = async () => {
            const { fetchSeaIceManifest } = await import('../../services/weather/api/seaiceGrid');
            const manifest = await fetchSeaIceManifest();
            if (cancelled) return;
            const idx = computeCmemsNowIndex(
                manifest?.data_start,
                manifest?.cadence_hours ?? 24,
                manifest?.files.length ?? seaiceTotalSteps,
            );
            seaiceNowIdxRef.current = idx ?? -1;
            if (idx === null) return;
            const s = cmemsUserScrubbedRefs.current.seaice;
            if (s.scrubbed && Date.now() - s.at < CMEMS_MANUAL_COOLDOWN_MS) return;
            s.scrubbed = false;
            setSeaiceStep((prev) => (prev !== idx ? idx : prev));
        };
        align();
        const interval = setInterval(align, 60 * 60 * 1000);
        return () => {
            cancelled = true;
            clearInterval(interval);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeKey, computeCmemsNowIndex]);

    useEffect(() => {
        if (!activeLayers.has('mld')) return;
        let cancelled = false;
        const align = async () => {
            const { fetchMldManifest } = await import('../../services/weather/api/mldGrid');
            const manifest = await fetchMldManifest();
            if (cancelled) return;
            const idx = computeCmemsNowIndex(
                manifest?.data_start,
                manifest?.cadence_hours ?? 24,
                manifest?.files.length ?? mldTotalSteps,
            );
            mldNowIdxRef.current = idx ?? -1;
            if (idx === null) return;
            const s = cmemsUserScrubbedRefs.current.mld;
            if (s.scrubbed && Date.now() - s.at < CMEMS_MANUAL_COOLDOWN_MS) return;
            s.scrubbed = false;
            setMldStep((prev) => (prev !== idx ? idx : prev));
        };
        align();
        const interval = setInterval(align, 60 * 60 * 1000);
        return () => {
            cancelled = true;
            clearInterval(interval);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeKey, computeCmemsNowIndex]);

    // ── Pressure scrubber: recompute Now every minute and auto-advance ──
    // Same rationale as the wind equivalent above: "Now" is a moving
    // target as wall-clock time marches on, so we slide the scrubber
    // forward unless the user has recently scrubbed manually. Skips
    // when no cached grid (layer not active or not yet loaded).
    const pressureUserScrubbedRef = useRef(false);
    const pressureUserScrubbedTimeRef = useRef(0);
    useEffect(() => {
        if (!activeLayers.has('pressure')) return;
        const interval = setInterval(() => {
            const grid = cachedGridRef.current;
            if (!grid) return;

            // GFS publishes new cycles throughout the day. The global grid
            // stays valid across panning, but not indefinitely; refresh it on
            // a bounded cadence while retaining the currently visible valid
            // time through updateIsobars().
            if (Date.now() - isobarFetchedAtRef.current >= 30 * 60 * 1000) {
                const map = mapRef.current;
                if (map) void updateIsobars(map);
                return;
            }
            const newNowIdx = computePressureNowIndex(grid);
            pressureNowIdxRef.current = newNowIdx;

            // In the wind+pressure overlay the wind timeline is the single
            // time authority (see the sync effect above) — advancing the
            // isobar frame here would fight it.
            if (activeLayers.has('wind') || activeLayers.has('velocity')) return;

            // Skip auto-advance if user manually scrubbed within the last 5 min
            const manualAge = Date.now() - pressureUserScrubbedTimeRef.current;
            const MANUAL_COOLDOWN_MS = 5 * 60 * 1000;
            if (pressureUserScrubbedRef.current && manualAge < MANUAL_COOLDOWN_MS) return;

            pressureUserScrubbedRef.current = false;
            setForecastHour((prev) => (prev !== newNowIdx ? newNowIdx : prev));
        }, 60 * 1000);
        return () => clearInterval(interval);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeKey, computePressureNowIndex, updateIsobars]);

    // ── Center map when switching layers + WIND GEOLOCK ──
    const prevLayerCountRef = useRef(0);
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady || embedded) return;

        const hasWind = activeLayers.has('wind') || activeLayers.has('velocity');
        const hasPressureLayer = activeLayers.has('pressure');
        const layerCount = activeLayers.size;

        // AU+NZ fit zoom is published by useMapInit as the "opens-on" target
        // but is NOT used as a hard floor — the user wants to pinch out to
        // world view when no weather layer forces a constraint.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ausNzMin: number = (map as any).__ausNzMinZoom ?? 3;

        if (hasPressureLayer && layerCount === 1) {
            // STANDALONE pressure/synoptic — only makes sense at synoptic
            // scale, so the ceiling stays tight. The FLOOR is pressure's own
            // framing zoom (2.0), NOT the AU+NZ fit: this floor and MapHub's
            // framing ease are two halves of one decision, and when they
            // disagreed the floor silently won. Mapbox clamps easeTo at call
            // time, so the old `max(ausNzMin, 3)` swallowed the 2.0 ease and
            // tapping the pressure FAB landed at 3 — indistinguishable from
            // the framing never firing (Shane 2026-07-23). Derived, so they
            // cannot drift apart again.
            //
            // Solo only: as an overlay on wind (or any other layer) pressure
            // must not steal the host layer's zoom range — clamping a z10
            // wind view to z7 because isobars were added yanked the camera.
            map.setMinZoom(LAYER_FRAME_ZOOM.pressure ?? 2);
            map.setMaxZoom(7);
            map.setMaxBounds(undefined!);
        } else if (hasWind) {
            // Wind particle overlay needs enough pixels on screen to look right,
            // while still allowing the chart to reach wind's authoritative
            // opening frame on a wide tablet/desktop canvas.
            //
            // With the isobar overlay riding wind, the floor drops to
            // pressure's 2.0 — isobars are a synoptic read and the user must
            // be able to pinch out for the whole-ocean picture — while wind's
            // full tile depth stays available.
            // Wind never zooms out past z3 (Shane 2026-08-04: "no more than
            // the default zoom level") — including when the isobar overlay
            // rides along. Solo pressure (branch above) keeps its deliberate
            // z2 synoptic frame.
            //
            // The CEILING is z9 (Shane 2026-08-08: "the punter can zoom
            // between 3-9 only"). It used to be 18, which let the chart run
            // four levels past anything the wind field could actually
            // resolve: the particles are seeded from a global forecast grid,
            // so past synoptic scale you are watching interpolation, drawn
            // with total confidence, over a street map. Mapbox clamps the
            // live camera the moment this is set, so activating wind while
            // zoomed deeper pulls back to z9 rather than leaving the map
            // outside its own limit.
            map.setMinZoom(Math.max(LAYER_FRAME_ZOOM.wind ?? 3, 3));
            map.setMaxZoom(9);
            map.setMaxBounds(undefined!);
        } else {
            // No weather layer → full zoom-in depth, but the zoom-out floor
            // stays at z3 / the AU+NZ fit (Shane 2026-08-04) — world view at
            // z1 was disorienting more than useful. Solo pressure above keeps
            // its deliberate z2 synoptic framing.
            map.setMinZoom(Math.min(3, ausNzMin));
            map.setMaxZoom(22);
            map.setMaxBounds(undefined!);
        }

        // Zoom to the first active layer's authoritative frame on FIRST
        // activation. Keep the current map centre so we don't yank the user
        // away from wherever they were already looking; only ease the zoom if
        // the user isn't already there or deeper.
        if (!planMode && layerCount > 0 && prevLayerCountRef.current === 0) {
            const currentZoom = map.getZoom();
            const centre = map.getCenter();
            const activationZoom = getActiveLayerFrameZoom(activeLayers) ?? 5;
            if (currentZoom < activationZoom - 0.5) {
                map.flyTo({ center: [centre.lng, centre.lat], zoom: activationZoom, duration: 800 });
            }
        }
        // Suppression is presentation-only. Remember the user's real layer
        // count while Plan is open so returning to Chart is not mistaken for a
        // fresh activation (which used to trigger an unwanted camera jump).
        prevLayerCountRef.current = planMode ? userLayers.size : layerCount;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mapReady, embedded, activeKey, userKey, planMode]);

    // Rain auto-play (unified radar + forecast) — loops continuously
    useEffect(() => {
        if (!rainPlaying || !activeLayers.has('rain')) return;
        const timer = setInterval(() => {
            // Pause when app is backgrounded
            if (document.hidden) return;
            // On a cold connection, advancing again would cancel the one
            // frame currently warming up and leave the animation permanently
            // behind its UI. Hold this step until the handoff commits.
            if (rainTransitionRef.current?.isTransitioning()) return;
            setRainFrameIndex((prev) => {
                if (prev + 1 >= rainFrameCount) return 0; // loop back to start
                return prev + 1;
            });
        }, 600);
        return () => clearInterval(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [rainPlaying, activeKey, rainFrameCount]);

    // Unified rain frame swap. Parked layers stay layout-hidden until one is
    // requested; RainFrameTransitionController warms that one at opacity zero
    // and only replaces the image already on screen after its tiles are ready.
    const rainCleanupRef = useRef<(() => void) | null>(null);
    const rainInitialPaintCleanupRef = useRef<(() => void) | null>(null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const savedLandFillColorsRef = useRef<Map<string, any>>(new Map());

    useEffect(() => {
        const m = mapRef.current;
        if (!activeLayers.has('rain') || !rainReady || !m) {
            cancelRainFrameTransition(m);
            return;
        }
        const frames = unifiedFramesRef.current;
        if (rainFrameIndex >= frames.length) return;
        const frame = frames[rainFrameIndex];

        let targetId: string | null = null;
        let commitVisibleFrame: (() => void) | null = null;
        if (frame.type === 'radar' && frame.radarPath) {
            const radarFrames = frames.filter((f) => f.type === 'radar');
            const rdIdx = radarFrames.indexOf(frame);
            if (rdIdx >= 0) {
                targetId = `radar-${rdIdx}`;
                commitVisibleFrame = () => {
                    visibleRadarIdxRef.current = rdIdx;
                    visibleForecastIdxRef.current = null;
                };
            }
        } else if (frame.type === 'forecast' && frame.forecastTileUrl) {
            const forecastFrames = frames.filter((f) => f.type === 'forecast');
            const fcIdx = forecastFrames.indexOf(frame);
            if (fcIdx >= 0) {
                targetId = `rainbow-fc-${fcIdx}`;
                commitVisibleFrame = () => {
                    visibleForecastIdxRef.current = fcIdx;
                    visibleRadarIdxRef.current = null;
                };
            }
        }

        if (!targetId || !commitVisibleFrame) return;

        const visibleIds = [
            visibleRadarIdxRef.current === null ? null : `radar-${visibleRadarIdxRef.current}`,
            visibleForecastIdxRef.current === null ? null : `rainbow-fc-${visibleForecastIdxRef.current}`,
        ].filter((id): id is string => id !== null);

        rainTransitionRef.current?.request(m as unknown as RainFrameMap, targetId, visibleIds, commitVisibleFrame);

        return () => cancelRainFrameTransition(m);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [rainFrameIndex, activeKey, rainReady, cancelRainFrameTransition]);

    // ── Weather Layer Toggle (main effect) ──
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady) return;

        // Remove layers NOT in active set
        if (!activeLayers.has('rain')) {
            // Clean up rain sources/layers when rain is deactivated
            cancelRainFrameTransition(map);
            // ABORT THE IN-FLIGHT LOAD. This is the important line.
            //
            // The teardown used to remove the layers and reset the refs without
            // ever telling the running load to stop — rainCleanupRef, which is
            // what sets `stale` and aborts, is only ever called on UNMOUNT, and
            // is overwritten by each new session. So a load in flight survived
            // its own teardown, then finished into a torn-down world: it either
            // re-added layers after everything had been removed, or raced a
            // second activation into "there is already a source with ID
            // radar-0", whose catch sets rainReady(false). Either way rain went
            // dead until an app restart, with tiles sometimes still painted.
            //
            // This was always latent — it needed two fast hand-toggles. Then
            // 6714c58c made the plan page empty activeLayers, so every
            // chart -> plan -> chart round trip runs this teardown and the race
            // became something you hit by using the app normally. That is the
            // "rain does not seem to be working" report.
            rainCleanupRef.current?.();
            rainCleanupRef.current = null;
            rainInitialPaintCleanupRef.current?.();
            rainInitialPaintCleanupRef.current = null;
            // The session cleanup owns normal teardown. This catches any
            // stale source left behind by an interrupted/older session.
            removeRainFrameLayers(map);
            unifiedFramesRef.current = [];
            rainFetchedAtRef.current = 0; // Next activation gets a fresh fetch
            // Stale indices would otherwise hide a freshly-created frame on the
            // next activation — harmless while frames were parked at opacity 0,
            // a real blank frame now that hiding is a layout write.
            visibleRadarIdxRef.current = null;
            visibleForecastIdxRef.current = null;
            setRainFrameCount(0);
            setRainFrameIndex(0);
            setRainImageLoading(false);
            setRainReady(false);
        }
        if (!activeLayers.has('wind') && !activeLayers.has('velocity')) {
            if (map.getLayer('wind-labels')) map.removeLayer('wind-labels');
            if (map.getSource('wind-labels')) map.removeSource('wind-labels');
            windMarkersRef.current.forEach((mk) => mk.remove());
            windMarkersRef.current = [];
            try {
                if (map.getLayer('wind-particles')) map.removeLayer('wind-particles');
            } catch (_) {
                log.warn('[useWeatherLayers]', _);
            }
            windEngineRef.current = null;
            WindDataController.deactivate(map);
            setWindReady(false);
        }

        if (!activeLayers.has('pressure')) {
            hideIsobarLayers(map, savedLandFillColorsRef.current);
            // Clear cached grid so a fresh one is fetched next time the layer activates
            ++isobarFetchRef.current;
            isobarLoadingRef.current = false;
            isobarFetchedAtRef.current = 0;
            cachedGridRef.current = null;
            cachedFramesRef.current = [];
            pressureOverlayModeRef.current = false;
            setPressureFrameStepHours(1);
            setPressureSource(null);
        }

        // ── Static tile layers (sea, temperature, clouds) ──
        // Remove tile layers NOT in active set — must run BEFORE the early return
        // below, otherwise toggling off the last layer skips cleanup.
        // When the CMEMS particle layer is enabled, `currents` is served by
        // useOceanCurrentParticleLayer instead of the Xweather raster tile.
        const cmemsCurrentsEnabled =
            String(import.meta.env.VITE_CMEMS_CURRENTS_ENABLED ?? 'false').toLowerCase() === 'true';
        const cmemsWavesEnabled = String(import.meta.env.VITE_CMEMS_WAVES_ENABLED ?? 'false').toLowerCase() === 'true';
        const cmemsSstEnabled = String(import.meta.env.VITE_CMEMS_SST_ENABLED ?? 'false').toLowerCase() === 'true';
        // Note: chlorophyll isn't in this gate — it's a net-new CMEMS
        // layer with no Xweather tile equivalent to replace.
        const TILE_LAYERS: WeatherLayer[] = [
            'sea',
            'temperature',
            'clouds',
            ...(cmemsWavesEnabled ? [] : (['waves'] as WeatherLayer[])),
            ...(cmemsCurrentsEnabled ? [] : (['currents'] as WeatherLayer[])),
            ...(cmemsSstEnabled ? [] : (['sst'] as WeatherLayer[])),
            // wind-gusts/visibility/cape removed 2026-04-22 with Xweather.
        ];
        for (const tl of TILE_LAYERS) {
            const tileId = `tiles-${tl}`;
            if (!activeLayers.has(tl)) {
                try {
                    if (map.getLayer(tileId)) map.removeLayer(tileId);
                } catch (_) {
                    log.warn('[useWeatherLayers]', _);
                }
                try {
                    if (map.getSource(tileId)) map.removeSource(tileId);
                } catch (_) {
                    log.warn('[useWeatherLayers]', _);
                }
            }
        }
        // When CMEMS currents is on, ensure the legacy Xweather raster currents
        // tile is gone — it was served by this loop before the feature flag was
        // introduced and may still be on the map from a prior session.
        if (cmemsCurrentsEnabled) {
            try {
                if (map.getLayer('tiles-currents')) map.removeLayer('tiles-currents');
            } catch (_) {
                log.warn('[useWeatherLayers] tiles-currents layer cleanup', _);
            }
            try {
                if (map.getSource('tiles-currents')) map.removeSource('tiles-currents');
            } catch (_) {
                log.warn('[useWeatherLayers] tiles-currents source cleanup', _);
            }
        }
        // Same for CMEMS waves — replaces the Xweather wave-height raster.
        if (cmemsWavesEnabled) {
            try {
                if (map.getLayer('tiles-waves')) map.removeLayer('tiles-waves');
            } catch (_) {
                log.warn('[useWeatherLayers] tiles-waves layer cleanup', _);
            }
            try {
                if (map.getSource('tiles-waves')) map.removeSource('tiles-waves');
            } catch (_) {
                log.warn('[useWeatherLayers] tiles-waves source cleanup', _);
            }
        }
        // Same for CMEMS SST — replaces the Xweather sst raster.
        if (cmemsSstEnabled) {
            try {
                if (map.getLayer('tiles-sst')) map.removeLayer('tiles-sst');
            } catch (_) {
                log.warn('[useWeatherLayers] tiles-sst layer cleanup', _);
            }
            try {
                if (map.getSource('tiles-sst')) map.removeSource('tiles-sst');
            } catch (_) {
                log.warn('[useWeatherLayers] tiles-sst source cleanup', _);
            }
        }

        // Sync permanent sea marks layers with the 'sea' toggle
        const seaVisible = activeLayers.has('sea') ? 'visible' : 'none';
        for (const lid of [
            'openseamap-permanent',
            'harbour-seamarks-circle',
            'harbour-seamarks-label',
            'nav-markers-glow',
            'nav-markers-dot',
        ]) {
            try {
                if (map.getLayer(lid)) map.setLayoutProperty(lid, 'visibility', seaVisible);
            } catch (_) {
                // Layer may not exist yet
            }
        }
        // Also clean up legacy single 'weather-tiles' source/layer
        try {
            if (map.getLayer('weather-tiles')) map.removeLayer('weather-tiles');
        } catch (_) {
            log.warn('[useWeatherLayers]', _);
        }
        try {
            if (map.getSource('weather-tiles')) map.removeSource('weather-tiles');
        } catch (_) {
            log.warn('[useWeatherLayers]', _);
        }

        // ── 'tiles-satellite' PERMANENT Esri base REMOVED (2026-07-11) ──
        // This always-on 0.85-opacity imagery raster was the app's
        // de-facto basemap — THE "old sat map" that survived every
        // satellite fix of the purge (all of which targeted
        // 'satellite-base-layer', a DIFFERENT layer). The white chart is
        // the map now; imagery exists only behind the explicit satellite
        // toggle. Actively removed (not just no-longer-added) so live
        // sessions heal without a reload.
        try {
            if (map.getLayer('tiles-satellite')) map.removeLayer('tiles-satellite');
            if (map.getSource('tiles-satellite')) map.removeSource('tiles-satellite');
        } catch (_) {
            /* style mid-swap — next pass heals */
        }

        // Himawari-9 IR satellite layer is now managed by useCycloneLayer.ts
        // — only shown when viewing active cyclones (storm page).

        if (activeLayers.size === 0) return;

        // ── Pressure / Isobars ──
        if (activeLayers.has('pressure')) {
            // Solo = the full standalone synoptic chart (heatmap, barbs,
            // charcoal land). Sharing the map with ANY other layer = the
            // clean isobar overlay: contours + H/L centres only, riding the
            // host layer's look (the Windy-style wind+isobar combo).
            const pressureOverlay = activeLayers.size > 1;
            pressureOverlayModeRef.current = pressureOverlay;
            initIsobarLayers(map);

            showIsobarLayers(map, savedLandFillColorsRef.current, pressureOverlay);
            updateIsobars(map);

            // ── Coastal Vignette Glow ── (standalone chart only)
            if (!pressureOverlay && !map.getLayer('coastal-vignette') && map.getSource('composite')) {
                map.addLayer({
                    id: 'coastal-vignette',
                    type: 'line',
                    source: 'composite',
                    'source-layer': 'water',
                    paint: {
                        'line-color': '#000814',
                        'line-width': 6,
                        'line-blur': 8,
                        'line-opacity': 0.6,
                    },
                });
            }
        }

        // ── Rain (unified: RainViewer radar past + GFS forecast future) ──
        // Fetch when: not loaded yet OR loaded but stale (>10 min). Without
        // the staleness gate the chart would keep showing hours-old radar
        // while current weather has moved on — one of the symptoms behind
        // the user's "it's showing rain here but sky is clear" report.
        const rainAge = Date.now() - rainFetchedAtRef.current;
        const rainStale = rainFetchedAtRef.current > 0 && rainAge > RAIN_MAX_AGE_MS;
        if (activeLayers.has('rain') && (unifiedFramesRef.current.length === 0 || rainStale)) {
            if (rainStale) {
                log.info(`[Rain] Layer data ${Math.round(rainAge / 60000)}m old — refreshing`);
                // Abort the old session before dropping its layers. The real
                // IDs are radar-* and rainbow-fc-*; the old rain-frame-* pass
                // never removed either, leaving stale imagery in the map.
                cancelRainFrameTransition(map);
                rainCleanupRef.current?.();
                rainCleanupRef.current = null;
                removeRainFrameLayers(map);
                unifiedFramesRef.current = [];
                rainFetchedAtRef.current = 0;
                visibleRadarIdxRef.current = null;
                visibleForecastIdxRef.current = null;
            }
            rainLastAttemptRef.current = Date.now();
            setRainLoading(true);
            setRainImageLoading(true);
            setRainReady(false);
            setRainFrameIndex(0);

            const abortCtrl = new AbortController();
            let stale = false;

            (async () => {
                // ═══════════════════════════════════════════════════════════
                // TWO-PHASE RAIN LOAD — the real fix for "10 seconds to show"
                // ═══════════════════════════════════════════════════════════
                // Previously we Promise.all'd RainViewer + Rainbow snapshot
                // and waited for BOTH before showing anything. Rainbow hits
                // a Supabase Edge Function whose default wall-clock is ~10s,
                // so a cold/slow Rainbow blocked the radar from appearing
                // for that full wall-clock — producing the symptom "rain
                // takes exactly 10 seconds to show".
                //
                // Now:
                //   Phase 1 — RainViewer only. Radar frames + layers go
                //             in the map, setRainReady(true) fires. User
                //             sees current rain within ~300ms.
                //   Phase 2 — Rainbow snapshot in the background with a
                //             hard 3s timeout. If it arrives, forecast
                //             frames get appended to the timeline and
                //             pre-created as hidden layers. If it doesn't,
                //             rain still works, just without future frames.
                // ═══════════════════════════════════════════════════════════
                const supabaseUrl = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_URL) || '';
                const RAINBOW_FORECAST_MINUTES = [10, 20, 30, 40, 50, 60, 80, 100, 120, 150, 180, 210, 240];
                const RAINBOW_HARD_TIMEOUT_MS = 3000;

                // Rainbow snapshot fetcher: memo → Pi passthrough → direct.
                // Hard 3s timeout so even a dead backend can't block us.
                const fetchRainbowSnapshot = async (): Promise<number | null> => {
                    const memo = rainbowSnapshotMemoRef.current;
                    if (memo && Date.now() - memo.at < RAINBOW_SNAPSHOT_TTL_MS) {
                        return memo.snapshot;
                    }
                    if (!supabaseUrl) return null;
                    const timeoutCtrl = new AbortController();
                    const timeoutTimer = setTimeout(() => timeoutCtrl.abort(), RAINBOW_HARD_TIMEOUT_MS);
                    // Link both the outer abort (layer toggled off) and the
                    // local timeout — either aborts the fetch.
                    const onOuterAbort = () => timeoutCtrl.abort();
                    abortCtrl.signal.addEventListener('abort', onOuterAbort);
                    try {
                        const upstream = `${supabaseUrl}/functions/v1/proxy-rainbow?action=snapshot&layer=precip-global`;
                        const piUrl = piCache.passthroughUrl(upstream, RAINBOW_SNAPSHOT_TTL_MS, 'rainbow-snapshot');
                        const snapResp = await fetch(piUrl ?? upstream, { signal: timeoutCtrl.signal });
                        if (!snapResp.ok) {
                            log.warn(`Rainbow.ai snapshot failed: ${snapResp.status}`);
                            return null;
                        }
                        const snapData = await snapResp.json();
                        const snapshot = snapData.snapshot ?? null;
                        rainbowSnapshotMemoRef.current = { at: Date.now(), snapshot };
                        log.info(`Rainbow.ai snapshot: ${snapshot}`);
                        return snapshot;
                    } catch (err) {
                        if (abortCtrl.signal.aborted) throw err;
                        log.warn(
                            `Rainbow.ai snapshot fetch failed or timed out (${RAINBOW_HARD_TIMEOUT_MS}ms) — using radar only:`,
                            err,
                        );
                        return null;
                    } finally {
                        clearTimeout(timeoutTimer);
                        abortCtrl.signal.removeEventListener('abort', onOuterAbort);
                    }
                };

                // ── PHASE 1: radar (fast path) ────────────────────────────
                try {
                    const { fetchRainviewerIndex } = await import('../../services/weather/api/rainviewerIndex');
                    const radarData = await fetchRainviewerIndex();
                    if (stale || abortCtrl.signal.aborted) {
                        setRainLoading(false);
                        return;
                    }

                    const past = radarData?.radar?.past ?? [];
                    const nowcast = radarData?.radar?.nowcast ?? [];
                    const allRadar = [...past, ...nowcast];
                    const radarHost = radarData?.host;

                    // Build radar-only unified timeline first so the UI can
                    // render as soon as it's ready.
                    const unified: UnifiedRainFrame[] = [];
                    const now = Date.now() / 1000;
                    for (const f of allRadar) {
                        const diffMin = Math.round((f.time - now) / 60);
                        let label: string;
                        if (Math.abs(diffMin) < 3) label = 'Now';
                        else if (Math.abs(diffMin) >= 60) {
                            const h = Math.round(diffMin / 60);
                            label = `${h > 0 ? '+' : ''}${h}h`;
                        } else label = `${diffMin > 0 ? '+' : ''}${diffMin}m`;
                        unified.push({
                            type: 'radar',
                            radarPath: f.path,
                            radarHost,
                            radarTime: f.time,
                            label,
                        });
                    }

                    const nowIdx = Math.max(0, past.length - 1);
                    rainNowIdxRef.current = nowIdx;
                    unifiedFramesRef.current = unified;
                    rainFetchedAtRef.current = Date.now();
                    setRainFrameCount(unified.length);
                    setRainFrameIndex(nowIdx);

                    const m = mapRef.current;
                    if (!m) {
                        setRainLoading(false);
                        setRainImageLoading(false);
                        return;
                    }

                    // NOTHING TO DRAW. The index fetch returning null (offline,
                    // a stalled Pi hop, RainViewer down) used to fall straight
                    // through to setRainReady(true) over an empty map, and
                    // stamp rainFetchedAtRef so the staleness gate treated the
                    // empty result as a good load — a rain layer that reports
                    // healthy and never paints, with nothing in the console.
                    if (allRadar.length === 0) {
                        log.warn('[rain] radar index empty — leaving rain unready so it retries');
                        rainFetchedAtRef.current = 0;
                        setRainLoading(false);
                        setRainImageLoading(false);
                        return;
                    }

                    // Insert rain ABOVE the chart, BELOW the labels.
                    //
                    // This used to anchor at the style's FIRST symbol layer,
                    // which was right when it was written (d74e3c81) — imagery
                    // sat at the bottom of the stack then. It does not survive
                    // what came later: the hybrid imagery is now moved up to
                    // just below the ENC stack, and ENC anchors at
                    // settlement-major-label, which is far ABOVE the first
                    // symbol. So rain was painting and then being covered by
                    // the opaque imagery and the ENC depth fills — the layer
                    // worked perfectly and was simply underneath the chart
                    // (Shane 2026-07-23: "my rain layer does not seem to be
                    // working").
                    //
                    // Anchoring on the SAME candidates ENC uses puts rain
                    // immediately below that anchor and therefore above the ENC
                    // layers already inserted before it, while still leaving
                    // the place labels on top.
                    const rainBeforeId = (() => {
                        const layers = m.getStyle()?.layers ?? [];
                        for (const id of [
                            'settlement-major-label',
                            'place-city',
                            'country-label',
                            'admin-0-boundary',
                        ]) {
                            if (layers.some((l) => l.id === id)) return id;
                        }
                        return layers.find((l) => l.type === 'symbol')?.id;
                    })();

                    const addRadarFrame = (i: number, rf: UnifiedRainFrame): void => {
                        if (!rf.radarPath) return;
                        const srcId = `radar-${i}`;
                        // Duplicate guard, mirroring the Phase-2 loop below.
                        // Without it a second activation racing the first threw
                        // "already a source with ID", which the outer catch
                        // turned into setRainReady(false) — leaving painted
                        // tiles, no scrubber and no way to swap frames for the
                        // rest of the mount.
                        if (m.getSource(srcId)) return;
                        m.addSource(srcId, {
                            type: 'raster',
                            tiles: [
                                buildRainViewerTileUrl(rf.radarPath, {
                                    host: rf.radarHost,
                                    size: RAINVIEWER_MAP_TILE_SIZE,
                                    zoom: '{z}',
                                    x: '{x}',
                                    y: '{y}',
                                }),
                            ],
                            tileSize: RAINVIEWER_MAP_TILE_SIZE,
                            minzoom: 2,
                            // RainViewer rejects native z8+. Keeping the source
                            // ceiling at z7 makes Mapbox overzoom the final
                            // valid 512px tile instead of displaying the
                            // provider's "Zoom Level Not Supported" error PNG.
                            maxzoom: RAINVIEWER_NATIVE_MAX_ZOOM,
                        });
                        m.addLayer(
                            {
                                id: srcId,
                                type: 'raster',
                                // Park by visibility, not opacity — the
                                // transition controller stages only the frame
                                // currently being requested.
                                // This is what stops 29 frames fetching at once.
                                layout: { visibility: i === nowIdx ? 'visible' : 'none' },
                                source: srcId,
                                paint: {
                                    'raster-opacity': RAIN_FRAME_OPACITY,
                                    'raster-opacity-transition': { duration: 200, delay: 0 },
                                    'raster-fade-duration': 0,
                                    // Lift the baked tiles off a dark chart —
                                    // the same treatment the pressure heatmap
                                    // already uses for the same reason. Modest
                                    // on purpose: enough that a cell reads as
                                    // weather, not so much that the palette
                                    // stops meaning what the legend says.
                                    'raster-saturation': RAIN_FRAME_SATURATION,
                                    'raster-contrast': RAIN_FRAME_CONTRAST,
                                },
                            },
                            rainBeforeId,
                        );
                    };

                    // THE VISIBLE FRAME FIRST. It is the last past frame, so in
                    // creation order it landed ~13th and its tiles queued behind
                    // every earlier frame's. It is the only one anyone is
                    // waiting on, so it goes to the front of the queue.
                    const radarFrames = unified.filter((f) => f.type === 'radar');
                    if (radarFrames[nowIdx]) addRadarFrame(nowIdx, radarFrames[nowIdx]);
                    visibleRadarIdxRef.current = nowIdx;
                    for (let i = 0; i < radarFrames.length; i++) {
                        if (i !== nowIdx) addRadarFrame(i, radarFrames[i]);
                    }
                    log.info(`Pre-created ${radarFrames.length} radar layers`);

                    // The source is now visible, but its first raster still has
                    // to travel through Mapbox's tile + render cycle. Keep the
                    // OBS loading pill up until that first image has actually
                    // had a paint pass; otherwise the status disappears just
                    // before the thing it describes appears.
                    const initialRadarSourceId = `radar-${nowIdx}`;
                    let firstTileReady = false;
                    let firstPaintWatchActive = true;
                    let initialPaintTimeout: ReturnType<typeof setTimeout> | null = null;
                    const onInitialRainRender = () => {
                        if (!firstTileReady) return;
                        finishInitialRainPaintWatch();
                    };
                    const onInitialRainSourceData = (event: mapboxgl.MapSourceDataEvent) => {
                        if (event.sourceId !== initialRadarSourceId) return;
                        // Tile errors must not leave the status spinning forever.
                        if (event.sourceDataType === 'error') {
                            finishInitialRainPaintWatch();
                            return;
                        }
                        if (event.tile == null) return;
                        firstTileReady = true;
                        try {
                            m.triggerRepaint();
                        } catch {
                            /* map is tearing down; the session cleanup resolves it */
                        }
                    };
                    const onInitialRainAbort = () => cleanupInitialRainPaintWatch();
                    const cleanupInitialRainPaintWatch = () => {
                        if (!firstPaintWatchActive) return;
                        firstPaintWatchActive = false;
                        if (initialPaintTimeout) clearTimeout(initialPaintTimeout);
                        m.off('sourcedata', onInitialRainSourceData);
                        m.off('render', onInitialRainRender);
                        abortCtrl.signal.removeEventListener('abort', onInitialRainAbort);
                        if (rainInitialPaintCleanupRef.current === cleanupInitialRainPaintWatch) {
                            rainInitialPaintCleanupRef.current = null;
                        }
                    };
                    const finishInitialRainPaintWatch = () => {
                        cleanupInitialRainPaintWatch();
                        if (!stale && !abortCtrl.signal.aborted) setRainImageLoading(false);
                    };
                    rainInitialPaintCleanupRef.current?.();
                    m.on('sourcedata', onInitialRainSourceData);
                    m.on('render', onInitialRainRender);
                    abortCtrl.signal.addEventListener('abort', onInitialRainAbort, { once: true });
                    initialPaintTimeout = setTimeout(finishInitialRainPaintWatch, 10_000);
                    rainInitialPaintCleanupRef.current = cleanupInitialRainPaintWatch;

                    setRainReady(true);
                    setRainLoading(false);
                    log.info(`Radar ready: ${allRadar.length} frames. Rainbow.ai loading in background…`);

                    // ── PHASE 2: Rainbow forecast (background) ────────────
                    // Doesn't block rainReady. If it fails or times out, the
                    // user still has a working rain layer.
                    (async () => {
                        const rainbowSnapshot = await fetchRainbowSnapshot();
                        if (stale || abortCtrl.signal.aborted) return;
                        if (!rainbowSnapshot) return;
                        const m2 = mapRef.current;
                        if (!m2) return;

                        // Append forecast frames to the unified timeline.
                        const current = unifiedFramesRef.current;
                        const forecastAppendStart = current.length;
                        const appended = [...current];
                        for (const mins of RAINBOW_FORECAST_MINUTES) {
                            let label: string;
                            if (mins < 60) label = `+${mins}m`;
                            else if (mins % 60 === 0) label = `+${mins / 60}h`;
                            else label = `+${Math.floor(mins / 60)}h${mins % 60}m`;
                            const forecastSecs = mins * 60;
                            const tileUrl = `${supabaseUrl}/functions/v1/proxy-rainbow?action=tile&layer=precip-global&snapshot=${rainbowSnapshot}&forecast=${forecastSecs}&z={z}&x={x}&y={y}&color=dbz_u8`;
                            appended.push({ type: 'forecast', forecastTileUrl: tileUrl, label });
                        }
                        // Pre-create forecast layers (all hidden initially).
                        for (let i = 0; i < RAINBOW_FORECAST_MINUTES.length; i++) {
                            const ff = appended[forecastAppendStart + i];
                            if (!ff?.forecastTileUrl) continue;
                            const srcId = `rainbow-fc-${i}`;
                            // Guard against a race where Phase-2 fires twice
                            // (e.g. rapid toggle off/on): skip if already
                            // present so we don't try to add a duplicate.
                            if (m2.getSource(srcId)) continue;
                            m2.addSource(srcId, {
                                type: 'raster',
                                tiles: [ff.forecastTileUrl],
                                tileSize: 256,
                                minzoom: 2,
                                // Rainbow's 1km native res doesn't add visible
                                // detail past z8 for ocean weather. Mapbox
                                // overzooms past 8 by stretching the z8 tile
                                // — identical-looking at typical phone zooms
                                // but ~16x fewer tile requests per zoom level.
                                maxzoom: 8,
                            });
                            m2.addLayer(
                                {
                                    id: srcId,
                                    type: 'raster',
                                    // Hidden by LAYOUT so it costs no tiles
                                    // until scrubbed to — the transition
                                    // controller warms one requested frame.
                                    layout: { visibility: 'none' },
                                    source: srcId,
                                    paint: {
                                        'raster-opacity': RAIN_FRAME_OPACITY,
                                        // Matched to the radar frames: one
                                        // palette AND one treatment, so
                                        // scrubbing across "now" changes the
                                        // data, never the colour language.
                                        'raster-saturation': RAIN_FRAME_SATURATION,
                                        'raster-contrast': RAIN_FRAME_CONTRAST,
                                        'raster-opacity-transition': { duration: 200, delay: 0 },
                                        'raster-fade-duration': 0,
                                        'raster-color': RAINVIEWER_COLOR_RAMP,
                                        'raster-color-mix': [1, 0, 0, 0],
                                        'raster-color-range': [0, 1],
                                    },
                                },
                                rainBeforeId,
                            );
                        }
                        // PUBLISH LAST. These two lines used to run BEFORE the
                        // loop above, so the moment they landed the scrubber
                        // advertised 13 forecast frames — and if the loop then
                        // threw (it has no try/catch of its own, unlike Phase 1)
                        // those frames had no layers behind them. Scrubbing or
                        // autoplaying into one painted nothing, which reads as
                        // rain flickering to blank mid-loop. Advertise only what
                        // actually exists.
                        unifiedFramesRef.current = appended;
                        setRainFrameCount(appended.length);
                        log.info(
                            `Rainbow forecast ready: ${RAINBOW_FORECAST_MINUTES.length} frames appended (timeline now ${appended.length}).`,
                        );
                    })().catch((e) => log.warn('[rain] forecast phase failed — radar still usable', e));
                } catch (err) {
                    log.error('Error loading unified rain data:', err);
                    setRainReady(false);
                    setRainLoading(false);
                    setRainImageLoading(false);
                }
            })();

            // Store cleanup for this rain session (called ONLY when rain is toggled off)
            rainCleanupRef.current = () => {
                stale = true;
                abortCtrl.abort();
                rainInitialPaintCleanupRef.current?.();
                rainInitialPaintCleanupRef.current = null;
                cancelRainFrameTransition(map);
                removeRainFrameLayers(map);
                unifiedFramesRef.current = [];
                setRainFrameCount(0);
                setRainImageLoading(false);
                setRainReady(false);
            };
        }

        // Add tile layers that ARE active
        for (const tl of TILE_LAYERS) {
            if (!activeLayers.has(tl)) continue;
            const tileId = `tiles-${tl}`;
            const tileUrl = getTileUrl(tl);
            if (!tileUrl) continue;
            // Skip if layer already exists and is visible
            if (map.getLayer(tileId)) continue;
            try {
                // Remove stale source if layer was removed but source persists
                if (map.getSource(tileId)) {
                    try {
                        map.removeSource(tileId);
                    } catch (_) {
                        /* source cleanup */
                    }
                }
                map.addSource(tileId, {
                    type: 'raster',
                    tiles: [tileUrl],
                    tileSize: 256,
                    maxzoom: 18,
                });
                // Per-layer opacity: sea marks stay solid, weather heatmaps
                // are translucent so coastlines/countries remain visible.
                const LAYER_OPACITY: Partial<Record<WeatherLayer, number>> = {
                    sea: 1.0,
                    temperature: 0.6,
                    clouds: 0.6,
                    waves: 0.65,
                    currents: 0.65,
                    sst: 0.65,
                    // wind-gusts/visibility/cape opacities removed with Xweather decommission.
                };
                map.addLayer(
                    {
                        id: tileId,
                        type: 'raster',
                        source: tileId,
                        paint: {
                            'raster-opacity': LAYER_OPACITY[tl] ?? 0.65,
                            // Kill Mapbox's default 300ms cross-fade — OWM
                            // tiles for clouds/temperature are a single
                            // static layer (no animation), so the fade is
                            // pure visual fluff that costs a paint cycle
                            // on every tile load. Match the satellite base
                            // layer which already runs with fade-duration 0.
                            'raster-fade-duration': 0,
                            // Smooth resampling when Mapbox overzooms past
                            // OWM's source maxzoom — looks better on a phone
                            // pinch-in without costing extra bandwidth.
                            'raster-resampling': 'linear',
                        },
                    },
                    map.getLayer('route-line-layer') ? 'route-line-layer' : undefined,
                );
                log.info(`Added tile layer: ${tileId}`);
            } catch (err) {
                log.warn(`Failed to add tile layer ${tileId}:`, err);
            }
        }

        // ── Glass Pane: promote nav layers above any newly-added weather layers ──
        // This is the core safety net: regardless of which weather layers were just
        // added/removed, route and supporting overlays always render on top.
        promoteNavLayers(map);

        // ── Scoped cleanup: rain teardown is handled at two distinct points ──
        // 1. Line 701: when rain is toggled OFF (removes layers + resets state)
        // 2. Unmount effect: resets refs (line ~1165)
        // Previously this return() destroyed rain on EVERY activeKey change,
        // causing rain to vanish when toggling wind/pressure/etc.
        return () => {
            // No-op — intentionally empty.
            // Rain layers persist across layer toggles and are only cleaned up
            // when rain is explicitly toggled off or the component unmounts.
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeKey, mapReady, updateIsobars, rainRefreshNonce]);

    // ── Rain self-heal: retry failures, refresh stale frames ──────────
    // The build above only runs when the main effect re-runs, which used to
    // mean "when the user toggles a layer". This timer re-enters it when a
    // fetch failed (index timeout on marine LTE) or the frames have outlived
    // RAIN_MAX_AGE_MS. The 55s attempt guard stops a dead network from being
    // hammered; rainviewerIndex has its own 6s timeout per attempt.
    useEffect(() => {
        if (!mapReady || !activeLayers.has('rain')) return;
        const timer = setInterval(() => {
            if (document.hidden) return;
            const failed = unifiedFramesRef.current.length === 0 && rainFetchedAtRef.current === 0;
            const stale = rainFetchedAtRef.current > 0 && Date.now() - rainFetchedAtRef.current > RAIN_MAX_AGE_MS;
            if ((failed || stale) && Date.now() - rainLastAttemptRef.current > 55_000) {
                setRainRefreshNonce((n) => n + 1);
            }
        }, 60_000);
        return () => clearInterval(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mapReady, activeKey]);

    // ── Rain manual retry ─────────────────────────────────────────────
    // The self-heal timer above eventually recovers a failed fetch, but it
    // only looks once a minute. The scrubber has been advertising "Retry"
    // under "No Data" the whole time with nothing wired to it, so a skipper
    // who lost radar tapped that word and watched it do nothing for up to 60
    // seconds. This is what the label promised.
    //
    // It routes through the session cleanup rather than just clearing the
    // frame array: that aborts the in-flight fetch and removes the radar-*
    // and rainbow-fc-* layers, so a retry can't leave orphaned tiles painted
    // under a fresh timeline. Clearing the frames is also what guarantees the
    // build guard re-enters — setting rainFetchedAtRef to 0 alone would NOT,
    // because staleness requires a non-zero stamp, and the spinner we raise
    // here would then never come down.
    const retryRain = useCallback(() => {
        log.info('[rain] manual retry requested');
        rainCleanupRef.current?.();
        rainCleanupRef.current = null;
        rainFetchedAtRef.current = 0;
        rainLastAttemptRef.current = 0;
        setRainLoading(true);
        setRainRefreshNonce((n) => n + 1);
    }, []);

    // ── Rain z-order healer ───────────────────────────────────────────
    // Deferred out of the styledata callback frame (style mutation inside the
    // render pass crashes placement) and coalesced like the wind heatmap's.
    useEffect(() => {
        if (!mapReady || !activeLayers.has('rain')) return;
        const map = mapRef.current;
        if (!map) return;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const reassert = () => {
            if (timer) return;
            timer = setTimeout(() => {
                timer = null;
                const m = mapRef.current;
                if (m) ensureRainLayerOrder(m);
            }, 150);
        };
        map.on('styledata', reassert);
        reassert();
        return () => {
            if (timer) clearTimeout(timer);
            map.off('styledata', reassert);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mapReady, activeKey]);

    // Global grid covers all zoom levels and viewport positions — no moveend re-fetch needed.
    // It is reused for panning and refreshed on a bounded GFS-cycle TTL.

    // ── Cleanup on unmount — ensures fresh re-initialization on re-entry ──
    useEffect(() => {
        const map = mapRef.current;
        return () => {
            // Invoke rain cleanup to remove map layers + abort pending fetches
            if (rainCleanupRef.current) {
                rainCleanupRef.current();
                rainCleanupRef.current = null;
            } else {
                cancelRainFrameTransition(map);
            }
            setWindReady(false);
            setRainImageLoading(false);
            setRainReady(false);
            setRainFrameCount(0);
            windEngineRef.current = null;
            windGridRef.current = null;
            unifiedFramesRef.current = [];
            // eslint-disable-next-line react-hooks/exhaustive-deps
            savedLandFillColorsRef.current.clear();
        };
    }, [cancelRainFrameTransition, mapRef]);

    return {
        activeLayer,
        setActiveLayer,
        /**
         * WHAT IS PAINTED — empty while plotting. Chrome that describes the map
         * (the helix scrubber, the legend) keys off this, so it stands down with
         * the layers instead of scrubbing a field nobody can see.
         */
        activeLayers,
        /**
         * WHAT THE PUNTER CHOSE — survives the plan page untouched. Use this,
         * never `activeLayers`, for anything that SNAPSHOTS the selection to
         * restore later (pin view does exactly that), or the restore brings
         * back an empty set.
         */
        userLayers,
        toggleLayer,
        setLayerVisibility,
        selectInGroup,
        // Wind
        windEngineRef,
        windGridRef,
        windMarkersRef,
        windState,
        windHour,
        setWindHour,
        windTotalHours,
        setWindTotalHours,
        windPlaying,
        setWindPlaying,
        windReady,
        setWindReady,
        windMaxSpeed,
        setWindMaxSpeed,
        windForecastHours,
        windForecastHoursRef,
        windNowIdx,
        windNowIdxRef,
        // Model + field switcher (chart wind overlay)
        windModel: windState.model,
        windField: windState.field,
        setWindModel: WindStore.setModel,
        setWindField: WindStore.setField,
        // Currents (CMEMS hourly forecast, gated by VITE_CMEMS_CURRENTS_ENABLED)
        currentsHour,
        setCurrentsHour: useCallback(
            (valOrFn: number | ((prev: number) => number)) => {
                const s = cmemsUserScrubbedRefs.current.currents;
                s.scrubbed = true;
                s.at = Date.now();
                setCurrentsHour(valOrFn);
            },

            [],
        ),
        currentsTotalHours,
        /** Step index that represents wall-clock "Now" for the currents
         *  layer. Consumed by MapHub's scrubber label — a 4h-old manifest
         *  makes nowIdx=4, so the +4h step labels "Now" instead of h00. */
        currentsNowIdx: currentsNowIdxRef.current,
        currentsPlaying,
        setCurrentsPlaying,
        // Waves (CMEMS WAM 3-hourly, gated by VITE_CMEMS_WAVES_ENABLED)
        wavesHour,
        setWavesHour: useCallback(
            (valOrFn: number | ((prev: number) => number)) => {
                const s = cmemsUserScrubbedRefs.current.waves;
                s.scrubbed = true;
                s.at = Date.now();
                setWavesHour(valOrFn);
            },

            [],
        ),
        wavesTotalHours,
        wavesNowIdx: wavesNowIdxRef.current,
        wavesPlaying,
        setWavesPlaying,
        // SST (CMEMS daily-mean 5-day forecast, gated by VITE_CMEMS_SST_ENABLED)
        sstStep,
        setSstStep: useCallback(
            (valOrFn: number | ((prev: number) => number)) => {
                const s = cmemsUserScrubbedRefs.current.sst;
                s.scrubbed = true;
                s.at = Date.now();
                setSstStep(valOrFn);
            },

            [],
        ),
        sstTotalSteps,
        sstNowIdx: sstNowIdxRef.current,
        sstPlaying,
        setSstPlaying,
        // Chlorophyll (CMEMS BGC daily, gated by VITE_CMEMS_CHL_ENABLED)
        chlStep,
        setChlStep: useCallback(
            (valOrFn: number | ((prev: number) => number)) => {
                const s = cmemsUserScrubbedRefs.current.chl;
                s.scrubbed = true;
                s.at = Date.now();
                setChlStep(valOrFn);
            },

            [],
        ),
        chlTotalSteps,
        chlNowIdx: chlNowIdxRef.current,
        chlPlaying,
        setChlPlaying,
        // Sea-ice (CMEMS physics daily, gated by VITE_CMEMS_SEAICE_ENABLED)
        seaiceStep,
        setSeaiceStep: useCallback(
            (valOrFn: number | ((prev: number) => number)) => {
                const s = cmemsUserScrubbedRefs.current.seaice;
                s.scrubbed = true;
                s.at = Date.now();
                setSeaiceStep(valOrFn);
            },

            [],
        ),
        seaiceTotalSteps,
        seaiceNowIdx: seaiceNowIdxRef.current,
        seaicePlaying,
        setSeaicePlaying,
        // Mixed-layer depth (CMEMS physics daily, gated by VITE_CMEMS_MLD_ENABLED)
        mldStep,
        setMldStep: useCallback(
            (valOrFn: number | ((prev: number) => number)) => {
                const s = cmemsUserScrubbedRefs.current.mld;
                s.scrubbed = true;
                s.at = Date.now();
                setMldStep(valOrFn);
            },

            [],
        ),
        mldTotalSteps,
        mldNowIdx: mldNowIdxRef.current,
        mldPlaying,
        setMldPlaying,
        // Marine Protected Areas (CAPAD, gated by VITE_MPA_ENABLED)
        mpaVisible,
        setMpaVisible,
        // Rain (unified radar + forecast)
        unifiedFramesRef,
        rainFrameIndex,
        setRainFrameIndex,
        rainFrameCount,
        setRainFrameCount,
        rainPlaying,
        setRainPlaying,
        rainReady,
        rainLoading,
        retryRain,
        rainImageLoading,
        rainNowIdxRef,
        // GRIB
        isGribDownloading,
        setIsGribDownloading,
        gribProgress,
        setGribProgress,
        gribError,
        setGribError,
        // Isobars / Pressure
        forecastHour,
        /** Wraps the raw state setter to flag that the user manually
         *  scrubbed — the 1-min Now-recompute interval will back off for
         *  5 minutes before auto-advancing again. */
        setForecastHour: useCallback(
            (valOrFn: number | ((prev: number) => number)) => {
                pressureUserScrubbedRef.current = true;
                pressureUserScrubbedTimeRef.current = Date.now();
                setForecastHour(valOrFn);
            },

            [],
        ),
        /** Sub-frame index corresponding to wall-clock "Now". Consumed by
         *  MapHub's scrubber label so a 4h-old GFS cycle shows "Now" on
         *  the +4h sub-frame instead of mis-labelling cycle-0 as Now. */
        pressureNowIdx: pressureNowIdxRef.current,
        /** Actual time represented by one pressure sub-frame. The GFS path is
         *  hourly after interpolation; the fallback is already hourly. */
        pressureFrameStepHours,
        pressureSource,
        isPlaying,
        setIsPlaying,
        totalFrames,
        framesReady,
        applyFrame,
    };
}

/**
 * useEmbeddedRain — Rain radar overlay that runs independently of activeLayer.
 * Works in both embedded mode and full map mode (background rain under velocity particles).
 */

// Re-export for backward compatibility
export { useEmbeddedRain } from './useEmbeddedRain';
