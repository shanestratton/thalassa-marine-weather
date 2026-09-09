import React, {
    createContext,
    useContext,
    useState,
    useEffect,
    useCallback,
    useRef,
    useSyncExternalStore,
} from 'react';
import { MarineWeatherReport, VoyagePlan } from '../types';
import { useSettings } from './SettingsContext';
import { toast } from '../components/Toast';
import { GpsService } from '../services/GpsService';
import { LocationStore } from '../stores/LocationStore';
import { reverseGeocode } from '../services/weatherService';
import {
    saveLargeData,
    saveLargeDataImmediate,
    deleteLargeData,
    loadLargeData,
    VOYAGE_CACHE_KEY,
} from '../services/nativeStorage';
import { getUpdateInterval, alignToNextInterval, LIVE_OVERLAY_INTERVAL } from '../services/WeatherScheduler';
import {
    WeatherOrchestrator,
    STALE_THRESHOLD_MS,
    loadWeatherCacheSyncForScope,
    weatherCacheKeysForScope,
    type OrchestratorCallbacks,
} from '../services/WeatherOrchestrator';
import {
    findWeatherHistoryReport,
    weatherCoordinatesNearby,
    weatherReportMatchesRequest,
} from '../services/weather/cache';

import { createLogger } from '../utils/createLogger';
import {
    decideFollowAction,
    haversineNM,
    tideNeedsRefresh,
    GPS_FOLLOW_POLL_MS,
    NAME_UPDATE_NM,
    coordinateLocationName,
} from '../utils/gpsFollow';
import { fetchTidesForPosition } from '../services/weather/api/tides';
import {
    resolveWeatherPosition,
    getWeatherFollowTarget,
    WEATHER_FOLLOW_TARGET_EVENT,
    weatherFixStatus,
    describeWeatherFix,
    setHeldChoice,
    setWeatherFollowTarget,
    type HeldChoice,
    type WeatherFix,
    type WeatherFixKind,
    type WeatherFollowTarget,
    type WeatherPositionResolution,
} from '../services/weatherPosition';
import type { BoatFixRung } from '../services/boatPositionChain';
import { useWeatherStore } from '../stores/weatherStore';
import { useUIStore } from '../stores/uiStore';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from '../services/authIdentityScope';

const log = createLogger('WeatherContext');

// ── Context Type (unchanged — zero consumer impact) ──────────

/** Which receiver the weather is for while following — see services/weatherPosition. */
export interface WeatherPositionSource {
    kind: WeatherFixKind | null;
    timestamp: number;
    target?: WeatherFollowTarget;
    status?: 'live' | 'last-known' | 'unavailable';
    /** GPS is unavailable; the displayed forecast still belongs to this last verified selection. */
    retainedWeather?: boolean;
    rung?: BoatFixRung;
    source?: string | null;
}

/** The boat-or-phone question while her last fix is held. */
export interface WeatherPositionChoicePrompt {
    held: WeatherFix;
    phone: WeatherFix | null;
}

export interface WeatherPositionChoice {
    prompt: WeatherPositionChoicePrompt | null;
    answer: (choice: HeldChoice) => void;
    /** Re-open the question from the status line while a hold is in force. */
    open: () => void;
}

interface WeatherContextType {
    weatherData: MarineWeatherReport | null;
    voyagePlan: VoyagePlan | null;
    loading: boolean;
    loadingMessage: string;
    error: string | null;
    debugInfo: import('../types').DebugInfo | null;
    quotaUsed: number;
    backgroundUpdating: boolean;
    staleRefresh: boolean;
    nextUpdate: number | null;
    fetchWeather: (
        location: string,
        force?: boolean,
        coords?: { lat: number; lon: number },
        showOverlay?: boolean,
        silent?: boolean,
    ) => Promise<void>;
    selectLocation: (
        location: string,
        coords?: { lat: number; lon: number },
        options?: { requestPhonePermission?: boolean; onlyIfUnselected?: boolean },
    ) => Promise<void>;
    refreshData: (silent?: boolean) => void;
    saveVoyagePlan: (plan: VoyagePlan) => void;
    handleSaveVoyagePlan: (plan: VoyagePlan) => void;
    clearVoyagePlan: () => void;
    incrementQuota: () => void;
    /** Which receiver the weather is for while following: the boat, her held last fix, or the phone. */
    positionSource: WeatherPositionSource | null;
    positionChoice: WeatherPositionChoice;
    historyCache: Record<string, MarineWeatherReport>;
    setHistoryCache: React.Dispatch<React.SetStateAction<Record<string, MarineWeatherReport>>>;
}

const WeatherContext = createContext<WeatherContextType | undefined>(undefined);

/**
 * Is the report currently on screen for a DIFFERENT place than the one just
 * selected? If so the Glass must swap to a placeholder for the new name
 * immediately rather than leave the previous location's report sitting there.
 *
 * App.tsx builds the header as `weatherData.locationName`, preferring it over
 * the name the user tapped — so without this the title keeps showing the old
 * place for the whole fetch. That was the 4-5 s of apparent dead air.
 *
 * Case-insensitive because the same place can arrive differently cased from a
 * favourite, a geocode and a cache key.
 */
export function isShowingAnotherPlace(currentName: string | undefined | null, nextName: string): boolean {
    if (!currentName) return false; // nothing on screen to contradict
    return currentName.trim().toLowerCase() !== nextName.trim().toLowerCase();
}

/**
 * What a location selection must persist — the NAME AND COORDS as a pair,
 * or null when nothing changed.
 *
 * Persisting only the name (the old behaviour) left defaultLocationCoords
 * frozen at the onboarding home port, so every boot after a pick re-fetched
 * the new name against the OLD coordinates (triggerInitialFetch prefers
 * saved coords over re-geocoding the name) — any crash or plain iOS
 * eviction while viewing a picked location "came back to Newport".
 *
 * Rules this encodes:
 * - coords provided → persist both, so a reboot lands where the user picked.
 * - no coords (name-only search/favourite) → CLEAR the saved coords; boot
 *   must resolve the name rather than trust coords for a different place.
 * - same name, different coords → still write: two map picks can
 *   reverse-geocode to the same suburb.
 */
export function locationPersistPatch(
    prev: { defaultLocation?: string; defaultLocationCoords?: { lat: number; lon: number } },
    location: string,
    coords?: { lat: number; lon: number },
): { defaultLocation: string; defaultLocationCoords: { lat: number; lon: number } | undefined } | null {
    if (!location) return null;
    const coordsChanged =
        !!coords && (prev.defaultLocationCoords?.lat !== coords.lat || prev.defaultLocationCoords?.lon !== coords.lon);
    if (location === prev.defaultLocation && !coordsChanged) return null;
    return { defaultLocation: location, defaultLocationCoords: coords };
}

// ── Provider (thin React wrapper around WeatherOrchestrator) ─

function subscribeIdentitySnapshot(onStoreChange: () => void): () => void {
    return subscribeAuthIdentityScope(() => onStoreChange());
}

export const WeatherProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const identityScope = useSyncExternalStore(subscribeIdentitySnapshot, getAuthIdentityScope, getAuthIdentityScope);

    // A generation change deliberately remounts every hook/effect below.
    // The auth scope itself changes synchronously first, so old promises are
    // fenced even before React reaches their cleanup functions.
    return (
        <ScopedWeatherProvider key={`${identityScope.key}:${identityScope.generation}`} identityScope={identityScope}>
            {children}
        </ScopedWeatherProvider>
    );
};

const ScopedWeatherProvider: React.FC<{ children: React.ReactNode; identityScope: AuthIdentityScope }> = ({
    children,
    identityScope,
}) => {
    const { settings, updateSettings, loading: settingsLoading } = useSettings();
    // One reactive subscription drives timer lifecycle. Async callbacks still
    // read getState() so a probe transition is observed even before React has
    // committed the corresponding render.
    const isOffline = useUIStore((state) => state.isOffline);
    const cacheKeys = React.useMemo(() => weatherCacheKeysForScope(identityScope), [identityScope]);
    const isCurrentScope = useCallback(() => isAuthIdentityScopeCurrent(identityScope), [identityScope]);

    // Synchronous cache pre-read at initial render. Running this as the
    // useState initializer (instead of inside a useEffect) means the
    // very first paint already has the cached weather on screen — no
    // "Initializing Weather Data…" flash. Only flips loading=true if
    // there's literally nothing to show yet.
    const initialWeather = React.useMemo(() => {
        try {
            return loadWeatherCacheSyncForScope(identityScope);
        } catch {
            return null;
        }
    }, [identityScope]);

    // ── React State ─────────────────────────────────────────
    const [loading, setLoading] = useState(initialWeather === null);
    const [loadingMessage, setLoadingMessage] = useState('Initializing Weather Data...');
    const [backgroundUpdating, setBackgroundUpdating] = useState(false);
    const [staleRefresh, setStaleRefresh] = useState(false);
    // Initial mode derived from settings — only 'Current Location' opts into
    // GPS tracking. An empty first run waits for a location choice; publishing
    // a missing phone fix there would hide the welcome actions behind an error.
    // A named location stays locked to that port. Was
    // hardcoded 'gps' previously, which meant that on cold boot for
    // returning users with a saved port (e.g. 'Newport, QLD'), the
    // 30-second auto-refresh would fire fetchWeather('Current
    // Location', …) within half a minute and overwrite
    // weatherData.locationName, so the location box reverted to
    // 'Current Location' or worse. A sync useEffect below keeps it
    // consistent if defaultLocation is restored after this init runs.
    const [locationMode, setLocationMode] = useState<'gps' | 'selected'>(
        settings.defaultLocation === 'Current Location' ? 'gps' : 'selected',
    );
    const [error, setError] = useState<string | null>(null);
    const [debugInfo] = useState<import('../types').DebugInfo | null>(null);
    const [quotaUsed, setQuotaUsed] = useState(0);
    const [nextUpdate, setNextUpdate] = useState<number | null>(null);
    const [versionChecked, setVersionChecked] = useState(false);
    const [weatherData, _setWeatherData] = useState<MarineWeatherReport | null>(initialWeather);
    const [voyagePlan, setVoyagePlan] = useState<VoyagePlan | null>(null);
    const [historyCache, setHistoryCache] = useState<Record<string, MarineWeatherReport>>({});

    // ── Where the weather is for: boat → her held last fix → phone ──
    const [positionSource, setPositionSource] = useState<WeatherPositionSource | null>(null);
    const positionSourceRef = useRef<WeatherPositionSource | null>(null);
    const [positionPrompt, setPositionPrompt] = useState<WeatherPositionChoicePrompt | null>(null);
    const lastHeldRef = useRef<WeatherFix | null>(null);
    const lastPhoneRef = useRef<WeatherFix | null>(null);
    const followTickRef = useRef<(() => void) | null>(null);
    // Publish only on a change of receiver (or of the held fix itself): a live
    // fix arrives every tick, and re-rendering every consumer of this context
    // every 5 s for an unchanged label would be a cost with no return.
    const publishPositionSource = useCallback(
        (fix: WeatherFix | null, target?: WeatherFollowTarget, retainedWeather = false) => {
            const next: WeatherPositionSource | null = fix
                ? {
                      kind: fix.kind,
                      timestamp: fix.timestamp,
                      rung: fix.rung,
                      source: fix.source ?? null,
                      target,
                      status: retainedWeather ? 'unavailable' : weatherFixStatus(fix),
                      ...(retainedWeather ? { retainedWeather: true } : {}),
                  }
                : target
                  ? { kind: null, timestamp: 0, target, status: 'unavailable' }
                  : null;
            const prev = positionSourceRef.current;
            const same =
                (prev === null && next === null) ||
                (prev !== null &&
                    next !== null &&
                    prev.kind === next.kind &&
                    prev.target === next.target &&
                    prev.status === next.status &&
                    prev.retainedWeather === next.retainedWeather &&
                    prev.rung === next.rung &&
                    (prev.source ?? null) === (next.source ?? null) &&
                    ((next.status !== 'last-known' && !next.retainedWeather) || prev.timestamp === next.timestamp));
            if (same) return;
            positionSourceRef.current = next;
            setPositionSource(next);
        },
        [],
    );

    // ── Refs ─────────────────────────────────────────────────
    const historyCacheRef = useRef<Record<string, MarineWeatherReport>>({});
    const weatherDataRef = useRef<MarineWeatherReport | null>(initialWeather);
    const settingsRef = useRef(settings);
    const isTrackingCurrentLocation = useRef(settings.defaultLocation === 'Current Location');
    const isFetchingRef = useRef(false);
    const nextUpdateRef = useRef<number | null>(null);
    const locationModeRef = useRef(locationMode);
    const pendingDisposeRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const previousOfflineRef = useRef(isOffline);
    const selectionEpochRef = useRef(0);
    const selectionResolvingRef = useRef(false);
    const followRefreshInFlightRef = useRef<symbol | null>(null);
    const followTargetRef = useRef(getWeatherFollowTarget());
    const lastFollowFixRef = useRef<{ fix: WeatherFix; target: WeatherFollowTarget; epoch: number } | null>(null);
    // A forecast can adopt new coordinates without resolving their suburb.
    // Only an actual naming attempt advances this separate baseline.
    const namePointRef = useRef<{ lat: number; lon: number } | null>(null);
    const nameResolvedRef = useRef(false);
    const nameRetryAtRef = useRef(0);
    const tideRequestRef = useRef<{ point: { lat: number; lon: number }; token: symbol } | null>(null);
    const restoreLocationRef = useRef<((location: string, coords?: { lat: number; lon: number }) => void) | null>(null);

    // A missed receiver read does not invalidate a forecast already obtained
    // for that same selection. Keep its actual place and dates, but explicitly
    // mark GPS unavailable. Never reuse an unproven startup cache, another
    // receiver's report, or weather for a newly known different position.
    const setWeatherError = useCallback(
        (message: string | null) => {
            if (!isCurrentScope()) return;
            const target = getWeatherFollowTarget();
            const previous = lastFollowFixRef.current;
            const report = weatherDataRef.current;
            if (
                message?.startsWith(`${target === 'phone' ? 'Phone' : 'Boat'} GPS unavailable`) &&
                locationModeRef.current === 'gps' &&
                previous?.target === target &&
                previous.epoch === selectionEpochRef.current &&
                report?.generatedAt &&
                (report as MarineWeatherReport & { loading?: boolean }).loading !== true &&
                Number.isFinite(Date.parse(report.generatedAt)) &&
                // The normal follower intentionally leaves the displayed point
                // unchanged inside its name-update radius. Ordinary GPS jitter
                // there must not turn the next missed read into a page failure.
                weatherCoordinatesNearby(
                    report.coordinates,
                    {
                        lat: previous.fix.lat,
                        lon: previous.fix.lon,
                    },
                    NAME_UPDATE_NM * 1.852,
                )
            ) {
                publishPositionSource(previous.fix, target, true);
                setStaleRefresh(false);
                setError(null);
                return;
            }
            setError(message);
        },
        [isCurrentScope, publishPositionSource],
    );

    // Wrapper: every weather update also feeds the environment detection service
    const setWeatherData = useCallback(
        (data: MarineWeatherReport | null) => {
            if (!isCurrentScope()) return;
            weatherDataRef.current = data;
            _setWeatherData(data);
            if (data) WeatherOrchestrator.updateEnvironment(data);
        },
        [isCurrentScope],
    );

    const setHistoryCacheForScope = useCallback<
        React.Dispatch<React.SetStateAction<Record<string, MarineWeatherReport>>>
    >(
        (updater) => {
            if (!isCurrentScope()) return;
            setHistoryCache((previous) => {
                if (!isCurrentScope()) return previous;
                const next = typeof updater === 'function' ? updater(previous) : updater;
                historyCacheRef.current = next;
                return next;
            });
        },
        [isCurrentScope],
    );

    const setNextUpdateForScope = useCallback(
        (value: number | null) => {
            if (!isCurrentScope()) return;
            nextUpdateRef.current = value;
            setNextUpdate(value);
        },
        [isCurrentScope],
    );

    // Keep locationMode in sync with settings.defaultLocation. The
    // useState init above handles the cold-boot case where settings
    // load before WeatherContext mounts; this effect handles the
    // async path where settings load AFTER mount (cloud-pull, user
    // edits Settings, etc). Without this, the periodic auto-refresh
    // can fire fetchWeather('Current Location', …) for users who
    // actually have a saved port, clobbering their location name.
    useEffect(() => {
        if (!isCurrentScope()) return;
        if (!settings.defaultLocation) return;
        const expected: 'gps' | 'selected' = settings.defaultLocation === 'Current Location' ? 'gps' : 'selected';
        if (locationMode !== expected) {
            setLocationMode(expected);
            isTrackingCurrentLocation.current = expected === 'gps';
        }
    }, [isCurrentScope, locationMode, settings.defaultLocation]);

    // Sync Refs
    useEffect(() => {
        weatherDataRef.current = weatherData;
    }, [weatherData]);
    useEffect(() => {
        settingsRef.current = settings;
    }, [settings]);
    useEffect(() => {
        historyCacheRef.current = historyCache;
    }, [historyCache]);
    useEffect(() => {
        nextUpdateRef.current = nextUpdate;
    }, [nextUpdate]);
    useEffect(() => {
        locationModeRef.current = locationMode;
    }, [locationMode]);

    const incrementQuota = useCallback(() => {
        if (isCurrentScope()) setQuotaUsed((p) => p + 1);
    }, [isCurrentScope]);

    // ── Orchestrator Instance ───────────────────────────────
    const [orchestrator] = useState(() => {
        const callbacks: OrchestratorCallbacks = {
            setWeatherData,
            setLoading,
            setLoadingMessage,
            setBackgroundUpdating,
            setStaleRefresh,
            setError: setWeatherError,
            setNextUpdate: setNextUpdateForScope,
            setHistoryCache: setHistoryCacheForScope,
            setVersionChecked,
            incrementQuota,
            getWeatherData: () => weatherDataRef.current,
            getSettings: () => settingsRef.current,
            getHistoryCache: () => historyCacheRef.current,
            getLocationMode: () => locationModeRef.current,
            getIsOffline: () => useUIStore.getState().isOffline,
            getIsFetching: () => isFetchingRef.current,
            setIsFetching: (v) => {
                isFetchingRef.current = v;
            },
        };
        return new WeatherOrchestrator(callbacks, identityScope);
    });

    useEffect(() => {
        // React StrictMode deliberately runs effect setup → cleanup → setup
        // once in development. The orchestrator is state-held so that replay
        // refers to the same instance; disposing it synchronously during the
        // rehearsal permanently fenced its cache-version check and left the
        // app behind the initial loading overlay. Deferring cleanup one task
        // lets the replay cancel it, while a genuine unmount still disposes
        // the instance immediately after the current task completes.
        if (pendingDisposeRef.current !== null) {
            clearTimeout(pendingDisposeRef.current);
            pendingDisposeRef.current = null;
        }

        return () => {
            const disposeTimer = setTimeout(() => {
                if (pendingDisposeRef.current !== disposeTimer) return;
                pendingDisposeRef.current = null;
                orchestrator.dispose();
            }, 0);
            pendingDisposeRef.current = disposeTimer;
        };
    }, [orchestrator]);

    // ── INSTANT DISPLAY: Synchronous pre-read from localStorage ─
    useEffect(() => {
        if (!isCurrentScope()) return;
        const syncCached = orchestrator.loadInstantCache();
        if (syncCached) {
            setWeatherData(syncCached);
            setLoading(false);
            // Sync to LocationStore for Map tab
            const coords = syncCached.coordinates;
            if (coords && (coords.lat !== 0 || coords.lon !== 0)) {
                const locState = LocationStore.getState();
                if (locState.source === 'initial') {
                    LocationStore.setState({
                        lat: coords.lat,
                        lon: coords.lon,
                        name: syncCached.locationName,
                        source: 'search',
                    });
                }
            }
        }
    }, [isCurrentScope, orchestrator, setWeatherData]);

    // ── CACHE VERSION CHECK ─────────────────────────────────
    useEffect(() => {
        // One line per mount: a second appearance during one boot means the
        // provider remounted (identity key/generation change) and every
        // in-flight init was thrown away — exactly the failure mode that is
        // otherwise invisible in a device console.
        log.warn(
            `[perf] weather provider up scope=${identityScope.userId ? 'user' : 'anonymous'} gen=${identityScope.generation}`,
        );
        void orchestrator.checkCacheVersion();
    }, [identityScope, orchestrator]);

    // ── INITIALIZATION ──────────────────────────────────────
    useEffect(() => {
        log.warn(`[perf] init gate: settingsLoading=${settingsLoading} versionChecked=${versionChecked}`);
        if (!versionChecked) return;
        // Paint cached weather NOW. The settings store is only needed to
        // decide what to FETCH; making the cached paint wait for it queued
        // first paint behind a Supabase round-trip on cold start.
        void orchestrator.loadCache();
        if (settingsLoading) return;
        log.info('[WeatherContext] Init starting (settingsLoading=false, versionChecked=true)');
        void orchestrator.loadCacheAndInit();
    }, [identityScope, orchestrator, settingsLoading, versionChecked]);

    // ── CLOUD-RESTORE TRIGGER ───────────────────────────────
    // settingsStore.pullFromCloud dispatches this event after it
    // merges cloud settings into the local store on first sign-in.
    // The init useEffect above may have already fired with an
    // empty defaultLocation (the orchestrator then setLoading(false)
    // and returned without fetching). This listener picks up the
    // restored location and kicks off the weather fetch the user
    // expects — without it, the Glass page stayed on its initial
    // loading state until the next cold boot. Boot-time race.
    useEffect(() => {
        const handler = (e: Event) => {
            if (!isCurrentScope()) return;
            const detail = (
                e as CustomEvent<{
                    defaultLocation?: string;
                    defaultLocationCoords?: { lat: number; lon: number };
                }>
            ).detail;
            const loc = detail?.defaultLocation;
            log.warn(
                `[WeatherContext] settings-restored event received: loc=${loc ?? 'undefined'}, hasData=${!!weatherDataRef.current}`,
            );
            if (!loc) return;
            // A delayed account restore is not newer user intent. In particular,
            // selection deliberately clears old weather while awaiting GPS.
            if (selectionEpochRef.current !== 0) return;
            if (weatherDataRef.current) return; // already have data, nothing to do
            log.warn(`[WeatherContext] dispatching fetchWeather for ${loc}`);
            restoreLocationRef.current?.(loc, loc === 'Current Location' ? undefined : detail?.defaultLocationCoords);
        };
        window.addEventListener('thalassa:settings-restored', handler);
        return () => window.removeEventListener('thalassa:settings-restored', handler);
    }, [isCurrentScope, orchestrator]);

    // ── PERSISTENCE ─────────────────────────────────────────
    useEffect(() => {
        if (versionChecked && weatherData && isCurrentScope()) {
            void saveLargeDataImmediate(cacheKeys.data, weatherData);
        }
    }, [cacheKeys.data, isCurrentScope, versionChecked, weatherData]);

    useEffect(() => {
        if (versionChecked && Object.keys(historyCache).length > 0 && isCurrentScope()) {
            void saveLargeData(cacheKeys.history, historyCache);
        }
    }, [cacheKeys.history, historyCache, isCurrentScope, versionChecked]);

    // ── Voyage Plan ─────────────────────────────────────────
    useEffect(() => {
        if (!versionChecked || !isCurrentScope()) return;
        let cancelled = false;
        const loadVoyage = async () => {
            let cached = (await loadLargeData(cacheKeys.voyage)) as VoyagePlan | null;
            if (cancelled || !isCurrentScope()) return;
            if (!cached && identityScope.userId === null) {
                // Unscoped legacy voyage data has no authenticated owner.
                // Only the public anonymous namespace may adopt it.
                cached = (await loadLargeData(VOYAGE_CACHE_KEY)) as VoyagePlan | null;
                if (cancelled || !isCurrentScope()) return;
                if (cached) await saveLargeDataImmediate(cacheKeys.voyage, cached);
            }
            if (!cancelled && isCurrentScope() && cached) setVoyagePlan(cached);
        };
        void loadVoyage();
        return () => {
            cancelled = true;
        };
    }, [cacheKeys.voyage, identityScope.userId, isCurrentScope, versionChecked]);

    const handleSaveVoyagePlan = useCallback(
        (plan: VoyagePlan) => {
            if (!isCurrentScope()) return;
            setVoyagePlan(plan);
            void saveLargeDataImmediate(cacheKeys.voyage, plan);
        },
        [cacheKeys.voyage, isCurrentScope],
    );

    const clearVoyagePlan = useCallback(() => {
        if (!isCurrentScope()) return;
        setVoyagePlan(null);
        void deleteLargeData(cacheKeys.voyage);
    }, [cacheKeys.voyage, isCurrentScope]);

    // ── FETCH WEATHER (delegates to orchestrator) ───────────
    const fetchWeather = useCallback(
        async (
            location: string,
            force = false,
            coords?: { lat: number; lon: number },
            showOverlay = false,
            silent = false,
        ) => {
            if (!isCurrentScope()) return;
            await orchestrator.fetchWeather(location, { force, coords, showOverlay, silent });
        },
        [isCurrentScope, orchestrator],
    );

    const readFollowPosition = useCallback(
        (target: WeatherFollowTarget, requestPhonePermission = false) =>
            resolveWeatherPosition(
                async () => {
                    const position = requestPhonePermission
                        ? await GpsService.requestCurrentForegroundPosition({ staleLimitMs: 10_000 })
                        : await GpsService.getCurrentPositionIfGranted({ staleLimitMs: 10_000 });
                    return position
                        ? { lat: position.latitude, lon: position.longitude, timestamp: position.timestamp }
                        : null;
                },
                { target },
            ).catch((): WeatherPositionResolution => ({ fix: null, held: null, phone: null, ask: false })),
        [],
    );

    const resolveFollowFix = useCallback(
        async (requestPhonePermission = false) => {
            const epoch = selectionEpochRef.current;
            const target = getWeatherFollowTarget();
            const resolution = await readFollowPosition(target, requestPhonePermission);
            if (
                !isCurrentScope() ||
                selectionEpochRef.current !== epoch ||
                locationModeRef.current !== 'gps' ||
                getWeatherFollowTarget() !== target
            )
                return null;
            if (resolution.fix) lastFollowFixRef.current = { fix: resolution.fix, target, epoch };
            publishPositionSource(resolution.fix, target);
            lastHeldRef.current = resolution.held;
            lastPhoneRef.current = resolution.phone;
            setWeatherError(resolution.fix ? null : describeWeatherFix(null, Date.now(), target));
            return resolution.fix;
        },
        [isCurrentScope, publishPositionSource, readFollowPosition, setWeatherError],
    );

    const refreshFollowWeather = useCallback(
        async (silent = true) => {
            if (selectionResolvingRef.current || followRefreshInFlightRef.current) return;
            const request = Symbol('weather-follow-refresh');
            followRefreshInFlightRef.current = request;
            const epoch = selectionEpochRef.current;
            const target = getWeatherFollowTarget();
            try {
                const fix = await resolveFollowFix();
                if (
                    !fix ||
                    !isCurrentScope() ||
                    epoch !== selectionEpochRef.current ||
                    target !== getWeatherFollowTarget() ||
                    useUIStore.getState().isOffline
                ) {
                    if (epoch === selectionEpochRef.current) setStaleRefresh(false);
                    return;
                }
                await fetchWeather('Current Location', true, { lat: fix.lat, lon: fix.lon }, false, silent);
            } finally {
                if (followRefreshInFlightRef.current === request) followRefreshInFlightRef.current = null;
            }
        },
        [fetchWeather, isCurrentScope, resolveFollowFix],
    );

    // A receiver switch can keep the same "Current Location" setting, so an
    // effect keyed only by that setting cannot cancel its older promises.
    useEffect(() => {
        const changed = () => {
            const target = getWeatherFollowTarget();
            if (!isCurrentScope() || target === followTargetRef.current) return;
            followTargetRef.current = target;
            lastFollowFixRef.current = null;
            selectionEpochRef.current += 1;
            selectionResolvingRef.current = false;
            followRefreshInFlightRef.current = null;
            namePointRef.current = null;
            nameResolvedRef.current = false;
            nameRetryAtRef.current = 0;
            tideRequestRef.current = null;
            orchestrator.cancelPendingLocation();
            if (locationModeRef.current === 'gps') {
                setWeatherData(null);
                publishPositionSource(null, target);
                setError(describeWeatherFix(null, Date.now(), target));
            }
        };
        window.addEventListener(WEATHER_FOLLOW_TARGET_EVENT, changed);
        return () => window.removeEventListener(WEATHER_FOLLOW_TARGET_EVENT, changed);
    }, [isCurrentScope, orchestrator, publishPositionSource, setWeatherData]);

    // ── REFRESH / SELECT ────────────────────────────────────
    const refreshData = useCallback(
        (silent = false) => {
            if (!isCurrentScope()) return;
            const data = weatherDataRef.current;
            const loc = data?.locationName || settingsRef.current.defaultLocation || '';
            if (useUIStore.getState().isOffline) {
                if (!silent) toast.info('Offline — showing cached data');
                return;
            }
            if (locationModeRef.current === 'gps') {
                void refreshFollowWeather(silent);
                return;
            }
            void fetchWeather(loc, true, data?.coordinates, false, silent);
        },
        [fetchWeather, isCurrentScope, refreshFollowWeather],
    );

    const selectLocation = useCallback(
        async (
            location: string,
            coords?: { lat: number; lon: number },
            options?: { requestPhonePermission?: boolean; onlyIfUnselected?: boolean },
        ) => {
            if (!isCurrentScope()) return;
            if (options?.onlyIfUnselected && selectionEpochRef.current !== 0) return;
            const target = getWeatherFollowTarget();
            let bootResolution: WeatherPositionResolution | null = null;
            if (options?.onlyIfUnselected && location === 'Current Location') {
                if (useUIStore.getState().isOffline) return;
                // Open at the receiver when a passive fix is available. Until
                // then retain the saved port (or the first-run empty state),
                // without selecting GPS, clearing its report, or raising an
                // unavailable error. Explicit GPS choices still do all three.
                const bootEpoch = selectionEpochRef.current;
                try {
                    bootResolution = await readFollowPosition(target);
                } catch {
                    return;
                }
                if (
                    !bootResolution.fix ||
                    !isCurrentScope() ||
                    useUIStore.getState().isOffline ||
                    selectionEpochRef.current !== bootEpoch ||
                    target !== getWeatherFollowTarget()
                )
                    return;
            }
            const epoch = ++selectionEpochRef.current;
            lastFollowFixRef.current = null;
            selectionResolvingRef.current = false;
            followRefreshInFlightRef.current = null;
            orchestrator.cancelPendingLocation();
            namePointRef.current = null;
            nameResolvedRef.current = false;
            nameRetryAtRef.current = 0;
            tideRequestRef.current = null;
            const isCurrent = location === 'Current Location';
            setLocationMode(isCurrent ? 'gps' : 'selected');
            locationModeRef.current = isCurrent ? 'gps' : 'selected';
            isTrackingCurrentLocation.current = isCurrent;

            // Do not persist receiver coordinates as a generic location fallback.
            const persistPatch = locationPersistPatch(settingsRef.current, location, isCurrent ? undefined : coords);
            if (persistPatch) updateSettings(persistPatch);
            if (isCurrent) {
                selectionResolvingRef.current = true;
                publishPositionSource(null, target);
                setWeatherData(null);
                setBackgroundUpdating(true);
                const fix = bootResolution
                    ? bootResolution.fix
                    : await resolveFollowFix(options?.requestPhonePermission === true);
                if (!isCurrentScope() || selectionEpochRef.current !== epoch || target !== getWeatherFollowTarget())
                    return;
                selectionResolvingRef.current = false;
                if (!fix) {
                    setLoading(false);
                    setStaleRefresh(false);
                    setBackgroundUpdating(false);
                    return;
                }
                if (bootResolution) {
                    lastFollowFixRef.current = { fix, target, epoch };
                    publishPositionSource(fix, target);
                    lastHeldRef.current = bootResolution.held;
                    lastPhoneRef.current = bootResolution.phone;
                    setError(null);
                }
                coords = { lat: fix.lat, lon: fix.lon };
            } else {
                publishPositionSource(null);
                setError(null);
            }

            // Smooth transition strategy
            const cache = historyCacheRef.current;
            const cached = isCurrent ? null : findWeatherHistoryReport(cache, location, coords);
            const isCacheValid =
                cached && cached?.coordinates && (cached.coordinates.lat !== 0 || cached.coordinates.lon !== 0);

            // Does what's on screen belong to somewhere ELSE? App.tsx builds
            // the Glass title as `weatherData.locationName`, preferring it
            // over the name the user just tapped — so until the new report
            // lands the header keeps showing the PREVIOUS place. That is the
            // 4-5 s of "nothing happened" that has punters mashing buttons
            // (Shane 2026-07-22), and it is not the network: the sources now
            // return in 0.4-2.7 s.
            const showingAnotherPlace =
                isShowingAnotherPlace(weatherDataRef.current?.locationName, location) ||
                (!!coords &&
                    !!weatherDataRef.current &&
                    !weatherReportMatchesRequest(weatherDataRef.current, location, coords));

            const ageOf = (iso?: string) => (iso ? Date.now() - new Date(iso).getTime() : Infinity);

            // ── FRESH CACHE? THEN DON'T FETCH AT ALL ────────────────────
            // Shane 2026-07-22: "if the data is fresh, it does not need to be
            // re-freshed, we have a rule somewhere". The rule is
            // STALE_THRESHOLD_MS (30 min) and the orchestrator ALREADY honours
            // it on boot — "Cache fresh (Nm old) — skipping fetch". Picking a
            // location did not, because selectLocation forces every fetch, so
            // reopening a port you looked at two minutes ago cost a full round
            // of sources for numbers that could not have changed.
            //
            // Returns BEFORE the blur decision on purpose. Raising the blur and
            // then skipping the fetch would leave it up until the 25 s
            // watchdog: the orchestrator's `finally` is what lowers it, and
            // there is no orchestrator call on this path.
            //
            // force is untouched on the OTHER branches — a stale cache still
            // forces, because that guard exists so a concurrent background
            // fetch cannot swallow an explicit tap.
            if (isCacheValid && ageOf(cached?.generatedAt) < STALE_THRESHOLD_MS) {
                log.info(
                    `[WeatherContext] ${location}: cache ${Math.round(ageOf(cached?.generatedAt) / 60000)}m old — fresh, no fetch`,
                );
                setWeatherData(cached);
                setStaleRefresh(false);
                setBackgroundUpdating(false);
                return;
            }

            // ── BLUR DECISION ───────────────────────────────────────────
            // Ask what will be ON SCREEN WHILE THE FETCH RUNS, not merely
            // what was there before it started. Those differ, and the gap
            // was the bug (Shane 2026-07-22: a new location and a stale
            // saved one both updated with no blur, and the stale one kept
            // its toast).
            //
            // Two things were wrong:
            //
            // 1. It measured `weatherDataRef.current` — the OUTGOING report.
            //    Selecting a saved location immediately swaps in that
            //    location's CACHED report (just below), which can be far
            //    older than what it replaced. A fresh screen plus a stale
            //    cache scored "no blur-sm" and then displayed stale numbers.
            //
            // 2. The threshold was 2 h while the old freshness strip warned from
            //    60 min (coastal). Everything in between showed the toast
            //    with no blur to explain it — exactly the state reported.
            //    One constant now drives both, so they cannot disagree.
            const BLUR_THRESHOLD_MS = 60 * 60 * 1000;
            const onScreenAge = isCacheValid
                ? ageOf(cached?.generatedAt) // the cache we are about to show
                : showingAnotherPlace
                  ? Infinity // stub/skeleton — no reading for this place yet
                  : ageOf(weatherDataRef.current?.generatedAt);

            // Switching place ALWAYS blurs, however fresh the cache: those
            // numbers describe somewhere else until the new report lands.
            const needsBlur = showingAnotherPlace || onScreenAge >= BLUR_THRESHOLD_MS;

            // Guard stays: with nothing on screen there is nothing to blur,
            // and cold boot has its own full-screen loader.
            if (needsBlur && weatherDataRef.current) setStaleRefresh(true);

            if (isCacheValid) {
                setWeatherData(cached);
            } else if (!weatherDataRef.current || showingAnotherPlace) {
                // Cold start stub — ALSO used when switching location with no
                // cached report. Swapping in a stub blanks the readings for a
                // beat, which is the honest trade: the alternative is the
                // PREVIOUS location's wind and tide sitting under the new
                // name, which on a marine app is worse than a brief skeleton.
                const optimisticData = {
                    locationName: location,
                    coordinates: coords || { lat: 0, lon: 0 },
                    locationType: 'coastal' as const,
                    timeZone: 'UTC',
                    generatedAt: new Date().toISOString(),
                    isEstimated: true,
                    alerts: [],
                    loading: true,
                    current: {
                        windSpeed: null,
                        windGust: null,
                        windDirection: '---',
                        waveHeight: null,
                        swellPeriod: null,
                        airTemperature: null,
                        waterTemperature: null,
                        condition: 'Loading...',
                        uvIndex: 0,
                        visibility: null,
                        humidity: null,
                        pressure: null,
                        cloudCover: null,
                        precipitation: null,
                        description: 'Loading marine data...',
                        feelsLike: null,
                        dewPoint: null,
                    },
                    forecast: [],
                    hourly: [],
                    tides: [],
                    tideHourly: [],
                    boatingAdvice: 'Generating advice...',
                    modelUsed: 'Loading...',
                } as unknown as MarineWeatherReport;
                setWeatherData(optimisticData);
            }

            setBackgroundUpdating(true);
            // force=TRUE. selectLocation is only ever reached from explicit
            // user intent — a map pick, a favourite, a search. The
            // orchestrator's concurrent-fetch guard drops any un-forced call
            // while another fetch is in flight, silently, which left the
            // PREVIOUS location's numbers on screen under the new name: pick
            // Townsville, land back on the Glass looking at Newport. A
            // background refresh may be dropped; a person tapping a place
            // may not.
            if (cached) {
                await fetchWeather(location, true, coords, false, true);
            } else {
                await fetchWeather(location, true, coords, !weatherDataRef.current);
            }
        },
        [
            fetchWeather,
            isCurrentScope,
            orchestrator,
            publishPositionSource,
            readFollowPosition,
            resolveFollowFix,
            setWeatherData,
            updateSettings,
        ],
    );

    restoreLocationRef.current = (location, coords) => {
        void selectLocation(location, coords);
    };

    // ── WATCHDOG: Ensure nextUpdate is set if data exists ───
    useEffect(() => {
        if (isCurrentScope() && !isOffline && weatherData && !nextUpdate) {
            const lt = weatherData.locationType || 'coastal';
            const isCurrentLoc = locationMode === 'gps';
            const interval = getUpdateInterval(lt, weatherData, isCurrentLoc, settingsRef.current.satelliteMode);
            const gen = new Date(weatherData.generatedAt).getTime();
            const target = gen + interval;
            if (target > Date.now()) {
                setNextUpdateForScope(target);
            } else {
                setNextUpdateForScope(alignToNextInterval(interval));
            }
        }
    }, [isCurrentScope, isOffline, locationMode, nextUpdate, setNextUpdateForScope, weatherData]);

    // A scheduled timestamp means "the app intends to make a network
    // refresh at this time". Keep that promise honest: while the WAN probe
    // says offline there is no pending refresh, and an old timestamp must not
    // leave consumers showing "Updating" or "Overdue" indefinitely.
    //
    // Reconnect is keyed to the probe transition, not window.online. The
    // latter only says a link interface returned (often the boat LAN); the
    // internet probe is what proves that weather providers are reachable.
    useEffect(() => {
        const wasOffline = previousOfflineRef.current;
        previousOfflineRef.current = isOffline;
        if (!isCurrentScope()) return;

        if (isOffline) {
            setNextUpdateForScope(null);
            localStorage.removeItem(cacheKeys.nextUpdate);
            setStaleRefresh(false);
            return;
        }

        if (!wasOffline) return;

        const data = weatherDataRef.current;
        const dataAge = data?.generatedAt ? Date.now() - new Date(data.generatedAt).getTime() : Infinity;
        const STALE_ON_RECONNECT_MS = 5 * 60 * 1000;
        if (dataAge < STALE_ON_RECONNECT_MS) return;

        log.info(`[WeatherContext] WAN restored — data ${Math.round(dataAge / 60000)}m old, refreshing`);
        if (dataAge >= 2 * 60 * 60 * 1000) setStaleRefresh(true);

        const reconnectTimer = setTimeout(() => {
            if (!isCurrentScope() || useUIStore.getState().isOffline || isFetchingRef.current) return;
            const current = weatherDataRef.current;
            const loc = current?.locationName || settingsRef.current.defaultLocation;
            if (!loc) return;

            if (locationModeRef.current === 'gps') {
                void refreshFollowWeather();
            } else {
                void fetchWeather(loc, true, current?.coordinates, false, true);
            }
        }, 1500);

        return () => clearTimeout(reconnectTimer);
    }, [
        cacheKeys.nextUpdate,
        fetchWeather,
        isCurrentScope,
        isOffline,
        locationMode,
        refreshFollowWeather,
        setNextUpdateForScope,
    ]);

    // ── SMART REFRESH TIMER ─────────────────────────────────
    useEffect(() => {
        // Do not create polling or wake timers that can only fail. The
        // probe-driven reconnect effect above restarts this scheduler.
        if (isOffline) return;

        const deferredTimers = new Set<ReturnType<typeof setTimeout>>();
        const scheduleDeferred = (callback: () => void, delayMs: number) => {
            const timer = setTimeout(() => {
                deferredTimers.delete(timer);
                if (isCurrentScope()) callback();
            }, delayMs);
            deferredTimers.add(timer);
        };

        const checkInterval = setInterval(() => {
            if (!isCurrentScope()) return;
            if (document.hidden) return;
            if (useUIStore.getState().isOffline) return;
            if (isFetchingRef.current) return;

            const data = weatherDataRef.current;
            if (data) {
                const age = Date.now() - (data.generatedAt ? new Date(data.generatedAt).getTime() : 0);
                if (age > 7200000 && !nextUpdateRef.current) {
                    setNextUpdateForScope(Date.now() + 5000);
                    return;
                }
            }

            if (!nextUpdateRef.current) return;
            if (Date.now() >= nextUpdateRef.current) {
                const tempNext = Date.now() + 90000;
                setNextUpdateForScope(tempNext);

                if (locationModeRef.current === 'gps') {
                    void refreshFollowWeather();
                } else {
                    const loc = weatherDataRef.current?.locationName || settingsRef.current.defaultLocation;
                    const storedCoords = weatherDataRef.current?.coordinates;
                    if (loc && storedCoords) void fetchWeather(loc, false, storedCoords, false, true);
                    else if (loc) void fetchWeather(loc, false, undefined, false, true);
                }
            }
        }, 30_000);

        // Wake from sleep handler
        // Raised 30min → 2h to match the new two-tier staleness policy
        // (see WeatherOrchestrator.BLUR_THRESHOLD_MS). Below 2h we refresh
        // silently using the sync badge; only older than that gets the
        // disruptive blur overlay.
        const STALE_ON_WAKE_MS = 2 * 60 * 60 * 1000;
        const handleVisibilityChange = () => {
            if (!isCurrentScope()) return;
            if (document.visibilityState !== 'visible') return;
            if (useUIStore.getState().isOffline) return;
            if (isFetchingRef.current) return;

            const data = weatherDataRef.current;
            const dataAge = data?.generatedAt ? Date.now() - new Date(data.generatedAt).getTime() : Infinity;

            if (dataAge > STALE_ON_WAKE_MS) {
                log.info(`[WeatherContext] Wake: data is ${Math.round(dataAge / 60000)}m old — refreshing`);
                setStaleRefresh(true);
                // Revalidate the selected receiver before reusing a point.
                // A cached report does not prove whether it came from this
                // phone or the vessel, including after a receiver switch.
                const wakeEpoch = selectionEpochRef.current;
                scheduleDeferred(() => {
                    if (useUIStore.getState().isOffline) return;
                    if (isFetchingRef.current) return;
                    if (wakeEpoch !== selectionEpochRef.current) return;
                    const loc = data?.locationName || settingsRef.current.defaultLocation;
                    if (!loc) return;
                    const knownCoords = data?.coordinates;

                    if (locationModeRef.current !== 'gps') {
                        void fetchWeather(loc, true, knownCoords, false, true);
                        return;
                    }
                    void refreshFollowWeather();
                }, 300);
            } else {
                const now = Date.now();
                const target = nextUpdateRef.current;
                if (target && now >= target) {
                    const wakeNext = now + 5000;
                    setNextUpdateForScope(wakeNext);
                }
            }
        };
        document.addEventListener('visibilitychange', handleVisibilityChange);

        return () => {
            clearInterval(checkInterval);
            for (const timer of deferredTimers) clearTimeout(timer);
            deferredTimers.clear();
            document.removeEventListener('visibilitychange', handleVisibilityChange);
        };
    }, [fetchWeather, isCurrentScope, isOffline, locationMode, refreshFollowWeather, setNextUpdateForScope]);

    // ── BLUR WATCHDOG ──────────────────────────────────────────
    // The blur is only ever cleared by the orchestrator's `finally`, which
    // means it clears only if a fetch actually STARTS. Both handlers above
    // raise it and then defer to a setTimeout that can return without
    // fetching — already-fetching, no location resolved, or a null GPS fix
    // on a path with no fallback. Those leave the blur up with nothing left
    // running to take it down.
    //
    // That was survivable while the overlay showed a spinner and "Updating":
    // a stuck one still read as BUSY, which tells the punter to pull-to-
    // refresh. A bare blur (2026-07-22, message removed at Shane's request)
    // reads as a broken screen instead — so the failure mode got worse
    // exactly as the affordance disappeared, and it needs a floor.
    //
    // Deliberately at the STATE and not at the four call sites: it also
    // covers whatever raises the blur next.
    //
    // 25 s is sized off the SLOWEST LEGITIMATE path, not off a typical
    // fetch: waking on GPS costs a 2 s settle, then getCurrentPosition at
    // timeoutSec 10, then sources bounded at 8 s — about 20 s before a good
    // fetch resolves. A tighter watchdog (12 s was the first guess) fires
    // mid-flight on exactly that path and drops the blur while the numbers
    // are still being replaced, which is the thing it exists to prevent.
    // Late is the safe direction to err here: a stuck blur self-heals,
    // whereas lifting early re-exposes stale numbers as if they were good.
    useEffect(() => {
        if (!staleRefresh || !isCurrentScope()) return;
        const t = setTimeout(() => {
            if (!isCurrentScope()) return;
            log.warn('[WeatherContext] Blur watchdog fired — clearing after 25s with no fetch completion');
            setStaleRefresh(false);
        }, 25_000);
        return () => clearTimeout(t);
    }, [isCurrentScope, staleRefresh]);

    // ── GPS FOLLOW — live position every 5 s, weather every 30 NM ──
    // While defaultLocation is 'Current Location' the Glass page FOLLOWS
    // the boat: position checked every 5 s; once you've drifted ≥0.5 NM
    // from what's on screen the displayed name/coords update (reverse-
    // geocoded); once you're ≥30 NM from the point the FORECAST was
    // fetched for, fresh weather is pulled for where you actually are.
    // Decision logic + thresholds live in utils/gpsFollow (unit-tested).
    //
    // CRITICAL INVARIANT: nothing in this effect may call selectLocation()
    // or write settings.defaultLocation — both flip locationMode to
    // 'selected' (via the sync effect above), which unmounts this very
    // effect. That self-kill was the original "position never updates
    // underway" bug: the old drift detector promoted its first geocoded
    // name into settings and died. GPS-follow mode is STICKY until the
    // user manually picks a port.
    //
    // The 30 NM baseline is the last REAL fetch point, tracked via
    // generatedAt (display renames preserve generatedAt; real fetches
    // change it). Measuring against displayed coords instead would let
    // 0.5 NM renames keep resetting the baseline — a boat could cross an
    // ocean in small hops without ever tripping a forecast refresh.
    const weatherPointRef = useRef<{ lat: number; lon: number; generatedAt: string } | null>(null);
    /** Where the tides on screen were fetched for — reset by every real fetch, moved by each tide-only refresh. */
    const tidePointRef = useRef<{ lat: number; lon: number } | null>(null);
    useEffect(() => {
        if (!isCurrentScope()) return;
        const d = weatherData;
        if (!d?.coordinates || !d.generatedAt) return;
        if (weatherPointRef.current?.generatedAt !== d.generatedAt) {
            weatherPointRef.current = { lat: d.coordinates.lat, lon: d.coordinates.lon, generatedAt: d.generatedAt };
            tidePointRef.current = { lat: d.coordinates.lat, lon: d.coordinates.lon };
        }
    }, [isCurrentScope, weatherData]);

    useEffect(() => {
        if (locationMode !== 'gps' || !isCurrentScope()) return;
        let cancelled = false;
        let tickGeneration = 0;
        let activeTick: { epoch: number } | null = null;

        const tick = () => {
            if (!isCurrentScope() || cancelled || locationModeRef.current !== 'gps') return;
            if (document.hidden) return;
            if (isFetchingRef.current) return;
            if (selectionResolvingRef.current || followRefreshInFlightRef.current) return;
            // A slow geocoder must get to finish, rather than being replaced
            // every five seconds. A new selection may start immediately.
            if (activeTick?.epoch === selectionEpochRef.current) return;

            const displayed = weatherDataRef.current?.coordinates;
            const weatherPoint = weatherPointRef.current;
            const generation = ++tickGeneration;
            const selectionEpoch = selectionEpochRef.current;
            const tickRequest = { epoch: selectionEpoch };
            activeTick = tickRequest;
            const target = getWeatherFollowTarget();
            const isCurrentTick = () =>
                isCurrentScope() &&
                !cancelled &&
                generation === tickGeneration &&
                selectionEpoch === selectionEpochRef.current &&
                target === getWeatherFollowTarget() &&
                locationModeRef.current === 'gps';

            // The phone by default; the boat (the bus, then the Pi, then her
            // cloud row, then her held last fix) when the skipper picked her
            // row in the ★ menu — see services/weatherPosition (2026-09-08).
            // The phone read stays the passive, already-granted one.
            readFollowPosition(target)
                .then(async (resolved) => {
                    if (!isCurrentTick()) return;
                    if (resolved.fix) lastFollowFixRef.current = { fix: resolved.fix, target, epoch: selectionEpoch };
                    publishPositionSource(resolved.fix, target);
                    lastHeldRef.current = resolved.held;
                    lastPhoneRef.current = resolved.phone;
                    if (!resolved.fix) {
                        setWeatherError(describeWeatherFix(null, Date.now(), target));
                        return;
                    }
                    setError(null);
                    const { lat: latitude, lon: longitude } = resolved.fix;
                    if (!displayed || !weatherPoint) {
                        if (!useUIStore.getState().isOffline) {
                            void fetchWeather('Current Location', true, { lat: latitude, lon: longitude }, false, true);
                        }
                        return;
                    }

                    const action = decideFollowAction({
                        weatherPoint,
                        displayed: namePointRef.current ?? displayed,
                        position: { lat: latitude, lon: longitude },
                        // Boot case: prettify the literal placeholder name even
                        // at zero drift — without leaving GPS mode.
                        displayedNameIsPlaceholder:
                            namePointRef.current === null ||
                            (!nameResolvedRef.current && Date.now() >= nameRetryAtRef.current),
                    });
                    if (action === 'none' && !tideNeedsRefresh(tidePointRef.current, { lat: latitude, lon: longitude }))
                        return;

                    let name =
                        action === 'none'
                            ? (weatherDataRef.current?.locationName ?? '')
                            : coordinateLocationName({ lat: latitude, lon: longitude });
                    let nameResolved = false;
                    // A cardinal coordinate is an honest offline label. Do not
                    // send a reverse-geocode request until the WAN probe says it
                    // can succeed.
                    if (action !== 'none' && !useUIStore.getState().isOffline) {
                        try {
                            const geo = await reverseGeocode(latitude, longitude);
                            if (!isCurrentTick()) return;
                            if (geo) {
                                name = geo;
                                nameResolved = true;
                            }
                        } catch {
                            /* offshore — cardinal coords are an honest label */
                        }
                    }
                    if (!isCurrentTick()) return;
                    if (weatherPointRef.current?.generatedAt !== weatherPoint.generatedAt) return;
                    if (action !== 'none') {
                        namePointRef.current = { lat: latitude, lon: longitude };
                        nameResolvedRef.current = nameResolved;
                        nameRetryAtRef.current = Date.now() + 60_000;
                    }

                    if (action === 'refetch') {
                        if (useUIStore.getState().isOffline) return; // retry after the reachability probe recovers
                        const dist = haversineNM(weatherPoint.lat, weatherPoint.lon, latitude, longitude);
                        log.warn(
                            `[WeatherContext] GPS follow: ${dist.toFixed(1)} NM from forecast point — refetching for ${name}`,
                        );
                        void fetchWeather(name, true, { lat: latitude, lon: longitude }, false, true);
                    } else {
                        // Inside the 30 NM bubble: keep the DISPLAYED position
                        // live. No settings write, no refetch — just the label.
                        const existing = weatherDataRef.current;
                        if (existing && action !== 'none') {
                            setWeatherData({
                                ...existing,
                                locationName: name,
                                coordinates: { lat: latitude, lon: longitude },
                            });
                        }
                        // The tide station follows sooner than the forecast: the
                        // label under the graph read the old station until the
                        // 30 NM refetch (Shane 2026-09-06). Tide-only; the 24 h
                        // upstream cache makes a repeat cheap.
                        if (
                            existing &&
                            tideNeedsRefresh(tidePointRef.current, { lat: latitude, lon: longitude }) &&
                            (!tideRequestRef.current ||
                                tideNeedsRefresh(tideRequestRef.current.point, { lat: latitude, lon: longitude })) &&
                            !useUIStore.getState().isOffline
                        ) {
                            const request = { point: { lat: latitude, lon: longitude }, token: Symbol('tides') };
                            tideRequestRef.current = request;
                            void fetchTidesForPosition(latitude, longitude)
                                .then((tides) => {
                                    if (
                                        !tides ||
                                        !isCurrentScope() ||
                                        cancelled ||
                                        selectionEpoch !== selectionEpochRef.current ||
                                        target !== getWeatherFollowTarget() ||
                                        locationModeRef.current !== 'gps' ||
                                        tideRequestRef.current !== request
                                    )
                                        return;
                                    if (weatherPointRef.current?.generatedAt !== weatherPoint.generatedAt) return;
                                    const current = weatherDataRef.current;
                                    if (!current) return;
                                    tidePointRef.current = request.point;
                                    setWeatherData({
                                        ...current,
                                        tides: tides.tides,
                                        tideHourly: tides.tideHourly,
                                        tideGUIDetails: tides.tideGUIDetails ?? current.tideGUIDetails,
                                    });
                                })
                                .catch(() => {
                                    // Retry at the next eligible tick; a failed request
                                    // must not pretend that the tide station moved.
                                })
                                .finally(() => {
                                    if (tideRequestRef.current === request) tideRequestRef.current = null;
                                });
                        }
                    }
                })
                .catch((error) => {
                    if (isCurrentTick()) log.warn('GPS follow lookup failed', error);
                })
                .finally(() => {
                    if (activeTick === tickRequest) activeTick = null;
                });
        };

        // Immediate first tick — covers 'opened the app after a flight'
        // (≥30 NM → instant refetch) and boot-time name prettify.
        followTickRef.current = tick;
        tick();
        const followTimer = setInterval(tick, GPS_FOLLOW_POLL_MS);

        return () => {
            cancelled = true;
            tickGeneration += 1;
            followTickRef.current = null;
            clearInterval(followTimer);
        };
    }, [
        fetchWeather,
        isCurrentScope,
        locationMode,
        setWeatherData,
        publishPositionSource,
        readFollowPosition,
        setWeatherError,
    ]);

    // Off GPS-follow (a port was picked): no receiver line, no open question.
    useEffect(() => {
        if (locationMode === 'gps') return;
        publishPositionSource(null);
        setPositionPrompt(null);
        lastHeldRef.current = null;
    }, [locationMode, publishPositionSource]);

    // ── LIVE OVERLAY (delegates to orchestrator) ────────────
    useEffect(() => {
        if (isOffline) return;

        const liveTimer = setInterval(() => {
            if (!isCurrentScope()) return;
            if (document.hidden) return;
            if (useUIStore.getState().isOffline) return;
            if (isFetchingRef.current) return;
            void orchestrator.patchLiveMetrics();
        }, LIVE_OVERLAY_INTERVAL);

        return () => clearInterval(liveTimer);
    }, [isCurrentScope, isOffline, orchestrator]);

    // ── Model Change Effect ─────────────────────────────────
    // Watches the Glass forecast-model picker (settings.forecastModel).
    // The strategy layer reads the store directly at fetch time, so all
    // this has to do is force a refetch when the choice changes.
    const prevModelRef = useRef(settings.forecastModel);
    useEffect(() => {
        if (!isCurrentScope()) return;
        if (prevModelRef.current !== settings.forecastModel) {
            prevModelRef.current = settings.forecastModel;
            if (locationModeRef.current === 'gps') {
                void refreshFollowWeather();
                return;
            }
            const loc = weatherDataRef.current?.locationName || settingsRef.current.defaultLocation;
            if (loc) void fetchWeather(loc, true);
        }
    }, [fetchWeather, isCurrentScope, refreshFollowWeather, settings.forecastModel]);

    // ── ZUSTAND SYNC BRIDGE ──────────────────────────────────
    // Syncs context state → Zustand store so components can use
    // fine-grained selectors via useWeatherStore() while we
    // incrementally migrate away from the context provider.
    useEffect(() => {
        useWeatherStore.getState()._sync(
            {
                weatherData,
                voyagePlan,
                loading,
                loadingMessage,
                error,
                debugInfo,
                quotaUsed,
                backgroundUpdating,
                staleRefresh,
                nextUpdate,
                historyCache,
            },
            identityScope,
        );
    }, [
        identityScope,
        weatherData,
        voyagePlan,
        loading,
        loadingMessage,
        error,
        debugInfo,
        quotaUsed,
        backgroundUpdating,
        staleRefresh,
        nextUpdate,
        historyCache,
    ]);

    // ── CONTEXT VALUE (memoized) ────────────────────────────
    const answerPositionChoice = useCallback(
        (choice: HeldChoice) => {
            const held = positionPrompt?.held ?? lastHeldRef.current;
            setPositionPrompt(null);
            if (!held) return;
            setHeldChoice(held, choice);
            // The same switch the saved-locations menu throws (2026-09-08): the
            // dialog is just the ℹ panel's door to it while a held fix shows.
            setWeatherFollowTarget(choice);
            log.info(`Boat quiet — the weather follows ${choice === 'boat' ? 'her last fix' : 'the phone'}`);
            followTickRef.current?.();
        },
        [positionPrompt],
    );
    const openPositionChoice = useCallback(() => {
        const held = lastHeldRef.current;
        if (!held) return;
        setPositionPrompt({ held, phone: lastPhoneRef.current });
    }, []);
    const positionChoice = React.useMemo<WeatherPositionChoice>(
        () => ({ prompt: positionPrompt, answer: answerPositionChoice, open: openPositionChoice }),
        [positionPrompt, answerPositionChoice, openPositionChoice],
    );

    const contextValue = React.useMemo(
        () => ({
            weatherData,
            voyagePlan,
            loading,
            loadingMessage,
            error,
            debugInfo,
            quotaUsed,
            backgroundUpdating,
            staleRefresh,
            nextUpdate,
            fetchWeather,
            refreshData,
            selectLocation,
            saveVoyagePlan: handleSaveVoyagePlan,
            handleSaveVoyagePlan,
            clearVoyagePlan,
            incrementQuota,
            positionSource,
            positionChoice,
            historyCache,
            setHistoryCache: setHistoryCacheForScope,
        }),
        [
            weatherData,
            voyagePlan,
            loading,
            loadingMessage,
            error,
            debugInfo,
            quotaUsed,
            backgroundUpdating,
            staleRefresh,
            nextUpdate,
            fetchWeather,
            refreshData,
            selectLocation,
            handleSaveVoyagePlan,
            clearVoyagePlan,
            incrementQuota,
            positionSource,
            positionChoice,
            historyCache,
            setHistoryCacheForScope,
        ],
    );

    return <WeatherContext.Provider value={contextValue}>{children}</WeatherContext.Provider>;
};

export const useWeather = () => {
    const context = useContext(WeatherContext);
    if (context === undefined) throw new Error('useWeather must be used within a WeatherProvider');
    return context;
};

/** The same context, or undefined outside a provider — for pages that only borrow a field from it. */
export const useWeatherOptional = () => useContext(WeatherContext);

// Scheduling internals now imported from services/WeatherScheduler.ts
// Import directly: import { isBadWeather, getUpdateInterval, ... } from '../services/WeatherScheduler'
