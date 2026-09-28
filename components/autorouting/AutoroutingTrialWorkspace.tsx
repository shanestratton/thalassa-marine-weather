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
import {
    calculateAutoroutingTrial,
    getAutoroutingTrialStatus,
    type AutoroutingTrialRoute,
    type AutoroutingTrialStatus,
} from '../../services/autoroutingTrial';
import {
    AUTOROUTING_TRIAL_MAX_DRAFT_M,
    AUTOROUTING_TRIAL_MAX_SPEED_KTS,
    type AutoroutingVesselProfile,
} from '../../types/autorouting';
import { formatLatDegMin, formatLonDegMin } from '../../utils/formatDegMin';
import { useEncChartInventory } from '../map/useEncChartInventory';
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
import { resolveAutomaticCanalExit, VERIFIED_CANAL_EXIT_PROFILES } from '../../services/automaticCanalExit';
import { verifyCanalExitChart } from '../../services/verifyCanalExitChart';
import { providerHazardMapFeature, providerHazardViewport } from '../../services/providerHazardGeometry';
import type { AutoroutingProviderFinding } from '../../supabase/functions/_shared/autorouting-provider-check';
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
type Endpoint = 'departure' | 'destination' | 'canal exit';
type DepartureMode = 'canal' | 'open-water';
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
    const [canalExit, setCanalExit] = useState(emptyPosition);
    // No default: an unnoticed checkbox must not send a canal departure
    // straight to SevenCs, bypassing the local connector.
    const [departureMode, setDepartureMode] = useState<DepartureMode | null>(null);
    const canalEnabled = departureMode === 'canal';
    const [manualExitOverride, setManualExitOverride] = useState(false);
    const [exitRevision, setExitRevision] = useState(0);
    const start = useMemo(() => point(departure), [departure]);
    const end = useMemo(() => point(destination), [destination]);
    const exitResolution = useMemo(
        () => (start && canalEnabled ? resolveAutomaticCanalExit(start, end, VERIFIED_CANAL_EXIT_PROFILES) : null),
        // Review validity is time-based: expiry/resume explicitly advances this revision.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [start, end, canalEnabled, exitRevision],
    );
    const automaticExit = !manualExitOverride && exitResolution?.status === 'resolved' ? exitResolution : null;
    const automaticSourceKey = automaticExit ? `${automaticExit.profileId}:${automaticExit.sourceRevision}` : '';
    const [verifiedExitSource, setVerifiedExitSource] = useState('');
    const exitSourceReady = !!automaticSourceKey && verifiedExitSource === automaticSourceKey;
    const effectiveExitInput = useMemo(
        () =>
            automaticExit ? { lat: String(automaticExit.exit.lat), lon: String(automaticExit.exit.lon) } : canalExit,
        [automaticExit, canalExit],
    );
    const [progress, setProgress] = useState('');
    const endpointNames: Endpoint[] =
        canalEnabled && !automaticExit ? ['departure', 'canal exit', 'destination'] : ['departure', 'destination'];
    const endpointInput = (name: Endpoint) =>
        name === 'departure' ? departure : name === 'destination' ? destination : canalExit;
    const [target, setTarget] = useState<Endpoint>('departure');
    // Read-only Vessel preferences from the mode chooser. Clear resets the
    // proposed route, never the boat. Preserve the full metres conversion.
    const { draft, speed, vesselProfile } = useRef({
        draft: initialDraftM,
        speed: initialSpeedKts,
        vesselProfile: initialVesselProfile ? structuredClone(initialVesselProfile) : undefined,
    }).current;
    const draftAssumed = vesselProfile?.draftStatus !== 'measured';
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
    const profileSupported = !vesselProfile || status?.vesselProfile === true;
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
                ? buildTrialWaypointPlan(
                      proposal.coordinates,
                      proposal.canalDeparture ? [proposal.canalDeparture.handoverIndex] : [],
                      proposal.localEdit?.waypointIndices ?? [],
                  )
                : { waypoints: [], sparse: true },
        [proposal],
    );
    const displayWaypoints = waypointPlan.waypoints;
    const waypointCountRef = useRef(displayWaypoints.length);
    waypointCountRef.current = displayWaypoints.length;
    const passageNm = (displayWaypoints.at(-1)?.distanceM ?? 0) / 1852;
    const [savedProposal, setSavedProposal] = useState<AutoroutingTrialRoute | null>(null);
    const [locatedProvider, setLocatedProvider] = useState<AutoroutingProviderFinding | null>(null);
    const locatedProviderRef = useRef(locatedProvider);
    locatedProviderRef.current = locatedProvider;
    const { review, stop: stopReview, recheck } = useAutoroutingReview(proposal, draft, draftAssumed);
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
        setProposal(null);
        setUndoProposal(null);
        setPanelPage('setup');
        setSavedProposal(null);
        setLocatedProvider(null);
        setError('');
        setProgress('');
        setInspectingWaypoint(false);
        setMovingWaypoint(false);
        setMoveCandidate(null);
        setMoveError('');
        moveBasisRef.current = null;
    }, []);
    // A manual exit belongs to one departure. Even partially editing its
    // coordinates invalidates the old association and any in-flight request.
    const updateEndpoint = (name: Endpoint, value: PositionInput) => {
        invalidate();
        if (name === 'departure') {
            setDeparture(value);
            setCanalExit(emptyPosition());
            setManualExitOverride(false);
        } else if (name === 'destination') setDestination(value);
        else {
            setCanalExit(value);
            setManualExitOverride(true);
        }
    };
    useEffect(() => {
        // Coordinate-entry can resolve an exit without a chart tap. Never leave
        // a now-hidden Canal Exit target armed for the next tap.
        if (automaticExit && target === 'canal exit') setTarget('destination');
    }, [automaticExit, target]);
    const automaticProfileId = automaticExit?.profileId;
    useEffect(() => {
        setVerifiedExitSource('');
        if (!automaticProfileId) return;
        const controller = new AbortController();
        const scope = getAuthIdentityScope();
        void verifyCanalExitChart(automaticProfileId, controller.signal)
            .catch(() => false)
            .then((verified) => {
                if (controller.signal.aborted || !isAuthIdentityScopeCurrent(scope)) return;
                if (verified) setVerifiedExitSource(automaticSourceKey);
                else {
                    invalidate();
                    setManualExitOverride(true);
                    setCanalExit(emptyPosition());
                    setTarget('canal exit');
                    setError(
                        'The installed chart could not verify this automatic exit. Choose Canal exit manually, or retry the chart check.',
                    );
                }
            });
        return () => controller.abort();
    }, [automaticProfileId, automaticSourceKey, exitRevision, invalidate]);
    useEffect(() => {
        if (!automaticExit) return;
        const delay = Math.max(0, Date.parse(automaticExit.validUntil) - Date.now());
        // Long timers overflow in browsers. Recheck boundedly, including when
        // a suspended phone resumes after the source review has expired.
        const refresh = () => {
            invalidate();
            setExitRevision((v) => v + 1);
        };
        const timer = window.setTimeout(refresh, Math.min(delay + 1, 2_147_000_000));
        const resume = () => {
            if (Date.now() >= Date.parse(automaticExit.validUntil)) refresh();
        };
        document.addEventListener('visibilitychange', resume);
        return () => {
            window.clearTimeout(timer);
            document.removeEventListener('visibilitychange', resume);
        };
    }, [automaticExit, invalidate]);
    const selectPoint = useRef((_lat: number, _lon: number) => {});
    selectPoint.current = (lat, lon) => {
        if (movingWaypoint) {
            setMoveCandidate([lon, lat]);
            setMoveError('');
            return;
        }
        if (proposal && !editingEndpoints) return;
        const input = { lat: lat.toFixed(6), lon: lon.toFixed(6) };
        updateEndpoint(target, input);
        const nextExit =
            target === 'departure' && canalEnabled && point(input)
                ? resolveAutomaticCanalExit(point(input)!, end, VERIFIED_CANAL_EXIT_PROFILES)
                : null;
        setTarget(
            target === 'departure' && canalEnabled && nextExit?.status !== 'resolved' ? 'canal exit' : 'destination',
        );
    };
    const selectWaypoint = useRef<(index: number) => boolean>(() => false);
    selectWaypoint.current = (index) => {
        if (proposal && !editingEndpoints && Number.isInteger(index) && index >= 0 && index < displayWaypoints.length) {
            localSpotFocused.current = true;
            setLocatedProvider(null);
            setSelectedWaypoint(index);
            setInspectingWaypoint(true);
            setPanelExpanded(false);
            return true;
        }
        return false;
    };

    useEffect(() => {
        const controller = new AbortController();
        const scope = getAuthIdentityScope();
        const unsubscribe = subscribeAuthIdentityScope(() => {
            controller.abort();
            invalidate();
            setDeparture(emptyPosition());
            setDestination(emptyPosition());
            setStatus(null);
            onClose();
        });
        void getAutoroutingTrialStatus(controller.signal)
            .then((next) => {
                if (!controller.signal.aborted && isAuthIdentityScopeCurrent(scope)) setStatus(next);
            })
            .catch(() => {});
        return () => {
            controller.abort();
            pending.current?.abort();
            unsubscribe();
        };
    }, [invalidate, onClose]);

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
            map.addSource('trial-review', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
            map.addLayer({
                id: 'trial-reviewed-legs',
                type: 'line',
                source: 'trial-review',
                filter: ['==', '$type', 'LineString'],
                paint: { 'line-color': ['get', 'color'], 'line-width': 4 },
            });
            map.addLayer({
                id: 'trial-endpoints',
                type: 'circle',
                source: 'trial',
                filter: ['==', '$type', 'Point'],
                paint: {
                    'circle-radius': 8,
                    'circle-color': [
                        'match',
                        ['get', 'endpoint'],
                        'departure',
                        '#34d399',
                        'canal exit',
                        '#fbbf24',
                        '#c084fc',
                    ],
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
            map.addSource('trial-provider-hazard', {
                type: 'geojson',
                data: { type: 'FeatureCollection', features: [] },
            });
            const hazardColor = ['match', ['get', 'severity'], 'danger', '#fb7185', '#fbbf24'] as const;
            map.addLayer({
                id: 'trial-provider-fill',
                type: 'fill',
                source: 'trial-provider-hazard',
                filter: ['==', '$type', 'Polygon'],
                paint: { 'fill-color': [...hazardColor], 'fill-opacity': 0.22 },
            });
            map.addLayer({
                id: 'trial-provider-line',
                type: 'line',
                source: 'trial-provider-hazard',
                filter: ['in', '$type', 'LineString', 'Polygon'],
                paint: { 'line-color': [...hazardColor], 'line-width': 4 },
            });
            map.addLayer({
                id: 'trial-provider-point',
                type: 'circle',
                source: 'trial-provider-hazard',
                filter: ['==', '$type', 'Point'],
                paint: {
                    'circle-color': [...hazardColor],
                    'circle-radius': 14,
                    'circle-stroke-width': 3,
                    'circle-stroke-color': '#0f172a',
                },
            });
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
                // Retain any hazard highlight, but stop treating it as a camera command.
                locatedProviderRef.current = null;
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
            const hazardViewport =
                locatedProviderRef.current && !localSpotFocused.current
                    ? providerHazardViewport(locatedProviderRef.current)
                    : null;
            if (hazardViewport)
                map.fitBounds(hazardViewport.bounds, { padding: viewportPadding(), maxZoom: 16, duration: 0 });
            else if (proposalBounds.current && !localSpotFocused.current)
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

    const exit = canalEnabled ? point(effectiveExitInput) : null;
    const providerReport = proposal?.localEdit?.originalProposal.providerCheck ?? proposal?.providerCheck;
    const dangerReported =
        providerReport?.status === 'unsafe' ||
        providerReport?.findings.some((finding) => finding.severity === 'danger') ||
        review?.legs.some((leg) => leg?.verdict.grade === 'danger');
    const missingPosition = !start ? 'departure' : canalEnabled && !exit ? 'canal exit' : !end ? 'destination' : null;
    const valid =
        departureMode &&
        start &&
        end &&
        (start.lat !== end.lat || start.lon !== end.lon) &&
        vesselReady &&
        profileSupported &&
        (!canalEnabled || (!!exit && (!automaticExit || exitSourceReady)));
    const chooseDepartureMode = (mode: DepartureMode) => {
        if (mode === departureMode) return;
        invalidate();
        setDepartureMode(mode);
        setCanalExit(emptyPosition());
        setManualExitOverride(false);
        const resolved =
            mode === 'canal' && start ? resolveAutomaticCanalExit(start, end, VERIFIED_CANAL_EXIT_PROFILES) : null;
        setTarget(
            mode === 'canal' && start ? (resolved?.status === 'resolved' ? 'destination' : 'canal exit') : 'departure',
        );
        setEditingEndpoints(true);
    };
    useEffect(() => {
        const source = mapRef.current?.getSource('trial') as mapboxgl.GeoJSONSource | undefined;
        if (!mapReady || !source) return;
        const features: GeoJSON.Feature[] = [];
        const endpoints: [Endpoint, PositionInput][] = [
            ['departure', departure],
            ['destination', destination],
        ];
        if (canalEnabled) endpoints.push(['canal exit', effectiveExitInput]);
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
    }, [mapReady, departure, destination, canalEnabled, effectiveExitInput, proposal, viewportPadding]);

    useEffect(() => {
        if (!mapReady) return;
        const source = mapRef.current?.getSource('trial-review') as mapboxgl.GeoJSONSource | undefined;
        source?.setData(trialReviewFeatures(proposal?.coordinates ?? [], review, displayWaypoints));
    }, [mapReady, proposal, review, displayWaypoints]);
    useEffect(() => {
        if (!mapReady) return;
        localSpotFocused.current = preserveEditedViewport.current;
        preserveEditedViewport.current = false;
        const source = mapRef.current?.getSource('trial-focus') as mapboxgl.GeoJSONSource | undefined;
        source?.setData({ type: 'FeatureCollection', features: [] });
        (mapRef.current?.getSource('trial-provider-hazard') as mapboxgl.GeoJSONSource | undefined)?.setData({
            type: 'FeatureCollection',
            features: [],
        });
        setLocatedProvider(null);
    }, [mapReady, proposal]);
    const focusSpot = (spot: { lat: number; lon: number }) => {
        const map = mapRef.current;
        if (!map) return;
        localSpotFocused.current = true;
        setLocatedProvider(null);
        (map.getSource('trial-provider-hazard') as mapboxgl.GeoJSONSource | undefined)?.setData({
            type: 'FeatureCollection',
            features: [],
        });
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
            : inspectedWaypoint.pathIndex === proposal?.canalDeparture?.handoverIndex
              ? 'Change the canal exit in route setup, then recalculate.'
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
                moved.route.canalDeparture ? [moved.route.canalDeparture.handoverIndex] : [],
                moved.route.localEdit?.waypointIndices ?? [],
            );
            // Fresh immutable geometry starts a complete new local review. The
            // old provider report is historical, never current clearance.
            stopReview();
            preserveEditedViewport.current = true;
            localSpotFocused.current = true;
            setSavedProposal(null);
            setUndoProposal(proposal);
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
        setLocatedProvider(null);
        setInspectingWaypoint(false);
        setSelectedWaypoint(0);
        setProposal(undoProposal);
        setUndoProposal(null);
        setPanelPage('review');
    };
    const fitRoute = () => {
        if (!proposalBounds.current) return;
        pendingSpot.current = null;
        cancelMove();
        setInspectingWaypoint(false);
        setLocatedProvider(null);
        locatedProviderRef.current = null;
        localSpotFocused.current = false;
        for (const source of ['trial-focus', 'trial-provider-hazard']) {
            (mapRef.current?.getSource(source) as mapboxgl.GeoJSONSource | undefined)?.setData({
                type: 'FeatureCollection',
                features: [],
            });
        }
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
    const focusProvider = (finding: AutoroutingProviderFinding) => {
        const map = mapRef.current;
        const feature = providerHazardMapFeature(finding);
        const viewport = providerHazardViewport(finding);
        if (!map || !mapReady || !feature || !viewport) return;
        localSpotFocused.current = false;
        (map.getSource('trial-focus') as mapboxgl.GeoJSONSource | undefined)?.setData({
            type: 'FeatureCollection',
            features: [],
        });
        (map.getSource('trial-provider-hazard') as mapboxgl.GeoJSONSource | undefined)?.setData({
            type: 'FeatureCollection',
            features: [feature],
        });
        setLocatedProvider(finding);
        map.fitBounds(viewport.bounds, {
            padding: viewportPadding(),
            maxZoom: 16,
            duration: 500,
        });
        collapsePanel();
    };

    // The folded status may gain lines when a hazard or missing ENC coverage is
    // reported. Measure the committed DOM before framing its exact geometry.
    useLayoutEffect(() => {
        if (!mapReady || panelExpanded) return;
        const viewport = locatedProvider && !localSpotFocused.current ? providerHazardViewport(locatedProvider) : null;
        if (viewport)
            mapRef.current?.fitBounds(viewport.bounds, { padding: viewportPadding(), maxZoom: 16, duration: 0 });
        else if (proposalBounds.current && !localSpotFocused.current)
            mapRef.current?.fitBounds(proposalBounds.current, { padding: viewportPadding(), duration: 0 });
    }, [
        mapReady,
        panelExpanded,
        locatedProvider,
        encNoCoverage,
        encHydration.remaining,
        mapError,
        viewportPadding,
        fitRevision,
    ]);
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
        if (!valid || !departureMode || !start || !end || !vesselReady || !status?.ready || busy || pending.current)
            return;
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
            let calculateProvider = calculateAutoroutingTrial;
            // Older deployments do not accept chart-track constraints. Only
            // load the scoped guidance path after the entitled server advertises it.
            if (status.channelGuidance === true) {
                const { createChartGuidedTrialCalculator, CHART_GUIDANCE_TOTAL_TIMEOUT_MS } =
                    await import('../../services/chartGuidedAutorouting');
                if (controller.signal.aborted || !isAuthIdentityScopeCurrent(scope)) return;
                calculateProvider = createChartGuidedTrialCalculator({
                    channelGuidance: true,
                    onProgress,
                    // Include local canal work in the optional guidance budget,
                    // reserving time before the canal's outer abort deadline.
                    deadlineAtMs: Date.now() + CHART_GUIDANCE_TOTAL_TIMEOUT_MS,
                });
            }
            let route: AutoroutingTrialRoute;
            if (canalEnabled && exit) {
                // Do not use a source that expired between render and tapping
                // Calculate, nor fall through to a direct provider request.
                const currentExit = automaticExit
                    ? resolveAutomaticCanalExit(start, end, VERIFIED_CANAL_EXIT_PROFILES)
                    : null;
                if (automaticExit && currentExit?.status !== 'resolved') {
                    setExitRevision((v) => v + 1);
                    throw new Error('Automatic channel exit needs review. Choose the exit manually.');
                }
                if (automaticExit && !(await verifyCanalExitChart(automaticExit.profileId, controller.signal)))
                    throw new Error(
                        'The chart no longer matches the reviewed channel exit. Choose Canal exit manually.',
                    );
                const { calculateWithCanalDeparture } = await import('../../services/autoroutingCanalDeparture');
                if (controller.signal.aborted || !isAuthIdentityScopeCurrent(scope)) return;
                route = await calculateWithCanalDeparture(
                    request,
                    exit,
                    openingToken.current,
                    controller.signal,
                    onProgress,
                    currentExit?.status === 'resolved' ? currentExit : undefined,
                    calculateProvider,
                );
            } else if (departureMode === 'open-water') {
                route = await calculateProvider(request, controller.signal);
            } else return;
            if (automaticExit) {
                const currentExit = resolveAutomaticCanalExit(start, end, VERIFIED_CANAL_EXIT_PROFILES);
                if (
                    currentExit.status !== 'resolved' ||
                    currentExit.profileId !== automaticExit.profileId ||
                    currentExit.sourceRevision !== automaticExit.sourceRevision ||
                    JSON.stringify(currentExit.gateCentres) !== JSON.stringify(automaticExit.gateCentres) ||
                    !(await verifyCanalExitChart(automaticExit.profileId, controller.signal))
                )
                    throw new Error(
                        'The automatic exit review changed during calculation. No proposal has been accepted.',
                    );
                // A chart read may straddle expiry too (including resume from sleep).
                if (Date.now() >= Date.parse(currentExit.validUntil))
                    throw new Error('The automatic exit review expired. Choose Canal exit manually.');
            }
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
    const clear = () => {
        invalidate();
        setDeparture(emptyPosition());
        setDestination(emptyPosition());
        setCanalExit(emptyPosition());
        setManualExitOverride(false);
        setDepartureMode(null);
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
                                      : departureMode
                                        ? missingPosition
                                            ? `Set ${missingPosition}`
                                            : 'Ready to calculate'
                                        : 'Choose departure type'}
                            </span>
                            {dangerReported && (
                                <span className="block font-bold">Danger reported · review required</span>
                            )}
                            {proposal?.localEdit && (
                                <span className="block">Edited · provider checks no longer apply</span>
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
                                <fieldset className="min-w-0">
                                    <legend className="text-micro font-semibold text-gray-300">
                                        Departure type — choose one
                                    </legend>
                                    <div className="mt-1 grid grid-cols-2 gap-2">
                                        {(
                                            [
                                                ['canal', 'Canal / marina'],
                                                ['open-water', 'Open water'],
                                            ] as const
                                        ).map(([mode, label]) => (
                                            <button
                                                key={mode}
                                                type="button"
                                                aria-pressed={departureMode === mode}
                                                onClick={() => chooseDepartureMode(mode)}
                                                className={`${buttonClass} min-w-0 ${departureMode === mode ? 'border-teal-400 bg-teal-500/20 text-teal-200' : 'bg-slate-900 text-white'}`}
                                            >
                                                {label}
                                            </button>
                                        ))}
                                    </div>
                                </fieldset>
                                <p className="text-micro text-gray-400">
                                    {!departureMode
                                        ? 'Choose Canal / marina or Open water above before calculating.'
                                        : proposal && !editingEndpoints
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
                                {canalEnabled && automaticExit && (
                                    <section
                                        aria-label="Automatic channel exit"
                                        className="rounded-xl border border-teal-400/30 bg-teal-500/10 p-3 text-micro"
                                    >
                                        <div className="flex items-center justify-between gap-2">
                                            <button
                                                type="button"
                                                className="min-h-11 text-left"
                                                onClick={() => focusSpot(automaticExit.exit)}
                                            >
                                                <span className="block font-bold text-teal-300">
                                                    {automaticExit.label} ·{' '}
                                                    {exitSourceReady ? 'automatic exit' : 'checking chart…'}
                                                </span>
                                                <span className="block tabular-nums">
                                                    {formatLatDegMin(automaticExit.exit.lat)}{' '}
                                                    {formatLonDegMin(automaticExit.exit.lon)}
                                                </span>
                                            </button>
                                            <button
                                                type="button"
                                                className={buttonClass}
                                                onClick={() => {
                                                    invalidate();
                                                    setCanalExit(emptyPosition());
                                                    setManualExitOverride(true);
                                                    setTarget('canal exit');
                                                    setEditingEndpoints(true);
                                                }}
                                            >
                                                Choose manually
                                            </button>
                                        </div>
                                        <p>
                                            {proposal?.localEdit
                                                ? 'Exit retained. The canal path has been edited; its original marker-pair checks no longer apply.'
                                                : `Local route through ${automaticExit.gateCentres.length} charted marker pairs; SevenCs starts at the final pair. Depth and hazards still need checking.`}
                                        </p>
                                    </section>
                                )}
                                {canalEnabled && !automaticExit && (
                                    <p className="text-micro text-amber-300">
                                        {!manualExitOverride && exitResolution?.status === 'manual-required' && (
                                            <span className="block">{exitResolution.reason}</span>
                                        )}
                                        Place Canal exit in open water beyond the walls. Thalassa plots to it; SevenCs
                                        starts there. Local water shape does not establish depth or clearance.
                                    </p>
                                )}
                                {canalEnabled && manualExitOverride && exitResolution?.status === 'resolved' && (
                                    <button
                                        type="button"
                                        className={buttonClass}
                                        onClick={() => {
                                            invalidate();
                                            setManualExitOverride(false);
                                            setCanalExit(emptyPosition());
                                            setTarget('destination');
                                            setEditingEndpoints(true);
                                        }}
                                    >
                                        Use automatic channel exit
                                    </button>
                                )}
                                {departureMode === 'open-water' && (
                                    <p className="text-micro text-gray-300">
                                        SevenCs starts at departure. For a canal or marina exit, choose Canal / marina
                                        above.
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
                                                className={`${buttonClass} min-w-0 py-2 text-left ${endpointNames.length === 3 && name === 'destination' ? 'col-span-2' : ''} ${target === name ? 'border-teal-400 bg-teal-500/10' : ''}`}
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
                                        <p className="mt-2 text-micro text-amber-300">
                                            Missing or estimated dimensions are not confirmed clearance. Change
                                            measurements in Vessel preferences.
                                        </p>
                                    </details>
                                )}
                                {status?.ready && !profileSupported && (
                                    <p role="status" className="text-micro text-amber-300">
                                        The routing service needs an update to use your full boat details. No
                                        measurements have been omitted.
                                    </p>
                                )}
                                {!status?.ready && (
                                    <p role="status" className="text-micro text-amber-300">
                                        {status?.message ||
                                            (status
                                                ? 'Trial calculation is not available.'
                                                : 'Checking trial availability…')}
                                    </p>
                                )}
                                {departureMode && missingPosition && (
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
                                    route={proposal}
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
                                        setLocatedProvider(null);
                                        setSelectedWaypoint(index);
                                        setInspectingWaypoint(true);
                                        collapsePanel();
                                    }}
                                    onLocateProvider={focusProvider}
                                    onStop={stopReview}
                                    onRecheck={recheck}
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
                                        {proposal.localEdit
                                            ? 'Locally edited trial proposal'
                                            : proposal.canalDeparture
                                              ? 'Thalassa canal + SevenCs proposal'
                                              : 'SevenCs proposal'}{' '}
                                        ·{' '}
                                        {savedProposal === proposal
                                            ? 'saved as a plan, not activated'
                                            : 'not saved or activated'}
                                    </p>
                                    {proposal.localEdit && (
                                        <p role="status" className="text-amber-300">
                                            Waypoints moved · new local chart checks required. The original provider and
                                            canal checks no longer apply. Saving this edited trial is unavailable.
                                        </p>
                                    )}
                                    {proposal.canalDeparture && !proposal.localEdit && (
                                        <p>
                                            Canal exit: waypoint{' '}
                                            {displayWaypoints.findIndex(
                                                (waypoint) =>
                                                    waypoint.pathIndex === proposal.canalDeparture!.handoverIndex,
                                            ) + 1}
                                            . Provider checks apply to the SevenCs section only.
                                        </p>
                                    )}
                                    {proposal.localEdit && (
                                        <p className="font-semibold">Original proposal notices (historical):</p>
                                    )}
                                    {proposal.warnings.map((warning, index) => (
                                        <p key={index} className="text-amber-300">
                                            {warning}
                                        </p>
                                    ))}
                                </section>
                            </div>
                        )}
                        {proposal && typeof draft === 'number' && !reviewProposal && (
                            <div hidden={panelPage !== 'review'}>
                                <AutoroutingProposalSaveCard
                                    key={proposal.id}
                                    route={proposal}
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
                    {locatedProvider && (
                        <span className="block font-semibold text-amber-300">
                            SevenCs {locatedProvider.severity} · exact reported {locatedProvider.geometry?.type}{' '}
                            highlighted.
                        </span>
                    )}
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
                        : !departureMode
                          ? 'Open Set up route to choose Canal / marina or Open water.'
                          : `Tap the chart to set ${target}.`}
                </div>
            )}
        </OverlayPortal>
    );
}
