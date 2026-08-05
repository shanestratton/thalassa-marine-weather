/**
 * WeatherWindowCard — Departure window analyser for cruisers.
 *
 * "When should I leave?"
 * Analyses 16 days of weather, scores 6h departure windows.
 * Shows Go / Marginal / Wait ratings.
 * Red → Green when skipper accepts a departure window.
 */

import React, { useState, useEffect, useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import {
    WeatherWindowService,
    WEATHER_WINDOW_MAX_FALLBACK_AGE_MS,
    isWeatherWindowResultAcceptable,
    type WeatherWindowResult,
    type DepartureWindow,
} from '../../services/WeatherWindowService';
import { type Voyage } from '../../services/VoyageService';
import { triggerHaptic } from '../../utils/system';
import { calculateBearing } from '../../utils/navigationCalculations';
import {
    useReadinessIdentityScope,
    useScopedReadinessStorageState,
    useSingleCheckSync,
} from '../../hooks/useReadinessSync';
import { isAuthIdentityScopeCurrent } from '../../services/authIdentityScope';
import { useSettings } from '../../context/SettingsContext';
import {
    isWeatherWindowAcceptanceRecord,
    passageDataFingerprint,
    passageRouteFingerprint,
    weatherWindowAcceptanceFingerprint,
    type WeatherWindowAcceptanceRecord,
} from '../../services/passageEnvironmentReadiness';

interface WeatherWindowCardProps {
    voyageId?: string;
    departure?: { lat: number; lon: number };
    destination?: { lat: number; lon: number };
    routeCoordinates?: Array<{ lat: number; lon: number }>;
    activeVoyage?: Voyage | null;
    /** ISO timestamp the skipper picked for departure. When provided,
     *  the card auto-scopes the visible windows to ±3 days around this
     *  date and re-renders whenever it changes — so picking a new
     *  departure date in the form (or accepting a window in this very
     *  card) instantly updates which days are highlighted.
     *
     *  Falls back to activeVoyage.departure_time if undefined. */
    departureTime?: string | null;
    /** Parent-owned route scheduler; receives the accepted full ISO time. */
    onDepartureTimeChange?: (departureTime: string, eta?: string | null) => void;
    onReviewedChange?: (ready: boolean) => void;
}

const STORAGE_KEY = 'thalassa_accepted_window';

const RATING_STYLES = {
    go: {
        bg: 'bg-emerald-500/15',
        border: 'border-emerald-500/25',
        text: 'text-emerald-400',
        label: '✅ GO',
        dot: 'bg-emerald-400',
    },
    marginal: {
        bg: 'bg-amber-500/10',
        border: 'border-amber-500/20',
        text: 'text-amber-400',
        label: '⚠️ MARGINAL',
        dot: 'bg-amber-400',
    },
    wait: {
        bg: 'bg-red-500/10',
        border: 'border-red-500/20',
        text: 'text-red-400',
        label: '❌ WAIT',
        dot: 'bg-red-400',
    },
};

export const WeatherWindowCard: React.FC<WeatherWindowCardProps> = ({
    voyageId,
    departure,
    destination,
    routeCoordinates,
    activeVoyage: _activeVoyage,
    departureTime,
    onDepartureTimeChange,
    onReviewedChange,
}) => {
    const identityScope = useReadinessIdentityScope();
    // Resolve the chosen departure date — priority order:
    //   1. The latest ISO captured from a `thalassa:departure-time-updated`
    //      event (live, fires the moment the form's date input changes
    //      or another card accepts a window). Snapshot in local state
    //      so the filter below re-runs without waiting for a parent
    //      prop to round-trip through React Context.
    //   2. The explicit `departureTime` prop (when the parent already
    //      pipes the chosen date through).
    //   3. The active voyage's departure_time (last-resort fallback).
    const [eventDepartureIso, setEventDepartureIso] = useState<string | null>(null);
    const externalDepartureIso = departureTime ?? _activeVoyage?.departure_time ?? null;
    const previousExternalDepartureRef = useRef(externalDepartureIso);
    useLayoutEffect(() => {
        if (previousExternalDepartureRef.current !== externalDepartureIso) {
            previousExternalDepartureRef.current = externalDepartureIso;
            setEventDepartureIso(externalDepartureIso);
        }
    }, [externalDepartureIso]);
    useEffect(() => {
        const operationScope = identityScope;
        const handler = (e: Event) => {
            const detail = (e as CustomEvent).detail as { voyageId?: string; iso?: string } | undefined;
            const iso = detail?.iso;
            if (
                isAuthIdentityScopeCurrent(operationScope) &&
                detail?.voyageId === voyageId &&
                typeof iso === 'string'
            ) {
                setEventDepartureIso(iso);
            }
        };
        window.addEventListener('thalassa:departure-time-updated', handler);
        return () => window.removeEventListener('thalassa:departure-time-updated', handler);
    }, [identityScope, voyageId]);

    const chosenDepartureIso = eventDepartureIso ?? externalDepartureIso;
    const chosenDepartureMs = chosenDepartureIso ? Date.parse(chosenDepartureIso) : NaN;
    const hasChosenDate = Number.isFinite(chosenDepartureMs);
    const [result, setResult] = useState<WeatherWindowResult | null>(null);
    const [resultInputFingerprint, setResultInputFingerprint] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const lifecycleGenerationRef = useRef(0);
    const analysisRequestRef = useRef(0);
    const acceptanceMutationRef = useRef(0);
    const [acceptance, setAcceptance] = useScopedReadinessStorageState<unknown>(STORAGE_KEY, voyageId, null);
    const [showAll, setShowAll] = useState(false);
    const [freshnessNowMs, setFreshnessNowMs] = useState(() => Date.now());
    const { settings } = useSettings();

    // Determine departure coordinates
    const lat = departure?.lat ?? null;
    const lon = departure?.lon ?? null;

    // Calculate course bearing
    const destLat = destination?.lat ?? null;
    const destLon = destination?.lon ?? null;

    let courseBearing: number | undefined;
    if (lat != null && lon != null && destLat != null && destLon != null) {
        courseBearing = calculateBearing(lat, lon, destLat, destLon);
    }
    const hasRoute = lat != null && lon != null && destLat != null && destLon != null;
    const routeFingerprint = useMemo(
        () => passageRouteFingerprint(routeCoordinates, departure, destination),
        [routeCoordinates, departure, destination],
    );
    const vesselAndComfortFingerprint = passageDataFingerprint('weather-window-vessel-inputs', {
        vessel: {
            type: settings.vessel?.type,
            cruisingSpeedKts: settings.vessel?.cruisingSpeed,
            maxWindKts: settings.vessel?.maxWindSpeed,
            maxWaveHeight: settings.vessel?.maxWaveHeight,
        },
        comfort: settings.comfortParams,
    });
    const analysisInputFingerprint = passageDataFingerprint('weather-window-card-analysis', {
        lat,
        lon,
        courseBearing,
        vesselAndComfortFingerprint,
    });

    useLayoutEffect(() => {
        lifecycleGenerationRef.current += 1;
        analysisRequestRef.current += 1;
        acceptanceMutationRef.current += 1;
        setEventDepartureIso(null);
        setResult(null);
        setResultInputFingerprint(null);
        setLoading(false);
        setError(null);
        setShowAll(false);
    }, [identityScope, voyageId]);

    useEffect(
        () => () => {
            lifecycleGenerationRef.current += 1;
            analysisRequestRef.current += 1;
            acceptanceMutationRef.current += 1;
        },
        [],
    );

    // Supabase sync — restore only a complete fingerprint record. Legacy
    // index-only acceptance rows cannot prove which route/data was reviewed.
    const { syncSingleCheck } = useSingleCheckSync(voyageId, 'weather_window', 'accepted');
    useEffect(() => {
        if (!voyageId) return;
        const operationScope = identityScope;
        const mutationAtLoadStart = acceptanceMutationRef.current;
        let cancelled = false;
        void import('../../services/ReadinessCheckService')
            .then(({ ReadinessCheckService }) => ReadinessCheckService.loadCardChecks(voyageId, 'weather_window'))
            .then((checks) => {
                const acceptedCheck = checks.accepted;
                if (
                    cancelled ||
                    !isAuthIdentityScopeCurrent(operationScope) ||
                    acceptanceMutationRef.current !== mutationAtLoadStart ||
                    !acceptedCheck?.checked ||
                    !isWeatherWindowAcceptanceRecord(acceptedCheck.metadata)
                ) {
                    return;
                }
                setAcceptance(acceptedCheck.metadata);
            })
            .catch(() => {
                /* scoped local record remains authoritative while offline */
            });
        return () => {
            cancelled = true;
        };
    }, [identityScope, voyageId, setAcceptance]);

    const analyse = useCallback(async () => {
        const operationScope = identityScope;
        const operationGeneration = ++analysisRequestRef.current;
        const isOperationCurrent = () =>
            isAuthIdentityScopeCurrent(operationScope) && analysisRequestRef.current === operationGeneration;
        if (lat == null || lon == null) {
            setError('No departure coordinates — plan a route first');
            return;
        }
        setLoading(true);
        setError(null);
        try {
            const data = await WeatherWindowService.analyse(lat, lon, voyageId, courseBearing);
            if (!isOperationCurrent()) return;
            setResult(data);
            setResultInputFingerprint(analysisInputFingerprint);
            setFreshnessNowMs(Date.now());
            if (data.availability === 'unavailable') setError(data.failureReason);
        } catch {
            if (isOperationCurrent()) setError('Failed to analyse weather windows');
        } finally {
            if (isOperationCurrent()) setLoading(false);
        }
    }, [identityScope, lat, lon, voyageId, courseBearing, analysisInputFingerprint]);

    // Auto-analyse on mount
    useEffect(() => {
        if (lat != null && lon != null) void analyse();
    }, [lat, lon, analyse]);

    const acceptedWindowIndex =
        isWeatherWindowAcceptanceRecord(acceptance) && result?.availability === 'available'
            ? result.windows.findIndex((window) => Date.parse(window.time) === Date.parse(acceptance.departureIso))
            : -1;
    const acceptedWindow = acceptedWindowIndex >= 0 ? result?.windows[acceptedWindowIndex] : undefined;
    const resultMatchesInputs = resultInputFingerprint === analysisInputFingerprint;
    const currentAcceptanceFingerprint =
        resultMatchesInputs && result?.availability === 'available' && acceptedWindow
            ? weatherWindowAcceptanceFingerprint({
                  departureIso: new Date(acceptedWindow.time).toISOString(),
                  routeFingerprint,
                  vessel: {
                      type: settings.vessel?.type,
                      cruisingSpeedKts: settings.vessel?.cruisingSpeed,
                      maxWindKts: settings.vessel?.maxWindSpeed,
                      maxWaveHeight: settings.vessel?.maxWaveHeight,
                  },
                  comfort: settings.comfortParams ?? {},
                  analysisContextFingerprint: result.analysisContextFingerprint,
                  dataFingerprint: result.dataFingerprint,
              })
            : null;
    const normalizedChosenDepartureIso = hasChosenDate ? new Date(chosenDepartureMs).toISOString() : null;
    const weatherDataAcceptable = resultMatchesInputs && isWeatherWindowResultAcceptable(result, freshnessNowMs);
    const accepted =
        weatherDataAcceptable &&
        isWeatherWindowAcceptanceRecord(acceptance) &&
        currentAcceptanceFingerprint === acceptance.fingerprint &&
        normalizedChosenDepartureIso === acceptance.departureIso;

    useEffect(() => {
        onReviewedChange?.(accepted);
    }, [accepted, onReviewedChange]);

    useEffect(() => {
        if (result?.availability !== 'available') return;
        const expiresAt = Date.parse(result.analysisTime) + WEATHER_WINDOW_MAX_FALLBACK_AGE_MS;
        const delayMs = expiresAt - Date.now();
        if (delayMs <= 0) {
            setFreshnessNowMs(Date.now());
            return;
        }
        const timeout = window.setTimeout(() => setFreshnessNowMs(Date.now()), Math.min(delayMs + 25, 2_147_483_647));
        return () => window.clearTimeout(timeout);
    }, [result]);

    // Mobile browsers can suspend expiry timers while the app is in the
    // background. Re-evaluate age as soon as the page becomes visible again
    // so a six-hour-old forecast can never remain accepted after resume.
    useEffect(() => {
        const refreshFreshness = () => setFreshnessNowMs(Date.now());
        const onVisibilityChange = () => {
            if (document.visibilityState === 'visible') refreshFreshness();
        };
        window.addEventListener('focus', refreshFreshness);
        document.addEventListener('visibilitychange', onVisibilityChange);
        return () => {
            window.removeEventListener('focus', refreshFreshness);
            document.removeEventListener('visibilitychange', onVisibilityChange);
        };
    }, []);

    const acceptWindow = useCallback(
        (index: number) => {
            const operationScope = identityScope;
            const operationGeneration = lifecycleGenerationRef.current;
            const isOperationCurrent = () =>
                isAuthIdentityScopeCurrent(operationScope) && lifecycleGenerationRef.current === operationGeneration;
            if (
                !isOperationCurrent() ||
                !hasRoute ||
                !resultMatchesInputs ||
                !isWeatherWindowResultAcceptable(result, Date.now())
            ) {
                setError('Refresh the forecast before accepting a departure window.');
                return;
            }
            const win = result.windows[index];
            if (!win?.time || !Number.isFinite(Date.parse(win.time))) return;
            const newDepartureIso = new Date(win.time).toISOString();
            const record: WeatherWindowAcceptanceRecord = {
                version: 1,
                fingerprint: weatherWindowAcceptanceFingerprint({
                    departureIso: newDepartureIso,
                    routeFingerprint,
                    vessel: {
                        type: settings.vessel?.type,
                        cruisingSpeedKts: settings.vessel?.cruisingSpeed,
                        maxWindKts: settings.vessel?.maxWindSpeed,
                        maxWaveHeight: settings.vessel?.maxWaveHeight,
                    },
                    comfort: settings.comfortParams ?? {},
                    analysisContextFingerprint: result.analysisContextFingerprint,
                    dataFingerprint: result.dataFingerprint,
                }),
                routeFingerprint,
                dataFingerprint: result.dataFingerprint,
                departureIso: newDepartureIso,
                acceptedAt: new Date().toISOString(),
            };
            acceptanceMutationRef.current += 1;
            setAcceptance(record);
            triggerHaptic('medium');
            if (voyageId) {
                // Mirror to Supabase so the acceptance follows the
                // skipper to other devices. Index is carried in
                // metadata; the boolean state is "accepted: true".
                syncSingleCheck(true, { ...record, index });
            }

            // ── Sync the accepted window through the parent route scheduler.
            // That one path uses the saved curve + vessel cruise speed for
            // ETA; preserving a previously stored ETA duration is wrong after
            // either the route or vessel profile has changed.
            if (win.time) {
                const winDate = new Date(win.time);
                if (!isNaN(winDate.getTime())) {
                    const hh = String(winDate.getHours()).padStart(2, '0');
                    const mm = String(winDate.getMinutes()).padStart(2, '0');
                    const hhmm = `${hh}:${mm}`;
                    setEventDepartureIso(newDepartureIso);
                    onDepartureTimeChange?.(newDepartureIso, null);

                    // Standalone use still broadcasts a live update; the
                    // regular Passage Planning parent emits the same event
                    // after it has derived and persisted the matching ETA.
                    try {
                        if (isOperationCurrent() && !onDepartureTimeChange) {
                            window.dispatchEvent(
                                new CustomEvent('thalassa:departure-time-updated', {
                                    detail: { voyageId, hhmm, iso: newDepartureIso },
                                }),
                            );
                        }
                    } catch {
                        /* SSR safety */
                    }
                }
            }
        },
        [
            identityScope,
            hasRoute,
            resultMatchesInputs,
            result,
            routeFingerprint,
            settings.vessel,
            settings.comfortParams,
            setAcceptance,
            voyageId,
            syncSingleCheck,
            onDepartureTimeChange,
        ],
    );

    // Determine windows to show.
    //
    // When the skipper has picked a departure date we scope the visible
    // windows to ±3 days around it — the typical "do I leave a day
    // earlier or a day later" decision space. Without this scoping the
    // user sees 16 days of windows and has to scroll to find their
    // chosen date. With it, the card centres on the date the user
    // cares about and updates immediately when they change it.
    //
    // When no date is picked yet, fall back to the previous behaviour
    // (top-rated windows from the full forecast).
    //
    // Indices below stay in `allWindows` coordinates. The durable acceptance
    // resolves by the window's departure instant, so filtering never changes
    // the identity of what the skipper accepted.
    const allWindows = result?.windows ?? [];
    const FOCUS_HALF_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
    const displayWindows = hasChosenDate
        ? allWindows.filter((w) => {
              const wMs = Date.parse(w.time);
              if (!Number.isFinite(wMs)) return false;
              return Math.abs(wMs - chosenDepartureMs) <= FOCUS_HALF_WINDOW_MS;
          })
        : allWindows;

    // Best window within the visible scope (not result.bestWindowIndex,
    // which is the global best — could fall outside the focus window).
    let scopedBestIdx = -1;
    for (const w of displayWindows) {
        const i = allWindows.indexOf(w);
        if (i < 0) continue;
        if (scopedBestIdx < 0 || w.score > allWindows[scopedBestIdx].score) scopedBestIdx = i;
    }

    const topWindows = showAll
        ? displayWindows
        : hasChosenDate
          ? displayWindows
          : displayWindows.filter((w) => w.rating === 'go' || w.rating === 'marginal').slice(0, 6);
    const goCount = displayWindows.filter((w) => w.rating === 'go').length;

    // Pre-format the chosen date for the summary line so the user sees
    // exactly which day the picker is focused on.
    const chosenDateLabel = hasChosenDate
        ? new Date(chosenDepartureMs).toLocaleDateString(undefined, {
              weekday: 'short',
              day: 'numeric',
              month: 'short',
          })
        : null;
    const weatherDataAgeMs =
        result?.availability === 'available'
            ? Math.max(0, freshnessNowMs - Date.parse(result.analysisTime))
            : Number.POSITIVE_INFINITY;
    const weatherDataAgeLabel = Number.isFinite(weatherDataAgeMs)
        ? weatherDataAgeMs < 60_000
            ? 'less than 1 minute old'
            : weatherDataAgeMs < 60 * 60_000
              ? `${Math.floor(weatherDataAgeMs / 60_000)} minutes old`
              : `${Math.floor(weatherDataAgeMs / (60 * 60_000))}h ${Math.floor((weatherDataAgeMs % (60 * 60_000)) / 60_000)}m old`
        : 'age unknown';

    return (
        <div className="space-y-4">
            {/* No coordinates */}
            {lat == null && (
                <div className="bg-white/[0.03] border border-dashed border-white/[0.08] rounded-xl p-4 text-center">
                    <p className="text-2xl mb-2">🧭</p>
                    <p className="text-xs text-gray-400">
                        Plan a route first to enable weather window analysis.
                        <br />
                        Departure coordinates are needed.
                    </p>
                </div>
            )}

            {/* Loading */}
            {loading && (
                <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-6 text-center">
                    <div className="w-8 h-8 border-2 border-cyan-400/20 border-t-cyan-400 rounded-full animate-spin mx-auto mb-3" />
                    <p className="text-xs text-gray-400">Analysing 16-day forecast...</p>
                </div>
            )}

            {/* Error */}
            {error && (
                <div role="alert" className="bg-red-500/10 border border-red-500/20 rounded-xl p-3 flex gap-2">
                    <span className="text-lg">⚠️</span>
                    <div className="flex-1">
                        <p className="text-xs text-red-300">{error}</p>
                        {result?.availability === 'unavailable' && (
                            <p className="text-[11px] text-gray-400 mt-1">Provider: {result.provider}</p>
                        )}
                        <button onClick={analyse} className="text-[11px] font-bold text-cyan-300 mt-2">
                            Retry forecast analysis
                        </button>
                    </div>
                </div>
            )}

            {/* Results */}
            {result?.availability === 'available' && !loading && (
                <>
                    {/* Summary bar */}
                    <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-3 flex items-center gap-3">
                        <span className="text-lg">{goCount > 0 ? '🌤️' : '⛈️'}</span>
                        <div className="flex-1">
                            <p className="text-xs font-bold text-white">
                                {chosenDateLabel ? (
                                    <>
                                        {goCount > 0
                                            ? `${goCount} departure window${goCount !== 1 ? 's' : ''}`
                                            : 'No ideal windows'}{' '}
                                        <span className="text-amber-300">around {chosenDateLabel}</span>
                                    </>
                                ) : goCount > 0 ? (
                                    `${goCount} departure window${goCount !== 1 ? 's' : ''} open`
                                ) : (
                                    'No ideal windows — proceed with caution'
                                )}
                            </p>
                            <p className="text-[11px] text-gray-500 mt-0.5">
                                {result.provider} · {result.source === 'live' ? 'live download' : 'cached analysis'} ·
                                updated {new Date(result.analysisTime).toLocaleString()} · {weatherDataAgeLabel}
                                {chosenDateLabel ? ' · scope ±3 days' : ''}
                            </p>
                        </div>
                        <button
                            onClick={analyse}
                            className="px-2.5 py-1.5 rounded-lg text-[11px] font-bold text-cyan-400 bg-cyan-500/10 border border-cyan-500/20 hover:bg-cyan-500/20 transition-all"
                        >
                            Refresh
                        </button>
                    </div>

                    {!weatherDataAcceptable && (
                        <div role="alert" className="bg-red-500/10 border border-red-500/20 rounded-xl p-3">
                            <p className="text-xs font-bold text-red-300">Forecast is too old to accept</p>
                            <p className="text-[11px] text-gray-400 mt-1">
                                Refresh this {weatherDataAgeLabel} analysis. Departure readiness is blocked after 6
                                hours.
                            </p>
                        </div>
                    )}

                    {/* No windows in the chosen-date scope (e.g. user
                        picked a date beyond the 16-day forecast horizon) */}
                    {displayWindows.length === 0 && hasChosenDate && (
                        <div className="bg-amber-500/[0.05] border border-amber-500/15 rounded-xl p-3 text-center">
                            <p className="text-xs text-amber-300">
                                No forecast data within ±3 days of {chosenDateLabel}.
                            </p>
                            <p className="text-[11px] text-gray-400 mt-1">
                                The 16-day forecast horizon doesn&apos;t reach this date — pick something closer.
                            </p>
                        </div>
                    )}

                    {/* Best window highlight (best within the visible
                        scope — not the global best, which could be
                        outside the chosen-date filter). */}
                    {scopedBestIdx >= 0 && allWindows[scopedBestIdx] && (
                        <WindowCard
                            window={allWindows[scopedBestIdx]}
                            index={scopedBestIdx}
                            isBest
                            isAccepted={accepted && acceptedWindowIndex === scopedBestIdx}
                            canAccept={weatherDataAcceptable && hasRoute}
                            disabledLabel={hasRoute ? 'Refresh forecast to accept' : 'Complete route to accept'}
                            onAccept={acceptWindow}
                        />
                    )}

                    {/* Other windows. Indices map back to allWindows while
                        persistence resolves by departure instant. */}
                    {topWindows
                        .filter((w) => allWindows.indexOf(w) !== scopedBestIdx)
                        .map((w) => {
                            const origIdx = allWindows.indexOf(w);
                            return (
                                <WindowCard
                                    key={w.time}
                                    window={w}
                                    index={origIdx}
                                    isAccepted={accepted && acceptedWindowIndex === origIdx}
                                    canAccept={weatherDataAcceptable && hasRoute}
                                    disabledLabel={hasRoute ? 'Refresh forecast to accept' : 'Complete route to accept'}
                                    onAccept={acceptWindow}
                                />
                            );
                        })}

                    {/* Show all toggle */}
                    {!showAll && displayWindows.length > topWindows.length + 1 && (
                        <button
                            onClick={() => setShowAll(true)}
                            className="w-full py-2 text-[11px] font-bold text-gray-400 hover:text-white transition-colors"
                        >
                            Show all {displayWindows.length} windows ▾
                        </button>
                    )}
                </>
            )}

            {/* Accepted summary */}
            {accepted && acceptedWindow && (
                <div className="flex items-center gap-2 px-4 py-3 rounded-xl border bg-emerald-500/10 border-emerald-500/20">
                    <span className="text-lg">✅</span>
                    <div>
                        <p className="text-xs font-bold text-emerald-400">Window accepted: {acceptedWindow.label}</p>
                        <p className="text-[11px] text-emerald-400/60 mt-0.5">{acceptedWindow.description}</p>
                    </div>
                </div>
            )}
            {!accepted && isWeatherWindowAcceptanceRecord(acceptance) && result?.availability === 'available' && (
                <p role="status" className="text-[11px] text-amber-300 text-center">
                    Departure, route, vessel limits or forecast data changed — accept a current matching window again.
                </p>
            )}
        </div>
    );
};

/** Individual window card */
const WindowCard: React.FC<{
    window: DepartureWindow;
    index: number;
    isBest?: boolean;
    isAccepted?: boolean;
    canAccept: boolean;
    disabledLabel: string;
    onAccept: (index: number) => void;
}> = ({ window: w, index, isBest, isAccepted, canAccept, disabledLabel, onAccept }) => {
    const style = RATING_STYLES[w.rating];
    return (
        <div
            className={`${style.bg} border ${style.border} rounded-xl p-3 transition-all ${
                isAccepted ? 'ring-2 ring-emerald-400/40' : ''
            }`}
        >
            <div className="flex items-center gap-3 mb-2">
                <div className="flex-1">
                    <div className="flex items-center gap-2">
                        <span className={`text-sm font-black ${style.text}`}>{w.label}</span>
                        {isBest && (
                            <span className="px-1.5 py-0.5 bg-amber-500/20 text-amber-300 text-[11px] font-bold rounded-full border border-amber-500/20">
                                ⭐ BEST
                            </span>
                        )}
                    </div>
                    <p className="text-[11px] font-bold text-white/80 mt-0.5 uppercase tracking-wider">
                        {w.rating === 'go' ? '✅' : w.rating === 'marginal' ? '⚠️' : '❌'} {w.rating.toUpperCase()}
                    </p>
                </div>
                {/* Score bar */}
                <div className="w-14 text-right">
                    <div className={`text-lg font-black ${style.text}`}>{w.score}</div>
                    <div className="w-full h-1.5 bg-white/10 rounded-full overflow-hidden">
                        <div
                            className={`h-full ${style.dot} rounded-full transition-all`}
                            style={{ width: `${w.score}%` }}
                        />
                    </div>
                </div>
            </div>

            {/* Details */}
            <div className="grid grid-cols-3 gap-2 text-center mb-2">
                <div>
                    <p className="text-[11px] text-gray-500 uppercase font-bold">Wind</p>
                    <p className="text-xs font-bold text-white">
                        {w.summary.dominantWindDir} {w.summary.avgWindKts}–{w.summary.maxWindKts}kt
                    </p>
                </div>
                <div>
                    <p className="text-[11px] text-gray-500 uppercase font-bold">Wave</p>
                    <p className="text-xs font-bold text-white">
                        {w.summary.avgWaveM}–{w.summary.maxWaveM}m
                    </p>
                </div>
                <div>
                    <p className="text-[11px] text-gray-500 uppercase font-bold">Rain</p>
                    <p className="text-xs font-bold text-white">{w.summary.rainProbability}%</p>
                </div>
            </div>

            {/* Accept button */}
            {!isAccepted ? (
                <button
                    onClick={() => onAccept(index)}
                    disabled={!canAccept}
                    className={`w-full py-2 rounded-lg text-[11px] font-bold transition-all active:scale-[0.98] ${
                        w.rating === 'go'
                            ? 'bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30 border border-emerald-500/20'
                            : w.rating === 'marginal'
                              ? 'bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 border border-amber-500/15'
                              : 'bg-red-500/10 text-red-300 hover:bg-red-500/20 border border-red-500/15'
                    } disabled:opacity-40 disabled:cursor-not-allowed`}
                >
                    {canAccept ? 'Accept This Window' : disabledLabel}
                </button>
            ) : (
                <div className="text-center text-[11px] font-bold text-emerald-400 py-1">✅ Accepted</div>
            )}
        </div>
    );
};
