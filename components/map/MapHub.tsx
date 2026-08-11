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
 *   - useWeatherLayers.ts  (weather overlay lifecycle and frame state)
 *   - MapWeatherControls.tsx (weather timeline, legend, model picker)
 *   - usePassagePlanner.ts (passage routing, isochrones, GPX export)
 */
import React, { Suspense, useRef, useState, useEffect, useCallback, useMemo } from 'react';
import { SearchIcon } from '../Icons';
import { createLogger } from '../../utils/createLogger';
import { parseCoordinateString } from '../../utils/coordParse';
import { calculateDistance } from '../../utils/navigationCalculations';
import { lazyRetry } from '../../utils/lazyRetry';

const log = createLogger('MapHub');
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';

import { useLocationStore } from '../../stores/LocationStore';
import { useWeather } from '../../context/WeatherContext';
import { LocationStore } from '../../stores/LocationStore';
import { useSettings } from '../../context/SettingsContext';
import { useUI } from '../../context/UIContext';
import { triggerHaptic } from '../../utils/system';
import { PassageBanner } from './PassageBanner';
import { CompassRoseOverlay } from './CompassRoseOverlay';
import { ZoomLevelFab } from './ZoomLevelFab';
import { MapBaseSelector, mapBaseVisibility, type MapBaseKind } from './MapBaseSelector';
import { ObsLayerLoadingPill } from './ObsLayerLoadingPill';
import { RouteEnhancementChip } from '../passage/RouteEnhancementChip';
import { GpsService } from '../../services/GpsService';

import {
    type MapHubProps,
    type WeatherLayer,
    getActiveLayerFrameZoom,
    LAYER_FRAME_ZOOM,
    shouldShowPlanChartKey,
    shouldSuppressChartOverlays,
} from './mapConstants';
import { useMapInit, useLocationDot, usePickerMode, setOpenSeaMapRasterVisibility } from './useMapInit';
import { useWeatherLayers, useEmbeddedRain } from './useWeatherLayers';
import { usePassagePlanner, type PassageNotice } from './usePassagePlanner';
import { useMapFitRequest } from './useMapFitRequest';
import { useConsensusMatrix } from './useConsensusMatrix';
import { usePinViewMode, readCurrentPinView, type PinViewHandoff } from './usePinViewMode';
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
import { useTraceHistory } from './useTraceHistory';
import { useTraceDraft } from './useTraceDraft';
import { useMapHubLayerVisibility } from './useMapHubLayerVisibility';
import { useAnchorageLayer } from './useAnchorageLayer';
import { useNoticeLayer } from './useNoticeLayer';
import { useLightningLayer } from './useLightningLayer';
import { useOceanCurrentParticleLayer } from './useOceanCurrentParticleLayer';
import { useOceanWaveParticleLayer } from './useOceanWaveParticleLayer';
import { useSstRasterLayer } from './useSstRasterLayer';
import { useChlRasterLayer } from './useChlRasterLayer';
import { useSeaIceRasterLayer } from './useSeaIceRasterLayer';
import { useMldRasterLayer } from './useMldRasterLayer';
import { isCmemsFeatureEnabled } from './cmemsFeatureAvailability';
import type { CmemsLayerId } from './CmemsAttribution';
import {
    CMEMS_SCALAR_DWELL_MS,
    CMEMS_VECTOR_DWELL_MS,
    isCmemsStepPresented,
    type CmemsPlaybackConfig,
    useCmemsAutoplay,
    useCmemsFailureBoundary,
} from './useCmemsPlayback';
import type { CmemsLayerLoadState } from './useCmemsGridRefresh';
import { isMpaEnabled, useMpaLayer } from './useMpaLayer';
import { useEncVectorLayer } from './useEncVectorLayer';
// Aliased: MapHub's own `setEncChartDetail` is the persisted-state setter.
import {
    SATELLITE_KEY,
    setEncVectorVisibility as encApplyLayerVisibility,
    setEncChartDetail as encApplyChartDetailLayers,
    syncDepareBaseTreatment as encSyncDepareBaseTreatment,
    setEncPopupSuppression,
    setEncDepthPopupEnabled,
    encHasClickableFeatureAt,
    encSuppressNextClickPopup,
    setEncDraftAssumed,
    setEncPlottingMode as encSetPlottingMode,
    SATELLITE_HIDE_LAYERS as ENC_SATELLITE_HIDE_LAYERS,
    ENC_VEC_LAYERS,
} from './EncVectorLayer';
import { useSeawayDebugLayer } from './useSeawayDebugLayer';
import { useBuoyageDirectionLayer } from './useBuoyageDirectionLayer';
import { submitTracedRoute, listPendingRoutes, reviewRoute, type PendingRoute } from '../../services/communityRoutes';
import {
    fetchSeaVoyageChoices,
    loadVoyageTrackPoints,
    type RouteOrTrack,
    type SeaVoyageChoice,
} from '../../services/shiplog/RoutesAndTracks';
import { tryInshoreRoute } from '../../services/InshoreRouter';
import { vesselDraftMetres, vesselDraftIsAssumed } from '../../services/units';
import { DEFAULT_TIDE_SAFETY_M } from '../../services/routing/tidalWindow';
import { hazardDepthForDraft } from '../../services/HazardQueryService';
import {
    traceHealth,
    pointInBbox,
    loadSavedTraces,
    saveTrace,
    linkTraceToPassage,
    attachSavedTraceTombstoneLinks,
    deleteTrace,
    tracePinBlocked,
    snapTraceTapToWater,
    snapTraceTapToLead,
    rdpTracePoints,
    reverseRouteName,
    bearingDegBetween,
    courseArrow,
    commonDepartureWindowLabel,
    nextLegSeed,
    ordinalLegLabel,
    withLegBadge,
    buildTripPassageRollups,
    destNameFromRouteName,
    retroBadgeFirstLeg,
    healTripChain,
    traceAsCuratedFairwaySnippet,
    traceAsVoyagePlan,
    splitLegForDepthGrid,
    holdTracerCtx,
    type TraceLegVerdict,
    type TracerContext,
    type SavedTrace,
} from '../../services/routeTracer';
import { consumeTracerOpenRequest, consumeTracerAction, peekTracerOpenRequest } from '../../services/deepLink';
import { loadLogbookRouteForEditing } from '../../services/savedRouteLibrary';
import { getCachedActiveVoyage } from '../../services/VoyageService';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from '../../services/authIdentityScope';
import { setEncHydrationPaused } from '../../services/enc/EncHazardService';
import {
    getRegistryFingerprint as getEncRegistryFingerprint,
    getVersion as getEncRegistryVersion,
} from '../../services/enc/EncCellMetadata';
import { evaluateTraceRelease } from '../../services/traceVerification';
import { useEncChartInventory } from './useEncChartInventory';
import { DETAIL_SCRUB_MAX, applyChartDetailLevel, isScrubHidden } from './encDetailScrubber';
import { PinDirectionsCta } from './PinDirectionsCta';
import { ChartDepthControls, LiveTideAckModal } from './ChartDepthControls';
import { useTideDepthMode } from './useTideDepthMode';
import { useWeatherInspectPopup } from './useWeatherInspectPopup';
import { useAutoRouteLeg } from './useAutoRouteLeg';
import { useTracerLegFixes } from './useTracerLegFixes';
import { useTracerGhostLanes } from './useTracerGhostLanes';
import { useTracerSessionEffects } from './useTracerSessionEffects';
import { useTracerFrameMarkers } from './useTracerFrameMarkers';
import { useTracerPinMarkers } from './useTracerPinMarkers';
import { useTracerTraceLayer } from './useTracerTraceLayer';
import { usePassageRouterEvents } from './usePassageRouterEvents';
import { usePiTileAutoCache } from './usePiTileAutoCache';
import { useTracerGrading, type TracerStatus } from './useTracerGrading';
import {
    AUTO_ROUTE_BUTTON_VISIBLE,
    CHARTS_FAB_CATEGORY_VISIBLE,
    COURSE_FRAME_VISIBLE,
    OFFLINE_AREA_FAB_VISIBLE,
    SAIL_IT_BUTTON_VISIBLE,
    TRACER_CARD_LIBRARY_VISIBLE,
    TRACER_CARD_SHARE_VISIBLE,
    TRACER_COPY_BUTTON_VISIBLE,
    distMetres,
    fitTraceBounds,
    isBasemapHybridDuplicateLabelLayer,
    nearestLegForInsert,
} from './mapHubHelpers';
// The only scrubber-furniture layer the imagery hide-list also owns — the
// islet land-fill dot, hidden over satellite/hybrid so it can't blanket the
// imagery. Passed to applyChartDetailLevel so its restore side yields (audit
// rank 8: LNDARE_ISLET was the ~8 Hz default-config styledata loop).
const IMAGERY_SCRUB_OWNED: ReadonlySet<string> = new Set([ENC_VEC_LAYERS.LNDARE_ISLET]);
import { useDestinationFlag } from './useDestinationFlag';
import { useMobMarker } from './useMobMarker';
import { useAnchorSwingLayer } from './useAnchorSwingLayer';
import { useRouteTrackLayer } from './useRouteTrackLayer';
import { MapboxVelocityOverlay } from './MapboxVelocityOverlay';
import { RadialHelmMenu } from './RadialHelmMenu';
import { buildTacticalState } from './buildTacticalState';
import { MapActionFabs } from './MapActionFabs';
import { useDeviceMode } from '../../hooks/useDeviceMode';

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
const ChartKeyPanel = lazyRetry(
    () => import('./ChartKeyPanel').then((module) => ({ default: module.ChartKeyPanel })),
    'ChartKeyPanel',
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
import { ThreatBanner } from './ThreatBanner';
import { ConnectivityChip } from './ConnectivityChip';
import { PerfOverlay } from './PerfOverlay';
import { PerfDowntierToast } from './PerfDowntierToast';
import { TracerInputRows } from './tracer/TracerInputRows';
import { TracerWaypointList } from './tracer/TracerWaypointList';
import { TracerSavedRoutePicker } from './tracer/TracerSavedRoutePicker';
import { TracerPinEditor } from './tracer/TracerPinEditor';
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
// Route review is an intentional, post-planning step. Keeping its report UI
// out of the initial chart chunk makes first map paint cheaper without
// compromising the review path once the skipper asks for it.
const TraceReportModal = lazyRetry(
    () => import('./TraceReportModal').then((m) => ({ default: m.TraceReportModal })),
    'TraceReportModal',
);
const TraceReportLoading: React.FC = () => (
    <div
        role="status"
        aria-live="polite"
        className="fixed inset-0 z-[10050] flex items-center justify-center bg-black/60 px-4 text-center text-sm font-bold text-sky-200"
    >
        Opening route report…
    </div>
);
const RouteTrackPicker = lazyRetry(
    () => import('./RouteTrackPicker').then((m) => ({ default: m.RouteTrackPicker })),
    'RouteTrackPicker',
);
const RouteTrackPickerLoading: React.FC<{ label: string }> = ({ label }) => (
    <div
        role="status"
        aria-live="polite"
        className="fixed left-1/2 top-20 z-[185] -translate-x-1/2 rounded-xl border border-white/10 bg-slate-900/95 px-4 py-3 text-center text-xs font-bold text-sky-200 shadow-xl"
    >
        {label}
    </div>
);
const MapWeatherControls = lazyRetry(
    () => import('./MapWeatherControls').then((m) => ({ default: m.MapWeatherControls })),
    'MapWeatherControls',
);
const StormPicker = lazyRetry(() => import('./StormPicker').then((m) => ({ default: m.StormPicker })), 'StormPicker');
const StormPickerLoading: React.FC = () => (
    <div
        role="status"
        aria-live="polite"
        className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 px-4 text-center text-sm font-bold text-red-100"
    >
        Opening storm picker…
    </div>
);
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import { usePersistedState, usePersistedStringSet } from '../../hooks/usePersistedState';
// PinViewHandoff + readCurrentPinView moved to ./usePinViewMode (imported above).

// ── Component ──────────────────────────────────────────────────
export const MapHub: React.FC<MapHubProps> = ({
    mapboxToken,
    onLocationSelect,
    initialZoom = 5,
    mapStyle = 'mapbox://styles/mapbox/dark-v11',
    minimalLabels = false,
    embedded = false,
    cleanPlanningMap = false,
    center,
    pickerMode = false,
    pickerLabel,
    hideTracer = false,
}) => {
    // ── Foundations ──
    // The map handle, the container it mounts into, the two markers we own
    // outright, and the settings/UI context. Declared FIRST because they are
    // what everything else in this component is written against.
    //
    // These used to sit ~1,700 lines down, and the file had grown comments
    // apologising for it — "settings isn't in scope this early", "auto route
    // lives below the settings declaration". That ordering is also what
    // blocked extracting the tracer hooks: they need `settings.vessel` and
    // `mapRef` as plain arguments, and you cannot pass a binding that has not
    // been declared yet. Hoisting is behaviour-neutral (context reads, refs,
    // and an online subscription — none of them order-sensitive) and it is
    // the enabling move for the rest of the MapHub break-up, so it ships on
    // its own commit where a bisect can find it.
    const isOnline = useOnlineStatus();
    const containerRef = useRef<HTMLDivElement>(null);
    const mapRef = useRef<mapboxgl.Map | null>(null);
    const pinMarkerRef = useRef<mapboxgl.Marker | null>(null);
    const locationDotRef = useRef<mapboxgl.Marker | null>(null);
    const { settings, updateSettings } = useSettings();
    const { setPage, currentView } = useUI();
    // The inspect popup renders in a DETACHED React root, so it can't read
    // context. Its save action reads the live settings through this ref
    // rather than a render-time closure.
    const settingsRef = useRef(settings);
    settingsRef.current = settings;

    // ── Pin View Mode (from chat pin tap) ──

    const ownedPinViewRef = useRef<PinViewHandoff | null>(null);
    const [isPinView, setIsPinView] = useState(() => {
        const pinView = readCurrentPinView();
        ownedPinViewRef.current = pinView;
        return !!pinView;
    });
    const [showVesselSearch, setShowVesselSearch] = useState(false);
    const vesselSearchMarkerRef = useRef<mapboxgl.Marker | null>(null);
    const vesselSearchMarkerTimerRef = useRef<number | null>(null);
    useEffect(
        () => () => {
            if (vesselSearchMarkerTimerRef.current !== null) {
                window.clearTimeout(vesselSearchMarkerTimerRef.current);
            }
            vesselSearchMarkerRef.current?.remove();
        },
        [],
    );
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
    // A successful requestTracerOpen handoff is the durable ownership signal
    // for the Plan journey. Keep it separate from coordCaptureMode so a future
    // direct Chart tracer cannot accidentally inherit Plan-only furniture.
    const [planTracerActive, setPlanTracerActive] = useState(
        () => !embedded && !pickerMode && !hideTracer && !isPinView && peekTracerOpenRequest(),
    );
    const [coordCaptureMode, setCoordCaptureMode] = useState(() => planTracerActive);
    const tracerHandoffTimersRef = useRef<Set<number>>(new Set());
    // Trace data is session-persisted as one per-tab draft. The hook owns
    // recovery/validation so this orchestrator stays focused on map behaviour.
    const {
        capturedCoords,
        setCapturedCoords,
        departureMs,
        setDepartureMs,
        traceName,
        setTraceName,
        lastAutoNameRef,
        legAnchor,
        setLegAnchor,
        legAnchorRef,
        traceOrigin,
        setTraceOrigin,
        traceDest,
        setTraceDest,
    } = useTraceDraft();

    // Every pin edit feeds the same history hook, regardless of whether it
    // came from a tap, drag, auto-route, ghost lane, or saved route load.
    // Rebased loads establish a fresh undo floor.
    const {
        rebaseHistoryRef,
        skipNextHistoryRef,
        canUndo: canUndoTrace,
        canRedo: canRedoTrace,
        reset: resetTraceHistory,
        undo: undoTraceHistory,
        redo: redoTraceHistory,
    } = useTraceHistory(capturedCoords, setCapturedCoords);

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
    // TracerStatus is defined once, in useTracerGrading — the hook that
    // actually writes it. Restating the union here would be a second
    // hand-maintained copy of the same list.
    const [tracerStatus, setTracerStatus] = useState<TracerStatus>('idle');
    const tracerCtxRef = useRef<TracerContext | null>(null);
    /** Small LRU of recent GRID-BEARING contexts (jank audit #6): the single
     *  slot rebuilt the whole window on every ping-pong edit (nudge pin 3,
     *  then pin 30 — the fix-leg → re-grade → nudge flow). Bounded by
     *  MEASURED bytes, not entry count (holdTracerCtx): the original "three
     *  entries, ~5–13 MB each" sizing was broken on 2026-08-10 by Fraser
     *  Island grids the workers estimated at 37–39 MB EACH — three of those
     *  is ~117 MB of typed arrays, invisible to the cache census, on a
     *  surface with a documented jetsam history. Same reuse rule as the
     *  single slot: grid required, 0.008° interior margin, marks-only NEVER
     *  held. Cleared with the ctx on draft change and Done. */
    const tracerCtxLruRef = useRef<TracerContext[]>([]);
    const tracerCtxFromLru = useCallback((pts: ReadonlyArray<{ lat: number; lon: number }>): TracerContext | null => {
        for (const c of tracerCtxLruRef.current) {
            if (c.grid && pts.every((p) => pointInBbox(p, c.bbox, 0.008))) return c;
        }
        return null;
    }, []);
    const tracerCtxHold = useCallback((ctx: TracerContext) => {
        tracerCtxRef.current = ctx;
        tracerCtxLruRef.current = holdTracerCtx(tracerCtxLruRef.current, ctx);
    }, []);
    /** Draft the caches were graded with — invalidation must key on THIS,
     *  not on tracerCtxRef (Done nulls the ctx but keeps the cache; draft
     *  edits between Done and reopen used to serve stale-keel verdicts). */
    const gradedDraftRef = useRef<{ d: number; assumed: boolean } | null>(null);
    const [savedTraces, setSavedTraces] = useState<SavedTrace[]>([]);
    // AUTO-NAME (Shane 2026-07-16): "Newport - Scarborough" from the first +
    // last pins, live as the route grows; coords when no place is nearby.
    // Auto-naming is ACTIVE while the name box is empty or still holding the
    // last auto value — the moment the skipper types their own name (or opens
    // a saved route, whose name differs), it stops touching the box.
    // Restored alongside the name, because THIS ref is what distinguishes "we
    // named it" from "the skipper named it". Lost, every restored name looks
    // hand-typed and auto-naming silently stops updating it.
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
    }, [capturedCoords, coordCaptureMode, traceName, legAnchor, lastAutoNameRef, setTraceName]);
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
        skipNextHistoryRef.current = true;
        setCapturedCoords((prev) => (prev.length === 0 ? prev : [{ ...a }, ...prev.slice(1)]));
    }, [legAnchor, capturedCoords, skipNextHistoryRef, setCapturedCoords]);
    // Focused by the no-name Save guard so the keyboard pops ready to type.
    const traceNameInputRef = useRef<HTMLInputElement | null>(null);
    const [showSavedTraces, setShowSavedTraces] = useState(false);
    const [traceFeedback, setTraceFeedback] = useState<string | null>(null);
    const flashTraceFeedback = useCallback((msg: string) => {
        setTraceFeedback(msg);
        setTimeout(() => setTraceFeedback(null), 1800);
    }, []);
    /** No-go acknowledgment: with danger legs, the first Sail tap arms a red
     *  "Sail anyway?" and only the second tap sails. Never a hard block. */
    const [sailArmed, setSailArmed] = useState(false);
    const sailBusyRef = useRef(false);
    /** Pin editing (P2): tap a pin to select it → Delete / Insert-after in
     *  the panel. insertAfterRef mirrors state for the map-tap closure. */
    const [selectedPin, setSelectedPin] = useState<number | null>(null);
    const [insertAfter, setInsertAfter] = useState<number | null>(null);
    const insertAfterRef = useRef<number | null>(null);
    const clearTraceSelection = useCallback(() => {
        setSelectedPin(null);
        setInsertAfter(null);
        insertAfterRef.current = null;
    }, []);
    // Restoring a route edit must also clear a pin/insertion selection: indexes
    // refer to the old point list after undo or redo.
    const undoTrace = useCallback(() => {
        if (undoTraceHistory()) clearTraceSelection();
    }, [clearTraceSelection, undoTraceHistory]);
    const redoTrace = useCallback(() => {
        if (redoTraceHistory()) clearTraceSelection();
    }, [clearTraceSelection, redoTraceHistory]);
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
     *  Both are GHOSTS, never trace pins — the punter's line stays his.
     *  useTraceDraft keeps this frame and chained-leg identity with the
     *  session-backed work-in-progress pins. */
    const [fromQuery, setFromQuery] = useState('');
    const [toQuery, setToQuery] = useState('');
    const [frameBusy, setFrameBusy] = useState(false);
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
    // Proven-lane ghosts — curated + community fairways near the start of a
    // trace, in components/map/useTracerGhostLanes.ts.
    const ghostLanes = useTracerGhostLanes(mapRef, coordCaptureMode, capturedCoords);
    // Deep-link door (Phase 5.1): thalassawx.app/plan boots the map with
    // a pending tracer-open request — consume it on mount, or via the
    // 'thalassa:trace-mode' window event when the map is already up
    // (BuilderDeepLink fires it after the sign-in step). Gated exactly
    // like the Trace-route FAB: embedded/picker/pin surfaces never
    // respond, so the RoutePlanner's hideTracer embed can't hijack it.
    useEffect(() => {
        if (embedded || pickerMode || hideTracer || isPinView) return;
        const clearHandoffTimers = () => {
            for (const timer of tracerHandoffTimersRef.current) window.clearTimeout(timer);
            tracerHandoffTimersRef.current.clear();
        };
        const open = (event?: Event) => {
            if (!consumeTracerOpenRequest(event)) return;
            const requestScope = getAuthIdentityScope();
            if (!isAuthIdentityScopeCurrent(requestScope)) return;
            setWeatherInspectMode(false);
            setPlanTracerActive(true);
            setCoordCaptureMode(true);
            // PLAN-page front-door actions (Shane 2026-07-16): the punter
            // already PICKED the route in the planner's modal — load it
            // straight in, no second menu. paste runs SYNCHRONOUSLY inside
            // the dispatching click so the clipboard read keeps its iOS
            // user-activation.
            const action = consumeTracerAction();
            if (action?.kind === 'paste') {
                setLegAnchor(null);
                void pasteTrace(requestScope);
            } else if (action?.kind === 'load-voyage') {
                setLegAnchor(null);
                void loadVoyageAsTrace(action.choice, requestScope);
            } else if (action?.kind === 'load-logbook-route') {
                void loadLogbookRouteAsTrace(action.voyageId, requestScope);
            } else if (action?.kind === 'load-saved') {
                const t = loadSavedTraces().find((x) => x.id === action.id);
                if (t && t.points.length >= 2) {
                    setLegAnchor(null); // an opened route is edited standalone
                    rebaseHistoryRef.current = true; // opened a saved route → Undo floor
                    setCapturedCoords(t.points);
                    setTraceName(t.name);
                    // Re-arm auto-naming for a name that WE generated. Without
                    // this the restored name looks hand-typed, isAuto stays
                    // false, and dragging the destination never retitles the
                    // route (Shane 2026-07-28: Moreton Bay → Lady Musgrave).
                    void import('../../services/routeAutoName').then(({ looksAutoNamed }) => {
                        if (looksAutoNamed(t.name)) lastAutoNameRef.current = t.name;
                    });
                    setSavedTraces(loadSavedTraces());
                    // Fit the WHOLE route (Shane 2026-07-17) — same helper as
                    // the card's open path.
                    const fly = () => mapRef.current && fitTraceBounds(mapRef.current, t.points);
                    // Cold PLAN→map mount: the map object may trail this event
                    // by a beat — one delayed retry covers it.
                    if (mapRef.current) {
                        if (isAuthIdentityScopeCurrent(requestScope)) fly();
                    } else {
                        const timer = window.setTimeout(() => {
                            tracerHandoffTimersRef.current.delete(timer);
                            if (isAuthIdentityScopeCurrent(requestScope)) fly();
                        }, 1_200);
                        tracerHandoffTimersRef.current.add(timer);
                    }
                }
            } else if (action?.kind === 'load-trip-passage') {
                // Derived "(Passage)" rollup: rebuilt fresh from the legs at
                // open time — never a stored row, so it can't be stale. Saving
                // from here creates an independent standalone route, which is
                // a deliberate act, not a sync hazard.
                const rollup = buildTripPassageRollups(loadSavedTraces()).find((r) => r.tripId === action.tripId);
                if (rollup && rollup.points.length >= 2) {
                    setLegAnchor(null);
                    rebaseHistoryRef.current = true;
                    setCapturedCoords(rollup.points);
                    setTraceName(rollup.name);
                    setSavedTraces(loadSavedTraces());
                    const fly = () => mapRef.current && fitTraceBounds(mapRef.current, rollup.points);
                    if (mapRef.current) {
                        if (isAuthIdentityScopeCurrent(requestScope)) fly();
                    } else {
                        const timer = window.setTimeout(() => {
                            tracerHandoffTimersRef.current.delete(timer);
                            if (isAuthIdentityScopeCurrent(requestScope)) fly();
                        }, 1_200);
                        tracerHandoffTimersRef.current.add(timer);
                    }
                    flashTraceFeedback(`Passage opened — ${rollup.legCount} legs stitched`);
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
                    if (mapRef.current) {
                        if (isAuthIdentityScopeCurrent(requestScope)) fly();
                    } else {
                        const timer = window.setTimeout(() => {
                            tracerHandoffTimersRef.current.delete(timer);
                            if (isAuthIdentityScopeCurrent(requestScope)) fly();
                        }, 1_200);
                        tracerHandoffTimersRef.current.add(timer);
                    }
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
        const close = () => {
            setPlanTracerActive(false);
            setCoordCaptureMode(false);
        };
        const unsubscribeIdentity = subscribeAuthIdentityScope(() => {
            clearHandoffTimers();
            setPlanTracerActive(false);
            setCoordCaptureMode(false);
        });
        open();
        window.addEventListener('thalassa:trace-mode', open);
        window.addEventListener('thalassa:trace-mode-exit', close);
        return () => {
            unsubscribeIdentity();
            clearHandoffTimers();
            window.removeEventListener('thalassa:trace-mode', open);
            window.removeEventListener('thalassa:trace-mode-exit', close);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [embedded, pickerMode, hideTracer, isPinView]);

    // Chrome broadcast, PLAN-page departure adoption, and the tracer-open
    // bootstrap — components/map/useTracerSessionEffects.ts. None of the three
    // touches the map, and their guards differ ON PURPOSE.
    useTracerSessionEffects({
        coordCaptureMode,
        embedded,
        pickerMode,
        isPinView,
        setDepartureMs,
        coordCaptureRef,
        setPlotArmed,
        setSavedTraces,
    });
    // The graded trace line, its glow, arrows, issue icons, ghost lanes and
    // destination hint — components/map/useTracerTraceLayer.ts.
    // CALL POSITION IS THE Z-ORDER: after the ghost lanes it depends on, and
    // above every other map-layer hook in this file.
    useTracerTraceLayer({
        mapRef,
        coordCaptureMode,
        capturedCoords,
        legVerdicts,
        ghostLanes,
        traceOrigin,
        traceDest,
    });
    // START / 🏁 ghost rings for the course frame —
    // components/map/useTracerFrameMarkers.ts. Called BEFORE the pin markers
    // on purpose: DOM markers paint in insertion order, so pins go on top.
    useTracerFrameMarkers({ mapRef, coordCaptureMode, traceOrigin, traceDest, pinCount: capturedCoords.length });
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
    // Numbered draggable pins — components/map/useTracerPinMarkers.ts.
    // AFTER the frame markers: DOM markers have no z-index, so insertion
    // order decides and the pins belong above the ghost rings.
    useTracerPinMarkers({
        mapRef,
        tracerCtxRef,
        coordCaptureMode,
        capturedCoords,
        setCapturedCoords,
        selectedPin,
        setSelectedPin,
        setInsertAfter,
        insertAfterRef,
        legAnchor,
        flashTraceFeedback,
    });

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
            // Same re-arm as the load-saved deep link — see there.
            void import('../../services/routeAutoName').then(({ looksAutoNamed }) => {
                if (looksAutoNamed(t.name)) lastAutoNameRef.current = t.name;
            });
            setShowSavedTraces(false);
            setSelectedPin(null);
            if (mapRef.current) fitTraceBounds(mapRef.current, t.points);
            flashTraceFeedback(`Opened "${t.name}"`);
        },
        [flashTraceFeedback, lastAutoNameRef, rebaseHistoryRef, setCapturedCoords, setLegAnchor, setTraceName],
    );
    /**
     * The check-points a long leg is ALREADY being graded at, per leg.
     *
     * Derived, never stored: the grading pass cuts over-long legs with the same
     * pure function, so this is exactly where the checks happen — it cannot
     * drift from what was verified. Empty for every leg on a normal route.
     */
    const legSplitPoints = useMemo(() => {
        const out: Array<{ afterIndex: number; points: { lat: number; lon: number }[] }> = [];
        for (let i = 1; i < capturedCoords.length; i++) {
            const mids = splitLegForDepthGrid(capturedCoords[i - 1], capturedCoords[i]);
            if (mids.length > 0) out.push({ afterIndex: i - 1, points: mids });
        }
        return out;
    }, [capturedCoords]);
    const splitPointCount = useMemo(() => legSplitPoints.reduce((n, s) => n + s.points.length, 0), [legSplitPoints]);

    /**
     * Turn those check-points into real, editable waypoints — the opt-in half
     * of the long-leg fix (Shane 2026-08-01: verification happens by itself,
     * the pins only appear when he asks).
     *
     * Splices LAST leg first so earlier indices stay valid mid-loop — the same
     * ordering fixLegOnGrid uses. The points sit on each leg's own line, so the
     * route's shape is unchanged; what changes is that they now save, export
     * and follow with it. Verdicts re-grade because the leg keys change.
     */
    const materialiseSplitWaypoints = useCallback(() => {
        if (legSplitPoints.length === 0) return;
        triggerHaptic('light');
        setCapturedCoords((prev) => {
            let next = prev;
            for (const { afterIndex, points } of [...legSplitPoints].reverse()) {
                if (afterIndex + 1 > next.length) continue; // trace changed under us
                next = [
                    ...next.slice(0, afterIndex + 1),
                    ...points.map((p) => ({ ...p })),
                    ...next.slice(afterIndex + 1),
                ];
            }
            return next;
        });
        clearTraceSelection();
        flashTraceFeedback(
            `Added ${splitPointCount} waypoint${splitPointCount === 1 ? '' : 's'} — the legs were already checked here`,
        );
    }, [legSplitPoints, splitPointCount, clearTraceSelection, flashTraceFeedback, setCapturedCoords]);

    const getTraceReleaseGate = useCallback(
        () =>
            evaluateTraceRelease(capturedCoords, tracerStatus, legVerdicts, ackedLegs, {
                draftM: vesselDraftMetres(settings.vessel),
                draftAssumed: vesselDraftIsAssumed(settings.vessel),
                encRegistryVersion: getEncRegistryVersion(),
                encRegistryFingerprint: getEncRegistryFingerprint(),
                departureMs: departureMs ?? Date.now(),
                tideWindowLabel: departureLabel,
            }),
        [capturedCoords, tracerStatus, legVerdicts, ackedLegs, settings.vessel, departureMs, departureLabel],
    );
    const traceReleaseGate = getTraceReleaseGate();

    const saveCurrentTrace = useCallback(() => {
        if (capturedCoords.length < 2) return;
        const release = getTraceReleaseGate();
        if (!release.allowed || !release.verification) {
            triggerHaptic('heavy');
            flashTraceFeedback(release.reason || 'Check the route again before saving');
            if (traceHealth(legVerdicts).danger > 0) setShowReport(true);
            return;
        }
        const verification = release.verification;
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
        const saveScope = getAuthIdentityScope();
        const { trace, persisted, cloud } = saveTrace(finalName, capturedCoords, {
            ...(existing ? { overwriteId: existing.id } : {}),
            ...(anchor
                ? {
                      tripId: anchor.tripId,
                      legOrdinal: anchor.ordinal,
                      destName: destNameFromRouteName(finalName) ?? undefined,
                  }
                : {}),
            verification,
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
            // "right up to when it was last saved"). Save does not replace
            // capturedCoords, so reset the history immediately.
            resetTraceHistory();
            // Cross-device honesty: "Saved ✓" is true of THIS device either
            // way, but build-on-desktop→sail-on-phone needs the account
            // push — when it didn't happen, say so instead of letting the
            // route silently live in one browser's localStorage.
            void cloud.then((result) => {
                if (result === 'signedout') flashTraceFeedback('Saved here — sign in to sync across devices');
                else if (result === 'toolarge') flashTraceFeedback('Saved here — over 200 pins, too long to sync');
                else if (result === 'error') flashTraceFeedback('Saved here — cloud sync will retry later');
            });
            // Planned-route compatibility mirror — the same planned_%
            // logbook write Sail does, minus the follow. It powers cast-off
            // choices, planned-vs-sailed comparison, and legacy recovery in
            // Plan's Saved Routes library; it is no longer a factual Log
            // voyage card. Background under a JS deadline; the
            // label+day duplicate guard makes same-day re-saves quiet
            // no-ops instead of twins.
            void (async () => {
                try {
                    const [{ savePassagePlanToLogbookWithLinks }, { withDeadline }] = await Promise.all([
                        import('../../services/shiplog/PassagePlanSave'),
                        import('../../utils/deadline'),
                    ]);
                    const plan = traceAsVoyagePlan(finalName, capturedCoords, verification.legGrades, verification);
                    const mirrorSave = savePassagePlanToLogbookWithLinks(plan, {
                        savedRouteId: trace.id,
                        ...(trace.passageVoyageId ? { existingPassageVoyageId: trace.passageVoyageId } : {}),
                        ...(trace.plannedRouteId ? { existingPlannedRouteId: trace.plannedRouteId } : {}),
                    });
                    const reconcileMirror = async (saved: Awaited<typeof mirrorSave>): Promise<void> => {
                        if (!isAuthIdentityScopeCurrent(saveScope) || !saved) return;
                        // The mirror has now returned immutable ids. Attach
                        // them to the canonical trace so deleting it can
                        // remove only its own Log + Passage Planning
                        // counterparts.
                        const linked = linkTraceToPassage(trace.id, saved, saveScope);
                        if (linked) return;
                        // Delete can win while this background write is in
                        // flight. Persist the late ids on the delete fence
                        // before cleaning the mirror. If this cleanup is
                        // offline, saved-route sync can retry the *exact*
                        // graph later instead of leaving a Passage Planning
                        // ghost.
                        attachSavedTraceTombstoneLinks(trace.id, saved, saveScope);
                        const { deleteSavedRoutePassageGraph } = await import('../../services/savedRouteGraph');
                        await deleteSavedRoutePassageGraph(trace.id, saved, saveScope);
                    };
                    try {
                        await reconcileMirror(await withDeadline(mirrorSave, 25_000, 'trace save → logbook'));
                    } catch (error) {
                        // Capacitor's native request can finish after the JS
                        // deadline. It must still reconcile (or clean itself
                        // up if the trace was deleted) when it eventually
                        // lands.
                        void mirrorSave.then(reconcileMirror).catch(() => {});
                        throw error;
                    }
                    const { invalidateRoutesAndTracks } = await import('../../services/shiplog/RoutesAndTracks');
                    invalidateRoutesAndTracks(saveScope);
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
    }, [
        capturedCoords,
        traceName,
        legAnchor,
        savedTraces,
        overwriteArm,
        legVerdicts,
        getTraceReleaseGate,
        flashTraceFeedback,
        resetTraceHistory,
        setTraceName,
    ]);
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
    }, [capturedCoords.length, traceName, flashTraceFeedback, legAnchorRef, setCapturedCoords, setTraceName]);
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
        const release = getTraceReleaseGate();
        if (!release.allowed || !release.verification) {
            triggerHaptic('heavy');
            flashTraceFeedback(release.reason || 'Check the route again before sailing');
            if (traceHealth(legVerdicts).danger > 0) setShowReport(true);
            return;
        }
        if (release.verification.draftAssumed) {
            triggerHaptic('heavy');
            flashTraceFeedback('Set and confirm your vessel draft before following this route');
            return;
        }
        sailBusyRef.current = true;
        triggerHaptic('medium');
        const plan = traceAsVoyagePlan(traceName, capturedCoords, release.verification.legGrades, release.verification);
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
    }, [capturedCoords, traceName, legVerdicts, flashTraceFeedback, getTraceReleaseGate]);
    // ── Route report: Fix-this-leg + Acknowledge (Phase 3) ──
    // The splice half lives in components/map/useTracerLegFixes.ts.
    const { onFixLeg, onFixAll } = useTracerLegFixes({
        capturedCoords,
        setCapturedCoords,
        gradedDraftRef,
        tracerCtxFromLru,
        tracerCtxHold,
        legVerdicts,
        ackedLegs,
        setFixBusyLeg,
        flashTraceFeedback,
    });
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
    }, [coordEntry, flashTraceFeedback, setCapturedCoords]);

    const pasteTrace = useCallback(
        async (expectedScope: AuthIdentityScope = getAuthIdentityScope()) => {
            if (!isAuthIdentityScopeCurrent(expectedScope)) return;
            try {
                const text = await navigator.clipboard.readText();
                if (!isAuthIdentityScopeCurrent(expectedScope)) return;
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
                if (isAuthIdentityScopeCurrent(expectedScope)) {
                    flashTraceFeedback('Clipboard not available');
                }
            }
        },
        [flashTraceFeedback, setCapturedCoords],
    );
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

    // Where the tide panel reads from. The shallowest charted point on the
    // route is the one that decides whether you get across, so anchor there
    // when the tracer found one; otherwise the destination, which is what a
    // skipper checking "can I get in tonight" actually means.
    const tideAnchor = useMemo(() => {
        const shallow = legVerdicts.find((v) => v?.needsTide && v.minAt)?.minAt;
        if (shallow) return { lat: shallow.lat, lon: shallow.lon };
        const last = capturedCoords[capturedCoords.length - 1];
        return last ? { lat: last.lat, lon: last.lon } : null;
    }, [legVerdicts, capturedCoords]);

    // ⚡ Auto route — drives the real inshore routing engine between two
    // pins, in components/map/useAutoRouteLeg.ts. HARD RULE lives with it:
    // on ANY engine failure it changes nothing and says why. It must never
    // fall back to a straight line, because a straight line crosses land.
    const autoRouteLeg = useAutoRouteLeg({
        capturedCoords,
        setCapturedCoords,
        selectedPin,
        setSelectedPin,
        setInsertAfter,
        insertAfterRef,
        fixBusyLeg,
        setFixBusyLeg,
        setAutoRouteDiag,
        flashTraceFeedback,
        vessel: settings.vessel,
    });

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
        // Also computed when the route has a tide gate, not just when the
        // report is open: "leave 09:10–13:30 and every gate clears" IS the
        // answer to "will we make it across", and it was reachable only by
        // opening 📋 Route report — two taps behind the question.
        if (!showReport && !legVerdicts.some((v) => v?.needsTide)) return;
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
        const draftAssumed = vesselDraftIsAssumed(settings.vessel);
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
        async (t: SeaVoyageChoice, expectedScope: AuthIdentityScope = getAuthIdentityScope()) => {
            if (!isAuthIdentityScopeCurrent(expectedScope)) return;
            triggerHaptic('medium');
            flashTraceFeedback(`Loading ${t.label}…`);
            // Polyline fetched per-voyage on tap (paged, whole passage) —
            // the picker rows themselves carry no points now.
            const points = await loadVoyageTrackPoints(t.voyageId);
            if (!isAuthIdentityScopeCurrent(expectedScope)) return;
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
        [flashTraceFeedback, rebaseHistoryRef, setCapturedCoords],
    );
    // Historical planned-route mirror → editable tracer. Unlike sailed-voyage
    // imports, this must keep the exact stored curve: simplifying a planned
    // route can move it across a depth contour, mark or headland.
    const loadLogbookRouteAsTrace = useCallback(
        async (voyageId: string, expectedScope: AuthIdentityScope = getAuthIdentityScope()) => {
            if (!isAuthIdentityScopeCurrent(expectedScope)) return;
            triggerHaptic('medium');
            flashTraceFeedback('Loading saved route…');

            const route = await loadLogbookRouteForEditing(voyageId, expectedScope);
            if (!isAuthIdentityScopeCurrent(expectedScope)) return;
            if (!route) {
                flashTraceFeedback('Could not load that route — try again online');
                return;
            }

            setLegAnchor(null);
            setSelectedPin(null);
            setOverwriteArm(null);
            setShowSavedTraces(false);
            rebaseHistoryRef.current = true;
            setCapturedCoords(route.points);
            setTraceName(route.name);
            setSavedTraces(loadSavedTraces(expectedScope));

            const fit = () => mapRef.current && fitTraceBounds(mapRef.current, route.points);
            if (mapRef.current) {
                if (isAuthIdentityScopeCurrent(expectedScope)) fit();
            } else {
                const timer = window.setTimeout(() => {
                    tracerHandoffTimersRef.current.delete(timer);
                    if (isAuthIdentityScopeCurrent(expectedScope)) fit();
                }, 1_200);
                tracerHandoffTimersRef.current.add(timer);
            }
            flashTraceFeedback(`Opened "${route.name}" from Log — Save to keep it here`);
        },
        [flashTraceFeedback, rebaseHistoryRef, setCapturedCoords, setLegAnchor, setTraceName],
    );
    // ── Route Tracer validation ──
    // Context build + per-leg grading + sub-keel tide windows, all in
    // components/map/useTracerGrading.ts. Touches no map layer or marker.
    useTracerGrading({
        capturedCoords,
        coordCaptureMode,
        vessel: settings.vessel,
        legVerdicts,
        departureMs,
        legEtaOffsetsMs,
        tracerCtxRef,
        tracerCtxLruRef,
        gradedDraftRef,
        tracerCtxFromLru,
        tracerCtxHold,
        setLegVerdicts,
        setTracerStatus,
        setTideLabels,
        setAckedLegs,
        setSailArmed,
        setShareArmed,
    });

    const [isoProgress, setIsoProgress] = useState<{
        step: number;
        closestNM: number;
        totalDistNM?: number;
        elapsed?: number;
        frontSize?: number;
        phase?: string;
    } | null>(null);
    const [passageNotice, setPassageNotice] = useState<PassageNotice | null>(null);

    // ── Weather Inspect Popup ──
    // An imperative Mapbox popup with its own detached React root, in
    // components/map/useWeatherInspectPopup.tsx.
    const { showWeatherInspect, closeWeatherInspect } = useWeatherInspectPopup(mapRef, settingsRef, updateSettings);

    // Re-check pin view when navigating TO the map tab
    useEffect(() => {
        if (currentView === 'map') {
            const pinView = readCurrentPinView();
            ownedPinViewRef.current = pinView;
            setIsPinView(!!pinView);
        }
    }, [currentView]);

    // Passage router event bus — isochrone progress + preview line, passage
    // notices, and chat pin-drops. components/map/usePassageRouterEvents.ts.
    usePassageRouterEvents({ mapRef, setIsoProgress, setPassageNotice });

    const location = useLocationStore();
    const { weatherData, saveVoyagePlan } = useWeather();
    const weatherCoords = weatherData?.coordinates;
    const [mapReady, setMapReady] = useState(false);
    // Initialise passage state before any optional-layer hooks. A staged
    // RoutePlanner handoff makes showPassage true on this first render, so
    // every downstream layer sees a planning surface from frame one.
    const passage = usePassagePlanner(mapRef, mapReady);
    // Consensus matrix state + effects — components/map/useConsensusMatrix.ts.
    // Called here rather than at the old state position above because it needs
    // `passage`, which is only in scope from the line above down.
    const { showConsensus, setShowConsensus, consensusData, handleScrubPosition } = useConsensusMatrix({
        mapRef,
        passage,
        setIsoProgress,
    });
    const planningSurface = shouldSuppressChartOverlays(cleanPlanningMap, coordCaptureMode, passage.showPassage);
    const planChartKeyVisible = shouldShowPlanChartKey(
        cleanPlanningMap,
        planTracerActive,
        embedded,
        pickerMode,
        isPinView,
    );
    const browseWeatherInspectMode = weatherInspectMode && !planningSurface;
    const deviceMode = useDeviceMode();
    // ── Browse-layer visibility — components/map/useMapHubLayerVisibility.ts ──
    // Per-layer toggles, MOB highlight, storm picker + cyclone catalogue,
    // the storm-select handler, and the browse* planning-surface gates.
    // Called exactly where aisVisible used to be declared so hook order at
    // this position is unchanged.
    const {
        aisVisible,
        setAisVisible,
        setChokepointVisible,
        cycloneVisible,
        setCycloneVisible,
        squallVisible,
        setSquallVisible,
        vesselTrackingVisible,
        seamarkVisible,
        setSeamarkVisible,
        anchorageVisible,
        setAnchorageVisible,
        mobActive,
        tideStationsVisible,
        setTideStationsVisible,
        lightningVisible,
        setLightningVisible,
        closestStorm,
        setClosestStorm,
        skipAutoFlyRef,
        stormPickerOpen,
        setStormPickerOpen,
        allCyclones,
        cyclonePickerPendingRef,
        handleSelectStorm,
        browseAisVisible,
        browseChokepointVisible,
        browseCycloneVisible,
        browseSquallVisible,
        browseSeamarkVisible,
        browseAnchorageVisible,
        browseTideStationsVisible,
        browseLightningVisible,
    } = useMapHubLayerVisibility({ mapRef, planningSurface });
    // ENC vector chart visibility.
    //
    // PINNED ON 2026-07-22, for the same reason as encChartDetail below: the
    // ChartModes dropdown held the only setter, and it is gone. A persisted
    // `false` — which the old "Clear All" preset wrote and PERSISTED — could
    // then never be undone, leaving the sea chart off with no UI to restore
    // it. That exact state cost a day in July ("where did my white keel areas
    // go?") and is the reason for the plotting keel floor.
    //
    // The old rationale (toggle it off to compare against raster charts
    // underneath) does not survive losing the toggle. Restore
    // usePersistedState('thalassa_map_enc_visible', true) only alongside a
    // real control, and give it a writer in the same commit.
    const encVisible = true;
    // Chart-detail toggle. Default ON — the draft-aware depth shading IS the
    // product (flipped 2026-06-13; the 2026-05-17 "clean chart" preference
    // predates day-palette banding). When OFF: land + markers + hazards only.
    // Independent of `encVisible` — the master switch wins.
    // Key bumped _v2: usePersistedState eagerly writes the default on first
    // mount, so every pre-flip install had `false` persisted whether or not
    // the user ever touched the toggle — flipping the default alone would
    // no-op on existing devices. The bump resets everyone to ON once; new
    // toggles persist under the v2 key as usual.
    //
    // PINNED ON 2026-07-22. The only writer of this state was the legacy layer
    // FAB's onToggleEncChartDetail, deleted in 8044e434 — so the React setter
    // now has no callers and a persisted `false` could never be undone. That
    // is a trap, not a preference: with detailed=false, CHART_DETAIL_HIDE_LAYERS
    // (EncVectorLayer.ts:1657) hides DEPARE, i.e. no white water, with no UI
    // anywhere to bring it back.
    //
    // Reading the stored value would strand exactly those devices. The FAB had
    // been unreachable long before it was deleted (its own catch-22 gate), so
    // any surviving `false` was written by a build old enough that honouring it
    // is meaningless. Pinned to true until a real clean-chart control exists;
    // restore usePersistedState('thalassa_map_enc_chart_detail_v2', true) at
    // that point and give it a writer in the same commit.
    const encChartDetail = true;
    // Chart inventory — cell count, hydration progress and the no-coverage
    // affordance — with its subscriptions. Extracted to
    // components/map/useEncChartInventory.ts; it writes no map layers, so it
    // was the safe pilot for breaking this file up. Called exactly where the
    // state used to be declared: below mapReady, above chokepointVisible, so
    // hook order is unchanged.
    const { encCellCount, encReferenceCellCount, encHydration, encNoCoverage } = useEncChartInventory(
        mapRef,
        mapReady,
        encVisible,
    );
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
    // BOOT DEFAULT is HYBRID as of 2026-07-22 (Shane: "can we have the charts
    // page utilising the hybrid chart as default"). Plain satellite held the
    // boot from 2026-07-19; clean-dark had it from 07-17; hybrid had it before
    // that on 07-15. This has now flipped four times — the ONLY reliable
    // reading of the current default is these two useState initialisers, so
    // treat any prose elsewhere claiming otherwise as stale.
    //
    // What does NOT change: hybrid is imagery, so satOn is still true from the
    // first frame and the chart still boots with the full satellite ENC
    // treatment — white keel glaze, hidden land fills, amber safety contour —
    // rather than the dark ECDIS look. Hybrid just adds roads and place names
    // over the same photograph, which is the public voyage-page look.
    // Session-only, never persisted, so this is a default and not a setting
    // that can haunt a later boot.
    //
    // The old ChartModes dropdown was removed in July and accidentally took
    // the only base-map writer with it, leaving Satellite and Ocean as dead
    // constants. Keep this choice session-only (no stale base haunting a later
    // boot), but make all three supported rasters reachable through the small
    // MapBaseSelector on the browsing chart.
    // Default flipped hybrid → satellite (Shane 2026-08-07: "can we make
    // satellite the default layer on the obs page as well. not hybrid").
    // Hybrid's road and place-name furniture is drawn for land navigation and
    // clutters the water the chart is actually about; clean imagery lets the
    // ENC marks and the track palette read on their own. Hybrid stays one tap
    // away in the selector. Still session-only — a base map is a default here,
    // not a persisted setting that can haunt a later boot.
    const [mapBase, setMapBase] = useState<MapBaseKind>('satellite');
    const baseVisibility = mapBaseVisibility(mapBase);
    const satelliteVisible = baseVisibility.satellite;
    // Chart-declutter scrubber (Shane 2026-07-14): 0 = full chart, 6 =
    // near-bare. Session-only; encDetailScrubber owns which furniture
    // each step removes (safety layers are untouchable there).
    const [declutter, setDeclutter] = useState(0);
    // Hybrid base (Shane 2026-07-15): the PUBLIC voyage-page look —
    // satellite-streets, imagery with roads + names. Session-only,
    // mutually exclusive with satellite via MapBaseSelector, and
    // it gets the FULL satellite ENC treatment (glaze, hidden land
    // fills, bathy tint) via imageryOn below.
    // HYBRID BOOTS ON as of 2026-07-22 — this is the boot base (see the
    // satelliteVisible declaration above for the full history). The two
    // The visibility projection keeps all three bases mutually exclusive.
    // Plain satellite and bathymetric Ocean stay one tap away. Session-only.
    const hybridVisibleRaw = baseVisibility.hybrid;
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
    const oceanBaseVisible = baseVisibility.ocean;
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
    const hybridVisible = planningSurface && !satelliteVisible && !oceanBaseVisible ? true : hybridVisibleRaw;
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
                let styleLayers = map.getStyle()?.layers ?? [];
                let orderIds = styleLayers.map((layer) => layer.id);
                let encBottom = orderIds.find((id) => id.startsWith('enc-vec-'));
                const refreshOrder = () => {
                    styleLayers = map.getStyle()?.layers ?? [];
                    orderIds = styleLayers.map((layer) => layer.id);
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

                // PLACE NAMES OVER THE IMAGERY (Shane 2026-07-22: "we just
                // need more place names on the land, so we know where we
                // are"). Raw satellite needs the dark base style's settlement
                // labels raised above the imagery — it has no text of its own.
                //
                // Hybrid is different: satellite-streets raster tiles already
                // contain city / town / airport / POI names. Raising the same
                // vector symbols created the doubled city labels seen on OBS.
                // Hide just those *base-style* symbols for hybrid; route, AIS,
                // waypoint and ENC labels remain untouched. Restore them for
                // raw satellite and the normal vector map, where they are the
                // one useful set of place names.
                // Use the map's actual state rather than React intent alone.
                // A style reload can briefly leave the Hybrid layer absent or
                // hidden; during that interval the vector labels are the only
                // useful names and must stay visible. The next styledata pass
                // hides them as soon as the labelled Hybrid raster is live.
                const hybridRasterVisible =
                    !!map.getLayer('hybrid-base-layer') &&
                    ((map.getLayoutProperty('hybrid-base-layer', 'visibility') as string | undefined) ?? 'visible') !==
                        'none';
                const duplicateHybridLabels = styleLayers.filter(isBasemapHybridDuplicateLabelLayer);
                const desiredBaseLabelVisibility = hybridRasterVisible ? 'none' : 'visible';
                for (const layer of duplicateHybridLabels) {
                    if (setVis(layer.id, desiredBaseLabelVisibility)) changed = true;
                }

                // ENC'S LAND NAMES ARE THE THIRD LABEL SET, and the one that was
                // still doubling. Shane 2026-07-28, /plan: "BANKSIA BEACH" drawn
                // twice — once wide-spaced from enc-vec-lndare-label, once from
                // the hybrid raster, which is satellite-streets-v12 baked to
                // tiles and carries its own place names in the PIXELS.
                //
                // isBasemapHybridDuplicateLabelLayer cannot catch this and should
                // not try: it deliberately only touches `composite`/`openmaptiles`
                // layers, because hiding an app-owned label is worse than leaving
                // an unfamiliar basemap one alone. ENC's is app-owned, so it was
                // correctly skipped — and therefore never deduped against baked
                // pixels nothing can hide.
                //
                // LNDARE only. SEAARE_LABEL names sea areas, bays and channels,
                // which the basemap does NOT provide and a skipper actually wants;
                // it duplicates nothing. Land/suburb names are the whole overlap.
                if (map.getLayer(ENC_VEC_LAYERS.LNDARE_LABEL)) {
                    if (setVis(ENC_VEC_LAYERS.LNDARE_LABEL, desiredBaseLabelVisibility)) changed = true;
                }

                // Once raw satellite is active, lift the base labels above its
                // opaque raster. Hybrid deliberately skips the lift because its
                // baked labels are the authoritative, single set.
                //
                // The base style's settlement labels are added at style load,
                // BEFORE the imagery raster — and the raster is opaque, so
                // every town name was simply painted over. The ordering pass
                // above only ever pushed imagery below the ENC stack; nothing
                // raised the labels.
                //
                // Lift them above whichever imagery layer is on. Deliberately
                // NOT to the very top: the ENC stack stays above, so marks,
                // lights and leads still paint over a town name rather than
                // the other way round.
                //
                // Conditional writes only — an unconditional moveLayer here
                // would re-fire styledata forever (the ~8 Hz loop of the
                // 2026-07-15 audit).
                const litImagery = ['hybrid-base-layer', 'satellite-base-layer'].filter(
                    (id) => map.getLayer(id) && map.getLayoutProperty(id, 'visibility') !== 'none',
                );
                if (litImagery.length > 0 && !hybridRasterVisible) {
                    const imageryIdx = Math.max(...litImagery.map((id) => orderIds.indexOf(id)));
                    // Country/state are minimalLabels' business, and app-owned
                    // sources must never be reordered from here.
                    // Decide every move against ONE order snapshot, then apply:
                    // refreshing mid-loop would leave imageryIdx pointing at the
                    // wrong row and make the decisions drift.
                    const buried = styleLayers
                        .filter(
                            (layer) =>
                                orderIds.indexOf(layer.id) < imageryIdx && isBasemapHybridDuplicateLabelLayer(layer),
                        )
                        .map((layer) => layer.id);
                    // In original order, each anchored before encBottom, so the
                    // style's own label priority survives the lift.
                    for (const id of buried) map.moveLayer(id, encBottom);
                    if (buried.length > 0) {
                        // Self-limiting: once lifted they sit above the
                        // imagery, so this logs on the pass that fixes it and
                        // then goes quiet. This is normal layer maintenance,
                        // so keep it out of warning/error telemetry.
                        log.info(
                            `[labels] lifted ${buried.length} place-label layers above imagery: ${buried.join(', ')}`,
                        );
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
                // BROWSING FLOOR (Shane 2026-07-22: "we do not need all of the
                // soundings, hazards etc in the chart page, too much noise").
                //
                // The declutter scrubber is the RIGHT lever for this — it is
                // tiered decorative-first and carries an explicit safety floor
                // (encDetailScrubber: depth bands, glaze, land, coastline, the
                // safety contour, every hazard layer and the isolated-danger
                // marks are never cut at ANY level). So a floor here cannot
                // take away anything that sinks you; it takes labels, badges,
                // minor marks and — via the SCAMIN bias, ~0.9 virtual zoom per
                // step — thins the sounding field smoothly rather than
                // blinking it off.
                //
                // A FLOOR, not a new default, and only while BROWSING. The
                // scrubber only renders with the plotting card
                // (coordCaptureMode), so raising the stored value would leave
                // the browsing chart's density behind a control you cannot see
                // there. This leaves the slider alone: plotting gets exactly
                // what the skipper set, browsing never goes below the floor.
                const BROWSE_DECLUTTER_FLOOR = 3;
                const effectiveDeclutter = coordCaptureMode ? declutter : Math.max(declutter, BROWSE_DECLUTTER_FLOOR);
                if (
                    applyChartDetailLevel(map, effectiveDeclutter, {
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
    }, [
        satelliteVisible,
        hybridVisible,
        oceanBaseVisible,
        imageryOn,
        declutter,
        mapReady,
        encVisible,
        encChartDetail,
        coordCaptureMode,
    ]);
    // ── "Depth right now" — the live tide toggle (design 2026-07-11) ──
    // Charted depth + predicted tide plus the night-dim treatment, both in
    // components/map/useTideDepthMode.ts. VISUAL ONLY by hard rule: the
    // safety contour, tracer and router keep grading against chart datum.
    const {
        tideDepthMode,
        setTideDepthMode,
        nightDim,
        setNightDim,
        tideOffsetInfo,
        showTideAck,
        setShowTideAck,
        tideScrubQ,
        setTideScrubQ,
        onToggleTideDepth,
    } = useTideDepthMode(mapRef, mapReady, planningSurface);
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
    // sample), so they keep suppressing. The depth/keel verdict itself is
    // strictly Plan-owned: OBS keeps mark/safety inspection but never turns a
    // background tap into a passage-planning depth box. Per-map flags.
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady) return;
        setEncPopupSuppression(map, pickerMode || browseWeatherInspectMode);
        setEncDepthPopupEnabled(map, cleanPlanningMap);
        return () => {
            setEncPopupSuppression(map, false);
            setEncDepthPopupEnabled(map, true);
        };
    }, [pickerMode, browseWeatherInspectMode, cleanPlanningMap, mapReady]);
    // Picker mode pauses the ENC cloud-hydration walk. Panning the
    // location picker from home water to an un-synced coast (SE QLD →
    // GBR: 74 cells / 95 MB, none on-device) otherwise downloads
    // 15-40 cells whose arrivals each force a full wide-band re-merge —
    // the allocation-spike regime that has OOM'd the WebView on device
    // ("crash and back at Newport"). Local cells still render; Charts
    // proper (pickerMode=false) hydrates as always.
    useEffect(() => {
        setEncHydrationPaused(pickerMode);
        return () => setEncHydrationPaused(false);
    }, [pickerMode]);
    // ── THE PURGE (Shane 2026-07-11: "full purge of all layers, except
    // our new one... speed is the key") ──
    // One-shot per device: the first main-surface mount strips the whole
    // weather/overlay stack so the WHITE CHART is simply what the app
    // looks like. Every toggle still exists in the ChartModes chip — this
    // resets the default, it doesn't remove capability.
    useEffect(() => {
        if (embedded || pickerMode || isPinView || planningSurface) return;
        try {
            if (localStorage.getItem('thalassa_purge_lean_v1')) return;
            localStorage.setItem('thalassa_purge_lean_v1', new Date().toISOString());
        } catch {
            return; // no storage — skip rather than clobber on every mount
        }
        // Wind is exempt as of 2026-07-21: it is the chart page's signature
        // look and is now the first-run default, so purging it would strip
        // the very thing a new device is meant to open on. Everything else
        // still goes — the purge's point was the clean white chart, and one
        // animated field over it is that look, not the old layer pile.
        for (const layer of Array.from(weather.activeLayers as Set<string>)) {
            if (layer === 'wind' || layer === 'velocity') continue;
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
    // ── Plan chart key ──
    // Deliberately user-opened on the Plan-owned map. It must never appear on
    // Chart, including as a one-shot auto-open when ENC cells first hydrate.
    const [chartKeyOpen, setChartKeyOpen] = useState(false);
    // Declutter: collapse the bottom weather cluster (model selector +
    // scrubber + legend) behind a pop-out. CLOSED on every mount and
    // deliberately no longer persisted (Shane 2026-08-04: "ensure that the
    // weather controls are closed by default") — the punter opens it when
    // they want it, and a previous session's open state never leaks forward.
    const [chartControlsHidden, setChartControlsHidden] = useState(true);
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
    const [seawayDebugVisible] = useState(false);
    const [skChartIds, setSkChartIds] = usePersistedStringSet('thalassa_map_sk_chart_ids');
    const [skChartOpacity] = usePersistedState('thalassa_map_sk_chart_opacity', 0.7);
    const [localChartIds, setLocalChartIds] = usePersistedStringSet('thalassa_map_local_chart_ids');
    const [localChartOpacity] = usePersistedState('thalassa_map_local_chart_opacity', 0.7);

    // Charts start hidden — user enables them via the Charts layer toggle.
    // AvNavService still discovers available charts in the background so
    // the layer menu can list them, but nothing renders until toggled on.

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

    // A long-lived MapHub can be switched into picker mode by its host.
    // Close any workflow that was already open as well as hiding its trigger,
    // so it cannot reappear stale when the picker later returns to chart mode.
    useEffect(() => {
        if (!pickerMode) return;
        setRoutePickerOpen(false);
        setTrackPickerOpen(false);
        setShowVesselSearch(false);
        setShowOfflineArea(false);
        setStormPickerOpen(false);
        setShowReport(false);
        setShowTideAck(false);
        setShowConsensus(false);
    }, [pickerMode, setShowConsensus, setShowTideAck, setStormPickerOpen]);

    /** Active Voyage Mode flag — mirrored from the voyages cache. When
     *  true, the chart auto-displays the boat's GPS position, the live
     *  voyage track, and the planned route, regardless of which weather
     *  layer is on. Listens for `thalassa:active-voyage-changed` so the
     *  flag flips the moment Cast Off / End Voyage runs. */
    const initialActiveVoyage = useMemo(() => getCachedActiveVoyage(), []);
    const [activeVoyageMode, setActiveVoyageMode] = useState<boolean>(initialActiveVoyage?.status === 'active');
    const [activeVoyageId, setActiveVoyageId] = useState<string | null>(
        initialActiveVoyage?.status === 'active' ? initialActiveVoyage.id : null,
    );
    const [activeVoyageName, setActiveVoyageName] = useState<string | null>(
        initialActiveVoyage?.status === 'active' ? initialActiveVoyage.voyage_name : null,
    );
    useEffect(() => {
        const sync = () => {
            const activeVoyage = getCachedActiveVoyage();
            const isActive = activeVoyage?.status === 'active';
            setActiveVoyageMode(isActive);
            setActiveVoyageId(isActive ? activeVoyage.id : null);
            setActiveVoyageName(isActive ? activeVoyage.voyage_name : null);
        };
        const unsubscribeIdentity = subscribeAuthIdentityScope(sync);
        window.addEventListener('thalassa:active-voyage-changed', sync);
        return () => {
            unsubscribeIdentity();
            window.removeEventListener('thalassa:active-voyage-changed', sync);
        };
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

    // Ref for weather layer toggle (populated after weather hook runs)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const weatherRef = useRef<{ toggleLayer: (k: any) => void; activeLayers: Set<any> } | null>(null);

    // ── Passage Planner ──
    const noChartIds = useMemo(() => new Set<string>(), []);

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
            const nmApart = calculateDistance(o.lat, o.lon, d.lat, d.lon);
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
    }, [fromQuery, toQuery, frameBusy, flashTraceFeedback, setTraceDest, setTraceOrigin]);

    const clearCourseFrame = useCallback(() => {
        setTraceOrigin(null);
        setTraceDest(null);
        setFromQuery('');
        setToQuery('');
        setCourseChip(null);
    }, [setTraceDest, setTraceOrigin]);

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
    }, [
        autoBusy,
        capturedCoords,
        traceOrigin,
        traceDest,
        passage.arrival,
        settings.vessel,
        flashTraceFeedback,
        setCapturedCoords,
    ]);

    // Follow Route overlay — REMOVED from this chart entirely (Shane
    // 2026-08-03: "on the obs page, can we ensure that the route does not
    // show up"). It was already suppressed on Plan and in the tracer
    // (2026-07-09 "remove all of the spaghetti"), which made OBS its only
    // remaining surface — and OBS stays uncluttered. The followed route
    // still renders where it earns its keep: the Log page's live map and
    // the public voyage page. useFollowRouteMapbox died with this call;
    // follow-route STATE is untouched (publishing, leg grading and the
    // destination flag below all still read it).

    // Destination flag — pulsing green flag at the active voyage's
    // destination, with a live distance + bearing chip from the user's
    // current GPS. Hidden when no voyage is active. Deliberately KEPT on
    // OBS after the follow-route line was removed: one flag is the
    // glanceable "going there" without the spaghetti.
    useDestinationFlag(mapRef, mapReady && !planningSurface);
    // Active MOB fix — plain mapReady, NOT gated on planningSurface: an
    // active MOB must never vanish because the planner happens to be open.
    useMobMarker(mapRef, mapReady);

    // Routes (planned) and Tracks (sailed) chart layers. Both come
    // from the user's ship-log entries — Routes are voyageIds prefixed
    // `planned_*`, Tracks are everything else. Each is its own layer
    // so the user can have one of each visible simultaneously, with
    // distinct colours so they read clearly when overlapped. Hidden
    // while tracing — same declutter rule as above.
    useRouteTrackLayer({
        mapRef,
        mapReady: mapReady && !planningSurface,
        variant: 'route',
        selected: activeChartRoute,
    });
    useRouteTrackLayer({
        mapRef,
        mapReady: mapReady && !planningSurface,
        variant: 'track',
        selected: activeChartTrack,
    });

    // ── Cyclone Tracking Layer ──
    useCycloneLayer(
        mapRef,
        mapReady,
        browseCycloneVisible,
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
    useSquallMap(mapRef, mapReady, browseSquallVisible, location.lat, location.lon, allCyclones, handleSelectStorm);

    // ── Cyclone zoom center-lock — keep selected storm dead-center during zoom ──
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady || !browseCycloneVisible || !closestStorm) return;

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
    }, [browseCycloneVisible, closestStorm, mapReady, mapRef]);

    // ── Weather-inspect popup (tap gesture, inspect mode only) ──
    // Hoisted out of the handler map so onMapTap stays a thin router now
    // that placement moved to onMapLongPress.
    useEffect(() => {
        if (!planningSurface) return;
        setWeatherInspectMode(false);
        setShowVesselSearch(false);
        setStormPickerOpen(false);
        setRoutePickerOpen(false);
        setTrackPickerOpen(false);
        setShowOfflineArea(false);
        setChartKeyOpen(false);
        setShowTideAck(false);
        setShowReport(false);
        setShowConsensus(false);
        if (vesselSearchMarkerTimerRef.current !== null) {
            window.clearTimeout(vesselSearchMarkerTimerRef.current);
            vesselSearchMarkerTimerRef.current = null;
        }
        vesselSearchMarkerRef.current?.remove();
        vesselSearchMarkerRef.current = null;
        closeWeatherInspect();
    }, [planningSurface, setShowConsensus, setShowTideAck, setStormPickerOpen, closeWeatherInspect]);

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
        weatherInspect: browseWeatherInspectMode,
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
                    // Coach the SPECIFIC gesture when the tap grazed a leg:
                    // mid-route insert exists, but nobody can use a feature
                    // they are never told about (Shane 2026-08-11 read the
                    // append fallback as "insert is broken").
                    const legHere = nearestLegForInsert(
                        map.project([lon, lat]),
                        capturedCoords.map((p) => map.project([p.lon, p.lat])),
                    );
                    flashTraceFeedback(
                        legHere > 0
                            ? `Hold on the line to insert between ${legHere} and ${legHere + 1}`
                            : 'Hold the chart to drop a pin',
                    );
                }
                return;
            }

            // Only show weather popup if the user explicitly enabled inspect mode
            if (!browseWeatherInspectMode) return;
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
                // Hold ON the line → insert into that leg (Shane 2026-07-09:
                // "we need to be able to insert a waypoint along the track").
                // The leg test uses the RAW press position; the inserted pin
                // is the water-snapped one. Geometry extracted to
                // nearestLegForInsert 2026-08-11 and widened — the old
                // 16 px / middle-80% window was smaller than the fingertip
                // pressing it, so Shane only ever reached the append
                // fallback and read insert as missing entirely.
                const insertLeg = nearestLegForInsert(
                    map.project([lon, lat]),
                    capturedCoords.map((p) => map.project([p.lon, p.lat])),
                );
                if (insertLeg > 0) {
                    setCapturedCoords((prev) => [...prev.slice(0, insertLeg), pt, ...prev.slice(insertLeg)]);
                    flashTraceFeedback(`Inserted between ${insertLeg} and ${insertLeg + 1} — drag to fine-tune`);
                } else {
                    setCapturedCoords((prev) => [...prev, pt]);
                    if (capturedCoords.length >= 2) {
                        // Say what happened. The silent append here is what
                        // made a missed insert look like a routing bug.
                        flashTraceFeedback('Added to the end — hold on the line to insert mid-route');
                    }
                }
                // Medium, not light: the hold earned a firmer thunk than
                // the old tap ever gave.
                triggerHaptic('medium');
            }
        },
    });

    // ── Location Dot (basic fallback — disabled when vessel tracker is active) ──
    useLocationDot(mapRef, locationDotRef, mapReady && (!effectiveVesselTrackingVisible || planningSurface));

    // ── Fly to the selected weather location when it arrives / changes ──
    // `initialCenter` on useMapInit sets the mount-time centre, but when the
    // weather data is still loading from cache it's undefined and the map
    // falls back to live GPS. This effect fills that gap: as soon as
    // weatherCoords is available — and any time it changes afterwards — we
    // recentre on the selected location. User-driven pans don't change
    // weatherCoords, so their pan sticks.
    //
    // The first centre uses the active overlay's framing zoom when one exists;
    // otherwise it jumps instantly to ZOOM 10 — the golden chart size (Shane
    // 2026-07-16: every nav mark visible, local water fills the screen). This
    // matters when default-on wind is restored before weatherCoords resolves:
    // a later z10 recenter must not overwrite wind's z3 frame. Subsequent
    // centres preserve the user's zoom so we don't yank them out of a harbour.
    const GOLDEN_BOOT_ZOOM = 10;
    const activeWeatherLayersRef = useRef<ReadonlySet<WeatherLayer>>(new Set());
    const lastFlownCoordsRef = useRef<{ lat: number; lon: number } | null>(null);
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady) return;
        if (embedded || pickerMode || planningSurface || isPinView) return;
        if (!weatherCoords) return;

        const last = lastFlownCoordsRef.current;
        if (last && Math.abs(last.lat - weatherCoords.lat) < 1e-6 && Math.abs(last.lon - weatherCoords.lon) < 1e-6) {
            return;
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ausNzFitZoom = (map as any).__ausNzMinZoom ?? map.getMinZoom();
        const isFirst = last === null;
        const activeLayerFrameZoom = getActiveLayerFrameZoom(activeWeatherLayersRef.current);
        map.jumpTo({
            center: [weatherCoords.lon, weatherCoords.lat],
            zoom: isFirst ? (activeLayerFrameZoom ?? GOLDEN_BOOT_ZOOM) : Math.max(map.getZoom(), ausNzFitZoom),
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
        planningSurface,
        isPinView,
        weatherCoords,
    ]);

    // Silent Pi-backed tile pre-cache around the boat —
    // components/map/usePiTileAutoCache.ts.
    usePiTileAutoCache({ weatherCoords, embedded, pickerMode, isPinView });

    // ── GPS Vessel Tracker Layer ──
    useVesselTracker(mapRef, mapReady, effectiveVesselTrackingVisible && !planningSurface);

    // ── Picker Mode ──
    usePickerMode(mapRef, pinMarkerRef, pickerMode, onLocationSelect);

    // Route Nudge removed — see import note above.

    // ── Weather Layers ──
    const weather = useWeatherLayers(mapRef, mapReady, embedded, location, planningSurface);
    activeWeatherLayersRef.current = weather.userLayers;
    weatherRef.current = weather;

    // ── Clear Follow Route when passage mode activates ──
    const prevShowPassageRef = useRef(passage.showPassage);
    useEffect(() => {
        if (passage.showPassage && !prevShowPassageRef.current) {
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
    }, [passage.showPassage]);

    // ── Cyclone-aware temporal snap — REMOVED ──
    // Previously this scanned all GFS forecast hours to find the vortex center
    // closest to the ATCF position and overrode the wind scrubber. However, this
    // always biased toward hour-0 (model initialization) which showed wind data
    // 5-6 hours in the past. The time-based "now" index already produces correct
    // wind alignment with the tracked cyclone position.

    // ── Embedded Rain (also loads as background on full-map velocity mode) ──
    const embeddedRain = useEmbeddedRain(mapRef, embedded && !planningSurface, mapReady, false);

    // ── AIS Vessel Target Layer ──
    useAisLayer(mapRef, mapReady, browseAisVisible);
    useAisStreamLayer(mapReady ? mapRef.current : null, browseAisVisible);

    // ── Chokepoint Tracker ──
    useChokepointLayer(mapReady ? mapRef.current : null, browseChokepointVisible);

    // ── Signal K Nautical Charts ──
    const skCharts = useAvNavCharts(mapRef, mapReady, planningSurface ? noChartIds : skChartIds, skChartOpacity);

    // ── Free Chart Catalog (NOAA, LINZ) ──
    const chartCatalog = useChartCatalog(mapRef, mapReady, !planningSurface);

    // ── Local MBTiles Charts (on-phone, no AvNav needed) ──
    const localCharts = useLocalCharts(
        mapRef,
        mapReady,
        planningSurface ? noChartIds : localChartIds,
        localChartOpacity,
    );

    // ── Offline OSM raster fallback — renders when offline, invisible when online ──
    useOfflineBaseLayer(mapRef, mapReady, isOnline);
    const chartsActive =
        !planningSurface && (skChartIds.size > 0 || chartCatalog.hasEnabledCharts || localChartIds.size > 0);
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
        [skChartIds, localChartIds, chartCatalog, skCharts, localCharts, setLocalChartIds, setSkChartIds],
    );

    // ── Interactive Sea Marks (OpenSeaMap / Overpass API) ──
    // When o-charts or the ENC vector chart render their own navaids:
    //   'identify' mode (invisible hit targets, still click-to-identify)
    // When no charts: 'full' mode (renders IALA icons + click-to-identify)
    const seamarkMode = chartsActive || encActive ? ('identify' as const) : ('full' as const);
    useSeamarkLayer(mapRef, mapReady, browseSeamarkVisible, seamarkMode);

    // ── Tide Station Markers ──
    useTideStationLayer(mapRef, mapReady, browseTideStationsVisible);
    useAnchorageLayer(mapRef, mapReady, browseAnchorageVisible);
    // Armed anchor watch — anchor point + swing-radius ring (self-subscribes).
    useAnchorSwingLayer(mapRef, mapReady);

    // ── Notices to Mariners + low bridges on the chart (📄 / 🌉 tap-to-read) ──
    // Curated standing notices (MSQ-class, e.g. Mooloolah River bar); broadcast
    // NAVAREA warnings viewport-scoped at zoom ≥ 6; plus the curated low-bridge
    // clearances (this one hook owns BOTH — its `visible` flag gates the lot).
    // PLOTTING-ONLY (Shane 2026-07-17: "remove the bridges and the notice to
    // mariners from the chart page, not the plan page"): they're passage-
    // planning furniture, so they ride with the tracer and leave the browsing
    // chart clean.
    useNoticeLayer(mapRef, mapReady, coordCaptureMode);

    /**
     * Stable identities — these used to be inline arrows in the RadialHelmMenu
     * props, minted fresh on EVERY render. RadialHelmMenu lists both in the
     * dependency arrays of its drag callbacks, so during wind playback (which
     * re-renders ~10x/second as the hour advances) it was rebuilding those
     * callbacks on every frame for no reason.
     */
    const windOnGuards = useCallback(
        (layer: string) => {
            // Wind and lightning are mutually exclusive (see the boot-time
            // resolver below) — enforced on BOTH edges, because a one-sided
            // guard just means whichever you tap second wins.
            setLightningVisible(false);
            void layer;
        },
        [setLightningVisible],
    );

    /**
     * Ease to the layer's own framing zoom on its OFF -> ON edge.
     *
     * This lived inside the tap handlers and behaved backwards: turning wind
     * off could trigger its framing zoom while turning it on did nothing. Two
     * reasons, and the effect fixes both:
     *
     *  1. helmSelectInGroup had NO on/off test — the radial menu drives these
     *     through selectInGroup, and selecting the already-active layer turns
     *     it OFF, so every tap zoomed, including the one that killed the layer.
     *  2. helmToggleLayer's test read activeLayers BEFORE its own toggle had
     *     been applied, and the ease then raced the grid fetch that activation
     *     kicks off.
     *
     * Reacting to the STATE TRANSITION instead of the tap removes both
     * questions: by the time this runs the set is authoritative, and comparing
     * against the previous value means it can only fire when wind actually
     * came on. 'velocity' is the legacy alias for the same overlay, so both
     * keys count — missing it would make the edge undetectable when the layer
     * is stored under the older name.
     *
     * Fires ONLY on that edge, which is what keeps an unconditional easeTo
     * tolerable: it cannot fight you while you are working, because merely
     * panning or zooming with wind already on never re-triggers it.
     */
    const prevSnapLayersRef = useRef<Set<string>>(new Set());
    useEffect(() => {
        const framed = Object.keys(LAYER_FRAME_ZOOM) as WeatherLayer[];
        const on = new Set(framed.filter((k) => weather.userLayers.has(k)));
        const prev = prevSnapLayersRef.current;
        prevSnapLayersRef.current = on;
        if (planningSurface) return;
        // Fire only for a layer that NEWLY appears. Comparing sets (rather
        // than a single boolean) also catches a SWITCH between two framed
        // layers — e.g. rain to wind via selectInGroup is a fresh framing
        // decision, not a continuation, and selectInGroup makes that one tap.
        const newlyOn = [...on].find((k) => !prev.has(k)) as WeatherLayer | undefined;
        if (!newlyOn) return;
        // EXCEPT when a pressure overlay pair is forming. Since pressure
        // left the atmosphere exclusion group (2026-08-02), isobars STACK on
        // ANY host layer — wind, rain, clouds, temperature — and
        // useWeatherLayers renders the clean contour overlay whenever
        // pressure shares the map. Adding isobars on top of a layer the
        // skipper is already reading enriches that view; yanking the camera
        // to pressure's z2 synoptic frame would throw it away. The host test
        // reads the FULL selection (userLayers), not `on` — `on` is filtered
        // to framed layers and clouds/temperature aren't framed, so a
        // clouds-hosted overlay looked like pressure-solo through it
        // (audit 2026-08-02).
        const pairForming =
            (newlyOn === 'pressure' && weather.userLayers.size > 1) ||
            ((newlyOn === 'wind' || newlyOn === 'velocity') && on.has('pressure'));
        if (pairForming) return;
        const zoom = LAYER_FRAME_ZOOM[newlyOn];
        if (zoom === undefined) return;
        const m = mapRef.current;
        if (!m) return;
        try {
            // A SNAP, not a floor. Switching one of these on is a deliberate
            // change of task, so it gets the layer's known frame every time
            // rather than one that depends on where you happened to be.
            m.easeTo({ zoom, duration: 600 });
        } catch {
            /* map mid-teardown */
        }
        // LAYER_FRAME_ZOOM is a module constant now (mapConstants) — shared
        // with useWeatherLayers' minZoom floor, and not a valid dependency.
    }, [weather.userLayers, planningSurface]);

    const helmToggleLayer = useCallback(
        (layer: WeatherLayer) => {
            if ((layer === 'wind' || layer === 'velocity') && !weather.activeLayers.has(layer)) {
                windOnGuards(layer);
            }
            weather.toggleLayer(layer);
        },
        [weather, windOnGuards],
    );

    const helmSelectInGroup = useCallback(
        (layer: WeatherLayer, group: WeatherLayer[]) => {
            if (layer === 'wind' || layer === 'velocity') windOnGuards(layer);
            weather.selectInGroup(layer, group);
        },
        [weather, windOnGuards],
    );

    // ── Lightning Strikes (Blitzortung) ──
    // Off while plotting, same reasoning as the weather overlays: strike glyphs
    // are chart-browsing furniture and they land straight on top of the route.
    // Gated at the VISIBLE flag, never at `lightningVisible` itself, so the
    // punter's persisted toggle comes back with the browsing chart.
    useLightningLayer(mapRef, mapReady, browseLightningVisible);

    // Resolve the wind/lightning exclusion ONCE AT BOOT.
    //
    // The toggle handlers enforce it going forward, but they only fire when
    // something is tapped — and lightningVisible is PERSISTED
    // ('thalassa_map_lightning_visible') while wind is on by default. So a
    // session that ever left lightning on came back with both up, which is the
    // state Shane screenshotted on 2026-07-22 minutes after the exclusion
    // landed. A rule enforced only on transitions is not a rule.
    //
    // Wind wins: it is the default overlay and the one the model chips and
    // scrubber below are driving. Lightning is one tap away.
    const bootExclusionRef = useRef(false);
    useEffect(() => {
        // A Plan-owned MapHub must never resolve a Chart preference conflict:
        // doing so would mutate persisted browsing state from a surface where
        // neither layer is even rendered. Defer the one-shot until this map is
        // genuinely back in Chart browsing mode.
        if (!mapReady || planningSurface || bootExclusionRef.current) return;
        bootExclusionRef.current = true;
        if (lightningVisible && (weather.activeLayers.has('wind') || weather.activeLayers.has('velocity'))) {
            setLightningVisible(false);
        }
        // Boot-only: deps deliberately exclude the values it reads, so a later
        // legitimate toggle is not undone by this effect re-running.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mapReady, planningSurface]);

    // ── Ocean Currents (CMEMS via Mapbox raster-particle) ──
    // Gated by VITE_CMEMS_CURRENTS_ENABLED. When the flag is off the hook
    // no-ops and the existing Xweather raster-currents tile layer renders
    // instead (managed by useWeatherLayers via the 'currents' WeatherLayer).
    const currentsVisible = weather.activeLayers.has('currents');
    const currentsLoadState = useOceanCurrentParticleLayer(mapRef, mapReady, currentsVisible, weather.currentsHour);

    // ── Ocean Waves (CMEMS WAM forecast via the particle-layer engine) ──
    // Same pattern as currents: gated by VITE_CMEMS_WAVES_ENABLED, pulls
    // from /api/waves, replaces the Xweather wave-height raster when the
    // flag is on. Waves use their own scrubber step (3-hourly, 17 frames)
    // separate from currents' 13-hourly.
    const wavesVisible = weather.activeLayers.has('waves');
    const wavesLoadState = useOceanWaveParticleLayer(mapRef, mapReady, wavesVisible, weather.wavesHour);

    // ── Sea-surface temperature (CMEMS daily P1D-m raster heatmap) ──
    // Scalar field — no particles. Gated by VITE_CMEMS_SST_ENABLED.
    // 5-day forecast, daily cadence = 5 scrubber steps.
    const sstVisible = weather.activeLayers.has('sst');
    const sstLoadState = useSstRasterLayer(mapRef, mapReady, sstVisible, weather.sstStep);

    // ── Chlorophyll (CMEMS BGC daily raster heatmap) ──
    // Scalar field like SST. Net-new — no Xweather fallback. Gated by
    // VITE_CMEMS_CHL_ENABLED. Daily cadence, 5-day forecast.
    const chlVisible = weather.activeLayers.has('chl');
    const chlLoadState = useChlRasterLayer(mapRef, mapReady, chlVisible, weather.chlStep);

    // ── Sea-ice concentration (CMEMS physics daily raster heatmap) ──
    // Scalar field. Polar-only by definition (shader discards <15%).
    // Net-new — unlocks high-latitude routing (Baltic winter, Alaska,
    // Svalbard, Antarctic). Gated by VITE_CMEMS_SEAICE_ENABLED.
    const seaiceVisible = weather.activeLayers.has('seaice');
    const seaiceLoadState = useSeaIceRasterLayer(mapRef, mapReady, seaiceVisible, weather.seaiceStep);

    // ── Mixed-layer depth (CMEMS physics daily raster heatmap) ──
    // Scalar field log-encoded over [1m, 1000m]. Plasma ramp.
    // Niche — relevant to thermocline-tracking deep-sea fishers and
    // ocean modellers. Gated by VITE_CMEMS_MLD_ENABLED.
    const mldVisible = weather.activeLayers.has('mld');
    const mldLoadState = useMldRasterLayer(mapRef, mapReady, mldVisible, weather.mldStep);

    const cmemsLayerStates: Record<CmemsLayerId, CmemsLayerLoadState> = {
        currents: currentsLoadState,
        waves: wavesLoadState,
        sst: sstLoadState,
        chl: chlLoadState,
        seaice: seaiceLoadState,
        mld: mldLoadState,
    };
    let activeCmemsPlayback: CmemsPlaybackConfig | null = null;
    if (currentsVisible && isCmemsFeatureEnabled('currents')) {
        activeCmemsPlayback = {
            layer: 'currents',
            label: 'Currents',
            visible: true,
            playing: weather.currentsPlaying,
            step: weather.currentsHour,
            totalSteps: weather.currentsTotalHours,
            dwellMs: CMEMS_VECTOR_DWELL_MS,
            status: currentsLoadState,
            setStep: weather.setCurrentsHour,
            setPlaying: weather.setCurrentsPlaying,
            setLayerVisibility: weather.setLayerVisibility,
        };
    } else if (wavesVisible && isCmemsFeatureEnabled('waves')) {
        activeCmemsPlayback = {
            layer: 'waves',
            label: 'Waves',
            visible: true,
            playing: weather.wavesPlaying,
            step: weather.wavesHour,
            totalSteps: weather.wavesTotalHours,
            dwellMs: CMEMS_VECTOR_DWELL_MS,
            status: wavesLoadState,
            setStep: weather.setWavesHour,
            setPlaying: weather.setWavesPlaying,
            setLayerVisibility: weather.setLayerVisibility,
        };
    } else if (sstVisible && isCmemsFeatureEnabled('sst')) {
        activeCmemsPlayback = {
            layer: 'sst',
            label: 'Sea temperature',
            visible: true,
            playing: weather.sstPlaying,
            step: weather.sstStep,
            totalSteps: weather.sstTotalSteps,
            dwellMs: CMEMS_SCALAR_DWELL_MS,
            status: sstLoadState,
            setStep: weather.setSstStep,
            setPlaying: weather.setSstPlaying,
            setLayerVisibility: weather.setLayerVisibility,
        };
    } else if (chlVisible && isCmemsFeatureEnabled('chl')) {
        activeCmemsPlayback = {
            layer: 'chl',
            label: 'Chlorophyll',
            visible: true,
            playing: weather.chlPlaying,
            step: weather.chlStep,
            totalSteps: weather.chlTotalSteps,
            dwellMs: CMEMS_SCALAR_DWELL_MS,
            status: chlLoadState,
            setStep: weather.setChlStep,
            setPlaying: weather.setChlPlaying,
            setLayerVisibility: weather.setLayerVisibility,
        };
    } else if (seaiceVisible && isCmemsFeatureEnabled('seaice')) {
        activeCmemsPlayback = {
            layer: 'seaice',
            label: 'Sea ice',
            visible: true,
            playing: weather.seaicePlaying,
            step: weather.seaiceStep,
            totalSteps: weather.seaiceTotalSteps,
            dwellMs: CMEMS_SCALAR_DWELL_MS,
            status: seaiceLoadState,
            setStep: weather.setSeaiceStep,
            setPlaying: weather.setSeaicePlaying,
            setLayerVisibility: weather.setLayerVisibility,
        };
    } else if (mldVisible && isCmemsFeatureEnabled('mld')) {
        activeCmemsPlayback = {
            layer: 'mld',
            label: 'Mixed-layer depth',
            visible: true,
            playing: weather.mldPlaying,
            step: weather.mldStep,
            totalSteps: weather.mldTotalSteps,
            dwellMs: CMEMS_SCALAR_DWELL_MS,
            status: mldLoadState,
            setStep: weather.setMldStep,
            setPlaying: weather.setMldPlaying,
            setLayerVisibility: weather.setLayerVisibility,
        };
    }
    useCmemsAutoplay(activeCmemsPlayback);
    useCmemsFailureBoundary(activeCmemsPlayback);

    // Attribute the CMEMS products that are actually rendering. The feature
    // helpers mirror each layer hook's own gate, so a legacy fallback never
    // gets incorrectly labelled as Copernicus Marine data.
    const cmemsAttributionLayers: CmemsLayerId[] = [];
    if (isCmemsStepPresented(currentsLoadState)) {
        cmemsAttributionLayers.push('currents');
    }
    if (isCmemsStepPresented(wavesLoadState)) {
        cmemsAttributionLayers.push('waves');
    }
    if (isCmemsStepPresented(sstLoadState)) {
        cmemsAttributionLayers.push('sst');
    }
    if (isCmemsStepPresented(chlLoadState)) {
        cmemsAttributionLayers.push('chl');
    }
    if (isCmemsStepPresented(seaiceLoadState)) {
        cmemsAttributionLayers.push('seaice');
    }
    if (isCmemsStepPresented(mldLoadState)) {
        cmemsAttributionLayers.push('mld');
    }

    // ── Marine Protected Areas (CAPAD GeoJSON overlay) ──
    // Independent protected-area context toggle. CAPAD boundaries do not
    // determine whether entry, anchoring, fishing or another activity is legal.
    // Gated by VITE_MPA_ENABLED.
    useMpaLayer(mapRef, mapReady, weather.mpaVisible && !planningSurface, weather.setMpaVisible);

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
    // coordCaptureMode last: with the chart toggled off, the pipeline still
    // has to MOUNT while the tracer is up, or the plotting keel floor has no
    // layers to raise and the plot surface loses its depth read entirely.
    useEncVectorLayer(mapRef, mapReady, encVisible, encChartDetail, encSafetyDepthM, encHazardDepthM, coordCaptureMode);
    // Planning-only chart furniture: a few chart-backed direction-of-buoyage
    // arrows at numbered laterals. OBS stays uncluttered, and a picker must
    // remain a pure location-selection surface.
    useBuoyageDirectionLayer(mapRef, mapReady, cleanPlanningMap && !pickerMode);
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
            try {
                encSetPlottingMode(map, false);
            } catch {
                /* layers unmounted — nothing to lower */
            }
        };
    }, [mapReady, coordCaptureMode]);

    // Seaway Graph debug overlay — compiles gates/edges from the installed
    // cells for the viewport whenever the toggle is on (Phase 10).
    useSeawayDebugLayer(mapRef, mapReady, seawayDebugVisible);

    // Pending fit-to-bbox requests (EncCellManager "show me on the map") —
    // components/map/useMapFitRequest.ts.
    useMapFitRequest(mapRef, mapReady);

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

    // ── Pin View (chat pin tap) — components/map/usePinViewMode.ts ──
    // Pin marker, weather-layer snapshot/restore, identity sync, and the
    // Get Directions handler. isPinView/ownedPinViewRef stay declared above
    // (the tracer region reads them); this hook only consumes them.
    const { pinDirectionsBusy, pinDirectionsError, handlePinDirections } = usePinViewMode({
        mapRef,
        mapReady,
        isPinView,
        setIsPinView,
        ownedPinViewRef,
        pinMarkerRef,
        weather,
        cycloneVisible,
        setCycloneVisible,
        squallVisible,
        setSquallVisible,
        saveVoyagePlan,
    });

    // Picker hosts still need a fully interactive map, so they cannot use the
    // static `embedded` contract. Treat pickerMode as its own chrome boundary:
    // the tap-to-select layer stays live while route, weather, AIS, offline,
    // passage, and diagnostic workflows remain unavailable behind the host
    // dialog.

    // Determine if tablet split-screen is active
    const isHelmSplit = deviceMode === 'helm' && passage.showPassage && !embedded && !pickerMode;
    const showEmbeddedRainViewerAttribution = embedded && embeddedRain.embRainCount > 0 && embeddedRain.embRainIdx >= 0;

    return (
        <div data-testid="map-hub" className={`w-full h-full ${isHelmSplit ? 'flex' : 'relative'}`}>
            {/* Floating route-enhancement chip — visible while the */}
            {/* passage planner's bathymetric/weather/depth pipeline runs */}
            {/* in the background after the basic plan lands. */}
            {!pickerMode && <RouteEnhancementChip />}
            {/* Map container — 70% on tablet during passage, full otherwise */}
            <div className={`relative ${isHelmSplit ? 'flex-[7] h-full' : 'w-full h-full'}`}>
                <div ref={containerRef} className="w-full h-full" />

                {pickerMode && (
                    <div
                        role="status"
                        aria-live="polite"
                        className="pointer-events-none absolute left-1/2 top-[max(12px,env(safe-area-inset-top))] z-[720] w-[min(420px,calc(100%-112px))] -translate-x-1/2 rounded-2xl border border-sky-400/30 bg-slate-950/92 px-4 py-3 text-center shadow-2xl backdrop-blur-xl"
                    >
                        <p className="text-sm font-black text-white">
                            {pickerLabel || 'Tap the chart to choose a location'}
                        </p>
                        <p className="mt-1 text-xs text-sky-200/80">
                            Your tap is marked and saved immediately. Use Back to cancel.
                        </p>
                    </div>
                )}

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
                <PinDirectionsCta
                    visible={isPinView}
                    busy={pinDirectionsBusy}
                    error={pinDirectionsError}
                    onRequest={() => void handlePinDirections()}
                />
                {/* ═══ ZOOM-LEVEL FAB ═══
                    Top-left pill showing current map zoom — self-
                    subscribed so per-frame zoom events re-render the
                    pill alone, never this tree. Mirrors the Bosun mic
                    FAB top-right position (top:56px right:16px in
                    App.tsx). Visible in pin-view too. */}
                {!pickerMode && <ZoomLevelFab mapRef={mapRef} mapReady={mapReady} />}

                {/* Visual raster beneath the ENC stack. Satellite and Ocean
                    used to be wired map layers with no remaining control;
                    this restores an explicit, session-only way to reach them. */}
                <MapBaseSelector
                    visible={!planningSurface && !embedded && !pickerMode && !isPinView}
                    value={mapBase}
                    onChange={setMapBase}
                />

                {/* ═══ VELOCITY WIND OVERLAY ═══ */}
                {/* Hidden while plotting: wind particles animate straight over
                    the surface you are trying to draw a route on, and the
                    plotting chart has to stay legible (Shane 2026-07-22, twice).
                    coordCaptureMode is the established plotting flag (declared
                    :426, used ~40 places).

                    NARROW ON PURPOSE. 799dc4d0 gated this same line and was
                    reverted in a484571b — not because gating wind was wrong,
                    but because it ALSO gated the weather controls, which
                    stripped the legend and scrubber for EVERY weather layer
                    and took the planning chart with it. Keep this guard
                    narrow: this overlay alone is the whole fix. */}
                {/* ALSO hidden while a MOB is active (Shane 2026-08-07, with a
                    screenshot: the particle field covered the casualty marker,
                    the vessel and the water so completely that "MOB 1:13 · last
                    fix 15s ago" was unreadable). During a recovery the chart
                    has one job. Nothing is unselected — this gates the RENDER
                    on mobActive, so the skipper's wind layer returns by itself
                    the moment MOB clears, with no state to restore and nothing
                    to get wrong under pressure. Same narrow discipline as the
                    plotting guard above: the overlay only, never the controls,
                    legend or scrubber (799dc4d0 was reverted for exactly
                    that). */}
                {!isPinView && !embedded && !pickerMode && !planningSurface && (
                    <MapboxVelocityOverlay
                        mapboxMap={mapRef.current}
                        visible={
                            !mobActive && (weather.activeLayers.has('velocity') || weather.activeLayers.has('wind'))
                        }
                        windHour={weather.windHour}
                        windGrid={weather.windState.grid ?? undefined}
                    />
                )}

                {/* ═══ GHOST SHIP (route interpolation during forecast scrub) ═══ */}
                <Suspense fallback={null}>
                    {!isPinView && !embedded && !pickerMode && passage.showPassage && passage.routeAnalysis && (
                        <GhostShip
                            map={mapRef.current}
                            routeCoords={passage.isoResultRef.current?.routeCoordinates ?? null}
                            departureTime={passage.departureTime || new Date().toISOString()}
                            speed={passage.speed}
                            windHour={weather.windHour}
                            windForecastHours={weather.windForecastHours}
                            windNowIdx={weather.windNowIdx}
                            visible={
                                (weather.activeLayers.has('wind') || weather.activeLayers.has('velocity')) &&
                                passage.showPassage &&
                                !!passage.routeAnalysis
                            }
                        />
                    )}
                </Suspense>

                {!pickerMode && (
                    <PassageBanner
                        passage={passage}
                        isoProgress={isoProgress}
                        passageNotice={passageNotice}
                        embedded={embedded}
                        isPinView={isPinView}
                        deviceMode={deviceMode}
                    />
                )}

                {/* ═══ RADIAL HELM MENU (gesture-based layer control) ═══
                    Hidden while TRACING (Shane 2026-07-17: routing page
                    declutter) — Done brings the rail back. */}
                {!planningSurface && !embedded && !pickerMode && !isPinView && (
                    <RadialHelmMenu
                        activeLayers={weather.activeLayers}
                        // WIND AND LIGHTNING ARE MUTUALLY EXCLUSIVE (Shane
                        // 2026-07-22: "we should not have wind and lightning on
                        // the same screen"). Wind draws thousands of moving
                        // particles across the whole viewport; strike glyphs
                        // land on top of them and neither reads. Enforced on
                        // BOTH edges — here when wind goes on, and in
                        // onToggleLightning below when lightning does — because
                        // a one-sided guard just means whichever you tap second
                        // wins, which is the bug rather than the fix.
                        toggleLayer={helmToggleLayer}
                        selectInGroup={helmSelectInGroup}
                        tacticalState={buildTacticalState({
                            aisVisible,
                            setAisVisible,
                            cycloneVisible,
                            setCycloneVisible,
                            squallVisible,
                            setSquallVisible,
                            allCyclones,
                            cyclonePickerPendingRef,
                            setStormPickerOpen,
                            setChokepointVisible,
                            seamarkVisible,
                            setSeamarkVisible,
                            tideStationsVisible,
                            setTideStationsVisible,
                            anchorageVisible,
                            setAnchorageVisible,
                            lightningVisible,
                            setLightningVisible,
                            weatherInspectMode,
                            setWeatherInspectMode,
                            weather,
                            mobActive,
                            setPage,
                        })}
                        chartsState={{
                            // Compose optional chart sources plus Routes + Tracks in
                            // the radial menu's fourth category. RadialHelmMenu names
                            // that category from what is actually present.
                            // RE-THOUGHT 2026-08-03 (Shane, hours after the always-on
                            // follow-route line left OBS: "maybe we should have a toggle
                            // switch layer for routes… so a punter could select a track
                            // if he wanted to see what the weather was going to do"):
                            // Routes + Tracks are back as ALWAYS-AVAILABLE pickers — the
                            // deliberate pull-up-a-passage-to-read-weather-along-it
                            // move, which is the right shape: opt-in per look, not
                            // always-on spaghetti. The chart-source grab-bag (SignalK /
                            // NOAA / ECDIS / local) stays PARKED behind
                            // CHARTS_FAB_CATEGORY_VISIBLE (Shane 2026-07-17: the boat's
                            // own ENC/o-charts load automatically by zoom; those pickers
                            // are niche). Without optional overlays the fan says
                            // "Routes"; with feature-gated MPA context the mixed
                            // category says "Map", never "Charts".
                            sources: [
                                // CAPAD protected-area context belongs with map
                                // overlays, not the tactical danger menu. Its
                                // popup remains explicitly indicative and
                                // requires users to verify current rules.
                                ...(isMpaEnabled()
                                    ? [
                                          {
                                              id: 'mpa',
                                              label: 'MPAs',
                                              iconKind: 'generic' as const,
                                              enabled: weather.mpaVisible,
                                              onToggle: () => weather.setMpaVisible(!weather.mpaVisible),
                                          },
                                      ]
                                    : []),
                                // Routes — picker for saved planned passages from
                                // the ships log. Tap opens a sheet listing them;
                                // selection draws the route as a violet dashed line
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
                                ...(!CHARTS_FAB_CATEGORY_VISIBLE
                                    ? []
                                    : [
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
                                      ]),
                            ],
                        }}
                    />
                )}

                {/* Plan ENC Route action moved into the ChartModes dropdown
                    (2026-05-18) — sits between "Charts Only" and "Clear All".
                    The floating top-left pill was easily missed and crowded
                    the FAB column. */}

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
                        className="map-tracer-panel absolute left-3 z-[9995]"
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
                            // The chart key now lives in the left rail between the
                            // tracer and detail scrubber. Scrubber bottom 5.4rem + its
                            // ~44px height puts its top edge at ~130px; the key starts
                            // at 8.8rem and is 44px high. A 12rem tracer bottom leaves
                            // a deliberate ~7px seam above it, keeping the three cards
                            // visibly stacked whether the tracer is open or folded.
                            bottom: coordCaptureMode
                                ? 'calc(12rem + env(safe-area-inset-bottom))'
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
                                className={`map-tracer-card flex w-72 flex-col overflow-hidden rounded-2xl border border-amber-500/30 bg-slate-900/95 shadow-2xl ${
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
                                    <div
                                        // THE scroller is the whole card body now. It used to be
                                        // only the waypoint list, with keel line, saved-route,
                                        // plot row, report, depart, time selects, NOW and GPS-fix
                                        // all pinned around it — so once tide was added the one
                                        // flexible child was left about 40px and clipped its rows
                                        // mid-glyph. Pinning that much furniture only works while
                                        // the card is nearly empty; it is not any more.
                                        //
                                        // Wheel/touch propagation stops here because the card is
                                        // positioned in MAP CONTAINER coords, so Mapbox's
                                        // scrollZoom would otherwise preventDefault the wheel and
                                        // nothing would scroll on desktop at all.
                                        onWheel={(e) => e.stopPropagation()}
                                        onTouchMove={(e) => e.stopPropagation()}
                                        className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain"
                                    >
                                        {/* Draft honesty — ALWAYS say what keel the verdicts
                                checked; amber when it's the 2.5 m fallback, LOUD
                                when the number reads like a units mix-up (field
                                bug 2026-07-09: a 12.0 m keel turned every leg
                                into "needs +12.5 m tide" in deep water — draft
                                had been saved through the wrong unit toggle). */}
                                        {vesselDraftIsAssumed(settings.vessel) ? (
                                            <div className="border-b border-white/10 px-3 py-1.5 text-[10px] font-bold text-amber-400">
                                                ⚠ Assumed {vesselDraftMetres(settings.vessel).toFixed(1)} m draft —
                                                confirm Draft in Settings → Vessel before following or Cast Off.
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
                                        {/* Colour key REMOVED once pins exist (Shane 2026-07-23:
                                "not necessary as each waypoint also tells us if we
                                are able to go somewhere"). It was added because the
                                colours were undefined anywhere — but that argument
                                only held while the rows themselves said nothing.
                                They now carry their own verdict text, so the key was
                                restating in the abstract what the row below states in
                                the concrete, and costing a strip of the card's
                                scarcest asset — vertical space on a phone. The
                                empty-state copy still carries the key, because with
                                no pins yet there is no row to read it from. */}
                                        {/* Selected-pin editor: tap a numbered pin on the
                                chart → delete it or splice a new pin after it
                                (fixing pin 5 of 29 no longer costs 24 Undos). */}
                                        {selectedPin !== null && selectedPin < capturedCoords.length && (
                                            <TracerPinEditor
                                                selectedPin={selectedPin}
                                                setSelectedPin={setSelectedPin}
                                                pinCount={capturedCoords.length}
                                                setCapturedCoords={setCapturedCoords}
                                                legAnchor={legAnchor}
                                                insertAfter={insertAfter}
                                                setInsertAfter={setInsertAfter}
                                                insertAfterRef={insertAfterRef}
                                                flashTraceFeedback={flashTraceFeedback}
                                            />
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
                                        <TracerSavedRoutePicker
                                            savedTraces={savedTraces}
                                            setSavedTraces={setSavedTraces}
                                            showSavedTraces={showSavedTraces}
                                            setShowSavedTraces={setShowSavedTraces}
                                            openSavedTrace={openSavedTrace}
                                        />
                                        <TracerWaypointList
                                            capturedCoords={capturedCoords}
                                            legVerdicts={legVerdicts}
                                            tideLabels={tideLabels}
                                            tideAnchor={tideAnchor}
                                            departureMs={departureMs}
                                            departureLabel={departureLabel}
                                            mapRef={mapRef}
                                            pulseMarkHalo={pulseMarkHalo}
                                        />
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
                                        {/* Long legs are cut into grid-sized pieces and depth-checked
                                            automatically — this only offers to make those check-points
                                            into real waypoints, for export or a chartplotter. It is
                                            deliberately opt-in: inserted pins stay put when their
                                            parent is dragged, which would silently dogleg the route. */}
                                        {splitPointCount > 0 && (
                                            <div className="border-t border-white/10 px-3 py-2">
                                                <button
                                                    onClick={materialiseSplitWaypoints}
                                                    className="w-full rounded-lg bg-teal-500/15 py-2 text-[11px] font-black uppercase tracking-wide text-teal-300 active:scale-95"
                                                >
                                                    📍 Add {splitPointCount} check waypoint
                                                    {splitPointCount === 1 ? '' : 's'}
                                                </button>
                                                <p className="px-0.5 pt-1 text-[10px] leading-snug text-gray-400">
                                                    Long legs are already checked at these points. Adding them puts them
                                                    in the saved route.
                                                </p>
                                            </div>
                                        )}
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
                                        <TracerInputRows
                                            departureMs={departureMs}
                                            setDepartureMs={setDepartureMs}
                                            coordEntry={coordEntry}
                                            setCoordEntry={setCoordEntry}
                                            addCoordPin={addCoordPin}
                                        />
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
                                                    disabled={capturedCoords.length < 2 || !traceReleaseGate.allowed}
                                                    title={
                                                        traceReleaseGate.allowed
                                                            ? 'Save this checked route'
                                                            : traceReleaseGate.reason
                                                    }
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
                                                                disabled={
                                                                    capturedCoords.length < 2 ||
                                                                    traceReleaseGate.verification?.draftAssumed === true
                                                                }
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
                                            {capturedCoords.length >= 2 && !traceReleaseGate.allowed && (
                                                <div
                                                    role="status"
                                                    className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-2 py-1.5 text-[10px] font-bold leading-snug text-amber-200"
                                                >
                                                    Route not ready to save, export or sail: {traceReleaseGate.reason}
                                                </div>
                                            )}
                                            {traceReleaseGate.verification?.result === 'danger-acknowledged' && (
                                                <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-2 py-1.5 text-[10px] font-black leading-snug text-red-200">
                                                    Checked route includes explicitly acknowledged no-go legs. That
                                                    warning travels with the saved/exported route.
                                                </div>
                                            )}
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
                {showReport && !pickerMode && (
                    <Suspense fallback={<TraceReportLoading />}>
                        <TraceReportModal
                            open={showReport}
                            onClose={() => setShowReport(false)}
                            pins={capturedCoords}
                            routeName={traceName}
                            verdicts={legVerdicts}
                            tideLabels={tideLabels}
                            departureLabel={departureLabel}
                            ackedLegs={ackedLegs}
                            releaseGate={traceReleaseGate}
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
                    </Suspense>
                )}

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
                <ChartDepthControls
                    surfaceVisible={!planningSurface && !embedded && !pickerMode && !isPinView}
                    chartKeyVisible={planChartKeyVisible}
                    plotting={coordCaptureMode}
                    tideDepthMode={tideDepthMode}
                    tideOffsetInfo={tideOffsetInfo}
                    tideScrubQ={tideScrubQ}
                    onTideScrubChange={setTideScrubQ}
                    onToggleTideDepth={onToggleTideDepth}
                    encCellCount={encCellCount}
                    encReferenceCellCount={encReferenceCellCount}
                    encVisible={encVisible}
                    encHydration={encHydration}
                    encNoCoverage={encNoCoverage}
                    referenceNoticeVisible={!embedded && !pickerMode && !isPinView}
                    nightDim={nightDim}
                    onNightDimChange={setNightDim}
                    onToggleChartKey={() => setChartKeyOpen((open) => !open)}
                    onOpenEncLibrary={() => setPage('encLibrary')}
                />
                <Suspense fallback={null}>
                    <ChartKeyPanel
                        // Plan deliberately keeps this one reference available:
                        // it opens above the tracer card without restoring any
                        // optional Chart layers or the rest of the depth chrome.
                        visible={chartKeyOpen && planChartKeyVisible}
                        imageryOn={imageryOn}
                        tideDepthMode={tideDepthMode}
                        draftConfigured={Number(settings.vessel?.draft) > 0}
                        onClose={() => setChartKeyOpen(false)}
                    />
                </Suspense>
                <LiveTideAckModal
                    visible={showTideAck && !planningSurface && !pickerMode}
                    onCancel={() => setShowTideAck(false)}
                    onAccept={() => {
                        setShowTideAck(false);
                        setTideDepthMode(true);
                    }}
                />
                {/* Chart modes — top-center one-tap layer presets so a
                    new user can go from blank chart to "Day Sail" or
                    "Storm Watch" in a single tap, instead of hunting
                    through 20 layer toggles. Always visible while on
                    the chart screen. */}

                {/* First-run coach marks — fire once per device. Five
                    one-sentence prompts covering the chart screen's
                    main affordances. Each gated by its own seenKey so
                    they fire independently as the user encounters them. */}
                {!planningSurface && !embedded && !pickerMode && !isPinView && (
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
                            visibleWhen={mapReady && (browseLightningVisible || browseSquallVisible)}
                            anchor="bottom-left"
                            arrow="down"
                            initialDelayMs={2000}
                            message="The legend in the bottom-left explains every colour you see on the chart."
                        />
                        {/* Two CoachMarks lived here — "Sky / Tactical / Charts"
                            and a chart-library hint — both gated on
                            weather.showLayerMenu. Removed 2026-07-22 with the
                            legacy LayerFABMenu they described: that flag could
                            never become true (its only setter was inside the
                            menu the flag gated), so neither mark had ever
                            fired. Their comments claimed the radial menu set
                            the flag, which was never so — RadialHelmMenu is a
                            separate surface. If the radial menu ever wants an
                            intro mark, write a fresh one against ITS state. */}
                    </>
                )}

                {/* Perf-guardian toast — surfaced on session-start when
                    the previous session hit sustained low FPS and we
                    auto-downtiered the device. Informs the user that
                    particle density is reduced for performance.
                    Auto-clears state after the toast's own TTL. */}
                <PerfDowntierToast visible={perfToast && !planningSurface && !embedded && !pickerMode && !isPinView} />

                {/* Performance HUD — only renders when ?perf=1 in URL.
                    Used for diagnosing perf hitches on lower-spec
                    devices. Zero cost in normal use. */}
                {!pickerMode && !planningSurface && (
                    <PerfOverlay
                        mapRef={mapRef}
                        activeLayerCount={
                            weather.activeLayers.size +
                            (browseLightningVisible ? 1 : 0) +
                            (browseSquallVisible ? 1 : 0) +
                            (browseCycloneVisible ? 1 : 0) +
                            (browseAisVisible ? 1 : 0) +
                            (browseSeamarkVisible ? 1 : 0) +
                            (browseTideStationsVisible ? 1 : 0)
                        }
                    />
                )}

                {/* Routes picker — saved planned passages from the
                    ships log. Selection becomes activeChartRoute; the
                    useRouteTrackLayer renders + fits bounds. */}
                {routePickerOpen && !planningSurface && !embedded && !pickerMode && !isPinView && (
                    <Suspense fallback={<RouteTrackPickerLoading label="Opening routes…" />}>
                        <RouteTrackPicker
                            visible
                            variant="route"
                            selectedId={activeChartRoute?.id ?? null}
                            onSelect={(item) => setActiveChartRoute(item)}
                            onClose={() => setRoutePickerOpen(false)}
                        />
                    </Suspense>
                )}

                {/* Tracks picker — actually-sailed passages. Same UX as
                    Routes; the two can be active simultaneously. */}
                {trackPickerOpen && !planningSurface && !embedded && !pickerMode && !isPinView && (
                    <Suspense fallback={<RouteTrackPickerLoading label="Opening tracks…" />}>
                        <RouteTrackPicker
                            visible
                            variant="track"
                            selectedId={activeChartTrack?.id ?? null}
                            onSelect={(item) => setActiveChartTrack(item)}
                            onClose={() => setTrackPickerOpen(false)}
                        />
                    </Suspense>
                )}

                {/* Threat proximity banner — surfaces nearby lightning
                    or active cyclones with bearing + distance. The
                    safety feature competitors don't have. Tap → fly to
                    threat. Hidden when nothing is dangerously near. */}
                <ThreatBanner
                    visible={!planningSurface && !embedded && !pickerMode && !isPinView}
                    userLat={location.lat}
                    userLon={location.lon}
                    cyclones={allCyclones}
                    lightningActive={browseLightningVisible}
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
                <ConnectivityChip visible={!planningSurface && !embedded && !pickerMode && !isPinView} />

                {/* Bottom-left legend stack. flex-col-reverse → first child
                    sits at the bottom of the column.

                    The offset clears whatever the weather controls are
                    occupying below. It used to be a flat 240px for ANY active
                    layer, which was both wrong and wasteful: wrong because the
                    legend bar (expanded, ~160px on top of an 80px anchor)
                    reached 240px itself and the stack landed right on it, and
                    wasteful because 240px was reserved even for layers that
                    show no model selector at all.

                    The single-layer legend has since MOVED OUT of this corner
                    entirely — it now sits mid-left above the back chevron
                    (via MapWeatherControls / ThalassaHelixControl), which is what actually fixed the
                    pile-up. LegendDock (2+ layers) still lives here but
                    collapses to 44px chips.

                    So the only tall thing left below is WindModelFieldSelector,
                    and it renders for WIND only: clear it when wind is up,
                    otherwise sit just above the scrubber. Note lightning can no
                    longer coexist with wind (they are mutually exclusive as of
                    2026-07-22), so in practice the 240px branch is reached by
                    the SQUALL legend rather than the lightning one.
                    Shane 2026-07-22, on the pile-up and the lost real estate. */}
                {!pickerMode && !planningSurface && (browseLightningVisible || browseSquallVisible) && (
                    <div
                        className="fixed left-2 z-[140] flex flex-col-reverse gap-2 pointer-events-none"
                        style={{
                            bottom: weather.activeLayers.has('wind')
                                ? 'calc(env(safe-area-inset-bottom) + 240px)'
                                : weather.activeLayers.size > 0
                                  ? 'calc(env(safe-area-inset-bottom) + 140px)'
                                  : 'max(96px, calc(env(safe-area-inset-bottom) + 80px))',
                        }}
                    >
                        <BlitzortungAttribution visible={browseLightningVisible} />
                        <SquallLegend visible={browseSquallVisible} />
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
                    visible={!pickerMode && passage.showPassage}
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
                    {!planningSurface && !embedded && !pickerMode && !isPinView && (
                        <AisLegend visible={browseAisVisible} />
                    )}
                    {cmemsAttributionLayers.length > 0 && (
                        <React.Suspense fallback={null}>
                            <CmemsAttribution layers={cmemsAttributionLayers} embedded={embedded} />
                        </React.Suspense>
                    )}

                    {/* ═══ VESSEL SEARCH BUTTON ═══ */}
                    {!planningSurface && !embedded && !pickerMode && !isPinView && browseAisVisible && (
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
                    {!pickerMode && !planningSurface && (
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
                                        vesselSearchMarkerRef.current?.remove();
                                        vesselSearchMarkerRef.current = marker;
                                        if (vesselSearchMarkerTimerRef.current !== null) {
                                            window.clearTimeout(vesselSearchMarkerTimerRef.current);
                                        }

                                        // Remove after 8 seconds
                                        vesselSearchMarkerTimerRef.current = window.setTimeout(() => {
                                            marker.remove();
                                            if (vesselSearchMarkerRef.current === marker) {
                                                vesselSearchMarkerRef.current = null;
                                            }
                                            vesselSearchMarkerTimerRef.current = null;
                                        }, 8000);
                                    }

                                    log.info(
                                        `Vessel search: flying to ${name} (${mmsi}) at ${lat.toFixed(4)}, ${lon.toFixed(4)}`,
                                    );
                                }}
                            />
                        </Suspense>
                    )}

                    {/* ═══ AIS GUARD ZONE ALERT TOAST ═══ */}
                    {!pickerMode && !planningSurface && <AisGuardAlert />}
                </Suspense>

                {/* ═══ OFFLINE AREA DOWNLOAD — FAB + MODAL ═══
                    Parked behind OFFLINE_AREA_FAB_VISIBLE until the selected
                    provider has an explicit bulk/offline-download licence. */}
                {!embedded && !pickerMode && !isPinView && !planningSurface && (
                    <>
                        {OFFLINE_AREA_FAB_VISIBLE && (
                            <>
                                <button
                                    onClick={() => {
                                        triggerHaptic('light');
                                        setShowOfflineArea(true);
                                    }}
                                    // Right-rail column — sits directly below SysStatus and
                                    // above the Radial Helm FAB.
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
                    </>
                )}

                {/* ═══ OFFLINE — NO CACHED TILES CARD ═══
                    Shown when the device is offline. Explains why the map
                    might look blank while preserving truthful access to
                    imported MBTiles, licensed charts and viewed tile cache. */}
                {!isOnline && !offlineCardDismissed && !embedded && !pickerMode && !isPinView && !planningSurface && (
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
                                className="hit-target-44 shrink-0 w-6 h-6 rounded-full text-gray-500 hover:text-gray-300 hover:bg-white/[0.06] flex items-center justify-center transition-colors"
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
                        <p className="mt-3 rounded-xl border border-sky-500/20 bg-sky-500/[0.08] px-3 py-2 text-[11px] leading-relaxed text-sky-200/80">
                            Offline-area tile downloads are unavailable for this public map source. Imported MBTiles,
                            licensed charts and previously viewed cached tiles remain available offline.
                        </p>
                    </div>
                )}

                {/* ═══ ROUTE LEGEND (during passage mode) ═══ */}
                <Suspense fallback={null}>
                    <RouteLegend
                        visible={passage.showPassage && !!passage.routeAnalysis && !pickerMode && !isPinView}
                        embedded={embedded}
                        verificationStatus={passage.routeVerification.status}
                    />
                </Suspense>

                {/* ═══ CONSENSUS MATRIX FAB (during passage mode) ═══ */}
                {passage.showPassage &&
                    passage.routeAnalysis &&
                    consensusData &&
                    !embedded &&
                    !pickerMode &&
                    !isPinView && (
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
                {!embedded && !pickerMode && !planningSurface && !isPinView && (
                    <MapActionFabs
                        onLocateMe={() => {
                            triggerHaptic('medium');
                            // Exit full-screen overlay layers so user returns to base map
                            if (squallVisible) setSquallVisible(false);
                            if (cycloneVisible) setCycloneVisible(false);
                            GpsService.requestCurrentForegroundPosition({ staleLimitMs: 30_000, timeoutSec: 10 }).then(
                                (pos) => {
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
                                },
                            );
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

                {/* Also hidden during a MOB: the overlay it reports on is
                    suppressed while a casualty is marked, so "Loading wind
                    layer" would be narrating work whose result is deliberately
                    never drawn — noise across the one screen that must stay
                    readable (seen in Shane's 2026-08-07 MOB screenshot, where
                    the pill sat over the chart with the particles already
                    correctly gone). */}
                {!isPinView && !embedded && !pickerMode && !planningSurface && !mobActive && (
                    <ObsLayerLoadingPill
                        activeLayers={weather.activeLayers}
                        windLoading={weather.windState.loading}
                        windReady={weather.windReady}
                        windHasGrid={Boolean(weather.windState.grid)}
                        windError={weather.windState.error}
                        rainLoading={weather.rainLoading}
                        rainImageLoading={weather.rainImageLoading}
                    />
                )}

                {!isPinView && !embedded && !pickerMode && weather.activeLayers.size > 0 && (
                    <Suspense fallback={null}>
                        <MapWeatherControls
                            weather={weather}
                            cmemsLayerStates={cmemsLayerStates}
                            visible
                            embedded={embedded}
                            controlsHidden={chartControlsHidden}
                            onControlsHiddenChange={setChartControlsHidden}
                        />
                    </Suspense>
                )}
                {showEmbeddedRainViewerAttribution && (
                    <a
                        href="https://www.rainviewer.com/"
                        target="_blank"
                        rel="noreferrer"
                        className="absolute bottom-3 right-3 z-[509] rounded-md bg-slate-950/70 px-2 py-1 text-[10px] font-semibold text-slate-300/80 backdrop-blur-sm"
                        aria-label="Rain radar data by RainViewer"
                    >
                        Radar by RainViewer
                    </a>
                )}
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
                {deviceMode === 'deck' && showConsensus && consensusData && !embedded && !pickerMode && (
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
            {stormPickerOpen && !pickerMode && !planningSurface && (
                <Suspense fallback={<StormPickerLoading />}>
                    <StormPicker
                        visible
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
                </Suspense>
            )}
        </div>
    );
};
