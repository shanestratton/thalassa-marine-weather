import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import './AutoroutingTrialWorkspace.css';
import { OverlayPortal } from '../ui/OverlayPortal';
import { usePaneScope } from '../../context/PanePortalContext';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { useKeyboardOffset } from '../../hooks/useKeyboardOffset';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
} from '../../services/authIdentityScope';
import type { AutoroutingTrialRoute, AutoroutingTrialStatus } from '../../services/autoroutingThalassa';
import { useAutoroutingProvider } from './AutoroutingProviderContext';
import {
    AUTOROUTING_TRIAL_MAX_DRAFT_M,
    AUTOROUTING_TRIAL_MAX_SPEED_KTS,
    type AutoroutingVesselProfile,
} from '../../types/autorouting';
import { formatLatDegMin, formatLonDegMin } from '../../utils/formatDegMin';
import { useEncChartInventory } from '../map/useEncChartInventory';
import { subscribe as subscribeEncRegistry } from '../../services/enc/EncCellMetadata';
import { useEncVectorLayer } from '../map/useEncVectorLayer';
import { EncAttributionChip } from '../map/EncAttributionChip';
import { setEncMapBase } from '../map/encDepthStyleState';
import { setEncPlottingMode, setEncPopupSuppression } from '../map/EncVectorLayer';
import { DEFAULT_TIDE_SAFETY_M } from '../../services/routing/tidalWindow';
import { hazardDepthForDraft } from '../../services/HazardQueryService';
import { trialReviewFeatures } from '../../services/autoroutingReview';
import { buildTrialWaypointPlan, displayWaypointForPathIndex } from '../../services/autoroutingDisplayWaypoints';
import { moveAutoroutingDisplayWaypoint } from '../../services/autoroutingWaypointEdit';
import { nearestTrialWaypoint } from '../../services/autoroutingWaypointHit';
import { useAutoroutingReview } from './useAutoroutingReview';
import { TrialRouteReviewPanel } from './TrialRouteReviewPanel';
import {
    inshoreRouteFeatures,
    inshoreRouteLineLayers,
    inshoreRoutePieces,
    routeTideDepths,
    surveyDashLayers,
    unverifiedRouteDashLayers,
    tideLiftablePieces,
    type InshoreRoutePiece,
} from '../map/inshoreRouteState';
import { annotateTideWindows } from '../map/tideWindowChips';
import { routeRedStretches } from '../map/routeRedReasons';
import { isBackstopLandRefusal } from '../../services/routing/landBackstopWords';
import { AutoroutingProposalSaveCard } from './AutoroutingProposalSaveCard';
import { TrialTracerShell } from './TrialTracerShell';
import { TrialWaypointEditor } from './TrialWaypointEditor';
import { PlannerVesselLocator } from '../map/PlannerVesselLocator';

export interface AutoroutingTrialWorkspaceProps {
    onClose: () => void;
    mapboxToken: string;
    /** Read-only opening snapshots, never selected endpoints or a live vessel position. */
    initialCenter?: { lat: number; lon: number };
    initialDraftM?: number;
    initialSpeedKts?: number;
    initialVesselProfile?: AutoroutingVesselProfile;
    /** Read-only itinerary review. No edits, standalone saves or setup changes;
     * the owning planner must retain the exact route/schedule relationship. */
    reviewProposal?: AutoroutingTrialRoute;
    onReviewChange?: (review: import('../../services/autoroutingReview').TrialRouteReview | null) => void;
}
type Endpoint = 'departure' | 'destination';
type PositionInput = { lat: string; lon: string };
const emptyPosition = (): PositionInput => ({ lat: '', lon: '' });
const point = ({ lat, lon }: PositionInput) =>
    lat.trim() &&
    lon.trim() &&
    Number.isFinite(+lat) &&
    Number.isFinite(+lon) &&
    Math.abs(+lat) <= 90 &&
    Math.abs(+lon) <= 180
        ? { lat: +lat, lon: +lon }
        : null;
const inputClass = 'w-full min-w-0 rounded-lg border border-white/15 bg-slate-900 p-2 text-sm text-white';
const buttonClass = 'min-h-11 rounded-xl border border-white/15 px-3 text-sm font-bold disabled:opacity-40';

/** The route's own drawn pieces (owner decisions 9 and 10) are paintable only
 * for the router's unedited line with an intact disclosure. */
function engineStateMask(route: AutoroutingTrialRoute | null) {
    const mask = route?.engine?.stateMask;
    return route && !route.localEdit && mask && mask.length === route.coordinates.length - 1 ? mask : null;
}

/** Disposable plotting workspace. Saving is a separate explicit planned-route action. */
export function AutoroutingTrialWorkspace({
    onClose,
    mapboxToken,
    initialCenter,
    initialDraftM,
    initialSpeedKts,
    initialVesselProfile,
    reviewProposal,
    onReviewChange,
}: AutoroutingTrialWorkspaceProps) {
    const pane = usePaneScope();
    const provider = useAutoroutingProvider();
    const keyboardHeight = useKeyboardOffset(!pane);
    const closeRef = useRef<HTMLButtonElement>(null);
    const escapeAction = useRef(onClose);
    const dialogRef = useFocusTrap<HTMLDivElement>(true, {
        onEscape: () => escapeAction.current(),
        initialFocusRef: closeRef,
    });
    const container = useRef<HTMLDivElement>(null);
    const mapRef = useRef<mapboxgl.Map | null>(null);
    const proposalBounds = useRef<mapboxgl.LngLatBounds | null>(null);
    const localSpotFocused = useRef(false);
    const preserveEditedViewport = useRef(false);
    const openingCenter = useRef(initialCenter ? { ...initialCenter } : undefined);
    const openingToken = useRef(mapboxToken);
    const [mapReady, setMapReady] = useState(false);
    const [mapError, setMapError] = useState('');
    const [status, setStatus] = useState<AutoroutingTrialStatus | null>(null);
    const panelId = useId();
    const [panelExpanded, setPanelExpanded] = useState(true);
    const [panelPage, setPanelPage] = useState<'setup' | 'review'>(reviewProposal ? 'review' : 'setup');
    const [fitRevision, setFitRevision] = useState(0);
    const [focusRevision, setFocusRevision] = useState(0);
    const pendingSpot = useRef<[number, number] | null>(null);
    const panelToggle = useRef<HTMLButtonElement>(null);
    const viewportPadding = useCallback(() => {
        const frame = container.current?.getBoundingClientRect();
        if (!frame?.height || !frame.width) return 40;
        const header = dialogRef.current?.querySelector('.autoroute-map-header')?.getBoundingClientRect();
        const handle = panelToggle.current?.getBoundingClientRect();
        const foldedCard = dialogRef.current
            ?.querySelector('.trial-tracer-shell[data-expanded="false"]')
            ?.getBoundingClientRect();
        const prompt = dialogRef.current?.querySelector('.autoroute-map-prompt')?.getBoundingClientRect();
        // Fit below the real header and folded handle, including safe areas.
        // Bound the padding so short landscape/keyboard viewports remain valid.
        return {
            top: Math.min(
                frame.height * 0.5,
                Math.max(
                    40,
                    (header?.bottom ?? frame.top) - frame.top + 16,
                    (foldedCard?.bottom ?? handle?.bottom ?? frame.top) - frame.top + 16,
                ),
            ),
            bottom: Math.min(frame.height * 0.35, Math.max(140, prompt ? frame.bottom - prompt.top + 16 : 0)),
            left: Math.min(frame.width * 0.1, 35),
            right: Math.min(frame.width * 0.15, 65),
        };
    }, [dialogRef]);
    const [departure, setDeparture] = useState(() =>
        reviewProposal
            ? { lat: String(reviewProposal.coordinates[0][1]), lon: String(reviewProposal.coordinates[0][0]) }
            : emptyPosition(),
    );
    const [destination, setDestination] = useState(() =>
        reviewProposal
            ? { lat: String(reviewProposal.coordinates.at(-1)![1]), lon: String(reviewProposal.coordinates.at(-1)![0]) }
            : emptyPosition(),
    );
    // Thalassa's router routes from the berth with its own canal tier, so
    // setup is departure, destination, Calculate (2026-10-01): the Canal /
    // marina vs Open water choice and the canal exit pin went with the old
    // server trial, which could not route canals.
    const start = useMemo(() => point(departure), [departure]);
    const end = useMemo(() => point(destination), [destination]);
    const [progress, setProgress] = useState('');
    const endpointNames: Endpoint[] = ['departure', 'destination'];
    const endpointInput = (name: Endpoint) => (name === 'departure' ? departure : destination);
    const [target, setTarget] = useState<Endpoint>('departure');
    // Read-only Vessel preferences from the mode chooser. Clear resets the
    // proposed route, never the boat. Preserve the full metres conversion.
    const { draft, speed, vesselProfile } = useRef({
        draft: initialDraftM,
        speed: initialSpeedKts,
        vesselProfile: initialVesselProfile ? structuredClone(initialVesselProfile) : undefined,
    }).current;
    const draftAssumed = vesselProfile?.draftStatus !== 'measured';
    // The "not confirmed clearance" line belongs only where a dimension is
    // missing or estimated (Shane's screenshot, 2026-10-02: draft, length,
    // beam and air draft all measured, and the line still showed).
    const dimensionUnconfirmed =
        !!vesselProfile &&
        (vesselProfile.draftStatus !== 'measured' ||
            (['length', 'beam', 'airDraft'] as const).some((name) => vesselProfile[name].status !== 'measured'));
    const vesselReady =
        Number.isFinite(draft) &&
        typeof draft === 'number' &&
        draft > 0 &&
        draft <= AUTOROUTING_TRIAL_MAX_DRAFT_M &&
        Number.isFinite(speed) &&
        typeof speed === 'number' &&
        speed > 0 &&
        speed <= AUTOROUTING_TRIAL_MAX_SPEED_KTS &&
        vesselProfile?.draftStatus !== 'missing';
    const [proposal, setProposal] = useState<AutoroutingTrialRoute | null>(() =>
        reviewProposal ? structuredClone(reviewProposal) : null,
    );
    // One immutable checkpoint only: bounded memory and no implicit route history.
    const [undoProposal, setUndoProposal] = useState<AutoroutingTrialRoute | null>(null);
    // Sparse markers are a view of the exact checked/saved geometry, never a
    // replacement polyline connecting distant display waypoints across land.
    const waypointPlan = useMemo(
        () =>
            proposal
                ? buildTrialWaypointPlan(proposal.coordinates, [], proposal.localEdit?.waypointIndices ?? [])
                : { waypoints: [], sparse: true },
        [proposal],
    );
    const displayWaypoints = waypointPlan.waypoints;
    const waypointCountRef = useRef(displayWaypoints.length);
    waypointCountRef.current = displayWaypoints.length;
    const passageNm = (displayWaypoints.at(-1)?.distanceM ?? 0) / 1852;
    const [savedProposal, setSavedProposal] = useState<AutoroutingTrialRoute | null>(null);
    const { review, stop: stopReview, recheck } = useAutoroutingReview(proposal, draft, draftAssumed);
    // Review's Retry for the satellite land check (2026-10-02: the field route
    // timed out online and was told "offline"). It re-runs the check alone:
    // the router's proposal stays the one the map and the chart review key on,
    // and the rechecked copy — the same id and line — is what the notes and
    // Save read. A new route, an edit or a clear leaves it behind (`base`).
    const [backstopRetry, setBackstopRetry] = useState<{
        base: AutoroutingTrialRoute;
        route: AutoroutingTrialRoute;
    } | null>(null);
    // Which proposal a retry is running for, and a retry's failure that was
    // not land (fix-up review, 2026-10-03): both belong to one proposal, so a
    // new route is never held or told off by an old route's retry.
    const [backstopRetrying, setBackstopRetrying] = useState<AutoroutingTrialRoute | null>(null);
    const [backstopRetryError, setBackstopRetryError] = useState<{
        base: AutoroutingTrialRoute;
        message: string;
    } | null>(null);
    // The proposal on screen now, for a retry that answers later (a ~27 s
    // wait on a slow link): it acts only if its own proposal still is.
    const proposalRef = useRef(proposal);
    proposalRef.current = proposal;
    const shownProposal = proposal && backstopRetry?.base === proposal ? backstopRetry.route : proposal;
    const backstopUnavailable =
        !!shownProposal &&
        !reviewProposal &&
        !shownProposal.localEdit &&
        shownProposal.engine?.backstop === 'unavailable';
    // Retry needs the charts' verdict at every satellite sample, which the
    // proposal keeps only when the router could build its chart probe
    // (calculateThalassaProposal: one per sample of this very line).
    const backstopCharts = shownProposal?.engine?.backstopCharts;
    const backstopRetryable =
        backstopUnavailable &&
        Array.isArray(backstopCharts) &&
        backstopCharts.length >= 2 &&
        !!provider.recheckBackstop;
    const backstopRetryingNow = !!proposal && backstopRetrying === proposal;
    const backstopRetryMessage = proposal && backstopRetryError?.base === proposal ? backstopRetryError.message : '';
    useEffect(() => {
        if (reviewProposal) onReviewChange?.(review);
    }, [reviewProposal, review, onReviewChange]);
    const [selectedWaypoint, setSelectedWaypoint] = useState(0);
    const [inspectingWaypoint, setInspectingWaypoint] = useState(false);
    const [movingWaypoint, setMovingWaypoint] = useState(false);
    const [moveCandidate, setMoveCandidate] = useState<[number, number] | null>(null);
    const [moveError, setMoveError] = useState('');
    const movingWaypointRef = useRef(false);
    const moveBasisRef = useRef<{ route: AutoroutingTrialRoute; pathIndex: number } | null>(null);
    movingWaypointRef.current = movingWaypoint;
    const [editingEndpoints, setEditingEndpoints] = useState(!reviewProposal);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const collapsePanel = () => {
        setPanelExpanded(false);
        // Keep keyboard focus on a visible control when a locator folds its panel.
        panelToggle.current?.focus({ preventScroll: true });
    };
    const pending = useRef<AbortController | null>(null);
    const invalidate = useCallback(() => {
        pending.current?.abort();
        pending.current = null;
        setBusy(false);
        proposalRef.current = null;
        setProposal(null);
        setBackstopRetry(null);
        setBackstopRetrying(null);
        setBackstopRetryError(null);
        setUndoProposal(null);
        setPanelPage('setup');
        setSavedProposal(null);
        setError('');
        setProgress('');
        setInspectingWaypoint(false);
        setMovingWaypoint(false);
        setMoveCandidate(null);
        setMoveError('');
        moveBasisRef.current = null;
    }, []);
    // Even partially editing an endpoint invalidates any proposal and request.
    const updateEndpoint = (name: Endpoint, value: PositionInput) => {
        invalidate();
        if (name === 'departure') setDeparture(value);
        else setDestination(value);
    };
    const selectPoint = useRef((_lat: number, _lon: number) => {});
    selectPoint.current = (lat, lon) => {
        if (movingWaypoint) {
            setMoveCandidate([lon, lat]);
            setMoveError('');
            return;
        }
        if (proposal && !editingEndpoints) return;
        updateEndpoint(target, { lat: lat.toFixed(6), lon: lon.toFixed(6) });
        setTarget('destination');
    };
    const selectWaypoint = useRef<(index: number) => boolean>(() => false);
    selectWaypoint.current = (index) => {
        if (proposal && !editingEndpoints && Number.isInteger(index) && index >= 0 && index < displayWaypoints.length) {
            localSpotFocused.current = true;
            setSelectedWaypoint(index);
            setInspectingWaypoint(true);
            setPanelExpanded(false);
            return true;
        }
        return false;
    };

    useEffect(() => {
        const unsubscribe = subscribeAuthIdentityScope(() => {
            invalidate();
            setDeparture(emptyPosition());
            setDestination(emptyPosition());
            setStatus(null);
            onClose();
        });
        return () => {
            pending.current?.abort();
            unsubscribe();
        };
    }, [invalidate, onClose]);

    // Worked out on the phone (2026-10-01): a signed-in identity and installed
    // navigation charts. Re-read when the chart library changes, so charts
    // installed while Auto is open enable Calculate.
    useEffect(() => {
        const read = () => {
            try {
                setStatus(provider.status());
            } catch {
                setStatus({ enabled: false, ready: false, message: 'Auto routing is temporarily unavailable.' });
            }
        };
        read();
        return subscribeEncRegistry(read);
    }, [provider]);

    // One Mapbox instance per open workspace; edits update only its GeoJSON source.
    useEffect(() => {
        const token = openingToken.current;
        if (!container.current || !token) {
            setMapError('Chart unavailable: Mapbox is not configured.');
            return;
        }
        let map: mapboxgl.Map;
        const daylight = document.documentElement.classList.contains('display-light');
        const center = openingCenter.current;
        const validCenter =
            center &&
            Number.isFinite(center.lat) &&
            Number.isFinite(center.lon) &&
            Math.abs(center.lat) <= 90 &&
            Math.abs(center.lon) <= 180;
        try {
            map = new mapboxgl.Map({
                container: container.current,
                accessToken: token,
                style: daylight ? 'mapbox://styles/mapbox/light-v11' : 'mapbox://styles/mapbox/dark-v11',
                center: validCenter ? [center.lon, center.lat] : [0, 15],
                zoom: validCenter ? 10 : 1,
                dragRotate: false,
                attributionControl: false,
                projection: 'mercator',
                maxTileCacheSize: 20,
                // Waypoint numbers must render without another font-server
                // request, including on an intermittent onboard connection.
                localFontFamily: 'sans-serif',
            });
        } catch {
            setMapError('Chart unavailable on this device.');
            return;
        }
        mapRef.current = map;
        // Keep a full paper-chart ENC treatment on THIS map only. Do not
        // change OBS/manual plotting's imagery preference or chart toggles.
        setEncMapBase(map, false);
        setEncPlottingMode(map, true);
        setEncPopupSuppression(map, true); // taps select endpoints, not chart popups
        map.touchZoomRotate.disableRotation();
        map.addControl(new mapboxgl.AttributionControl({ compact: true }), 'bottom-right');
        map.on('load', () => {
            map.addSource('trial', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
            map.addLayer({
                id: 'trial-route',
                metadata: { 'thalassa:enc-anchor': true },
                type: 'line',
                source: 'trial',
                filter: ['==', '$type', 'LineString'],
                paint: { 'line-color': '#94a3b8', 'line-width': 4, 'line-dasharray': [2, 1] },
            });
            // Thalassa's route in the planner's own Phase 2a colours
            // (inshoreRouteState): red, needs-tide amber, survey dots,
            // channel yellow, teal — the same table the planner map uses.
            map.addSource('thalassa-route', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
            for (const spec of inshoreRouteLineLayers('thalassa-route', 'thalassa-route'))
                map.addLayer(spec as mapboxgl.AnyLayer);
            for (const spec of surveyDashLayers('thalassa-route')) map.addLayer(spec as mapboxgl.AnyLayer);
            map.addSource('trial-review', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
            map.addLayer({
                id: 'trial-reviewed-legs',
                type: 'line',
                source: 'trial-review',
                filter: ['==', '$type', 'LineString'],
                paint: { 'line-color': ['get', 'color'], 'line-width': 4 },
            });
            // A line whose safety classifications did not arrive intact: the
            // planner's unverified line — bright red and white dashes on a
            // dark edge (2026-10-03; amber dashes until then, which read as a
            // lead) — over the chart-check colours.
            for (const spec of unverifiedRouteDashLayers('thalassa-route', 'thalassa-route'))
                map.addLayer(spec as mapboxgl.AnyLayer);
            map.addLayer({
                id: 'trial-endpoints',
                type: 'circle',
                source: 'trial',
                filter: ['==', '$type', 'Point'],
                paint: {
                    'circle-radius': 8,
                    'circle-color': ['match', ['get', 'endpoint'], 'departure', '#34d399', '#c084fc'],
                    'circle-stroke-width': 2,
                    'circle-stroke-color': '#ffffff',
                },
            });
            map.addLayer({
                id: 'trial-waypoints',
                type: 'circle',
                source: 'trial-review',
                filter: ['==', '$type', 'Point'],
                paint: {
                    'circle-radius': 12,
                    'circle-color': ['get', 'color'],
                    'circle-stroke-color': '#0f172a',
                    'circle-stroke-width': 2,
                },
            });
            map.addLayer({
                id: 'trial-waypoint-labels',
                type: 'symbol',
                source: 'trial-review',
                filter: ['==', '$type', 'Point'],
                layout: {
                    'text-field': ['to-string', ['get', 'number']],
                    'text-size': 12,
                    'text-font': ['Open Sans Bold'],
                    'text-allow-overlap': false,
                },
                paint: { 'text-color': '#0f172a' },
            });
            map.addSource('trial-focus', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
            map.addLayer({
                id: 'trial-focus-ring',
                type: 'circle',
                source: 'trial-focus',
                paint: {
                    'circle-radius': 22,
                    'circle-color': 'transparent',
                    'circle-stroke-color': '#38bdf8',
                    'circle-stroke-width': 3,
                },
            });
            map.addSource('trial-edit-preview', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
            map.addLayer({
                id: 'trial-edit-preview-line',
                type: 'line',
                source: 'trial-edit-preview',
                filter: ['==', '$type', 'LineString'],
                paint: { 'line-color': '#fbbf24', 'line-width': 4, 'line-dasharray': [2, 1] },
            });
            map.addLayer({
                id: 'trial-edit-preview-pin',
                type: 'circle',
                source: 'trial-edit-preview',
                filter: ['==', '$type', 'Point'],
                paint: {
                    'circle-radius': 13,
                    'circle-color': '#fbbf24',
                    'circle-stroke-width': 3,
                    'circle-stroke-color': '#0f172a',
                },
            });
            setMapReady(true);
        });
        map.on('click', (event) => {
            if (movingWaypointRef.current) {
                selectPoint.current(event.lngLat.lat, event.lngLat.wrap().lng);
                return;
            }
            const hits = map.getLayer('trial-waypoints')
                ? map.queryRenderedFeatures(
                      [
                          [event.point.x - 22, event.point.y - 22],
                          [event.point.x + 22, event.point.y + 22],
                      ],
                      { layers: ['trial-waypoints'] },
                  )
                : [];
            const candidates = hits.flatMap((hit) => {
                if (hit.geometry.type !== 'Point') return [];
                const [lon, lat] = hit.geometry.coordinates;
                const wrappedLon = lon + 360 * Math.round((event.lngLat.lng - lon) / 360);
                const point = map.project([wrappedLon, lat]);
                return [{ index: Number(hit.properties?.number) - 1, x: point.x, y: point.y }];
            });
            const hit = nearestTrialWaypoint(candidates, event.point, waypointCountRef.current);
            if (hit !== null && selectWaypoint.current(hit)) return;
            selectPoint.current(event.lngLat.lat, event.lngLat.wrap().lng);
        });
        const keepUserView = (event: unknown) => {
            if (event && typeof event === 'object' && 'originalEvent' in event && event.originalEvent) {
                localSpotFocused.current = true;
            }
        };
        map.on('dragstart', keepUserView);
        map.on('zoomstart', keepUserView);
        // Keyboard pans move without a drag or zoom start, and box zoom's
        // zoomstart carries no input event: both are still the skipper's view,
        // which the folded-card re-fit must not throw away. The workspace's
        // own camera calls pass no event, so they never count.
        map.on('movestart', keepUserView);
        map.on('boxzoomstart', keepUserView);
        map.on('error', () =>
            setMapError('Some chart detail could not load. Check your connection and ENC display status.'),
        );
        const resize = new ResizeObserver(() => {
            map.resize();
            // Controls do not shrink the canvas. On orientation/keyboard resize,
            // keep the proposal clear of the floating header and source credit.
            if (proposalBounds.current && !localSpotFocused.current)
                map.fitBounds(proposalBounds.current, { padding: viewportPadding(), duration: 0 });
        });
        resize.observe(container.current);
        return () => {
            resize.disconnect();
            mapRef.current = null;
            map.remove();
        };
    }, [viewportPadding]);

    // Same licensed chart inventory and viewport-bounded renderer as manual
    // plotting. No full-coast merge and no second planner/navigation state.
    const { encCellCount, encReferenceCellCount, encHydration, encNoCoverage } = useEncChartInventory(
        mapRef,
        mapReady,
        true,
    );
    useEncVectorLayer(
        mapRef,
        mapReady,
        true,
        true,
        vesselReady ? draft + DEFAULT_TIDE_SAFETY_M : undefined,
        vesselReady ? Math.abs(hazardDepthForDraft(draft)) : undefined,
        true,
    );

    const dangerReported = review?.legs.some((leg) => leg?.verdict.grade === 'danger');
    const missingPosition = !start ? 'departure' : !end ? 'destination' : null;
    const valid = start && end && (start.lat !== end.lat || start.lon !== end.lon) && vesselReady;
    useEffect(() => {
        const source = mapRef.current?.getSource('trial') as mapboxgl.GeoJSONSource | undefined;
        if (!mapReady || !source) return;
        const features: GeoJSON.Feature[] = [];
        const endpoints: [Endpoint, PositionInput][] = [
            ['departure', departure],
            ['destination', destination],
        ];
        for (const [endpoint, input] of endpoints) {
            const p = point(input);
            if (p)
                features.push({
                    type: 'Feature',
                    properties: { endpoint },
                    geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
                });
        }
        if (proposal)
            features.push({
                type: 'Feature',
                properties: {},
                geometry: { type: 'LineString', coordinates: proposal.coordinates },
            });
        source.setData({ type: 'FeatureCollection', features });
        proposalBounds.current = null;
        if (proposal) {
            const bounds = new mapboxgl.LngLatBounds();
            for (const coordinate of proposal.coordinates) bounds.extend(coordinate);
            proposalBounds.current = bounds;
            if (!preserveEditedViewport.current)
                mapRef.current?.fitBounds(bounds, { padding: viewportPadding(), duration: 0 });
        }
    }, [mapReady, departure, destination, proposal, viewportPadding]);

    useEffect(() => {
        if (!mapReady) return;
        const source = mapRef.current?.getSource('trial-review') as mapboxgl.GeoJSONSource | undefined;
        source?.setData(trialReviewFeatures(proposal?.coordinates ?? [], review, displayWaypoints));
    }, [mapReady, proposal, review, displayWaypoints]);

    // The router's own colours for its unedited line (owner decisions 9/10,
    // the planner's pieces): while they show, the chart-check colouring of the
    // line is hidden — the numbered waypoints keep it. A hand edit, or a line
    // whose classifications did not arrive intact, falls back to the
    // chart-check colours; the latter also draws the planner's unverified red
    // dashes.
    const [tideTop, setTideTop] = useState<{
        route: AutoroutingTrialRoute;
        highestAt: (lon: number, lat: number) => number | null;
    } | null>(null);
    const tideNeedM =
        typeof proposal?.engine?.tideNeedM === 'number' && Number.isFinite(proposal.engine.tideNeedM)
            ? proposal.engine.tideNeedM
            : (draft ?? 0) + DEFAULT_TIDE_SAFETY_M;
    const routePieces = useCallback(
        (route: AutoroutingTrialRoute, highestAt: ((lon: number, lat: number) => number | null) | null) => {
            const mask = engineStateMask(route);
            const engine = route.engine;
            if (!mask || !engine) return [] as InshoreRoutePiece[];
            const masks = { polyline: route.coordinates, ...engine };
            return inshoreRoutePieces(route.coordinates, mask, engine.surveyRuns, engine.chartedShallowSpans, {
                depthM: routeTideDepths(masks),
                needM: tideNeedM,
                highestM: null,
                ...(highestAt ? { highestAt } : {}),
            });
        },
        [tideNeedM],
    );
    // Why each red stretch is red, cut at the display waypoints, for the route
    // review (round 2, 2026-10-02: the field route's legs were red on the map
    // while their checks said "no issue found", and nothing said why) — the
    // same pieces and the same tide the map draws.
    const redStretches = useMemo(() => {
        const engine = proposal?.engine;
        if (!proposal || !engine || !engineStateMask(proposal)) return [];
        const highestAt = tideTop?.route === proposal ? tideTop.highestAt : null;
        const tide = {
            depthM: routeTideDepths({ polyline: proposal.coordinates, ...engine }),
            needM: tideNeedM,
            highestM: null,
            ...(highestAt ? { highestAt } : {}),
        };
        return routeRedStretches(
            proposal.coordinates,
            routePieces(proposal, highestAt),
            { ...engine, tideNeedM },
            tide,
            displayWaypoints.map((waypoint) => waypoint.pathIndex),
        );
    }, [proposal, tideTop, tideNeedM, routePieces, displayWaypoints]);
    const enginePainted = !!engineStateMask(proposal);
    useEffect(() => {
        const map = mapRef.current;
        if (!mapReady || !map) return;
        const source = map.getSource('thalassa-route') as mapboxgl.GeoJSONSource | undefined;
        let features: GeoJSON.Feature[] = [];
        if (proposal && enginePainted)
            features = inshoreRouteFeatures(
                routePieces(proposal, tideTop?.route === proposal ? tideTop.highestAt : null),
            );
        else if (proposal?.engine && !proposal.localEdit && !proposal.engine.stateMask)
            features = [
                {
                    type: 'Feature',
                    properties: { safety: 'unverified', dashed: true, verification: 'unverified' },
                    geometry: { type: 'LineString', coordinates: proposal.coordinates },
                },
            ];
        source?.setData({ type: 'FeatureCollection', features });
        if (map.getLayer('trial-reviewed-legs'))
            map.setLayoutProperty('trial-reviewed-legs', 'visibility', enginePainted ? 'none' : 'visible');
    }, [mapReady, proposal, enginePainted, routePieces, tideTop]);

    // Tide-window chips on the needs-tide runs, as the planner places them
    // (tideWindowChips): fetched after the route paints; the curves' tops
    // redraw the line amber where a tide clears it (owner decision 10).
    // Removed on recalculate, clear, edit, account change and close: every one
    // of them changes or drops the proposal, or unmounts.
    const chipMarkers = useRef<mapboxgl.Marker[]>([]);
    const chipRevision = useRef(0);
    useEffect(() => {
        const map = mapRef.current;
        const revision = ++chipRevision.current;
        const clearChips = () => {
            chipRevision.current += 1;
            for (const marker of chipMarkers.current.splice(0)) marker.remove();
        };
        const engine = proposal?.engine;
        const mask = engineStateMask(proposal);
        if (!mapReady || !map || !proposal || !engine || !mask || typeof draft !== 'number') return clearChips;
        const liftable = tideLiftablePieces(
            proposal.coordinates,
            mask,
            engine.chartedShallowSpans,
            routeTideDepths({ polyline: proposal.coordinates, ...engine }),
            tideNeedM,
        );
        if (!engine.shallowRuns?.length && !engine.surveyRuns?.length && liftable.length === 0) return clearChips;
        const stale = () => revision !== chipRevision.current || mapRef.current !== map;
        const departureMs = Date.parse(proposal.createdAt);
        void annotateTideWindows({
            map,
            runs: engine.shallowRuns ?? [],
            surveyRuns: engine.surveyRuns,
            draftM: draft,
            needM: tideNeedM,
            departureMs: Number.isFinite(departureMs) ? departureMs : Date.now(),
            isStale: stale,
            markers: chipMarkers.current,
            liftable,
            ...(engine.canalMask ? { canalMask: engine.canalMask } : {}),
            onTide: (highestAt) => {
                if (stale()) return;
                setTideTop({ route: proposal, highestAt });
                return routePieces(proposal, highestAt);
            },
        });
        return clearChips;
    }, [mapReady, proposal, draft, tideNeedM, routePieces]);

    useEffect(() => {
        if (!mapReady) return;
        localSpotFocused.current = preserveEditedViewport.current;
        preserveEditedViewport.current = false;
        const source = mapRef.current?.getSource('trial-focus') as mapboxgl.GeoJSONSource | undefined;
        source?.setData({ type: 'FeatureCollection', features: [] });
    }, [mapReady, proposal]);
    const focusSpot = (spot: { lat: number; lon: number }) => {
        const map = mapRef.current;
        if (!map) return;
        localSpotFocused.current = true;
        (map.getSource('trial-focus') as mapboxgl.GeoJSONSource | undefined)?.setData({
            type: 'Feature',
            properties: {},
            geometry: { type: 'Point', coordinates: [spot.lon, spot.lat] },
        });
        pendingSpot.current = [spot.lon, spot.lat];
        setFocusRevision((value) => value + 1);
        collapsePanel();
    };
    const inspectedWaypoint = inspectingWaypoint ? displayWaypoints[selectedWaypoint] : undefined;
    const moveLockedReason = reviewProposal
        ? 'Itinerary preview only. Save the plan, then edit it in Plan and reassess timings and weather.'
        : !inspectedWaypoint
          ? undefined
          : inspectedWaypoint.pathIndex === 0 || inspectedWaypoint.pathIndex === (proposal?.coordinates.length ?? 0) - 1
            ? 'Change departure or destination in route setup, then recalculate.'
            : undefined;
    const cancelMove = () => {
        setMovingWaypoint(false);
        setMoveCandidate(null);
        setMoveError('');
        moveBasisRef.current = null;
    };
    escapeAction.current = movingWaypoint
        ? cancelMove
        : inspectingWaypoint
          ? () => setInspectingWaypoint(false)
          : onClose;
    const beginMove = () => {
        if (!proposal || !inspectedWaypoint || moveLockedReason) return;
        cancelMove();
        moveBasisRef.current = { route: proposal, pathIndex: inspectedWaypoint.pathIndex };
        setMovingWaypoint(true);
        setEditingEndpoints(false);
        focusSpot({ lon: inspectedWaypoint.coordinates[0], lat: inspectedWaypoint.coordinates[1] });
    };
    const confirmMove = () => {
        if (!proposal || !inspectedWaypoint || !moveCandidate || !movingWaypoint) return;
        if (
            moveBasisRef.current?.route !== proposal ||
            moveBasisRef.current.pathIndex !== inspectedWaypoint.pathIndex
        ) {
            cancelMove();
            setMoveError('The selection changed. Select the waypoint again before moving it.');
            return;
        }
        try {
            const moved = moveAutoroutingDisplayWaypoint(proposal, inspectedWaypoint, moveCandidate);
            const plan = buildTrialWaypointPlan(
                moved.route.coordinates,
                [],
                moved.route.localEdit?.waypointIndices ?? [],
            );
            // Fresh immutable geometry starts a complete new local review. The
            // router's checks are historical, never current clearance.
            stopReview();
            preserveEditedViewport.current = true;
            localSpotFocused.current = true;
            setSavedProposal(null);
            setUndoProposal(proposal);
            proposalRef.current = moved.route;
            setProposal(moved.route);
            setSelectedWaypoint(displayWaypointForPathIndex(plan.waypoints, moved.pathIndex));
            cancelMove();
        } catch (failure) {
            setMoveError(
                failure instanceof Error ? failure.message : 'The waypoint could not be moved. Nothing changed.',
            );
        }
    };
    const undoMove = () => {
        if (!undoProposal || !proposal?.localEdit) return;
        cancelMove();
        recheck(); // Advance the attempt now; even a rapid edit→undo cannot revive old green checks.
        preserveEditedViewport.current = true;
        localSpotFocused.current = true;
        setSavedProposal(null);
        setInspectingWaypoint(false);
        setSelectedWaypoint(0);
        proposalRef.current = undoProposal;
        setProposal(undoProposal);
        setUndoProposal(null);
        setPanelPage('review');
    };
    const fitRoute = () => {
        if (!proposalBounds.current) return;
        pendingSpot.current = null;
        cancelMove();
        setInspectingWaypoint(false);
        localSpotFocused.current = false;
        (mapRef.current?.getSource('trial-focus') as mapboxgl.GeoJSONSource | undefined)?.setData({
            type: 'FeatureCollection',
            features: [],
        });
        collapsePanel();
        setFitRevision((value) => value + 1);
    };
    // Frame a focused pin after the folded card/editor have committed. Mapbox
    // padding otherwise persists from Fit Route and can put it behind a card.
    useLayoutEffect(() => {
        const map = mapRef.current;
        const spot = pendingSpot.current;
        if (!mapReady || panelExpanded || !map || !spot) return;
        pendingSpot.current = null;
        const frame = container.current?.getBoundingClientRect();
        const overlays = Array.from(
            dialogRef.current?.querySelectorAll(
                '.trial-tracer-shell, .trial-waypoint-editor, .autoroute-map-header, .autoroute-map-zoom, .autoroute-map-prompt',
            ) ?? [],
        ).map((element) => element.getBoundingClientRect());
        let offset: [number, number] = [0, 0];
        if (frame?.width && frame.height) {
            // Pick the point with the most room around it in the uncovered
            // chart, including split panes and short landscape screens.
            let best = -Infinity;
            for (let y = 32; y < frame.height - 60; y += 16) {
                for (let x = 24; x < frame.width - 24; x += 16) {
                    let clearance = Math.min(x, frame.width - x, y, frame.height - 60 - y);
                    for (const rect of overlays) {
                        const dx = Math.max(rect.left - frame.left - x, 0, x - (rect.right - frame.left));
                        const dy = Math.max(rect.top - frame.top - y, 0, y - (rect.bottom - frame.top));
                        clearance = Math.min(clearance, Math.hypot(dx, dy));
                    }
                    const score = clearance - Math.hypot(x - frame.width / 2, y - frame.height / 2) * 0.02;
                    if (score > best) {
                        best = score;
                        offset = [x - frame.width / 2, y - frame.height / 2];
                    }
                }
            }
        }
        map.flyTo({
            center: spot,
            zoom: Math.max(map.getZoom(), 15),
            padding: 0,
            offset,
            retainPadding: false,
            duration: 500,
        });
    }, [mapReady, panelExpanded, focusRevision, dialogRef]);
    useEffect(() => {
        if (!mapReady) return;
        const map = mapRef.current;
        const source = map?.getSource('trial-edit-preview') as mapboxgl.GeoJSONSource | undefined;
        const features: GeoJSON.Feature[] = [];
        if (movingWaypoint && moveCandidate && proposal && inspectedWaypoint) {
            const index = inspectedWaypoint.pathIndex;
            const before = proposal.coordinates[Number.isInteger(index) ? index - 1 : Math.floor(index)];
            const after = proposal.coordinates[Number.isInteger(index) ? index + 1 : Math.ceil(index)];
            if (before && after) {
                features.push({
                    type: 'Feature',
                    properties: {},
                    geometry: { type: 'LineString', coordinates: [before, moveCandidate, after] },
                });
                features.push({
                    type: 'Feature',
                    properties: {},
                    geometry: { type: 'Point', coordinates: moveCandidate },
                });
            }
        }
        source?.setData({ type: 'FeatureCollection', features });
        if (map) map.getCanvas().style.cursor = movingWaypoint ? 'crosshair' : '';
    }, [mapReady, movingWaypoint, moveCandidate, proposal, inspectedWaypoint]);

    // The folded status may gain lines when a danger or missing ENC coverage is
    // reported. Measure the committed DOM before framing its exact geometry.
    useLayoutEffect(() => {
        if (!mapReady || panelExpanded) return;
        if (proposalBounds.current && !localSpotFocused.current)
            mapRef.current?.fitBounds(proposalBounds.current, { padding: viewportPadding(), duration: 0 });
    }, [mapReady, panelExpanded, encNoCoverage, encHydration.remaining, mapError, viewportPadding, fitRevision]);
    // That fit measures the folded card once. The card can still change
    // height afterwards, when its status line wraps differently once fonts
    // settle or a late status lands: on Linux fonts 'Chart checks complete ·
    // review required' took a third line and covered the route's top
    // endpoint. Re-fit on the same terms whenever the folded card's own height
    // changes; fitBounds does not resize the card, so this cannot loop.
    useEffect(() => {
        if (!mapReady || panelExpanded || typeof ResizeObserver === 'undefined') return;
        const card = dialogRef.current?.querySelector('.trial-tracer-shell[data-expanded="false"]');
        if (!card) return;
        let lastHeight = card.getBoundingClientRect().height;
        const observer = new ResizeObserver(() => {
            const height = card.getBoundingClientRect().height;
            if (Math.abs(height - lastHeight) < 1) return;
            lastHeight = height;
            setFitRevision((value) => value + 1);
        });
        observer.observe(card);
        return () => observer.disconnect();
    }, [mapReady, panelExpanded, dialogRef]);

    const calculate = async () => {
        if (!valid || !start || !end || !vesselReady || !status?.ready || busy || pending.current) return;
        invalidate();
        const controller = new AbortController();
        const scope = getAuthIdentityScope();
        pending.current = controller;
        setBusy(true);
        try {
            const request = {
                departure: start,
                destination: end,
                draftM: draft,
                speedKts: speed,
                ...(vesselProfile ? { vesselProfile: structuredClone(vesselProfile) } : {}),
            };
            const onProgress = (message: string) => {
                if (!controller.signal.aborted && isAuthIdentityScopeCurrent(scope)) setProgress(message);
            };
            // Thalassa's router on this phone (2026-10-01). A refusal throws
            // the engine's own words, shown whole; it never draws a line.
            const route = await provider.calculate(request, controller.signal, onProgress);
            if (!controller.signal.aborted && isAuthIdentityScopeCurrent(scope)) {
                setSelectedWaypoint(0);
                setEditingEndpoints(false);
                setProposal(route);
                setPanelPage('review');
                collapsePanel();
            }
        } catch (failure) {
            if (!controller.signal.aborted && isAuthIdentityScopeCurrent(scope)) {
                setError(failure instanceof Error ? failure.message : 'Trial calculation failed.');
                setPanelExpanded(true);
            }
        } finally {
            if (pending.current === controller) {
                pending.current = null;
                setBusy(false);
            }
        }
    };
    const retryBackstop = async () => {
        const base = proposal;
        const route = shownProposal;
        if (!base || !route || !backstopRetryable || backstopRetryingNow || !provider.recheckBackstop) return;
        const scope = getAuthIdentityScope();
        // Its answer is this proposal's only while this proposal is shown: a
        // new route, an edit or a clear in the meantime leaves it behind
        // (fix-up review, 2026-10-03: an old route's land refusal removed the
        // new route and showed itself as the new route's).
        const current = () => isAuthIdentityScopeCurrent(scope) && proposalRef.current === base;
        setBackstopRetrying(base);
        setBackstopRetryError(null);
        try {
            const next = await provider.recheckBackstop(route);
            if (current()) setBackstopRetry({ base, route: next });
        } catch (failure) {
            if (!current() || failure instanceof DOMException) return;
            if (isBackstopLandRefusal(failure)) {
                // Land after all: the route must not be shown (Auto's
                // refusal), exactly as if the router had found it.
                invalidate();
                setError(failure.message);
                setPanelExpanded(true);
                return;
            }
            // Anything else is not land: the route stays, Save stays off.
            setBackstopRetryError({
                base,
                message:
                    failure instanceof Error && failure.message
                        ? failure.message
                        : 'The satellite land check could not be retried.',
            });
        } finally {
            setBackstopRetrying((retrying) => (retrying === base ? null : retrying));
        }
    };
    const clear = () => {
        invalidate();
        setDeparture(emptyPosition());
        setDestination(emptyPosition());
        setTarget('departure');
        setEditingEndpoints(true);
        setPanelExpanded(true);
    };
    return (
        <OverlayPortal
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="Autorouting trial"
            className="autoroute-full-chart overflow-hidden bg-slate-950 text-white"
            style={
                {
                    bottom: pane ? undefined : keyboardHeight,
                    '--autoroute-safe-top': pane ? '0px' : 'env(safe-area-inset-top, 0px)',
                    '--autoroute-safe-bottom': pane ? '0px' : 'env(safe-area-inset-bottom, 0px)',
                } as React.CSSProperties
            }
        >
            <header className="autoroute-map-header">
                <div className="flex items-center justify-between gap-2">
                    <h2 className="sr-only">Autorouting · Trial</h2>
                    <button
                        ref={closeRef}
                        type="button"
                        onClick={onClose}
                        className={`${buttonClass} bg-slate-900 text-white`}
                        aria-label="Close autorouting trial"
                    >
                        ×
                    </button>
                </div>
            </header>
            <div className="autoroute-map-canvas">
                <div
                    ref={container}
                    role="region"
                    aria-label={
                        reviewProposal ? 'Day plan route review chart' : 'Trial chart — tap to set selected endpoint'
                    }
                    className="absolute inset-0"
                    style={{ position: 'absolute', inset: 0 }}
                />
                <div className="autoroute-map-zoom flex flex-col gap-1">
                    <button
                        type="button"
                        aria-label="Zoom trial chart in"
                        onClick={() => {
                            localSpotFocused.current = true;
                            mapRef.current?.zoomIn();
                        }}
                        className={`${buttonClass} bg-slate-900 text-white`}
                    >
                        +
                    </button>
                    <button
                        type="button"
                        aria-label="Zoom trial chart out"
                        onClick={() => {
                            localSpotFocused.current = true;
                            mapRef.current?.zoomOut();
                        }}
                        className={`${buttonClass} bg-slate-900 text-white`}
                    >
                        −
                    </button>
                    {proposal && (
                        <button
                            type="button"
                            aria-label="Show whole route"
                            title="Show whole route"
                            onClick={fitRoute}
                            className={`${buttonClass} bg-slate-900 text-white`}
                        >
                            <svg
                                viewBox="0 0 24 24"
                                width="22"
                                height="22"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                aria-hidden="true"
                            >
                                <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M7 15l4-6 6 5" />
                                <circle cx="7" cy="15" r="1.5" />
                                <circle cx="17" cy="14" r="1.5" />
                            </svg>
                        </button>
                    )}
                </div>
                <EncAttributionChip mapRef={mapRef} mapReady={mapReady} bottom={32} />
            </div>
            <PlannerVesselLocator
                mapRef={mapRef}
                mapReady={mapReady}
                autoCenter={!start && !end && !proposal}
                onLocate={() => {
                    localSpotFocused.current = true;
                }}
            />
            <div className="autoroute-controls-anchor">
                <TrialTracerShell
                    className="autoroute-controls"
                    expanded={panelExpanded}
                    panelId={panelId}
                    toggleRef={panelToggle}
                    onToggle={() => {
                        setPanelExpanded((v) => !v);
                        cancelMove();
                        setInspectingWaypoint(false);
                    }}
                    warning={
                        savedProposal === proposal && proposal
                            ? 'Saved plan only · not activated or cleared for navigation.'
                            : 'Not for navigation. Unsaved proposal only.'
                    }
                    statusTone={
                        dangerReported ? 'danger' : busy || review?.phase === 'checking' ? 'working' : 'neutral'
                    }
                    status={
                        <>
                            <span className="block font-bold">
                                {proposal
                                    ? `${passageNm.toFixed(1)} NM · ${displayWaypoints.length} waypoints`
                                    : 'Set up route'}
                            </span>
                            <span className="block">
                                {busy
                                    ? progress || 'Calculating…'
                                    : proposal
                                      ? review?.phase === 'complete'
                                          ? 'Chart checks complete · review required'
                                          : `Chart checks ${review?.phase ?? 'pending'}`
                                      : missingPosition
                                        ? `Set ${missingPosition}`
                                        : !status?.ready && status
                                          ? 'Install charts to calculate'
                                          : 'Ready to calculate'}
                            </span>
                            {dangerReported && (
                                <span className="block font-bold">Danger reported · review required</span>
                            )}
                            {shownProposal && shownProposal.warnings.length > 0 && (
                                <span className="block">
                                    {shownProposal.warnings.length} route{' '}
                                    {shownProposal.warnings.length === 1 ? 'note' : 'notes'} · review required
                                </span>
                            )}
                            {proposal?.localEdit && (
                                <span className="block">Edited · router checks no longer apply</span>
                            )}
                            {inspectedWaypoint && (mapError || encNoCoverage || encHydration.remaining > 0) && (
                                <span className="block">
                                    {mapError ||
                                        (encNoCoverage
                                            ? 'ENC coverage unavailable at this view'
                                            : 'ENC detail is loading')}
                                </span>
                            )}
                        </>
                    }
                    navigation={
                        proposal &&
                        !reviewProposal && (
                            <>
                                {(['setup', 'review'] as const).map((page) => (
                                    <button
                                        key={page}
                                        type="button"
                                        aria-pressed={panelPage === page}
                                        onClick={() => {
                                            cancelMove();
                                            setInspectingWaypoint(false);
                                            setEditingEndpoints(false);
                                            setPanelPage(page);
                                        }}
                                    >
                                        {page === 'setup' ? 'Setup' : 'Review'}
                                    </button>
                                ))}
                            </>
                        )
                    }
                    footer={
                        reviewProposal ? (
                            <div className="grid grid-cols-2 gap-2">
                                <button type="button" onClick={fitRoute} className={buttonClass}>
                                    Whole route
                                </button>
                                <button
                                    type="button"
                                    onClick={onClose}
                                    className={`${buttonClass} bg-teal-600 text-white`}
                                >
                                    Back to day plan
                                </button>
                            </div>
                        ) : !proposal || panelPage === 'setup' ? (
                            <div className="grid grid-cols-[1fr_auto] gap-2">
                                <button
                                    type="button"
                                    onClick={() => void calculate()}
                                    disabled={!valid || !status?.ready || !mapReady || busy}
                                    className={`${buttonClass} bg-teal-600 text-white`}
                                >
                                    {busy ? 'Calculating…' : 'Calculate trial route'}
                                </button>
                                <button type="button" onClick={clear} className={buttonClass}>
                                    Clear
                                </button>
                            </div>
                        ) : (
                            <div className="grid gap-2">
                                {undoProposal && (
                                    <button type="button" onClick={undoMove} className={buttonClass}>
                                        ↶ Undo last move
                                    </button>
                                )}
                                <button type="button" onClick={fitRoute} className={buttonClass}>
                                    Show whole route
                                </button>
                            </div>
                        )
                    }
                >
                    <div className="p-3 space-y-3">
                        {(!proposal || panelPage === 'setup') && (
                            <div className="space-y-3">
                                <p className="text-micro text-gray-400">
                                    {proposal && !editingEndpoints
                                        ? 'Tap a numbered waypoint to inspect or move it.'
                                        : `Tap the chart to set ${target}.`}
                                </p>
                                {(encHydration.remaining > 0 || encNoCoverage) && (
                                    <p role="status" className="text-micro text-amber-300">
                                        {encHydration.remaining > 0
                                            ? 'Loading ENC chart detail…'
                                            : encCellCount > 0 && encCellCount === encReferenceCellCount
                                              ? 'Reference chart only — not navigation coverage.'
                                              : 'ENC coverage unavailable here. Background map only.'}
                                    </p>
                                )}
                                {mapError && (
                                    <p role="status" className="text-micro text-amber-300">
                                        {mapError}
                                    </p>
                                )}
                                <div className="grid grid-cols-2 gap-2">
                                    {endpointNames.map((name) => {
                                        const position = point(endpointInput(name));
                                        return (
                                            <button
                                                type="button"
                                                key={name}
                                                aria-pressed={target === name}
                                                onClick={() => {
                                                    setTarget(name);
                                                    setEditingEndpoints(true);
                                                    collapsePanel();
                                                }}
                                                className={`${buttonClass} min-w-0 py-2 text-left ${target === name ? 'border-teal-400 bg-teal-500/10' : ''}`}
                                            >
                                                <span className="block capitalize">{name}</span>
                                                <span className="block text-micro font-normal">
                                                    {position ? (
                                                        <>
                                                            <span className="block whitespace-nowrap tabular-nums">
                                                                {formatLatDegMin(position.lat)}
                                                            </span>{' '}
                                                            <span className="block whitespace-nowrap tabular-nums">
                                                                {formatLonDegMin(position.lon)}
                                                            </span>
                                                        </>
                                                    ) : (
                                                        'Tap chart or enter below'
                                                    )}
                                                </span>
                                            </button>
                                        );
                                    })}
                                </div>
                                <details>
                                    <summary className="min-h-11 cursor-pointer content-center text-sm">
                                        Enter coordinates
                                    </summary>
                                    <div className="grid grid-cols-2 gap-2">
                                        {endpointNames.map((name) => (
                                            <fieldset key={name} className="min-w-0 space-y-2">
                                                <legend className="text-micro capitalize">{name}</legend>
                                                {(['lat', 'lon'] as const).map((axis) => (
                                                    <label key={axis} className="block text-micro">
                                                        {axis === 'lat' ? 'Latitude' : 'Longitude'}
                                                        <input
                                                            type="number"
                                                            step="any"
                                                            min={axis === 'lat' ? -90 : -180}
                                                            max={axis === 'lat' ? 90 : 180}
                                                            aria-label={`${name} ${axis === 'lat' ? 'latitude' : 'longitude'}`}
                                                            value={endpointInput(name)[axis]}
                                                            onChange={(event) => {
                                                                updateEndpoint(name, {
                                                                    ...endpointInput(name),
                                                                    [axis]: event.target.value,
                                                                });
                                                            }}
                                                            className={inputClass}
                                                        />
                                                    </label>
                                                ))}
                                            </fieldset>
                                        ))}
                                    </div>
                                </details>
                                {!vesselReady && (
                                    <p role="status" className="text-micro text-amber-300">
                                        Set a valid draft and cruising speed in Vessel preferences before calculating.
                                    </p>
                                )}
                                {vesselProfile && (
                                    <details>
                                        <summary className="min-h-11 cursor-pointer content-center text-micro font-semibold">
                                            Boat details · from Vessel preferences
                                        </summary>
                                        <dl className="grid grid-cols-2 gap-2 text-micro">
                                            <dt>Draft</dt>
                                            <dd>
                                                {draft?.toFixed(2)} m · {vesselProfile.draftStatus}
                                            </dd>
                                            <dt>Cruising speed</dt>
                                            <dd>{speed} kn</dd>
                                            {(['length', 'beam', 'airDraft'] as const).map((name) => (
                                                <React.Fragment key={name}>
                                                    <dt>
                                                        {name === 'airDraft'
                                                            ? 'Air draft'
                                                            : name === 'length'
                                                              ? 'Length'
                                                              : 'Beam'}
                                                    </dt>
                                                    <dd>
                                                        {vesselProfile[name].status === 'missing'
                                                            ? 'Not set · not checked'
                                                            : `${vesselProfile[name].valueM.toFixed(2)} m · ${vesselProfile[name].status}`}
                                                    </dd>
                                                </React.Fragment>
                                            ))}
                                        </dl>
                                        {dimensionUnconfirmed && (
                                            <p className="mt-2 text-micro text-amber-300">
                                                Missing or estimated dimensions are not confirmed clearance. Change
                                                measurements in Vessel preferences.
                                            </p>
                                        )}
                                    </details>
                                )}
                                {!status?.ready && (
                                    <p role="status" className="text-micro text-amber-300">
                                        {status?.message ||
                                            (status ? 'Trial calculation is not available.' : 'Checking charts…')}
                                    </p>
                                )}
                                {missingPosition && (
                                    <p role="status" className="text-sm font-semibold text-amber-300">
                                        Set {missingPosition} on the chart or enter its coordinates before calculating.
                                    </p>
                                )}
                            </div>
                        )}
                        {error && (
                            <p role="alert" className="text-sm text-red-300">
                                {error}
                            </p>
                        )}
                        {proposal && (
                            <div hidden={panelPage !== 'review'}>
                                <TrialRouteReviewPanel
                                    route={shownProposal ?? proposal}
                                    coordinates={proposal.coordinates}
                                    waypoints={displayWaypoints}
                                    sparse={waypointPlan.sparse}
                                    review={review}
                                    selected={selectedWaypoint}
                                    onSelect={(index) => {
                                        cancelMove();
                                        setSelectedWaypoint(index);
                                    }}
                                    onFocus={focusSpot}
                                    onInspectWaypoint={(index) => {
                                        cancelMove();
                                        localSpotFocused.current = true;
                                        setSelectedWaypoint(index);
                                        setInspectingWaypoint(true);
                                        collapsePanel();
                                    }}
                                    onStop={stopReview}
                                    onRecheck={recheck}
                                    redStretches={redStretches}
                                />
                            </div>
                        )}
                        {busy && progress && (
                            <p role="status" className="text-micro text-teal-300">
                                {progress}
                            </p>
                        )}
                        {proposal && (
                            <div hidden={panelPage !== 'review'}>
                                <section aria-label="Trial proposal" className="space-y-1 text-micro">
                                    <p className="font-bold text-teal-300">
                                        {proposal.localEdit ? 'Locally edited trial proposal' : 'Thalassa proposal'} ·{' '}
                                        {savedProposal === proposal
                                            ? 'saved as a plan, not activated'
                                            : 'not saved or activated'}
                                    </p>
                                    {proposal.localEdit && (
                                        <p role="status" className="text-amber-300">
                                            Waypoints moved · new local chart checks required. The router&apos;s
                                            original checks no longer apply. Saving this edited trial is unavailable.
                                        </p>
                                    )}
                                </section>
                            </div>
                        )}
                        {proposal && typeof draft === 'number' && !reviewProposal && (
                            <div hidden={panelPage !== 'review'}>
                                {backstopUnavailable && (
                                    <section
                                        aria-label="Satellite land check"
                                        className="mb-2 space-y-2 rounded-lg border border-amber-300/30 p-2 text-micro"
                                    >
                                        <p className="text-amber-200">
                                            Satellite land check couldn&apos;t be done just now:{' '}
                                            {shownProposal?.engine?.backstopReason ??
                                                "the satellite relief didn't come back for the whole route"}
                                            .{' '}
                                            {backstopRetryable
                                                ? 'Retry runs the check again on this route — not the route.'
                                                : 'Recalculate to run it again.'}
                                        </p>
                                        {backstopRetryable && (
                                            <button
                                                type="button"
                                                className={`${buttonClass} w-full`}
                                                disabled={backstopRetryingNow}
                                                onClick={() => void retryBackstop()}
                                            >
                                                {backstopRetryingNow
                                                    ? 'Checking satellite relief…'
                                                    : 'Retry satellite check'}
                                            </button>
                                        )}
                                        {backstopRetryMessage && (
                                            <p role="alert" className="text-amber-100">
                                                {backstopRetryMessage}
                                            </p>
                                        )}
                                    </section>
                                )}
                                <AutoroutingProposalSaveCard
                                    key={proposal.id}
                                    route={shownProposal ?? proposal}
                                    review={review}
                                    draftM={draft}
                                    draftAssumed={draftAssumed}
                                    onSaved={() => setSavedProposal(proposal)}
                                />
                            </div>
                        )}
                    </div>
                </TrialTracerShell>
            </div>
            {inspectedWaypoint && (
                <div className="autoroute-waypoint-anchor">
                    <TrialWaypointEditor
                        waypointNumber={selectedWaypoint + 1}
                        coordinates={inspectedWaypoint.coordinates}
                        moving={movingWaypoint}
                        candidate={moveCandidate}
                        lockedReason={moveLockedReason}
                        error={moveError}
                        onBeginMove={beginMove}
                        onConfirmMove={confirmMove}
                        onCancelMove={cancelMove}
                        onClose={() => {
                            cancelMove();
                            setInspectingWaypoint(false);
                        }}
                        onFocus={() =>
                            focusSpot({ lon: inspectedWaypoint.coordinates[0], lat: inspectedWaypoint.coordinates[1] })
                        }
                        onUndo={undoProposal ? undoMove : undefined}
                    />
                </div>
            )}
            {!panelExpanded && !inspectedWaypoint && (
                <div
                    className="autoroute-map-prompt rounded-xl border border-white/15 bg-slate-950 px-3 py-2 text-micro shadow-xl"
                    role="status"
                >
                    {(mapError || encNoCoverage || encHydration.remaining > 0) && (
                        <span className="block font-semibold text-amber-300">
                            {mapError ||
                                (encHydration.remaining > 0
                                    ? 'ENC chart detail is still loading.'
                                    : encCellCount > 0 && encCellCount === encReferenceCellCount
                                      ? 'Reference chart only — not navigation coverage.'
                                      : 'No navigational ENC coverage here · background map only.')}
                        </span>
                    )}
                    {proposal
                        ? dangerReported
                            ? 'Danger reported · open Route review before proceeding.'
                            : reviewProposal
                              ? 'Day plan preview · review checks, then return to the itinerary.'
                              : 'Trial proposal only · open Route review to inspect checks and save.'
                        : `Tap the chart to set ${target}.`}
                </div>
            )}
        </OverlayPortal>
    );
}
