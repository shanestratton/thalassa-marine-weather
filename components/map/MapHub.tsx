/**
 * MapHub — WebGL-powered map tab using Mapbox GL JS.
 *
 * Architecture pillars:
 *   1. Zero React overlay clutter — all data rendered as native map layers
 *   2. Long-press pin → LocationStore (global state)
 *   3. Weather tile layers: wind + rain (raster tiles, GPU-rendered)
 *   4. Passage planner: GeoJSON source layers for routes/isochrones
 *
 * Performance targets: 60fps pan/zoom on iPhone 16.
 *
 * This file is now a thin orchestrator — logic is split into:
 *   - mapConstants.ts      (types, constants, helpers)
 *   - useMapInit.ts        (map creation, layers, pin drop, location dot, picker)
 *   - useWeatherLayers.ts  (weather overlays, isobars, rain/wind scrubbers)
 *   - usePassagePlanner.ts (passage routing, isochrones, GPX export)
 *   - MapHubOverlays.tsx   (presentational overlay components)
 */
import React, { Suspense, useRef, useState, useEffect, useCallback, useMemo } from 'react';
import { CompassIcon, SearchIcon } from '../Icons';
import { createRoot } from 'react-dom/client';
import { createLogger } from '../../utils/createLogger';
import { parseCoordinateString } from '../../utils/coordParse';
import { lazyRetry } from '../../utils/lazyRetry';

const log = createLogger('MapHub');
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';

import { useLocationStore } from '../../stores/LocationStore';
import { useWeather } from '../../context/WeatherContext';
import { WindStore } from '../../stores/WindStore';
import type { ConsensusMatrixData } from '../../services/ConsensusMatrixEngine';
import { LocationStore } from '../../stores/LocationStore';
import { useSettings } from '../../context/SettingsContext';
import { useUI } from '../../context/UIContext';
import { triggerHaptic } from '../../utils/system';
import { PassageBanner } from './PassageBanner';
import { CompassRoseOverlay } from './CompassRoseOverlay';
import { ZoomLevelFab } from './ZoomLevelFab';
import { RouteEnhancementChip } from '../passage/RouteEnhancementChip';
import { GpsService } from '../../services/GpsService';
import { piCache } from '../../services/PiCacheService';
import { MapOfflineService } from '../../services/MapOfflineService';
import { getConnectionState, onConnectionChange } from '../../services/ConnectionPriorityService';

import { type MapHubProps, type WeatherLayer, SEA_STATE_LAYERS, ATMOSPHERE_LAYERS } from './mapConstants';
import { useMapInit, useLocationDot, usePickerMode, setOpenSeaMapRasterVisibility } from './useMapInit';
import { useWeatherLayers, useEmbeddedRain } from './useWeatherLayers';
import { usePassagePlanner, type PassageNotice } from './usePassagePlanner';
// useRouteNudge removed 2026-05-05 — long-press-to-drag the route line was
// half-implemented (the dispatched 'route-nudge' just set arrival to the
// via-point, dropping the actual destination) and unreliable in practice.
// Manual route editing happens through the route planner instead.
import { useAisLayer } from './useAisLayer';
import { useAisStreamLayer } from './useAisStreamLayer';
import { useChokepointLayer } from './useChokepointLayer';
import { useCycloneLayer } from './useCycloneLayer';
import { useSquallMap } from './useSquallMap';
import { useVesselTracker } from './useVesselTracker';
import { useAvNavCharts } from './useAvNavCharts';
import { useChartCatalog } from './useChartCatalog';
import { useLocalCharts } from './useLocalCharts';
import { useOfflineBaseLayer } from './useOfflineBaseLayer';
import { useSeamarkLayer } from './useSeamarkLayer';
import { useTideStationLayer } from './useTideStationLayer';
import { useAnchorageLayer } from './useAnchorageLayer';
import { useNoticeLayer } from './useNoticeLayer';
import { useLightningLayer } from './useLightningLayer';
import { useOceanCurrentParticleLayer, isCmemsCurrentsEnabled } from './useOceanCurrentParticleLayer';
import { useOceanWaveParticleLayer, isCmemsWavesEnabled } from './useOceanWaveParticleLayer';
import { useSstRasterLayer, isCmemsSstEnabled } from './useSstRasterLayer';
import { useChlRasterLayer, isCmemsChlEnabled } from './useChlRasterLayer';
import { useSeaIceRasterLayer, isCmemsSeaIceEnabled } from './useSeaIceRasterLayer';
import { useMldRasterLayer, isCmemsMldEnabled } from './useMldRasterLayer';
import { useMpaLayer, isMpaEnabled } from './useMpaLayer';
import { useEncVectorLayer } from './useEncVectorLayer';
// Aliased: MapHub's own `setEncChartDetail` is the persisted-state setter.
import {
    ENC_NIGHT_DIM_KEY,
    SATELLITE_KEY,
    setEncVectorVisibility as encApplyLayerVisibility,
    setEncChartDetail as encApplyChartDetailLayers,
    syncDepareBaseTreatment as encSyncDepareBaseTreatment,
    setEncTideOffset,
    setEncPopupSuppression,
    encHasClickableFeatureAt,
    encSuppressNextClickPopup,
    setEncDraftAssumed,
    setEncNightDim,
    setEncPlottingMode as encSetPlottingMode,
    SATELLITE_HIDE_LAYERS as ENC_SATELLITE_HIDE_LAYERS,
    ENC_VEC_LAYERS,
} from './EncVectorLayer';
import {
    readTideCurveWindow,
    tideReadAt,
    type TideCurveWindow,
    type TideOffsetRead,
} from '../../services/TideOffsetService';
import { useEncTestRouteLayer, type EncTestRoute } from './useEncTestRouteLayer';
import { useSeawayDebugLayer } from './useSeawayDebugLayer';
import { TraceReportModal } from './TraceReportModal';
import {
    submitTracedRoute,
    communityLanesNear,
    listPendingRoutes,
    reviewRoute,
    type PendingRoute,
} from '../../services/communityRoutes';
import {
    fetchSeaVoyageChoices,
    loadVoyageTrackPoints,
    type RouteOrTrack,
    type SeaVoyageChoice,
} from '../../services/shiplog/RoutesAndTracks';
import { tryInshoreRoute } from '../../services/InshoreRouter';
import { vesselDraftMetres, vesselAirDraftMetres } from '../../services/units';
import { DEFAULT_TIDE_SAFETY_M } from '../../services/routing/tidalWindow';
import { hazardDepthForDraft } from '../../services/HazardQueryService';
import {
    buildTracerContext,
    validateTraceLeg,
    traceHealth,
    traceBbox,
    traceBboxPadded,
    bboxMaxSpanM,
    pointInBbox,
    tideWindowLabelFor,
    loadSavedTraces,
    saveTrace,
    deleteTrace,
    tracePinBlocked,
    snapTraceTapToWater,
    snapTraceTapToLead,
    rdpTracePoints,
    capSegmentLength,
    reverseRouteName,
    bearingDegBetween,
    courseArrow,
    curatedLanesNear,
    fixLegOnGrid,
    commonDepartureWindowLabel,
    persistLegVerdicts,
    hydrateLegVerdicts,
    groupTracesByTrip,
    nextLegSeed,
    ordinalLegLabel,
    withLegBadge,
    destNameFromRouteName,
    retroBadgeFirstLeg,
    healTripChain,
    type NextLegSeed,
    type GhostLane,
    traceAsCuratedFairwaySnippet,
    traceAsVoyagePlan,
    type TraceLegVerdict,
    type TracerContext,
    type SavedTrace,
} from '../../services/routeTracer';
import { consumeTracerOpenRequest, consumeTracerAction } from '../../services/deepLink';
import { listCells as listEncCells, getVersion as getEncRegistryVersion } from '../../services/enc/EncCellMetadata';
import {
    subscribe as subscribeToEnc,
    subscribeHydration as subscribeToEncHydration,
    getHydrationProgress as getEncHydrationProgress,
    hasCoverageFor as encHasCoverageFor,
} from '../../services/enc/EncHazardService';
// Legend swatches import the REAL glaze constants — they were hand-copied
// hexes and went stale the moment the palette moved (same drift class as
// MapHub's old SATELLITE_HIDE_LAYERS copy).
import { CAUTION_BAND_COLOR, DEPARE_BAND_COLORS, ENC_HAZARD_MAGENTA, SHALLOW_CAUTION_COLOR } from './encDepthStyle';
// Chart-key glyphs + swatch colours, imported from the modules that RENDER them
// so the legend cannot drift from the chart (audit 2026-07-19).
import { seamarkIconDataUri } from './seamarkIcons';
import { CAUTION_CLASS_COLOURS, CAUTION_DEFAULT_COLOUR } from './encPopup';
import { LIGHT_COLOUR_HEX } from '../../services/enc/types';
import { bootstrapEncSamplesIfNeeded } from '../../services/enc/bootstrapEncSamples';
import { DETAIL_SCRUB_MAX, applyChartDetailLevel, isScrubHidden } from './encDetailScrubber';
// The only scrubber-furniture layer the imagery hide-list also owns — the
// islet land-fill dot, hidden over satellite/hybrid so it can't blanket the
// imagery. Passed to applyChartDetailLevel so its restore side yields (audit
// rank 8: LNDARE_ISLET was the ~8 Hz default-config styledata loop).
const IMAGERY_SCRUB_OWNED: ReadonlySet<string> = new Set([ENC_VEC_LAYERS.LNDARE_ISLET]);
import { startAutoSyncPolling } from '../../services/enc/autoSyncFromPi';
import { consumeMapFit, peekMapFit, subscribeMapFit } from '../../stores/MapFitTargetStore';
import type { ActiveCyclone } from '../../services/weather/CycloneTrackingService';
import { useFollowRouteMapbox } from '../../hooks/useFollowRouteMapbox';
import { useDestinationFlag } from './useDestinationFlag';
import { useRouteTrackLayer } from './useRouteTrackLayer';
import { RouteTrackPicker } from './RouteTrackPicker';
import { MapboxVelocityOverlay } from './MapboxVelocityOverlay';
import { LayerFABMenu } from './MapHubOverlays';
import { RadialHelmMenu } from './RadialHelmMenu';
import { StormPicker } from './StormPicker';
import { MapActionFabs } from './MapActionFabs';
import { TimePicker24 } from '../passage/TimePicker24';
import { ThalassaHelixControl, LegendDock, type HelixLayer } from './ThalassaHelixControl';
import { WindModelFieldSelector } from './WindModelFieldSelector';
import { useDeviceMode } from '../../hooks/useDeviceMode';
import type { PointWeatherData } from '../../services/weather/pointWeather';

// ── Lazy-loaded overlay components (split into separate chunks) ──
const ConsensusMatrix = lazyRetry(
    () => import('./ConsensusMatrix').then((m) => ({ default: m.ConsensusMatrix })),
    'ConsensusMatrix',
);
const VesselSearch = lazyRetry(
    () => import('./VesselSearch').then((m) => ({ default: m.VesselSearch })),
    'VesselSearch',
);
const AisLegend = lazyRetry(() => import('./AisLegend').then((m) => ({ default: m.AisLegend })), 'AisLegend');
const CmemsAttribution = lazyRetry(
    () => import('./CmemsAttribution').then((m) => ({ default: m.CmemsAttribution })),
    'CmemsAttribution',
);
// Eager import — the chip doubles as the live diagnostic pill for the
// lightning feed, so a lazy chunk that fails to load silently (and
// leaves the user staring at an empty chart with no feedback) is the
// exact failure mode we're trying to fix. Tiny component, not worth the
// risk of a broken chunk hiding our debug surface.
import { BlitzortungAttribution } from './BlitzortungAttribution';
import { EncAttributionChip } from './EncAttributionChip';
import { HazardReportPanel } from '../passage/HazardReportPanel';
import { SquallLegend } from './SquallLegend';
import { ChartModes } from './ChartModes';
import { ThreatBanner } from './ThreatBanner';
import { ConnectivityChip } from './ConnectivityChip';
import { LayerSettings } from './LayerSettings';
import { PerfOverlay } from './PerfOverlay';
import { PerfDowntierToast } from './PerfDowntierToast';
import { CoachMark } from '../ui/CoachMark';
import { PerfGuardian, consumePerfDowntierToast } from '../../services/PerfGuardian';
const AisGuardAlert = lazyRetry(
    () => import('./AisGuardAlert').then((m) => ({ default: m.AisGuardAlert })),
    'AisGuardAlert',
);
const GhostShip = lazyRetry(() => import('./GhostShip').then((m) => ({ default: m.GhostShip })), 'GhostShip');
const RouteLegend = lazyRetry(() => import('./RouteLegend').then((m) => ({ default: m.RouteLegend })), 'RouteLegend');
const PassageDataPanel = lazyRetry(
    () => import('./PassageDataPanel').then((m) => ({ default: m.PassageDataPanel })),
    'PassageDataPanel',
);
const OfflineAreaModal = lazyRetry(
    () => import('./OfflineAreaModal').then((m) => ({ default: m.OfflineAreaModal })),
    'OfflineAreaModal',
);
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import { usePersistedState, usePersistedStringSet } from '../../hooks/usePersistedState';
// WeatherInspectPopup is rendered imperatively via createRoot — use direct dynamic import
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _WeatherInspectPopup: React.ComponentType<any> | null = null;
const getWeatherInspectPopup = async () => {
    if (!_WeatherInspectPopup) {
        const mod = await import('./WeatherInspectPopup');
        _WeatherInspectPopup = mod.WeatherInspectPopup;
    }
    return _WeatherInspectPopup;
};

// ── Component ──────────────────────────────────────────────────

/** Cache key for one trace leg — endpoint coords pin the verdict. The last
 *  leg is keyed separately ("|last"): it owns marks that project onto its
 *  far endpoint (see validateTraceLeg's ownership rule), so when a new pin
 *  demotes it to an interior leg its verdict must re-grade — one leg, cheap. */
const legCacheKey = (a: { lat: number; lon: number }, b: { lat: number; lon: number }, isLast: boolean): string =>
    `${a.lat.toFixed(6)},${a.lon.toFixed(6)}|${b.lat.toFixed(6)},${b.lon.toFixed(6)}${isLast ? '|last' : ''}`;

/** Fit a saved route's WHOLE extent on screen (Shane 2026-07-17: "show the
 *  entire route… overriding the zoom-10 restriction"). Shared by every "open
 *  a saved route" path so they behave identically. fitBounds picks whatever
 *  zoom shows every pin (in OR out past 10); the left/bottom padding clears
 *  the tracer card + scrubber, and maxZoom stops a tiny route slamming to
 *  max zoom. */
function fitTraceBounds(map: mapboxgl.Map, points: ReadonlyArray<{ lat: number; lon: number }>): void {
    if (points.length === 0) return;
    let minLon = Infinity,
        minLat = Infinity,
        maxLon = -Infinity,
        maxLat = -Infinity;
    for (const p of points) {
        if (p.lon < minLon) minLon = p.lon;
        if (p.lat < minLat) minLat = p.lat;
        if (p.lon > maxLon) maxLon = p.lon;
        if (p.lat > maxLat) maxLat = p.lat;
    }
    map.fitBounds(
        [
            [minLon, minLat],
            [maxLon, maxLat],
        ],
        { padding: { top: 90, bottom: 130, left: 300, right: 40 }, maxZoom: 15, duration: 900 },
    );
}

/** One-time "live tide depth" disclaimer acknowledgment (design 2026-07-11:
 *  "needs a disclaimer of course"). Value = ISO timestamp of the ack. */
const TIDE_ACK_KEY = 'thalassa_tide_depth_ack_v1';

/** Ungraded legs are clustered into build windows no wider than this, so the
 *  padded context bbox (1.5× span) always fits the depth-grid budget — the
 *  whole-trace bbox used to go marks-only at 40 km ("trace too long") AND
 *  cleared the leg cache on every outgrow (Shane 2026-07-11: full re-check
 *  on each new pin, then no depth at all through the shipping channel). */
const TRACE_CLUSTER_SPAN_M = 24_000;

// ⚡ Auto route: after the engine follows deep water, no resulting leg may
// exceed this — a longer leg outgrows the grading depth-grid budget and
// reads "long open-water leg, depth unchecked" (Shane 2026-07-15). 15 km
// (~8 NM) sits well inside TRACE_CLUSTER_SPAN_M so EVERY piece grades with
// a real depth grid; the extra pins land ON the engine's water line (safe).
const AUTO_MAX_LEG_M = 15_000;

// ⚡ Auto route profile selection (2026-07-16 rework — the old AUTO_DETOUR_CAP
// 2.2× cap couldn't tell a legit deep detour from a nearby-marina dogleg, and
// the tide fallback it fell to ALSO doglegged because tideAssist prices a
// crossing at 10× — no crossing ever beats a <10×-longer deep detour).
//
//   NEAR_DIRECT_CAP  'safest' within this × the straight line ⇒ deep water
//                    already lines up, keep it (no tide crossing needed).
//   TIDE_ADOPT_FACTOR  otherwise run 'tideDirect' (recoverable banks at 1.5×,
//                    so A* commits to the near-direct crossing) and adopt it
//                    ONLY when it's materially straighter than the safe
//                    dogleg (< this × the safe distance). Deep detours that
//                    exist because the direct line is blocked by land/drying
//                    (Newport→Rivergate) keep 'safest' — 'tideDirect' doglegs
//                    the same there and isn't materially shorter.
// The seamanship dial is TIDE_ADOPT_FACTOR: 0.7 keeps a deep detour up to
// ~1.43× the direct crossing (take the deep water); beyond that, cross on the
// tide. Lower → commit to deep water harder; raise → cross banks more eagerly.
const NEAR_DIRECT_CAP = 1.15;
const TIDE_ADOPT_FACTOR = 0.7;

// ⚡ Auto route is PARKED (Shane 2026-07-16: "hide the autoroute button for
// now, so we can move on" — not deleted). The engine path (autoRouteLeg +
// the tideDirect profile) stays wired and tested; flip this back to true to
// re-expose the button.
const AUTO_ROUTE_BUTTON_VISIBLE = false;
// Copy-coords button PARKED (Shane 2026-07-17) — thinned the 6-button
// controls row to 5 so the survivors get a fatter tap target on a phone.
const TRACER_COPY_BUTTON_VISIBLE = false;
// "Sail it" PARKED (Shane 2026-07-17): following a route is a CAST-OFF
// decision now, not a plotting one — it lives on the Log page (slide to start
// tracking → "Follow a route?", or the FOLLOW button on a route card, which
// also publishes to the public page). Plot → Save → cast off → follow.
// sailTrace() stays wired for a future "cast off with this route" shortcut.
const SAIL_IT_BUTTON_VISIBLE = false;
// Charts source-picker category on the radial layer FAB PARKED (Shane
// 2026-07-17): the boat's ENC/o-charts are automatic; the picker (Routes/
// Tracks/NOAA/ECDIS/local) only cluttered the fan. Flip to restore it.
const CHARTS_FAB_CATEGORY_VISIBLE = false;

// The guided course-frame (From/To boxes + 🧭 Set course) and its ⚡
// Auto-to-destination button are PARKED with it (Shane 2026-07-16: "remove
// autoroute and set course — they are both hopeless. we don't need the from
// and to boxes either; we just start by clicking a spot"). The wiring
// (setCourseFrame, autoCompleteTrace, traceDest et al) stays intact for a
// future rework — flip to true to re-expose.
const COURSE_FRAME_VISIBLE = false;

// The tracer card's route-library rows (📥 paste / 🛥 past voyage / 💾 saved
// routes) are PARKED (Shane 2026-07-17: "remove from the bottom of the tracer
// card") — the PLAN page's front door + picker modals own those flows now.
// Wiring (pasteTrace, openVoyagePicker, the saved list) stays intact.
const TRACER_CARD_LIBRARY_VISIBLE = false;

// The card's two share rows (📤 share with a mate / 🌐 share with all
// skippers) are PARKED (Shane 2026-07-17: "remove these from the bottom of
// the tracer card"). Wiring (shareTrace, submitShare, the harbourmaster
// review queue) stays intact for a future home.
const TRACER_CARD_SHARE_VISIBLE = false;

/** Equirectangular distance in metres between two lat/lon points. */
const distMetres = (p: { lat: number; lon: number }, q: { lat: number; lon: number }): number => {
    const mLon = 111_320 * Math.cos((((p.lat + q.lat) / 2) * Math.PI) / 180);
    return Math.hypot((q.lat - p.lat) * 110_540, (q.lon - p.lon) * mLon);
};

/** Epoch ms → the LOCAL "yyyy-MM-ddTHH:mm" a datetime-local input wants
 *  (toISOString would shift to UTC — off by the timezone). */
const msToLocalInput = (ms: number): string => {
    const d = new Date(ms);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

export const MapHub: React.FC<MapHubProps> = ({
    mapboxToken,
    onLocationSelect,
    initialZoom = 5,
    mapStyle = 'mapbox://styles/mapbox/dark-v11',
    minimalLabels = false,
    embedded = false,
    center,
    pickerMode = false,
    hideTracer = false,
}) => {
    // ── Pin View Mode (from chat pin tap) ──

    const [isPinView, setIsPinView] = useState(!!window.__thalassaPinView);
    const [showVesselSearch, setShowVesselSearch] = useState(false);
    const [showOfflineArea, setShowOfflineArea] = useState(false);
    const [offlineCardDismissed, setOfflineCardDismissed] = useState(false);
    const [weatherInspectMode, setWeatherInspectMode] = useState(false);
    // ── Route Tracer — grew out of coordinate capture (Shane 2026-07-07 →
    // promoted 2026-07-08 "let people make their own routes"). Tap pins
    // along your own line; every leg is graded LIVE against the router's
    // own data (depth vs keel, land/berth crossings, cardinal safe sides,
    // gate threading, leads) and drawn green/amber/red. Save it, sail it,
    // or export it as a curated-fairway candidate — the human-in-the-loop
    // router while the auto-router earns trust, and the flywheel that
    // turned Shane's 29 Mooloolaba taps into the shipped fairway. A ref
    // mirrors the flag so the map tap closure never reads a stale value.
    const [coordCaptureMode, setCoordCaptureMode] = useState(false);
    // Work-in-progress pins survive a page reload (Shane 2026-07-09: a
    // service-worker reload storm ate his half-traced route — the storm
    // is fixed, but a mid-trace deploy or crash must never cost the work
    // again). sessionStorage = per-tab, dies with the tab: exactly the
    // lifetime of "work in progress". Restored lazily on mount; the
    // persist effect below keeps it current (CLEAR writes [] naturally).
    const [capturedCoords, setCapturedCoords] = useState<Array<{ lat: number; lon: number }>>(() => {
        try {
            const raw = sessionStorage.getItem('thalassa_trace_wip_pins');
            const parsed = raw ? (JSON.parse(raw) as Array<{ lat: number; lon: number }>) : [];
            return Array.isArray(parsed)
                ? parsed.filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon))
                : [];
        } catch {
            return [];
        }
    });
    useEffect(() => {
        try {
            sessionStorage.setItem('thalassa_trace_wip_pins', JSON.stringify(capturedCoords));
        } catch {
            /* quota/private-mode — the trace just doesn't survive reloads */
        }
    }, [capturedCoords]);

    // Undo / REDO HISTORY (Shane 2026-07-16: "a stray tap drops a stupid
    // waypoint and sends the route sideways — put it back exactly as it was,
    // and step back edit-by-edit up to the last save" + "do redo too"). Every
    // edit to capturedCoords — whatever dropped it: a tap, a drag, auto-route,
    // a ghost, a delete — snapshots the PREVIOUS state here, so Undo restores
    // it whole; Redo walks forward again. Two stacks; a fresh edit invalidates
    // the redo branch. Captured via an effect keyed on capturedCoords so all
    // ~18 setCapturedCoords sites feed it for free. Guards: an undo/redo
    // restore must not re-push; a save/load rebases both stacks (the saved
    // state is the floor — you can't undo past it).
    type Coords = Array<{ lat: number; lon: number }>;
    const traceHistoryRef = useRef<Coords[]>([]);
    const traceRedoRef = useRef<Coords[]>([]);
    const prevCoordsRef = useRef(capturedCoords);
    const isRestoringRef = useRef(false);
    const rebaseHistoryRef = useRef(false);
    const [canUndoTrace, setCanUndoTrace] = useState(false);
    const [canRedoTrace, setCanRedoTrace] = useState(false);
    useEffect(() => {
        if (capturedCoords === prevCoordsRef.current) return; // no real change
        if (isRestoringRef.current) {
            // An undo/redo restore — the handler already moved the stacks. Just
            // sync the baseline; never re-push and never clear the redo branch.
            isRestoringRef.current = false;
            prevCoordsRef.current = capturedCoords;
            return;
        }
        if (rebaseHistoryRef.current) {
            // Save / load a route → this IS the new floor. Wipe both stacks.
            rebaseHistoryRef.current = false;
            traceHistoryRef.current = [];
            traceRedoRef.current = [];
            prevCoordsRef.current = capturedCoords;
            setCanUndoTrace(false);
            setCanRedoTrace(false);
            return;
        }
        // A fresh edit: push the previous state, and abandon the redo branch.
        traceHistoryRef.current.push(prevCoordsRef.current);
        if (traceHistoryRef.current.length > 100) traceHistoryRef.current.shift();
        traceRedoRef.current = [];
        prevCoordsRef.current = capturedCoords;
        setCanUndoTrace(true);
        setCanRedoTrace(false);
    }, [capturedCoords]);
    /** Undo the last route edit — restore the exact prior state (multi-step,
     *  back to the last save). No-op when history is empty. */
    const undoTrace = useCallback(() => {
        if (traceHistoryRef.current.length === 0) return;
        triggerHaptic('light');
        const prev = traceHistoryRef.current.pop()!;
        traceRedoRef.current.push(prevCoordsRef.current); // current → redo
        isRestoringRef.current = true;
        setSelectedPin(null);
        setInsertAfter(null);
        insertAfterRef.current = null;
        setCapturedCoords(prev);
        setCanUndoTrace(traceHistoryRef.current.length > 0);
        setCanRedoTrace(true);
    }, []);
    /** Redo — step forward again after an Undo, up to where you'd undone from.
     *  Cleared the moment you make a new edit. No-op when the redo stack empty. */
    const redoTrace = useCallback(() => {
        if (traceRedoRef.current.length === 0) return;
        triggerHaptic('light');
        const next = traceRedoRef.current.pop()!;
        traceHistoryRef.current.push(prevCoordsRef.current); // current → undo
        isRestoringRef.current = true;
        setSelectedPin(null);
        setInsertAfter(null);
        insertAfterRef.current = null;
        setCapturedCoords(next);
        setCanUndoTrace(true);
        setCanRedoTrace(traceRedoRef.current.length > 0);
    }, []);

    // Departure date/time for the plan (Shane 2026-07-16): anchors the
    // per-leg tide windows (evaluated at each leg's ETA), the departure-window
    // headline, and the report's weather ETAs. null = "leave now".
    // Session-persisted beside the WIP pins; a departure >1 h in the past is
    // stale planning state and resets to "now" on restore.
    const [departureMs, setDepartureMs] = useState<number | null>(() => {
        try {
            const raw = sessionStorage.getItem('thalassa_trace_departure_ms');
            const v = raw ? Number(raw) : NaN;
            return Number.isFinite(v) && v > Date.now() - 3_600_000 ? v : null;
        } catch {
            return null;
        }
    });
    useEffect(() => {
        try {
            if (departureMs === null) sessionStorage.removeItem('thalassa_trace_departure_ms');
            else sessionStorage.setItem('thalassa_trace_departure_ms', String(departureMs));
        } catch {
            /* private mode — departure just doesn't survive reloads */
        }
    }, [departureMs]);

    // Corridor chart prefetch (Shane 2026-07-16): the app knows the route's
    // start/finish the moment two pins exist — quietly pull the ENC cells for
    // the padded corridor in the background (device → Pi → cloud ladder) while
    // the skipper keeps tracing. Debounced so a burst of pin edits costs one
    // run; the service is single-flight + per-run capped, so this stays cheap.
    const [coordsCopied, setCoordsCopied] = useState(false);
    const coordCaptureRef = useRef(false);
    /** The PEN switch (Shane 2026-07-11: stray taps while the tracer is
     *  open dropped unwanted pins — "great when you want it, and fucken
     *  annoying when you don't"). Armed = taps plot pins (the default on
     *  every tracer open); paused = the chart is a chart again: popups
     *  answer, pans are safe, nothing plots until ▶ resume. */
    const [plotArmed, setPlotArmed] = useState(true);
    const plotArmedRef = useRef(true);
    useEffect(() => {
        plotArmedRef.current = plotArmed;
    }, [plotArmed]);
    // Per-pin marker records for RECONCILIATION (Shane 2026-07-15: "still
    // becoming unresponsive the moment I have a lot of waypoints"). The
    // old effect destroyed and recreated every DOM marker on EVERY pin
    // add / nudge / selection tap — O(N) DOM churn per interaction, and
    // the churn itself forced Mapbox to re-anchor all N roots. Records
    // let each pass touch only what changed: append = 1 create + 1
    // restyle, drag = 1 move, select = 2 restyles. `index` is LIVE —
    // listeners read it at fire time so inserts/deletes never orphan a
    // closure; `sig` is the rendered-style signature so unchanged pins
    // skip all style writes.
    const captureMarkersRef = useRef<
        Array<{
            marker: mapboxgl.Marker;
            el: HTMLDivElement;
            dot: HTMLDivElement;
            tag: HTMLDivElement | null;
            sig: string;
            lat: number;
            lon: number;
            index: number;
            dragged: boolean;
        }>
    >([]);
    // Tracer verdicts + context. The context (ENC cells + OSM overlay +
    // depth grid over the trace bbox) builds async once per area; a seq
    // guard drops stale builds when pins outrun a slow fetch.
    // null slot = leg not graded yet (its window is still building) — the
    // panel row shows grey "checking…" and the chart leg draws 'pending'.
    const [legVerdicts, setLegVerdicts] = useState<Array<TraceLegVerdict | null>>([]);

    // Corridor chart prefetch (Shane 2026-07-16): pull the cells covering the
    // route's padded bbox in the background (device → Pi → cloud ladder) while
    // the skipper keeps tracing. Held off while legs are still grading (null
    // slots pending): the prefetch's multi-MB JSON.parse used to land INSIDE
    // the exact window where "checking…" jank is felt (jank audit #5).
    // legVerdicts in the deps re-arms the timer per grading publish, so it
    // fires ~4 s after the route settles — long before that water matters.
    useEffect(() => {
        if (!coordCaptureMode || capturedCoords.length < 2) return;
        if (legVerdicts.some((v) => v === null)) return;
        const t = window.setTimeout(() => {
            void import('../../services/enc/corridorPrefetch').then(({ prefetchCorridorCells }) =>
                prefetchCorridorCells(capturedCoords),
            );
        }, 4000);
        return () => window.clearTimeout(t);
    }, [capturedCoords, coordCaptureMode, legVerdicts]);
    const [tideLabels, setTideLabels] = useState<Record<number, string>>({});
    const [tracerStatus, setTracerStatus] = useState<
        'idle' | 'loading' | 'ready' | 'marksonly' | 'toolarge' | 'nochart'
    >('idle');
    const tracerCtxRef = useRef<TracerContext | null>(null);
    /** Small LRU of recent GRID-BEARING contexts (jank audit #6): the single
     *  slot rebuilt the whole window on every ping-pong edit (nudge pin 3,
     *  then pin 30 — the fix-leg → re-grade → nudge flow). Three entries
     *  (~5–13 MB of typed arrays each at the 1M-cell cap) covers a working
     *  route without flirting with iOS jetsam. Same reuse rule as the single
     *  slot: grid required, 0.008° interior margin, marks-only NEVER held.
     *  Cleared with the ctx on draft change and Done. */
    const tracerCtxLruRef = useRef<TracerContext[]>([]);
    const tracerCtxFromLru = useCallback((pts: ReadonlyArray<{ lat: number; lon: number }>): TracerContext | null => {
        for (const c of tracerCtxLruRef.current) {
            if (c.grid && pts.every((p) => pointInBbox(p, c.bbox, 0.008))) return c;
        }
        return null;
    }, []);
    const tracerCtxHold = useCallback((ctx: TracerContext) => {
        tracerCtxRef.current = ctx;
        const lru = tracerCtxLruRef.current.filter((c) => c !== ctx);
        lru.unshift(ctx);
        tracerCtxLruRef.current = lru.slice(0, 3);
    }, []);
    const tracerSeqRef = useRef(0);
    const tideReqRef = useRef<Set<string>>(new Set());
    /** Incremental grading (Shane 2026-07-09: "each new waypoint rechecks
     *  all of the previous waypoints — not necessary unless we nudged").
     *  Verdicts cache per LEG, keyed by its endpoints: a fresh pin only
     *  misses on its own leg, a nudged pin on its two adjacent legs, and
     *  every untouched leg is a hit. Cleared when the CONTEXT rebuilds
     *  (new area / draft change) — those invalidate every cached verdict. */
    const legCacheRef = useRef<Map<string, TraceLegVerdict>>(new Map());
    /** One-shot hydration of the persisted verdict cache (Shane 2026-07-17:
     *  "checks the entire route again, even though nothing changed" — the
     *  cache used to die with every remount/reload/tab-bounce). Runs inside
     *  the grading effect where the real draft is known. */
    const legCacheHydratedRef = useRef(false);
    /** VOLATILE failure verdicts ("no ENC chart here", build exception) —
     *  kept OUT of legCacheRef because a nochart can be a transient network
     *  blip (cloud cell hydration offline): every grading pass clears this
     *  map and retries, so charts appearing mid-session heal the legs.
     *  toolarge verdicts ARE durable (pure geometry — the leg really is
     *  that long until a pin splits it, which changes its cache key). */
    const failVerdictsRef = useRef<Map<string, TraceLegVerdict>>(new Map());
    /** Draft the caches were graded with — invalidation must key on THIS,
     *  not on tracerCtxRef (Done nulls the ctx but keeps the cache; draft
     *  edits between Done and reopen used to serve stale-keel verdicts). */
    const gradedDraftRef = useRef<{ d: number; assumed: boolean } | null>(null);
    /** Tide-window labels cached by SPOT (leg indices shift on insert/
     *  delete; the shallow patch itself doesn't move). */
    const tideSpotCacheRef = useRef<Map<string, string>>(new Map());
    const [savedTraces, setSavedTraces] = useState<SavedTrace[]>([]);
    // Name rides with the WIP pins across a tab hop (2026-07-18).
    const [traceName, setTraceName] = useState(() => {
        try {
            return sessionStorage.getItem('thalassa_trace_wip_name') ?? '';
        } catch {
            return '';
        }
    });
    // AUTO-NAME (Shane 2026-07-16): "Newport - Scarborough" from the first +
    // last pins, live as the route grows; coords when no place is nearby.
    // Auto-naming is ACTIVE while the name box is empty or still holding the
    // last auto value — the moment the skipper types their own name (or opens
    // a saved route, whose name differs), it stops touching the box.
    // Restored alongside the name, because THIS ref is what distinguishes "we
    // named it" from "the skipper named it". Lost, every restored name looks
    // hand-typed and auto-naming silently stops updating it.
    // Hoisted above the auto-name effect, which reads it to keep a chained leg's
    // FROM half stable. Self-contained (sessionStorage only), so the move costs
    // nothing — and the effect referencing it from below was a TDZ error that
    // vite bundled happily and tsc caught.
    const [legAnchor, setLegAnchor] = useState<NextLegSeed | null>(() => {
        try {
            return JSON.parse(sessionStorage.getItem('thalassa_trace_wip_leg_anchor') ?? 'null');
        } catch {
            return null;
        }
    });
    const lastAutoNameRef = useRef<string>(
        (() => {
            try {
                return sessionStorage.getItem('thalassa_trace_wip_auto_name') ?? '';
            } catch {
                return '';
            }
        })(),
    );
    useEffect(() => {
        if (!coordCaptureMode || capturedCoords.length === 0) return;
        const isAuto = traceName === '' || traceName === lastAutoNameRef.current;
        if (!isAuto) return;
        // A chained leg has no destination until one is traced. With just the
        // locked start, first === last and this would name it "Newport - Newport";
        // leaving the "Newport - " prefill alone is the honest state.
        if (legAnchor && capturedCoords.length < 2) return;
        const first = capturedCoords[0];
        const last = capturedCoords[capturedCoords.length - 1];
        // Debounced: a burst of pin drops costs one geocode pass (and the
        // helper caches on a ~1 km grid anyway).
        const t = window.setTimeout(() => {
            void import('../../services/routeAutoName').then(async ({ autoRouteName, placeLabelFor }) => {
                // CHAINED LEG: the FROM half is the previous leg's recorded arrival
                // name and is authoritative. Re-geocoding the anchor can return a
                // different label for the same spot — "Scarborough" for the pin the
                // previous leg called "Newport" — which would contradict both the
                // locked-start badge and the leg it chains from. Only the
                // destination is looked up.
                const name = legAnchor
                    ? `${legAnchor.fromName} - ${await placeLabelFor(last)}`
                    : await autoRouteName(first, last);
                setTraceName((cur) => {
                    // The skipper typed while we were geocoding — theirs wins.
                    if (cur !== '' && cur !== lastAutoNameRef.current) return cur;
                    lastAutoNameRef.current = name;
                    return name;
                });
            });
        }, 800);
        return () => window.clearTimeout(t);
    }, [capturedCoords, coordCaptureMode, traceName, legAnchor]);
    // Typed GPS-fix entry (build a route by keying coords, not just tapping —
    // Shane 2026-07-16). Accepts decimal, hemisphere, DMM and DMS via
    // parseCoordinateString; each Add appends a pin to the trace.
    const [coordEntry, setCoordEntry] = useState('');
    // Same-name save = overwrite, but ASKED first: holds the id of the
    // saved route the next Save tap will replace (two-tap arm, like the
    // saved-route delete). Disarmed by editing the name.
    const [overwriteArm, setOverwriteArm] = useState<string | null>(null);
    // ── Multi-leg trips (Shane 2026-07-17: "get our LEGS functioning") ──
    // Set when the tracer opened via "plot the next leg": pin 1 is pre-
    // dropped at the previous leg's EXACT final coordinates and LOCKED
    // (no drag, no delete; Clear resets TO it — legs chain by position,
    // not by name). Save badges the name "(2nd Leg)", stamps the chain
    // fields, and retro-badges leg 1. Loading anything else drops it.
    // Restored with the pins — see the persistence effect below for why the
    // chain must not outlive its own trace.
    const legAnchorRef = useRef<NextLegSeed | null>(null);
    useEffect(() => {
        legAnchorRef.current = legAnchor;
    }, [legAnchor]);

    // THE LOCK IS AN INVARIANT, not a pile of per-path guards (Shane 2026-07-19:
    // "the first pin LOCKED where the last pin from the previous leg ended… it
    // should not be able to be moved at all").
    //
    // Dragging (setDraggable), delete, ⇄ reverse, tap-insert, Clear and the
    // three load doors each already refuse to move pin 1 of a chained leg. That
    // is SIX separate promises, and adopting a ghost lane — which replaces the
    // whole pin array wholesale — quietly broke every one of them at once.
    // Rather than add a seventh guard and wait for the eighth, re-assert the
    // anchor here: whatever rewrote the route, pin 1 goes back to the previous
    // leg's arrival. Same reasoning as the ENC keel floor — a rule enforced in
    // one place cannot be forgotten by a path written later.
    //
    // The honest way to move it is unchanged and still works: edit the PREVIOUS
    // leg, whose new arrival becomes this leg's locked start.
    useEffect(() => {
        const a = legAnchor?.anchor;
        if (!a || capturedCoords.length === 0) return;
        const p0 = capturedCoords[0];
        if (p0.lat === a.lat && p0.lon === a.lon) return; // already correct — the common case
        // A correction is not an edit: borrow the undo/redo suppression so this
        // never lands on the history stack as a step the skipper can undo into.
        isRestoringRef.current = true;
        setCapturedCoords((prev) => (prev.length === 0 ? prev : [{ ...a }, ...prev.slice(1)]));
    }, [legAnchor, capturedCoords]);
    // Focused by the no-name Save guard so the keyboard pops ready to type.
    const traceNameInputRef = useRef<HTMLInputElement | null>(null);
    const [showSavedTraces, setShowSavedTraces] = useState(false);
    const [traceFeedback, setTraceFeedback] = useState<string | null>(null);
    /** No-go acknowledgment: with danger legs, the first Sail tap arms a red
     *  "Sail anyway?" and only the second tap sails. Never a hard block. */
    const [sailArmed, setSailArmed] = useState(false);
    const sailBusyRef = useRef(false);
    /** Pin editing (P2): tap a pin to select it → Delete / Insert-after in
     *  the panel. insertAfterRef mirrors state for the map-tap closure. */
    const [selectedPin, setSelectedPin] = useState<number | null>(null);
    const [insertAfter, setInsertAfter] = useState<number | null>(null);
    const insertAfterRef = useRef<number | null>(null);
    /** Saved-route delete confirm: first ✕ arms, second deletes. */
    const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
    /** Guided builder: "⚡ Auto to destination" run state + the course chip
     *  ("↘ head 168° — Newport 32 NM") shown after the router takes the
     *  open water. */
    const [autoBusy, setAutoBusy] = useState(false);
    const [courseChip, setCourseChip] = useState<string | null>(null);
    /** Panel fold (Shane 2026-07-09 phone screenshot: the tracer panel
     *  covered the ENTIRE screen — "cannot actually build a route").
     *  Folded = header + a one-line ⚡/Undo strip; the chart owns the
     *  glass. Auto-folds once when plotting starts on a narrow screen;
     *  the chevron toggles it any time. */
    const [panelFolded, setPanelFolded] = useState(false);
    const autoFoldedRef = useRef(false);
    /** Draggable compass rose while tracing — park it beside a cardinal
     *  mark to read which side is north (Shane 2026-07-11: "I need to
     *  pass on the correct side of cardinals but I do not know which
     *  side is which"). Session-only state, ON by default; ✕ on the
     *  rose hides it, the 🧭 in the panel header brings it back. */
    // Compass rose is always on while tracing now — the header show/hide
    // toggle was removed 2026-07-17 ("we don't need to hide the compass").
    useEffect(() => {
        if (!coordCaptureMode) {
            autoFoldedRef.current = false;
            return;
        }
        if (
            capturedCoords.length > 0 &&
            !autoFoldedRef.current &&
            typeof window !== 'undefined' &&
            window.innerWidth < 640
        ) {
            autoFoldedRef.current = true;
            setPanelFolded(true);
        }
    }, [capturedCoords.length, coordCaptureMode]);
    /** Course frame (guided front door, Shane 2026-07-09 "dumb this down"):
     *  the tracer owns its own From/To — no trip through the old planner.
     *  Origin = fly-to + hollow START ring; destination arms ⚡ Auto, draws
     *  the 🏁 ghost and the dashed bearing hint from the trace's live end.
     *  Both are GHOSTS, never trace pins — the punter's line stays his. */
    // Frame survives reloads alongside the WIP pins (same rationale).
    const [traceOrigin, setTraceOrigin] = useState<{ lat: number; lon: number; name: string } | null>(() => {
        try {
            const p = JSON.parse(sessionStorage.getItem('thalassa_trace_wip_origin') ?? 'null');
            return p && Number.isFinite(p.lat) && Number.isFinite(p.lon) ? p : null;
        } catch {
            return null;
        }
    });
    const [traceDest, setTraceDest] = useState<{ lat: number; lon: number; name: string } | null>(() => {
        try {
            const p = JSON.parse(sessionStorage.getItem('thalassa_trace_wip_dest') ?? 'null');
            return p && Number.isFinite(p.lat) && Number.isFinite(p.lon) ? p : null;
        } catch {
            return null;
        }
    });
    useEffect(() => {
        try {
            sessionStorage.setItem('thalassa_trace_wip_origin', JSON.stringify(traceOrigin));
            sessionStorage.setItem('thalassa_trace_wip_dest', JSON.stringify(traceDest));
        } catch {
            /* quota/private-mode */
        }
    }, [traceOrigin, traceDest]);
    // The leg CHAIN rides with the pins, or resuming a trace quietly corrupts it
    // (2026-07-18). legAnchor is what makes leg 2 a leg 2 — saveTrace branches on
    // it for tripId/legOrdinal — so a trace resumed after a tab hop would save
    // UNCHAINED and unbadged, looking fine while having silently lost its parent.
    // That is worse than the visible loss it accompanies, so it persists too.
    useEffect(() => {
        try {
            sessionStorage.setItem('thalassa_trace_wip_leg_anchor', JSON.stringify(legAnchor));
            sessionStorage.setItem('thalassa_trace_wip_name', traceName);
            sessionStorage.setItem('thalassa_trace_wip_auto_name', lastAutoNameRef.current);
        } catch {
            /* quota/private-mode */
        }
    }, [legAnchor, traceName]);
    const [fromQuery, setFromQuery] = useState('');
    const [toQuery, setToQuery] = useState('');
    const [frameBusy, setFrameBusy] = useState(false);
    const frameMarkersRef = useRef<mapboxgl.Marker[]>([]);
    /** Route report (Phase 3): review → Fix/Acknowledge → sail. */
    const [showReport, setShowReport] = useState(false);
    const [ackedLegs, setAckedLegs] = useState<Set<number>>(new Set());
    const [fixBusyLeg, setFixBusyLeg] = useState<number | null>(null);
    // PERSISTENT auto-route diagnostic — the flash vanishes in 1.8 s and I
    // can't see the device console, so the exact engine outcome (routed / no
    // coverage / error / straight) stays on screen until the next action so
    // Shane can screenshot it. Cleared when the pins change.
    const [autoRouteDiag, setAutoRouteDiag] = useState<string | null>(null);
    /** null = computing, '' = nothing tide-gated on the route. */
    const [departureLabel, setDepartureLabel] = useState<string | null>('');
    /** Community flywheel (#38): consent-armed share, harbourmaster queue,
     *  and the track→trace voyage picker. */
    const [shareArmed, setShareArmed] = useState(false);
    const [pendingRoutes, setPendingRoutes] = useState<PendingRoute[]>([]);
    const [showQueue, setShowQueue] = useState(false);
    const [voyageTracks, setVoyageTracks] = useState<SeaVoyageChoice[]>([]);
    const [showVoyagePicker, setShowVoyagePicker] = useState(false);
    /** Proven-lane ghosts: curated fairways near the trace area, drawn dotted
     *  grey; accepting one loads its pins ("trace out of the marina" solved
     *  in two taps where a lane exists). */
    const [ghostLanes, setGhostLanes] = useState<GhostLane[]>([]);
    // Ghosts only ever RENDER while the trace has ≤1 pin (the "trace out
    // of the marina" moment) — yet this effect used to rescan lanes and
    // mint a fresh array on EVERY pin edit, dirtying the trace-line
    // sync's deps for a wasted 4×setData pass per pin (perf hunt
    // 2026-07-15). The primitive key kills that: 'off' once ≥2 pins
    // exist, else the first pin rounded to ~100 m — nudges and pans
    // don't rescan, a genuinely new start area does.
    const ghostKey =
        !coordCaptureMode || capturedCoords.length > 1
            ? 'off'
            : capturedCoords.length === 1
              ? `${capturedCoords[0].lat.toFixed(3)},${capturedCoords[0].lon.toFixed(3)}`
              : 'centre';
    useEffect(() => {
        if (ghostKey === 'off') {
            setGhostLanes((prev) => (prev.length === 0 ? prev : []));
            return;
        }
        const map = mapRef.current;
        const centre =
            capturedCoords.length > 0
                ? capturedCoords[capturedCoords.length - 1]
                : map
                  ? { lat: map.getCenter().lat, lon: map.getCenter().lng }
                  : null;
        if (!centre) {
            setGhostLanes((prev) => (prev.length === 0 ? prev : []));
            return;
        }
        const bbox: [number, number, number, number] = [
            centre.lon - 0.05,
            centre.lat - 0.05,
            centre.lon + 0.05,
            centre.lat + 0.05,
        ];
        // Curated lanes land instantly; approved community lanes merge in as
        // the RPC returns (10-min cached). Stale-guarded — a pin drop mid-
        // fetch supersedes this run.
        let stale = false;
        setGhostLanes(curatedLanesNear(bbox));
        void communityLanesNear(bbox).then((community) => {
            if (stale || community.length === 0) return;
            setGhostLanes((prev) => {
                const seen = new Set(prev.map((l) => l.id));
                return [...prev, ...community.filter((l) => !seen.has(l.id))];
            });
        });
        return () => {
            stale = true;
        };
        // capturedCoords is read for the centre only — ghostKey already
        // encodes it to ~100 m, so re-running on every array identity
        // would defeat the whole gate.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ghostKey]);
    // Deep-link door (Phase 5.1): thalassawx.app/plan boots the map with
    // a pending tracer-open request — consume it on mount, or via the
    // 'thalassa:trace-mode' window event when the map is already up
    // (BuilderDeepLink fires it after the sign-in step). Gated exactly
    // like the Trace-route FAB: embedded/picker/pin surfaces never
    // respond, so the RoutePlanner's hideTracer embed can't hijack it.
    useEffect(() => {
        if (embedded || pickerMode || hideTracer || isPinView) return;
        const open = () => {
            consumeTracerOpenRequest();
            setWeatherInspectMode(false);
            setCoordCaptureMode(true);
            // PLAN-page front-door actions (Shane 2026-07-16): the punter
            // already PICKED the route in the planner's modal — load it
            // straight in, no second menu. paste runs SYNCHRONOUSLY inside
            // the dispatching click so the clipboard read keeps its iOS
            // user-activation.
            const action = consumeTracerAction();
            if (action?.kind === 'paste') {
                setLegAnchor(null);
                void pasteTrace();
            } else if (action?.kind === 'load-voyage') {
                setLegAnchor(null);
                void loadVoyageAsTrace(action.choice);
            } else if (action?.kind === 'load-saved') {
                const t = loadSavedTraces().find((x) => x.id === action.id);
                if (t && t.points.length >= 2) {
                    setLegAnchor(null); // an opened route is edited standalone
                    rebaseHistoryRef.current = true; // opened a saved route → Undo floor
                    setCapturedCoords(t.points);
                    setTraceName(t.name);
                    setSavedTraces(loadSavedTraces());
                    // Fit the WHOLE route (Shane 2026-07-17) — same helper as
                    // the card's open path.
                    const fly = () => mapRef.current && fitTraceBounds(mapRef.current, t.points);
                    // Cold PLAN→map mount: the map object may trail this event
                    // by a beat — one delayed retry covers it.
                    if (mapRef.current) fly();
                    else setTimeout(fly, 1_200);
                }
            } else if (action?.kind === 'new-leg') {
                // Plot the NEXT leg of a trip (Shane 2026-07-17): the first
                // pin IS the previous leg's arrival — exact coordinates,
                // locked. The name box is prefilled "Woorim - " so the save
                // reads "woorim - timbuktu (2nd Leg)".
                const t = loadSavedTraces().find((x) => x.id === action.fromId);
                const seed = t ? nextLegSeed(t) : null;
                if (seed) {
                    rebaseHistoryRef.current = true; // fresh leg → Undo floor
                    setCapturedCoords([seed.anchor]);
                    setTraceName(`${seed.fromName} - `);
                    // The prefill IS ours, not the skipper's (Shane 2026-07-19: "it
                    // does not auto put the destination in the save box, so i get
                    // something like Newport -"). Marking it as the punter's typing
                    // made isAuto false below, so auto-naming stood down and the
                    // dangling "Newport - " could never be completed. Recording it
                    // here as the last auto value lets the destination fill in.
                    lastAutoNameRef.current = `${seed.fromName} - `;
                    setLegAnchor(seed);
                    setSelectedPin(null);
                    setOverwriteArm(null);
                    const fly = () =>
                        mapRef.current?.flyTo({
                            center: [seed.anchor.lon, seed.anchor.lat],
                            zoom: 13.5,
                            duration: 900,
                        });
                    if (mapRef.current) fly();
                    else setTimeout(fly, 1_200);
                    flashTraceFeedback(
                        `${ordinalLegLabel(seed.ordinal)} departs ${seed.fromName} — first pin locked 🔒`,
                    );
                }
            }
        };
        // THE WAY OUT (Shane 2026-07-18: "i cannot press the charts button... i
        // can go to any other screen but the chart screen"). Every other tab left
        // trace mode by unmounting MapHub, but Charts is already ON the map, so
        // the tap changed nothing and the tracer sat there — the one destination
        // you could not reach. This is the first commit where leaving is SAFE:
        // the pins persist and the 🧭 pill brings them back, so Charts can simply
        // close the tracer and hand over the bare chart, exactly like the other
        // tabs do. It does NOT clear the trace.
        const close = () => setCoordCaptureMode(false);
        if (consumeTracerOpenRequest()) open();
        window.addEventListener('thalassa:trace-mode', open);
        window.addEventListener('thalassa:trace-mode-exit', close);
        return () => {
            window.removeEventListener('thalassa:trace-mode', open);
            window.removeEventListener('thalassa:trace-mode-exit', close);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [embedded, pickerMode, hideTracer, isPinView]);

    // Routing-page declutter (Shane 2026-07-17): tell app-level chrome (the
    // Bosun mic orb over the map) when the tracer is active so it steps
    // aside; Done brings it back.
    useEffect(() => {
        if (embedded || pickerMode || isPinView) return;
        const say = (active: boolean) => {
            try {
                window.dispatchEvent(new CustomEvent('thalassa:tracer-active', { detail: { active } }));
            } catch {
                /* chrome just stays visible */
            }
        };
        say(coordCaptureMode);
        // Done no longer exits trace mode (2026-07-17) — the tab bar does,
        // by UNMOUNTING MapHub. Without this cleanup the mic orb would stay
        // hidden on every other page after leaving mid-trace.
        return () => say(false);
    }, [coordCaptureMode, embedded, pickerMode, isPinView]);

    // Departure set on the PLAN page (DepartControl) → adopt it here so the
    // tide windows / weather ETAs re-anchor without a remount.
    useEffect(() => {
        const onDep = (e: Event) => {
            const ms = (e as CustomEvent).detail?.ms as unknown;
            setDepartureMs(typeof ms === 'number' && Number.isFinite(ms) ? ms : null);
        };
        window.addEventListener('thalassa:departure-changed', onDep);
        return () => window.removeEventListener('thalassa:departure-changed', onDep);
    }, []);
    // (Tap-the-water popup suppression lives below, after mapRef/mapReady
    // are declared — it's per-map now, not module-global.)
    useEffect(() => {
        coordCaptureRef.current = coordCaptureMode;
        if (coordCaptureMode) {
            // Every tracer open starts with the pen ARMED — pausing is a
            // within-session choice, never a haunting state.
            setPlotArmed(true);
            setSavedTraces(loadSavedTraces());
            // Desktop builder (Phase 5): register cloud ENC cells (idempotent,
            // signed-in only — a browser can't reach the Pi) and pull the
            // account's saved routes; refresh the list when the merge lands.
            void import('../../services/enc/cloudCellSync')
                .then(({ registerCloudCells }) => registerCloudCells())
                .catch(() => {});
            void import('../../services/savedRoutesSync')
                .then(({ syncSavedRoutes }) => syncSavedRoutes())
                .then((merged) => setSavedTraces(merged))
                .catch(() => {});
        }
    }, [coordCaptureMode]);
    // Draw the graded legs on a dedicated source ('route-line' belongs to the
    // passage planner). Idempotent ensure() re-adds after a basemap style
    // switch drops custom layers; styledata re-syncs.
    useEffect(() => {
        const map = mapRef.current;
        if (!map) return;
        const sync = (): void => {
            try {
                // No isStyleLoaded() gate: it idles FALSE on a quiet map
                // (proven 2026-07-15), and gating on it left fresh verdicts
                // undrawn — "the last waypoint stays grey until you add
                // another" / "reopen the page and all waypoints stay grey".
                // addSource/addLayer only throw during the style's INITIAL
                // load; the try/catch below plus the retry timer cover that
                // window, and setData is always safe once sources exist.
                if (!map.getSource('trace-line')) {
                    map.addSource('trace-line', {
                        type: 'geojson',
                        data: { type: 'FeatureCollection', features: [] },
                    });
                }
                for (const [id, width, blur, opacity] of [
                    ['trace-line-glow', 10, 8, 0.5],
                    ['trace-line-core', 3.5, 0, 0.95],
                ] as const) {
                    if (!map.getLayer(id)) {
                        map.addLayer({
                            id,
                            type: 'line',
                            source: 'trace-line',
                            layout: { 'line-join': 'round', 'line-cap': 'round' },
                            paint: {
                                'line-color': [
                                    'match',
                                    ['get', 'grade'],
                                    'clear',
                                    '#00e676',
                                    'caution',
                                    '#ffb300',
                                    'danger',
                                    '#ff1744',
                                    '#94a3b8', // pending — verdict still computing
                                ],
                                'line-width': width,
                                'line-blur': blur,
                                'line-opacity': opacity,
                            },
                        });
                    }
                }
                // Direction chevrons — "head south when you exit the bar, not
                // north" (Shane 2026-07-08). Auto-rotated along each leg; white
                // with a dark halo so they read over every grade colour.
                if (!map.getLayer('trace-line-arrows')) {
                    map.addLayer({
                        id: 'trace-line-arrows',
                        type: 'symbol',
                        source: 'trace-line',
                        layout: {
                            'symbol-placement': 'line',
                            'symbol-spacing': 90,
                            'text-field': '›',
                            'text-size': 18,
                            'text-keep-upright': false,
                            'text-allow-overlap': true,
                            'text-rotation-alignment': 'map',
                        },
                        paint: {
                            'text-color': '#ffffff',
                            'text-halo-color': '#0f172a',
                            'text-halo-width': 1.5,
                        },
                    });
                }
                // Proven-lane ghost (guided builder): dotted grey preview of a
                // curated fairway near the punter — accept it in the panel and
                // its points become pins.
                if (!map.getSource('trace-ghost')) {
                    map.addSource('trace-ghost', {
                        type: 'geojson',
                        data: { type: 'FeatureCollection', features: [] },
                    });
                }
                if (!map.getLayer('trace-ghost-line')) {
                    map.addLayer({
                        id: 'trace-ghost-line',
                        type: 'line',
                        source: 'trace-ghost',
                        layout: { 'line-join': 'round', 'line-cap': 'round' },
                        paint: {
                            'line-color': '#94a3b8',
                            'line-width': 3,
                            'line-opacity': 0.7,
                            'line-dasharray': [1.5, 2],
                        },
                    });
                }
                // Problem spots ON the chart (P2): a ⚠ at every issue position —
                // the verdict computed the exact lat/lon all along; the panel row
                // alone left the punter guessing WHERE on a 2 NM leg the 2.1 m
                // patch was.
                if (!map.getSource('trace-issues')) {
                    map.addSource('trace-issues', {
                        type: 'geojson',
                        data: { type: 'FeatureCollection', features: [] },
                    });
                }
                if (!map.getLayer('trace-issues-icons')) {
                    map.addLayer({
                        id: 'trace-issues-icons',
                        type: 'symbol',
                        source: 'trace-issues',
                        layout: { 'text-field': '⚠', 'text-size': 16, 'text-allow-overlap': true },
                        paint: {
                            'text-color': ['match', ['get', 'severity'], 'danger', '#ff1744', '#ffb300'],
                            'text-halo-color': '#0f172a',
                            'text-halo-width': 1.5,
                        },
                    });
                }
                const feats: Array<{
                    type: 'Feature';
                    properties: { grade: string };
                    geometry: { type: 'LineString'; coordinates: [number, number][] };
                }> = [];
                const issueFeats: Array<{
                    type: 'Feature';
                    properties: { severity: string };
                    geometry: { type: 'Point'; coordinates: [number, number] };
                }> = [];
                if (coordCaptureMode) {
                    for (let i = 1; i < capturedCoords.length; i++) {
                        const a = capturedCoords[i - 1];
                        const b = capturedCoords[i];
                        feats.push({
                            type: 'Feature',
                            properties: { grade: legVerdicts[i - 1]?.grade ?? 'pending' },
                            geometry: {
                                type: 'LineString',
                                coordinates: [
                                    [a.lon, a.lat],
                                    [b.lon, b.lat],
                                ],
                            },
                        });
                    }
                    for (const v of legVerdicts) {
                        if (!v) continue; // pending slot — still grading
                        for (const iss of v.issues) {
                            if (!iss.at) continue;
                            if (iss.severity === 'info') continue; // green confirmation → no ⚠ on the chart
                            issueFeats.push({
                                type: 'Feature',
                                properties: { severity: iss.severity },
                                geometry: { type: 'Point', coordinates: [iss.at.lon, iss.at.lat] },
                            });
                        }
                    }
                }
                (map.getSource('trace-line') as mapboxgl.GeoJSONSource).setData({
                    type: 'FeatureCollection',
                    features: feats as never,
                });
                (map.getSource('trace-issues') as mapboxgl.GeoJSONSource).setData({
                    type: 'FeatureCollection',
                    features: issueFeats as never,
                });
                (map.getSource('trace-ghost') as mapboxgl.GeoJSONSource).setData({
                    type: 'FeatureCollection',
                    features: (coordCaptureMode && capturedCoords.length <= 1
                        ? ghostLanes.map((l) => ({
                              type: 'Feature' as const,
                              properties: { id: l.id },
                              geometry: {
                                  type: 'LineString' as const,
                                  coordinates: l.points.map((p) => [p.lon, p.lat]),
                              },
                          }))
                        : []) as never,
                });
                // Course-frame bearing hint — thin dashed sky line from the
                // trace's live end (or the origin, pre-first-pin) to the 🏁
                // destination ghost. Pure orientation ("which way is
                // Mooloolaba"), never a route: it re-anchors as pins land.
                if (!map.getSource('trace-dest-hint')) {
                    map.addSource('trace-dest-hint', {
                        type: 'geojson',
                        data: { type: 'FeatureCollection', features: [] },
                    });
                }
                if (!map.getLayer('trace-dest-hint-line')) {
                    map.addLayer({
                        id: 'trace-dest-hint-line',
                        type: 'line',
                        source: 'trace-dest-hint',
                        layout: { 'line-join': 'round', 'line-cap': 'round' },
                        paint: {
                            'line-color': '#38bdf8',
                            'line-width': 1.5,
                            'line-opacity': 0.45,
                            'line-dasharray': [1, 3],
                        },
                    });
                }
                const hintFrom = capturedCoords[capturedCoords.length - 1] ?? traceOrigin;
                (map.getSource('trace-dest-hint') as mapboxgl.GeoJSONSource).setData({
                    type: 'FeatureCollection',
                    features: (coordCaptureMode && traceDest && hintFrom
                        ? [
                              {
                                  type: 'Feature' as const,
                                  properties: {},
                                  geometry: {
                                      type: 'LineString' as const,
                                      coordinates: [
                                          [hintFrom.lon, hintFrom.lat],
                                          [traceDest.lon, traceDest.lat],
                                      ],
                                  },
                              },
                          ]
                        : []) as never,
                });
            } catch {
                /* style mid-initial-load — the retry timer lands it */
            }
        };
        sync();
        // Wake a parked render loop so the recolour paints NOW, not on
        // the next interaction (same rAF-stall as the stale-chart bug).
        try {
            map.triggerRepaint();
        } catch {
            /* map mid-teardown */
        }
        // HEAL, don't re-run: sync's own setData calls emit styledata, so
        // re-syncing on EVERY styledata was a self-feeding churn loop —
        // four setData pushes per event, payload growing with each leg
        // ("the more waypoints I add, the slower the page becomes",
        // 2026-07-15). The listener now only re-runs sync when a basemap
        // swap actually DROPPED the sources.
        const heal = (): void => {
            if (!map.getSource('trace-line')) sync();
        };
        map.on('styledata', heal);
        // First-paint retry: if the style wasn't ready at effect time,
        // poll briefly until the sources land, then stop.
        const firstTry = !map.getSource('trace-line')
            ? window.setInterval(() => {
                  if (map.getSource('trace-line')) {
                      window.clearInterval(firstTry as number);
                      return;
                  }
                  sync();
              }, 300)
            : null;
        return () => {
            map.off('styledata', heal);
            if (firstTry !== null) window.clearInterval(firstTry);
        };
    }, [capturedCoords, legVerdicts, coordCaptureMode, ghostLanes, traceOrigin, traceDest]);
    // START / 🏁 ghost markers for the course frame — DOM markers (they
    // survive basemap style switches), hollow rings so they can never be
    // mistaken for trace pins. Rebuilt whole on any frame change.
    useEffect(() => {
        frameMarkersRef.current.forEach((m) => m.remove());
        frameMarkersRef.current = [];
        const map = mapRef.current;
        if (!map || !coordCaptureMode) return;
        const mk = (p: { lat: number; lon: number; name: string }, kind: 'start' | 'finish'): mapboxgl.Marker => {
            const colour = kind === 'start' ? '#34d399' : '#f87171';
            const el = document.createElement('div');
            el.style.cssText = 'display:flex;flex-direction:column;align-items:center;pointer-events:none;';
            const ring = document.createElement('div');
            ring.style.cssText = `width:16px;height:16px;border-radius:50%;border:3px solid ${colour};background:rgba(15,23,42,0.5);box-shadow:0 0 6px rgba(0,0,0,0.7);`;
            const label = document.createElement('div');
            label.style.cssText = `margin-top:2px;max-width:96px;font:800 9px/1.15 system-ui;letter-spacing:0.04em;text-align:center;color:${colour};text-shadow:0 1px 3px #000;`;
            label.textContent = kind === 'start' ? 'START' : `🏁 ${p.name}`;
            el.append(ring, label);
            return new mapboxgl.Marker({ element: el, anchor: 'top' }).setLngLat([p.lon, p.lat]).addTo(map);
        };
        // Origin ghost only until the first real pin lands — pin 1 IS the
        // START button now, and two green STARTs on one chart is noise.
        // The 🏁 destination ghost stays: it's the target being traced
        // toward until the trace actually gets there.
        if (traceOrigin && capturedCoords.length === 0) frameMarkersRef.current.push(mk(traceOrigin, 'start'));
        if (traceDest) frameMarkersRef.current.push(mk(traceDest, 'finish'));
        return () => {
            frameMarkersRef.current.forEach((m) => m.remove());
            frameMarkersRef.current = [];
        };
    }, [traceOrigin, traceDest, coordCaptureMode, capturedCoords.length]);
    // Arrival nudge — the punter's latest pin landed on the doorstep of
    // the framed destination: close the loop, point at Save.
    useEffect(() => {
        if (!traceDest || capturedCoords.length < 2) return;
        const last = capturedCoords[capturedCoords.length - 1];
        const dLat = (last.lat - traceDest.lat) * 111_320;
        const dLon = (last.lon - traceDest.lon) * 111_320 * Math.cos((traceDest.lat * Math.PI) / 180);
        if (Math.hypot(dLat, dLon) < 150) {
            flashTraceFeedback(`That's ${traceDest.name} — name the route and save it`);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [capturedCoords]);
    const copyCapturedCoords = useCallback(async () => {
        const text = capturedCoords.map((c) => `${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}`).join('\n');
        try {
            await navigator.clipboard.writeText(text);
            setCoordsCopied(true);
            setTimeout(() => setCoordsCopied(false), 1500);
        } catch {
            /* clipboard blocked — the on-screen list is still copyable by hand */
        }
        triggerHaptic('medium');
    }, [capturedCoords]);
    // Drop / refresh a numbered pin per captured coord so the skipper can see
    // exactly where each tap landed. Pins are DRAGGABLE (nudge one and the
    // adjoining legs re-grade live) and TAPPABLE (select → Delete / Insert-
    // after in the panel). The visual circle stays 22 px but rides inside a
    // 40 px transparent hit-slop so gloved fingers can actually grab it.
    useEffect(() => {
        const map = mapRef.current;
        if (!map) return;
        const recs = captureMarkersRef.current;
        if (!coordCaptureMode) {
            recs.forEach((r) => r.marker.remove());
            captureMarkersRef.current = [];
            return;
        }
        // RECONCILE, don't rebuild: pins deleted → pop their markers;
        // everything else updates in place (position / style signature).
        while (recs.length > capturedCoords.length) recs.pop()!.marker.remove();
        capturedCoords.forEach((c, i) => {
            // Journey book-ends (Shane 2026-07-14): the FIRST pin IS the
            // green START button and the LAST pin IS the red finish ring —
            // middles stay numbered (2, 3, …). Appending a pin restyles
            // the old tail back to its number via the sig diff below.
            const isStart = i === 0;
            const isEnd = !isStart && i === capturedCoords.length - 1;
            // Chained-leg lock (Shane 2026-07-17): pin 1 of a "next leg" IS
            // the previous leg's arrival — exact coords, not draggable.
            const locked = isStart && legAnchor !== null;
            const label = isStart ? '1' : isEnd ? String(capturedCoords.length) : String(i + 1);
            const smallFont = capturedCoords.length > 9 && isEnd;
            const sig = `${isStart ? 's' : isEnd ? 'e' : 'm'}|${label}|${i === selectedPin ? 1 : 0}|${smallFont ? 1 : 0}|${locked ? 'L' : ''}`;
            let rec = recs[i];
            if (!rec) {
                const el = document.createElement('div');
                // NEVER set `position` inline on a Marker root: it overrides
                // Mapbox's .mapboxgl-marker { position: absolute } and drops
                // the pin into document FLOW — each pin then rendered a fixed
                // 40 px × index below its true anchor, which reads as "routes
                // move when you zoom" (Shane 2026-07-14; live-site autopsy:
                // transform said y=58, rect said y=118). The root is already
                // absolutely positioned by Mapbox, so it IS the containing
                // block for the absolute START label — no `relative` needed.
                el.style.cssText = 'width:40px;height:40px;display:flex;align-items:center;justify-content:center;';
                const dot = document.createElement('div');
                el.appendChild(dot);
                const marker = new mapboxgl.Marker({ element: el, draggable: true })
                    .setLngLat([c.lon, c.lat])
                    .addTo(map);
                const newRec: (typeof recs)[number] = {
                    marker,
                    el,
                    dot,
                    tag: null,
                    sig: '', // forces the first style pass below
                    lat: c.lat,
                    lon: c.lon,
                    index: i,
                    dragged: false,
                };
                marker.on('dragstart', () => {
                    newRec.dragged = true;
                });
                marker.on('dragend', () => {
                    const ll = marker.getLngLat();
                    triggerHaptic('light');
                    // Dragging NEAR a lead lands ON the lead (same fat-finger
                    // rule as placement; >120 m away stays where dropped).
                    let p0 = { lat: ll.lat, lon: ll.lng };
                    const ctx = tracerCtxRef.current;
                    const onLead = ctx ? snapTraceTapToLead(ctx, p0) : null;
                    if (onLead) {
                        p0 = onLead;
                        marker.setLngLat([p0.lon, p0.lat]);
                        flashTraceFeedback('Snapped onto the lead 🎯');
                    }
                    setCapturedCoords((prev) => prev.map((p, j) => (j === newRec.index ? p0 : p)));
                });
                el.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (newRec.dragged) {
                        newRec.dragged = false;
                        return;
                    }
                    triggerHaptic('light');
                    setSelectedPin((cur) => (cur === newRec.index ? null : newRec.index));
                    setInsertAfter(null);
                    insertAfterRef.current = null;
                });
                recs[i] = newRec;
                rec = newRec;
            }
            rec.index = i; // keep listener closures honest across inserts/deletes
            if (rec.lat !== c.lat || rec.lon !== c.lon) {
                rec.marker.setLngLat([c.lon, c.lat]);
                rec.lat = c.lat;
                rec.lon = c.lon;
            }
            if (rec.sig === sig) return; // style already right — zero writes
            rec.sig = sig;
            // Idempotent per style pass (the sig carries the lock flag).
            rec.marker.setDraggable(!locked);
            const ring =
                i === selectedPin
                    ? 'box-shadow:0 0 0 3px #38bdf8,0 1px 4px rgba(0,0,0,.5);'
                    : 'box-shadow:0 1px 4px rgba(0,0,0,.5);';
            if (isStart || isEnd) {
                const colour = isStart ? '#34d399' : '#f87171';
                // The sequence number rides INSIDE the ring (Shane
                // 2026-07-15: "1 inside the green, whatever the last
                // number is inside the red") — the journey book-ends
                // still count as waypoints.
                rec.dot.textContent = label;
                rec.dot.style.cssText = `width:22px;height:22px;border-radius:9999px;border:4px solid ${colour};background:rgba(15,23,42,0.85);color:${colour};display:flex;align-items:center;justify-content:center;font:800 ${smallFont ? 8 : 10}px sans-serif;${ring}`;
            } else {
                rec.dot.textContent = label;
                rec.dot.style.cssText = `background:#f59e0b;color:#000;border-radius:9999px;width:22px;height:22px;display:flex;align-items:center;justify-content:center;font:700 12px sans-serif;${ring}`;
            }
            if (isStart && !rec.tag) {
                // Label overflows the fixed 40 px hit-box (absolute, no
                // layout part) so the marker's centre anchor — and drag
                // grab point — stays exactly on the coordinate.
                const tag = document.createElement('div');
                tag.style.cssText =
                    'position:absolute;top:33px;left:50%;transform:translateX(-50%);font:800 9px/1 system-ui;letter-spacing:0.04em;color:#34d399;text-shadow:0 1px 3px #000;pointer-events:none;white-space:nowrap;';
                rec.el.appendChild(tag);
                rec.tag = tag;
            } else if (!isStart && rec.tag) {
                rec.tag.remove();
                rec.tag = null;
            }
            // Chained legs read "🔒 START" — the padlock says why this one
            // won't drag (its spot IS the previous leg's arrival).
            if (rec.tag) rec.tag.textContent = locked ? '🔒 START' : 'START';
        });
    }, [capturedCoords, coordCaptureMode, selectedPin, legAnchor]);

    // Deeper-water GHOST waypoints — REMOVED (Shane 2026-07-16: "get rid of
    // the phantom waypoints, that went haywire"). A thin route sprouted a
    // dashed ghost pin on EVERY nudge-carrying leg at once — visual noise and
    // mis-splices. The 💡 "deeper water ~30 m to starboard" text advisory
    // stays; TraceLegVerdict.nudgeTo (the charted deep spot) stays computed +
    // tested for a future, better-scoped resurrection (e.g. one ghost for the
    // SELECTED leg only).
    // Pin-on-land diagnosis, MEMOIZED — this used to run tracePinBlocked
    // (a depth-grid read) for EVERY pin on EVERY render inside the panel
    // JSX; with the zoom pill re-rendering the tree per pinch frame that
    // was N grid reads per frame (perf hunt 2026-07-15). legVerdicts is
    // the recompute key: it changes exactly when a grading pass lands,
    // which is when the held ctx could have answered differently.
    const pinDiagnosis = useMemo(() => {
        if (!coordCaptureMode) return null;
        const ctx = tracerCtxRef.current;
        if (!ctx?.grid) return null;
        const bad = capturedCoords.map((p, i) => ({ i, why: tracePinBlocked(ctx, p) })).filter((x) => x.why !== null);
        if (bad.length === 0) return null;
        return bad
            .slice(0, 2)
            .map(
                (x) =>
                    `Pin ${x.i + 1} is on ${x.why === 'land' ? 'charted land' : x.why === 'berth' ? 'a berth row' : 'a charted hazard'} — drag it into the water.`,
            )
            .join(' ');
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [coordCaptureMode, capturedCoords, legVerdicts]);
    // ── Tracer actions: save / export-as-fairway / sail ──
    const flashTraceFeedback = useCallback((msg: string) => {
        setTraceFeedback(msg);
        setTimeout(() => setTraceFeedback(null), 1800);
    }, []);
    // Open a saved route straight into the card (Shane 2026-07-17: "a way,
    // when you are in the web page, to bring up the previous tracks"). On the
    // standalone /plan page there's no PLAN front door, so this is the ONLY
    // path to a saved route. Same load semantics as the PLAN-page 'load-saved'
    // deep link: rebase the Undo floor, adopt the name, drop the leg-chain
    // lock, and FIT THE WHOLE ROUTE on screen (Shane 2026-07-17: "show the
    // entire route, overriding the zoom-10 restriction") — fitBounds picks
    // whatever zoom shows every pin, in OR out past 10, capped at 15 so a
    // tiny route doesn't slam to max zoom.
    const openSavedTrace = useCallback(
        (t: SavedTrace) => {
            if (!t || t.points.length < 2) return;
            triggerHaptic('light');
            setLegAnchor(null);
            rebaseHistoryRef.current = true;
            setCapturedCoords(t.points);
            setTraceName(t.name);
            setShowSavedTraces(false);
            setSelectedPin(null);
            if (mapRef.current) fitTraceBounds(mapRef.current, t.points);
            flashTraceFeedback(`Opened "${t.name}"`);
        },
        [flashTraceFeedback],
    );
    const saveCurrentTrace = useCallback(() => {
        if (capturedCoords.length < 2) return;
        // No name, no save (Shane 2026-07-15) — the date-stamped fallback
        // bred anonymous "Trace 15/07/2026" rows nobody could tell apart.
        // Prompt and put the cursor in the box instead.
        if (!traceName.trim()) {
            triggerHaptic('light');
            flashTraceFeedback('Name the route first');
            traceNameInputRef.current?.focus();
            return;
        }
        // Chained leg (Shane 2026-07-17): the stored name carries the ordinal
        // badge — "woorim - timbuktu" saves as "woorim - timbuktu (2nd Leg)".
        // withLegBadge strips any existing badge first, so re-saves never
        // stack "(2nd Leg) (2nd Leg)".
        const anchor = legAnchor;
        const finalName = anchor ? withLegBadge(traceName.trim(), anchor.ordinal) : traceName.trim();
        // Saving under an EXISTING route's name updates that route in place
        // — same id locally and on the account, so "Bay run" never breeds
        // "Bay run", "Bay run"… twins. Never silently though (Shane
        // 2026-07-15: "of course it needs to ask me first"): the first tap
        // arms the button as "Overwrite?", the second replaces.
        const wantedName = finalName.toLowerCase();
        const existing = wantedName ? savedTraces.find((t) => t.name.trim().toLowerCase() === wantedName) : undefined;
        if (existing && overwriteArm !== existing.id) {
            triggerHaptic('medium');
            setOverwriteArm(existing.id);
            flashTraceFeedback(`"${existing.name}" exists — tap again to overwrite it`);
            return;
        }
        setOverwriteArm(null);
        triggerHaptic('medium');
        const { trace, persisted, cloud } = saveTrace(finalName, capturedCoords, {
            ...(existing ? { overwriteId: existing.id } : {}),
            ...(anchor
                ? {
                      tripId: anchor.tripId,
                      legOrdinal: anchor.ordinal,
                      destName: destNameFromRouteName(finalName) ?? undefined,
                  }
                : {}),
        });
        // The trip becomes REAL at leg 2's save: leg 1 retro-earns its
        // "(1st Leg)" badge + chain fields (Shane's call: retro, not
        // upfront — day-sail routes never carry trip baggage).
        const retro = persisted && anchor ? retroBadgeFirstLeg(anchor.tripId) : null;
        // AUTO-HEAL (Shane's call): if this save moved a leg's arrival and a
        // later leg departs from it, that leg's locked start follows.
        const healed = persisted ? healTripChain(trace) : null;
        setSavedTraces(loadSavedTraces());
        if (anchor) setTraceName(finalName); // show the badged name; re-save arms overwrite
        if (persisted) {
            // Name STAYS after save (Shane 2026-07-15: "name is not
            // flipping" — his flow is save → ⇄ reverse → save the return
            // trip, and the old setTraceName('') here handed ⇄ an empty
            // box to flip). Keeping it also makes re-save-as-overwrite
            // natural: tap Save again and the "Overwrite?" arm appears.
            // One flash slot — chain news rides along with the save ack.
            const ack = existing ? 'Updated ✓' : 'Saved ✓';
            flashTraceFeedback(
                healed
                    ? `${ack} — ${healed}`
                    : retro
                      ? `${ack} — trip chained, leg 1 is now "${retro.name}"`
                      : anchor
                        ? `${ack} — ${ordinalLegLabel(anchor.ordinal)} of the trip`
                        : ack,
            );
            // This saved state is the new Undo FLOOR (Shane 2026-07-16: undo
            // "right up to when it was last saved"). Save doesn't touch
            // capturedCoords, so clear both stacks directly.
            traceHistoryRef.current = [];
            traceRedoRef.current = [];
            prevCoordsRef.current = capturedCoords;
            setCanUndoTrace(false);
            setCanRedoTrace(false);
            // Cross-device honesty: "Saved ✓" is true of THIS device either
            // way, but build-on-desktop→sail-on-phone needs the account
            // push — when it didn't happen, say so instead of letting the
            // route silently live in one browser's localStorage.
            void cloud.then((result) => {
                if (result === 'signedout') flashTraceFeedback('Saved here — sign in to sync across devices');
                else if (result === 'toolarge') flashTraceFeedback('Saved here — over 200 pins, too long to sync');
                else if (result === 'error') flashTraceFeedback('Saved here — cloud sync will retry later');
            });
            // Suggested-route mirror (Shane 2026-07-15: "when we save a
            // route, it should automatically save as a suggested route in
            // the log page") — the same planned_% logbook write Sail does,
            // minus the follow. Background under a JS deadline; the
            // label+day duplicate guard makes same-day re-saves quiet
            // no-ops instead of twins.
            void (async () => {
                try {
                    const [{ savePassagePlanToLogbook }, { withDeadline }] = await Promise.all([
                        import('../../services/shiplog/PassagePlanSave'),
                        import('../../utils/deadline'),
                    ]);
                    const plan = traceAsVoyagePlan(
                        finalName,
                        capturedCoords,
                        legVerdicts.length === capturedCoords.length - 1 && legVerdicts.every((v) => v !== null)
                            ? legVerdicts.map((v) => v!.grade)
                            : undefined,
                    );
                    await withDeadline(savePassagePlanToLogbook(plan), 25_000, 'trace save → logbook');
                    const { invalidateRoutesAndTracks } = await import('../../services/shiplog/RoutesAndTracks');
                    invalidateRoutesAndTracks();
                } catch (err) {
                    const { DUPLICATE_PASSAGE_PLAN_ERROR } = await import('../../services/shiplog/PassagePlanSave');
                    if (!(err instanceof Error && err.message === DUPLICATE_PASSAGE_PLAN_ERROR)) {
                        log.warn(`trace save → logbook skipped: ${err instanceof Error ? err.message : String(err)}`);
                    }
                }
            })();
        } else {
            // Quota refused the write — saying "Saved ✓" over a route that
            // won't exist next session is exactly the lie we don't tell.
            flashTraceFeedback('Could not save — storage full');
        }
    }, [capturedCoords, traceName, legAnchor, savedTraces, overwriteArm, legVerdicts, flashTraceFeedback]);
    // Return-trip flip (Shane 2026-07-15: "when we are returning, we can
    // flip the trip the other way"): reverse the pins and let the grader
    // re-run. Leg cache keys are DIRECTION-SENSITIVE (a↔b swap, the
    // |last suffix moves, solo-lateral advisory ownership follows travel
    // direction), so reversed legs re-grade honestly instead of reusing
    // outbound verdicts — the water is the same but the reads aren't.
    const reverseTrace = useCallback(() => {
        if (capturedCoords.length < 2) return;
        // A chained leg can't flip — its start is bolted to the previous
        // leg's arrival. (Reverse the whole TRIP leg-by-leg later instead.)
        if (legAnchorRef.current) {
            flashTraceFeedback(`Chained leg — the start is locked to ${legAnchorRef.current.fromName}`);
            return;
        }
        triggerHaptic('medium');
        setSelectedPin(null);
        setInsertAfter(null);
        insertAfterRef.current = null;
        setCapturedCoords((prev) => [...prev].reverse());
        // The name flips with the pins ("Newport - Lady Musgrave" →
        // "Lady Musgrave - Newport", Shane 2026-07-15) — so saving the
        // return run creates ITS OWN route instead of colliding with
        // the outbound's overwrite guard. No-op for separator-less names.
        const flipped = reverseRouteName(traceName);
        setTraceName(flipped);
        setOverwriteArm(null);
        // Say the new name out loud — "name is not flipping" turned out
        // to be an empty box being flipped; now the flash proves it.
        flashTraceFeedback(
            flipped.trim() && flipped !== traceName
                ? `Reversed — "${flipped.trim()}"`
                : 'Reversed — checking the return run now',
        );
    }, [capturedCoords.length, traceName, flashTraceFeedback]);
    const copyFairwaySnippet = useCallback(async () => {
        if (capturedCoords.length < 2) return;
        try {
            await navigator.clipboard.writeText(traceAsCuratedFairwaySnippet(traceName, capturedCoords));
            flashTraceFeedback('Fairway JSON copied ✓');
        } catch {
            flashTraceFeedback('Clipboard blocked');
        }
        triggerHaptic('medium');
    }, [capturedCoords, traceName, flashTraceFeedback]);
    const sailTrace = useCallback(async () => {
        if (capturedCoords.length < 2 || sailBusyRef.current) return;
        sailBusyRef.current = true;
        triggerHaptic('medium');
        const plan = traceAsVoyagePlan(
            traceName,
            capturedCoords,
            legVerdicts.length === capturedCoords.length - 1 && legVerdicts.every((v) => v !== null)
                ? legVerdicts.map((v) => v!.grade)
                : undefined,
        );
        // FOLLOW FIRST — it's synchronous/local and it's the thing the skipper
        // actually needs. The logbook save used to run ahead of it: four
        // sequential network awaits with no visible feedback, and CapacitorHttp
        // AbortSignals are no-ops on device, so a marginal anchorage left the
        // Sail tap dead for minutes (adversarial audit, 2026-07-08).
        try {
            const { useFollowRouteStore } = await import('../../stores/followRouteStore');
            useFollowRouteStore.getState().startFollowing(plan, '');
            flashTraceFeedback('Following your trace ✓');
        } catch (err) {
            log.warn(`trace follow failed: ${err instanceof Error ? err.message : String(err)}`);
            flashTraceFeedback('Could not start following');
            sailBusyRef.current = false;
            return;
        }
        // Logbook save in the BACKGROUND under a JS deadline; patch the
        // voyageId into the follow store when it lands.
        void (async () => {
            try {
                const [{ savePassagePlanToLogbook }, { withDeadline }] = await Promise.all([
                    import('../../services/shiplog/PassagePlanSave'),
                    import('../../utils/deadline'),
                ]);
                const voyageId = await withDeadline(savePassagePlanToLogbook(plan), 25_000, 'trace logbook save');
                if (voyageId) {
                    const { useFollowRouteStore } = await import('../../stores/followRouteStore');
                    const st = useFollowRouteStore.getState();
                    if (st.isFollowing && st.voyagePlan?.origin === plan.origin) {
                        useFollowRouteStore.setState({ voyageId });
                    }
                }
            } catch (err) {
                const { DUPLICATE_PASSAGE_PLAN_ERROR } = await import('../../services/shiplog/PassagePlanSave');
                if (err instanceof Error && err.message === DUPLICATE_PASSAGE_PLAN_ERROR) {
                    // Same label already saved today — surface it, don't lie.
                    flashTraceFeedback('Already in the logbook today — following without a new entry');
                } else {
                    log.warn(`trace log save skipped: ${err instanceof Error ? err.message : String(err)}`);
                }
            } finally {
                sailBusyRef.current = false;
            }
        })();
    }, [capturedCoords, traceName, legVerdicts, flashTraceFeedback]);
    // ── Route report: Fix-this-leg + Acknowledge (Phase 3) ──
    // Splice micro-A* detours for the given DANGER legs. Processed last-to-
    // first so earlier indices stay valid, on ONE local pin array so a
    // multi-fix doesn't chase stale state. Returns how many actually fixed.
    // ASYNC since windowed grading: tracerCtxRef holds only the LAST build
    // window, so a danger leg from an earlier window builds a fresh context
    // around ITSELF before the A* — otherwise every out-of-window fix
    // false-failed with "No clean detour here".
    const applyFixes = useCallback(
        async (legIdxs: number[]): Promise<{ fixed: number; added: number }> => {
            // Draft from the last grading pass (settings isn't in scope this
            // early in the component) — Fix buttons only exist once a pass
            // has graded, so the ref is always populated here.
            const draft = gradedDraftRef.current;
            if (!draft) return { fixed: 0, added: 0 };
            let pins = [...capturedCoords];
            let fixed = 0;
            for (const i of [...legIdxs].sort((x, y) => y - x)) {
                if (i < 0 || i + 1 >= pins.length) continue;
                let ctx = tracerCtxFromLru([pins[i], pins[i + 1]]);
                if (!ctx) {
                    try {
                        const built = await buildTracerContext(traceBboxPadded([pins[i], pins[i + 1]]), draft.d, {
                            draftAssumed: draft.assumed,
                        });
                        if (built.status === 'ready') {
                            ctx = built.ctx;
                            tracerCtxHold(built.ctx);
                        } else {
                            continue; // marks-only/no chart — nothing to A* on
                        }
                    } catch {
                        continue;
                    }
                }
                const detour = fixLegOnGrid(ctx, pins[i], pins[i + 1]);
                if (detour && detour.length >= 2) {
                    pins = [...pins.slice(0, i + 1), ...detour.slice(1, -1), ...pins.slice(i + 1)];
                    fixed++;
                }
            }
            if (fixed > 0) setCapturedCoords(pins);
            // `added` feeds the auto-route flash — "3 pins added" vs "the
            // straight shot was already the clean line".
            return { fixed, added: fixed > 0 ? pins.length - capturedCoords.length : 0 };
        },
        [capturedCoords],
    );
    const onFixLeg = useCallback(
        (i: number) => {
            setFixBusyLeg(i);
            // Yield a frame so the "Fixing…" state paints before the A*.
            setTimeout(() => {
                void applyFixes([i]).then(({ fixed }) => {
                    flashTraceFeedback(
                        fixed > 0 ? 'Leg fixed — re-checked' : 'No clean detour here — acknowledge or re-trace',
                    );
                    setFixBusyLeg(null);
                });
            }, 30);
        },
        [applyFixes, flashTraceFeedback],
    );
    /** Pulse a temporary amber halo on a chart mark — the answer to "WHICH
     *  marker am I too close to?" (Shane 2026-07-11). Tapping a mark caution
     *  flies there and rings the mark itself; WebAnimations, self-removing,
     *  one halo at a time. */
    const markHaloRef = useRef<mapboxgl.Marker | null>(null);
    const pulseMarkHalo = useCallback((p: { lat: number; lon: number }) => {
        const map = mapRef.current;
        if (!map) return;
        markHaloRef.current?.remove();
        const el = document.createElement('div');
        el.style.cssText =
            'width:44px;height:44px;border-radius:50%;border:3px solid #fbbf24;box-shadow:0 0 14px rgba(251,191,36,0.9);pointer-events:none;';
        el.animate(
            [
                { transform: 'scale(0.5)', opacity: 1 },
                { transform: 'scale(1.6)', opacity: 0 },
            ],
            { duration: 1100, iterations: 5, easing: 'ease-out' },
        );
        const marker = new mapboxgl.Marker({ element: el }).setLngLat([p.lon, p.lat]).addTo(map);
        markHaloRef.current = marker;
        window.setTimeout(() => {
            marker.remove();
            if (markHaloRef.current === marker) markHaloRef.current = null;
        }, 5600);
    }, []);
    const onFixAll = useCallback(() => {
        const dangers = legVerdicts
            .map((v, i) => (v?.grade === 'danger' && !ackedLegs.has(i) ? i : -1))
            .filter((i) => i >= 0);
        if (dangers.length === 0) return;
        setFixBusyLeg(-1);
        setTimeout(() => {
            void applyFixes(dangers).then(({ fixed }) => {
                flashTraceFeedback(
                    fixed === dangers.length
                        ? `All ${fixed} no-go legs fixed — re-checked`
                        : `${fixed}/${dangers.length} fixed — the rest need an acknowledge or a re-trace`,
                );
                setFixBusyLeg(null);
            });
        }, 30);
    }, [legVerdicts, ackedLegs, applyFixes, flashTraceFeedback]);
    // ⚡ Auto route lives below the settings declaration (it reads
    // settings.vessel for draft/air-draft) — see autoRouteLeg.
    // Paste-import (Phase 4 lite): consume the exact format Copy produces —
    // mate-sharing over Messages with zero backend.
    // Append a typed GPS fix as the next pin. parseCoordinateString handles
    // the formats a sailor actually reads off a plotter/chart (decimal,
    // "27 08.5S 153 09.2E" DMM, DMS, hemisphere-suffixed). Builds a route
    // coord-by-coord — no map tapping needed.
    const addCoordPin = useCallback(() => {
        const parsed = parseCoordinateString(coordEntry);
        if (!parsed) {
            flashTraceFeedback('Couldn’t read that fix — try "27 08.5S 153 09.2E" or "-27.14, 153.15"');
            return;
        }
        triggerHaptic('light');
        const pt = { lat: parsed.lat, lon: parsed.lon };
        setCapturedCoords((prev) => [...prev, pt]);
        setCoordEntry('');
        const z = mapRef.current?.getZoom?.() ?? 12;
        mapRef.current?.flyTo({ center: [pt.lon, pt.lat], zoom: Math.max(z, 12), duration: 700 });
        flashTraceFeedback(`Point added — ${pt.lat.toFixed(4)}, ${pt.lon.toFixed(4)}`);
    }, [coordEntry, flashTraceFeedback]);

    const pasteTrace = useCallback(async () => {
        try {
            const text = await navigator.clipboard.readText();
            const pins: Array<{ lat: number; lon: number }> = [];
            for (const line of text.split(/\n+/)) {
                const m = line.match(/(-?\d{1,3}\.\d+)[,\s]+(-?\d{1,3}\.\d+)/);
                if (!m) continue;
                const lat = parseFloat(m[1]);
                const lon = parseFloat(m[2]);
                if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) pins.push({ lat, lon });
            }
            if (pins.length >= 2) {
                triggerHaptic('medium');
                setCapturedCoords(pins);
                const mid = pins[Math.floor(pins.length / 2)];
                mapRef.current?.flyTo({ center: [mid.lon, mid.lat], zoom: 12.5, duration: 1000 });
                flashTraceFeedback(`${pins.length} pins pasted — checking them now`);
            } else {
                flashTraceFeedback('Nothing on the clipboard that reads like "lat, lon" lines');
            }
        } catch {
            flashTraceFeedback('Clipboard not available');
        }
    }, [flashTraceFeedback]);
    // Share sheet (Phase 4 lite): the same coord payload Copy produces, out
    // through the native share sheet — "follow my line in" over Messages.
    const shareTrace = useCallback(async () => {
        if (capturedCoords.length < 2) return;
        const label = traceName.trim() || 'My route';
        const text =
            `${label} — traced with Thalassa (${capturedCoords.length} pins).\n` +
            `Open Thalassa → 🧭 Trace route → 📥 Paste coords:\n` +
            capturedCoords.map((c) => `${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}`).join('\n');
        triggerHaptic('medium');
        try {
            if (navigator.share) {
                await navigator.share({ title: label, text });
            } else {
                await navigator.clipboard.writeText(text);
                flashTraceFeedback('Copied — paste it to your mate');
            }
        } catch {
            /* punter cancelled the sheet — no drama */
        }
    }, [capturedCoords, traceName, flashTraceFeedback]);
    // Current map zoom level — surfaced in a small FAB top-left so
    // the skipper has at-a-glance idea of detail vs overview. Mirror
    // position of the mic FAB in App.tsx (top: 56px, right: 16px).
    // Zoom readout lives in ZoomLevelFab now — self-subscribed, so the
    // per-frame 'zoom' events never re-render this component (perf hunt
    // 2026-07-15: they re-rendered the whole tree every pinch frame).
    const isOnline = useOnlineStatus();
    const containerRef = useRef<HTMLDivElement>(null);
    const mapRef = useRef<mapboxgl.Map | null>(null);
    const pinMarkerRef = useRef<mapboxgl.Marker | null>(null);
    const locationDotRef = useRef<mapboxgl.Marker | null>(null);
    const { settings } = useSettings();
    const { setPage, currentView } = useUI();

    // Per-leg transit offsets (ms from departure to leg i's START pin) at
    // cruising speed — the ETA the tide windows are evaluated at. Pin-start
    // ETA is close enough to the gate's mid-leg spot: tide windows are hours
    // wide, legs are minutes long.
    const legEtaOffsetsMs = useMemo(() => {
        const spdRaw = settings.vessel?.cruisingSpeed;
        const spd = typeof spdRaw === 'number' && spdRaw > 0 ? spdRaw : 6;
        const out: number[] = [];
        let cumNM = 0;
        for (let i = 0; i + 1 < capturedCoords.length; i++) {
            out.push((cumNM / spd) * 3_600_000);
            cumNM += distMetres(capturedCoords[i], capturedCoords[i + 1]) / 1852;
        }
        return out;
    }, [capturedCoords, settings.vessel]);

    // ⚡ Auto route (Shane 2026-07-15: "follow deep water. if there is a
    // place we cannot cross, then check that against tide times. we cannot
    // cross land"). Drives the REAL inshore routing engine (tryInshoreRoute)
    // between the last two pins — the same engine ⚡ Auto-to-destination
    // uses. It follows navigable/deep water, treats LNDARE as a hard wall
    // (never crosses land), and the 'tideAssist' profile is willing to route
    // a shallow that clears with the tide and chip the window rather than
    // detour miles — exactly "follow deep water, tide-check where we can't
    // cross". The engine's polyline drops back as editable, re-graded pins.
    //
    // HARD RULE: on ANY engine failure (no route, no charts, too far) auto
    // route CHANGES NOTHING and says so. It must NEVER fall back to a straight
    // line — a straight line crosses land, which is exactly the failure the
    // first cut shipped (my mistake). Better to route nothing than route over
    // a headland.
    //
    // WHICH leg: the one INTO the highlighted pin (Shane 2026-07-15 "whichever
    // waypoint is highlighted, the leg between it and the waypoint before").
    // No selection → the last leg.
    const autoRouteLeg = useCallback(() => {
        if (capturedCoords.length < 2 || fixBusyLeg !== null) return;
        const iLeg =
            selectedPin !== null && selectedPin > 0 && selectedPin < capturedCoords.length
                ? selectedPin - 1
                : capturedCoords.length - 2;
        const a = capturedCoords[iLeg];
        const b = capturedCoords[iLeg + 1];
        triggerHaptic('medium');
        setFixBusyLeg(iLeg);
        setAutoRouteDiag(null);
        flashTraceFeedback('Following deep water…');
        setTimeout(() => {
            void (async () => {
                try {
                    const draftM = vesselDraftMetres(settings.vessel);
                    const airM = vesselAirDraftMetres(settings.vessel);
                    const O = { lat: a.lat, lon: a.lon };
                    const D = { lat: b.lat, lon: b.lon };
                    // DEEPEST WATER FIRST — but only when the deep line is
                    // SENSIBLE (Shane 2026-07-15: "follow the deepest water it
                    // can, if it CAN'T, tide-check where we must cross"). 'safest'
                    // prices sub-keel water 40× rather than blocking it, so in a
                    // nearly-all-shallow bay (Deception Bay for a 2.4 m keel) it
                    // doesn't fail — it returns an absurd deep-channel dogleg (a
                    // 30 NM tour for a 5 NM hop). THAT is the "can't cross"
                    // signal. So: take 'safest' only when its route stays within
                    // NEAR_DIRECT_CAP× the straight line; past that, run
                    // 'tideDirect' (recoverable banks at 1.5× so A* commits to
                    // the near-direct crossing on the tide) and take it when it's
                    // materially straighter (TIDE_ADOPT_FACTOR). A genuine deep
                    // detour (Newport→Rivergate ~1.35×) stays on safest.
                    const directNM = distMetres(a, b) / 1852;
                    const ratio = (nm: number) => (nm / directNM).toFixed(2);
                    const runEngine = async (): Promise<{
                        res: Awaited<ReturnType<typeof tryInshoreRoute>>;
                        viaTide: boolean;
                        diag: string | null;
                    }> => {
                        const safe = await tryInshoreRoute(O, D, draftM, airM, 'safest');
                        const safeOk = !!safe && 'polyline' in safe;
                        // Deep water already lines up near-direct → keep it, no
                        // tide crossing needed.
                        if (safeOk && safe.distanceNM <= directNM * NEAR_DIRECT_CAP) {
                            return {
                                res: safe,
                                viaTide: false,
                                diag: `⚡ Deep route ${safe.distanceNM.toFixed(1)} NM (${ratio(safe.distanceNM)}× direct ${directNM.toFixed(1)}) — near-direct, no tide crossing needed.`,
                            };
                        }
                        // 'safest' doglegged (or failed) → try 'tideDirect': the
                        // recoverable banks price at 1.5× so A* commits to the
                        // near-direct crossing rather than a marina detour
                        // (land + drying stay hard-blocked, never crossed).
                        const direct = await tryInshoreRoute(O, D, draftM, airM, 'tideDirect');
                        const directOk = !!direct && 'polyline' in direct;
                        if (directOk && (!safeOk || direct.distanceNM < safe.distanceNM * TIDE_ADOPT_FACTOR)) {
                            return {
                                res: direct,
                                viaTide: true,
                                diag: safeOk
                                    ? `⚡ Deep route ${safe.distanceNM.toFixed(1)} NM (${ratio(safe.distanceNM)}× direct ${directNM.toFixed(1)}) vs tide-direct ${direct.distanceNM.toFixed(1)} NM (${ratio(direct.distanceNM)}×) → CROSSING the banks on the tide. Cross near HW — see the red legs for the window.`
                                    : `⚡ No all-deep route — tide-direct ${direct.distanceNM.toFixed(1)} NM (${ratio(direct.distanceNM)}× direct) CROSSES the banks on the tide. Cross near HW — see the red legs.`,
                            };
                        }
                        // Neither near-direct deep nor a materially-straighter
                        // crossing → keep the safe deep route (a genuine detour:
                        // land/drying blocks the direct line) or the failure.
                        return {
                            res: safeOk ? safe : (safe ?? direct),
                            viaTide: false,
                            diag: safeOk
                                ? `⚡ Deep route ${safe.distanceNM.toFixed(1)} NM (${ratio(safe.distanceNM)}× direct ${directNM.toFixed(1)}); tide-direct ${directOk ? `${direct.distanceNM.toFixed(1)} NM not materially shorter` : 'unavailable'} (direct line blocked by land/drying) → kept the deep route.`
                                : null,
                        };
                    };
                    let { res, viaTide, diag } = await runEngine();

                    // Coverage-gap → SYNC THE CHARTS FIRST, then retry (Shane
                    // 2026-07-15 chose this). The router refuses to cross a
                    // stretch with no routing-grade chart; the missing detail
                    // cell almost always lives on the boat's Pi (confirmed
                    // OC-61-10ENB5 for Deception Bay). Pull the cells nearest
                    // this leg from the Pi and route again — no menu-diving.
                    if (res && 'error' in res && res.code === 'coverage-gap') {
                        setAutoRouteDiag('⚡ Missing charts for part of this leg — fetching them from the cloud…');
                        try {
                            // Fetch from the CLOUD, not the Pi: this runs on the
                            // web (thalassawx.app over HTTPS), where the Pi at
                            // http://…:3001 is unreachable behind the page's HTTPS
                            // origin (mixed-content block). The cloud bucket is
                            // HTTPS and holds the same cells. Downloading a cell
                            // also fixes its hazardCount so the router's coverage
                            // gate finally accepts it (the real bug — see
                            // cloudCellSync).
                            const { downloadCloudCellsForBBox } = await import('../../services/enc/cloudCellSync');
                            const pad = 0.03;
                            const bbox: [number, number, number, number] = [
                                Math.min(a.lon, b.lon) - pad,
                                Math.min(a.lat, b.lat) - pad,
                                Math.max(a.lon, b.lon) + pad,
                                Math.max(a.lat, b.lat) + pad,
                            ];
                            const fill = await downloadCloudCellsForBBox(bbox);
                            log.warn(
                                `auto-route: cloud fill downloaded=${fill.downloaded} needed=${fill.needed} bucket=${fill.bucketAvailable}`,
                            );
                            if (!fill.bucketAvailable) {
                                setAutoRouteDiag(
                                    "⚡ This leg needs charts your session doesn't have, and the chart cloud isn't reachable. Check your connection and that you're signed in (the charts are licensed).",
                                );
                                return;
                            }
                            if (fill.downloaded === 0 && fill.needed > 0) {
                                setAutoRouteDiag(
                                    "⚡ The missing charts wouldn't download — you're probably not signed in (the chart bucket is licensed-access). Sign in and try again.",
                                );
                                return;
                            }
                            if (fill.downloaded > 0) {
                                ({ res, viaTide, diag } = await runEngine());
                            }
                        } catch (syncErr) {
                            setAutoRouteDiag(
                                `⚡ Couldn't fetch the missing charts (${syncErr instanceof Error ? syncErr.message.slice(0, 50) : 'error'}). Check your connection / sign-in and try again.`,
                            );
                            return;
                        }
                    }
                    if (res && 'polyline' in res) {
                        const pts = res.polyline.map(([lon, lat]) => ({ lat, lon }));
                        const prof = viaTide ? 'tideDirect' : 'safest';
                        log.warn(
                            `auto-route: engine returned ${pts.length} pts, ${res.distanceNM.toFixed(1)} NM (${prof}); direct ${directNM.toFixed(1)} NM`,
                        );
                        // RDP to the bends, THEN cap every straight run to
                        // AUTO_MAX_LEG_M so a long open-water stretch becomes a
                        // chain of DEPTH-CHECKABLE legs — the added pins sit ON
                        // the engine's water line, so they can't cross land.
                        const followed = capSegmentLength(rdpTracePoints(pts, 40), AUTO_MAX_LEG_M);
                        const interior = followed.slice(1, -1);
                        const base = capturedCoords;
                        const newPins = [...base.slice(0, iLeg + 1), ...interior, ...base.slice(iLeg + 1)];
                        setCapturedCoords(newPins);
                        setSelectedPin(null); // indices shifted; drop the highlight
                        setInsertAfter(null);
                        insertAfterRef.current = null;
                        if (interior.length > 0) {
                            flashTraceFeedback(
                                viaTide
                                    ? `Routed with a tide gate — ${interior.length} pin${interior.length > 1 ? 's' : ''} added, checking the window`
                                    : `Routed through deep water — ${interior.length} pin${interior.length > 1 ? 's' : ''} added, checking now`,
                            );
                            // Persist the decision + ratios (not null) so an
                            // on-water run gives ground truth to calibrate the
                            // NEAR_DIRECT_CAP / TIDE_ADOPT_FACTOR dials.
                            setAutoRouteDiag(diag);
                        } else {
                            // Engine returned the straight line — it can't see a
                            // better path even on 'safest'. Persist WHY.
                            setAutoRouteDiag(
                                `⚡ Engine kept the straight line (${prof}, ${pts.length} pts, ${res.distanceNM.toFixed(1)} NM). It sees no deeper detour it can reach — the shallow may sit in a coverage gap or between charts.`,
                            );
                        }
                    } else if (res && 'error' in res) {
                        // A coverage-gap that survived the Pi sync = the detail
                        // cell isn't on the Pi either, so it's genuinely uncharted.
                        setAutoRouteDiag(
                            res.code === 'coverage-gap'
                                ? `⚡ Still no detailed chart for part of this leg even after fetching — that stretch isn't charted to routing grade in the cloud set. Trace it by hand or drop a pin past the gap. (${res.error.slice(0, 60)})`
                                : `⚡ Engine couldn't route: ${res.error}`,
                        );
                    } else {
                        setAutoRouteDiag(
                            '⚡ Engine declined this leg (returned nothing) — usually no ENC chart coverage at one end, or over the 50 NM cap. Nothing changed.',
                        );
                    }
                } catch (err) {
                    log.warn(`auto-route failed: ${err instanceof Error ? err.message : String(err)}`);
                    setAutoRouteDiag(`⚡ Auto-route threw: ${err instanceof Error ? err.message : String(err)}`);
                } finally {
                    setFixBusyLeg(null);
                }
            })();
        }, 30);
    }, [capturedCoords, selectedPin, fixBusyLeg, settings.vessel, flashTraceFeedback]);

    // Safety depth driving the ENC day-palette bands + bold safety contour:
    // the vessel's real draft (feet→metres via vesselDraftMetres) plus the
    // tide margin. A grounding-risk line drawn against a fake draft is worse
    // than none, so this is the LIVE value, recomputed when the profile edits.
    const encSafetyDepthM = vesselDraftMetres(settings.vessel) + DEFAULT_TIDE_SAFETY_M;
    // The ROUTER's grounding threshold (draft×1.5 + UKC), from its OWN function
    // so the satellite glaze's caution band and the router can't drift apart
    // (cycle-5 re-audit: the [safety, hazard) band read GO-white yet routed as
    // a hazard). hazardDepthForDraft returns negative metres → magnitude here.
    const encHazardDepthM = Math.abs(hazardDepthForDraft(vesselDraftMetres(settings.vessel)));
    // THE departure window — computed when the report opens. (Below the
    // settings declaration: the dep array reads settings.vessel at render.)
    useEffect(() => {
        if (!showReport) return;
        setDepartureLabel(null);
        let stale = false;
        void commonDepartureWindowLabel(legVerdicts, vesselDraftMetres(settings.vessel), {
            departureMs,
            etaOffsetsMs: legEtaOffsetsMs,
        }).then((label) => {
            if (!stale) setDepartureLabel(label ?? '');
        });
        return () => {
            stale = true;
        };
    }, [showReport, legVerdicts, settings.vessel, departureMs, legEtaOffsetsMs]);
    // ── Community flywheel handlers (#38) ──
    // Consent share: first tap ARMS with the plain-english consent copy;
    // second tap submits. Explicit every time — never a background upload.
    const submitShare = useCallback(async () => {
        if (capturedCoords.length < 2) return;
        triggerHaptic('medium');
        const draftAssumed = !(Number(settings.vessel?.draft) > 0);
        const res = await submitTracedRoute(
            traceName,
            capturedCoords,
            draftAssumed ? null : vesselDraftMetres(settings.vessel),
        );
        setShareArmed(false);
        flashTraceFeedback(res.message);
    }, [capturedCoords, traceName, settings.vessel, flashTraceFeedback]);
    // Harbourmaster queue — RLS means non-owner accounts just see [].
    const refreshQueue = useCallback(async () => {
        setPendingRoutes(await listPendingRoutes());
    }, []);
    const handleReview = useCallback(
        async (id: string, verdict: 'approved' | 'rejected') => {
            triggerHaptic('medium');
            const ok = await reviewRoute(id, verdict);
            flashTraceFeedback(
                ok ? (verdict === 'approved' ? 'Published as a proven lane ✓' : 'Rejected') : 'Review failed — signal?',
            );
            if (ok) setPendingRoutes((prev) => prev.filter((r) => r.id !== id));
        },
        [flashTraceFeedback],
    );
    // Track→trace: a sailed voyage, decimated to editable pins and re-graded.
    // "Sail it once, save it forever."
    const openVoyagePicker = useCallback(async () => {
        triggerHaptic('light');
        setShowVoyagePicker((v) => !v);
        if (voyageTracks.length === 0) {
            // Summary-backed: sees the WHOLE history. The old path listed
            // groups from the newest-10k entry dump — Shane's 3 July ocean
            // passage aged out of that window in a week of auto-capture and
            // the picker could never show it (forensic query 2026-07-15).
            // Sea-only via the career roll-up's landFraction vote.
            setVoyageTracks(await fetchSeaVoyageChoices(6));
        }
    }, [voyageTracks.length]);
    const loadVoyageAsTrace = useCallback(
        async (t: SeaVoyageChoice) => {
            triggerHaptic('medium');
            flashTraceFeedback(`Loading ${t.label}…`);
            // Polyline fetched per-voyage on tap (paged, whole passage) —
            // the picker rows themselves carry no points now.
            const points = await loadVoyageTrackPoints(t.voyageId);
            if (points.length < 2) {
                flashTraceFeedback('Could not load that track — try again online');
                return;
            }
            let pins = rdpTracePoints(points, 30);
            // Cap at 80 pins — a 12-hour track at trawl speed can survive RDP
            // with hundreds of vertices; coarsen until it's editable.
            let eps = 30;
            while (pins.length > 80 && eps < 500) {
                eps *= 2;
                pins = rdpTracePoints(points, eps);
            }
            setShowVoyagePicker(false);
            rebaseHistoryRef.current = true; // wholesale load → new Undo floor
            setCapturedCoords(pins);
            const mid = pins[Math.floor(pins.length / 2)];
            mapRef.current?.flyTo({ center: [mid.lon, mid.lat], zoom: 11.5, duration: 1000 });
            flashTraceFeedback(`${t.label} loaded as ${pins.length} pins — re-checking it now`);
        },
        [flashTraceFeedback],
    );
    // ── Route Tracer validation (lives below the settings declaration —
    // the dep arrays read settings.vessel at render time) ──
    // Build/refresh the tracer context, then grade every leg. Rebuilds when a
    // pin lands outside the current grid's padded bbox OR the vessel draft
    // changed (a ctx keeps grading against the keel it was BUILT with —
    // adversarial-audit critical #1: edit draft 1.9→2.6 m and a green bar
    // crossing stayed green).
    useEffect(() => {
        setSailArmed(false); // a changed line always re-earns its "Sail anyway"
        // Ack indices die with the old leg list — but IDENTITY-PRESERVING:
        // an unconditional new Set() forced a full 7k-line MapHub render on
        // EVERY pin edit even when no acks existed (jank audit #4).
        setAckedLegs((s) => (s.size === 0 ? s : new Set()));
        setShareArmed(false); // consent never outlives the line it was given for
        if (!coordCaptureMode || capturedCoords.length === 0) {
            // Kill any in-flight grading pass — un-superseded, it would
            // resurrect the old trace's verdicts/status over Clear/Done.
            tracerSeqRef.current++;
            if (capturedCoords.length === 0) {
                setLegVerdicts([]);
                legCacheRef.current.clear();
                failVerdictsRef.current.clear();
            }
            return;
        }
        const draftNow = vesselDraftMetres(settings.vessel);
        const draftAssumed = !(Number(settings.vessel?.draft) > 0);
        const seq = ++tracerSeqRef.current;

        // Draft change invalidates EVERY cached verdict and tide label —
        // they were graded against the old keel (adversarial-audit critical
        // #1); keyed on the draft the CACHE saw, not on the ctx (Done nulls
        // the ctx but keeps the cache). Area growth does NOT invalidate:
        // chart data is static for the session, so a verdict graded in an
        // earlier window stays true forever.
        const prevDraft = gradedDraftRef.current;
        if (prevDraft && (prevDraft.d !== draftNow || prevDraft.assumed !== draftAssumed)) {
            tracerCtxRef.current = null;
            tracerCtxLruRef.current = []; // grids were built FOR the old keel
            legCacheRef.current.clear();
            tideSpotCacheRef.current.clear();
            setTideLabels({});
            tideReqRef.current.clear();
        }
        gradedDraftRef.current = { d: draftNow, assumed: draftAssumed };
        const cache = legCacheRef.current;
        if (!legCacheHydratedRef.current) {
            legCacheHydratedRef.current = true;
            // Same keel + same chart library ⇒ yesterday's verdicts are
            // today's verdicts; anything else returns null and we re-grade.
            const persisted = hydrateLegVerdicts(draftNow, draftAssumed, getEncRegistryVersion());
            if (persisted) for (const [k, v] of persisted) if (!cache.has(k)) cache.set(k, v);
        }
        // Failure verdicts retry every pass — a chart that appears
        // mid-session (Pi back in range, cloud sync) heals the legs.
        const failMap = failVerdictsRef.current;
        failMap.clear();

        const legs: Array<{ a: { lat: number; lon: number }; b: { lat: number; lon: number }; key: string }> = [];
        for (let i = 1; i < capturedCoords.length; i++) {
            legs.push({
                a: capturedCoords[i - 1],
                b: capturedCoords[i],
                key: legCacheKey(capturedCoords[i - 1], capturedCoords[i], i === capturedCoords.length - 1),
            });
        }
        const publish = (): void => {
            if (seq !== tracerSeqRef.current) return;
            // Identity-preserving: cache entries are stable objects, so an
            // element-wise match means NOTHING changed — return prev and no
            // re-render happens. Without this every publish minted a fresh
            // array, and each one cascaded into a full trace-line re-sync
            // (4× setData + chevron re-layout) + tide-label pass + panel
            // render — 3-5 wasted cycles per pin add (perf hunt 2026-07-15).
            const next = legs.map((l) => cache.get(l.key) ?? failMap.get(l.key) ?? null);
            setLegVerdicts((prev) =>
                prev.length === next.length && next.every((v, i) => v === prev[i]) ? prev : next,
            );
        };
        publish(); // cached legs render NOW; only truly new legs show "checking…"

        const pending = legs.filter((l) => !cache.has(l.key));
        if (pending.length === 0) {
            setTracerStatus('ready');
            return;
        }

        void (async () => {
            // Cluster the ungraded legs (in trace order) into span-bounded
            // build windows. The common cases — appended pin, nudged pin,
            // inserted pin — are ONE tiny cluster around the touched legs;
            // a loaded 60 km trace grades window-by-window with real depth
            // everywhere instead of a whole-trace marks-only bail.
            const clusters: Array<typeof pending> = [];
            let cur: typeof pending = [];
            for (const leg of pending) {
                const probe = [...cur, leg];
                if (
                    cur.length > 0 &&
                    bboxMaxSpanM(
                        traceBbox(
                            probe.flatMap((l) => [l.a, l.b]),
                            0,
                        ),
                    ) > TRACE_CLUSTER_SPAN_M
                ) {
                    clusters.push(cur);
                    cur = [leg];
                } else {
                    cur = probe;
                }
            }
            if (cur.length > 0) clusters.push(cur);

            const cautionVerdict = (message: string): TraceLegVerdict => ({
                grade: 'caution',
                issues: [{ severity: 'caution', message }],
                minDepthM: null,
                minAt: null,
                needsTide: false,
                nudge: null,
                nudgeTo: null,
            });
            let failStatus: 'toolarge' | 'nochart' | null = null;
            let sawMarksOnly = false;
            for (const cluster of clusters) {
                if (seq !== tracerSeqRef.current) return; // a newer pin superseded this pass
                const pts = cluster.flatMap((l) => [l.a, l.b]);
                // Reuse the held window only when it has a DEPTH GRID and the
                // cluster sits well inside it (~890 m margin — a gate mark's
                // pair partner sits up to a few hundred metres across the
                // channel; a fringe reuse once split a pair at the bbox edge
                // and downgraded a wrong-side DANGER to a solo caution). A
                // grid-less (marks-only) ctx is NEVER reused: its huge bbox
                // would stamp every short leg inside it "depth unchecked".
                let ctx = tracerCtxFromLru(pts);
                if (!ctx) {
                    setTracerStatus('loading');
                    try {
                        const built = await buildTracerContext(traceBboxPadded(pts), draftNow, { draftAssumed });
                        if (seq !== tracerSeqRef.current) return;
                        if (built.status === 'ready') {
                            ctx = built.ctx;
                            tracerCtxHold(built.ctx);
                        } else if (built.status === 'marksonly') {
                            // One genuinely long leg — grade marks with this
                            // ctx but DON'T hold it: a grid-less window must
                            // never shadow later clusters.
                            ctx = built.ctx;
                            sawMarksOnly = true;
                        } else if (built.status === 'toolarge') {
                            // Pure geometry (>80 km leg) — durable verdict;
                            // splitting the leg changes its key and re-grades.
                            failStatus = 'toolarge';
                            for (const l of cluster)
                                cache.set(l.key, cautionVerdict('depth unchecked — leg too long, drop a pin midway'));
                            publish();
                            continue;
                        } else {
                            // nochart can be a NETWORK BLIP (cloud cells not
                            // yet hydrated) — volatile verdict, retried every
                            // pass so charts appearing mid-session heal it.
                            failStatus = 'nochart';
                            for (const l of cluster)
                                failMap.set(l.key, cautionVerdict('no ENC chart here — depth unchecked'));
                            publish();
                            continue;
                        }
                    } catch (err) {
                        if (seq !== tracerSeqRef.current) return;
                        log.warn(`tracer context build failed: ${err instanceof Error ? err.message : String(err)}`);
                        failStatus = 'nochart';
                        for (const l of cluster)
                            failMap.set(l.key, cautionVerdict('chart load failed — depth unchecked, will retry'));
                        publish();
                        continue;
                    }
                }
                for (const l of cluster) {
                    cache.set(l.key, validateTraceLeg(l.a, l.b, ctx, { lastLeg: l.key.endsWith('|last') }));
                }
                publish();
            }
            if (seq !== tracerSeqRef.current) return;
            // Prune verdicts for legs no longer in the trace (bounded memory).
            const keep = new Set(legs.map((l) => l.key));
            for (const k of Array.from(cache.keys())) if (!keep.has(k)) cache.delete(k);
            // Failures outrank the held ctx in the strip — a half-graded
            // trace must not read "ready" while legs say "load failed".
            setTracerStatus(failStatus ?? (sawMarksOnly ? 'marksonly' : tracerCtxRef.current ? 'ready' : 'nochart'));
            // The pass is the unit of new knowledge — bank it so the NEXT
            // mount (reload, deploy, tab-bounce) re-grades nothing.
            persistLegVerdicts(cache, draftNow, draftAssumed, getEncRegistryVersion());
        })();
    }, [capturedCoords, coordCaptureMode, settings.vessel]);
    // Tide windows for sub-keel legs — async per shallow SPOT, cached by the
    // spot's position+depth (never by leg index: indices shift on insert/
    // delete, but the shallow patch itself doesn't move). Cached labels
    // re-attach synchronously after every re-grade, so a 30-pin trace
    // gaining pin 31 keeps its tide chips without a single WorldTides call;
    // the spot cache dies with the tracer context (draft/area change).
    useEffect(() => {
        if (!coordCaptureMode) return;
        const draftM = vesselDraftMetres(settings.vessel);
        const next: Record<number, string> = {};
        legVerdicts.forEach((v, i) => {
            if (!v || !v.needsTide || v.minDepthM === null || !v.minAt) return;
            // Window anchored at the leg's ARRIVAL (departure + transit), not
            // "now" — the crossing question is about when you're THERE. The
            // 30-min ETA bucket in the cache key re-fetches when the departure
            // (or the route ahead of this leg) moves the arrival materially.
            const fromMs = (departureMs ?? Date.now()) + (legEtaOffsetsMs[i] ?? 0);
            const spot = `${v.minAt.lat.toFixed(5)}|${v.minAt.lon.toFixed(5)}|${v.minDepthM}|t${Math.round(fromMs / 1_800_000)}`;
            const cached = tideSpotCacheRef.current.get(spot);
            if (cached) {
                next[i] = cached;
                return;
            }
            if (tideReqRef.current.has(spot)) return;
            tideReqRef.current.add(spot);
            void tideWindowLabelFor(v.minDepthM, draftM, v.minAt, fromMs).then((label) => {
                if (!label) {
                    // Fetch failed (offline) — release the spot so a later
                    // pass retries; the old design got free retries from
                    // context rebuilds, the windowed design does not.
                    tideReqRef.current.delete(spot);
                    return;
                }
                if (!tideReqRef.current.has(spot)) return;
                tideSpotCacheRef.current.set(spot, label);
                // Index is valid for the verdicts THIS run saw; if the legs
                // shifted mid-fetch, the next re-grade re-syncs from cache.
                setTideLabels((prev) => ({ ...prev, [i]: label }));
            });
        });
        // Identity-preserving, mirroring the legVerdicts publish (audit rank 3):
        // this effect fires on every grading publish, and the common case is
        // `next === {}` (no sub-keel legs). An unconditional setState bought one
        // guaranteed extra full-tree render per pin interaction — on the exact
        // "more waypoints = slower" path. Bail when the map is unchanged.
        setTideLabels((prev) => {
            const pk = Object.keys(prev);
            const nk = Object.keys(next);
            if (pk.length === nk.length && nk.every((k) => prev[k as never] === next[k as never])) return prev;
            return next;
        });
    }, [legVerdicts, coordCaptureMode, settings.vessel, departureMs, legEtaOffsetsMs]);

    const [isoProgress, setIsoProgress] = useState<{
        step: number;
        closestNM: number;
        totalDistNM?: number;
        elapsed?: number;
        frontSize?: number;
        phase?: string;
    } | null>(null);
    const [passageNotice, setPassageNotice] = useState<PassageNotice | null>(null);
    const [showConsensus, setShowConsensus] = useState(false);
    const [consensusData, setConsensusData] = useState<ConsensusMatrixData | null>(null);
    const playheadMarkerRef = useRef<mapboxgl.Marker | null>(null);

    // ── Weather Inspect Popup ──
    const [_inspectData, setInspectData] = useState<PointWeatherData | null>(null);
    const [_inspectLoading, setInspectLoading] = useState(false);
    const inspectPopupRef = useRef<mapboxgl.Popup | null>(null);
    const inspectRootRef = useRef<ReturnType<typeof createRoot> | null>(null);

    // Re-check pin view when navigating TO the map tab
    useEffect(() => {
        if (currentView === 'map') {
            const pv = window.__thalassaPinView;
            setIsPinView(!!pv);
        }
    }, [currentView]);

    // Listen for isochrone progress + completion events
    useEffect(() => {
        const onProgress = (e: Event) => {
            const d = (e as CustomEvent).detail;
            log.info('Isochrone progress:', d);
            if (d)
                setIsoProgress({
                    step: d.step,
                    closestNM: d.closestNM,
                    totalDistNM: d.totalDistNM,
                    elapsed: d.elapsed,
                    frontSize: d.frontSize,
                    phase: d.phase,
                });

            // ── Progressive route rendering ──
            // Draw the partial route as the wavefronts expand so the user
            // sees the line growing — use a separate preview source to avoid
            // wiping out the harbour leg features on 'route-line'.
            if (d?.partialRoute && d.partialRoute.length >= 2) {
                const map = mapRef.current;
                if (!map) return;
                // Lazily create preview source/layer
                if (!map.getSource('route-preview')) {
                    map.addSource('route-preview', {
                        type: 'geojson',
                        data: { type: 'FeatureCollection', features: [] },
                    });
                    map.addLayer({
                        id: 'route-preview-layer',
                        type: 'line',
                        source: 'route-preview',
                        layout: { 'line-join': 'round', 'line-cap': 'round' },
                        paint: {
                            'line-color': '#00e676',
                            'line-width': 2,
                            'line-opacity': 0.5,
                            'line-dasharray': [4, 4],
                        },
                    });
                }
                const src = map.getSource('route-preview') as mapboxgl.GeoJSONSource;
                if (src) {
                    src.setData({
                        type: 'FeatureCollection',
                        features: [
                            {
                                type: 'Feature',
                                properties: {},
                                geometry: {
                                    type: 'LineString',
                                    coordinates: d.partialRoute,
                                },
                            },
                        ],
                    });
                }
            }
        };
        const onComplete = () => {
            log.info('Isochrone complete — clearing progress');
            setIsoProgress(null);
            // Clean up the progressive preview layer
            const map = mapRef.current;
            if (map) {
                if (map.getLayer('route-preview-layer')) map.removeLayer('route-preview-layer');
                if (map.getSource('route-preview')) map.removeSource('route-preview');
            }
        };
        window.addEventListener('thalassa:isochrone-progress', onProgress);
        window.addEventListener('thalassa:isochrone-complete', onComplete);
        return () => {
            window.removeEventListener('thalassa:isochrone-progress', onProgress);
            window.removeEventListener('thalassa:isochrone-complete', onComplete);
        };
    }, []);

    // Passage notices — refusals, chart-gap rejections, too-short bails.
    // Field bug 2026-06-12: these outcomes were dispatched (or only
    // logged) with no listener, so the map stayed blank with zero
    // feedback — indistinguishable from a hang.
    useEffect(() => {
        const onNotice = (e: Event) => {
            setPassageNotice((e as CustomEvent).detail ?? null);
        };
        const onTooShort = (e: Event) => {
            const d = (e as CustomEvent).detail;
            setPassageNotice({
                severity: 'warn',
                title: `Route too short for passage planning (${d?.distanceNM ?? '?'} NM)`,
                message: d?.message ?? 'Try Community Routes for local harbour exits and coastal legs.',
            });
        };
        window.addEventListener('thalassa:passage-notice', onNotice);
        window.addEventListener('thalassa:passage-too-short', onTooShort);
        return () => {
            window.removeEventListener('thalassa:passage-notice', onNotice);
            window.removeEventListener('thalassa:passage-too-short', onTooShort);
        };
    }, []);

    // Listen for pin-drop-navigate events from DM chat
    useEffect(() => {
        const onPinDrop = (e: Event) => {
            const { lat, lon, label } = (e as CustomEvent).detail;
            if (!isFinite(lat) || !isFinite(lon)) return;

            // Request tab switch to map via global event
            window.dispatchEvent(new CustomEvent('thalassa:navigate-tab', { detail: { tab: 'map' } }));

            // Fly to the pin location (delay gives map tab time to render)
            setTimeout(() => {
                const map = mapRef.current;
                if (!map) return;

                map.flyTo({ center: [lon, lat], zoom: 14, duration: 1500 });

                // Drop a temporary pin marker
                const el = document.createElement('div');
                el.className = 'pin-drop-marker';
                const wrapper = document.createElement('div');
                wrapper.style.cssText =
                    'display:flex;flex-direction:column;align-items:center;animation:pinDropBounce 0.5s ease-out';
                const pin = document.createElement('span');
                pin.style.cssText = 'font-size:28px;filter:drop-shadow(0 2px 6px rgba(0,0,0,0.4))';
                pin.textContent = '📍';
                wrapper.appendChild(pin);
                const lbl = document.createElement('span');
                lbl.style.cssText =
                    'font-size:10px;color:#38bdf8;font-weight:700;background:rgba(0,0,0,0.6);padding:2px 8px;border-radius:8px;margin-top:2px;white-space:nowrap;max-width:150px;overflow:hidden;text-overflow:ellipsis';
                lbl.textContent = label;
                wrapper.appendChild(lbl);
                el.appendChild(wrapper);

                const mapboxgl = window.mapboxgl;
                if (mapboxgl?.Marker) {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const marker = new (mapboxgl as any).Marker({ element: el }).setLngLat([lon, lat]).addTo(map);

                    // Auto-remove after 10 seconds
                    setTimeout(() => {
                        try {
                            marker.remove();
                        } catch (e) {
                            console.warn('Suppressed:', e);
                            /* already removed */
                        }
                    }, 10_000);
                }
            }, 500);
        };

        window.addEventListener('pin-drop-navigate', onPinDrop);
        return () => window.removeEventListener('pin-drop-navigate', onPinDrop);
    }, []);

    const location = useLocationStore();
    const { weatherData, saveVoyagePlan } = useWeather();
    const weatherCoords = weatherData?.coordinates;
    const [mapReady, setMapReady] = useState(false);
    const deviceMode = useDeviceMode();
    // Map state persisted across Charts tab switches so the user comes
    // back to exactly what they left on. Time-critical overlays that
    // are meant to be session-only (cyclone / squall / weather inspect)
    // deliberately stay as plain useState.
    const [aisVisible, setAisVisible] = usePersistedState('thalassa_map_ais_visible', false);
    // ENC vector chart visibility — separate from cell *presence*. When the user
    // has imported cells we still let them toggle the chart off (e.g. to compare
    // with raster charts underneath). Default true so first import is visible.
    const [encVisible, setEncVisible] = usePersistedState('thalassa_map_enc_visible', true);
    // Chart-detail toggle. Default ON — the draft-aware depth shading IS the
    // product (flipped 2026-06-13; the 2026-05-17 "clean chart" preference
    // predates day-palette banding). When OFF: land + markers + hazards only.
    // Independent of `encVisible` — the master switch wins.
    // Key bumped _v2: usePersistedState eagerly writes the default on first
    // mount, so every pre-flip install had `false` persisted whether or not
    // the user ever touched the toggle — flipping the default alone would
    // no-op on existing devices. The bump resets everyone to ON once; new
    // toggles persist under the v2 key as usual.
    const [encChartDetail, setEncChartDetail] = usePersistedState('thalassa_map_enc_chart_detail_v2', true);
    // Live cell-count so the layer FAB shows the right "N cells imported" caption
    // and surfaces the toggle the moment the first cell lands.
    const [encCellCount, setEncCellCount] = useState(() => listEncCells().length);
    // Cloud-chart hydration progress — silent downloads read as "no
    // chart here" (2026-07-12 audit): the punter needs to know dark
    // water is a cell still on its way down, not a gap in coverage.
    const [encHydration, setEncHydration] = useState(() => getEncHydrationProgress());
    useEffect(() => subscribeToEncHydration(setEncHydration), []);
    // No-coverage affordance (2026-07-17 audit): browsing genuinely
    // UNCHARTED water at nav zoom was indistinguishable from having the
    // chart layer off — the dark shell told the punter nothing. When the
    // viewport escapes every imported cell's bbox at z11+, say so.
    const [encNoCoverage, setEncNoCoverage] = useState(false);
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady || !encVisible) {
            setEncNoCoverage(false);
            return;
        }
        const probe = (): void => {
            try {
                if (map.getZoom() < 11 || listEncCells().length === 0) {
                    setEncNoCoverage(false);
                    return;
                }
                const b = map.getBounds();
                if (!b) return;
                setEncNoCoverage(!encHasCoverageFor([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]));
            } catch {
                setEncNoCoverage(false);
            }
        };
        probe();
        map.on('moveend', probe);
        return () => {
            map.off('moveend', probe);
        };
    }, [mapReady, encVisible]);
    useEffect(() => {
        const refresh = () => {
            const cells = listEncCells();
            // Diagnostic — count only: joining all 172 cloud-cell ids
            // built a ~2.5 KB string per notify and flooded the console
            // during registration storms (2026-07-12 audit).
            console.warn(`[MapHub] encCellCount = ${cells.length}`);
            setEncCellCount(cells.length);
        };
        refresh();
        // Debounced: a 172-cell cloud registration fires one notify PER
        // CELL; refreshing synchronously each time was an O(n²) parse
        // burst on first signed-in boot.
        let t: number | null = null;
        const unsub = subscribeToEnc(() => {
            if (t !== null) window.clearTimeout(t);
            t = window.setTimeout(() => {
                t = null;
                refresh();
            }, 300);
        });
        return () => {
            if (t !== null) window.clearTimeout(t);
            unsub();
        };
    }, []);
    // One-shot import of any bundled sample cells the dev server is serving.
    // No-op once the localStorage flag is set or when real cells already exist.
    useEffect(() => {
        void bootstrapEncSamplesIfNeeded();
        // After the bundled NOAA demo lands, also check if the user's Bosun
        // Pi is reachable on local wifi and silently pull any AU/NZ/EU cells
        // they've decrypted there. Polling — runs immediately + every 10 min
        // while foregrounded so a user who buys a chart at the marina cafe
        // walks back to the boat and the cells flow in within a poll cycle.
        // Throttled to never hit the Pi more than once per 5 min.
        startAutoSyncPolling();
        // Web default = the white depth chart (Shane 2026-07-11: "show our
        // new layer as the default on our routing web page"). Cloud cells
        // used to register only when the tracer opened, so a signed-in
        // punter browsing thalassawx.app/plan saw a bare dark map until
        // they tapped Trace. Register at map mount instead — idempotent,
        // manifest-only (blobs still hydrate on demand), and quietly a
        // no-op when signed out (the private bucket refuses: licensing
        // gate stays). Native keeps its Pi-first ladder; a cloud
        // registration there is equally idempotent and covers boats
        // sailing without a Pi aboard.
        void import('../../services/enc/cloudCellSync')
            .then(({ registerCloudCells }) => registerCloudCells())
            .catch(() => {});
        // A punter who lands signed OUT and signs in on the page gets the
        // charts the moment auth flips — without needing to open the tracer.
        let unsubAuth: (() => void) | undefined;
        void import('../../services/supabase')
            .then(({ supabase }) => {
                if (!supabase) return;
                const { data } = supabase.auth.onAuthStateChange((event: string) => {
                    if (event !== 'SIGNED_IN') return;
                    void import('../../services/enc/cloudCellSync')
                        .then(({ registerCloudCells }) => registerCloudCells())
                        .catch(() => {});
                });
                unsubAuth = () => data.subscription.unsubscribe();
            })
            .catch(() => {});
        return () => unsubAuth?.();
    }, []);
    const [chokepointVisible, setChokepointVisible] = usePersistedState('thalassa_map_chokepoint_visible', false);
    const [cycloneVisible, setCycloneVisible] = useState(false);
    const [squallVisible, setSquallVisible] = useState(false);
    // Vessel tracking now defaults to TRUE so a new user always sees
    // their own boat on the chart from the first frame — without having
    // to discover the toggle in the radial menu. Existing users who
    // explicitly turned it off keep their preference (usePersistedState
    // reads localStorage first). Toggle still works to dim down to the
    // simpler GPS dot via useLocationDot.
    const [vesselTrackingVisible, setVesselTrackingVisible] = usePersistedState(
        'thalassa_map_vessel_tracking_visible',
        true,
    );
    const [seamarkVisible, setSeamarkVisible] = usePersistedState('thalassa_map_seamark_visible', false);
    const [anchorageVisible, setAnchorageVisible] = usePersistedState('thalassa_map_anchorage_visible', false);
    // Satellite BASE imagery (Esri World Imagery raster under every custom
    // layer — routes/seamarks/weather render on top). Owner ask 2026-07-03:
    // "satellite overlay instead of the enc overlay when running a route".
    // Key doubles as the init-time visibility read in useMapInit.
    // THE PURGE, final form (Shane 2026-07-11: "the app does not
    // automatically go to our new layer" — it must, ALWAYS): satellite is
    // SESSION-ONLY now, never persisted. Every boot is the white chart;
    // satellite is a peek you flip on when you want it (the Seaway-debug
    // lesson: state that shouldn't haunt doesn't persist). The effect
    // below mirrors the live value into localStorage purely for
    // EncVectorLayer's synchronous satelliteBaseOn() reads.
    // CHART-ONLY hard-off RETIRED (Shane 2026-07-12: "just missing the
    // sat overlay" — on the web chart, the day after asking for chart-
    // ONLY there): every surface keeps the session-only satellite peek.
    // DEFAULT BASE IS HYBRID NOW, every surface (Shane 2026-07-15:
    // "lets default to hybrid" — satellite-streets, the public-page
    // look, replaced plain satellite as the boot imagery). Offline
    // caveat that used to keep native on the white-chart boot still
    // exists (no tiles = dark under the glaze) but the Chart toggle is
    // one tap and the owner asked. Still never persisted — the toggle
    // owns it per session, so no state can haunt a later boot.
    // BOOT DEFAULT is SATELLITE (Shane 2026-07-19: "can we try the satellite
    // image as the default layer?"), replacing the clean-dark boot of 2026-07-17.
    // Worth knowing what this turns back on: satellite is imagery, so satOn is
    // true from the first frame and the chart boots with the FULL satellite ENC
    // treatment — white keel glaze, hidden land fills, amber safety contour —
    // rather than the dark ECDIS look. Still session-only, never persisted, so
    // it is a default and not a setting that can haunt a later boot.
    const [satelliteVisible, setSatelliteVisible] = useState(true);
    // Chart-declutter scrubber (Shane 2026-07-14): 0 = full chart, 6 =
    // near-bare. Session-only; encDetailScrubber owns which furniture
    // each step removes (safety layers are untouchable there).
    const [declutter, setDeclutter] = useState(0);
    // Hybrid base (Shane 2026-07-15): the PUBLIC voyage-page look —
    // satellite-streets, imagery with roads + names. Session-only,
    // mutually exclusive with satellite via the ChartModes setters, and
    // it gets the FULL satellite ENC treatment (glaze, hidden land
    // fills, bathy tint) via imageryOn below.
    // Hybrid boots OFF — SATELLITE is the boot base as of 2026-07-19 (see its
    // declaration above; the clean-dark boot of 2026-07-17 lasted two days).
    // The two imagery bases are mutually exclusive via the ChartModes setters,
    // so hybrid starting false is what lets satellite be the one that shows.
    // Both remain one tap away on the base toggle. Session-only.
    const [hybridVisibleRaw, setHybridVisible] = useState(false);
    // OCEAN BASE (Shane 2026-07-19: "we used to have one that had a bit of
    // bathymetry with it" → make it its own base). The MapTiler Ocean raster has
    // always existed, but only as a 0.45 tint ON TOP of satellite. As a BASE it
    // becomes the water itself: a bathymetric chart rather than a photograph.
    //
    // It counts as imagery below, which is the load-bearing part. imageryOn is
    // what gives ENC its translucent treatment — DEPARE drops to the glaze and
    // the opaque land fills stand down. Without that the 0.95-opaque DEPARE ramp
    // would paint straight over the bathymetry and the base would be invisible,
    // which is the whole reason for choosing it. Session-only, like the others.
    const [oceanBaseVisible, setOceanBaseVisible] = useState(false);
    // PER-SURFACE base (Shane 2026-07-17: "changing the layer on the chart page
    // also changed the planning page — I've lost all my zoom 10 whites in the
    // water"). The browsing chart and the plotting surface are the SAME map, so
    // one base state served both, and the clean-dark chart default silently
    // killed the whites on the plot surface: the white keel-clearance glaze
    // ("bright white = water that clears YOUR keel") is part of the SATELLITE
    // ENC treatment — syncDepareBaseTreatment paints the glaze only when satOn,
    // and zeroes its opacity otherwise.
    //
    // DERIVED, not a state-setting effect: an effect could be raced or undone
    // by the base-apply pass (which only re-paints the glaze when a visibility
    // actually changed). Deriving makes "plotting ⇒ imagery on" structurally
    // true — imageryOn can never be false while the tracer is up, so the glaze
    // always paints. Plain satellite still wins if the skipper picked it (also
    // imagery, so the glaze holds); the browsing chart keeps the clean dark.
    // Plotting forces hybrid ONLY when no other imagery base is already chosen —
    // ocean counts, or picking it would be silently overridden the moment the
    // tracer opened.
    const hybridVisible =
        coordCaptureMode && !satelliteVisible && !oceanBaseVisible ? true : hybridVisibleRaw;
    const imageryOn = satelliteVisible || hybridVisible || oceanBaseVisible;
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady) return;
        // Mirror for EncVectorLayer's sync reads — written BEFORE apply()
        // so the visibility writers see the same truth this render does.
        try {
            // Hybrid counts as satellite for every ENC treatment consumer
            // (glaze opacity, hide-lists) — it IS imagery underneath.
            localStorage.setItem(SATELLITE_KEY, imageryOn ? 'true' : 'false');
        } catch {
            /* storage unavailable — writers fall back to their default */
        }
        // Visibility write that no-ops when the layer is ALREADY at the
        // target — the loop-breaker. Every unconditional setLayoutProperty
        // emits a fresh `styledata`, which re-invokes this handler: with
        // satellite default-ON on web that was a self-perpetuating per-
        // frame storm (getStyle + 8 setters × 60 fps) that saturated the
        // main thread and froze zoom (Shane 2026-07-12: "locks up as I try
        // to zoom in"). A conditional write changes nothing at steady
        // state, so no new styledata is emitted and the loop dies.
        // Returns true when it actually wrote (i.e. the layer was NOT already
        // at the target) — the caller uses that to decide whether any heavier
        // re-assert is needed this pass.
        const setVis = (id: string, v: 'visible' | 'none'): boolean => {
            if (!map.getLayer(id)) return false;
            const cur = (map.getLayoutProperty(id, 'visibility') as string | undefined) ?? 'visible';
            if (cur === v) return false;
            map.setLayoutProperty(id, 'visibility', v);
            return true;
        };
        // `force` on the initial call + toggle; styledata re-asserts pass
        // false so the DEPARE glaze re-paint (encSyncDepareBaseTreatment,
        // which writes paint UNCONDITIONALLY and would keep the styledata
        // loop alive) only runs when something structural actually changed
        // this pass — otherwise steady state emits zero style mutations and
        // the loop dies (Shane 2026-07-12 "locks up as I try to zoom in").
        const apply = (force = false) => {
            try {
                let changed = force;
                // ONE style read shared by both base blocks (audit rank 4):
                // getStyle() serializes the whole ~150-250-layer stylesheet,
                // and both base layers always exist so both z-order heals
                // ran it every pass — a needless serialize + GC hit on every
                // styledata tick. Refreshed only if a (rare) heal actually
                // moves a layer, keeping the order honest for the 2nd block.
                let orderIds = map.getStyle()?.layers?.map((l) => l.id) ?? [];
                let encBottom = orderIds.find((id) => id.startsWith('enc-vec-'));
                const refreshOrder = () => {
                    orderIds = map.getStyle()?.layers?.map((l) => l.id) ?? [];
                    encBottom = orderIds.find((id) => id.startsWith('enc-vec-'));
                };
                // Hybrid base rides the same conditional-write rules as
                // satellite: visibility + self-healing z-order.
                if (map.getLayer('hybrid-base-layer')) {
                    if (setVis('hybrid-base-layer', hybridVisible ? 'visible' : 'none')) changed = true;
                    if (encBottom && orderIds.indexOf('hybrid-base-layer') > orderIds.indexOf(encBottom)) {
                        map.moveLayer('hybrid-base-layer', encBottom);
                        changed = true;
                        refreshOrder();
                    }
                }
                if (map.getLayer('satellite-base-layer')) {
                    if (setVis('satellite-base-layer', satelliteVisible ? 'visible' : 'none')) changed = true;
                    // Self-healing z-order: whatever race added the raster
                    // ABOVE the ENC stack (chart-mode swap vs async cell
                    // mount), push it back underneath — marks, lights and
                    // leads must always paint over the imagery.
                    if (encBottom && orderIds.indexOf('satellite-base-layer') > orderIds.indexOf(encBottom)) {
                        map.moveLayer('satellite-base-layer', encBottom);
                        changed = true;
                        refreshOrder();
                    }
                }
                // The opaque LAND fills sit ABOVE the satellite base and
                // blanket the imagery — satellite ON hides those. The DEPARE
                // ramp is different since 2026-07-11 ("our layer sitting on
                // top of the satellite layer"): it STAYS visible as a
                // depth-graded translucent glaze (deep = white wash, shallow
                // = the real sand banks glowing through the dirty tint) via
                // syncDepareBaseTreatment. Contours, coastline, soundings,
                // marks, routes and chips all render on the imagery.
                if (imageryOn) {
                    // Mirrors EncVectorLayer's SATELLITE_HIDE_LAYERS BY IMPORT,
                    // not by hand: land fills + charted coastline are chart
                    // furniture the imagery replaces (Shane 2026-07-11).
                    // Applies to BOTH imagery bases (satellite and hybrid).
                    //
                    // The hand-copy had DRIFTED. It still listed DEPCNT_SAFETY,
                    // which was deliberately dropped from the real list when
                    // syncDepareBaseTreatment started restyling that contour
                    // amber as the keel-limit line over imagery. So this loop
                    // was killing the very line that function paints every
                    // pass, and the two fought each other — on the plotting
                    // surface that cost the second depth channel on top of the
                    // glaze. Importing makes a future divergence impossible.
                    for (const id of ENC_SATELLITE_HIDE_LAYERS) {
                        if (setVis(id, 'none')) changed = true;
                    }
                    // Bathymetry OVER the imagery (Shane 2026-07-09: "can we
                    // have a bathymetry layer on top of the satellite") — the
                    // MapTiler ocean raster used to be hidden with the fills;
                    // now it stays on as a translucent depth tint so the water
                    // carries its contours while the imagery shows through.
                    if (setVis('maptiler-ocean-layer', 'visible')) changed = true;
                    // …but as the BASE it is the water, not a tint over one, so
                    // it has to drop UNDER the ENC stack. As an overlay it is
                    // deliberately inserted just below the labels, which leaves
                    // it ABOVE the depth bands and marks — fine when it is a
                    // wash over a photo, wrong when the chart is drawn on it.
                    if (oceanBaseVisible && map.getLayer('maptiler-ocean-layer')) {
                        if (encBottom && orderIds.indexOf('maptiler-ocean-layer') > orderIds.indexOf(encBottom)) {
                            map.moveLayer('maptiler-ocean-layer', encBottom);
                            changed = true;
                            refreshOrder();
                        }
                    }
                    // Only re-paint the DEPARE glaze when this pass actually
                    // changed layer state (a cell load hid a fresh fill, the
                    // z-order moved, or force). At steady state this is
                    // skipped, so no paint write → no styledata → loop dies.
                    if (changed) {
                        encSyncDepareBaseTreatment(map);
                        if (map.getLayer('maptiler-ocean-layer')) {
                            // 0.45 as a tint so the imagery beneath still reads;
                            // near-opaque as the base, where there is nothing
                            // underneath worth showing and the contours should be
                            // as legible as a paper bathymetric chart.
                            map.setPaintProperty(
                                'maptiler-ocean-layer',
                                'raster-opacity',
                                oceanBaseVisible ? 0.95 : 0.45,
                            );
                            // The tint is dimmed to sit under imagery; as the base
                            // it should render at its own contrast.
                            map.setPaintProperty(
                                'maptiler-ocean-layer',
                                'raster-brightness-max',
                                oceanBaseVisible ? 1 : 0.7,
                            );
                        }
                    }
                }
                // Declutter runs LAST so it has the final word on its
                // furniture after the visibility owners above have spoken —
                // EXCEPT where those owners have a stronger claim (ENC master
                // off, or imagery hiding an opaque land fill). Passing that
                // authority in stops the scrubber's restore side from fighting
                // them every pass, which with Hybrid-default was an ~8 Hz
                // background styledata loop over LNDARE_ISLET (audit rank 8).
                if (
                    applyChartDetailLevel(map, declutter, {
                        encMasterOff: !encVisible,
                        imageryHidden: imageryOn ? IMAGERY_SCRUB_OWNED : undefined,
                    })
                )
                    changed = true;
            } catch {
                /* style mid-swap — re-applied on the next styledata tick */
            }
        };
        apply(true);
        if (!imageryOn) {
            // Toggled OFF: hand the fills back to their owners (ENC master
            // toggle + chart-detail mode) instead of force-showing them —
            // forcing 'visible' here used to override a user's ENC-off/clean
            // chart state.
            try {
                if (map.getLayer('maptiler-ocean-layer')) {
                    // THE PURGE (2026-07-11): the raster bathy tint is
                    // satellite-mode furniture only. In chart mode the white
                    // ramp IS the water; uncovered water stays honestly dark.
                    map.setLayoutProperty('maptiler-ocean-layer', 'visibility', 'none');
                }
                encApplyLayerVisibility(map, encVisible);
                encApplyChartDetailLayers(map, encChartDetail);
            } catch {
                /* ENC layers not mounted yet — the mount path applies both */
            }
        }
        // ENC layers are (re)added asynchronously as cells load — re-assert
        // whenever the style gains layers so a late-added fill can't cover
        // the imagery. COALESCED (2026-07-12): a zoom fires a burst of
        // styledata (tile loads + the ENC setData), and running the full
        // apply — getStyle + the DEPARE treatment — on every one of them
        // pinned the main thread and froze zoom. A trailing timer collapses
        // each burst into ONE apply after it settles; z-order/visibility
        // heal ~one frame late, imperceptible, while the tick cost during
        // the zoom itself drops to nothing.
        let pending: number | null = null;
        const scheduleApply = () => {
            if (pending !== null) return;
            pending = window.setTimeout(() => {
                pending = null;
                apply();
            }, 120);
        };
        map.on('styledata', scheduleApply);
        return () => {
            if (pending !== null) window.clearTimeout(pending);
            map.off('styledata', scheduleApply);
        };
    }, [satelliteVisible, hybridVisible, oceanBaseVisible, imageryOn, declutter, mapReady, encVisible, encChartDetail]);
    // ── "Depth right now" — the live tide toggle (design 2026-07-11) ──
    // Charted depth + predicted tide, ONE offset applied at the paint
    // layer (band tints, sounding numbers, contour labels — see
    // setEncTideOffset). VISUAL ONLY by hard rule: the safety contour,
    // tracer and router keep grading against chart datum. Persisted:
    // the offset is re-read live on every boot, and the badge makes the
    // mode unmistakable, so stickiness is safe.
    const [tideDepthMode, setTideDepthMode] = usePersistedState('thalassa_tide_depth_mode', false);
    // Night dim — chartplotter-style red-tinted uniform dim (burn-down:
    // the white DEPARE ramp killed night vision at the helm).
    const [nightDim, setNightDim] = usePersistedState(ENC_NIGHT_DIM_KEY, false);
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady) return;
        try {
            setEncNightDim(map, nightDim);
        } catch {
            /* style mid-swap — the next mapReady pass reapplies */
        }
        // The dim div lives on document.body, so it leaks app-wide if MapHub
        // unmounts while ON (cycle-5 audit #5). This cleanup also runs on every
        // re-toggle (harmless: off-then-on nets to the correct state).
        return () => {
            const m = mapRef.current;
            if (!m) return;
            try {
                setEncNightDim(m, false);
            } catch {
                /* map/style torn down */
            }
        };
    }, [nightDim, mapReady]);
    const [tideOffsetInfo, setTideOffsetInfo] = useState<TideOffsetRead | null>(null);
    const [showTideAck, setShowTideAck] = useState(false);
    /** Scrubber position in QUARTER-HOURS AHEAD of now, 0 = live now
     *  (2026-07-11 #3: drag through the day, watch the banks flood and
     *  dry, park it on your ETA). RELATIVE, not an absolute instant — an
     *  absolute scrub drifted into the past and the thumb crept as time
     *  passed (review major). A ref mirrors it for async closures. */
    const [tideScrubQ, setTideScrubQ] = useState(0);
    const tideScrubRef = useRef(0);
    const tideCurveRef = useRef<TideCurveWindow | null>(null);
    /** The instant the scrub currently points at (null = live). */
    const scrubInstant = (q: number): number | null => (q > 0 ? Date.now() + q * 900_000 : null);
    const onToggleTideDepth = useCallback(() => {
        triggerHaptic('light');
        if (!tideDepthMode) {
            let acked = false;
            try {
                acked = !!localStorage.getItem(TIDE_ACK_KEY);
            } catch {
                /* storage unavailable — show the sheet every time, honest default */
            }
            if (!acked) {
                setShowTideAck(true);
                return;
            }
        }
        setTideDepthMode(!tideDepthMode);
    }, [tideDepthMode, setTideDepthMode]);
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady) return;
        if (!tideDepthMode) {
            setEncTideOffset(map, null);
            setTideOffsetInfo(null);
            setTideScrubQ(0);
            tideCurveRef.current = null;
            return;
        }
        let cancelled = false;
        let lastFix: { lat: number; lon: number } | null = null;
        const applyAtScrub = (): void => {
            const curve = tideCurveRef.current;
            const atMs = tideScrubRef.current > 0 ? Date.now() + tideScrubRef.current * 900_000 : null;
            const read = curve ? tideReadAt(curve, atMs ?? Date.now()) : null;
            setTideOffsetInfo(read);
            // Fail-safe: no curve / off the curve → chart datum, badge says
            // so. The scrub instant rides along so the tap-the-water popup
            // can never present a scrubbed tide as "right now".
            setEncTideOffset(map, read ? read.offsetM : null, atMs);
        };
        const refresh = async (): Promise<void> => {
            const c = map.getCenter();
            lastFix = { lat: c.lat, lon: c.lng };
            const curve = await readTideCurveWindow(c.lat, c.lng);
            if (cancelled) return;
            if (curve) {
                tideCurveRef.current = curve;
            } else {
                // Fetch failed — KEEP a still-valid curve for the same
                // waters (review major: a blip mid-scrub silently dropped
                // the chart to datum); drop it only when it's for
                // somewhere else or has expired.
                const old = tideCurveRef.current;
                const stillGood =
                    old &&
                    Math.abs(c.lat - old.fix.lat) <= 0.2 &&
                    Math.abs(c.lng - old.fix.lon) <= 0.2 &&
                    Date.now() < old.rangeMs[1];
                if (!stillGood) tideCurveRef.current = null;
            }
            applyAtScrub();
        };
        void refresh();
        // Tide moves ~1–2 cm/min at worst — 5 min keeps the live read
        // within a freeboard of truth without hammering the API (and
        // re-samples the curve at the scrub position either way).
        const iv = window.setInterval(() => void refresh(), 5 * 60_000);
        const onMoveEnd = (): void => {
            const c = map.getCenter();
            if (!lastFix) return;
            // ~0.2° ≈ 12–20 NM — far enough that a different station
            // governs; small pans keep the current read.
            if (Math.abs(c.lat - lastFix.lat) > 0.2 || Math.abs(c.lng - lastFix.lon) > 0.2) {
                void refresh();
            }
        };
        map.on('moveend', onMoveEnd);
        return () => {
            cancelled = true;
            window.clearInterval(iv);
            map.off('moveend', onMoveEnd);
            setEncTideOffset(map, null);
        };
    }, [tideDepthMode, mapReady]);
    // Scrub moves re-sample the already-fetched curve — no network, no
    // rebuild. THROTTLED trailing-edge (2026-07-12 audit): the sounding
    // and contour-label text-fields are LAYOUT properties, so every
    // quarter-hour detent forced Mapbox to re-shape + re-collision-place
    // every visible label. Dragging dawn-to-dusk over a z13 sounding
    // field fired dozens of full symbol re-layouts; ~150 ms pacing keeps
    // the flooding-banks feel while the worker breathes. The final detent
    // always lands (trailing timer).
    const tideScrubAppliedAtRef = useRef(0);
    useEffect(() => {
        tideScrubRef.current = tideScrubQ;
        if (!tideDepthMode || !mapReady) return;
        const map = mapRef.current;
        if (!map) return;
        const apply = () => {
            tideScrubAppliedAtRef.current = Date.now();
            const curve = tideCurveRef.current;
            const atMs = scrubInstant(tideScrubRef.current);
            const read = curve ? tideReadAt(curve, atMs ?? Date.now()) : null;
            setTideOffsetInfo(read);
            setEncTideOffset(map, read ? read.offsetM : null, atMs);
        };
        const since = Date.now() - tideScrubAppliedAtRef.current;
        if (since >= 150) {
            apply();
            return;
        }
        const t = window.setTimeout(apply, 150 - since);
        return () => window.clearTimeout(t);
    }, [tideScrubQ, tideDepthMode, mapReady]);
    // Keel-honesty flag for the tap-the-water popup — a verdict against
    // the 2.5 m fallback draft must say so (mirrors the tracer).
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady) return;
        setEncDraftAssumed(map, !(Number(settings.vessel?.draft) > 0));
    }, [settings.vessel, mapReady]);
    // Popups stay LIVE while plotting (Shane 2026-07-16: "tap a marker for
    // its info without closing the tracer"). Placement is the LONG PRESS now,
    // so a tap is free to inspect — the old suppression dated from tap-to-
    // place. Picker + weather-inspect still own taps outright (they place /
    // sample), so they keep suppressing. Per-map flag.
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady) return;
        setEncPopupSuppression(map, pickerMode || weatherInspectMode);
        return () => setEncPopupSuppression(map, false);
    }, [pickerMode, weatherInspectMode, mapReady]);
    // ── THE PURGE (Shane 2026-07-11: "full purge of all layers, except
    // our new one... speed is the key") ──
    // One-shot per device: the first main-surface mount strips the whole
    // weather/overlay stack so the WHITE CHART is simply what the app
    // looks like. Every toggle still exists in the ChartModes chip — this
    // resets the default, it doesn't remove capability.
    useEffect(() => {
        if (embedded || pickerMode || isPinView) return;
        try {
            if (localStorage.getItem('thalassa_purge_lean_v1')) return;
            localStorage.setItem('thalassa_purge_lean_v1', new Date().toISOString());
        } catch {
            return; // no storage — skip rather than clobber on every mount
        }
        for (const layer of Array.from(weather.activeLayers as Set<string>)) {
            weather.toggleLayer(layer as never);
        }
        setAisVisible(false);
        setLightningVisible(false);
        setCycloneVisible(false);
        setSquallVisible(false);
        setChokepointVisible(false);
        setTideStationsVisible(false);
        setSeamarkVisible(false);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    // ── Chart key (the legend for mere mortals, 2026-07-11) ──
    // Auto-opens ONCE when charted water first renders (punters don't
    // know khaki means "dries" or what LAT is); after that it lives
    // behind the ChartModes row. Session state + a seen-flag.
    const [chartKeyOpen, setChartKeyOpen] = useState(false);
    useEffect(() => {
        // encVisible gate (review minor): never auto-open (or burn the
        // one-shot flag) over a map that isn't showing the chart.
        if (encCellCount === 0 || !encVisible || embedded || pickerMode || isPinView) return;
        try {
            if (!localStorage.getItem('thalassa_chart_key_seen_v1')) {
                localStorage.setItem('thalassa_chart_key_seen_v1', new Date().toISOString());
                setChartKeyOpen(true);
            }
        } catch {
            /* private mode — no auto-open, row still works */
        }
    }, [encCellCount, encVisible, embedded, pickerMode, isPinView]);
    // Declutter: collapse the bottom weather cluster (model selector + scrubber + legend) behind a pop-out.
    const [chartControlsHidden, setChartControlsHidden] = usePersistedState(
        'thalassa_map_chart_controls_hidden',
        false,
    );
    const [tideStationsVisible, setTideStationsVisible] = usePersistedState(
        'thalassa_map_tide_stations_visible',
        false,
    );
    const [lightningVisible, setLightningVisible] = usePersistedState('thalassa_map_lightning_visible', false);
    // Seaway Graph debug overlay (masterplan Stage IV Phase 10) — gates/
    // edges compiled from installed ENC cells. Per-device flag, never
    // SESSION-ONLY, deliberately NOT persisted (2026-07-10, second offence):
    // this debug overlay got stuck ON across restarts in June (key bumped
    // _v2 to reset it) and AGAIN in July — sky-blue graph edges + numbered
    // node pins zigzagging between the Newport channel marks, haunting
    // every screenshot ("we STILL have our spaghetti routes"). A dev
    // overlay must never outlive the session that turned it on. The toggle
    // (Charts → modes gear → "Seaway Graph") still works for a debugging
    // session; a restart always starts clean.
    const [seawayDebugVisible, setSeawayDebugVisible] = useState(false);
    const [skChartIds, setSkChartIds] = usePersistedStringSet('thalassa_map_sk_chart_ids');
    const [skChartOpacity, setSkChartOpacity] = usePersistedState('thalassa_map_sk_chart_opacity', 0.7);
    const [localChartIds, setLocalChartIds] = usePersistedStringSet('thalassa_map_local_chart_ids');
    const [localChartOpacity, setLocalChartOpacity] = usePersistedState('thalassa_map_local_chart_opacity', 0.7);

    // Charts start hidden — user enables them via the Charts layer toggle.
    // AvNavService still discovers available charts in the background so
    // the layer menu can list them, but nothing renders until toggled on.

    const [closestStorm, setClosestStorm] = useState<ActiveCyclone | null>(null);
    const [allCyclones, setAllCyclones] = useState<ActiveCyclone[]>([]);
    const skipAutoFlyRef = useRef(false);
    // Storm picker modal — opens when the user taps Storms in the radial menu
    // AND there are multiple active cyclones to choose from.
    const [stormPickerOpen, setStormPickerOpen] = useState(false);
    const [layerSettingsOpen, setLayerSettingsOpen] = useState(false);
    /** One-time toast surfaced when PerfGuardian downtiered the device
     *  on the previous session. Cleared on dismiss / first render. */
    const [perfToast, setPerfToast] = useState<boolean>(() => consumePerfDowntierToast());
    /** Currently-displayed planned route on the chart. Null when none.
     *  Independent from the active follow-route — these come from saved
     *  ship-log entries, not the live voyage system. */
    const [activeChartRoute, setActiveChartRoute] = useState<RouteOrTrack | null>(null);
    /** Currently-displayed recorded track on the chart. Null when none. */
    const [activeChartTrack, setActiveChartTrack] = useState<RouteOrTrack | null>(null);
    const [routePickerOpen, setRoutePickerOpen] = useState(false);
    const [trackPickerOpen, setTrackPickerOpen] = useState(false);

    /** Active Voyage Mode flag — mirrored from the voyages cache. When
     *  true, the chart auto-displays the boat's GPS position, the live
     *  voyage track, and the planned route, regardless of which weather
     *  layer is on. Listens for `thalassa:active-voyage-changed` so the
     *  flag flips the moment Cast Off / End Voyage runs. */
    const [activeVoyageMode, setActiveVoyageMode] = useState<boolean>(() => {
        try {
            const raw = localStorage.getItem('thalassa_active_voyage');
            if (!raw) return false;
            const parsed = JSON.parse(raw);
            return parsed?.status === 'active';
        } catch {
            return false;
        }
    });
    const [activeVoyageId, setActiveVoyageId] = useState<string | null>(() => {
        try {
            const raw = localStorage.getItem('thalassa_active_voyage');
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            return parsed?.status === 'active' ? (parsed.id as string) : null;
        } catch {
            return null;
        }
    });
    const [activeVoyageName, setActiveVoyageName] = useState<string | null>(() => {
        try {
            const raw = localStorage.getItem('thalassa_active_voyage');
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            return parsed?.status === 'active' ? (parsed.voyage_name as string) : null;
        } catch {
            return null;
        }
    });
    useEffect(() => {
        const sync = () => {
            try {
                const raw = localStorage.getItem('thalassa_active_voyage');
                const v = raw ? JSON.parse(raw) : null;
                const isActive = v?.status === 'active';
                setActiveVoyageMode(isActive);
                setActiveVoyageId(isActive ? (v.id as string) : null);
                setActiveVoyageName(isActive ? (v.voyage_name as string) : null);
            } catch {
                setActiveVoyageMode(false);
                setActiveVoyageId(null);
                setActiveVoyageName(null);
            }
        };
        window.addEventListener('thalassa:active-voyage-changed', sync);
        return () => window.removeEventListener('thalassa:active-voyage-changed', sync);
    }, []);

    /** Vessel position + trail are FORCED visible during Active Voyage
     *  Mode, regardless of the user's persisted toggle. The user can
     *  still toggle off in normal mode; toggling off mid-voyage is a
     *  no-op for the actual rendering (the underlying preference is
     *  preserved for when the voyage ends). */
    const effectiveVesselTrackingVisible = vesselTrackingVisible || activeVoyageMode;

    /** Auto-select the active voyage's planned route + sailed track on
     *  the chart so the skipper sees "I am here, I came from there, I'm
     *  heading there" from one glance — no manual route/track picking
     *  required while underway. Match planned route by normalised name
     *  (matches the same scheme CrewManagement uses); match track by
     *  voyage.id (ShipLogService.startTracking seeds entries.voyageId
     *  with the voyages-table UUID at Cast Off time). */
    useEffect(() => {
        if (!activeVoyageMode || !activeVoyageId) return;
        let cancelled = false;
        // FULL fetch — matches the planned route by name (routes need the
        // whole list) AND seeds the sailed track. Runs on mount and when a
        // save/delete fires the change event; NOT on the 60s tick (the plan
        // is fixed for the voyage, so re-listing every route every minute
        // was pure waste — audit rank 7).
        const syncRouteAndTrack = async () => {
            try {
                const { fetchRoutesAndTracks } = await import('../../services/shiplog/RoutesAndTracks');
                const { routes, tracks } = await fetchRoutesAndTracks(true);
                if (cancelled) return;
                const norm = (s: string) => s.trim().toLowerCase();
                if (activeVoyageName) {
                    const wantLabel = norm(activeVoyageName);
                    const matchedRoute = routes.find((r) => norm(r.label) === wantLabel) ?? null;
                    if (matchedRoute) setActiveChartRoute((cur) => (cur?.id === matchedRoute.id ? cur : matchedRoute));
                }
                const matchedTrack = tracks.find((t) => t.id === activeVoyageId) ?? null;
                if (matchedTrack) {
                    setActiveChartTrack((cur) =>
                        cur?.id === matchedTrack.id && cur.points.length === matchedTrack.points.length
                            ? cur
                            : matchedTrack,
                    );
                }
            } catch (e) {
                log.warn('Active voyage auto-select failed:', e);
            }
        };
        // INCREMENTAL trail refresh — fetches ONLY the active voyage's
        // entries (bounded by that one passage), not the whole log. Replaces
        // the rendered track only when it actually GREW (point count changed),
        // so the trail genuinely extends AND unchanged ticks cost no re-render.
        const refreshTrail = async () => {
            try {
                const { fetchVoyageAsTrack } = await import('../../services/shiplog/RoutesAndTracks');
                const track = await fetchVoyageAsTrack(activeVoyageId);
                if (cancelled || !track) return;
                setActiveChartTrack((cur) =>
                    cur?.id === track.id && cur.points.length === track.points.length ? cur : track,
                );
            } catch (e) {
                log.warn('Active voyage trail refresh failed:', e);
            }
        };
        void syncRouteAndTrack();

        const onRefresh = () => void syncRouteAndTrack();
        window.addEventListener('thalassa:routes-and-tracks-changed', onRefresh);
        // Extend the trail as new GPS points come in — one voyage's fetch,
        // not the career's.
        const t = setInterval(() => void refreshTrail(), 60_000);
        return () => {
            cancelled = true;
            window.removeEventListener('thalassa:routes-and-tracks-changed', onRefresh);
            clearInterval(t);
        };
    }, [activeVoyageMode, activeVoyageId, activeVoyageName]);

    // Start the silent FPS watchdog when the chart screen mounts. It
    // runs essentially free (one rAF callback) and writes to
    // localStorage when sustained FPS goes below 35 — the next launch
    // picks up the lower tier automatically.
    useEffect(() => {
        PerfGuardian.start();
        return () => PerfGuardian.stop();
    }, []);

    // Clear the perf-toast flag a beat after the toast's own auto-
    // dismiss so we don't keep re-rendering it across mount/remount.
    useEffect(() => {
        if (!perfToast) return;
        const t = setTimeout(() => setPerfToast(false), 6500);
        return () => clearTimeout(t);
    }, [perfToast]);

    // Fetch all active cyclones for the storm picker menu (runs regardless of layer visibility)
    // Dynamic import — CycloneTrackingService is large and only needed after map loads
    useEffect(() => {
        let cancelled = false;
        const load = async () => {
            try {
                const { fetchActiveCyclones } = await import('../../services/weather/CycloneTrackingService');
                const cyclones = await fetchActiveCyclones();
                if (!cancelled) setAllCyclones(cyclones);
            } catch (e) {
                console.warn('Suppressed:', e);
                /* non-critical */
            }
        };
        load();
        const timer = setInterval(load, 30 * 60 * 1000);
        return () => {
            cancelled = true;
            clearInterval(timer);
        };
    }, []);

    // Ref for weather layer toggle (populated after weather hook runs)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const weatherRef = useRef<{ toggleLayer: (k: any) => void; activeLayers: Set<any> } | null>(null);

    // Handle storm selection from the picker menu
    const handleSelectStorm = useCallback(
        (storm: ActiveCyclone) => {
            // Signal useCycloneLayer to skip its auto-fly on the next load.
            // We handle the flyTo here to the user-selected storm.
            skipAutoFlyRef.current = true;
            if (!cycloneVisible) setCycloneVisible(true);
            setSquallVisible(false); // Mutually exclusive with squall
            setClosestStorm(storm);
            const map = mapRef.current;
            if (map) {
                map.flyTo({
                    center: [storm.currentPosition.lon, storm.currentPosition.lat],
                    zoom: 4,
                    duration: 2000,
                    essential: true,
                });
            }
        },
        [mapRef, cycloneVisible],
    );

    // ── Passage Planner ──
    const passage = usePassagePlanner(mapRef, mapReady);

    // ── Course frame: resolve From/To typed in the tracer panel ──
    // parseLocation handles ports, buoys, and hand-typed GPS coords (the
    // full planner chain), biased to the current chart view so "Newport"
    // means the one on screen. Success flies to the origin at marina zoom
    // — the punter starts plotting where his boat actually is.
    const setCourseFrame = useCallback(async () => {
        const from = fromQuery.trim();
        const to = toQuery.trim();
        if (frameBusy || !from || !to) return;
        setFrameBusy(true);
        triggerHaptic('light');
        try {
            const { parseLocation } = await import('../../services/weather/api/geocoding');
            const map = mapRef.current;
            const near = map ? { lat: map.getCenter().lat, lon: map.getCenter().lng } : undefined;
            const o = await parseLocation(from, near);
            const d = await parseLocation(to, { lat: o.lat, lon: o.lon });
            setTraceOrigin({ lat: o.lat, lon: o.lon, name: o.name });
            setTraceDest({ lat: d.lat, lon: d.lon, name: d.name });
            mapRef.current?.flyTo({ center: [o.lon, o.lat], zoom: 14.5, duration: 1400 });
            // Geocoder sanity flash — "Mooloolaba Marina" once matched
            // Marina del Rey, California (proximity bias lost to the word
            // "Marina"). Don't block a genuine ocean passage; just make a
            // wrong-hemisphere match impossible to miss.
            const toRad = (x: number): number => (x * Math.PI) / 180;
            const dLat = toRad(d.lat - o.lat);
            const dLon = toRad(d.lon - o.lon);
            const a =
                Math.sin(dLat / 2) ** 2 + Math.cos(toRad(o.lat)) * Math.cos(toRad(d.lat)) * Math.sin(dLon / 2) ** 2;
            const nmApart = 3440.065 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
            flashTraceFeedback(
                nmApart > 1500
                    ? `Heads up — "${d.name}" is ${Math.round(nmApart).toLocaleString()} NM away. Wrong match? ✕ the course and retype.`
                    : `Plot your way out of ${o.name} — ⚡ Auto takes the open water any time`,
            );
        } catch (err) {
            flashTraceFeedback(
                `Couldn't find that — try "27.4698S 153.0251E" (${err instanceof Error ? err.message.slice(0, 40) : 'lookup failed'})`,
            );
        } finally {
            setFrameBusy(false);
        }
    }, [fromQuery, toQuery, frameBusy, flashTraceFeedback]);

    const clearCourseFrame = useCallback(() => {
        setTraceOrigin(null);
        setTraceDest(null);
        setFromQuery('');
        setToQuery('');
        setCourseChip(null);
    }, []);

    // ── Guided builder: "⚡ Auto to destination" ──
    // The punter traces the fiddly bits (marina, bar, river — where local
    // knowledge beats the algorithm); one tap hands the OPEN WATER to the
    // four-tier router (where it's proven). The engine polyline comes back
    // as PINS (RDP-decimated to the bends) so the whole route stays ONE
    // editable, re-gradable trace — drag/insert/delete the arrival end like
    // any pin. An OFFER, never a takeover (masterplan prime directive).
    // The tracer's own course frame outranks the old planner's arrival;
    // with a frame set and NO pins yet, ⚡ routes the lot from the origin
    // ("he can run the entire route without our help" — and the inverse).
    const autoCompleteTrace = useCallback(async () => {
        const start = capturedCoords[capturedCoords.length - 1] ?? traceOrigin;
        if (autoBusy || !start) return;
        const dest = traceDest ?? passage.arrival;
        if (!dest) {
            flashTraceFeedback('Type a destination up top first');
            return;
        }
        setAutoBusy(true);
        triggerHaptic('medium');
        flashTraceFeedback('Routing the open water…');
        try {
            const res = await tryInshoreRoute(
                { lat: start.lat, lon: start.lon },
                { lat: dest.lat, lon: dest.lon },
                vesselDraftMetres(settings.vessel),
            );
            if (res && 'polyline' in res) {
                const pts = res.polyline.map(([lon, lat]) => ({ lat, lon }));
                // 40 m tolerance keeps every bend the engine chose while a
                // 60-vertex line becomes ~15-25 editable pins, not pin soup.
                const sparse = rdpTracePoints(pts, 40);
                // With pins down, sparse[0] duplicates the last pin — drop
                // it. Frame-only (zero pins) keeps the origin as pin #1.
                const add = capturedCoords.length > 0 ? sparse.slice(1) : sparse;
                if (add.length > 0) {
                    setCapturedCoords((prev) => [...prev, ...add]);
                    // First-leg heading off the polyline itself — correct in
                    // both modes (pins: last pin → first new; frame-only:
                    // origin → first bend).
                    const brg = bearingDegBetween(sparse[0], sparse[1] ?? dest);
                    setCourseChip(
                        `${courseArrow(brg)} head ${String(Math.round(brg)).padStart(3, '0')}° — ${
                            dest.name || 'destination'
                        } ${res.distanceNM.toFixed(res.distanceNM >= 10 ? 0 : 1)} NM`,
                    );
                    // Fly to the ARRIVAL end for "take her in" review — most
                    // routes end in a marina and that end needs eyes on it.
                    mapRef.current?.flyTo({ center: [dest.lon, dest.lat], zoom: 13.5, duration: 1400 });
                    flashTraceFeedback('Auto-routed — check the arrival end, drag pins to adjust');
                } else {
                    flashTraceFeedback('Already at the destination');
                }
            } else if (res && 'error' in res) {
                flashTraceFeedback(`Router: ${res.error.slice(0, 70)}`);
            } else {
                flashTraceFeedback('No auto route from here (too far or no charts) — keep tracing');
            }
        } catch (err) {
            log.warn(`auto-complete failed: ${err instanceof Error ? err.message : String(err)}`);
            flashTraceFeedback('Auto-route failed — keep tracing');
        } finally {
            setAutoBusy(false);
        }
    }, [autoBusy, capturedCoords, traceOrigin, traceDest, passage.arrival, settings.vessel, flashTraceFeedback]);

    // Follow Route overlay — renders the followed planned route on the map
    // Suppressed during passage planning to avoid visual conflict
    // (both use dashed sky-blue lines, causing confusion), and while the
    // TRACER is open (Shane 2026-07-09 "remove all of the spaghetti":
    // saved routes, sailed tracks, follow-route and dest flag were all
    // painting over the marks he was trying to thread — the tracer's
    // chart is for the trace and the marks, nothing else).
    useFollowRouteMapbox(mapRef, mapReady && !passage.showPassage && !coordCaptureMode);

    // Destination flag — pulsing green flag at the active voyage's
    // destination, with a live distance + bearing chip from the user's
    // current GPS. Hidden when no voyage is active. Sits on top of the
    // follow-route line so the user gets the full "I am here, going
    // there" picture from one glance at the chart.
    useDestinationFlag(mapRef, mapReady && !passage.showPassage && !coordCaptureMode);

    // Routes (planned) and Tracks (sailed) chart layers. Both come
    // from the user's ship-log entries — Routes are voyageIds prefixed
    // `planned_*`, Tracks are everything else. Each is its own layer
    // so the user can have one of each visible simultaneously, with
    // distinct colours so they read clearly when overlapped. Hidden
    // while tracing — same declutter rule as above.
    useRouteTrackLayer({
        mapRef,
        mapReady: mapReady && !passage.showPassage && !coordCaptureMode,
        variant: 'route',
        selected: activeChartRoute,
    });
    useRouteTrackLayer({
        mapRef,
        mapReady: mapReady && !passage.showPassage && !coordCaptureMode,
        variant: 'track',
        selected: activeChartTrack,
    });

    // ── Cyclone Tracking Layer ──
    useCycloneLayer(
        mapRef,
        mapReady,
        cycloneVisible,
        location.lat,
        location.lon,
        setClosestStorm,
        skipAutoFlyRef,
        closestStorm,
        // Wire marker clicks to the same handler the picker modal uses —
        // so tapping a storm on the chart does the same thing as tapping
        // its row in the picker (fly + highlight + close any overlay).
        handleSelectStorm,
    );

    // ── Rain Squall Map (GMGSI IR with BD Enhancement Curve) ──
    useSquallMap(mapRef, mapReady, squallVisible, location.lat, location.lon, allCyclones, handleSelectStorm);

    // ── Cyclone zoom center-lock — keep selected storm dead-center during zoom ──
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady || !cycloneVisible || !closestStorm) return;

        const onZoomEnd = () => {
            const storm = closestStorm;
            if (!storm) return;
            map.easeTo({
                center: [storm.currentPosition.lon, storm.currentPosition.lat],
                duration: 300,
            });
        };
        map.on('zoomend', onZoomEnd);
        return () => {
            map.off('zoomend', onZoomEnd);
        };
    }, [cycloneVisible, closestStorm, mapReady, mapRef]);

    // Clear isochrone progress when route completes
    useEffect(() => {
        if (passage.isoResultRef.current) setIsoProgress(null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [passage.routeAnalysis]);

    // Generate consensus data when route completes
    // Dynamic import — ConsensusMatrixEngine is heavy computation, only needed post-route
    useEffect(() => {
        const isoResult = passage.isoResultRef.current;
        if (!isoResult || !passage.routeAnalysis) {
            setConsensusData(null);
            return;
        }
        const windGrid = WindStore.getState().grid;
        if (!windGrid) return;

        (async () => {
            try {
                const { generateConsensusMatrix } = await import('../../services/ConsensusMatrixEngine');
                const data = await generateConsensusMatrix(
                    isoResult,
                    windGrid,
                    passage.departureTime || new Date().toISOString(),
                    undefined,
                    6,
                );
                setConsensusData(data);
            } catch (err) {
                log.warn('[Consensus] Failed to generate matrix:', err);
            }
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [passage.routeAnalysis, passage.departureTime]);

    // Route-sync playhead marker
    const handleScrubPosition = useCallback((lat: number, lon: number) => {
        const map = mapRef.current;
        if (!map) return;

        if (!playheadMarkerRef.current) {
            const el = document.createElement('div');
            el.style.cssText = `
                width: 20px; height: 20px;
                background: linear-gradient(135deg, #38bdf8, #a78bfa);
                border: 3px solid #fff;
                border-radius: 50%;
                box-shadow: 0 0 16px rgba(56,189,248,0.5), 0 4px 12px rgba(0,0,0,0.3);
                transition: opacity 0.2s;
            `;
            playheadMarkerRef.current = new mapboxgl.Marker({ element: el, anchor: 'center' })
                .setLngLat([lon, lat])
                .addTo(map);
        } else {
            playheadMarkerRef.current.setLngLat([lon, lat]);
        }
    }, []);

    // Clean up playhead when consensus closes
    useEffect(() => {
        if (!showConsensus && playheadMarkerRef.current) {
            playheadMarkerRef.current.remove();
            playheadMarkerRef.current = null;
        }
    }, [showConsensus]);

    // ── Weather-inspect popup (tap gesture, inspect mode only) ──
    // Hoisted out of the handler map so onMapTap stays a thin router now
    // that placement moved to onMapLongPress.
    const showWeatherInspect = (lat: number, lon: number): void => {
        const map = mapRef.current;
        if (!map) return;
        // Close any existing inspect popup
        if (inspectPopupRef.current) {
            inspectPopupRef.current.remove();
            inspectPopupRef.current = null;
        }
        if (inspectRootRef.current) {
            inspectRootRef.current.unmount();
            inspectRootRef.current = null;
        }

        const container = document.createElement('div');
        container.style.minWidth = '240px';
        const root = createRoot(container);
        inspectRootRef.current = root;

        setInspectData(null);
        setInspectLoading(true);

        const closePopup = () => {
            if (inspectPopupRef.current) {
                inspectPopupRef.current.remove();
                inspectPopupRef.current = null;
            }
            if (inspectRootRef.current) {
                inspectRootRef.current.unmount();
                inspectRootRef.current = null;
            }
            setInspectData(null);
            setInspectLoading(false);
        };

        getWeatherInspectPopup().then((WIP) => {
            root.render(<WIP data={null} loading={true} onClose={closePopup} />);
        });

        const popup = new mapboxgl.Popup({
            closeButton: false,
            closeOnClick: true,
            className: 'weather-inspect-popup',
            maxWidth: '300px',
            offset: 8,
        })
            .setLngLat([lon, lat])
            .setDOMContent(container)
            .addTo(map);

        inspectPopupRef.current = popup;
        popup.on('close', () => {
            if (inspectRootRef.current) {
                inspectRootRef.current.unmount();
                inspectRootRef.current = null;
            }
            inspectPopupRef.current = null;
            setInspectData(null);
            setInspectLoading(false);
        });

        import('../../services/weather/pointWeather')
            .then(({ fetchPointWeather }) => fetchPointWeather(lat, lon))
            .then((data) => {
                if (!inspectPopupRef.current) return; // popup was closed
                setInspectData(data);
                setInspectLoading(false);
                getWeatherInspectPopup().then((WIP) => {
                    root.render(<WIP data={data} loading={false} onClose={closePopup} />);
                });
            })
            .catch(() => {
                setInspectLoading(false);
            });
    };

    // ── Map Init ──
    const { dropPin } = useMapInit({
        containerRef,
        mapRef,
        pinMarkerRef,
        locationDotRef,
        mapboxToken,
        mapStyle,
        initialZoom,
        minimalLabels,
        embedded,
        center,
        location,
        initialCenter: weatherCoords ? { lat: weatherCoords.lat, lon: weatherCoords.lon } : undefined,
        onLocationSelect,
        pickerMode,
        settingPoint: passage.settingPoint,
        showPassage: passage.showPassage,
        departure: passage.departure,
        arrival: passage.arrival,
        setMapReady,
        setActiveLayer: (layer: string) => {
            if (layer !== 'none') {
                setSquallVisible(false);
                setCycloneVisible(false);
            }
            weather.setActiveLayer(layer as import('./mapConstants').WeatherLayer);
        },
        setDeparture: passage.setDeparture,
        setArrival: passage.setArrival,
        setSettingPoint: passage.setSettingPoint,
        weatherInspect: weatherInspectMode,
        coordCapture: coordCaptureMode,
        onMapTap: (lat: number, lon: number) => {
            const map = mapRef.current;
            if (!map) return;

            // Tracer active + armed: taps no longer place — placement is
            // the LONG PRESS (Shane 2026-07-15), so a stray tap mid-pan
            // can't seed a phantom pin. A tap on a mark/light/water now
            // shows its ENC popup (Shane 2026-07-16: "tap a marker for its
            // info without closing the tracer"); we only COACH when the tap
            // hit nothing to inspect, so the popup isn't buried under a flash.
            if (coordCaptureRef.current && plotArmedRef.current) {
                if (!encHasClickableFeatureAt(map, { lat, lng: lon })) {
                    flashTraceFeedback('Hold the chart to drop a pin');
                }
                return;
            }

            // Only show weather popup if the user explicitly enabled inspect mode
            if (!weatherInspectMode) return;
            // Weather inspect — stays active so the user can tap multiple
            // locations; they disable via the layer FAB menu.
            showWeatherInspect(lat, lon);
        },
        onMapLongPress: (lat: number, lon: number) => {
            const map = mapRef.current;
            if (!map) return;

            // Route Tracer owns the LONG PRESS when active AND ARMED —
            // record the fix (snapped off the breakwater if the fat finger
            // just missed the water), splice it mid-trace when an insert is
            // armed. PAUSED plotting (Shane 2026-07-11: "great when you
            // want it, and fucken annoying when you don't") hands the
            // gesture back to the chart.
            if (coordCaptureRef.current && plotArmedRef.current) {
                // The release-click after this placement must NOT open a
                // feature popup where the pin just landed (popups are live
                // while plotting now).
                encSuppressNextClickPopup(map);
                let pt = { lat, lon };
                const ctx = tracerCtxRef.current;
                if (ctx) {
                    // Lead first (Shane 2026-07-17: "shove it directly on top
                    // of the lead — very hard with fat fingers"): a pin within
                    // ~120 m of a charted transit means "on the lead", and the
                    // lead IS navigable water, so the water snap is moot.
                    const onLead = snapTraceTapToLead(ctx, pt);
                    if (onLead) {
                        pt = onLead;
                        flashTraceFeedback('Snapped onto the lead 🎯');
                    } else {
                        const snapped = snapTraceTapToWater(ctx, pt);
                        if (snapped) {
                            pt = snapped;
                            flashTraceFeedback('Snapped to water');
                        }
                    }
                }
                if (map.getZoom() < 13) {
                    flashTraceFeedback('Zoomed out — pins are rough, zoom in for channel work');
                }
                const after = insertAfterRef.current;
                if (after !== null) {
                    insertAfterRef.current = null;
                    setInsertAfter(null);
                    setSelectedPin(null);
                    setCapturedCoords((prev) => [...prev.slice(0, after + 1), pt, ...prev.slice(after + 1)]);
                    triggerHaptic('light');
                    return;
                }
                // Tap ON the line → insert into that leg (Shane 2026-07-09:
                // "we need to be able to insert a waypoint along the track").
                // Screen-space distance so it feels identical at every zoom;
                // 16 px ≈ the edge of a fingertip. The middle 80% of the leg
                // only — taps near an endpoint belong to the pin's own
                // tap/drag affordance (40 px hit-slop), not a mid-leg splice.
                // The leg test uses the RAW tap position; the inserted pin is
                // the water-snapped one.
                let insertLeg = -1;
                {
                    const tapPx = map.project([lon, lat]);
                    let bestD = 16;
                    for (let i = 1; i < capturedCoords.length; i++) {
                        const a = map.project([capturedCoords[i - 1].lon, capturedCoords[i - 1].lat]);
                        const b = map.project([capturedCoords[i].lon, capturedCoords[i].lat]);
                        const dx = b.x - a.x;
                        const dy = b.y - a.y;
                        const len2 = dx * dx + dy * dy;
                        const t = len2 > 0 ? ((tapPx.x - a.x) * dx + (tapPx.y - a.y) * dy) / len2 : 0;
                        if (t < 0.1 || t > 0.9) continue;
                        const d = Math.hypot(a.x + t * dx - tapPx.x, a.y + t * dy - tapPx.y);
                        if (d < bestD) {
                            bestD = d;
                            insertLeg = i;
                        }
                    }
                }
                if (insertLeg > 0) {
                    setCapturedCoords((prev) => [...prev.slice(0, insertLeg), pt, ...prev.slice(insertLeg)]);
                    flashTraceFeedback(`Inserted between ${insertLeg} and ${insertLeg + 1} — drag to fine-tune`);
                } else {
                    setCapturedCoords((prev) => [...prev, pt]);
                }
                // Medium, not light: the hold earned a firmer thunk than
                // the old tap ever gave.
                triggerHaptic('medium');
            }
        },
    });

    // ── Location Dot (basic fallback — disabled when vessel tracker is active) ──
    useLocationDot(mapRef, locationDotRef, mapReady && !effectiveVesselTrackingVisible);

    // ── Fly to the selected weather location when it arrives / changes ──
    // `initialCenter` on useMapInit sets the mount-time centre, but when the
    // weather data is still loading from cache it's undefined and the map
    // falls back to live GPS. This effect fills that gap: as soon as
    // weatherCoords is available — and any time it changes afterwards — we
    // recentre on the selected location. User-driven pans don't change
    // weatherCoords, so their pan sticks.
    //
    // First centre jumps instantly at ZOOM 10 — the golden size (Shane
    // 2026-07-16: every nav mark visible, local water fills the screen). This
    // effect fires right after boot, so it must agree with useMapInit's
    // GOLDEN_BOOT_ZOOM or it silently clobbers it (the "zoom is not working"
    // bug: it jumped back out to the Aus+NZ fit). Subsequent centres preserve
    // the user's current zoom so we don't yank them out of a harbour view.
    const GOLDEN_BOOT_ZOOM = 10;
    const lastFlownCoordsRef = useRef<{ lat: number; lon: number } | null>(null);
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady) return;
        if (embedded || pickerMode || passage.showPassage || isPinView) return;
        if (!weatherCoords) return;

        const last = lastFlownCoordsRef.current;
        if (last && Math.abs(last.lat - weatherCoords.lat) < 1e-6 && Math.abs(last.lon - weatherCoords.lon) < 1e-6) {
            return;
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ausNzFitZoom = (map as any).__ausNzMinZoom ?? map.getMinZoom();
        const isFirst = last === null;
        map.jumpTo({
            center: [weatherCoords.lon, weatherCoords.lat],
            zoom: isFirst ? GOLDEN_BOOT_ZOOM : Math.max(map.getZoom(), ausNzFitZoom),
        });
        if (!isFirst) {
            map.easeTo({ center: [weatherCoords.lon, weatherCoords.lat], duration: 600 });
        }
        lastFlownCoordsRef.current = { lat: weatherCoords.lat, lon: weatherCoords.lon };
    }, [
        mapReady,
        weatherCoords?.lat,
        weatherCoords?.lon,
        embedded,
        pickerMode,
        passage.showPassage,
        isPinView,
        weatherCoords,
    ]);

    // ── Auto-cache tiles around the user when a Pi is in play ──
    // When the boat has a Pi on the network AND the user has a strong
    // internet connection, silently download a 1000 NM tiered shell of
    // raster tiles around the user so the map keeps working the moment
    // they drop offline. Tier breakdown lives in MapOfflineService:
    //   1000 NM @ z4-7   (ocean-wide)
    //   500 NM  @ z8-9   (regional)
    //   150 NM  @ z10-11 (coastal approach)
    //   40 NM   @ z12-13 (harbour detail)
    //
    // Conditions for firing:
    //   - Pi is reachable (piCache.isAvailable())
    //   - Connection quality is 'high' (WiFi / good 4G — NOT cellular
    //     2G/3G, NOT satellite, NOT save-data mode). User explicitly
    //     asked for "only if they have a strong connection".
    //   - User has a valid weatherCoords
    //   - User has moved > 100 NM since the last auto-cache (tracked
    //     in localStorage by MapOfflineService)
    //   - Pi's SQLite cache isn't already gigantic (>10 GB)
    //
    // Re-evaluates on three triggers — Pi appearing, connection
    // improving to 'high', or location changing — so a phone that
    // started on weak cellular and later joined a marina WiFi will
    // pick up the cache automatically without the user having to do
    // anything. No prompts, no confirmations.
    const autoCacheRanRef = useRef(false);
    useEffect(() => {
        if (embedded || pickerMode || isPinView) return;
        if (!weatherCoords) return;
        if (autoCacheRanRef.current) return;

        let cancelled = false;
        const ctrl = new AbortController();
        const tryRun = async () => {
            if (!piCache.isAvailable()) return; // wait for Pi
            // Connection-quality gate — only auto-cache when the user
            // actually has the bandwidth to spare. Strong = WiFi or
            // 4G+ with > 0.5 Mbps downlink + saveData off. Weak = 2G,
            // 3G with low downlink, satellite, or saveData enabled.
            const conn = getConnectionState();
            if (conn.quality !== 'high') {
                log.info(
                    `Auto-cache: skipping — connection quality '${conn.quality}' (type=${conn.type}, downlink=${conn.effectiveDownlink}). Will retry when it improves.`,
                );
                return;
            }
            autoCacheRanRef.current = true;
            const outcome = await MapOfflineService.autoDownloadAroundUser({
                centerLat: weatherCoords.lat,
                centerLon: weatherCoords.lon,
                signal: ctrl.signal,
                // Toast progress callback removed — Shane found the
                // "Auto-caching 1000 NM…" + "Pi cached N tiles…"
                // toasts unannounced/distracting on the Charts page.
                // The cache fills silently in the background; if the
                // user wants to verify, the Pi cache status badge in
                // settings shows tile counts.
                onProgress: () => {},
            });
            if (cancelled) return;
            if (outcome.status === 'error') {
                // Reset the guard so a later weatherCoords change can retry.
                autoCacheRanRef.current = false;
                log.warn('Auto-cache failed:', outcome.message);
            } else if (outcome.status === 'skipped') {
                // Skipped for a legitimate reason (no Pi, not moved, cache full) —
                // don't toast the user, but leave the guard open so Pi arriving
                // later or movement over the threshold can still kick it off.
                autoCacheRanRef.current = false;
                log.info('Auto-cache skipped:', outcome.reason);
            }
        };

        // Run once now, then subscribe so we fire the moment EITHER
        //   (a) the Pi is found, or
        //   (b) the connection upgrades to high quality
        // — whichever was the missing condition the first time.
        tryRun();
        const unsubPi = piCache.onStatusChange(() => {
            if (!autoCacheRanRef.current && piCache.isAvailable()) tryRun();
        });
        const unsubConn = onConnectionChange((state) => {
            if (!autoCacheRanRef.current && state.quality === 'high' && piCache.isAvailable()) {
                log.info(`Auto-cache: connection upgraded to high (${state.type}) — kicking off`);
                tryRun();
            }
        });

        return () => {
            cancelled = true;
            ctrl.abort();
            unsubPi();
            unsubConn();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [weatherCoords?.lat, weatherCoords?.lon, embedded, pickerMode, isPinView]);

    // ── GPS Vessel Tracker Layer ──
    const { flyToVessel } = useVesselTracker(mapRef, mapReady, effectiveVesselTrackingVisible);

    // ── Picker Mode ──
    usePickerMode(mapRef, pinMarkerRef, pickerMode, onLocationSelect);

    // Route Nudge removed — see import note above.

    // ── Weather Layers ──
    const weather = useWeatherLayers(mapRef, mapReady, embedded, location);
    weatherRef.current = weather;

    // ── Clear weather layers + Follow Route when passage mode activates ──
    const prevShowPassageRef = useRef(passage.showPassage);
    useEffect(() => {
        if (passage.showPassage && !prevShowPassageRef.current) {
            weather.setActiveLayer('none');
            // The 2026-07-05 owner-ask ("show the route on the clean
            // satellite base, not the busy ENC chart") force-switched to
            // imagery on EVERY passage — the ghost behind "the old sat map
            // keeps coming back" all day (2026-07-11). SUPERSEDED by the
            // purge: the white chart IS the route surface now, on every
            // platform. Satellite remains a manual peek where allowed.
            // Force-remove Follow Route layers — the hook's useEffect cleanup
            // has a timing gap when mapReady transitions while routeCoords changes
            const map = mapRef.current;
            if (map) {
                const FR_LAYERS = [
                    'follow-route-markers-labels',
                    'follow-route-markers-circle',
                    'follow-route-active-line',
                    'follow-route-previous-line',
                ];
                const FR_SOURCES = ['follow-route-active', 'follow-route-previous', 'follow-route-markers'];
                for (const id of FR_LAYERS) {
                    if (map.getLayer(id)) map.removeLayer(id);
                }
                for (const id of FR_SOURCES) {
                    if (map.getSource(id)) map.removeSource(id);
                }
            }
        }
        prevShowPassageRef.current = passage.showPassage;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [passage.showPassage]);

    // ── Cyclone-aware temporal snap — REMOVED ──
    // Previously this scanned all GFS forecast hours to find the vortex center
    // closest to the ATCF position and overrode the wind scrubber. However, this
    // always biased toward hour-0 (model initialization) which showed wind data
    // 5-6 hours in the past. The time-based "now" index already produces correct
    // wind alignment with the tracked cyclone position.

    // ── Embedded Rain (also loads as background on full-map velocity mode) ──
    const _embRain = useEmbeddedRain(mapRef, embedded, mapReady, false);

    // ── AIS Vessel Target Layer ──
    useAisLayer(mapRef, mapReady, aisVisible);
    useAisStreamLayer(mapReady ? mapRef.current : null, aisVisible);

    // ── Chokepoint Tracker ──
    useChokepointLayer(mapReady ? mapRef.current : null, chokepointVisible);

    // ── Signal K Nautical Charts ──
    const skCharts = useAvNavCharts(mapRef, mapReady, skChartIds, skChartOpacity);

    // ── Free Chart Catalog (NOAA, LINZ) ──
    const chartCatalog = useChartCatalog(mapRef, mapReady);

    // ── Local MBTiles Charts (on-phone, no AvNav needed) ──
    const localCharts = useLocalCharts(mapRef, mapReady, localChartIds, localChartOpacity);

    // ── Offline OSM raster fallback — renders when offline, invisible when online ──
    useOfflineBaseLayer(mapRef, mapReady, isOnline);
    const chartsActive = skChartIds.size > 0 || chartCatalog.hasEnabledCharts || localChartIds.size > 0;
    // ENC vector chart actually rendering — master toggle ON and at least one
    // cell imported. Drives the same "another chart source draws its own
    // navaids" switch-offs as `chartsActive` (OSM raster icons + full-mode
    // seamark symbols) so the ENC IALA icons don't render doubled. v1 is a
    // global toggle: panning outside ENC coverage with cells loaded shows no
    // OSM seamarks there — accepted; a bbox-aware gate can come with the
    // coverage layer's cell bboxes later.
    const encActive = encVisible && encCellCount > 0;

    // ── Single-select chart picker ──
    // Only one nautical chart layer visible at a time across all three kinds
    // (AvNav / free catalog / on-phone MBTiles). Clicking the currently-on
    // chart turns it off (empty state is allowed). Clicking any other chart
    // turns that one on, turns everything else off, and flies the camera
    // to the new chart's coverage.
    const selectChartExclusive = useCallback(
        (kind: 'sk' | 'catalog' | 'local', id: string) => {
            const isSkOn = kind === 'sk' && skChartIds.has(id);
            const isLocalOn = kind === 'local' && localChartIds.has(id);
            const catalogSrc = kind === 'catalog' ? chartCatalog.sources.find((s) => s.id === id) : undefined;
            const isCatalogOn = !!catalogSrc?.enabled;
            const turningOff = isSkOn || isLocalOn || isCatalogOn;

            if (turningOff) {
                // Toggle off the one they tapped; leave the (already-empty) other buckets alone.
                if (kind === 'sk') {
                    setSkChartIds((prev) => {
                        const next = new Set(prev);
                        next.delete(id);
                        return next;
                    });
                } else if (kind === 'local') {
                    setLocalChartIds((prev) => {
                        const next = new Set(prev);
                        next.delete(id);
                        return next;
                    });
                } else if (catalogSrc) {
                    chartCatalog.toggleSource(catalogSrc.id);
                }
                return;
            }

            // Turning on → wipe every other chart, enable just this one.
            setSkChartIds(kind === 'sk' ? new Set([id]) : new Set());
            setLocalChartIds(kind === 'local' ? new Set([id]) : new Set());
            chartCatalog.disableAll();
            if (kind === 'catalog' && catalogSrc) {
                chartCatalog.toggleSource(catalogSrc.id); // flips off → on
            }

            // Fly the camera so the user sees their selection.
            if (kind === 'sk') {
                const chart = skCharts.availableCharts.find((c) => c.id === id);
                if (chart) skCharts.flyToChart(chart);
            } else if (kind === 'local') {
                const chart = localCharts.availableCharts.find((c) => c.fileName === id);
                if (chart) localCharts.flyToChart(chart);
            } else if (catalogSrc) {
                chartCatalog.flyToSource(catalogSrc);
            }
        },
        [skChartIds, localChartIds, chartCatalog, skCharts, localCharts],
    );

    // ── Interactive Sea Marks (OpenSeaMap / Overpass API) ──
    // When o-charts or the ENC vector chart render their own navaids:
    //   'identify' mode (invisible hit targets, still click-to-identify)
    // When no charts: 'full' mode (renders IALA icons + click-to-identify)
    const seamarkMode = chartsActive || encActive ? ('identify' as const) : ('full' as const);
    const seamark = useSeamarkLayer(mapRef, mapReady, seamarkVisible, seamarkMode);

    // ── Tide Station Markers ──
    const tideStations = useTideStationLayer(mapRef, mapReady, tideStationsVisible);
    useAnchorageLayer(mapRef, mapReady, anchorageVisible);

    // ── Notices to Mariners + low bridges on the chart (📄 / 🌉 tap-to-read) ──
    // Curated standing notices (MSQ-class, e.g. Mooloolah River bar); broadcast
    // NAVAREA warnings viewport-scoped at zoom ≥ 6; plus the curated low-bridge
    // clearances (this one hook owns BOTH — its `visible` flag gates the lot).
    // PLOTTING-ONLY (Shane 2026-07-17: "remove the bridges and the notice to
    // mariners from the chart page, not the plan page"): they're passage-
    // planning furniture, so they ride with the tracer and leave the browsing
    // chart clean.
    useNoticeLayer(mapRef, mapReady, coordCaptureMode);

    // ── Lightning Strikes (Xweather GLD360) ──
    useLightningLayer(mapRef, mapReady, lightningVisible);

    // ── Ocean Currents (CMEMS via Mapbox raster-particle) ──
    // Gated by VITE_CMEMS_CURRENTS_ENABLED. When the flag is off the hook
    // no-ops and the existing Xweather raster-currents tile layer renders
    // instead (managed by useWeatherLayers via the 'currents' WeatherLayer).
    const currentsVisible = weather.activeLayers.has('currents');
    useOceanCurrentParticleLayer(mapRef, mapReady, currentsVisible, weather.currentsHour);

    // ── Ocean Waves (CMEMS WAM forecast via the particle-layer engine) ──
    // Same pattern as currents: gated by VITE_CMEMS_WAVES_ENABLED, pulls
    // from /api/waves, replaces the Xweather wave-height raster when the
    // flag is on. Waves use their own scrubber step (3-hourly, 17 frames)
    // separate from currents' 13-hourly.
    const wavesVisible = weather.activeLayers.has('waves');
    useOceanWaveParticleLayer(mapRef, mapReady, wavesVisible, weather.wavesHour);

    // ── Sea-surface temperature (CMEMS daily P1D-m raster heatmap) ──
    // Scalar field — no particles. Gated by VITE_CMEMS_SST_ENABLED.
    // 5-day forecast, daily cadence = 5 scrubber steps.
    const sstVisible = weather.activeLayers.has('sst');
    useSstRasterLayer(mapRef, mapReady, sstVisible, weather.sstStep);

    // ── Chlorophyll (CMEMS BGC daily raster heatmap) ──
    // Scalar field like SST. Net-new — no Xweather fallback. Gated by
    // VITE_CMEMS_CHL_ENABLED. Daily cadence, 5-day forecast.
    const chlVisible = weather.activeLayers.has('chl');
    useChlRasterLayer(mapRef, mapReady, chlVisible, weather.chlStep);

    // ── Sea-ice concentration (CMEMS physics daily raster heatmap) ──
    // Scalar field. Polar-only by definition (shader discards <15%).
    // Net-new — unlocks high-latitude routing (Baltic winter, Alaska,
    // Svalbard, Antarctic). Gated by VITE_CMEMS_SEAICE_ENABLED.
    const seaiceVisible = weather.activeLayers.has('seaice');
    useSeaIceRasterLayer(mapRef, mapReady, seaiceVisible, weather.seaiceStep);

    // ── Mixed-layer depth (CMEMS physics daily raster heatmap) ──
    // Scalar field log-encoded over [1m, 1000m]. Plasma ramp.
    // Niche — relevant to thermocline-tracking deep-sea fishers and
    // ocean modellers. Gated by VITE_CMEMS_MLD_ENABLED.
    const mldVisible = weather.activeLayers.has('mld');
    useMldRasterLayer(mapRef, mapReady, mldVisible, weather.mldStep);

    // ── Marine Protected Areas (CAPAD GeoJSON overlay) ──
    // Independent toggle — co-exists with any weather layer because
    // "where can I fish?" is orthogonal to "what's the weather doing?".
    // Gated by VITE_MPA_ENABLED.
    useMpaLayer(mapRef, mapReady, weather.mpaVisible);

    // ── ENC Chart Coverage (dashed bbox overview) ──
    // ENC coverage overlay RETIRED from auto-mount (Shane 2026-07-12:
    // "rid ourselves of those blue dotted lines that are everywhere").
    // The always-on CATZOC-coloured cell outlines were "highest-value
    // feedback" when a punter owned 1-10 cells; with the full 172-cell
    // library registered they grid the ENTIRE coast in dashed sky-blue
    // rectangles. The chart itself now carries the coverage message
    // (white ramp = charted, dark shell = not). EncCoverageLayer +
    // useEncCoverageLayer were DELETED 2026-07-12 (audit: dead since
    // the grid retirement, drifting from live conventions) — git
    // history has them if a diagnostics
    // toggle.

    // ── ENC Vector Chart Display ──
    // The real chart — surveyed depth contours (DEPARE),
    // coastlines (COALNE), tan land (LNDARE), and magenta
    // obstruction/wreck/rock symbols. Depth-graduated blues so
    // the user can read shoals at a glance. Mounts at zoom 7+
    // (lower zooms get the dashed coverage overlay above).
    useEncVectorLayer(mapRef, mapReady, encVisible, encChartDetail, encSafetyDepthM, encHazardDepthM);
    // Tracer WYSIWYG (Shane 2026-07-09 "show markers, leads, laterals
    // and cardinals"): while tracing, every mark the grader checks
    // must be ON SCREEN — laterals, cardinals, specials, lights and
    // the RECTRC leads — even if the punter has flipped the ENC
    // master toggle off or a mode hid them. styledata re-asserts
    // because cell loads re-add layers asynchronously; on exit,
    // visibility goes back to the master toggle + chart-detail owners.
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady || !coordCaptureMode) return;
        const MARK_LAYERS = [
            ENC_VEC_LAYERS.BOYLAT,
            ENC_VEC_LAYERS.BCNLAT,
            ENC_VEC_LAYERS.BOYCAR,
            ENC_VEC_LAYERS.BCNCAR,
            ENC_VEC_LAYERS.BOYSPP,
            ENC_VEC_LAYERS.BCNSPP,
            ENC_VEC_LAYERS.LIGHTS,
            ENC_VEC_LAYERS.RECTRC,
            ENC_VEC_LAYERS.RECTRC_LABEL,
            ENC_VEC_LAYERS.SOUNDG,
            ENC_VEC_LAYERS.NAVAIDS_LABEL,
        ];
        const apply = (): void => {
            try {
                for (const id of MARK_LAYERS) {
                    if (!map.getLayer(id)) continue;
                    // The detail scrubber outranks the tracer's re-assert
                    // (Shane 2026-07-15: "at the clean end of the scrubber
                    // I have flashing leads as well as markers" — this
                    // effect force-showed what the scrubber had cut, 120 ms
                    // apart, forever). Scrubbing clean is explicit intent;
                    // scrub back left and the marks return for plotting.
                    if (isScrubHidden(id)) continue;
                    // Conditional write — an unconditional setLayoutProperty
                    // emits a styledata that re-invokes this handler, and
                    // this effect is active during PLOTTING (coordCaptureMode)
                    // exactly when the user reported zoom locking up. Setting
                    // only when actually hidden lets steady state emit nothing.
                    const cur = (map.getLayoutProperty(id, 'visibility') as string | undefined) ?? 'visible';
                    if (cur !== 'visible') map.setLayoutProperty(id, 'visibility', 'visible');
                }
            } catch {
                /* style mid-swap — styledata re-applies */
            }
        };
        apply();
        // Coalesce the styledata burst a zoom/tile-load fires into ONE
        // trailing pass so the re-assert can't pin the thread mid-zoom.
        let pending: number | null = null;
        const scheduleApply = () => {
            if (pending !== null) return;
            pending = window.setTimeout(() => {
                pending = null;
                apply();
            }, 120);
        };
        map.on('styledata', scheduleApply);
        return () => {
            if (pending !== null) window.clearTimeout(pending);
            map.off('styledata', scheduleApply);
            try {
                encApplyLayerVisibility(map, encVisible);
                encApplyChartDetailLayers(map, encChartDetail);
            } catch {
                /* layers unmounted — nothing to restore */
            }
        };
    }, [coordCaptureMode, mapReady, encVisible, encChartDetail]);

    // Raise the PLOTTING KEEL FLOOR for as long as the tracer is up. The
    // effect above force-shows the MARKS you steer by; this one guarantees the
    // DEPTH you clear by (glaze/bands + safety contour + wrecks, rocks and
    // obstructions), which no furniture toggle may strip from the one surface
    // that exists to answer "does this leg float my keel?". Lowered on unmount
    // so the browsing chart honours the skipper's own toggles again.
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady) return;
        encSetPlottingMode(map, coordCaptureMode);
        return () => {
            const m = mapRef.current;
            if (m) {
                try {
                    encSetPlottingMode(m, false);
                } catch {
                    /* layers unmounted — nothing to lower */
                }
            }
        };
    }, [mapReady, coordCaptureMode]);

    // ── ENC test route line ──
    // One-off rendering of `tryInshoreRoute` output triggered by the
    // EncRouteButton chip. Independent of the passage-planner pipeline so
    // we can demo on-chart routing without the planner UI in scope.
    const [encTestRoute, setEncTestRoute] = useState<EncTestRoute | null>(null);
    useEncTestRouteLayer(mapRef, mapReady, encTestRoute);

    // Seaway Graph debug overlay — compiles gates/edges from the installed
    // cells for the viewport whenever the toggle is on (Phase 10).
    useSeawayDebugLayer(mapRef, mapReady, seawayDebugVisible);

    // ── Pending fit-to-bbox request ──
    // Used by EncCellManager (and any future "show me on the map"
    // entry point) to fit the viewport to a bbox after navigating
    // to the map. We consume on mount (if a request was staged
    // before navigation) and on subscription bumps (if one comes
    // in while the map is already mounted).
    useEffect(() => {
        if (!mapReady) return;
        const apply = () => {
            const map = mapRef.current;
            if (!map) return;
            const target = consumeMapFit();
            if (!target) return;
            const [minLon, minLat, maxLon, maxLat] = target.bbox;
            try {
                map.fitBounds(
                    [
                        [minLon, minLat],
                        [maxLon, maxLat],
                    ],
                    {
                        padding: target.paddingPx ?? 60,
                        maxZoom: target.maxZoom ?? 11,
                        duration: 1200,
                        essential: true,
                    },
                );
            } catch (err) {
                // Mapbox throws on degenerate bboxes (single point).
                // Fall back to a simple flyTo at the centre.
                map.flyTo({
                    center: [(minLon + maxLon) / 2, (minLat + maxLat) / 2],
                    zoom: target.maxZoom ?? 11,
                    essential: true,
                });
            }
        };
        // Apply any request staged before mount.
        if (peekMapFit()) apply();
        // Apply any future requests dispatched while we're mounted.
        return subscribeMapFit(apply);
    }, [mapReady]);

    // ── Hide OpenSeaMap raster overlays when another source draws navaids ──
    // Both raster overlays — 'openseamap-overlay' (baked into the map style,
    // ThalassaMap.tsx) and 'openseamap-permanent' (added by useMapInit) —
    // show their own seamark icons. When o-charts are active they render
    // native marks, and when the ENC vector chart is rendering it draws its
    // own IALA navaids, so hide the rasters to prevent doubled icons.
    // 'openseamap-permanent' is co-owned by the 'sea' weather toggle
    // (useWeatherLayers re-syncs it to that toggle on every weather-layer
    // change), so: when not chart-hidden we defer to the toggle rather than
    // forcing it visible, and we depend on weather.activeLayers so this
    // effect re-asserts the hide AFTER useWeatherLayers' sync (which runs
    // first — hook order) whenever weather layers change.
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady) return;
        const hide = chartsActive || encActive;
        const apply = (): void => {
            setOpenSeaMapRasterVisibility(map, {
                overlay: !hide,
                permanent: !hide && weather.activeLayers.has('sea'),
            });
            // OSM seamark circles retire ENTIRELY while a real chart source
            // is active (2026-07-11, Shane: "can we kill those?" — green
            // and blue dot trails down every channel at bay zoom). They
            // were the wide-zoom read from before broad ENC coverage; the
            // ENC IALA glyphs (per-mark SCAMIN, ~z13.5+) are now the only
            // marks worth glass, and the white ramp carries the wide view.
            // No chart source = circles at every zoom, as before — they're
            // still the only marks a chartless region has.
            try {
                if (map.getLayer('harbour-seamarks-circle')) {
                    map.setLayoutProperty('harbour-seamarks-circle', 'visibility', hide ? 'none' : 'visible');
                    if (!hide) map.setLayerZoomRange('harbour-seamarks-circle', 0, 24);
                }
                if (map.getLayer('harbour-seamarks-label')) {
                    map.setLayerZoomRange('harbour-seamarks-label', hide ? 24 : 14, 24);
                }
            } catch {
                /* style mid-swap — styledata re-applies */
            }
        };
        apply();
        // Re-assert on styledata: 'openseamap-overlay' is BAKED INTO the
        // basemap style, so every chart-mode/basemap switch resurrects it
        // without any React dep changing — the doubled icon Shane caught at
        // Mooloolaba beacon 5 (2026-07-09: OSM's red-outlined-triangle+star
        // raster icon stamped over our correct green IALA glyph). COALESCED
        // (2026-07-12): setLayoutProperty/setLayerZoomRange here each emit a
        // styledata, so running per-tick joined the zoom-freeze storm; a
        // trailing timer collapses each burst into one pass.
        let pending: number | null = null;
        const scheduleApply = () => {
            if (pending !== null) return;
            pending = window.setTimeout(() => {
                pending = null;
                apply();
            }, 120);
        };
        map.on('styledata', scheduleApply);
        return () => {
            if (pending !== null) window.clearTimeout(pending);
            map.off('styledata', scheduleApply);
        };
    }, [mapRef, mapReady, chartsActive, encActive, weather.activeLayers]);

    // ── Pin View: Drop a visual-only pin marker (no navigation side-effects) ──
    useEffect(() => {
        const pv = window.__thalassaPinView as { lat: number; lng: number } | undefined;
        if (!isPinView || !pv || !mapReady || !mapRef.current) return;
        const map = mapRef.current;

        // Remove any existing pin
        if (pinMarkerRef.current) pinMarkerRef.current.remove();

        // Create visual pin marker
        const el = document.createElement('div');
        el.className = 'mapbox-pin-marker';
        const pinDiv = document.createElement('div');
        pinDiv.style.cssText =
            'width:32px;height:32px;background:linear-gradient(135deg,#f59e0b,#ef4444);border:3px solid #fff;border-radius:50% 50% 50% 0;transform:rotate(-45deg);box-shadow:0 4px 16px rgba(245,158,11,0.5);animation:pinBounce 0.4s ease-out;';
        el.appendChild(pinDiv);
        const marker = new mapboxgl.Marker({ element: el, anchor: 'bottom' }).setLngLat([pv.lng, pv.lat]).addTo(map);
        pinMarkerRef.current = marker;

        // Fly to the pin
        map.flyTo({ center: [pv.lng, pv.lat], zoom: 7, duration: 1200 });
    }, [isPinView, mapReady]);

    // ── Pin View: temporarily clear weather overlays for a clean map ──
    // Shane: "when the punter does click the pin, we need to ensure
    // there are no other layers showing. at the moment, all the layers
    // that where on stay there." Solution: snapshot the user's active
    // weather layers + cyclone/squall toggles when entering pin view,
    // turn them off, restore on exit. The user's chart-catalog
    // selection (their chosen vector charts) stays — that's
    // legitimate context for navigating to a pin.
    const savedLayersRef = useRef<{
        weather: Set<WeatherLayer> | null;
        cyclone: boolean;
        squall: boolean;
    } | null>(null);
    useEffect(() => {
        if (!isPinView) return;
        // Snapshot
        savedLayersRef.current = {
            weather: new Set(weather.activeLayers),
            cyclone: cycloneVisible,
            squall: squallVisible,
        };
        // Clear
        weather.setActiveLayer('none');
        setCycloneVisible(false);
        setSquallVisible(false);
        return () => {
            // Restore on exit
            const saved = savedLayersRef.current;
            if (!saved) return;
            // Restore weather layers one by one (toggleLayer preserves
            // cross-group selections, which is how the user had them).
            saved.weather?.forEach((layer) => {
                if (!weather.activeLayers.has(layer)) weather.toggleLayer(layer);
            });
            setCycloneVisible(saved.cyclone);
            setSquallVisible(saved.squall);
            savedLayersRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isPinView]);

    // ── Pin View: Get Directions handler ──
    // Builds a Mapbox driving route from current GPS to the pin and
    // saves it as a VoyagePlan. Exits pin view on success so the
    // user's normal layers come back along with the route, ready to
    // navigate.
    const [pinDirectionsBusy, setPinDirectionsBusy] = useState(false);
    const [pinDirectionsError, setPinDirectionsError] = useState<string | null>(null);
    const handlePinDirections = useCallback(async () => {
        const pv = window.__thalassaPinView as { lat: number; lng: number } | undefined;
        if (!pv || pinDirectionsBusy) return;
        setPinDirectionsBusy(true);
        setPinDirectionsError(null);
        try {
            const { GpsService } = await import('../../services/GpsService');
            const pos = await GpsService.getCurrentPosition({ staleLimitMs: 30_000, timeoutSec: 10 });
            if (!pos) {
                setPinDirectionsError('Could not get your GPS position.');
                return;
            }
            const { buildDirectionsVoyagePlan } = await import('../../services/MapboxDirectionsService');
            const plan = await buildDirectionsVoyagePlan(
                { lat: pos.latitude, lon: pos.longitude, name: 'My Location' },
                { lat: pv.lat, lon: pv.lng, name: 'Pin' },
                'driving',
            );
            if (!plan) {
                setPinDirectionsError('No driving route found.');
                return;
            }
            saveVoyagePlan(plan);
            // Exit pin view so layers/route are visible normally.
            delete window.__thalassaPinView;
            setIsPinView(false);
        } catch (e) {
            setPinDirectionsError(e instanceof Error ? e.message : 'Directions failed.');
        } finally {
            setPinDirectionsBusy(false);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pinDirectionsBusy]);

    // Determine if tablet split-screen is active
    const isHelmSplit = deviceMode === 'helm' && passage.showPassage && !embedded;

    return (
        <div className={`w-full h-full ${isHelmSplit ? 'flex' : 'relative'}`}>
            {/* Floating route-enhancement chip — visible while the */}
            {/* passage planner's bathymetric/weather/depth pipeline runs */}
            {/* in the background after the basic plan lands. */}
            <RouteEnhancementChip />
            {/* Map container — 70% on tablet during passage, full otherwise */}
            <div className={`relative ${isHelmSplit ? 'flex-[7] h-full' : 'w-full h-full'}`}>
                <div ref={containerRef} className="w-full h-full" />

                {/* Pin bounce + location pulse animations moved to index.css */}

                {/* PIN VIEW BACK BUTTON removed — there's already a
                    middle-left back chevron in the global chrome, no
                    need for a second one in the top-left slot fighting
                    the zoom pill. Exit paths now: tap the existing
                    middle-left chevron, tap Get Directions (which
                    auto-exits on success), or use the bottom nav to
                    leave Charts. Shane: "there is already a chevron
                    middle left claude." */}

                {/* ═══ PIN VIEW · GET DIRECTIONS CTA ═══
                    Bottom-anchored emerald button so the punter can
                    immediately ask "how do I get there?" after a pin
                    tap from Scuttlebutt. Sits above the bottom nav
                    (88px reserve) with safe-area padding so it never
                    lands behind the tab bar — the earlier complaint
                    that drove the PinMapViewer portal fix (since
                    discovered to be dead code). z-[700] matches the
                    back-button stacking, well above the map but below
                    full-screen modals. */}
                {isPinView && (
                    <div className="absolute left-4 right-4 bottom-[calc(env(safe-area-inset-bottom)+88px)] z-[700] space-y-2 pointer-events-none">
                        {pinDirectionsError && (
                            <div className="rounded-xl border border-red-500/30 bg-red-500/90 backdrop-blur-md px-3 py-2 text-xs text-white shadow-lg pointer-events-auto">
                                {pinDirectionsError}
                            </div>
                        )}
                        <button
                            onClick={() => void handlePinDirections()}
                            disabled={pinDirectionsBusy}
                            aria-label="Get driving directions to pin"
                            className="pointer-events-auto w-full h-12 rounded-xl bg-emerald-500 hover:bg-emerald-400 active:scale-[0.98] transition-all text-white font-bold flex items-center justify-center gap-2 disabled:opacity-50 shadow-2xl"
                        >
                            {pinDirectionsBusy ? (
                                <>
                                    <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                    <span>Routing…</span>
                                </>
                            ) : (
                                <>
                                    <CompassIcon className="w-5 h-5" rotation={0} />
                                    <span>Get Directions</span>
                                </>
                            )}
                        </button>
                    </div>
                )}

                {/* ═══ ZOOM-LEVEL FAB ═══
                    Top-left pill showing current map zoom — self-
                    subscribed so per-frame zoom events re-render the
                    pill alone, never this tree. Mirrors the Bosun mic
                    FAB top-right position (top:56px right:16px in
                    App.tsx). Visible in pin-view too. */}
                <ZoomLevelFab mapRef={mapRef} mapReady={mapReady} />

                {/* ═══ VELOCITY WIND OVERLAY ═══ */}
                {!isPinView && !embedded && (
                    <MapboxVelocityOverlay
                        mapboxMap={mapRef.current}
                        visible={weather.activeLayers.has('velocity') || weather.activeLayers.has('wind')}
                        windHour={weather.windHour}
                        windGrid={weather.windGridRef?.current ?? undefined}
                        hideBadge={passage.showPassage}
                    />
                )}

                {/* ═══ GHOST SHIP (route interpolation during forecast scrub) ═══ */}
                <Suspense fallback={null}>
                    {!isPinView && !embedded && passage.showPassage && passage.routeAnalysis && (
                        <GhostShip
                            map={mapRef.current}
                            routeCoords={passage.isoResultRef.current?.routeCoordinates ?? null}
                            departureTime={passage.departureTime || new Date().toISOString()}
                            speed={passage.speed}
                            windHour={weather.windHour}
                            windForecastHours={weather.windForecastHoursRef.current}
                            windNowIdx={weather.windNowIdxRef.current}
                            visible={
                                (weather.activeLayers.has('wind') || weather.activeLayers.has('velocity')) &&
                                passage.showPassage &&
                                !!passage.routeAnalysis
                            }
                        />
                    )}
                </Suspense>

                <PassageBanner
                    passage={passage}
                    isoProgress={isoProgress}
                    passageNotice={passageNotice}
                    embedded={embedded}
                    isPinView={isPinView}
                    deviceMode={deviceMode}
                />

                {/* ═══ RADIAL HELM MENU (gesture-based layer control) ═══
                    Hidden while TRACING (Shane 2026-07-17: routing page
                    declutter) — Done brings the rail back. */}
                {!passage.showPassage && !embedded && !isPinView && !coordCaptureMode && (
                    <RadialHelmMenu
                        activeLayers={weather.activeLayers}
                        toggleLayer={weather.toggleLayer}
                        selectInGroup={weather.selectInGroup}
                        tacticalState={{
                            aisVisible,
                            onToggleAis: () => {
                                setAisVisible((v) => {
                                    if (!v) {
                                        setSquallVisible(false);
                                        setCycloneVisible(false);
                                    }
                                    return !v;
                                });
                            },
                            cycloneVisible,
                            onToggleCyclones: () => {
                                // When MULTIPLE cyclones are active, open the picker modal
                                // instead of just toggling — otherwise the user has no way
                                // to switch between storms (previous behaviour auto-focused
                                // only the closest one). With 0 or 1 storms, fall back to
                                // the simple toggle.
                                if (allCyclones.length > 1) {
                                    setStormPickerOpen(true);
                                    // Also enable the layer if it's off so the picked storm
                                    // becomes visible immediately.
                                    if (!cycloneVisible) {
                                        setCycloneVisible(true);
                                        setSquallVisible(false);
                                        setAisVisible(false);
                                        setChokepointVisible(false);
                                        setSeamarkVisible(false);
                                        setTideStationsVisible(false);
                                        setWeatherInspectMode(false);
                                        weather.setActiveLayer('none');
                                    }
                                    return;
                                }
                                // Single- or zero-storm case — plain toggle (existing behaviour)
                                const willBeVisible = !cycloneVisible;
                                setCycloneVisible(willBeVisible);
                                if (willBeVisible) {
                                    setSquallVisible(false);
                                    setAisVisible(false);
                                    setChokepointVisible(false);
                                    setSeamarkVisible(false);
                                    setTideStationsVisible(false);
                                    setWeatherInspectMode(false);
                                    weather.setActiveLayer('none');
                                }
                            },
                            squallVisible,
                            onToggleSquall: () => {
                                const willBeVisible = !squallVisible;
                                setSquallVisible(willBeVisible);
                                if (willBeVisible) {
                                    setCycloneVisible(false);
                                    setAisVisible(false);
                                    setChokepointVisible(false);
                                    setSeamarkVisible(false);
                                    setTideStationsVisible(false);
                                    setWeatherInspectMode(false);
                                    weather.setActiveLayer('none');
                                }
                            },
                            lightningVisible,
                            onToggleLightning: () => setLightningVisible((v) => !v),
                            weatherInspectMode,
                            onToggleWeatherInspect: () => {
                                setWeatherInspectMode((v) => {
                                    if (!v) {
                                        setSquallVisible(false);
                                        setCycloneVisible(false);
                                    }
                                    return !v;
                                });
                            },
                            seamarkVisible,
                            onToggleSeamark: () => {
                                setSeamarkVisible((v) => {
                                    if (!v) {
                                        setSquallVisible(false);
                                        setCycloneVisible(false);
                                    }
                                    return !v;
                                });
                            },
                            tideStationsVisible,
                            onToggleTideStations: () => {
                                setTideStationsVisible((v) => {
                                    if (!v) {
                                        setSquallVisible(false);
                                        setCycloneVisible(false);
                                    }
                                    return !v;
                                });
                            },
                            anchorageVisible,
                            onToggleAnchorage: () => setAnchorageVisible((v) => !v),
                            onOpenWeatherWindow: () => setPage('weatherWindow'),
                            // Marine Protected Areas — only surface in the
                            // radial menu when the feature flag is on, so
                            // the button doesn't taunt users on builds
                            // without the data pipeline live yet.
                            ...(isMpaEnabled()
                                ? {
                                      mpaVisible: weather.mpaVisible,
                                      onToggleMpa: () => weather.setMpaVisible(!weather.mpaVisible),
                                  }
                                : {}),
                        }}
                        chartsState={{
                            // Compose chart sources from AvNav (o-charts) + free chart
                            // catalog + local MBTiles + Routes + Tracks so all chart
                            // toggles live in the radial menu's 4th category.
                            // PARKED (Shane 2026-07-17: "do we really need the Charts
                            // button under the layer fab — it's all automatic now"): the
                            // boat's own ENC/o-charts load automatically by zoom, and the
                            // grab-bag here (Routes/Tracks now live on PLAN/LOG + the
                            // public page; NOAA/ECDIS/local are niche) only forced the
                            // category to always show. Empty sources ⇒ buildChartsCategory
                            // returns [] ⇒ the "Charts" button drops off the radial fan.
                            // Flip CHARTS_FAB_CATEGORY_VISIBLE to bring the picker back
                            // (all the pickers/state below stay wired).
                            sources: !CHARTS_FAB_CATEGORY_VISIBLE
                                ? []
                                : [
                                      // Routes — picker for saved planned passages from
                                      // the ships log. Tap opens a sheet listing them;
                                      // selection draws the route as a green dashed line
                                      // and fits the map to its bounds.
                                      {
                                          id: 'routes',
                                          label: 'Routes',
                                          iconKind: 'generic' as const,
                                          enabled: activeChartRoute !== null,
                                          onToggle: () => setRoutePickerOpen((v) => !v),
                                      },
                                      // Tracks — picker for actually-sailed passages.
                                      // Same UX as Routes; renders amber solid line so
                                      // the two can be visible together without confusing
                                      // which is the plan vs the reality.
                                      {
                                          id: 'tracks',
                                          label: 'Tracks',
                                          iconKind: 'generic' as const,
                                          enabled: activeChartTrack !== null,
                                          onToggle: () => setTrackPickerOpen((v) => !v),
                                      },
                                      ...skCharts.availableCharts.map((c) => ({
                                          id: `sk-${c.id}`,
                                          label: c.name.length > 10 ? c.name.substring(0, 10) : c.name,
                                          iconKind: 'avnav' as const,
                                          enabled: skChartIds.has(c.id),
                                          onToggle: () => selectChartExclusive('sk', c.id),
                                      })),
                                      ...chartCatalog.sources.map((s) => ({
                                          id: `cat-${s.id}`,
                                          label:
                                              s.id === 'noaa-ncds'
                                                  ? 'NOAA'
                                                  : s.id === 'noaa-ecdis'
                                                    ? 'ECDIS'
                                                    : s.id === 'linz-charts'
                                                      ? 'NZ'
                                                      : s.name.length > 10
                                                        ? s.name.substring(0, 10)
                                                        : s.name,
                                          iconKind: (s.id === 'noaa-ncds'
                                              ? 'noaa'
                                              : s.id === 'noaa-ecdis'
                                                ? 'ecdis'
                                                : s.id === 'linz-charts'
                                                  ? 'linz'
                                                  : 'generic') as 'noaa' | 'ecdis' | 'linz' | 'generic',
                                          enabled: s.enabled && !!s.tileUrl,
                                          onToggle: () => selectChartExclusive('catalog', s.id),
                                      })),
                                      ...localCharts.availableCharts.map((c) => ({
                                          id: `local-${c.fileName}`,
                                          label: c.name.length > 10 ? c.name.substring(0, 10) : c.name,
                                          iconKind: 'local' as const,
                                          enabled: localChartIds.has(c.fileName),
                                          onToggle: () => selectChartExclusive('local', c.fileName),
                                      })),
                                  ],
                        }}
                    />
                )}

                {/* Plan ENC Route action moved into the ChartModes dropdown
                    (2026-05-18) — sits between "Charts Only" and "Clear All".
                    The floating top-left pill was easily missed and crowded
                    the FAB column. */}

                {/* ═══ LEGACY LAYER MENU (kept for chart/SK/vessel controls not yet in radial) ═══ */}
                {!passage.showPassage && !embedded && !isPinView && weather.showLayerMenu && (
                    <LayerFABMenu
                        activeLayers={weather.activeLayers}
                        showLayerMenu={weather.showLayerMenu}
                        embedded={embedded}
                        location={location}
                        initialZoom={initialZoom}
                        center={center}
                        mapRef={mapRef}
                        toggleLayer={weather.toggleLayer}
                        onSelectSeaState={(layer) => {
                            setSquallVisible(false);
                            setCycloneVisible(false);
                            weather.selectInGroup(layer, SEA_STATE_LAYERS);
                        }}
                        onSelectAtmosphere={(layer) => {
                            setSquallVisible(false);
                            setCycloneVisible(false);
                            weather.selectInGroup(layer, ATMOSPHERE_LAYERS);
                        }}
                        setShowLayerMenu={weather.setShowLayerMenu}
                        encVisible={encVisible}
                        onToggleEnc={() => setEncVisible(!encVisible)}
                        encCellCount={encCellCount}
                        encChartDetail={encChartDetail}
                        onToggleEncChartDetail={() => setEncChartDetail(!encChartDetail)}
                        aisVisible={aisVisible}
                        onToggleAis={() => {
                            setAisVisible((v) => {
                                if (!v) {
                                    setSquallVisible(false);
                                    setCycloneVisible(false);
                                }
                                return !v;
                            });
                        }}
                        chokepointVisible={chokepointVisible}
                        onToggleChokepoint={() => {
                            setChokepointVisible((v) => {
                                if (!v) {
                                    setSquallVisible(false);
                                    setCycloneVisible(false);
                                }
                                return !v;
                            });
                        }}
                        weatherInspectMode={weatherInspectMode}
                        onToggleWeatherInspect={() => {
                            setWeatherInspectMode((v) => {
                                if (!v) {
                                    setSquallVisible(false);
                                    setCycloneVisible(false);
                                }
                                return !v;
                            });
                            weather.setShowLayerMenu(false);
                        }}
                        cycloneVisible={cycloneVisible}
                        onToggleCyclones={() => {
                            const willBeVisible = !cycloneVisible;
                            setCycloneVisible(willBeVisible);
                            if (willBeVisible) {
                                setSquallVisible(false);
                                setAisVisible(false);
                                setChokepointVisible(false);
                                setSeamarkVisible(false);
                                setTideStationsVisible(false);
                                setWeatherInspectMode(false);
                                weather.setActiveLayer('none');
                            }
                        }}
                        cycloneStormName={closestStorm?.name ?? null}
                        allCyclones={allCyclones}
                        userLat={location.lat}
                        userLon={location.lon}
                        onSelectStorm={handleSelectStorm}
                        squallVisible={squallVisible}
                        onToggleSquall={() => {
                            const willBeVisible = !squallVisible;
                            setSquallVisible(willBeVisible);
                            if (willBeVisible) {
                                setCycloneVisible(false);
                                setAisVisible(false);
                                setChokepointVisible(false);
                                setSeamarkVisible(false);
                                setTideStationsVisible(false);
                                setWeatherInspectMode(false);
                                weather.setActiveLayer('none');
                            }
                        }}
                        lightningVisible={lightningVisible}
                        onToggleLightning={() => {
                            setLightningVisible((v) => !v);
                        }}
                        vesselTrackingVisible={vesselTrackingVisible}
                        onToggleVesselTracking={() => {
                            setVesselTrackingVisible((v) => {
                                if (!v) {
                                    setSquallVisible(false);
                                    setCycloneVisible(false);
                                }
                                return !v;
                            });
                        }}
                        onLocateVessel={flyToVessel}
                        skCharts={skCharts.availableCharts}
                        skChartIds={skChartIds}
                        skChartOpacity={skChartOpacity}
                        skConnectionStatus={skCharts.connectionStatus}
                        onToggleSkChart={(id: string) => selectChartExclusive('sk', id)}
                        onSkChartOpacityChange={setSkChartOpacity}
                        onFlyToChart={skCharts.flyToChart}
                        seamarkVisible={seamarkVisible}
                        onToggleSeamark={() => {
                            setSeamarkVisible((v) => {
                                if (!v) {
                                    setSquallVisible(false);
                                    setCycloneVisible(false);
                                }
                                return !v;
                            });
                        }}
                        seamarkFeatureCount={seamark.featureCount}
                        seamarkLoading={seamark.loading}
                        chartsActive={chartsActive}
                        seamarkMode={seamarkMode}
                        tideStationsVisible={tideStationsVisible}
                        onToggleTideStations={() => {
                            setTideStationsVisible((v) => {
                                if (!v) {
                                    setSquallVisible(false);
                                    setCycloneVisible(false);
                                }
                                return !v;
                            });
                        }}
                        tideStationCount={tideStations.stationCount}
                        tideStationLoading={tideStations.loading}
                        {...(isMpaEnabled()
                            ? {
                                  mpaVisible: weather.mpaVisible,
                                  onToggleMpa: () => weather.setMpaVisible(!weather.mpaVisible),
                              }
                            : {})}
                        chartCatalogSources={chartCatalog.sources}
                        onToggleChartSource={(id) => selectChartExclusive('catalog', id)}
                        onChartSourceOpacity={chartCatalog.setOpacity}
                        onFlyToChartSource={chartCatalog.flyToSource}
                        onUpdateLinzKey={chartCatalog.updateLinzKey}
                        localCharts={localCharts.availableCharts}
                        localChartIds={localChartIds}
                        localChartOpacity={localChartOpacity}
                        localChartsLoading={localCharts.loading}
                        onToggleLocalChart={(fileName: string) => selectChartExclusive('local', fileName)}
                        onLocalChartOpacityChange={setLocalChartOpacity}
                        onFlyToLocalChart={localCharts.flyToChart}
                    />
                )}

                {/* Compass rose — tracer's hand tool, same surface gates. */}
                {/* Compass rose ALWAYS shows while tracing (Shane 2026-07-17:
                    "we don't need to hide the compass" — the header toggle is
                    gone). */}
                {!embedded && !isPinView && !pickerMode && !hideTracer && coordCaptureMode && (
                    <CompassRoseOverlay mapRef={mapRef} mapReady={mapReady} />
                )}

                {/* ═══ DETAIL SCRUBBER ═══
                    "Hard right is very little detail, hard left is full
                    detail" (Shane 2026-07-14). Bottom-centre slider, 7
                    detents — encDetailScrubber maps each step to furniture
                    cuts + a sounding-density bias; hazards and the safety
                    contour are untouchable. Same surface gates as the
                    tracer so embedded/pin/picker views stay clean.
                    TRACING-ONLY since 2026-07-17 (Shane: "on the charts
                    page, remove the scrubber") — the browsing chart stays
                    bare; the slider appears with the plotting card. */}
                {!embedded && !isPinView && !pickerMode && !hideTracer && coordCaptureMode && encCellCount > 0 && (
                    <div
                        // LEFT RAIL, not centred (Shane 2026-07-18: "the scrubber
                        // just touches the location fab at the bottom right"). At
                        // w-72 centred it reached ~300px on a 390pt screen, right
                        // into the Locate FAB's corner. Pinned left it clears it,
                        // and the tracer card stacks directly above on the same
                        // rail so the two read as one column.
                        className="absolute left-3 z-[9994]"
                        style={{ bottom: 'calc(5.4rem + env(safe-area-inset-bottom))' }}
                    >
                        {/* w-72 (was w-64) so the 7 detents sit further apart —
                            more travel per step is half the fat-finger fix; the
                            other half is the 26px-tall .detail-scrubber input
                            (Shane 2026-07-18). Matches the tracer card's width. */}
                        <div className="flex w-72 items-center gap-2.5 rounded-full border border-white/10 bg-slate-900/85 px-3.5 py-2 shadow-lg backdrop-blur-sm">
                            <span className="text-[10px] font-black uppercase tracking-widest text-sky-300/90">
                                Full
                            </span>
                            <input
                                type="range"
                                min={0}
                                max={DETAIL_SCRUB_MAX}
                                step={1}
                                value={declutter}
                                onChange={(e) => {
                                    const v = Number(e.target.value);
                                    if (v !== declutter) triggerHaptic('light');
                                    setDeclutter(v);
                                }}
                                aria-label="Chart detail — full at left, minimal at right"
                                className="detail-scrubber flex-1"
                            />
                            <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">
                                Clean
                            </span>
                        </div>
                    </div>
                )}

                {/* ═══ ROUTE TRACER ═══
                    Tap pins along your own line — every leg grades live
                    (depth vs keel, land/berths, cardinals, gates, leads) and
                    draws green/amber/red. Save, sail, or export the trace as
                    a curated-fairway candidate (Shane 2026-07-08). Gated out
                    of embedded/pin/picker surfaces like its neighbours —
                    ungated it swallowed picker taps (audit minor). */}
                {/* TRACING-ONLY since 2026-07-17 (Shane: "remove the tracer
                    card" from the charts page): the browsing chart carries no
                    tracer furniture at all — the PLAN page is the only door
                    in ("Slide to Start Plotting" / Trip box / saved routes),
                    and Done hands the bare chart back. */}
                {/* PLOTTING ONLY — no tracer furniture on the browsing chart
                    (Shane 2026-07-19: "once you put one plotted spot on the planning
                    page, the tracer card shows up in the charts page, can we prevent
                    that").

                    The 🧭 resume pill was un-parked here on 2026-07-18 as the way
                    back from a trace stranded by a tab hop. It turned out not to be
                    needed: the real fix that day was PERSISTING the pins, and with
                    thalassa_trace_wip_pins hydrating capturedCoords on mount, the
                    Plan page's "Slide to Start Plotting" already restores the trace
                    whole — its door fires requestTracerOpen() with no action, which
                    never touches pins. So the pill was a second, redundant door that
                    cost the browsing chart its cleanliness. Removed; the pins are
                    still safe and still resume. (The closed-pill branch below returns
                    to being parked, not deleted.) */}
                {!embedded && !isPinView && !pickerMode && !hideTracer && coordCaptureMode && (
                    <div
                        // LEFT RAIL, shared with the scrubber (Shane 2026-07-18:
                        // "move the tracer card so that it is right on top of the
                        // scrubber, make it all balance nicely"). Briefly centred on
                        // device earlier the same day, but once the scrubber moved
                        // left to clear the Locate FAB, a centred card sat off-axis
                        // from it. Same left-3, same w-72 — card directly above
                        // scrubber, one column, nothing near the corner FABs.
                        className="absolute left-3 z-[9995]"
                        // OPEN card sits ABOVE the detail scrubber (bottom 5.4rem,
                        // ~2.2rem tall) — it used to overlap it by ~24 px (Shane
                        // 2026-07-17). MINIMISED it lifts a further 2rem so the
                        // little header block floats clear of the scrubber
                        // (Shane 2026-07-17: "move it up slightly so that it is
                        // free of the scrubber"). The CLOSED 🧭 pill keeps its
                        // usual bottom-rail home at 6rem (parked branch).
                        style={{
                            // OPEN: bind BOTH edges so the card is a fixed band in
                            // CONTAINER coords (Shane 2026-07-17: the old fixed
                            // h-[100dvh…] measured the VIEWPORT, but the card lives
                            // in the shorter map container, so it overshot the top).
                            // top clears whichever top-furniture sits LOWEST + 8px:
                            //   • compass rose bottom = env(safe-top)+0.5rem+116px
                            //   • zoom pill / moon bottom = 148px (LITERAL top-104
                            //     + h-11; NOT safe-area-adjusted)
                            // On the web (no safe-top) the rose rides up but the pills
                            // stay at 148px, so tying top to the rose alone let the
                            // card cover the pills — max() takes the lower of the two.
                            // FOLDED: no top — the card shrinks to its header strip
                            // (so Done visibly minimises). The CLOSED 🧭 pill likewise
                            // binds bottom only — top-bound it would stretch the little
                            // pill into a full-height band.
                            top:
                                !coordCaptureMode || panelFolded
                                    ? undefined
                                    : 'calc(max(env(safe-area-inset-top) + 124px, 148px) + 8px)',
                            // SITS ON THE SCRUBBER, open or folded (Shane 2026-07-18:
                            // "right on top of the scrubber... balance nicely").
                            // Scrubber bottom 5.4rem + its ~44px height puts its top
                            // edge at ~130px, so 8.8rem (~141px) leaves a ~10px seam.
                            // Folded used to sit 2rem higher to clear the slider; with
                            // the card deliberately docked to it that lift is now the
                            // thing to avoid — one value keeps the column stable when
                            // Done folds it, instead of the header jumping.
                            bottom: coordCaptureMode
                                ? 'calc(8.8rem + env(safe-area-inset-bottom))'
                                : 'calc(6rem + env(safe-area-inset-bottom))',
                        }}
                    >
                        {!coordCaptureMode ? (
                            <button
                                onClick={() => {
                                    triggerHaptic('light');
                                    setWeatherInspectMode(false);
                                    setCoordCaptureMode(true);
                                    // Guided start: fresh trace + a planned
                                    // departure → fly to the berth at close
                                    // zoom, ready to trace out of the marina.
                                    if (capturedCoords.length === 0 && passage.departure) {
                                        const d = passage.departure;
                                        mapRef.current?.flyTo({
                                            center: [d.lon, d.lat],
                                            zoom: 14.5,
                                            duration: 1200,
                                        });
                                        flashTraceFeedback(
                                            `Trace out of ${d.name || 'the marina'} — I'll take the open water`,
                                        );
                                    }
                                }}
                                className="flex items-center gap-1.5 rounded-full border border-white/10 bg-slate-800/90 px-3 py-2 text-xs font-bold text-amber-300 shadow-lg active:scale-95"
                            >
                                {/* Badge = unsaved pins survive Done ("trace kept") */}
                                🧭 Trace route{capturedCoords.length > 0 ? ` (${capturedCoords.length})` : ''}
                            </button>
                        ) : (
                            // OPEN: h-full fills the top/bottom-bound band above,
                            // so the card is a FIXED size and never grows with
                            // waypoints (Shane 2026-07-17); the waypoint list is the
                            // ONE flex-1 min-h-0 child, soaking up the slack and
                            // scrolling while Save/Report/Depart stay pinned. FOLDED:
                            // no height — the card collapses to its header strip.
                            <div
                                className={`flex w-72 flex-col overflow-hidden rounded-2xl border border-amber-500/30 bg-slate-900/95 shadow-2xl ${
                                    panelFolded ? '' : 'h-full'
                                }`}
                            >
                                {/* Header is a SINGLE full-width fold/expand button now
                                    (Shane 2026-07-17: "remove Done and the compass — Done
                                    does the exact same thing as Tracer, and we don't need
                                    to hide the compass"). Tapping TRACER minimises to the
                                    header strip / re-expands. The compass rose stays put;
                                    leaving trace mode is via the tab bar. */}
                                <div className="flex select-none items-center border-b border-white/10 px-2 py-1.5">
                                    <button
                                        onClick={() => {
                                            triggerHaptic('light');
                                            setPanelFolded((f) => !f);
                                        }}
                                        aria-expanded={!panelFolded}
                                        aria-label={panelFolded ? 'Expand tracer panel' : 'Collapse tracer panel'}
                                        className="flex h-9 w-full items-center gap-1.5 rounded-lg bg-white/10 px-2.5 text-xs font-black uppercase tracking-widest text-amber-300 active:scale-95"
                                    >
                                        <span className="text-lg leading-none text-gray-400">
                                            {panelFolded ? '▸' : '▾'}
                                        </span>
                                        ● Tracer
                                    </button>
                                </div>
                                {panelFolded ? (
                                    /* Folded: the chart owns the glass. Feedback still
                                       flashes ("Inserted between 4 and 5"), ⚡ Auto and
                                       Undo stay one thumb away; everything else waits
                                       behind the chevron. */
                                    <div>
                                        {traceFeedback && (
                                            <div className="border-b border-white/10 px-3 py-1.5 text-[10px] font-black text-emerald-300">
                                                {traceFeedback}
                                            </div>
                                        )}
                                        <div className="flex items-center gap-2 px-3 py-1.5">
                                            <button
                                                onClick={() => {
                                                    triggerHaptic('light');
                                                    setPlotArmed((a) => !a);
                                                }}
                                                aria-pressed={plotArmed}
                                                className={`flex-1 rounded-lg py-1.5 text-[10px] font-black uppercase tracking-wide active:scale-95 ${
                                                    plotArmed
                                                        ? 'bg-amber-500/20 text-amber-300'
                                                        : 'bg-white/10 text-gray-300'
                                                }`}
                                            >
                                                {plotArmed ? '✏️ Plotting' : '⏸ Paused'}
                                            </button>
                                            {COURSE_FRAME_VISIBLE &&
                                                (capturedCoords.length > 0 || traceOrigin) &&
                                                (traceDest || passage.arrival) && (
                                                    <button
                                                        onClick={() => void autoCompleteTrace()}
                                                        disabled={autoBusy}
                                                        className="flex-1 rounded-lg bg-violet-500/20 py-1.5 text-[10px] font-black uppercase tracking-wide text-violet-300 active:scale-95 disabled:opacity-50"
                                                    >
                                                        {autoBusy ? '⏳ Routing…' : '⚡ Auto'}
                                                    </button>
                                                )}
                                            <button
                                                onClick={undoTrace}
                                                disabled={!canUndoTrace}
                                                className="flex-1 rounded-lg bg-white/5 py-1.5 text-[10px] font-black uppercase tracking-wide text-gray-300 active:scale-95 disabled:opacity-40"
                                            >
                                                Undo
                                            </button>
                                            <button
                                                onClick={redoTrace}
                                                disabled={!canRedoTrace}
                                                className="flex-1 rounded-lg bg-white/5 py-1.5 text-[10px] font-black uppercase tracking-wide text-gray-300 active:scale-95 disabled:opacity-40"
                                            >
                                                Redo
                                            </button>
                                        </div>
                                    </div>
                                ) : (
                                    <div className="flex min-h-0 flex-1 flex-col">
                                        {/* Draft honesty — ALWAYS say what keel the verdicts
                                checked; amber when it's the 2.5 m fallback, LOUD
                                when the number reads like a units mix-up (field
                                bug 2026-07-09: a 12.0 m keel turned every leg
                                into "needs +12.5 m tide" in deep water — draft
                                had been saved through the wrong unit toggle). */}
                                        {!(Number(settings.vessel?.draft) > 0) ? (
                                            <div className="border-b border-white/10 px-3 py-1.5 text-[10px] font-bold text-amber-400">
                                                ⚠ Default 2.5 m draft — set your vessel for real depth checks.
                                            </div>
                                        ) : vesselDraftMetres(settings.vessel) > 6 ? (
                                            <div className="border-b border-white/10 px-3 py-1.5 text-[10px] font-bold text-amber-400">
                                                ⚠ Checking a {vesselDraftMetres(settings.vessel).toFixed(1)} m keel —
                                                that reads like a units mix-up. Check Draft in Settings → Vessel.
                                            </div>
                                        ) : (
                                            <div className="border-b border-white/10 px-3 py-1.5 text-[10px] text-gray-400">
                                                Checking {vesselDraftMetres(settings.vessel).toFixed(1)} m keel +{' '}
                                                {DEFAULT_TIDE_SAFETY_M} m margin at low tide
                                            </div>
                                        )}
                                        {/* Course frame (guided front door) — PARKED behind
                                COURSE_FRAME_VISIBLE (Shane 2026-07-16: no
                                From/To boxes, "we just start by clicking a
                                spot"). */}
                                        {COURSE_FRAME_VISIBLE && !traceDest && capturedCoords.length === 0 && (
                                            <div className="space-y-1.5 border-b border-white/10 px-3 py-2">
                                                <input
                                                    value={fromQuery}
                                                    onChange={(e) => setFromQuery(e.target.value)}
                                                    onKeyDown={(e) => {
                                                        if (e.key === 'Enter') void setCourseFrame();
                                                    }}
                                                    placeholder="From — port or GPS coords"
                                                    aria-label="Passage origin"
                                                    className="h-8 w-full rounded-lg border border-white/10 bg-slate-800/80 px-2 text-[11px] font-medium text-white placeholder-gray-500 outline-none focus:border-sky-500/50"
                                                />
                                                <input
                                                    value={toQuery}
                                                    onChange={(e) => setToQuery(e.target.value)}
                                                    onKeyDown={(e) => {
                                                        if (e.key === 'Enter') void setCourseFrame();
                                                    }}
                                                    placeholder="To — destination"
                                                    aria-label="Passage destination"
                                                    className="h-8 w-full rounded-lg border border-white/10 bg-slate-800/80 px-2 text-[11px] font-medium text-white placeholder-gray-500 outline-none focus:border-sky-500/50"
                                                />
                                                <button
                                                    onClick={() => void setCourseFrame()}
                                                    disabled={frameBusy || !fromQuery.trim() || !toQuery.trim()}
                                                    className="w-full rounded-lg bg-sky-500/20 py-2 text-[11px] font-black uppercase tracking-wide text-sky-300 active:scale-95 disabled:opacity-40"
                                                >
                                                    {frameBusy ? '⏳ Finding…' : '🧭 Set course'}
                                                </button>
                                                <p className="text-[9px] leading-snug text-gray-500">
                                                    Or just tap the chart to start plotting.
                                                </p>
                                            </div>
                                        )}
                                        {traceDest && (
                                            <div className="flex items-center justify-between border-b border-white/10 px-3 py-1.5">
                                                <span className="truncate text-[10px] font-black text-sky-300">
                                                    {traceOrigin?.name ?? 'Here'} → {traceDest.name}
                                                </span>
                                                <button
                                                    onClick={clearCourseFrame}
                                                    aria-label="Clear the course frame"
                                                    className="ml-2 shrink-0 text-[10px] font-bold text-gray-500"
                                                >
                                                    ✕
                                                </button>
                                            </div>
                                        )}
                                        {tracerStatus === 'loading' && (
                                            <div className="border-b border-white/10 px-3 py-1.5 text-[10px] font-bold text-sky-300">
                                                Reading charts for this area…
                                            </div>
                                        )}
                                        {tracerStatus === 'nochart' && (
                                            <div className="border-b border-white/10 px-3 py-1.5 text-[10px] font-bold text-amber-400">
                                                No ENC charts here — legs can't be depth-checked.
                                            </div>
                                        )}
                                        {tracerStatus === 'toolarge' && (
                                            <div className="border-b border-white/10 px-3 py-1.5 text-[10px] font-bold text-amber-400">
                                                A leg spans too much water to check — drop pins along it.
                                            </div>
                                        )}
                                        {tracerStatus === 'marksonly' && (
                                            <div className="border-b border-white/10 px-3 py-1.5 text-[10px] font-bold text-amber-400">
                                                Long open-water leg — marks checked, depth not. Add a mid pin.
                                            </div>
                                        )}
                                        {/* Persistent ⚡ auto-route outcome — stays until the
                                            next auto-route so a no-op is legible (tap to dismiss). */}
                                        {autoRouteDiag && (
                                            <button
                                                onClick={() => setAutoRouteDiag(null)}
                                                className="w-full border-b border-white/10 px-3 py-1.5 text-left text-[10px] font-bold text-violet-300 active:opacity-70"
                                            >
                                                {autoRouteDiag} <span className="text-gray-500">(tap to dismiss)</span>
                                            </button>
                                        )}
                                        {traceFeedback && (
                                            <div className="border-b border-white/10 px-3 py-1.5 text-[10px] font-black text-emerald-300">
                                                {traceFeedback}
                                            </div>
                                        )}
                                        {/* Guided builder ⚡ Auto-to-destination — PARKED with
                                the course frame (COURSE_FRAME_VISIBLE). */}
                                        {COURSE_FRAME_VISIBLE &&
                                            (capturedCoords.length > 0 || traceOrigin) &&
                                            (traceDest || passage.arrival) && (
                                                <div className="border-b border-white/10 px-3 py-1.5">
                                                    <button
                                                        onClick={() => void autoCompleteTrace()}
                                                        disabled={autoBusy}
                                                        className="w-full rounded-lg bg-violet-500/20 py-2 text-[11px] font-black uppercase tracking-wide text-violet-300 active:scale-95 disabled:opacity-50"
                                                    >
                                                        {autoBusy
                                                            ? '⏳ Routing the open water…'
                                                            : `⚡ Auto to ${(traceDest ?? passage.arrival)?.name || 'destination'}`}
                                                    </button>
                                                </div>
                                            )}
                                        {courseChip && (
                                            <div className="border-b border-white/10 px-3 py-1.5 text-[11px] font-black text-sky-300">
                                                {courseChip}
                                            </div>
                                        )}
                                        {/* Proven-lane ghost accept — the flywheel
                                paying out: someone's validated lane, two taps. */}
                                        {capturedCoords.length <= 1 && ghostLanes.length > 0 && (
                                            <div className="border-b border-white/10 px-3 py-1.5">
                                                <button
                                                    onClick={() => {
                                                        triggerHaptic('medium');
                                                        const lane = ghostLanes[0] as (typeof ghostLanes)[number] & {
                                                            draftM?: number | null;
                                                        };
                                                        rebaseHistoryRef.current = true; // wholesale load → Undo floor
                                                        setCapturedCoords(lane.points);
                                                        // Draft-relative honesty: a shared lane was proven
                                                        // by SOMEONE'S keel — the re-grade against YOURS
                                                        // happens automatically as the pins load.
                                                        const mine = vesselDraftMetres(settings.vessel);
                                                        flashTraceFeedback(
                                                            lane.draftM
                                                                ? `Proven at ${lane.draftM.toFixed(1)} m draft — re-checking for your ${mine.toFixed(1)} m keel`
                                                                : 'Proven lane loaded — check it, then ⚡ Auto or keep tracing',
                                                        );
                                                    }}
                                                    className="w-full rounded-lg bg-emerald-500/15 py-2 text-[11px] font-black uppercase tracking-wide text-emerald-300 active:scale-95"
                                                >
                                                    ⭐ Use the proven lane here
                                                </button>
                                            </div>
                                        )}
                                        {/* Colour key — green/amber/red were never defined
                                anywhere (audit: punters can't tell if amber
                                means "fine, watch it" or "don't go"). */}
                                        {capturedCoords.length > 0 && (
                                            <div className="flex gap-2 border-b border-white/10 px-3 py-1 text-[10px] text-gray-400">
                                                <span>
                                                    <span className="text-emerald-300">●</span> good water
                                                </span>
                                                <span>
                                                    <span className="text-amber-300">●</span> check it
                                                </span>
                                                <span>
                                                    <span className="text-red-400">●</span> no-go at low tide
                                                </span>
                                            </div>
                                        )}
                                        {/* Selected-pin editor: tap a numbered pin on the
                                chart → delete it or splice a new pin after it
                                (fixing pin 5 of 29 no longer costs 24 Undos). */}
                                        {selectedPin !== null && selectedPin < capturedCoords.length && (
                                            <div className="flex items-center gap-1.5 border-b border-sky-500/30 bg-sky-500/10 px-3 py-1.5">
                                                <span className="flex-1 text-[11px] font-bold text-sky-300">
                                                    {selectedPin === 0
                                                        ? legAnchor
                                                            ? `Start — locked to ${legAnchor.fromName} 🔒`
                                                            : 'Start'
                                                        : selectedPin === capturedCoords.length - 1
                                                          ? 'Finish'
                                                          : `Pin ${selectedPin + 1}`}
                                                    {insertAfter !== null
                                                        ? ' — hold on the chart to insert after it'
                                                        : ''}
                                                </span>
                                                {insertAfter === null && (
                                                    <button
                                                        onClick={() => {
                                                            triggerHaptic('light');
                                                            setInsertAfter(selectedPin);
                                                            insertAfterRef.current = selectedPin;
                                                        }}
                                                        className="rounded-lg bg-sky-500/20 px-2 py-1.5 text-[11px] font-black uppercase text-sky-300 active:scale-95"
                                                    >
                                                        + Insert
                                                    </button>
                                                )}
                                                <button
                                                    onClick={() => {
                                                        // The chained-leg start can't be deleted —
                                                        // it IS the previous leg's arrival.
                                                        if (selectedPin === 0 && legAnchor) {
                                                            flashTraceFeedback(
                                                                `First pin is locked to ${legAnchor.fromName} — edit the previous leg to move it`,
                                                            );
                                                            return;
                                                        }
                                                        triggerHaptic('medium');
                                                        const idx = selectedPin;
                                                        setSelectedPin(null);
                                                        setInsertAfter(null);
                                                        insertAfterRef.current = null;
                                                        setCapturedCoords((prev) => prev.filter((_, j) => j !== idx));
                                                    }}
                                                    className="rounded-lg bg-red-500/20 px-2 py-1.5 text-[11px] font-black uppercase text-red-300 active:scale-95"
                                                >
                                                    Delete
                                                </button>
                                                <button
                                                    onClick={() => {
                                                        setSelectedPin(null);
                                                        setInsertAfter(null);
                                                        insertAfterRef.current = null;
                                                    }}
                                                    className="px-1 text-gray-400"
                                                >
                                                    ✕
                                                </button>
                                            </div>
                                        )}
                                        {/* Pin-on-land diagnosis: a fat-fingered pin on the
                                breakwater used to show as two cryptic red legs
                                with the shared-pin cause never stated. Memoized
                                above — grid reads happen per grading pass, not
                                per render. */}
                                        {pinDiagnosis && (
                                            <div className="border-b border-white/10 px-3 py-1.5 text-[10px] font-bold text-red-400">
                                                {pinDiagnosis}
                                            </div>
                                        )}
                                        {/* Open a saved route — the only path to previous
                                            tracks on the standalone /plan web page (no PLAN
                                            front door there). The "Key" toggle was removed
                                            (Shane 2026-07-17: "makes the card go haywire and
                                            gives no meaningful info"); the empty-state help
                                            still carries the colour key. */}
                                        <div className="flex shrink-0 border-b border-white/10 px-3 py-1.5">
                                            <button
                                                onClick={() => {
                                                    triggerHaptic('light');
                                                    setSavedTraces(loadSavedTraces());
                                                    setShowSavedTraces((v) => !v);
                                                }}
                                                className={`flex-1 rounded-lg px-2.5 py-1 text-left text-[10px] font-black uppercase tracking-wide active:scale-95 ${showSavedTraces ? 'bg-white/10 text-gray-100' : 'bg-white/5 text-gray-400'}`}
                                            >
                                                {showSavedTraces ? '▾ Saved routes' : '📂 Open a saved route'}
                                            </button>
                                        </div>
                                        {showSavedTraces && (
                                            <div className="max-h-40 shrink-0 space-y-1 overflow-y-auto border-b border-white/10 px-3 py-2">
                                                {savedTraces.length === 0 ? (
                                                    <div className="text-[10px] text-gray-500">
                                                        No saved routes yet — plot one and Save it.
                                                    </div>
                                                ) : (
                                                    // GROUPED by trip (Shane 2026-07-17), the same
                                                    // shared helper the PLAN Trip box uses: a
                                                    // multi-leg trip shows a header + indented
                                                    // legs; a standalone route is one row.
                                                    groupTracesByTrip(savedTraces).map((trip) =>
                                                        trip.legs.length === 1 ? (
                                                            <button
                                                                key={trip.key}
                                                                onClick={() => openSavedTrace(trip.legs[0])}
                                                                className="block w-full truncate rounded-md px-1.5 py-1.5 text-left text-[11px] text-gray-200 active:bg-white/10"
                                                            >
                                                                {trip.legs[0].name}{' '}
                                                                <span className="text-gray-500">
                                                                    ({trip.legs[0].points.length} pins)
                                                                </span>
                                                            </button>
                                                        ) : (
                                                            <div key={trip.key}>
                                                                <div className="truncate px-1.5 pt-1 text-[10px] font-black uppercase tracking-wide text-amber-300/90">
                                                                    🧩 {trip.label}
                                                                </div>
                                                                {trip.legs.map((leg) => (
                                                                    <button
                                                                        key={leg.id}
                                                                        onClick={() => openSavedTrace(leg)}
                                                                        className="block w-full truncate rounded-md py-1.5 pl-4 pr-1.5 text-left text-[11px] text-gray-200 active:bg-white/10"
                                                                    >
                                                                        {leg.name}{' '}
                                                                        <span className="text-gray-500">
                                                                            ({leg.points.length} pins)
                                                                        </span>
                                                                    </button>
                                                                ))}
                                                            </div>
                                                        ),
                                                    )
                                                )}
                                            </div>
                                        )}
                                        {capturedCoords.length === 0 ? (
                                            <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3 text-[11px] leading-snug text-gray-400">
                                                Tap the chart along your intended track — each leg is checked for depth,
                                                markers and land as you go. Zoom right in for tight channels. Drag a pin
                                                to nudge it; tap a pin to delete it or insert after it.
                                                <div className="pt-1">
                                                    <span className="text-emerald-300">●</span> good water ·{' '}
                                                    <span className="text-amber-300">●</span> check it ·{' '}
                                                    <span className="text-red-400">●</span> no-go at low tide
                                                </div>
                                            </div>
                                        ) : (
                                            // THE one scroller — flex-1 min-h-0 soaks up
                                            // the card's slack and scrolls; every footer
                                            // action below keeps min-height:auto so it
                                            // stays pinned (Shane 2026-07-17).
                                            <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 py-2">
                                                {capturedCoords.map((c, i) => {
                                                    if (i === 0)
                                                        return (
                                                            <div
                                                                key="p0"
                                                                className="font-mono text-[10px] text-gray-500"
                                                            >
                                                                <span className="text-amber-400">1.</span>{' '}
                                                                {c.lat.toFixed(5)}, {c.lon.toFixed(5)}
                                                            </div>
                                                        );
                                                    const v = legVerdicts[i - 1];
                                                    const dot = !v
                                                        ? 'text-gray-500'
                                                        : v.grade === 'danger'
                                                          ? 'text-red-400'
                                                          : v.grade === 'caution'
                                                            ? 'text-amber-300'
                                                            : 'text-emerald-300';
                                                    // A clear leg normally reads "clear — N m least",
                                                    // but a green 'info' note (e.g. "Red mark to your
                                                    // port — correct side heading in") takes its place
                                                    // so a right mark-pass shows its confirmation.
                                                    const infoNote = v?.issues.find((iss) => iss.severity === 'info');
                                                    const msg = !v
                                                        ? 'checking…'
                                                        : v.grade === 'clear'
                                                          ? infoNote
                                                              ? infoNote.message
                                                              : v.minDepthM !== null
                                                                ? `clear — ${v.minDepthM.toFixed(1)} m least`
                                                                : 'clear'
                                                          : (v.issues.find((iss) => iss.severity !== 'info')?.message ??
                                                            v.grade);
                                                    // Tap a leg row → fly to the MARK it's
                                                    // about (haloed) when there is one, else
                                                    // the problem spot / leg midpoint.
                                                    const firstIssue = v?.issues[0];
                                                    const spot = firstIssue?.mark ??
                                                        firstIssue?.at ??
                                                        v?.minAt ?? {
                                                            lat: (capturedCoords[i - 1].lat + c.lat) / 2,
                                                            lon: (capturedCoords[i - 1].lon + c.lon) / 2,
                                                        };
                                                    return (
                                                        <div
                                                            key={i}
                                                            onClick={() => {
                                                                const m = mapRef.current;
                                                                if (!m) return;
                                                                triggerHaptic('light');
                                                                m.flyTo({
                                                                    center: [spot.lon, spot.lat],
                                                                    zoom: Math.max(m.getZoom(), 15),
                                                                    duration: 700,
                                                                });
                                                                if (firstIssue?.mark) pulseMarkHalo(firstIssue.mark);
                                                            }}
                                                            className="cursor-pointer active:opacity-70"
                                                        >
                                                            <div className="flex items-start gap-1.5 text-[11px] leading-tight">
                                                                <span className={`${dot} font-black`}>
                                                                    {v?.grade === 'danger'
                                                                        ? '⛔'
                                                                        : v?.grade === 'caution'
                                                                          ? '⚠'
                                                                          : '●'}
                                                                </span>
                                                                <span className="text-gray-200">
                                                                    <span className="font-mono text-gray-400">
                                                                        {i}→{i + 1}
                                                                    </span>{' '}
                                                                    {msg}
                                                                </span>
                                                            </div>
                                                            {v &&
                                                                (tideLabels[i - 1] ||
                                                                    v.nudge ||
                                                                    v.issues.length > 1) && (
                                                                    <div className="pl-4 text-[10px] leading-tight text-gray-400">
                                                                        {v.issues.slice(1).map((iss, k) => (
                                                                            <div
                                                                                key={k}
                                                                                onClick={(e) => {
                                                                                    const tgt = iss.mark ?? iss.at;
                                                                                    const m = mapRef.current;
                                                                                    if (!tgt || !m) return;
                                                                                    e.stopPropagation();
                                                                                    triggerHaptic('light');
                                                                                    m.flyTo({
                                                                                        center: [tgt.lon, tgt.lat],
                                                                                        zoom: Math.max(m.getZoom(), 15),
                                                                                        duration: 700,
                                                                                    });
                                                                                    if (iss.mark)
                                                                                        pulseMarkHalo(iss.mark);
                                                                                }}
                                                                                className={
                                                                                    iss.mark || iss.at
                                                                                        ? 'cursor-pointer underline decoration-dotted underline-offset-2 active:opacity-70'
                                                                                        : undefined
                                                                                }
                                                                            >
                                                                                · {iss.message}
                                                                            </div>
                                                                        ))}
                                                                        {tideLabels[i - 1] && (
                                                                            <div>🌊 {tideLabels[i - 1]}</div>
                                                                        )}
                                                                        {v.nudge && <div>💡 {v.nudge}</div>}
                                                                    </div>
                                                                )}
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        )}
                                        <div className="flex gap-1.5 border-t border-white/10 px-3 py-2">
                                            <button
                                                onClick={() => {
                                                    triggerHaptic('light');
                                                    setPlotArmed((a) => !a);
                                                }}
                                                aria-pressed={plotArmed}
                                                className={`flex-1 rounded-lg py-1.5 text-[11px] font-black uppercase tracking-wide active:scale-95 ${
                                                    plotArmed
                                                        ? 'bg-amber-500/20 text-amber-300'
                                                        : 'bg-white/10 text-gray-300'
                                                }`}
                                            >
                                                {plotArmed ? '✏️ Plot' : '⏸ Paused'}
                                            </button>
                                            <button
                                                onClick={undoTrace}
                                                disabled={!canUndoTrace}
                                                className="flex-1 rounded-lg bg-white/5 py-1.5 text-[11px] font-black uppercase tracking-wide text-gray-300 active:scale-95 disabled:opacity-40"
                                            >
                                                Undo
                                            </button>
                                            <button
                                                onClick={redoTrace}
                                                disabled={!canRedoTrace}
                                                className="flex-1 rounded-lg bg-white/5 py-1.5 text-[11px] font-black uppercase tracking-wide text-gray-300 active:scale-95 disabled:opacity-40"
                                            >
                                                Redo
                                            </button>
                                            {/* Copy PARKED (Shane 2026-07-17: rarely used
                                                mid-plot, and it made the controls row a
                                                6-button fat-finger squeeze). Folded away so
                                                Plot/Undo/Redo/Clear/⇄ get the width;
                                                copyCapturedCoords stays wired. */}
                                            {TRACER_COPY_BUTTON_VISIBLE && (
                                                <button
                                                    onClick={() => void copyCapturedCoords()}
                                                    disabled={capturedCoords.length === 0}
                                                    className="flex-1 rounded-lg bg-white/5 py-1.5 text-[11px] font-black uppercase tracking-wide text-gray-300 active:scale-95 disabled:opacity-40"
                                                >
                                                    {coordsCopied ? 'Copied ✓' : 'Copy'}
                                                </button>
                                            )}
                                            <button
                                                onClick={() => {
                                                    triggerHaptic('light');
                                                    setSelectedPin(null);
                                                    setInsertAfter(null);
                                                    insertAfterRef.current = null;
                                                    // Chained leg: first Clear resets TO the locked
                                                    // pin; clearing again abandons the leg entirely
                                                    // (drops the lock, empty sheet).
                                                    const anchor = legAnchorRef.current;
                                                    if (anchor && capturedCoords.length > 1) {
                                                        setCapturedCoords([anchor.anchor]);
                                                        flashTraceFeedback(
                                                            `Back to the ${anchor.fromName} start — Clear again to abandon the leg`,
                                                        );
                                                        return;
                                                    }
                                                    if (anchor) setLegAnchor(null);
                                                    setCapturedCoords([]);
                                                    // An AUTO name belongs to the cleared route —
                                                    // wipe it with the pins. A typed name survives.
                                                    setTraceName((cur) => (cur === lastAutoNameRef.current ? '' : cur));
                                                }}
                                                disabled={capturedCoords.length === 0}
                                                className="flex-1 rounded-lg bg-white/5 py-1.5 text-[11px] font-black uppercase tracking-wide text-gray-400 active:scale-95 disabled:opacity-40"
                                            >
                                                Clear
                                            </button>
                                            {/* Return-trip flip: start↔finish swap, legs
                                                re-grade for the opposite heading. */}
                                            <button
                                                onClick={reverseTrace}
                                                disabled={capturedCoords.length < 2}
                                                aria-label="Reverse route — plot the return trip"
                                                title="Reverse route"
                                                className="rounded-lg bg-white/5 px-2.5 py-1.5 text-[13px] font-black text-sky-300 active:scale-95 disabled:opacity-40"
                                            >
                                                ⇄
                                            </button>
                                        </div>
                                        {capturedCoords.length >= 2 && (
                                            <div className="flex gap-1.5 border-t border-white/10 px-3 py-2">
                                                <button
                                                    onClick={() => {
                                                        triggerHaptic('light');
                                                        setShowReport(true);
                                                    }}
                                                    className="flex-1 rounded-lg bg-white/10 py-2 text-[11px] font-black uppercase tracking-wide text-gray-100 active:scale-95"
                                                >
                                                    📋 Route report
                                                </button>
                                                {/* ⚡ routes the leg INTO the highlighted pin (tap a
                                                    pin first) via the real inshore engine — follows
                                                    deep water, never crosses land, breaks long runs
                                                    into depth-checkable, tide-aware pins. No pin
                                                    selected → the last leg. PARKED for now
                                                    (AUTO_ROUTE_BUTTON_VISIBLE) — engine stays wired. */}
                                                {AUTO_ROUTE_BUTTON_VISIBLE && (
                                                    <button
                                                        onClick={autoRouteLeg}
                                                        disabled={fixBusyLeg !== null}
                                                        className="flex-1 rounded-lg bg-violet-500/20 py-2 text-[11px] font-black uppercase tracking-wide text-violet-300 active:scale-95 disabled:opacity-50"
                                                    >
                                                        {fixBusyLeg !== null ? '⏳ Routing…' : '⚡ Auto route'}
                                                    </button>
                                                )}
                                            </div>
                                        )}
                                        {/* Departure date/time (Shane 2026-07-16): anchors the
                                            tide windows at each leg's ETA, the departure-window
                                            headline, and the report's per-waypoint weather.
                                            Empty = leave now. Two lines (date, then 24-hour
                                            selects) so neither is squeezed. */}
                                        <div className="space-y-1.5 border-t border-white/10 px-3 py-2">
                                            <div className="flex items-baseline justify-between">
                                                <span className="text-[10px] font-black uppercase tracking-widest text-gray-400">
                                                    🕐 Depart
                                                </span>
                                                {departureMs === null && (
                                                    <span className="text-[10px] font-bold text-emerald-300/80">
                                                        now
                                                    </span>
                                                )}
                                            </div>
                                            <div className="flex gap-1.5">
                                                <input
                                                    type="date"
                                                    value={
                                                        departureMs !== null
                                                            ? msToLocalInput(departureMs).slice(0, 10)
                                                            : msToLocalInput(Date.now()).slice(0, 10)
                                                    }
                                                    // Past dates greyed out (Shane 2026-07-17) —
                                                    // can't plan to leave yesterday.
                                                    min={msToLocalInput(Date.now()).slice(0, 10)}
                                                    onChange={(e) => {
                                                        triggerHaptic('light');
                                                        if (!e.target.value) {
                                                            setDepartureMs(null);
                                                            return;
                                                        }
                                                        const time =
                                                            departureMs !== null
                                                                ? msToLocalInput(departureMs).slice(11, 16)
                                                                : msToLocalInput(Date.now()).slice(11, 16);
                                                        const t = new Date(`${e.target.value}T${time}`).getTime();
                                                        if (Number.isFinite(t)) setDepartureMs(t);
                                                    }}
                                                    aria-label="Departure date"
                                                    className="min-w-0 flex-[3] rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-[11px] text-gray-200 [color-scheme:dark] focus:border-sky-500/50 focus:outline-none"
                                                />
                                                {/* 24-hour time (Shane 2026-07-17: the web time
                                                    input's AM/PM clipped in the card). */}
                                                <TimePicker24
                                                    value={
                                                        departureMs !== null
                                                            ? {
                                                                  h: Number(msToLocalInput(departureMs).slice(11, 13)),
                                                                  m: Number(msToLocalInput(departureMs).slice(14, 16)),
                                                              }
                                                            : null
                                                    }
                                                    dateStr={
                                                        departureMs !== null
                                                            ? msToLocalInput(departureMs).slice(0, 10)
                                                            : ''
                                                    }
                                                    onChange={(h, m) => {
                                                        triggerHaptic('light');
                                                        const date =
                                                            departureMs !== null
                                                                ? msToLocalInput(departureMs).slice(0, 10)
                                                                : msToLocalInput(Date.now()).slice(0, 10);
                                                        const p = (n: number) => String(n).padStart(2, '0');
                                                        const t = new Date(`${date}T${p(h)}:${p(m)}`).getTime();
                                                        if (Number.isFinite(t)) setDepartureMs(t);
                                                    }}
                                                    selectClassName="min-w-0 rounded-lg border border-white/10 bg-white/5 px-1.5 py-1.5 text-[11px] text-gray-200 [color-scheme:dark] focus:border-sky-500/50 focus:outline-none"
                                                />
                                            </div>
                                            {/* OK button REMOVED (Shane 2026-07-17): it only
                                                existed to blur the native time wheel closed,
                                                and the 24-hour selects dismiss themselves. */}
                                            {departureMs !== null && (
                                                <button
                                                    onClick={() => {
                                                        triggerHaptic('light');
                                                        (document.activeElement as HTMLElement | null)?.blur?.();
                                                        setDepartureMs(null);
                                                    }}
                                                    className="w-full rounded-lg bg-white/10 py-1.5 text-[11px] font-black uppercase tracking-wide text-gray-300 active:scale-95"
                                                >
                                                    Now
                                                </button>
                                            )}
                                        </div>
                                        {/* Build a route by keying GPS fixes — decimal, DMM
                                            ("27 08.5S 153 09.2E"), DMS or hemisphere-suffixed.
                                            Each Add drops the next pin (Shane 2026-07-16). */}
                                        <div className="flex gap-1.5 border-t border-white/10 px-3 py-2">
                                            <input
                                                value={coordEntry}
                                                onChange={(e) => setCoordEntry(e.target.value)}
                                                onKeyDown={(e) => {
                                                    if (e.key === 'Enter') {
                                                        e.preventDefault();
                                                        addCoordPin();
                                                    }
                                                }}
                                                inputMode="text"
                                                autoCapitalize="characters"
                                                autoCorrect="off"
                                                spellCheck={false}
                                                placeholder="Add a GPS Fix"
                                                className="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 font-mono text-[11px] text-gray-200 placeholder:text-gray-500 focus:border-emerald-500/50 focus:outline-none"
                                            />
                                            <button
                                                onClick={addCoordPin}
                                                disabled={!coordEntry.trim()}
                                                className="shrink-0 rounded-lg bg-emerald-500/20 px-3 py-1.5 text-[11px] font-black uppercase tracking-wide text-emerald-300 active:scale-95 disabled:opacity-40"
                                            >
                                                ＋ Add
                                            </button>
                                        </div>
                                        <div className="space-y-1.5 border-t border-white/10 px-3 py-2">
                                            <input
                                                ref={traceNameInputRef}
                                                value={traceName}
                                                onChange={(e) => {
                                                    setTraceName(e.target.value);
                                                    setOverwriteArm(null);
                                                }}
                                                placeholder="Name this route…"
                                                className="w-full rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-[11px] text-gray-200 placeholder:text-gray-500 focus:border-amber-500/50 focus:outline-none"
                                            />
                                            <div className="flex gap-1.5">
                                                <button
                                                    onClick={saveCurrentTrace}
                                                    disabled={capturedCoords.length < 2}
                                                    className={`flex-1 rounded-lg py-1.5 text-[11px] font-black uppercase tracking-wide active:scale-95 disabled:opacity-40 ${
                                                        overwriteArm
                                                            ? 'bg-red-500/25 text-red-300'
                                                            : 'bg-amber-500/20 text-amber-300'
                                                    }`}
                                                >
                                                    {overwriteArm ? 'Overwrite?' : 'Save'}
                                                </button>
                                                {/* Dev-only: CuratedFairway JSON export is
                                        Shane's flywheel workflow, not a punter
                                        button ("Fairway" read as "show me the
                                        fairway" and appeared to do nothing).
                                        Rides the existing seaway debug toggle. */}
                                                {seawayDebugVisible && (
                                                    <button
                                                        onClick={() => void copyFairwaySnippet()}
                                                        disabled={capturedCoords.length < 2}
                                                        className="flex-1 rounded-lg bg-sky-500/15 py-1.5 text-[11px] font-black uppercase tracking-wide text-sky-300 active:scale-95 disabled:opacity-40"
                                                    >
                                                        Fairway
                                                    </button>
                                                )}
                                                {SAIL_IT_BUTTON_VISIBLE &&
                                                    (() => {
                                                        // No-go acknowledgment: with danger legs the
                                                        // first tap arms a red "Sail anyway?" — the
                                                        // skipper owns the line, but the green button
                                                        // must not endorse a route this same screen
                                                        // graded as crossing land. Never hard-blocks.
                                                        const hasDanger = traceHealth(legVerdicts).danger > 0;
                                                        const needsArm = hasDanger && !sailArmed;
                                                        return (
                                                            <button
                                                                onClick={() => {
                                                                    if (needsArm) {
                                                                        triggerHaptic('heavy');
                                                                        setSailArmed(true);
                                                                        return;
                                                                    }
                                                                    setSailArmed(false);
                                                                    void sailTrace();
                                                                }}
                                                                disabled={capturedCoords.length < 2}
                                                                className={`flex-1 rounded-lg py-1.5 text-[11px] font-black uppercase tracking-wide active:scale-95 disabled:opacity-40 ${
                                                                    hasDanger
                                                                        ? 'bg-red-500/25 text-red-300'
                                                                        : 'bg-emerald-500/20 text-emerald-300'
                                                                }`}
                                                            >
                                                                {needsArm
                                                                    ? 'Sail it'
                                                                    : hasDanger
                                                                      ? 'Sail anyway?'
                                                                      : 'Sail it'}
                                                            </button>
                                                        );
                                                    })()}
                                            </div>
                                            {TRACER_CARD_LIBRARY_VISIBLE && (
                                                <button
                                                    onClick={() => void pasteTrace()}
                                                    className="w-full text-left text-[10px] font-bold uppercase tracking-wide text-gray-400 active:text-gray-200"
                                                >
                                                    📥 Paste coords from a mate
                                                </button>
                                            )}
                                            {TRACER_CARD_SHARE_VISIBLE && capturedCoords.length >= 2 && (
                                                <button
                                                    onClick={() => void shareTrace()}
                                                    className="w-full text-left text-[10px] font-bold uppercase tracking-wide text-gray-400 active:text-gray-200"
                                                >
                                                    📤 Share this route with a mate
                                                </button>
                                            )}
                                            {TRACER_CARD_SHARE_VISIBLE && capturedCoords.length >= 2 && (
                                                <button
                                                    onClick={() => {
                                                        if (shareArmed) {
                                                            void submitShare();
                                                        } else {
                                                            triggerHaptic('light');
                                                            setShareArmed(true);
                                                        }
                                                    }}
                                                    className={`w-full text-left text-[10px] font-bold uppercase tracking-wide active:text-gray-200 ${shareArmed ? 'text-emerald-300' : 'text-gray-400'}`}
                                                >
                                                    {shareArmed
                                                        ? '✓ Confirm: submits for review, name not shown — tap again'
                                                        : '🌐 Share with all skippers'}
                                                </button>
                                            )}
                                            {TRACER_CARD_LIBRARY_VISIBLE && (
                                                <>
                                                    <button
                                                        onClick={() => void openVoyagePicker()}
                                                        className="w-full text-left text-[10px] font-bold uppercase tracking-wide text-gray-400 active:text-gray-200"
                                                    >
                                                        {showVoyagePicker ? '▾' : '▸'} 🛥 From a past voyage
                                                    </button>
                                                    {showVoyagePicker &&
                                                        (voyageTracks.length === 0 ? (
                                                            <div className="pl-4 text-[10px] text-gray-500">
                                                                No sailed sea voyages yet — finish one first.
                                                            </div>
                                                        ) : (
                                                            voyageTracks.map((t) => (
                                                                <button
                                                                    key={t.voyageId}
                                                                    onClick={() => void loadVoyageAsTrace(t)}
                                                                    className="block w-full truncate pl-4 text-left text-[11px] text-gray-200 active:opacity-70"
                                                                >
                                                                    {t.label}{' '}
                                                                    <span className="text-gray-500">{t.sublabel}</span>
                                                                    {t.isLocal && (
                                                                        <span className="ml-1 rounded bg-white/10 px-1 text-[9px] font-bold text-gray-400">
                                                                            LOCAL
                                                                        </span>
                                                                    )}
                                                                </button>
                                                            ))
                                                        ))}
                                                </>
                                            )}
                                            {seawayDebugVisible && (
                                                <button
                                                    onClick={() => {
                                                        triggerHaptic('light');
                                                        setShowQueue((q) => !q);
                                                        if (!showQueue) void refreshQueue();
                                                    }}
                                                    className="w-full text-left text-[10px] font-bold uppercase tracking-wide text-amber-400 active:text-amber-200"
                                                >
                                                    {showQueue ? '▾' : '▸'} ⚓ Harbourmaster queue
                                                </button>
                                            )}
                                            {seawayDebugVisible &&
                                                showQueue &&
                                                (pendingRoutes.length === 0 ? (
                                                    <div className="pl-4 text-[10px] text-gray-500">Queue's empty.</div>
                                                ) : (
                                                    pendingRoutes.map((r) => (
                                                        <div
                                                            key={r.id}
                                                            className="flex items-center gap-1.5 pl-4 text-[11px]"
                                                        >
                                                            <button
                                                                onClick={() => {
                                                                    triggerHaptic('light');
                                                                    rebaseHistoryRef.current = true; // load → Undo floor
                                                                    setCapturedCoords(r.points);
                                                                    const mid =
                                                                        r.points[Math.floor(r.points.length / 2)];
                                                                    mapRef.current?.flyTo({
                                                                        center: [mid.lon, mid.lat],
                                                                        zoom: 12.5,
                                                                        duration: 900,
                                                                    });
                                                                }}
                                                                className="flex-1 truncate text-left text-gray-200 active:opacity-70"
                                                            >
                                                                {r.name}{' '}
                                                                <span className="text-gray-500">
                                                                    ({r.points.length} pins
                                                                    {r.draftM ? ` · ${r.draftM.toFixed(1)} m` : ''})
                                                                </span>
                                                            </button>
                                                            <button
                                                                onClick={() => void handleReview(r.id, 'approved')}
                                                                className="px-1 font-black text-emerald-300 active:scale-95"
                                                            >
                                                                ✓
                                                            </button>
                                                            <button
                                                                onClick={() => void handleReview(r.id, 'rejected')}
                                                                className="px-1 font-black text-red-400 active:scale-95"
                                                            >
                                                                ✕
                                                            </button>
                                                        </div>
                                                    ))
                                                ))}
                                            {TRACER_CARD_LIBRARY_VISIBLE && savedTraces.length > 0 && (
                                                <button
                                                    onClick={() => setShowSavedTraces((s) => !s)}
                                                    className="w-full text-left text-[10px] font-bold uppercase tracking-wide text-gray-400"
                                                >
                                                    {showSavedTraces ? '▾' : '▸'} Saved routes ({savedTraces.length})
                                                </button>
                                            )}
                                            {TRACER_CARD_LIBRARY_VISIBLE &&
                                                showSavedTraces &&
                                                savedTraces.map((t) => (
                                                    <div key={t.id} className="flex items-center gap-1.5 text-[11px]">
                                                        <button
                                                            onClick={() => {
                                                                triggerHaptic('light');
                                                                rebaseHistoryRef.current = true; // opened a saved route → Undo floor
                                                                setCapturedCoords(t.points);
                                                                setTraceName(t.name);
                                                                setShowSavedTraces(false);
                                                                // A route built on the desktop is usually
                                                                // for somewhere else — without the flyTo its
                                                                // pins land off-screen and the tap looks
                                                                // like a no-op (the queue loader above
                                                                // already does this).
                                                                const mid = t.points[Math.floor(t.points.length / 2)];
                                                                mapRef.current?.flyTo({
                                                                    center: [mid.lon, mid.lat],
                                                                    zoom: 12.5,
                                                                    duration: 900,
                                                                });
                                                            }}
                                                            className="flex-1 truncate text-left text-gray-200 active:opacity-70"
                                                        >
                                                            {t.name}{' '}
                                                            <span className="text-gray-500">
                                                                ({t.points.length} pins)
                                                            </span>
                                                        </button>
                                                        <button
                                                            onClick={() => {
                                                                // Two-tap confirm — a bare ✕ silently
                                                                // destroyed a saved route (audit).
                                                                if (confirmDeleteId === t.id) {
                                                                    deleteTrace(t.id);
                                                                    setSavedTraces(loadSavedTraces());
                                                                    setConfirmDeleteId(null);
                                                                } else {
                                                                    triggerHaptic('light');
                                                                    setConfirmDeleteId(t.id);
                                                                }
                                                            }}
                                                            className={`px-1 ${confirmDeleteId === t.id ? 'font-black text-red-400' : 'text-gray-500 active:text-red-400'}`}
                                                        >
                                                            {confirmDeleteId === t.id ? 'sure?' : '✕'}
                                                        </button>
                                                    </div>
                                                ))}
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                )}
                <TraceReportModal
                    open={showReport}
                    onClose={() => setShowReport(false)}
                    pins={capturedCoords}
                    routeName={traceName}
                    verdicts={legVerdicts}
                    tideLabels={tideLabels}
                    departureLabel={departureLabel}
                    ackedLegs={ackedLegs}
                    fixBusy={fixBusyLeg}
                    vesselName={settings.vessel?.name}
                    draftM={vesselDraftMetres(settings.vessel)}
                    cruisingSpeedKts={settings.vessel?.cruisingSpeed}
                    departureMs={departureMs}
                    onFlyTo={(pt) => {
                        setShowReport(false);
                        mapRef.current?.flyTo({ center: [pt.lon, pt.lat], zoom: 15, duration: 800 });
                    }}
                    onFixLeg={onFixLeg}
                    onFixAll={onFixAll}
                    onAckLeg={(i) => {
                        triggerHaptic('light');
                        setAckedLegs((prev) => new Set(prev).add(i));
                    }}
                />

                {/* Lightning legend pill — rendered OUTSIDE the AisLegend
                    Suspense block. The eager-imported BlitzortungAttribution
                    used to live inside that Suspense, which meant if any
                    sibling lazy component (AisLegend, etc.) suspended, the
                    fallback={null} would hide the entire block — including
                    our chip. The chip then "disappeared" even though its
                    own code was loaded and ready. Now it stands alone so
                    it renders independently of any other component's
                    loading state. */}
                {/* Live-tide badge — the permanent, unmistakable "you are
                    NOT looking at chart datum" marker (design 2026-07-11).
                    Teal = live offset applied; amber = mode on but no tide
                    data, chart fell back to LAT. Tap = kill switch. */}
                {tideDepthMode && !embedded && !isPinView && !pickerMode && (
                    <>
                        <button
                            onClick={() => {
                                // Scrubbed WITH data = snap back to now; otherwise
                                // (live, or no data at all) = kill switch. A
                                // no-data badge must never eat the first tap as a
                                // silent scrub reset (review minor).
                                triggerHaptic('light');
                                if (tideScrubQ > 0 && tideOffsetInfo) {
                                    setTideScrubQ(0);
                                } else {
                                    onToggleTideDepth();
                                }
                            }}
                            aria-label={
                                tideScrubQ > 0 && tideOffsetInfo
                                    ? 'Depths shown at a future tide — tap to return to now'
                                    : 'Live tide depth is on — tap to return to chart datum'
                            }
                            className="absolute left-1/2 top-16 z-[9990] -translate-x-1/2 whitespace-nowrap rounded-full border px-4 py-2.5 text-[11px] font-black tracking-wide shadow-lg active:scale-95"
                            style={
                                tideOffsetInfo && tideScrubQ > 0
                                    ? {
                                          background: 'rgba(49, 27, 95, 0.92)',
                                          borderColor: 'rgba(167, 139, 250, 0.5)',
                                          color: '#c4b5fd',
                                      }
                                    : tideOffsetInfo
                                      ? {
                                            background: 'rgba(13, 63, 70, 0.92)',
                                            borderColor: 'rgba(45, 212, 191, 0.45)',
                                            color: '#5eead4',
                                        }
                                      : {
                                            background: 'rgba(69, 51, 8, 0.92)',
                                            borderColor: 'rgba(251, 191, 36, 0.45)',
                                            color: '#fcd34d',
                                        }
                            }
                        >
                            {tideOffsetInfo
                                ? `${
                                      tideScrubQ > 0
                                          ? `AT ${new Date(Date.now() + tideScrubQ * 900_000).toLocaleTimeString(
                                                'en-AU',
                                                { hour: '2-digit', minute: '2-digit', hour12: false },
                                            )}`
                                          : 'LIVE DEPTH'
                                  } ${tideOffsetInfo.offsetM >= 0 ? '+' : ''}${tideOffsetInfo.offsetM.toFixed(1)} m ${
                                      tideOffsetInfo.trend === 'rising' ? '↑' : '↓'
                                  }${tideOffsetInfo.stationName ? ` · ${tideOffsetInfo.stationName}` : ''}${
                                      tideOffsetInfo.approx ? ' · approx' : ''
                                  }${tideScrubQ > 0 ? ' · tap for now' : ''}`
                                : 'LIVE DEPTH — no tide data, showing chart datum'}
                        </button>
                        {/* The scrubber (#3): slide through the next 24 h and
                            watch the banks flood and dry — or park it on your
                            ETA. Re-samples the fetched curve; no network. */}
                        {tideOffsetInfo && (
                            <div className="absolute left-1/2 top-[6.4rem] z-[9989] w-60 -translate-x-1/2 rounded-xl border border-white/10 bg-slate-900/85 px-3 pb-1 pt-1.5 shadow-lg">
                                <input
                                    type="range"
                                    min={0}
                                    max={96}
                                    step={1}
                                    value={tideScrubQ}
                                    onChange={(e) => setTideScrubQ(Number(e.target.value))}
                                    aria-label="Scrub the tide through the next 24 hours"
                                    className={`w-full ${tideScrubQ > 0 ? 'accent-violet-400' : 'accent-teal-400'}`}
                                />
                                <div className="flex justify-between text-[11px] font-bold text-gray-400">
                                    <span>now</span>
                                    <span>+12 h</span>
                                    <span>+24 h</span>
                                </div>
                            </div>
                        )}
                    </>
                )}
                {/* Datum chip — the one-line honesty note (2026-07-11 #4).
                    Mode-aware: chart datum vs live tide, so the corner of
                    the chart always says which water you're reading. */}
                {encCellCount > 0 && encVisible && !embedded && !pickerMode && !isPinView && (
                    <button
                        onClick={() => {
                            triggerHaptic('light');
                            setChartKeyOpen((v) => !v);
                        }}
                        aria-label="What the chart colours and numbers mean"
                        className="absolute bottom-1 left-1/2 z-[9980] -translate-x-1/2 whitespace-nowrap rounded-md bg-slate-900/70 px-2 py-1 text-[11px] font-semibold tracking-wide text-gray-300 active:scale-95"
                    >
                        {tideDepthMode && tideOffsetInfo
                            ? `depths at predicted tide (${tideOffsetInfo.offsetM >= 0 ? '+' : ''}${tideOffsetInfo.offsetM.toFixed(1)} m)`
                            : 'depths in metres at low tide (LAT)'}
                        <span className="ml-1 text-gray-500">· key</span>
                    </button>
                )}
                {/* Hydration chip — dark water that's a DOWNLOAD in
                    flight must never read as "no chart here". */}
                {encHydration.remaining > 0 && encVisible && !embedded && !pickerMode && !isPinView && (
                    <div
                        className="pointer-events-none absolute bottom-6 left-1/2 z-[9980] -translate-x-1/2 whitespace-nowrap rounded-full border border-teal-500/30 bg-slate-900/85 px-3 py-1 text-[10px] font-bold text-teal-300 shadow-lg"
                        aria-live="polite"
                    >
                        Chart downloading… ({encHydration.total - encHydration.remaining + 1} of {encHydration.total})
                    </div>
                )}
                {/* Night-dim quick toggle (closing audit: the ☾ lived only at
                    the BOTTOM of the chart-modes dropdown, behind a scroll —
                    at night, when you need it, menus blind you first). One
                    tap from the map; same persisted state as the menu row.
                    Same 104px row as the zoom pill, tucked just off the
                    compass rose's RIGHT edge (Shane 2026-07-17: on the other
                    side of the rose, not the far side of the screen). The
                    rose is fixed left 98px, 116px wide → right edge 214px;
                    the moon sits at 224px with a ~10px gap. Zoom pill left,
                    rose centre, moon just past it.
                    PLANNING-ONLY (Shane 2026-07-17: "remove the half moon from
                    the charts page — it is for the planning page only"): gated
                    on coordCaptureMode so the bare browsing chart stays clean.
                    The ☾ row inside the chart-modes menu still covers it there. */}
                {/* NOT gated on encVisible (Shane 2026-07-18: "i have lost my half
                    moon button"). It used to be, which meant the control vanished
                    for anyone whose ENC master toggle was off — and since the
                    plotting keel floor (e75104d0) force-shows the depth read while
                    the tracer is up REGARDLESS of that toggle, the moon was
                    disappearing exactly when the chart it dims was on screen.
                    coordCaptureMode alone is the honest gate: if we're plotting,
                    there is an ENC chart to dim. */}
                {coordCaptureMode && !embedded && !pickerMode && !isPinView && (
                    <button
                        onClick={() => setNightDim(!nightDim)}
                        aria-label="Toggle night dim"
                        aria-pressed={nightDim}
                        className="absolute top-[104px] left-[224px] z-[700] flex h-11 w-11 items-center justify-center rounded-full border shadow-lg backdrop-blur-md active:scale-95"
                        style={{
                            background: nightDim ? 'rgba(220, 80, 60, 0.30)' : 'rgba(15, 23, 42, 0.85)',
                            borderColor: 'rgba(220, 80, 60, 0.35)',
                            color: '#e07a5f',
                            fontSize: 18,
                        }}
                    >
                        ☾
                    </button>
                )}
                {/* No-coverage chip — uncharted water at nav zoom must never
                    read like the chart layer is merely off (2026-07-17 audit). */}
                {encNoCoverage &&
                    encHydration.remaining === 0 &&
                    encVisible &&
                    !embedded &&
                    !pickerMode &&
                    !isPinView && (
                        <div
                            className="pointer-events-none absolute bottom-6 left-1/2 z-[9980] -translate-x-1/2 whitespace-nowrap rounded-full border border-amber-500/30 bg-slate-900/85 px-3 py-1 text-[11px] font-bold text-amber-300 shadow-lg"
                            aria-live="polite"
                        >
                            No chart coverage here — depths unverified
                        </div>
                    )}
                {/* Chart key — the legend for mere mortals (2026-07-11 #2).
                    Auto-opens once on first charted render; afterwards via
                    the ChartModes row. */}
                {chartKeyOpen && !embedded && !pickerMode && !isPinView && (
                    <div className="absolute bottom-44 right-2 z-[9992] w-64 max-h-[calc(100dvh-12rem)] overflow-y-auto overscroll-contain rounded-2xl border border-white/10 bg-slate-900/95 p-3 shadow-2xl">
                        <div className="mb-2 flex items-center justify-between">
                            <span className="text-[11px] font-black uppercase tracking-widest text-amber-300">
                                Chart key
                            </span>
                            <button
                                onClick={() => setChartKeyOpen(false)}
                                aria-label="Close chart key"
                                className="text-xs font-bold text-gray-400"
                            >
                                ✕
                            </button>
                        </div>
                        {/* CHART-MODE ramp only. Over imagery the DEPARE fills are at
                            opacity 0 and the glaze paints instead, so showing this ramp
                            there taught a legend for something not on the screen
                            (audit 2026-07-19). */}
                        {!imageryOn && (
                        <div className="mb-1 flex overflow-hidden rounded-md border border-white/10">
                            {(
                                [
                                    [DEPARE_BAND_COLORS.drying, 'dries'],
                                    [DEPARE_BAND_COLORS.b0to2, '0–2'],
                                    [DEPARE_BAND_COLORS.b2to5, '2–5'],
                                    [DEPARE_BAND_COLORS.b5to10, '5–10'],
                                    [DEPARE_BAND_COLORS.b10to20, '10–20'],
                                    [DEPARE_BAND_COLORS.b20to50, '20–50'],
                                    [DEPARE_BAND_COLORS.b50plus, '50+'],
                                ] as const
                            ).map(([hex, label]) => (
                                <div key={label} className="flex-1">
                                    <div style={{ background: hex, height: 14 }} />
                                    <div className="bg-slate-800 py-0.5 text-center text-[10px] font-bold text-gray-300">
                                        {label}
                                    </div>
                                </div>
                            ))}
                        </div>
                        )}
                        <div className="space-y-1 text-[10px] leading-snug text-gray-300">
                            {!imageryOn && (
                                <div>Bluer = shallower — like the paper chart. White = deep. Khaki dries at low tide.</div>
                            )}
                            {/* The datum flips with the tide toggle, so the sentence has
                                to as well — while live tide is on these are NOT lowest-tide
                                numbers, and saying so would be the one lie a skipper acts on
                                directly (audit 2026-07-19). */}
                            {tideDepthMode ? (
                                <div>
                                    Numbers are metres of water RIGHT NOW (charted + predicted tide) — 3₄ means 3.4 m.
                                </div>
                            ) : (
                                <div>
                                    Numbers are metres at the lowest tide (LAT) — 3₄ means 3.4 m. Olive numbers dry.
                                </div>
                            )}
                            {imageryOn ? (
                                // The keel-keyed glaze was never taught anywhere
                                // (2026-07-12 audit). Gated on imageryOn, NOT
                                // satelliteVisible: HYBRID is the boot base and the
                                // plotting base, so gating on satellite-only taught
                                // the paper-chart key on the very surface that paints
                                // the glaze (Shane 2026-07-18).
                                <div className="text-sky-200">
                                    {/* NOT "draft + 0.5 m" (audit 2026-07-19). White begins
                                        at the ROUTER HAZARD depth — buildDepareSatelliteOpacity
                                        steps to white at h, and h = draft × 1.5 + 0.5
                                        (HazardQueryService:106). draft+0.5 is the SAFETY depth,
                                        which is where the amber band starts — so the old text
                                        contradicted the very next clause, both of them claiming
                                        to define the same edge. */}
                                    Over imagery: bright white glaze = water with the router&apos;s full margin under
                                    your keel (1½× draft + 0.5 m).
                                    {/* The two decision-relevant washes were unexplained (cycle-7 re-audit #8).
                                        Swatches use the real constants so they track the palette. */}
                                    <span style={{ color: CAUTION_BAND_COLOR }}> Light amber</span> = margin-thin (clears
                                    the keel but the router still flags it as a hazard);
                                    <span style={{ color: SHALLOW_CAUTION_COLOR }}> amber</span> = too shallow;
                                    <span style={{ color: DEPARE_BAND_COLORS.drying }}> khaki</span> = dries at low tide.
                                    Bare imagery = no usable depth here — uncharted, unattributed, or surveyed too
                                    coarsely for this zoom. Treat it as unsurveyed.
                                </div>
                            ) : (
                                // COLOURS WERE INVERTED (audit 2026-07-19). This read
                                // "The SLATE contour is your keel's limit" — but the
                                // safety contour is AMBER #f97316 (EncVectorLayer:1165,
                                // "the single most keel-load-bearing line") and #7d8e9b
                                // slate is the ORDINARY contours. The key was naming the
                                // keel limit by the colour of the other line, so a
                                // skipper following it literally picks the wrong one.
                                // "Slate" survived only in comments describing the value
                                // that line USED to be.
                                <div>
                                    The <span className="font-bold text-orange-400">amber</span> contour is your keel&apos;s
                                    limit; thin slate-grey lines join equal depths.
                                </div>
                            )}
                            {!(Number(settings.vessel?.draft) > 0) && (
                                <div className="text-amber-300">
                                    Keel reads use a default 2.5 m draft — set your vessel in Settings.
                                </div>
                            )}
                            {tideDepthMode && (
                                <div className="text-teal-300">
                                    Teal numbers = live tide depth is on (drying numbers stay olive).
                                </div>
                            )}
                        </div>
                        {/* Marks & lights — the buoyage vocabulary the chart
                            renders and the popups decode. The key taught depth
                            ONLY (mission-audit #3b); a helmsman had no static
                            reference for what the coloured marks mean. */}
                        <div className="mt-2 space-y-1 border-t border-white/10 pt-2 text-[10px] leading-snug text-gray-300">
                            <div className="flex items-center justify-between">
                                <span className="font-black uppercase tracking-wider text-gray-200">
                                    Marks &amp; lights
                                </span>
                                {/* Region is DERIVED per cell (ialaRegionForSourceHO →
                                    baked into _icon), not a global assumption — a
                                    region-B cell swaps red and green. And three keyed
                                    rows are not in CLICKABLE_LAYER_IDS, so "tap to read"
                                    was over-promising (audit 2026-07-19). */}
                                <span className="text-[11px] text-gray-400">IALA-A here · most tap to read</span>
                            </div>
                            {/* REAL GLYPHS, not coloured dots (Shane 2026-07-19:
                                "change the circle symbols for proper symbols").
                                They come from getSeamarkIconDefs — the SAME asset the
                                chart paints — so the key cannot drift from the chart.
                                It had: two hexes for Cardinal that exist nowhere in the
                                render stack, the BUOY palette on the light-sector row,
                                an invented grey for Unknown, and a cardinal drawn as
                                TWO bands when cardinals have three (a 50/50
                                yellow-over-black dot literally asserts SOUTH).

                                <img src=data-uri>, never inlined: 13 glyphs share
                                `filter id="s"` and two more share id="g"/"vstripes", so
                                inlining collapses every url(#s) onto the first match and
                                breaks the safe-water stripes and the light glow.

                                Area/line classes have no glyph, so they keep a swatch —
                                but now imported from CAUTION_CLASS_COLOURS /
                                LIGHT_COLOUR_HEX rather than hand-typed. */}
                            <div className="grid grid-cols-2 gap-x-2 gap-y-1.5">
                                {(
                                    [
                                        ['icon', 'sm-buoy-port', 'Port-hand (can)'],
                                        ['icon', 'sm-buoy-starboard', 'Starboard (cone)'],
                                        // All four, because one dot cannot say "cardinal".
                                        ['icons4', 'cardinal', 'Cardinals (N E S W)'],
                                        ['icon', 'sm-safe-water', 'Safe water'],
                                        ['icon', 'sm-isolated-danger', 'Isolated danger'],
                                        ['icon', 'sm-special', 'Special mark'],
                                        // Rendered since the CATLAM pass, never keyed.
                                        ['icon', 'sm-buoy-prefchan-stbd', 'Preferred channel'],
                                        // Was ONE row for nine distinct INT1 glyphs.
                                        ['icon', 'sm-hazard-wreck-dangerous', 'Wreck'],
                                        ['icon', 'sm-hazard-rock', 'Rock / obstruction'],
                                        ['icon', 'sm-light-major', 'Light'],
                                        ['icon', 'sm-anchorage', 'Anchorage'],
                                        ['icon', 'sm-mark-unknown', 'Unknown mark'],
                                        // ── Areas + lines: no glyph, so a swatch is right.
                                        ['sector', '', 'Light sector'],
                                        ['swatch', CAUTION_DEFAULT_COLOUR, 'Restricted / caution'],
                                        // CBLARE and PIPARE are separate match arms — a
                                        // pipeline never paints the cable colour.
                                        ['swatch', CAUTION_CLASS_COLOURS.CBLARE ?? '#7c3aed', 'Submarine cable'],
                                        ['swatch', CAUTION_CLASS_COLOURS.PIPARE ?? '#5b21b6', 'Pipeline'],
                                        ['swatch', CAUTION_CLASS_COLOURS.TSSLPT ?? '#d97706', 'TSS lane / precautionary'],
                                        ['swatch', CAUTION_CLASS_COLOURS.TSEZNE ?? '#c2410c', 'TSS keep-out zone'],
                                        ['swatch', CAUTION_CLASS_COLOURS.MARCUL ?? '#5f7a3a', 'Marine farm'],
                                        ['swatch', CAUTION_CLASS_COLOURS.SBDARE ?? '#8a8a5a', 'Seabed type'],
                                        ['swatch', CAUTION_CLASS_COLOURS.DWRTPT ?? '#0e7490', 'Deep-water route'],
                                        ['swatch', '#3b82c4', 'Fairway edge'],
                                        ['swatch', '#f59e0b', 'Leading line / track'],
                                    ] as const
                                ).map(([kind, key, label]) => (
                                    <div
                                        key={label}
                                        // The cardinals row carries FOUR glyphs; at
                                        // half-width its nowrap label ran straight over
                                        // "Safe water" in the next column (Shane
                                        // 2026-07-19: "a small overlap of letters").
                                        // It takes the full row instead of the symbols
                                        // being shrunk — below ~18px a topmark stops
                                        // reading, which is the whole point of them.
                                        className={`flex min-w-0 items-center gap-1.5 ${
                                            kind === 'icons4' ? 'col-span-2' : ''
                                        }`}
                                    >
                                        {kind === 'icon' ? (
                                            <img
                                                src={seamarkIconDataUri(key) ?? ''}
                                                alt=""
                                                aria-hidden
                                                className="h-5 w-5 shrink-0"
                                            />
                                        ) : kind === 'icons4' ? (
                                            <span className="flex shrink-0 -space-x-1">
                                                {['north', 'east', 'south', 'west'].map((c) => (
                                                    <img
                                                        key={c}
                                                        src={seamarkIconDataUri(`sm-cardinal-${c}`) ?? ''}
                                                        alt=""
                                                        aria-hidden
                                                        className="h-5 w-5"
                                                    />
                                                ))}
                                            </span>
                                        ) : kind === 'sector' ? (
                                            // Driven by the arc palette, not the buoy one.
                                            <span
                                                className="inline-block h-2.5 w-5 shrink-0 rounded-sm border border-white/25"
                                                style={{
                                                    background: `linear-gradient(90deg,${LIGHT_COLOUR_HEX.green ?? '#22c55e'} 34%,${LIGHT_COLOUR_HEX.white ?? '#f0e030'} 34%,${LIGHT_COLOUR_HEX.white ?? '#f0e030'} 66%,${LIGHT_COLOUR_HEX.red ?? '#ef4444'} 66%)`,
                                                }}
                                            />
                                        ) : (
                                            <span
                                                className="inline-block h-2.5 w-5 shrink-0 rounded-sm border border-white/25"
                                                style={{ background: key }}
                                            />
                                        )}
                                        <span className="min-w-0 truncate">{label}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                )}
                {/* One-time disclaimer before the first enable ("needs a
                    disclaimer of course"). */}
                {showTideAck && (
                    <div
                        className="fixed inset-0 z-[10060] flex items-end justify-center bg-black/60 sm:items-center"
                        onClick={() => setShowTideAck(false)}
                    >
                        <div
                            className="w-full max-w-md rounded-t-3xl border border-teal-500/30 bg-slate-900 p-5 shadow-2xl sm:rounded-3xl"
                            onClick={(e) => e.stopPropagation()}
                        >
                            <div className="mb-2 text-sm font-black uppercase tracking-widest text-teal-300">
                                Live tide depth
                            </div>
                            <p className="mb-3 text-[13px] leading-snug text-gray-200">
                                Depths re-tint to charted depth + the predicted tide at the nearest station, refreshed
                                every few minutes. Numbers turn teal so you always know you're not reading chart datum.
                            </p>
                            <p className="mb-4 text-[12px] leading-snug text-amber-300/90">
                                It's a prediction, not a measurement: wind and pressure can move real water by 0.3 m or
                                more, tide differs across a bay, and sand moves. Your sounder is the truth. Route checks
                                stay on chart datum (LAT).
                            </p>
                            <div className="flex gap-2">
                                <button
                                    onClick={() => setShowTideAck(false)}
                                    className="flex-1 rounded-xl bg-white/5 py-2.5 text-[12px] font-black uppercase tracking-wide text-gray-300 active:scale-95"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={() => {
                                        try {
                                            localStorage.setItem(TIDE_ACK_KEY, new Date().toISOString());
                                        } catch {
                                            /* private mode — sheet just shows again next time */
                                        }
                                        setShowTideAck(false);
                                        setTideDepthMode(true);
                                    }}
                                    className="flex-1 rounded-xl bg-teal-500/20 py-2.5 text-[12px] font-black uppercase tracking-wide text-teal-300 active:scale-95"
                                >
                                    Show live depths
                                </button>
                            </div>
                        </div>
                    </div>
                )}
                {/* Chart modes — top-center one-tap layer presets so a
                    new user can go from blank chart to "Day Sail" or
                    "Storm Watch" in a single tap, instead of hunting
                    through 20 layer toggles. Always visible while on
                    the chart screen. */}
                <ChartModes
                    // Hidden while TRACING (Shane 2026-07-17: "hide the clear
                    // all thing at the top" on the routing page) — plotting
                    // deserves a clean sheet; Done brings it back.
                    visible={!passage.showPassage && !embedded && !isPinView && !coordCaptureMode}
                    onOpenSettings={() => setLayerSettingsOpen(true)}
                    activeSkyLayers={weather.activeLayers as Set<string>}
                    toggleSkyLayer={(layer) => weather.toggleLayer(layer as never)}
                    setActiveSkyLayer={(layer) =>
                        weather.setActiveLayer(layer as import('./mapConstants').WeatherLayer)
                    }
                    aisVisible={aisVisible}
                    setAisVisible={setAisVisible}
                    lightningVisible={lightningVisible}
                    setLightningVisible={setLightningVisible}
                    cycloneVisible={cycloneVisible}
                    setCycloneVisible={setCycloneVisible}
                    squallVisible={squallVisible}
                    setSquallVisible={setSquallVisible}
                    seamarkVisible={seamarkVisible}
                    setSeamarkVisible={setSeamarkVisible}
                    tideStationsVisible={tideStationsVisible}
                    setTideStationsVisible={setTideStationsVisible}
                    chokepointVisible={chokepointVisible}
                    setChokepointVisible={setChokepointVisible}
                    vesselTrackingVisible={vesselTrackingVisible}
                    setVesselTrackingVisible={setVesselTrackingVisible}
                    mpaVisible={weather.mpaVisible}
                    setMpaVisible={(v) => weather.setMpaVisible(v)}
                    encVisible={encVisible}
                    setEncVisible={setEncVisible}
                    satelliteVisible={satelliteVisible}
                    setSatelliteVisible={(v) => {
                        setSatelliteVisible(v);
                        if (v) {
                            setHybridVisible(false); // one base at a time
                            setOceanBaseVisible(false);
                        }
                    }}
                    hybridVisible={hybridVisible}
                    setHybridVisible={(v) => {
                        setHybridVisible(v);
                        if (v) {
                            setSatelliteVisible(false);
                            setOceanBaseVisible(false);
                        }
                    }}
                    oceanBaseVisible={oceanBaseVisible}
                    setOceanBaseVisible={(v) => {
                        setOceanBaseVisible(v);
                        if (v) {
                            setSatelliteVisible(false);
                            setHybridVisible(false);
                        }
                    }}
                    tideDepthMode={tideDepthMode}
                    onToggleTideDepth={onToggleTideDepth}
                    nightDim={nightDim}
                    onToggleNightDim={() => setNightDim(!nightDim)}
                    onOpenChartKey={() => setChartKeyOpen(true)}
                    encCellCount={encCellCount}
                    seawayDebugVisible={seawayDebugVisible}
                    onToggleSeawayDebug={() => setSeawayDebugVisible(!seawayDebugVisible)}
                    onClearRouteInk={() => {
                        // Route ink that outlives layer toggles: the follow-
                        // route persists in localStorage by design (SAIL IT
                        // survives restarts), and the chart route/track picks
                        // live in session state. "Clear All" kills the lot —
                        // including the Seaway Graph debug overlay, twice now
                        // the true identity of "the blue spaghetti".
                        void import('../../stores/followRouteStore').then(({ useFollowRouteStore }) =>
                            useFollowRouteStore.getState().stopFollowing(),
                        );
                        setActiveChartRoute(null);
                        setActiveChartTrack(null);
                        setSeawayDebugVisible(false);
                        // Closing audit: the ENC test route was UNCLEARABLE —
                        // its route-focus mode stripped DEPARE/glaze/land for
                        // the whole session once planned.
                        setEncTestRoute(null);
                    }}
                    onPlanEncRoute={async () => {
                        // Demo waypoints — hardcoded Newport → Rivergate
                        // until the full two-tap workflow lands. Draft comes
                        // from the REAL vessel settings (closing audit: a
                        // hardcoded 1.9 m planned routes a 2.4 m keel can't
                        // sail), defaulting like the rest of the app.
                        const FROM = { lat: -27.157, lon: 153.103 };
                        const TO = { lat: -27.435, lon: 153.105 };
                        const DRAFT_M = vesselDraftMetres(settings.vessel) || 2.5;
                        try {
                            const res = await tryInshoreRoute(FROM, TO, DRAFT_M);
                            if (res && 'polyline' in res) {
                                setEncTestRoute({ polyline: res.polyline, cautionMask: res.cautionMask });
                                const cautionCount = res.cautionMask?.filter(Boolean).length ?? 0;
                                return {
                                    ok: true,
                                    summary: `${res.distanceNM.toFixed(1)} NM · ${res.polyline.length} pts · ${cautionCount} caution`,
                                };
                            }
                            if (res && 'error' in res) {
                                setEncTestRoute(null);
                                // Humanised (closing audit: raw engine
                                // internals leaked to the row).
                                return { ok: false, summary: 'No safe water route found between these points' };
                            }
                            setEncTestRoute(null);
                            return {
                                ok: false,
                                summary: 'Charts for this area are still downloading — try again shortly',
                            };
                        } catch {
                            setEncTestRoute(null);
                            return {
                                ok: false,
                                summary: 'Route planning hit a problem — try again in a moment',
                            };
                        }
                    }}
                />

                {/* First-run coach marks — fire once per device. Five
                    one-sentence prompts covering the chart screen's
                    main affordances. Each gated by its own seenKey so
                    they fire independently as the user encounters them. */}
                {!passage.showPassage && !embedded && !isPinView && (
                    <>
                        <CoachMark
                            seenKey="thalassa_coach_chart_modes"
                            visibleWhen={mapReady}
                            anchor="top-left"
                            arrow="up"
                            initialDelayMs={1200}
                            className="!top-[60px] !left-1/2 !-translate-x-1/2 items-center"
                            message="Tap a mode at the top to set up the chart for your situation in one go."
                        />
                        <CoachMark
                            seenKey="thalassa_coach_radial_menu"
                            visibleWhen={mapReady}
                            anchor="bottom-right"
                            arrow="down"
                            initialDelayMs={8000}
                            message="Open the radial menu to fine-tune any individual layer."
                        />
                        <CoachMark
                            seenKey="thalassa_coach_legend_chip"
                            visibleWhen={mapReady && (lightningVisible || squallVisible)}
                            anchor="bottom-left"
                            arrow="down"
                            initialDelayMs={2000}
                            message="The legend in the bottom-left explains every colour you see on the chart."
                        />
                        {/* Layer-menu surface — fires the FIRST time the
                            radial menu is opened (which sets
                            weather.showLayerMenu=true). Explains the
                            three category structure so users don't have
                            to discover Sky / Tactical / Charts by tapping
                            blindly. */}
                        <CoachMark
                            seenKey="thalassa_coach_layer_menu"
                            visibleWhen={mapReady && weather.showLayerMenu}
                            anchor="center"
                            arrow="up"
                            initialDelayMs={400}
                            message="Sky for weather. Tactical for safety. Charts for navigation. Tap to switch."
                        />
                        {/* Chart-library hint — when the user enters the
                            chart catalog tab specifically. They might
                            not realise that tapping a chart enables it
                            and tapping again switches to a different one
                            (single-select, no hidden multi-toggle). */}
                        <CoachMark
                            seenKey="thalassa_coach_chart_catalog"
                            visibleWhen={mapReady && weather.showLayerMenu && chartCatalog.sources.length > 0}
                            anchor="bottom-left"
                            arrow="up"
                            initialDelayMs={2200}
                            message="Tap any chart to load it. Tap a different one to switch — only one chart shows at a time."
                        />
                    </>
                )}

                {/* Perf-guardian toast — surfaced on session-start when
                    the previous session hit sustained low FPS and we
                    auto-downtiered the device. Informs the user that
                    particle density is reduced for performance.
                    Auto-clears state after the toast's own TTL. */}
                <PerfDowntierToast visible={perfToast && !passage.showPassage && !embedded && !isPinView} />

                {/* Performance HUD — only renders when ?perf=1 in URL.
                    Used for diagnosing perf hitches on lower-spec
                    devices. Zero cost in normal use. */}
                <PerfOverlay
                    mapRef={mapRef}
                    activeLayerCount={
                        weather.activeLayers.size +
                        (lightningVisible ? 1 : 0) +
                        (squallVisible ? 1 : 0) +
                        (cycloneVisible ? 1 : 0) +
                        (aisVisible ? 1 : 0) +
                        (seamarkVisible ? 1 : 0) +
                        (tideStationsVisible ? 1 : 0)
                    }
                />

                {/* Routes picker — saved planned passages from the
                    ships log. Selection becomes activeChartRoute; the
                    useRouteTrackLayer renders + fits bounds. */}
                <RouteTrackPicker
                    visible={routePickerOpen && !passage.showPassage && !embedded && !isPinView}
                    variant="route"
                    selectedId={activeChartRoute?.id ?? null}
                    onSelect={(item) => setActiveChartRoute(item)}
                    onClose={() => setRoutePickerOpen(false)}
                />

                {/* Tracks picker — actually-sailed passages. Same UX as
                    Routes; the two can be active simultaneously. */}
                <RouteTrackPicker
                    visible={trackPickerOpen && !passage.showPassage && !embedded && !isPinView}
                    variant="track"
                    selectedId={activeChartTrack?.id ?? null}
                    onSelect={(item) => setActiveChartTrack(item)}
                    onClose={() => setTrackPickerOpen(false)}
                />

                {/* Layer-opacity settings sheet — opened from the cog
                    inside the ChartModes chip. Lets the user dim any
                    active raster layer in real time so they can see
                    the chart underneath without having to toggle the
                    layer off entirely. */}
                <LayerSettings
                    visible={layerSettingsOpen && !passage.showPassage && !embedded && !isPinView}
                    onClose={() => setLayerSettingsOpen(false)}
                    mapRef={mapRef}
                    activeSkyLayers={weather.activeLayers as Set<string>}
                    squallVisible={squallVisible}
                />

                {/* Threat proximity banner — surfaces nearby lightning
                    or active cyclones with bearing + distance. The
                    safety feature competitors don't have. Tap → fly to
                    threat. Hidden when nothing is dangerously near. */}
                <ThreatBanner
                    visible={!passage.showPassage && !embedded && !isPinView}
                    userLat={location.lat}
                    userLon={location.lon}
                    cyclones={allCyclones}
                    lightningActive={lightningVisible}
                    flyTo={(lat, lon, zoom) => {
                        const map = mapRef.current;
                        if (!map) return;
                        map.flyTo({ center: [lon, lat], zoom, duration: 1200, essential: true });
                    }}
                />

                {/* At-a-glance network status — Pi (boat network) /
                    Online (cellular/WiFi) / Offline. Critical for
                    marine users who need to know what their data costs
                    them and whether live feeds will update. */}
                <ConnectivityChip visible={!passage.showPassage && !embedded && !isPinView} />

                {/* Bottom-left legend stack. flex-col-reverse → first child
                    sits at the bottom of the column. When any weather layer
                    is active, ThalassaHelixControl / LegendDock occupies the
                    bottom-left corner with a ~140px-tall vertical legend bar;
                    lift the stack above that whole control to keep both
                    readable. */}
                {(lightningVisible || squallVisible) && (
                    <div
                        className="fixed left-2 z-[140] flex flex-col-reverse gap-2 pointer-events-none"
                        style={{
                            bottom:
                                weather.activeLayers.size > 0
                                    ? 'calc(env(safe-area-inset-bottom) + 240px)'
                                    : 'max(96px, calc(env(safe-area-inset-bottom) + 80px))',
                        }}
                    >
                        <BlitzortungAttribution visible={lightningVisible} />
                        <SquallLegend visible={squallVisible} />
                    </div>
                )}

                {/* ═══ ENC SOURCE ATTRIBUTION ═══ */}
                {/* Viewport-aware — only renders when ENC cells overlap the
                    current view. IHO standard practice for chart displays.
                    Self-contained: subscribes to its own viewport + cell-list
                    events. Tap to expand into a full per-cell list.
                    Gated like every other ENC chip (closing audit 2026-07-18:
                    it asserted "⚓ Charts: AHO ed.X" + a staleness warning even
                    with the ENC layer OFF over satellite/hybrid, and leaked into
                    embedded/picker/pin views the other chips suppress). */}
                {encVisible && !embedded && !pickerMode && !isPinView && (
                    <EncAttributionChip mapRef={mapRef} mapReady={mapReady} />
                )}

                {/* ═══ ENC HAZARD REPORT (route-adjacent obstructions) ═══ */}
                {/* Auto-populated by validateRouteSegments after a successful
                    route plan. Self-subscribes to the hazard-report singleton —
                    no prop drilling required. Hidden when not in passage mode
                    or when no hazards within the buffer. */}
                <HazardReportPanel
                    visible={passage.showPassage}
                    onHazardClick={(entry) => {
                        const map = mapRef.current;
                        if (!map) return;
                        triggerHaptic('light');
                        // Zoom 13 ≈ ~1 NM/cm — tight enough to show
                        // chart context around the hazard, loose
                        // enough to keep the surrounding route visible.
                        map.flyTo({
                            center: [entry.representativePoint.lon, entry.representativePoint.lat],
                            zoom: Math.max(map.getZoom(), 13),
                            speed: 1.6,
                            essential: true,
                        });
                    }}
                />

                {/* ═══ AIS COLOUR LEGEND + GUARD ZONE TOGGLE ═══ */}
                <Suspense fallback={null}>
                    {!passage.showPassage && !embedded && !isPinView && <AisLegend visible={aisVisible} />}
                    {isCmemsCurrentsEnabled() && (
                        <React.Suspense fallback={null}>
                            <CmemsAttribution visible={currentsVisible} />
                        </React.Suspense>
                    )}

                    {/* ═══ VESSEL SEARCH BUTTON ═══ */}
                    {!passage.showPassage && !embedded && !isPinView && aisVisible && (
                        <button
                            onClick={() => {
                                setShowVesselSearch(true);
                                triggerHaptic('light');
                            }}
                            // Right-rail column — sits below Offline FAB (top-[192px])
                            // at top-[256px]. z-[700] matches the rail's other FABs.
                            className="absolute z-[700] top-[256px] right-[16px] w-12 h-12 rounded-2xl bg-slate-900/90 border border-white/[0.08] flex items-center justify-center shadow-2xl hover:bg-slate-800/90 transition-all active:scale-95 text-slate-400"
                            aria-label="Search vessels"
                        >
                            <SearchIcon className="w-5 h-5" />
                        </button>
                    )}

                    {/* ═══ VESSEL SEARCH OVERLAY ═══ */}
                    <Suspense fallback={null}>
                        <VesselSearch
                            visible={showVesselSearch}
                            onClose={() => setShowVesselSearch(false)}
                            onSelect={(lat, lon, mmsi, name) => {
                                const map = mapRef.current;
                                if (!map) return;

                                // Fly to vessel location
                                map.flyTo({
                                    center: [lon, lat],
                                    zoom: 14,
                                    speed: 1.5,
                                    curve: 1.4,
                                    essential: true,
                                });

                                // Add a temporary pulse marker at the vessel
                                const el = document.createElement('div');
                                const pulseDiv = document.createElement('div');
                                pulseDiv.style.cssText =
                                    'width:48px;height:48px;border-radius:50%;background:radial-gradient(circle,rgba(14,165,233,0.3) 0%,transparent 70%);border:2px solid rgba(14,165,233,0.6);animation:pulse 1.5s ease-in-out infinite;display:flex;align-items:center;justify-content:center;font-size:20px;';
                                pulseDiv.textContent = '🎯';
                                el.appendChild(pulseDiv);

                                const mapboxglLib = window.mapboxgl;
                                if (mapboxglLib?.Marker) {
                                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                    const marker = new (mapboxglLib as any).Marker({ element: el })
                                        .setLngLat([lon, lat])
                                        .addTo(map);

                                    // Remove after 8 seconds
                                    setTimeout(() => marker.remove(), 8000);
                                }

                                log.info(
                                    `Vessel search: flying to ${name} (${mmsi}) at ${lat.toFixed(4)}, ${lon.toFixed(4)}`,
                                );
                            }}
                        />
                    </Suspense>

                    {/* ═══ AIS GUARD ZONE ALERT TOAST ═══ */}
                    <AisGuardAlert />
                </Suspense>

                {/* ═══ OFFLINE AREA DOWNLOAD — FAB + MODAL ═══
                    Below the ℹ button on the right rail. Opens a modal that
                    pre-caches raster map tiles (OSM + OpenSeaMap) for the
                    current view, routed through the boat Pi if available.
                    Hidden while TRACING (routing-page declutter, 2026-07-17). */}
                {!embedded && !isPinView && !passage.showPassage && !coordCaptureMode && (
                    <>
                        <button
                            onClick={() => {
                                triggerHaptic('light');
                                setShowOfflineArea(true);
                            }}
                            // Right-rail column — sits at top-[128px], directly below the
                            // SysStatus button. Above the Radial Helm FAB (top-[192px]) so
                            // opening the radial menu doesn't fan upward into the top-center
                            // mode chip.
                            className="absolute z-[700] top-[128px] right-[16px] w-12 h-12 rounded-2xl bg-slate-900/90 border border-white/[0.08] flex items-center justify-center shadow-2xl hover:bg-slate-800/90 transition-all active:scale-95"
                            aria-label="Download offline map area"
                            title="Download offline area"
                        >
                            <svg
                                className="w-5 h-5 text-sky-400"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={1.8}
                            >
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    d="M12 3v12m0 0l-4-4m4 4l4-4M4.5 17.25V19.5A1.5 1.5 0 006 21h12a1.5 1.5 0 001.5-1.5v-2.25"
                                />
                            </svg>
                        </button>
                        <Suspense fallback={null}>
                            <OfflineAreaModal
                                isOpen={showOfflineArea}
                                onClose={() => setShowOfflineArea(false)}
                                map={mapRef.current}
                            />
                        </Suspense>
                    </>
                )}

                {/* ═══ OFFLINE — NO CACHED TILES CARD ═══
                    Shown when the device is offline. Explains why the map
                    might look blank and offers a one-tap route into the
                    offline-area download modal (useful if the boat Pi has
                    internet even when the phone doesn't). */}
                {!isOnline && !offlineCardDismissed && !embedded && !isPinView && !passage.showPassage && (
                    <div className="absolute z-[550] left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[min(320px,calc(100vw-32px))] p-4 rounded-2xl bg-slate-900/95 backdrop-blur-xl border border-white/[0.08] shadow-2xl pointer-events-auto">
                        <div className="flex items-start gap-3">
                            <span className="text-xl leading-none">{'\u{1F6F0}\uFE0F'}</span>
                            <div className="flex-1">
                                <p className="text-sm font-bold text-white">Offline</p>
                                <p className="text-[11px] text-gray-400 leading-relaxed mt-1">
                                    The base map may not fully render — tiles can only load when there was internet
                                    before, or when a boat Pi has them cached. Your downloaded{' '}
                                    <span className="text-emerald-400 font-bold">.mbtiles</span> charts and GPS work
                                    fully offline.
                                </p>
                            </div>
                            <button
                                onClick={() => setOfflineCardDismissed(true)}
                                aria-label="Dismiss offline notice"
                                className="shrink-0 w-6 h-6 rounded-full text-gray-500 hover:text-gray-300 hover:bg-white/[0.06] flex items-center justify-center transition-colors"
                            >
                                <svg
                                    className="w-4 h-4"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                    strokeWidth={2}
                                >
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                                </svg>
                            </button>
                        </div>
                        <button
                            onClick={() => {
                                setOfflineCardDismissed(true);
                                setShowOfflineArea(true);
                            }}
                            className="mt-3 w-full py-2 rounded-xl text-[11px] font-black uppercase tracking-widest bg-sky-500/15 border border-sky-500/30 text-sky-400 hover:bg-sky-500/25 transition-all active:scale-95"
                        >
                            Download This Area
                        </button>
                    </div>
                )}

                {/* ═══ ROUTE LEGEND (during passage mode) ═══ */}
                <Suspense fallback={null}>
                    <RouteLegend
                        visible={passage.showPassage && !!passage.routeAnalysis && !isPinView}
                        embedded={embedded}
                    />
                </Suspense>

                {/* ═══ CONSENSUS MATRIX FAB (during passage mode) ═══ */}
                {passage.showPassage && passage.routeAnalysis && consensusData && !embedded && !isPinView && (
                    <button
                        onClick={() => {
                            setShowConsensus(!showConsensus);
                            triggerHaptic('medium');
                        }}
                        className={`absolute bottom-44 left-4 z-[500] w-12 h-12 rounded-2xl flex items-center justify-center shadow-2xl transition-all active:scale-95 ${
                            showConsensus
                                ? 'bg-gradient-to-br from-sky-500/30 to-purple-500/30 border border-sky-500/40'
                                : 'bg-slate-900/90 border border-white/[0.08] hover:bg-slate-800/90'
                        }`}
                        aria-label="Toggle Consensus Matrix"
                    >
                        <svg
                            className={`w-5 h-5 ${showConsensus ? 'text-sky-400' : 'text-white'}`}
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={1.5}
                        >
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M3.75 3v11.25A2.25 2.25 0 006 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0118 16.5h-2.25m-7.5 0h7.5m-7.5 0l-1 3m8.5-3l1 3m0 0l.5 1.5m-.5-1.5h-9.5m0 0l-.5 1.5M9 11.25v1.5M12 9v3.75m3-6v6"
                            />
                        </svg>
                    </button>
                )}

                {/* ═══ ACTION FABS ═══ */}
                {!embedded && !passage.showPassage && !isPinView && (
                    <MapActionFabs
                        onLocateMe={() => {
                            triggerHaptic('medium');
                            // Exit full-screen overlay layers so user returns to base map
                            if (squallVisible) setSquallVisible(false);
                            if (cycloneVisible) setCycloneVisible(false);
                            GpsService.getCurrentPosition({ staleLimitMs: 30_000, timeoutSec: 10 }).then((pos) => {
                                if (!pos) return;
                                const { latitude, longitude } = pos;
                                const map = mapRef.current;
                                if (map) {
                                    map.flyTo({ center: [longitude, latitude], zoom: 12, duration: 1200 });
                                }
                                LocationStore.setFromGPS(latitude, longitude);
                                if (pickerMode) {
                                    onLocationSelect?.(latitude, longitude);
                                }
                            });
                        }}
                        onRecenter={() => {
                            if (mapRef.current && weatherCoords) {
                                mapRef.current.flyTo({
                                    center: [weatherCoords.lon, weatherCoords.lat],
                                    zoom: 10,
                                    duration: 1000,
                                });
                                dropPin(mapRef.current, weatherCoords.lat, weatherCoords.lon);
                            }
                            triggerHaptic('light');
                        }}
                        recenterDisabled={!weatherCoords}
                    />
                )}

                {/* ═══ THALASSA HELIX CONTROL ═══ */}
                {!isPinView &&
                    !embedded &&
                    weather.activeLayers.size > 0 &&
                    !chartControlsHidden &&
                    (() => {
                        // Identify active weather layers (only scrubble types)
                        const WEATHER_KEYS: HelixLayer[] = [
                            'pressure',
                            'wind',
                            'rain',
                            'temperature',
                            'clouds',
                            // Currents + waves + SST + chl only get the scrubber when
                            // their CMEMS pipeline is on. Under Xweather raster the
                            // tiles are just static heatmaps.
                            ...(isCmemsCurrentsEnabled() ? (['currents'] as HelixLayer[]) : []),
                            ...(isCmemsWavesEnabled() ? (['waves'] as HelixLayer[]) : []),
                            ...(isCmemsSstEnabled() ? (['sst'] as HelixLayer[]) : []),
                            ...(isCmemsChlEnabled() ? (['chl'] as HelixLayer[]) : []),
                            ...(isCmemsSeaIceEnabled() ? (['seaice'] as HelixLayer[]) : []),
                            ...(isCmemsMldEnabled() ? (['mld'] as HelixLayer[]) : []),
                        ];
                        const activeWeatherLayers = WEATHER_KEYS.filter((k) =>
                            k === 'wind'
                                ? weather.activeLayers.has('wind' as WeatherLayer) ||
                                  weather.activeLayers.has('velocity')
                                : weather.activeLayers.has(k as WeatherLayer),
                        );

                        // ── Wind+Rain combo: synced scrubber limited to shortest timeline ──
                        const isWindRainCombo =
                            activeWeatherLayers.length === 2 &&
                            activeWeatherLayers.includes('wind') &&
                            activeWeatherLayers.includes('rain');

                        if (activeWeatherLayers.length >= 2 && !isWindRainCombo) {
                            return <LegendDock layers={activeWeatherLayers} embedded={embedded} />;
                        }

                        if (isWindRainCombo) {
                            // Synced scrubber: use rain timeline (shorter, ~4h) and drive both
                            if (weather.rainLoading) {
                                return (
                                    <ThalassaHelixControl
                                        activeLayer="rain"
                                        frameIndex={0}
                                        totalFrames={1}
                                        frameLabel="Loading..."
                                        sublabel="Rain"
                                        isPlaying={false}
                                        isLoading={true}
                                        embedded={embedded}
                                        onScrub={() => {}}
                                        onPlayToggle={() => {}}
                                    />
                                );
                            }
                            if (weather.rainReady && weather.rainFrameCount > 1) {
                                const rainNow = weather.rainNowIdxRef.current;
                                const curFrame = weather.unifiedFramesRef.current[weather.rainFrameIndex];
                                const isForecast = curFrame?.type === 'forecast';
                                return (
                                    <ThalassaHelixControl
                                        activeLayer="wind"
                                        frameIndex={weather.rainFrameIndex}
                                        totalFrames={weather.rainFrameCount}
                                        frameLabel={curFrame?.label ?? '--'}
                                        sublabel={isForecast ? 'Forecast' : 'Live'}
                                        isPlaying={weather.rainPlaying}
                                        isLoading={false}
                                        embedded={embedded}
                                        nowIndex={rainNow}
                                        dualColor={true}
                                        forecastAccent="#fbbf24"
                                        onScrub={(idx: number) => {
                                            weather.setRainFrameIndex(idx);
                                            // Map rain frame time to closest wind hour
                                            const frame = weather.unifiedFramesRef.current[idx];
                                            if (frame && weather.windForecastHoursRef.current.length > 0) {
                                                const fhrs = weather.windForecastHoursRef.current;
                                                const nowIdx = weather.windNowIdxRef.current;
                                                const rainNowIdx = weather.rainNowIdxRef.current;
                                                const deltaFrames = idx - rainNowIdx;
                                                // Each rain frame is ~10 min apart; map to wind hour index
                                                const deltaHours = (deltaFrames * 10) / 60;
                                                const targetForecastHour = (fhrs[nowIdx] ?? 0) + deltaHours;
                                                // Find closest wind forecast hour
                                                let bestWindIdx = nowIdx;
                                                let bestDist = Infinity;
                                                for (let i = 0; i < fhrs.length; i++) {
                                                    const d = Math.abs(fhrs[i] - targetForecastHour);
                                                    if (d < bestDist) {
                                                        bestDist = d;
                                                        bestWindIdx = i;
                                                    }
                                                }
                                                weather.setWindHour(bestWindIdx);
                                            }
                                        }}
                                        onScrubStart={() => weather.setRainPlaying(false)}
                                        onPlayToggle={() => weather.setRainPlaying(!weather.rainPlaying)}
                                    />
                                );
                            }
                            // Rain not ready — fall through to wind-only scrubber
                        }

                        // ── 0 weather layers (only sea/traffic/etc): nothing ──
                        if (activeWeatherLayers.length === 0) return null;

                        // ── Exactly 1 weather layer: show scrubber ──
                        const activeLayerKey = activeWeatherLayers[0];
                        if (!activeLayerKey) return null;

                        let frameIndex = 0;
                        let totalFrames = 1;
                        let frameLabel = 'Live';
                        let sublabel = 'Live';
                        let isPlaying = false;
                        let isLoading = false;
                        let framesReady: number | undefined;
                        let nowIndex: number | undefined;
                        let dualColor = false;
                        let forecastAccent = '#fbbf24';

                        let onScrub = (_f: number) => {};
                        let onScrubStart: (() => void) | undefined;
                        let onPlayToggle = () => {};

                        let applyFrame: ((f: number) => void) | undefined;

                        if (activeLayerKey === 'pressure') {
                            frameIndex = weather.forecastHour;
                            totalFrames = weather.totalFrames;
                            framesReady = weather.framesReady;
                            isPlaying = weather.isPlaying;
                            const maxF = Math.max(0, totalFrames - 1);
                            const nowIdx = weather.pressureNowIdx;
                            nowIndex = nowIdx; // feed the scrubber's Now-marker
                            // Label is RELATIVE to Now, not to cycle hour. If
                            // the GFS cycle is 4h old and we're on sub-frame 4
                            // (= wall-clock now), we want "Now", not "+4h".
                            // If we're on sub-frame 8 (= 4h in the future),
                            // we want "+4h". Matches the wind scrubber.
                            const forecastHrs = maxF > 0 ? ((frameIndex - nowIdx) / maxF) * 12 : 0;
                            if (frameIndex === nowIdx) {
                                frameLabel = 'Now';
                                sublabel = 'Current';
                            } else if (forecastHrs > 0) {
                                frameLabel = `+${forecastHrs % 1 === 0 ? forecastHrs : forecastHrs.toFixed(1)}h`;
                                sublabel = 'Forecast';
                            } else {
                                frameLabel = `${forecastHrs % 1 === 0 ? forecastHrs : forecastHrs.toFixed(1)}h`;
                                sublabel = 'Past';
                            }
                            onScrub = (h: number) => weather.setForecastHour(h);
                            onPlayToggle = () => weather.setIsPlaying(!weather.isPlaying);
                            onScrubStart = () => weather.setIsPlaying(false);
                            applyFrame = weather.applyFrame;
                        } else if (activeLayerKey === 'wind') {
                            const fhrs = weather.windForecastHoursRef.current;
                            const nowIdx = weather.windNowIdxRef.current;
                            const roundedIdx = Math.round(weather.windHour);
                            frameIndex = weather.windHour;
                            totalFrames = weather.windTotalHours;
                            const actualHour = fhrs[roundedIdx] ?? roundedIdx;
                            const nowHour = fhrs[nowIdx] ?? 0;

                            if (roundedIdx === nowIdx) {
                                frameLabel = 'Now';
                                sublabel = 'Current';
                            } else {
                                const relativeH = actualHour - nowHour;
                                if (relativeH > 0) {
                                    frameLabel = `+${relativeH}h`;
                                    sublabel = 'Forecast';
                                } else if (relativeH < 0) {
                                    frameLabel = `${relativeH}h`;
                                    sublabel = 'Past';
                                } else {
                                    frameLabel = 'Now';
                                    sublabel = 'Current';
                                }
                            }
                            isPlaying = weather.windPlaying;
                            onScrub = (idx: number) => weather.setWindHour(idx);
                            onPlayToggle = () => weather.setWindPlaying(!weather.windPlaying);
                            onScrubStart = () => weather.setWindPlaying(false);
                        } else if (activeLayerKey === 'currents' && isCmemsCurrentsEnabled()) {
                            frameIndex = weather.currentsHour;
                            totalFrames = weather.currentsTotalHours;
                            // Label is RELATIVE to Now. nowIdx is whatever
                            // step aligns with wall-clock now given how old
                            // the CMEMS manifest is. frame === nowIdx → Now.
                            const nowIdx = weather.currentsNowIdx;
                            nowIndex = nowIdx;
                            const relH = Math.round(frameIndex) - nowIdx;
                            if (relH === 0) {
                                frameLabel = 'Now';
                                sublabel = 'Nowcast';
                            } else {
                                frameLabel = relH > 0 ? `+${relH}h` : `${relH}h`;
                                sublabel = relH > 0 ? 'Forecast' : 'Past';
                            }
                            isPlaying = weather.currentsPlaying;
                            onScrub = (h: number) => weather.setCurrentsHour(Math.round(h));
                            onPlayToggle = () => weather.setCurrentsPlaying(!weather.currentsPlaying);
                            onScrubStart = () => weather.setCurrentsPlaying(false);
                        } else if (activeLayerKey === 'waves' && isCmemsWavesEnabled()) {
                            frameIndex = weather.wavesHour;
                            totalFrames = weather.wavesTotalHours;
                            // Waves are 3-hourly — each step = +3h of forecast.
                            const nowIdx = weather.wavesNowIdx;
                            nowIndex = nowIdx;
                            const relH = (Math.round(frameIndex) - nowIdx) * 3;
                            if (relH === 0) {
                                frameLabel = 'Now';
                                sublabel = 'Nowcast';
                            } else {
                                frameLabel = relH > 0 ? `+${relH}h` : `${relH}h`;
                                sublabel = relH > 0 ? 'Forecast' : 'Past';
                            }
                            isPlaying = weather.wavesPlaying;
                            onScrub = (h: number) => weather.setWavesHour(Math.round(h));
                            onPlayToggle = () => weather.setWavesPlaying(!weather.wavesPlaying);
                            onScrubStart = () => weather.setWavesPlaying(false);
                        } else if (activeLayerKey === 'sst' && isCmemsSstEnabled()) {
                            frameIndex = weather.sstStep;
                            totalFrames = weather.sstTotalSteps;
                            // SST is daily — each step = +1 day of forecast.
                            const nowIdx = weather.sstNowIdx;
                            nowIndex = nowIdx;
                            const relD = Math.round(frameIndex) - nowIdx;
                            if (relD === 0) {
                                frameLabel = 'Today';
                                sublabel = 'Daily mean';
                            } else {
                                frameLabel = relD > 0 ? `+${relD}d` : `${relD}d`;
                                sublabel = relD > 0 ? 'Forecast' : 'Past';
                            }
                            isPlaying = weather.sstPlaying;
                            onScrub = (h: number) => weather.setSstStep(Math.round(h));
                            onPlayToggle = () => weather.setSstPlaying(!weather.sstPlaying);
                            onScrubStart = () => weather.setSstPlaying(false);
                        } else if (activeLayerKey === 'chl' && isCmemsChlEnabled()) {
                            frameIndex = weather.chlStep;
                            totalFrames = weather.chlTotalSteps;
                            const nowIdx = weather.chlNowIdx;
                            nowIndex = nowIdx;
                            const relD = Math.round(frameIndex) - nowIdx;
                            if (relD === 0) {
                                frameLabel = 'Today';
                                sublabel = 'Daily mean';
                            } else {
                                frameLabel = relD > 0 ? `+${relD}d` : `${relD}d`;
                                sublabel = relD > 0 ? 'Forecast' : 'Past';
                            }
                            isPlaying = weather.chlPlaying;
                            onScrub = (h: number) => weather.setChlStep(Math.round(h));
                            onPlayToggle = () => weather.setChlPlaying(!weather.chlPlaying);
                            onScrubStart = () => weather.setChlPlaying(false);
                        } else if (activeLayerKey === 'seaice' && isCmemsSeaIceEnabled()) {
                            frameIndex = weather.seaiceStep;
                            totalFrames = weather.seaiceTotalSteps;
                            const nowIdx = weather.seaiceNowIdx;
                            nowIndex = nowIdx;
                            const relD = Math.round(frameIndex) - nowIdx;
                            if (relD === 0) {
                                frameLabel = 'Today';
                                sublabel = 'Daily mean';
                            } else {
                                frameLabel = relD > 0 ? `+${relD}d` : `${relD}d`;
                                sublabel = relD > 0 ? 'Forecast' : 'Past';
                            }
                            isPlaying = weather.seaicePlaying;
                            onScrub = (h: number) => weather.setSeaiceStep(Math.round(h));
                            onPlayToggle = () => weather.setSeaicePlaying(!weather.seaicePlaying);
                            onScrubStart = () => weather.setSeaicePlaying(false);
                        } else if (activeLayerKey === 'mld' && isCmemsMldEnabled()) {
                            frameIndex = weather.mldStep;
                            totalFrames = weather.mldTotalSteps;
                            const nowIdx = weather.mldNowIdx;
                            nowIndex = nowIdx;
                            const relD = Math.round(frameIndex) - nowIdx;
                            if (relD === 0) {
                                frameLabel = 'Today';
                                sublabel = 'Daily mean';
                            } else {
                                frameLabel = relD > 0 ? `+${relD}d` : `${relD}d`;
                                sublabel = relD > 0 ? 'Forecast' : 'Past';
                            }
                            isPlaying = weather.mldPlaying;
                            onScrub = (h: number) => weather.setMldStep(Math.round(h));
                            onPlayToggle = () => weather.setMldPlaying(!weather.mldPlaying);
                            onScrubStart = () => weather.setMldPlaying(false);
                        } else if (activeLayerKey === 'rain') {
                            if (weather.rainLoading) {
                                isLoading = true;
                            } else if (weather.rainReady && weather.rainFrameCount > 1) {
                                frameIndex = weather.rainFrameIndex;
                                totalFrames = weather.rainFrameCount;
                                nowIndex = weather.rainNowIdxRef.current;
                                const curFrame = weather.unifiedFramesRef.current[weather.rainFrameIndex];
                                const isForecast = curFrame?.type === 'forecast';
                                frameLabel = curFrame?.label ?? '--';
                                sublabel = isForecast ? 'Forecast' : 'Radar';
                                isPlaying = weather.rainPlaying;
                                dualColor = true;
                                forecastAccent = '#fbbf24';
                                onScrub = (idx: number) => weather.setRainFrameIndex(idx);
                                onPlayToggle = () => weather.setRainPlaying(!weather.rainPlaying);
                                onScrubStart = () => weather.setRainPlaying(false);
                            } else {
                                frameLabel = 'No Data';
                                sublabel = 'Retry';
                            }
                        }
                        // temperature / clouds: no scrubber, just legend (totalFrames stays 1)

                        return (
                            <>
                                {activeLayerKey === 'wind' && (
                                    <WindModelFieldSelector
                                        model={weather.windModel}
                                        field={weather.windField}
                                        onModelChange={weather.setWindModel}
                                        onFieldChange={weather.setWindField}
                                        loading={weather.windState.loading}
                                        embedded={embedded}
                                    />
                                )}
                                <ThalassaHelixControl
                                    activeLayer={activeLayerKey}
                                    frameIndex={frameIndex}
                                    totalFrames={totalFrames}
                                    frameLabel={frameLabel}
                                    sublabel={sublabel}
                                    isPlaying={isPlaying}
                                    isLoading={isLoading}
                                    framesReady={framesReady}
                                    embedded={embedded}
                                    onScrub={onScrub}
                                    onScrubStart={onScrubStart}
                                    onPlayToggle={onPlayToggle}
                                    applyFrame={applyFrame}
                                    nowIndex={nowIndex}
                                    dualColor={dualColor}
                                    forecastAccent={forecastAccent}
                                />
                            </>
                        );
                    })()}

                {/* Declutter toggle — hide/show the bottom weather cluster (model + scrubber + legend).
                    Collapsed: a centred "Weather controls" pill where the scrubber sat. Expanded: a small
                    minimise button top-right of the cluster, clear of the GPS FABs below it. */}
                {!isPinView &&
                    !embedded &&
                    weather.activeLayers.size > 0 &&
                    (chartControlsHidden ? (
                        <button
                            type="button"
                            onClick={() => setChartControlsHidden(false)}
                            className="absolute left-1/2 -translate-x-1/2 z-[510] flex items-center gap-1.5 px-3 py-2 rounded-full bg-slate-900/85 border border-white/10 backdrop-blur-md shadow-lg text-[12px] font-bold text-slate-200"
                            style={{ bottom: 'calc(80px + env(safe-area-inset-bottom))' }}
                            aria-label="Show weather controls"
                        >
                            <span className="text-sky-300 leading-none">▴</span> Weather controls
                        </button>
                    ) : (
                        <button
                            type="button"
                            onClick={() => setChartControlsHidden(true)}
                            className="absolute right-[16px] z-[510] flex h-9 w-9 items-center justify-center rounded-full bg-slate-900/85 border border-white/10 backdrop-blur-md shadow-lg text-slate-300"
                            style={{ bottom: 'calc(140px + env(safe-area-inset-bottom))' }}
                            aria-label="Hide weather controls"
                            title="Hide controls"
                        >
                            <span className="text-[14px] leading-none">▾</span>
                        </button>
                    ))}
            </div>

            {/* ═══ TABLET DATA PANEL / CONSENSUS MATRIX (Helm mode, 30% width) ═══ */}
            <Suspense fallback={null}>
                {isHelmSplit && (
                    <div className="flex-[3] h-full">
                        {showConsensus && consensusData ? (
                            <ConsensusMatrix
                                data={consensusData}
                                onScrubPosition={handleScrubPosition}
                                onClose={() => setShowConsensus(false)}
                            />
                        ) : (
                            <PassageDataPanel
                                routeAnalysis={passage.routeAnalysis}
                                departure={passage.departure}
                                arrival={passage.arrival}
                                turnWaypoints={passage.turnWaypointsRef.current}
                                departureTime={passage.departureTime}
                            />
                        )}
                    </div>
                )}

                {/* ═══ CONSENSUS MATRIX — Phone slide-up (Deck mode) ═══ */}
                {deviceMode === 'deck' && showConsensus && consensusData && !embedded && (
                    <div className="absolute inset-0 z-[600] animate-in slide-in-from-bottom duration-300">
                        <ConsensusMatrix
                            data={consensusData}
                            onScrubPosition={handleScrubPosition}
                            onClose={() => setShowConsensus(false)}
                        />
                    </div>
                )}
            </Suspense>

            {/* ═══ STORM PICKER — opens when user taps Storms with multiple cyclones ═══ */}
            <StormPicker
                visible={stormPickerOpen}
                cyclones={allCyclones}
                userLat={location.lat}
                userLon={location.lon}
                selectedStormName={closestStorm?.name ?? null}
                onSelect={handleSelectStorm}
                onClose={() => setStormPickerOpen(false)}
                onClearStorms={() => {
                    setCycloneVisible(false);
                    setClosestStorm(null);
                }}
            />
        </div>
    );
};
