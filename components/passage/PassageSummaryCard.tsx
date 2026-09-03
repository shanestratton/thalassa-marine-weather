/**
 * PassageSummaryCard — Full passage overview for the readiness dashboard.
 *
 * Shows route map, departure/arrival info, key stats, leg-by-leg
 * breakdown with difficulty ratings, and share controls.
 *
 * Route data comes from the global PassageStore (populated when
 * the passage planner computes a route on the Charts page).
 */

import React, { useState, useEffect, useCallback, useMemo, useRef, useLayoutEffect } from 'react';
import { triggerHaptic } from '../../utils/system';
import { usePassageStore, type PassageLeg, type PassageTurnWaypoint } from '../../stores/PassageStore';
import { PassageRouteMap } from './PassageRouteMap';
import SharePassageButton from './SharePassageButton';
import type { PassageBriefData } from '../../services/PassageBriefService';
import { useSettings } from '../../context/SettingsContext';
import type { ShipLogEntry } from '../../types';
import { TrackMapViewer } from '../TrackMapViewer';
import { Button } from '../ui/Button';
import { useReadinessIdentityScope } from '../../hooks/useReadinessSync';
import { isAuthIdentityScopeCurrent } from '../../services/authIdentityScope';
import { formatPlannedRouteLabel, isGeneratedEndpointLabel } from '../../services/shiplog/plannedRouteNaming';
import {
    departureAtLocalTime,
    derivePassageSummarySchedule,
    formatPassageDuration,
    greatCircleDistanceNm,
    localDepartureTimeMin,
    localTimeValue,
} from '../../services/passageSummarySchedule';
import { fetchRouteMaxConditions, type RouteMaxConditions } from '../../services/routeReportWeather';
import { useSettingsStore } from '../../stores/settingsStore';
import {
    AUTO_MODEL,
    getForecastModelInfo,
    isSpitfire,
    resolveForecastModel,
} from '../../services/weather/forecastModels';
import { splitDaysHours } from '../../utils/splitDaysHours';

/* ────────────────────────────────────────────────────────────── */

interface PassageSummaryCardProps {
    /** Voyage UUID — needed to fetch the sailed track or matching
     *  planned route entries when the user taps the inline map for a
     *  fullscreen playback view. */
    voyageId?: string;
    /** Voyage name — fallback match key when no sailed track exists
     *  yet. PassagePlanSave saves planned-route entries with a label
     *  derived from departure → arrival names; we match against that
     *  to find the right planned route in the logbook. */
    voyageName?: string;
    departPort?: string;
    destPort?: string;
    departureTime?: string | null;
    /** From route planner if available */
    distanceNm?: number;
    departLat?: number;
    departLon?: number;
    arriveLat?: number;
    arriveLon?: number;
    /** The saved route geometry for this exact voyage, in passage order. */
    routeCoordinates?: Array<{ lat: number; lon: number }>;
    /** The planned-route logbook voyage that supplied routeCoordinates. */
    plannedRouteId?: string;
    /** Called with the full, now-safe ISO departure and its derived ETA. */
    onDepartureTimeChange?: (departureTime: string, eta: string | null) => void;
}

/**
 * Module-scope stable empty-array reference. Used as the
 * "no waypoints" fallback for PassageRouteMap so we never hand it
 * a fresh `[]` (which would remount the Mapbox map every render).
 */
const EMPTY_WAYPOINTS: { id: string; name: string; lat: number; lon: number }[] = [];
const EMPTY_ROUTE_COORDINATES: [number, number][] = [];
/** ~9 NM at the equator. Enough for berth/port-centre drift, too tight for a different passage. */
const ROUTE_ENDPOINT_TOLERANCE_DEG = 0.15;

const isValidLatLon = (lat: number | null | undefined, lon: number | null | undefined): boolean => {
    if (lat == null || lon == null) return false;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return false;
    // (0,0) is a common uninitialised sentinel, not a credible voyage end.
    return Math.abs(lat) >= 0.0001 || Math.abs(lon) >= 0.0001;
};

const coordinatesAreNear = (
    left: { lat: number; lon: number },
    right: { lat: number; lon: number },
    tolerance = ROUTE_ENDPOINT_TOLERANCE_DEG,
): boolean => {
    // Longitude wraps at the International Date Line: +179.99° and
    // -179.99° are neighbours, not 359.98° apart.
    const wrappedLonDelta = Math.abs(((left.lon - right.lon + 540) % 360) - 180);
    return Math.abs(left.lat - right.lat) <= tolerance && wrappedLonDelta <= tolerance;
};

const formatCoord = (lat: number, lon: number): string => {
    const latDir = lat >= 0 ? 'N' : 'S';
    const lonDir = lon >= 0 ? 'E' : 'W';
    const latDeg = Math.abs(lat);
    const latMin = (latDeg % 1) * 60;
    const lonDeg = Math.abs(lon);
    const lonMin = (lonDeg % 1) * 60;
    return `${Math.floor(latDeg)}°${latMin.toFixed(1)}'${latDir} ${Math.floor(lonDeg)}°${lonMin.toFixed(1)}'${lonDir}`;
};

const formatHours = (h: number): string => {
    if (h < 1) return `${Math.round(h * 60)}min`;
    const { days, hours: hrs } = splitDaysHours(h); // rounds once — never "24h" or "1d 24h"
    if (days > 0) return `${days}d ${hrs}h`;
    return `${hrs}h`;
};

/* Module scope: this is called once per leg per render, and the card
   re-renders on a 30-second clock. One array, not sixteen strings a tick. */
const CARDINALS = [
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
] as const;

const NO_TRACK_ENTRIES: ShipLogEntry[] = [];

const bearingToCardinal = (deg: number): string => {
    return CARDINALS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
};

// Difficulty styling — refreshed 2026-05-05 for higher legibility.
//
//   color       → wind-stat accent text (kept subtle so it doesn't
//                 fight the rest of the leg row)
//   bg / border → card surface (bumped to /20 + /35 from /10 + /20
//                 so the colour reads at a glance instead of looking
//                 like a near-empty outline)
//   pillBg / pillText → SOLID badge in the top-right of each leg row,
//                 so the difficulty rating reads as a proper traffic-
//                 light pill, not just colored text.
const DIFFICULTY_CONFIG = {
    easy: {
        color: 'text-emerald-300',
        bg: 'bg-emerald-500/20',
        border: 'border-emerald-500/35',
        pillBg: 'bg-emerald-500',
        pillText: 'text-emerald-50',
        label: 'Easy',
        icon: '🟢',
    },
    moderate: {
        color: 'text-sky-300',
        bg: 'bg-sky-500/20',
        border: 'border-sky-500/35',
        pillBg: 'bg-sky-500',
        pillText: 'text-sky-50',
        label: 'Moderate',
        icon: '🔵',
    },
    tough: {
        color: 'text-amber-300',
        bg: 'bg-amber-500/20',
        border: 'border-amber-500/35',
        pillBg: 'bg-amber-500',
        pillText: 'text-amber-950',
        label: 'Tough',
        icon: '🟡',
    },
    challenging: {
        color: 'text-red-300',
        bg: 'bg-red-500/20',
        border: 'border-red-500/35',
        pillBg: 'bg-red-500',
        pillText: 'text-red-50',
        label: 'Challenging',
        icon: '🔴',
    },
} as const;

/* ── Leg Row Component ────────────────────────────────────────── */

const LegRow: React.FC<{ leg: PassageLeg; index: number }> = ({ leg, index }) => {
    const diff = DIFFICULTY_CONFIG[leg.difficulty];
    return (
        <div className={`${diff.bg} border ${diff.border} rounded-lg p-3`}>
            <div className="flex items-center justify-between mb-1.5">
                <div className="flex items-center gap-2">
                    <span className="text-xs font-mono text-gray-500">L{index + 1}</span>
                    <span className="text-xs font-bold text-white truncate max-w-[140px]">
                        {leg.from} → {leg.to}
                    </span>
                </div>
                <span
                    className={`px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider shadow-xs ${diff.pillBg} ${diff.pillText}`}
                >
                    {diff.label}
                </span>
            </div>
            {/* text-sm, not the old 12px floor: distance, time to run, heading
                and the wind on that leg are read off a phone in a cockpit. */}
            <div className="grid grid-cols-4 gap-1 text-sm font-mono">
                <div>
                    <span className="text-gray-500">Dist</span>
                    <div className="text-white">{leg.distanceNM.toFixed(1)} NM</div>
                </div>
                <div>
                    <span className="text-gray-500">Time</span>
                    <div className="text-white">{formatHours(leg.durationHours)}</div>
                </div>
                <div>
                    <span className="text-gray-500">Hdg</span>
                    <div className="text-white">
                        {Math.round(leg.bearing)}° {bearingToCardinal(leg.bearing)}
                    </div>
                </div>
                <div>
                    <span className="text-gray-500">Wind</span>
                    <div className={diff.color}>{Math.round(leg.maxWindKt)}kt</div>
                </div>
            </div>
            {leg.difficultyReason && <p className="text-[10px] text-gray-500 mt-1.5 italic">{leg.difficultyReason}</p>}
        </div>
    );
};

/* ── Main Component ───────────────────────────────────────────── */

export const PassageSummaryCard: React.FC<PassageSummaryCardProps> = ({
    voyageId,
    voyageName,
    departPort,
    destPort,
    departureTime,
    distanceNm,
    departLat,
    departLon,
    arriveLat,
    arriveLon,
    routeCoordinates,
    plannedRouteId,
    onDepartureTimeChange,
}) => {
    const identityScope = useReadinessIdentityScope();
    const passage = usePassageStore();
    // Trace compatibility rows expose their title as generated `start` / `end`
    // endpoints. Keep those raw values for the map and route lookup, but never
    // make a skipper read them as the passage title.
    const displayRouteName = departPort || destPort ? formatPlannedRouteLabel(departPort, destPort) : '-- → --';
    // settings.vessel.cruisingSpeed feeds the duration estimate when
    // there's no ETA on file. SettingsContext is reactive — change the
    // boat's cruising speed in Settings → Vessel Profile and this card
    // re-derives the displayed duration on the next render.
    const { settings } = useSettings();

    // A full ISO override keeps the native time picker, ETA, weather samples,
    // and persisted voyage in the same timezone-safe representation. The old
    // HH:mm localStorage mirror lost the date and could never persist an ETA.
    const [localDepartureOverride, setLocalDepartureOverride] = useState<string | null>(null);
    const [clockMs, setClockMs] = useState(() => Date.now());
    const conditionsRequestRef = useRef(0);
    const [routeConditions, setRouteConditions] = useState<{
        loading: boolean;
        value: RouteMaxConditions | null;
    } | null>(null);

    // Max Conditions reads from the SAME model the skipper pinned on the
    // Glass, and re-fetches when that pick changes (Shane 2026-08-04). Auto
    // and Spitfire have no single Open-Meteo id — they query the provider
    // blend and the label says so.
    const glassModel = resolveForecastModel(useSettingsStore((s) => s.settings.forecastModel));
    const conditionsQueryModel = isSpitfire(glassModel) || glassModel === AUTO_MODEL ? null : glassModel;
    const conditionsModelLabel = getForecastModelInfo(glassModel)?.label ?? 'Auto';

    // Update the lower bound while the screen remains open. A time that was
    // valid at 09:15 must not quietly remain selectable at 09:30.
    useEffect(() => {
        const refreshClock = () => setClockMs(Date.now());
        refreshClock();
        const interval = window.setInterval(refreshClock, 30_000);
        return () => window.clearInterval(interval);
    }, []);

    // Listen for a Weather Window acceptance / form edit from elsewhere.
    // The detail includes the full ISO so we retain both local date and time.
    useEffect(() => {
        const operationScope = identityScope;
        const handler = (e: Event) => {
            const detail = (e as CustomEvent).detail as { voyageId?: string; iso?: string } | undefined;
            if (isAuthIdentityScopeCurrent(operationScope) && detail?.voyageId === voyageId && detail?.iso) {
                setLocalDepartureOverride(detail.iso);
            }
        };
        window.addEventListener('thalassa:departure-time-updated', handler);
        return () => window.removeEventListener('thalassa:departure-time-updated', handler);
    }, [identityScope, voyageId]);

    useEffect(() => {
        // A different selected voyage must never inherit the previous card's
        // uncommitted picker edit.
        setLocalDepartureOverride(null);
        setRouteConditions(null);
        conditionsRequestRef.current += 1;
    }, [voyageId]);

    useEffect(() => {
        // Once the parent has round-tripped a persisted value, use it as the
        // next canonical base rather than preserving a local stale override.
        if (localDepartureOverride && departureTime === localDepartureOverride) {
            setLocalDepartureOverride(null);
        }
    }, [departureTime, localDepartureOverride]);

    const [showLegs, setShowLegs] = useState(false);

    // Fullscreen track-playback viewer state — same modal the Log book
    // uses when the user taps a voyage's map icon. Tapping the inline
    // map below opens it with the active voyage's entries (sailed
    // track if cast off, planned route otherwise). Lazy-loaded: we
    // only fetch the entries on first open, not on mount, so the
    // readiness card doesn't pay the cost when the user never opens
    // the fullscreen view.
    const [trackEntries, setTrackEntries] = useState<ShipLogEntry[] | null>(null);
    const [showTrackViewer, setShowTrackViewer] = useState(false);
    /* Stable identity for the memoised TrackMapViewer: an inline arrow and a
       fresh [] fallback re-rendered the whole track map on every clock tick. */
    const closeTrackViewer = useCallback(() => setShowTrackViewer(false), []);
    const [loadingTrack, setLoadingTrack] = useState(false);
    // Ref mirror of the loaded track so the live-poll interval can read the
    // latest without re-subscribing on every appended point.
    const trackEntriesRef = useRef<ShipLogEntry[] | null>(null);
    const trackGenerationRef = useRef(0);

    useLayoutEffect(() => {
        trackGenerationRef.current += 1;
        trackEntriesRef.current = null;
        setTrackEntries(null);
        setShowTrackViewer(false);
        setLoadingTrack(false);
        setShowLegs(false);
    }, [identityScope, voyageId]);

    useEffect(
        () => () => {
            trackGenerationRef.current += 1;
        },
        [],
    );

    const handleOpenTrackViewer = useCallback(async () => {
        const operationScope = identityScope;
        const operationGeneration = ++trackGenerationRef.current;
        const isOperationCurrent = () =>
            isAuthIdentityScopeCurrent(operationScope) && trackGenerationRef.current === operationGeneration;
        triggerHaptic('light');
        setShowTrackViewer(true);
        // One-shot per mount — reuse once loaded.
        if (trackEntries !== null) return;

        const { getCachedVoyageTrack, setCachedVoyageTrack } = await import('../../services/shiplog/VoyageTrackCache');
        if (!isOperationCurrent()) return;

        // Local-first: paint the cached track instantly so a flaky boat
        // connection — or a SECOND device viewing the recording device's
        // voyage — never leaves the viewer spinning ("iPhone can't get the
        // route up"). Then refresh from Supabase in the background and swap
        // in fresher data if it lands.
        const cached = await getCachedVoyageTrack(voyageId);
        if (!isOperationCurrent()) return;
        const haveCache = !!cached && cached.length >= 2;
        if (haveCache) setTrackEntries(cached);
        else setLoadingTrack(true);

        // Timeout the (paginated, un-cancellable) Supabase fetch so a
        // no-cache first view on bad comms shows an empty state instead of
        // hanging forever. Generous budget when a cached track is already up.
        const withTimeout = <T,>(p: Promise<T>, ms: number): Promise<T> =>
            Promise.race([
                p,
                new Promise<T>((_, reject) => setTimeout(() => reject(new Error('track-fetch-timeout')), ms)),
            ]);

        try {
            const { getLogEntries } = await import('../../services/shiplog/EntryCrud');
            if (!isOperationCurrent()) return;
            const all = await withTimeout(getLogEntries(10_000), haveCache ? 30_000 : 8_000);
            if (!isOperationCurrent()) return;

            // Sailed track first — entries written by the GPS pipeline once
            // the voyage casts off, keyed on the voyage's UUID (real telemetry).
            const sailed = voyageId ? all.filter((e) => e.voyageId === voyageId) : [];
            if (sailed.length >= 2) {
                setTrackEntries(sailed);
                if (isOperationCurrent()) void setCachedVoyageTrack(voyageId, sailed);
                return;
            }

            // Fall back to the planned route. PassagePlanSave creates a
            // separate `planned_*` log voyage. Prefer its immutable planning
            // record link (or the exact route ID supplied by CrewManagement)
            // over a label: a skipper can legitimately save the same A → B
            // route more than once, and a label-only find leaks the wrong
            // geometry into the fullscreen view.
            const expectedLabel = (voyageName || `${departPort ?? ''} → ${destPort ?? ''}`).trim().toLowerCase();
            if (expectedLabel || plannedRouteId || voyageId) {
                const { fetchRoutesAndTracks } = await import('../../services/shiplog/RoutesAndTracks');
                if (!isOperationCurrent()) return;
                const { routes } = await fetchRoutesAndTracks();
                if (!isOperationCurrent()) return;
                const exactMatch =
                    (plannedRouteId ? routes.find((route) => route.id === plannedRouteId) : undefined) ??
                    (voyageId ? routes.find((route) => route.linkedPlanId === voyageId) : undefined);
                const labelMatches = expectedLabel
                    ? routes.filter((route) => route.label.trim().toLowerCase() === expectedLabel)
                    : [];
                const matched = exactMatch ?? (labelMatches.length === 1 ? labelMatches[0] : undefined);
                if (matched) {
                    const planned = all.filter((e) => e.voyageId === matched.id);
                    if (planned.length >= 2) {
                        setTrackEntries(planned);
                        if (isOperationCurrent()) void setCachedVoyageTrack(voyageId, planned);
                        return;
                    }
                }
            }
            // Nothing fresh resolved — keep any cached track rather than blanking.
            if (!haveCache) setTrackEntries([]);
        } catch {
            // Timeout or fetch error — keep the cached track if we have one,
            // otherwise show the empty state (never an infinite spinner).
            if (!haveCache && isOperationCurrent()) setTrackEntries([]);
        } finally {
            if (isOperationCurrent()) setLoadingTrack(false);
        }
    }, [identityScope, trackEntries, voyageId, voyageName, departPort, destPort, plannedRouteId]);

    useEffect(() => {
        trackEntriesRef.current = trackEntries;
    }, [trackEntries]);

    // Almost-live cross-device: while the track viewer is open for an
    // IN-PROGRESS voyage (newest point recorded within the active window),
    // poll Supabase for newly-recorded points and append them — so a second
    // device watching the recording device's voyage sees the track grow
    // ~live. Cheap incremental query; stops when the viewer closes or the
    // voyage goes idle. Needs both devices online (shared backend) — an
    // offline boat LAN has nothing to poll.
    useEffect(() => {
        if (!showTrackViewer || !voyageId) return;
        const operationScope = identityScope;
        const operationGeneration = trackGenerationRef.current;
        const isOperationCurrent = () =>
            isAuthIdentityScopeCurrent(operationScope) && trackGenerationRef.current === operationGeneration;
        let stopped = false;
        const POLL_MS = 15_000;
        const ACTIVE_WINDOW_MS = 15 * 60_000;

        const tick = async () => {
            if (stopped || !isOperationCurrent()) return;
            const entries = trackEntriesRef.current;
            if (!entries || entries.length === 0) return;
            const newestMs = entries.reduce((m, e) => Math.max(m, Date.parse(e.timestamp)), 0);
            if (!newestMs) return;
            // Only poll while the voyage is still being recorded.
            if (Date.now() - newestMs > ACTIVE_WINDOW_MS) {
                stopped = true;
                return;
            }
            try {
                const { getVoyageEntriesSince } = await import('../../services/shiplog/EntryCrud');
                if (stopped || !isOperationCurrent()) return;
                const fresh = await getVoyageEntriesSince(voyageId, new Date(newestMs).toISOString());
                if (stopped || !isOperationCurrent() || fresh.length === 0) return;
                setTrackEntries((prev) => {
                    if (!isOperationCurrent()) return prev;
                    const merged = [...(prev ?? []), ...fresh];
                    void import('../../services/shiplog/VoyageTrackCache').then(({ setCachedVoyageTrack }) =>
                        isOperationCurrent() ? setCachedVoyageTrack(voyageId, merged) : undefined,
                    );
                    return merged;
                });
            } catch {
                /* transient comms error — retry next tick */
            }
        };

        const id = setInterval(tick, POLL_MS);
        return () => {
            stopped = true;
            clearInterval(id);
        };
    }, [identityScope, showTrackViewer, voyageId]);

    // The active VoyageRow supplies canonical geometry. Do not invent
    // endpoint coordinates from PassageStore: it is a shared chart-session
    // cache and cannot prove it belongs to this saved passage.
    const suppliedRouteEndpoints = useMemo(() => {
        const valid = (routeCoordinates ?? []).filter((point) => isValidLatLon(point.lat, point.lon));
        return valid.length >= 2 ? { departure: valid[0], arrival: valid[valid.length - 1] } : null;
    }, [routeCoordinates]);
    const propDeparture = isValidLatLon(departLat, departLon) ? { lat: departLat, lon: departLon } : null;
    const propArrival = isValidLatLon(arriveLat, arriveLon) ? { lat: arriveLat, lon: arriveLon } : null;
    const effectiveDepartLat = propDeparture?.lat ?? suppliedRouteEndpoints?.departure.lat ?? null;
    const effectiveDepartLon = propDeparture?.lon ?? suppliedRouteEndpoints?.departure.lon ?? null;
    const effectiveArriveLat = propArrival?.lat ?? suppliedRouteEndpoints?.arrival.lat ?? null;
    const effectiveArriveLon = propArrival?.lon ?? suppliedRouteEndpoints?.arrival.lon ?? null;

    const greatCircleNM = useMemo(
        () =>
            greatCircleDistanceNm(
                effectiveDepartLat != null && effectiveDepartLon != null
                    ? { lat: effectiveDepartLat, lon: effectiveDepartLon }
                    : null,
                effectiveArriveLat != null && effectiveArriveLon != null
                    ? { lat: effectiveArriveLat, lon: effectiveArriveLon }
                    : null,
            ),
        [effectiveDepartLat, effectiveDepartLon, effectiveArriveLat, effectiveArriveLon],
    );

    // PassageStore can carry stale data from a *different* voyage's
    // planning session — same localStorage key, different
    // departure/arrival pair. If its coords don't roughly match the
    // current voyage's coords, treat all of its derived fields
    // (distanceNM, totalDuration, etc.) as junk: they refer to
    // somewhere else.
    //
    // The shared PassageStore has no voyage ID, so it remains only a
    // tightly-guarded fallback. The saved route passed from the active
    // VoyageRow below always wins. A 0.15° endpoint tolerance allows normal
    // harbour/port-centre drift without admitting a nearby but different run.
    const passageMatchesVoyage =
        passage.hasRoute &&
        effectiveDepartLat != null &&
        effectiveDepartLon != null &&
        effectiveArriveLat != null &&
        effectiveArriveLon != null &&
        passage.departLat != null &&
        passage.departLon != null &&
        passage.arriveLat != null &&
        passage.arriveLon != null &&
        coordinatesAreNear(
            { lat: passage.departLat, lon: passage.departLon },
            { lat: effectiveDepartLat, lon: effectiveDepartLon },
        ) &&
        coordinatesAreNear(
            { lat: passage.arriveLat, lon: passage.arriveLon },
            { lat: effectiveArriveLat, lon: effectiveArriveLon },
        );

    // ── Map prop memoisation ──
    // PassageRouteMap's useEffect re-creates the entire Mapbox map
    // whenever its routeCoordinates / turnWaypoints prop reference
    // changes. Without memoising these here, every render of
    // PassageSummaryCard (which includes the time tick from the
    // briefing card etc) handed the map a fresh array → map.remove()
    // + new map() → flashing + heavy CPU + the "slow as a wet week"
    // performance the user reported.
    //
    // A VoyageRow carries the full planned geometry recovered from that
    // voyage's own logbook rows. Prefer it over PassageStore: the latter is
    // the last route seen on Chart and cannot prove which planning record it
    // belongs to. Endpoint validation prevents a late/stale parent render
    // from briefly drawing another passage's curve.
    const savedVoyageRouteCoordsRaw = useMemo<[number, number][]>(() => {
        if (!routeCoordinates || routeCoordinates.length < 2) return EMPTY_ROUTE_COORDINATES;
        const coordinates = routeCoordinates
            .filter((point) => isValidLatLon(point.lat, point.lon))
            .map((point) => [point.lon, point.lat] as [number, number]);
        if (coordinates.length < 2) return EMPTY_ROUTE_COORDINATES;

        if (
            effectiveDepartLat != null &&
            effectiveDepartLon != null &&
            effectiveArriveLat != null &&
            effectiveArriveLon != null &&
            (!coordinatesAreNear(
                { lat: coordinates[0][1], lon: coordinates[0][0] },
                { lat: effectiveDepartLat, lon: effectiveDepartLon },
            ) ||
                !coordinatesAreNear(
                    { lat: coordinates[coordinates.length - 1][1], lon: coordinates[coordinates.length - 1][0] },
                    { lat: effectiveArriveLat, lon: effectiveArriveLon },
                ))
        ) {
            return EMPTY_ROUTE_COORDINATES;
        }
        return coordinates;
    }, [routeCoordinates, effectiveDepartLat, effectiveDepartLon, effectiveArriveLat, effectiveArriveLon]);

    // Content-stable identity. The planning page rebuilds its voyage rows —
    // including a freshly-mapped routeCoordinates array — on every reload, so
    // identity-keyed memos downstream (schedule, map, and especially the
    // max-conditions effect with its two uncancellable Open-Meteo requests)
    // re-fired on every reload despite identical values. Same values must
    // yield the same array reference.
    const savedVoyageRouteCoordsKey = useMemo(
        () => savedVoyageRouteCoordsRaw.map(([lon, lat]) => `${lon.toFixed(6)},${lat.toFixed(6)}`).join(';'),
        [savedVoyageRouteCoordsRaw],
    );
    const stableCoordsRef = useRef<{ key: string; value: [number, number][] }>({
        key: '',
        value: EMPTY_ROUTE_COORDINATES,
    });
    if (stableCoordsRef.current.key !== savedVoyageRouteCoordsKey) {
        stableCoordsRef.current = { key: savedVoyageRouteCoordsKey, value: savedVoyageRouteCoordsRaw };
    }
    const savedVoyageRouteCoords = stableCoordsRef.current.value;

    // Memo key uses primitive coord values so the array is only rebuilt when
    // actual numbers change. There is deliberately no manufactured
    // departure→arrival fallback: a straight line is an unsafe lie when the
    // saved route's curve has not arrived yet.
    const mapRouteCoords = useMemo<[number, number][]>(() => {
        if (savedVoyageRouteCoords.length >= 2) return savedVoyageRouteCoords;
        if (!passageMatchesVoyage || passage.routeCoordinates.length < 2) return EMPTY_ROUTE_COORDINATES;
        const coordinates = passage.routeCoordinates.filter(([lon, lat]) => isValidLatLon(lat, lon));
        return coordinates.length >= 2 ? coordinates : EMPTY_ROUTE_COORDINATES;
    }, [savedVoyageRouteCoords, passageMatchesVoyage, passage.routeCoordinates]);

    const mapTurnWaypoints = useMemo(() => {
        // Turn points from the global store are only meaningful for the same
        // stored polyline. A saved per-voyage curve is already exact, so do
        // not decorate it with turn markers from some other chart session.
        return savedVoyageRouteCoords.length === 0 && passageMatchesVoyage ? passage.turnWaypoints : EMPTY_WAYPOINTS;
    }, [savedVoyageRouteCoords, passageMatchesVoyage, passage.turnWaypoints]);

    const savedRoutePoints = useMemo(
        () => savedVoyageRouteCoords.map(([lon, lat]) => ({ lat, lon })),
        [savedVoyageRouteCoords],
    );
    const fallbackDistanceNm = distanceNm ?? greatCircleNM;
    const buildSchedule = useCallback(
        (candidateDeparture: string | null | undefined, now: Date) =>
            derivePassageSummarySchedule({
                routeCoordinates: savedRoutePoints,
                fallbackDistanceNm,
                departureTime: candidateDeparture,
                cruisingSpeedKt: settings.vessel?.cruisingSpeed,
                now,
            }),
        [fallbackDistanceNm, savedRoutePoints, settings.vessel?.cruisingSpeed],
    );
    const now = useMemo(() => new Date(clockMs), [clockMs]);
    const passageSchedule = useMemo(
        () => buildSchedule(localDepartureOverride ?? departureTime, now),
        [buildSchedule, departureTime, localDepartureOverride, now],
    );
    const effectiveTime = localTimeValue(passageSchedule.departureTime);
    const effectiveTimeMin = localDepartureTimeMin(passageSchedule.departureTime, now);
    const effectiveDistance = passageSchedule.distanceNm;
    const effectiveEta = passageSchedule.eta;
    const duration = formatPassageDuration(passageSchedule.durationHours);

    // A pre-existing past departure must self-heal while the card is visible,
    // rather than staying valid only until the page is reopened. Do not create
    // a default voyage date from a blank field; only normalise one the skipper
    // has already saved.
    const automaticDepartureRef = useRef<string | null>(null);
    useEffect(() => {
        const storedDepartureMs = departureTime ? Date.parse(departureTime) : NaN;
        if (!onDepartureTimeChange || !Number.isFinite(storedDepartureMs) || storedDepartureMs >= clockMs) {
            automaticDepartureRef.current = null;
            return;
        }
        if (automaticDepartureRef.current === passageSchedule.departureTime) return;
        automaticDepartureRef.current = passageSchedule.departureTime;
        setLocalDepartureOverride(passageSchedule.departureTime);
        onDepartureTimeChange(passageSchedule.departureTime, passageSchedule.eta);
    }, [clockMs, departureTime, onDepartureTimeChange, passageSchedule.departureTime, passageSchedule.eta]);

    const handleTimeChange = useCallback(
        (e: React.ChangeEvent<HTMLInputElement>) => {
            const candidate = departureAtLocalTime(passageSchedule.departureTime, e.target.value, new Date(clockMs));
            const nextSchedule = buildSchedule(candidate, new Date(clockMs));
            setLocalDepartureOverride(nextSchedule.departureTime);
            onDepartureTimeChange?.(nextSchedule.departureTime, nextSchedule.eta);
            triggerHaptic('light');
        },
        [buildSchedule, clockMs, onDepartureTimeChange, passageSchedule.departureTime],
    );

    // Conditions intentionally come from an ETA-aware sampling of this exact
    // saved curve. Old global PassageStore weather can describe a different
    // chart route, so it is never used as a fallback here.
    useEffect(() => {
        const request = ++conditionsRequestRef.current;
        let disposed = false;
        if (savedRoutePoints.length < 2 || !effectiveEta) {
            setRouteConditions({ loading: false, value: null });
            return () => {
                disposed = true;
            };
        }
        setRouteConditions({ loading: true, value: null });
        void fetchRouteMaxConditions(
            savedRoutePoints,
            Date.parse(passageSchedule.departureTime),
            passageSchedule.cruisingSpeedKt,
            conditionsQueryModel,
        )
            .then((value) => {
                if (disposed || conditionsRequestRef.current !== request) return;
                setRouteConditions({ loading: false, value });
            })
            .catch(() => {
                if (disposed || conditionsRequestRef.current !== request) return;
                setRouteConditions({ loading: false, value: null });
            });
        return () => {
            disposed = true;
        };
    }, [
        effectiveEta,
        passageSchedule.cruisingSpeedKt,
        passageSchedule.departureTime,
        savedRoutePoints,
        conditionsQueryModel,
    ]);

    const effectiveMaxWind = routeConditions?.value?.maxWindKts ?? null;
    const effectiveMaxWave = routeConditions?.value?.maxWaveM ?? null;

    /* Build brief data for sharing.

       Memoised: SharePassageButton keys its share handlers on this object, so
       a fresh literal on every 30-second clock tick rebuilt the waypoint list
       and invalidated both callbacks for no change in content. */
    const briefData: PassageBriefData | null = useMemo(() => {
        if (
            effectiveDistance == null ||
            effectiveDepartLat == null ||
            effectiveDepartLon == null ||
            effectiveArriveLat == null ||
            effectiveArriveLon == null
        ) {
            return null;
        }
        const shareTurnWaypoints: PassageTurnWaypoint[] = passageMatchesVoyage ? passage.turnWaypoints : [];
        return {
            routeName: displayRouteName,
            origin: { name: departPort || 'Departure', lat: effectiveDepartLat, lon: effectiveDepartLon },
            destination: { name: destPort || 'Arrival', lat: effectiveArriveLat, lon: effectiveArriveLon },
            departureTime: passageSchedule.departureTime,
            totalDistanceNM: effectiveDistance,
            estimatedDuration: passageSchedule.durationHours ?? 0,
            speed: passageSchedule.cruisingSpeedKt,
            vesselName: passageMatchesVoyage ? (passage.vesselName ?? undefined) : settings.vessel?.name,
            turnWaypoints: shareTurnWaypoints.map((wp) => ({
                name: wp.name,
                lat: wp.lat,
                lon: wp.lon,
                tws: wp.tws,
                bng: wp.bearing,
            })),
        };
    }, [
        effectiveDistance,
        effectiveDepartLat,
        effectiveDepartLon,
        effectiveArriveLat,
        effectiveArriveLon,
        displayRouteName,
        departPort,
        destPort,
        passageSchedule.departureTime,
        passageSchedule.durationHours,
        passageSchedule.cruisingSpeedKt,
        passageMatchesVoyage,
        passage.turnWaypoints,
        passage.vesselName,
        settings.vessel?.name,
    ]);

    // Difficulty summary
    const difficultySummary = useMemo(() => {
        if (!passageMatchesVoyage || passage.legs.length === 0) return null;
        const counts = { easy: 0, moderate: 0, tough: 0, challenging: 0 };
        passage.legs.forEach((l) => counts[l.difficulty]++);
        return counts;
    }, [passageMatchesVoyage, passage.legs]);

    return (
        <div className="space-y-3">
            {/* ── Route Header ── */}
            <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-linear-to-r from-sky-500/6 to-indigo-500/3 border border-sky-500/15">
                <div className="text-2xl">&#x1F9ED;</div>
                <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold text-white truncate">{displayRouteName}</p>
                    {passageSchedule.departureTime && (
                        <p className="text-[11px] text-sky-400/70 mt-0.5">
                            {new Date(passageSchedule.departureTime).toLocaleDateString('en-AU', {
                                weekday: 'short',
                                day: 'numeric',
                                month: 'short',
                                year: 'numeric',
                            })}
                        </p>
                    )}
                </div>
                {/* Share button */}
                {briefData && <SharePassageButton briefData={briefData} className="shrink-0" />}
            </div>

            {/* ── Route Map ──
                Tap to open the same fullscreen TrackMapViewer the
                Log book uses — playback scrubber, telemetry HUD, and
                a clearer view of the route geometry. The wrapper is
                a button so the inline map stays non-interactive
                (PassageRouteMap doesn't pan/zoom) while the click
                surface still reads as tappable to the user. */}
            {effectiveDepartLat != null &&
                effectiveDepartLon != null &&
                effectiveArriveLat != null &&
                effectiveArriveLon != null &&
                mapRouteCoords.length >= 2 && (
                    <button
                        type="button"
                        onClick={handleOpenTrackViewer}
                        aria-label="Open fullscreen track view"
                        className="relative block w-full rounded-2xl overflow-hidden focus:outline-hidden focus:ring-2 focus:ring-sky-400/40 transition-shadow"
                    >
                        <PassageRouteMap
                            routeCoordinates={mapRouteCoords}
                            departLat={effectiveDepartLat}
                            departLon={effectiveDepartLon}
                            arriveLat={effectiveArriveLat}
                            arriveLon={effectiveArriveLon}
                            turnWaypoints={mapTurnWaypoints}
                            height={220}
                        />
                        {/* Hint chip — bottom-right so it doesn't fight
                            the route line for attention */}
                        <span className="absolute bottom-2 right-2 px-2 py-1 rounded-full bg-slate-900/80 border border-white/10 text-[10px] font-bold uppercase tracking-widest text-sky-300 backdrop-blur-xs pointer-events-none">
                            Tap to expand
                        </span>
                    </button>
                )}

            {/* ── Key Stats Grid ── */}
            <div className="grid grid-cols-2 gap-2">
                {/* Optimal Departure Time
                    The native iOS <input type="time"> imposes its own
                    min-width for the picker chrome (~140pt on iOS),
                    which on a narrow phone can ignore the parent's
                    width and bleed past the right edge of the stat
                    card. Wrapping in a flex container with
                    justify-center centers whatever natural width the
                    OS gives us, and overflow-hidden on the outer card
                    clips any final stragglers. The input itself drops
                    w-full so it sizes to its content rather than
                    stretching past the parent. */}
                <div className="bg-white/3 border border-white/6 rounded-xl p-3 min-w-0 overflow-hidden">
                    <div className="text-[11px] text-gray-400 uppercase tracking-widest font-bold mb-1.5 flex items-center gap-1">
                        Departure Time
                    </div>
                    <div className="flex justify-center">
                        <input
                            type="time"
                            value={effectiveTime}
                            min={effectiveTimeMin}
                            onChange={handleTimeChange}
                            aria-label="Departure Time"
                            className="min-h-[44px] bg-white/5 border border-white/10 rounded-lg px-2 py-2 text-base font-bold text-white font-mono focus:outline-hidden focus:border-sky-500/50 focus:ring-1 focus:ring-sky-500/30 transition-all max-w-full"
                            style={{ colorScheme: 'dark', boxSizing: 'border-box' }}
                        />
                    </div>
                </div>

                {/* Duration */}
                <div className="bg-white/3 border border-white/6 rounded-xl p-3">
                    <div className="text-[11px] text-gray-400 uppercase tracking-widest font-bold mb-1.5 flex items-center gap-1">
                        Duration
                    </div>
                    <div className="text-lg font-bold text-white font-mono text-center py-2">{duration}</div>
                </div>

                {/* Distance */}
                <div className="bg-white/3 border border-white/6 rounded-xl p-3">
                    <div className="text-[11px] text-gray-400 uppercase tracking-widest font-bold mb-1.5 flex items-center gap-1">
                        Distance
                    </div>
                    <div className="text-lg font-bold text-white font-mono text-center py-2">
                        {effectiveDistance != null ? `${effectiveDistance.toFixed(1)} NM` : '--'}
                    </div>
                </div>

                {/* Max Conditions */}
                <div className="bg-white/3 border border-white/6 rounded-xl p-3">
                    <div className="text-[11px] text-gray-400 uppercase tracking-widest font-bold mb-1.5 flex items-center gap-1">
                        Max Conditions
                    </div>
                    <div className="text-center py-2">
                        {effectiveMaxWind != null || effectiveMaxWave != null ? (
                            <div>
                                <div className="flex items-center justify-center gap-2">
                                    {effectiveMaxWind != null && (
                                        <span
                                            className={`text-sm font-bold font-mono ${
                                                effectiveMaxWind > 30
                                                    ? 'text-red-400'
                                                    : effectiveMaxWind > 20
                                                      ? 'text-amber-400'
                                                      : 'text-emerald-400'
                                            }`}
                                        >
                                            {effectiveMaxWind}kt
                                        </span>
                                    )}
                                    {effectiveMaxWave != null && (
                                        <span
                                            className={`text-sm font-bold font-mono ${
                                                effectiveMaxWave > 3
                                                    ? 'text-red-400'
                                                    : effectiveMaxWave > 2
                                                      ? 'text-amber-400'
                                                      : 'text-sky-400'
                                            }`}
                                        >
                                            {effectiveMaxWave.toFixed(1)}m
                                        </span>
                                    )}
                                </div>
                                {routeConditions?.value?.beyondForecast && (
                                    <p className="mt-1 text-[9px] font-bold uppercase tracking-wide text-amber-300">
                                        Forecast partial
                                    </p>
                                )}
                            </div>
                        ) : routeConditions?.loading ? (
                            <span className="text-xs font-bold text-sky-300/80">Forecasting…</span>
                        ) : routeConditions?.value?.beyondForecast ? (
                            <span className="text-[11px] font-bold text-amber-300/80">Partial forecast</span>
                        ) : (
                            <span className="text-xs font-bold text-gray-500">Forecast unavailable</span>
                        )}
                        <p className="mt-1 text-[9px] font-bold uppercase tracking-widest text-gray-500">
                            {conditionsModelLabel} model
                        </p>
                    </div>
                </div>
            </div>

            {/* ── Difficulty Overview ── */}
            {difficultySummary && (
                <div className="bg-white/3 border border-white/6 rounded-xl p-3">
                    <div className="text-[11px] text-gray-400 uppercase tracking-widest font-bold mb-2">
                        Passage Difficulty
                    </div>
                    <div className="flex items-center gap-1.5">
                        {passage.legs.map((leg, i) => {
                            const cfg = DIFFICULTY_CONFIG[leg.difficulty];
                            return (
                                <div
                                    key={i}
                                    className={`flex-1 h-2.5 rounded-full ${cfg.bg} border ${cfg.border}`}
                                    title={`L${i + 1}: ${leg.from} → ${leg.to} (${cfg.label})`}
                                />
                            );
                        })}
                    </div>
                    <div className="flex items-center justify-between mt-2 text-[10px] text-gray-500">
                        <span>Departure</span>
                        <div className="flex items-center gap-3">
                            {difficultySummary.easy > 0 && (
                                <span className="text-emerald-400">{difficultySummary.easy} easy</span>
                            )}
                            {difficultySummary.moderate > 0 && (
                                <span className="text-sky-400">{difficultySummary.moderate} moderate</span>
                            )}
                            {difficultySummary.tough > 0 && (
                                <span className="text-amber-400">{difficultySummary.tough} tough</span>
                            )}
                            {difficultySummary.challenging > 0 && (
                                <span className="text-red-400">{difficultySummary.challenging} hard</span>
                            )}
                        </div>
                        <span>Arrival</span>
                    </div>
                </div>
            )}

            {/* ── Leg-by-Leg Breakdown ── */}
            {passageMatchesVoyage && passage.legs.length > 0 && (
                <div>
                    <Button
                        variant="secondary"
                        onClick={() => {
                            setShowLegs((v) => !v);
                            triggerHaptic('light');
                        }}
                        className="w-full justify-between text-left"
                    >
                        <span className="text-[11px] text-gray-400 uppercase tracking-widest font-bold">
                            Leg Breakdown ({passage.legs.length} legs)
                        </span>
                        <svg
                            className={`w-4 h-4 text-gray-500 transition-transform ${showLegs ? 'rotate-180' : ''}`}
                            viewBox="0 0 20 20"
                            fill="currentColor"
                        >
                            <path
                                fillRule="evenodd"
                                d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
                                clipRule="evenodd"
                            />
                        </svg>
                    </Button>
                    {showLegs && (
                        <div className="mt-2 space-y-2 animate-in slide-in-from-top-2 duration-200">
                            {passage.legs.map((leg, i) => (
                                <LegRow key={i} leg={leg} index={i} />
                            ))}
                        </div>
                    )}
                </div>
            )}

            {/* ── Coordinates ── */}
            <div className="bg-white/3 border border-white/6 rounded-xl p-3">
                <div className="text-[11px] text-gray-400 uppercase tracking-widest font-bold mb-2">
                    Passage Coordinates
                </div>
                <div className="grid grid-cols-2 gap-3">
                    <div>
                        <div className="text-[11px] text-emerald-400 uppercase tracking-widest font-bold mb-0.5">
                            Departure
                        </div>
                        <div className="text-xs text-white font-mono">
                            {effectiveDepartLat != null && effectiveDepartLon != null
                                ? formatCoord(effectiveDepartLat, effectiveDepartLon)
                                : isGeneratedEndpointLabel(departPort)
                                  ? '--'
                                  : departPort || '--'}
                        </div>
                    </div>
                    <div>
                        <div className="text-[11px] text-amber-400 uppercase tracking-widest font-bold mb-0.5">
                            Arrival
                        </div>
                        <div className="text-xs text-white font-mono">
                            {effectiveArriveLat != null && effectiveArriveLon != null
                                ? formatCoord(effectiveArriveLat, effectiveArriveLon)
                                : isGeneratedEndpointLabel(destPort)
                                  ? '--'
                                  : destPort || '--'}
                        </div>
                    </div>
                </div>
            </div>

            {/* ── ETA ── */}
            {effectiveEta && (
                <div className="flex items-center gap-2 px-4 py-3 rounded-xl bg-emerald-500/5 border border-emerald-500/15">
                    <span className="text-lg">&#x1F3C1;</span>
                    <div>
                        <p className="text-[11px] text-gray-400 uppercase tracking-widest font-bold">
                            Estimated Arrival
                        </p>
                        <p className="text-sm font-bold text-emerald-400 font-mono">
                            {new Date(effectiveEta).toLocaleString('en-AU', {
                                weekday: 'short',
                                day: 'numeric',
                                month: 'short',
                                hour: '2-digit',
                                minute: '2-digit',
                            })}
                        </p>
                    </div>
                </div>
            )}

            {/* ── No Route Message ── */}
            {/* Only shown when the user has nothing — no passage selected */}
            {/* AND no route in the store. If they've already picked a draft */}
            {/* (departPort + destPort populated) they don't need a CTA */}
            {/* telling them to plan a route, that's exactly what they did. */}
            {mapRouteCoords.length < 2 && !departPort && !destPort && (
                <div className="px-4 py-3 rounded-xl bg-white/2 border border-white/6 text-center">
                    <p className="text-xs text-gray-500">
                        Plan a route on the Charts page to see the full passage breakdown here.
                    </p>
                </div>
            )}

            {/* Fullscreen track playback viewer — same modal the Log
                book opens. While the entries are loading we still
                render the modal so the user gets the dark backdrop
                immediately, then the map populates the moment the
                fetch resolves. If no entries are available (planned
                route not yet saved, no sailed track), TrackMapViewer
                will gracefully show its empty-state. */}
            <TrackMapViewer
                isOpen={showTrackViewer}
                onClose={closeTrackViewer}
                entries={trackEntries ?? NO_TRACK_ENTRIES}
            />
            {showTrackViewer && loadingTrack && (
                <div className="fixed inset-0 z-10000 flex items-center justify-center pointer-events-none">
                    <div className="px-3 py-1.5 rounded-full bg-slate-900/90 border border-white/10 text-[11px] text-sky-300 font-bold pointer-events-auto">
                        Loading track…
                    </div>
                </div>
            )}
        </div>
    );
};
