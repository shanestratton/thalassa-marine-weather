import React, { Suspense, useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { createLogger } from '../utils/createLogger';
import { lazyRetry } from '../utils/lazyRetry';

const log = createLogger('Dashboard');
import { t } from '../theme';
import { useDashboardController } from '../hooks/useDashboardController';
import { triggerHaptic } from '../utils/system';

import { HeroSection, type ShownGlassDay } from './dashboard/Hero';
import { CompactHeaderRow } from './dashboard/CompactHeaderRow';
import { StatusBadges } from './dashboard/StatusBadges';
// safety app must warn when the displayed weather is stale or the device is
// offline. Self-hides when data is fresh and online, so it adds no chrome in
// the normal case. Lives in the bottom badges container, next to the
// data-source badges, to avoid disturbing the hand-calc'd top layout stack.
import { OffshoreBoundaryToast } from './dashboard/OffshoreBoundaryToast';
import { getMoonPhase } from './dashboard/WeatherHelpers';
import { useOffshoreStatus } from '../hooks/useOffshoreStatus';

const LogPage = lazyRetry(() => import('../pages/LogPage').then((m) => ({ default: m.LogPage })), 'LogPage_Dash');
const GlassTutorial = lazyRetry(
    () => import('./dashboard/GlassTutorial').then((module) => ({ default: module.GlassTutorial })),
    'GlassTutorial',
);
// The header's Sun and moon chip opens it (W1-09); loaded only then.
const SunMoonSheet = lazyRetry(
    () => import('./dashboard/SunMoonSheet').then((module) => ({ default: module.SunMoonSheet })),
    'SunMoonSheet',
);
import { HeroHeader } from './dashboard/HeroHeader';
import { HeroWidgets } from './dashboard/HeroWidgets';
import { CurrentConditionsCard } from './dashboard/CurrentConditionsCard';
import { RainForecastCard } from './dashboard/RainForecastCard';
import { ShimmerBlock } from './ui/ShimmerBlock';
import {
    GLASS_LANDSCAPE_HERO_CONTAINER_HEIGHT_PX,
    glassSafeTopOffset,
    getGlassTopLayout,
} from './dashboard/glassLayout';
import { useViewportHeight } from '../hooks/useViewportHeight';
import { activeRowIsoDate, computeSunPhase, resolveHeroRowTemperatureRange } from './dashboard/hero/heroSlideHelpers';

import { useSettings } from '../context/SettingsContext';
// useWeather removed with the old freshness strip — re-add if a new Glass-page
// element needs error / loading / refreshData hooks.

import { DashboardWidgetContext, DashboardWidgetContextType } from './WidgetRenderer';
import { UnitPreferences, SourcedWeatherMetrics } from '../types';
import { fetchMinutelyRainWithSummary, MinutelyRain } from '../services/weather/api/weatherkit';
import { fetchRainbowPrecip } from '../services/weather/api/rainbowPrecip';
import {
    readPlaintextWeatherCacheItem,
    writePlaintextWeatherCacheItem,
} from '../services/weather/plaintextCachePrivacy';
import { useSettingsStore } from '../stores/settingsStore';
import { useUIStore } from '../stores/uiStore';
import { canAccess } from '../services/SubscriptionService';
import { canRefreshRainForecast } from '../utils/offlineAuthority';
import {
    getForecastModelInfo,
    getOffshoreModelInfo,
    isSpitfire,
    resolveForecastModel,
    resolveOffshoreModel,
} from '../services/weather/forecastModels';
import {
    DndContext,
    PointerSensor,
    TouchSensor,
    useSensor,
    useSensors,
    type DragEndEvent,
    type DragStartEvent,
    type DragOverEvent,
} from '@dnd-kit/core';

/**
 * Unified rain data fetcher — routes to Rainbow.ai (Skipper) or WeatherKit (others).
 * Rainbow.ai provides 4-hour forecast at 1km resolution; WeatherKit gives 1-hour minutely.
 */
async function fetchRainData(
    lat: number,
    lon: number,
    useRainbow: boolean,
    isCancelled: () => boolean,
    onData: (rain: MinutelyRain[], summary: string, source: 'rainbow' | 'weatherkit') => void,
): Promise<void> {
    // Cancellation is a GETTER, read again after every await. The previous
    // boolean parameter was frozen at call time (always false), so a fetch
    // in flight across a location change delivered the old place's rain
    // under the new place's name — for up to ~10 min, because the stale
    // result also looked fresh to the TTL guard (review, 2026-08-20).
    if (isCancelled()) return;

    if (useRainbow) {
        try {
            const result = await fetchRainbowPrecip(lat, lon);
            if (isCancelled()) return;
            if (result && result.rain.length > 0) {
                onData(result.rain, result.summary, 'rainbow');
                return;
            }
        } catch {
            // Rainbow.ai failed — fall through to WeatherKit
        }
    }

    // WeatherKit fallback (all tiers, or if Rainbow.ai fails)
    const { rain, summary } = await fetchMinutelyRainWithSummary(lat, lon);
    if (!isCancelled()) {
        onData(rain, summary, 'weatherkit');
    }
}

interface DashboardProps {
    onOpenMap: () => void;
    onTriggerUpgrade: () => void;
    favorites: string[];
    displayTitle: string;
    timeZone?: string;
    utcOffset?: number;
    timeDisplaySetting: string;
    onToggleFavorite: () => void;
    isRefreshing?: boolean;
    isNightMode: boolean;
    isMobileLandscape?: boolean;
    viewMode?: 'overview' | 'details';
    mapboxToken?: string;
    onLocationSelect?: (lat: number, lon: number, name?: string) => void;
}

// Main Component
export const Dashboard: React.FC<DashboardProps> = React.memo((props) => {
    // 1. Controller Hook (Encapsulated Logic)
    const {
        data,
        current,
        hourly,
        boatingAdvice,
        lockerItems,
        isLandlocked,
        isPro,
        isPlaying,

        // Actions
        handleAudioBroadcast,
        shareReport,
        staleRefresh,
        // `error` and `refreshData` were pulled only for the freshness strip
        // removed 2026-08-13. StatusBadges takes both straight from
        // useWeather() itself (StatusBadges.tsx:82), so the model pill keeps
        // its red-on-failure tint and its "Refresh now" without them here.
        refreshInterval,
        settings,
    } = useDashboardController(props.viewMode);

    // Settings
    const { settings: userSettings, updateSettings } = useSettings();

    // Freshness/error signals feed the forecast-model pill (pulse while
    // refreshing, red on failure) via the
    // controller (error) and the report itself (_stale/_staleAgeMinutes).
    // They were dropped when the banner was removed, and when it was
    // re-mounted 2026-06-21 only the age props came back — the loud
    // 'error' and 'offline-cache' tiers were unreachable until 2026-08-03.

    // Reactive offline flag (internetProbe-verified WAN reachability, not just
    // navigator.onLine) — feeds the offline pill so the Glass page warns the
    // moment the connection drops, even on otherwise-fresh data.
    const isOffline = useUIStore((s) => s.isOffline);
    const isInland = data?.locationType === 'inland' || isLandlocked;
    const offshore = useOffshoreStatus(data?.locationType);
    const isOffshore = offshore.isOffshore;
    const isExpanded =
        isInland || isOffshore ? (isOffshore ? true : false) : userSettings.dashboardMode !== 'essential';
    const viewportHeightPx = useViewportHeight();
    const glassTopLayout = getGlassTopLayout(Boolean(props.isMobileLandscape), viewportHeightPx);
    // Landscape: the stack is taller than the viewport, so the layers become
    // `absolute` inside a column tall enough to hold them and the page scrolls
    // (the referee's land-dashboard HIGH: footer and dot rail painted across
    // the widget grid). Portrait keeps the fixed stack exactly as shipped.
    const landscapeFlow = Boolean(props.isMobileLandscape);
    // The Glass footer (status badges + forecast credit) grows when the credit
    // wraps, so the hero stands on its measured height, not on the 47 px it
    // used to be: a two-line credit covered the tide card's
    // hour axis (UX scorecard run 7). 74 px is the footer's own bottom offset;
    // the Glass card gap (8, or 6 on a 667 pt phone) is the gap between the
    // tide card and the badges. It was 3 px on top of the slide's 16 px bottom
    // padding: a 20 pt band against 8 pt everywhere else (UX scorecard run 9).
    const [glassFooterHeightPx, setGlassFooterHeightPx] = useState(47);
    const glassFooterObserverRef = useRef<ResizeObserver | null>(null);
    // A callback ref, because the footer mounts after the first render (it
    // waits for weather data): observe it whenever the element attaches.
    const glassFooterRef = useCallback((el: HTMLDivElement | null) => {
        glassFooterObserverRef.current?.disconnect();
        glassFooterObserverRef.current = null;
        if (!el || typeof ResizeObserver === 'undefined') return;
        const measure = () => {
            const h = Math.round(el.getBoundingClientRect().height);
            if (h > 0) setGlassFooterHeightPx((prev) => (prev === h ? prev : h));
        };
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(el);
        glassFooterObserverRef.current = observer;
    }, []);
    useEffect(() => () => glassFooterObserverRef.current?.disconnect(), []);
    // A 667 pt phone held upright. (A landscape phone is under 700 tall too,
    // but its column scrolls, so it keeps the roomier hero.)
    const shortPortrait = glassTopLayout.isShortViewport && !landscapeFlow;
    // The footer's bottom offset: 74 px clears the tab bar by 12-13 pt. On a
    // 667 pt phone it clears it by the Glass gap instead, and the footer's
    // own padding halves, so the ~14 pt they free goes to the tide card,
    // squashed there to a 40 pt curve (UX scorecard run 10). The 163 px grid
    // is not touched.
    const glassFooterBottomPx = shortPortrait ? 68 : 74;
    const glassHeroBottom = `calc(env(safe-area-inset-bottom) + ${glassFooterBottomPx + glassFooterHeightPx + glassTopLayout.cardGapPx}px)`;
    const glassLayerPos = landscapeFlow ? 'absolute' : 'fixed';
    const landscapeHeroHeightPx = GLASS_LANDSCAPE_HERO_CONTAINER_HEIGHT_PX;

    // Derived UI Props
    const isDetailMode = props.viewMode === 'details';
    const [_selectedTime, setSelectedTime] = useState<number | undefined>(undefined);
    // RAW carousel index of the focused hero slide. Needed because activeHour is
    // LOSSY: on a forecast day the overview (slide 0) and 00:00 (slide 1) BOTH
    // report hour 0, so the hour cannot distinguish them (HeroSlide's own comment
    // says as much). Do NOT reach for selectedTime here — onTimeSelect is only
    // ever called with undefined, so it is always undefined and any test against
    // it silently matches every slide.
    const [activeSlideIdx, setActiveSlideIdx] = useState(0);

    // Fixed header state management — refs + state for throttled updates
    // Refs hold the latest value instantly (no re-render). State triggers the UI update.
    const [activeDay, setActiveDay] = useState(0);
    const [activeHour, setActiveHour] = useState(0);
    const [activeDayData, setActiveDayData] = useState<SourcedWeatherMetrics | null>(null);
    const activeDayRef = useRef(0);
    const activeHourRef = useRef(0);
    const activeDayDataRef = useRef<SourcedWeatherMetrics | null>(null);
    const rafIdRef = useRef<number | null>(null);

    // Stable handlers for the header rows. HeroHeader is React.memo, and an
    // inline closure here handed it a new onToggleExpand on every Dashboard
    // render — defeating the memo entirely.
    const handleToggleDashboardMode = useCallback(() => {
        triggerHaptic('light');
        const goingEssential = userSettings.dashboardMode !== 'essential';
        updateSettings({
            dashboardMode: goingEssential ? 'essential' : 'full',
        });
        if (goingEssential) {
            // Reset to live so map/widgets show current data
            setActiveDay(0);
            setActiveHour(0);
            setActiveDayData(null);
            // Reset horizontal scroll to live position
            setTimeout(() => window.dispatchEvent(new Event('hero-reset-scroll')), 10);
        }
    }, [userSettings.dashboardMode, updateSettings]);
    const handleToggleExpand = useCallback(() => {
        triggerHaptic('light');
        const goingEssential = isExpanded; // isExpanded means currently full, so toggling goes to essential
        updateSettings({
            dashboardMode: goingEssential ? 'essential' : 'full',
        });
        if (goingEssential) {
            /* Clear the REFS as well as the state. The rAF batches in
               handleDayChange / handleHourChange / handleActiveDataChange
               all re-assert setActiveDay(activeDayRef.current), and the
               reset itself provokes one — so setting state alone let the
               old day walk straight back in. That is why the header still
               read MON 31 AUG after a toggle that had just set day 0. */
            activeDayRef.current = 0;
            activeHourRef.current = 0;
            activeDayDataRef.current = null;
            setActiveDay(0);
            setActiveHour(0);
            setActiveDayData(null);
            // Reset horizontal scroll to live position
            setTimeout(() => window.dispatchEvent(new Event('hero-reset-scroll')), 10);
        }
    }, [isExpanded, updateSettings]);

    // Sync activeDayData with the same location-day high/low pair used by the
    // Hero row. This closes the short initial-render window before HeroSlide's
    // active-card callback arrives.
    useEffect(() => {
        if (current && !activeDayDataRef.current) {
            const temperatures = resolveHeroRowTemperatureRange(current, data?.forecast ?? [], hourly ?? [], {
                timeZone: data?.timeZone,
                referenceTime: Date.now(),
                preferForecast: true,
                allowLeadingPreviousDayFallback: true,
            });
            const liveDayData = {
                ...current,
                highTemp: temperatures.highTemp,
                lowTemp: temperatures.lowTemp,
            };
            activeDayDataRef.current = liveDayData;
            setActiveDayData(liveDayData);
        }
    }, [current, data?.forecast, data?.timeZone, hourly]);

    // The sun & moon sheet (W1-09), for the day on screen at the Glass point.
    // Not for the 0°, 0° stub a location wears while it is geocoded. The day
    // is the row's own date (row N is not always today plus N), read at the
    // tap from the refs: the rAF batch can leave activeDayData a row behind.
    const [sunMoonDay, setSunMoonDay] = useState<{ isoDate: string; isToday: boolean } | null>(null);
    const sunMoonPlaced = !!data?.coordinates && (data.coordinates.lat !== 0 || data.coordinates.lon !== 0);
    const sunMoonZone = data?.timeZone;
    const openSunMoon = useCallback(() => {
        const day = activeDayRef.current;
        setSunMoonDay({
            isoDate: activeRowIsoDate(activeDayDataRef.current, day, sunMoonZone),
            isToday: day === 0,
        });
    }, [sunMoonZone]);
    const closeSunMoon = useCallback(() => setSunMoonDay(null), []);

    // Minutely rain data — Rainbow.ai for Skipper tier, WeatherKit fallback for others
    const [minutelyRain, setMinutelyRain] = useState<MinutelyRain[]>([]);
    const [rainSummary, setRainSummary] = useState<string>('');
    const [rainSource, setRainSource] = useState<'rainbow' | 'weatherkit' | 'synthetic' | 'unknown'>('unknown');
    const [rainStatus, setRainStatus] = useState<'loading' | 'loaded' | 'error'>('loading');
    // Which location's rain is currently in state — so a location change can
    // clear the old place's frames instead of leaving them on screen under
    // the new place's name while the fetch runs (up to 15 s of a Townsville
    // headline over a Newport label).
    const rainLocRef = useRef<string | null>(null);
    const precipRef = useRef<number>(0);
    precipRef.current = current?.precipitation ?? 0;
    const subscriptionTier = useSettingsStore((s) => s.settings.subscriptionTier);
    const isSkipper = canAccess(subscriptionTier, 'weatherFull');

    // The model pill's own label, so a day past that model's range can name
    // it (UX scorecard run 6). Null for Auto and the automatic offshore blend:
    // no single model to name. Mirrors StatusBadges' pill resolution.
    const pinnedForecastModel = useSettingsStore((s) => s.settings.forecastModel);
    const pinnedOffshoreModel = useSettingsStore((s) => s.settings.offshoreModel);
    const forecastModelLabel = useMemo(() => {
        if (isOffshore) {
            const model = resolveOffshoreModel(pinnedOffshoreModel);
            return model === 'sg' ? null : getOffshoreModelInfo(model).label;
        }
        const model = resolveForecastModel(pinnedForecastModel);
        if (isSpitfire(model)) return 'SPITFIRE';
        return getForecastModelInfo(model)?.label ?? null;
    }, [isOffshore, pinnedForecastModel, pinnedOffshoreModel]);

    // ── DnD: Phase 2 of the metric-pin feature ───────────────────────
    // Long-press activation means taps on cells still pass through to the
    // existing offshore `gridOnClick` handler (model comparison matrix).
    // Only when the user HOLDS a cell for 250ms + moves > 8px does a drag
    // begin. Dropping it on the hero slot writes `settings.heroMetric`,
    // which the render-swap logic (shipped in Phase 1) already handles.
    const updateHeroSettings = useSettingsStore((s) => s.updateSettings);
    // Long-press relay: a dnd hold that releases without displacement is
    // treated as a long-press on that metric cell (see handleDndDragEnd) and
    // opens the model convergence chart via HeroWidgets.
    const [spreadMetric, setSpreadMetric] = useState<string | null>(null);
    const handleSpreadHandled = useCallback(() => setSpreadMetric(null), []);
    const dndSensors = useSensors(
        useSensor(PointerSensor, {
            activationConstraint: { delay: 250, tolerance: 8 },
        }),
        useSensor(TouchSensor, {
            activationConstraint: { delay: 250, tolerance: 8 },
        }),
    );
    // Haptic choreography across the drag lifecycle:
    //   drag start  → light tick   ("the cell is alive in your hand now")
    //   drag over   → medium tick  ("you're over a valid drop zone")
    //   drag end OK → medium tick  ("pinned")
    // Each transition is debounced via a ref so rapid finger movement
    // doesn't fire the same haptic twice per drag.
    const dragHapticRef = useRef<{ startFired: boolean; lastOver: string | null }>({
        startFired: false,
        lastOver: null,
    });

    const handleDndDragStart = useCallback((_event: DragStartEvent) => {
        dragHapticRef.current = { startFired: true, lastOver: null };
        triggerHaptic('light');
    }, []);

    const handleDndDragOver = useCallback((event: DragOverEvent) => {
        const overId = event.over?.id ? String(event.over.id) : null;
        // Only fire when the drop target actually changes — prevents a
        // buzz every frame the finger hovers inside the drop zone.
        if (overId !== dragHapticRef.current.lastOver) {
            dragHapticRef.current.lastOver = overId;
            if (overId === 'hero-pin-slot') {
                triggerHaptic('medium');
            }
        }
    }, []);

    const handleDndDragEnd = useCallback(
        (event: DragEndEvent) => {
            // Reset haptic tracking for the next drag
            dragHapticRef.current = { startFired: false, lastOver: null };
            const { active, over, delta } = event;
            if (!over || over.id !== 'hero-pin-slot') {
                // A hold that ended with no meaningful displacement is a
                // LONG-PRESS, not an abandoned drag — open the model
                // convergence chart pre-tabbed to that cell's metric. Real
                // drags that miss the pin slot have travelled well past 10px.
                const dist = Math.hypot(delta?.x ?? 0, delta?.y ?? 0);
                if (dist < 10 && active?.id) {
                    triggerHaptic('medium');
                    setSpreadMetric(String(active.id));
                }
                return;
            }
            const droppedMetric = String(active.id);
            // Valid drop IDs are the 10 grid metric IDs or 'temp' for reset
            const valid = [
                'wind',
                'dir',
                'gust',
                'wave',
                'period',
                'uv',
                'vis',
                'pressure',
                'humidity',
                'rain',
                'temp',
            ];
            if (!valid.includes(droppedMetric)) return;
            updateHeroSettings({ heroMetric: droppedMetric });
            triggerHaptic('medium');
        },
        [updateHeroSettings],
    );

    useEffect(() => {
        if (!data?.coordinates) return;
        const { lat, lon } = data.coordinates;
        // A name-only location pick briefly publishes an optimistic report
        // stubbed at {0,0} (WeatherContext selectLocation) until geocoding
        // lands. Never fetch — or cache — rain for Null Island; but DO clear:
        // this stub carries the NEW location's name, so the old place's rain
        // must come off the screen now, not when geocoding finishes.
        if (lat === 0 && lon === 0) {
            rainLocRef.current = null;
            setMinutelyRain([]);
            setRainSummary('');
            setRainSource('unknown');
            setRainStatus('loading');
            return;
        }
        let cancelled = false;

        const locKey = `${lat.toFixed(2)}_${lon.toFixed(2)}`;
        if (rainLocRef.current !== locKey) {
            // Different place: the old place's frames must not sit on screen
            // under the new name while the fetch runs.
            rainLocRef.current = locKey;
            setMinutelyRain([]);
            setRainSummary('');
            setRainSource('unknown');
        }
        setRainStatus('loading');

        // 10-min cache + 10-min refresh, matched to Rainbow.ai's own model
        // refresh cadence — fresher buys nothing, staler throws away exactly
        // the nowcast accuracy the card exists for. Quota is not the
        // constraint it was assumed to be: Rainbow bills $0.10 per 1,000
        // requests after a 5k/month free tier, so even fifty punters glued to
        // Glass all day cost of the order of $10/month. (The previous 30-min
        // ration let displayed frames age ~59 min, at which point the card
        // was analysing the past.)
        const RAIN_CACHE_TTL_MS = 10 * 60 * 1000;
        const RAIN_REFRESH_INTERVAL_MS = 10 * 60 * 1000;

        const source = isSkipper ? 'rainbow' : 'wk';
        const cacheKey = `thalassa_rain_${source}_${lat.toFixed(2)}_${lon.toFixed(2)}`;

        // Freshness of what is on screen — drives the wake/visibility refresh.
        let lastGoodTs = 0;
        // One rain fetch at a time: on wake, the visibility handler, an
        // overdue interval tick and a generatedAt re-run can all fire within
        // seconds — without this flag that was three paid requests for one
        // answer (review, 2026-08-20).
        let inFlight = false;

        const applyResult = (rain: MinutelyRain[], summary: string, src: 'rainbow' | 'weatherkit'): void => {
            if (cancelled) return;
            if (rain.length > 0) {
                lastGoodTs = Date.now();
                setMinutelyRain(rain);
                setRainSummary(summary);
                setRainSource(src);
                setRainStatus('loaded');
                log.info(`[rain] source=${src} minutes=${rain.length} summary="${summary}"`);
                writePlaintextWeatherCacheItem(
                    cacheKey,
                    JSON.stringify({ ts: Date.now(), data: rain, summary, source: src }),
                );
            } else {
                applyFallback();
                log.warn(
                    `[rain] both APIs returned empty — fallback=${precipRef.current >= 0.5 ? 'synthetic' : 'none'}`,
                );
            }
        };

        const applyFallback = (): void => {
            if (cancelled) return;
            const fallback = synthesizeFromHourly();
            setMinutelyRain(fallback);
            setRainSource(fallback.length > 0 ? 'synthetic' : 'unknown');
            setRainStatus(fallback.length > 0 ? 'loaded' : 'error');
        };

        const doFetch = (): void => {
            if (inFlight) return;
            inFlight = true;
            fetchRainData(lat, lon, isSkipper, () => cancelled, applyResult)
                .catch(() => {
                    if (!cancelled) applyFallback();
                })
                .finally(() => {
                    inFlight = false;
                });
        };

        /** Refetch only when the on-screen frame has outlived the TTL.
         *  30 s of grace so an interval tick arriving a few ms early (timer
         *  jitter) cannot conclude "still fresh" and push staleness to 20 min. */
        const refreshIfStale = (): void => {
            if (!canRefreshRainForecast(document.hidden, useUIStore.getState().isOffline, cancelled)) return;
            if (Date.now() - lastGoodTs < RAIN_CACHE_TTL_MS - 30_000) return;
            doFetch();
        };

        /** Wake refresh: reopening the app after it was backgrounded used to
         *  leave the card on whatever frame it fell asleep with until the
         *  next interval tick — the exact window where a fully-elapsed feed
         *  pinned a false "Rain in 1 min". */
        const onVisibilityChange = (): void => {
            if (!document.hidden) refreshIfStale();
        };

        const startTimers = (): (() => void) => {
            const rainTimer = setInterval(refreshIfStale, RAIN_REFRESH_INTERVAL_MS);
            document.addEventListener('visibilitychange', onVisibilityChange);
            return () => {
                cancelled = true;
                clearInterval(rainTimer);
                document.removeEventListener('visibilitychange', onVisibilityChange);
            };
        };

        const cached = readPlaintextWeatherCacheItem(cacheKey);
        if (cached) {
            try {
                const {
                    ts,
                    data: cachedData,
                    summary: cachedSummary,
                    source: cachedSource,
                } = JSON.parse(cached) as {
                    ts: number;
                    data: MinutelyRain[];
                    summary?: string;
                    source?: 'rainbow' | 'weatherkit';
                };
                // Same 30 s epsilon as refreshIfStale: accepting a 9 m 59 s
                // cache here and then TTL-gating the next tick let staleness
                // stack to ~2x TTL across a generatedAt re-run.
                if (Date.now() - ts < RAIN_CACHE_TTL_MS - 30_000 && cachedData.length > 0) {
                    lastGoodTs = ts;
                    setMinutelyRain(cachedData);
                    if (cachedSummary) setRainSummary(cachedSummary);
                    if (cachedSource) setRainSource(cachedSource);
                    setRainStatus('loaded');
                    // A recent cached nowcast remains useful while offline, but
                    // no network timer should run until the reachability probe
                    // explicitly clears the authoritative offline flag.
                    if (isOffline) {
                        return () => {
                            cancelled = true;
                        };
                    }
                    // Fresh cache: timers only, skip the initial fetch.
                    return startTimers();
                }
            } catch (e) {
                log.warn('corrupted cache, continue with fresh fetch:', e);
            }
        }

        if (isOffline) {
            // An expired minutely feed cannot honestly be shifted forward in
            // time. Leave the rain product unavailable; the main weather cache
            // and global staleness banner remain visible independently.
            setMinutelyRain([]);
            setRainSummary('');
            setRainSource('unknown');
            setRainStatus('error');
            return () => {
                cancelled = true;
            };
        }

        // ── Unified rain fetch: Rainbow.ai for Skipper, WeatherKit for others ──
        doFetch();
        return startTimers();

        // Synthesize 60 minutely entries from the current hour's precipitation
        // Uses ref to avoid stale closure over current?.precipitation
        function synthesizeFromHourly(): MinutelyRain[] {
            const precip = precipRef.current;
            if (precip < 0.5) return []; // Below threshold — don't show false rain
            const now = new Date();
            return Array.from({ length: 60 }, (_, i) => ({
                time: new Date(now.getTime() + i * 60000).toISOString(),
                intensity: precip,
            }));
        }
        // data?.generatedAt piggybacks the rain refresh onto every Glass
        // weather refresh (pull-to-refresh, wake refetch): the effect re-runs,
        // the TTL guard decides whether a request actually goes out.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [data?.coordinates?.lat, data?.coordinates?.lon, data?.generatedAt, isOffline, isSkipper]);

    // Stable scroll callbacks that batch state updates via rAF
    const handleTimeSelect = useCallback((time: number | undefined) => {
        // Only update selectedTime for TideWidget — no need to re-render carousel
        setSelectedTime(time);
    }, []);

    // Raw slide index. Set directly rather than through the rAF batch: it only
    // gates a text label, and batching it behind activeHour would let the two
    // disagree for a frame — showing "00:00 - 01:00" on the overview card as it
    // settles, which is the exact artefact this exists to remove.
    const handleSlideIndexChange = useCallback((idx: number) => {
        setActiveSlideIdx(idx);
    }, []);

    const handleDayChange = useCallback((day: number) => {
        activeDayRef.current = day;
        if (!rafIdRef.current) {
            rafIdRef.current = requestAnimationFrame(() => {
                rafIdRef.current = null;
                setActiveDay(activeDayRef.current);
                setActiveHour(activeHourRef.current);
            });
        }
    }, []);

    const handleHourChange = useCallback((hour: number) => {
        activeHourRef.current = hour;
        if (!rafIdRef.current) {
            rafIdRef.current = requestAnimationFrame(() => {
                rafIdRef.current = null;
                setActiveDay(activeDayRef.current);
                setActiveHour(activeHourRef.current);
            });
        }
    }, []);

    const handleActiveDataChange = useCallback((newData: SourcedWeatherMetrics) => {
        activeDayDataRef.current = newData;
        if (!rafIdRef.current) {
            rafIdRef.current = requestAnimationFrame(() => {
                rafIdRef.current = null;
                setActiveDayData(activeDayDataRef.current);
                setActiveDay(activeDayRef.current);
                setActiveHour(activeHourRef.current);
            });
        }
    }, []);

    // Why the day on screen has an empty grid past the model's range, as the
    // carousel reports it. The 24-dot hour row it once also gated is gone: the
    // 12-dot day rail is the one page indicator, and the hero header already
    // names the hour (UX scorecard run 8).
    const [shownDayRangeNote, setShownDayRangeNote] = useState<string | null>(null);
    const handleShownDayChange = useCallback((day: ShownGlassDay) => {
        setShownDayRangeNote(day.rangeNote);
    }, []);

    // One tap from a later day back to today's live card: the same reset a
    // second tap on The Glass tab performs (UX scorecard run 7).
    const handleReturnToToday = useCallback(() => {
        triggerHaptic('light');
        window.dispatchEvent(new Event('hero-reset-scroll'));
    }, []);

    // Every reset to live/now — this Today control, a second tap on The Glass
    // tab — clears the header's day as the collapse path does, refs as well as
    // state. The carousel's reset fires handleDayChange first, and its pending
    // rAF flushes only day and hour, so today's card data arriving behind it
    // was dropped: the header read live over the later day's numbers
    // (measured 2026-09-27: 24 °C and '--' pressure from Wed, marked live).
    useEffect(() => {
        const onReset = () => {
            activeDayRef.current = 0;
            activeHourRef.current = 0;
            activeDayDataRef.current = null;
            setActiveDay(0);
            setActiveHour(0);
            setActiveDayData(null);
        };
        window.addEventListener('hero-reset-scroll', onReset);
        return () => window.removeEventListener('hero-reset-scroll', onReset);
    }, []);

    // Landscape: the column scrolls, but its first view ends on the grid with
    // the rain strip, tide card and footer all below the fold and nothing to
    // say so. A fade and chevron show until the column's end is on screen.
    const landscapeEndRef = useRef<HTMLDivElement | null>(null);
    const [landscapeMoreBelow, setLandscapeMoreBelow] = useState(false);
    const landscapeCueActive = landscapeFlow && props.viewMode !== 'details';
    useEffect(() => {
        const end = landscapeEndRef.current;
        if (!landscapeCueActive || !end || typeof IntersectionObserver === 'undefined') {
            setLandscapeMoreBelow(false);
            return;
        }
        const io = new IntersectionObserver(([entry]) => setLandscapeMoreBelow(!entry.isIntersecting));
        io.observe(end);
        return () => io.disconnect();
        // data/current: the column (and so the sentinel) mounts once they land.
    }, [landscapeCueActive, data, current]);

    // PERFORMANCE: Memoize expensive inline computations that were previously IIFEs
    const widgetCardTime = useMemo(() => {
        if (activeDay === 0 && activeHour === 0) return Date.now();
        const now = new Date();
        if (activeDay === 0) {
            return new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + activeHour).getTime();
        } else {
            const forecast = data?.forecast?.[activeDay];
            if (forecast?.isoDate) {
                const [y, m, d] = forecast.isoDate.split('-').map(Number);
                return new Date(y, m - 1, d, activeHour).getTime();
            }
        }
        return Date.now();
    }, [activeDay, activeHour, data?.forecast]);

    // Essential mode resets activeDayData to null so safeActive falls
    // back to `current` (live hour metrics). Resolve today's high/low once
    // in the forecast location's timezone, matching the Hero row. Previously
    // this simply used forecast[0], which could be yesterday/tomorrow for a
    // device in a different timezone (or a WeatherKit UTC-labelled entry).
    const safeActive = useMemo(() => {
        if (activeDayData) return activeDayData;
        if (!current) return current;
        const temperatures = resolveHeroRowTemperatureRange(current, data?.forecast ?? [], hourly ?? [], {
            timeZone: data?.timeZone,
            referenceTime: Date.now(),
            preferForecast: true,
            allowLeadingPreviousDayFallback: true,
        });
        return {
            ...current,
            highTemp: temperatures.highTemp,
            lowTemp: temperatures.lowTemp,
        };
    }, [activeDayData, current, data?.forecast, data?.timeZone, hourly]);

    const widgetSources = useMemo(() => {
        return activeDay === 0 && activeHour === 0 ? current?.sources : safeActive?.sources;
    }, [activeDay, activeHour, current, safeActive]);

    // Compute day/night for the active card time (fixes "Sunny" at midnight).
    // The hero card's reader, so the polar words ('Sun stays up' / 'Sun stays
    // down', W1-06) and the HH:MM times are read one way on the whole Glass.
    const isActiveDay = useMemo(() => {
        if (!safeActive) {
            const h = new Date(widgetCardTime).getHours();
            return h >= 6 && h < 18;
        }
        return computeSunPhase(safeActive, widgetCardTime).isDay;
    }, [safeActive, widgetCardTime]);

    // Memoize nextUpdate — compute the next scheduled wall-clock refresh time
    const nextUpdateTime = useMemo(() => {
        const now = new Date();
        const intervalMs = refreshInterval;
        const intervalMin = intervalMs / 60000;

        // Compute next aligned time based on interval
        if (intervalMin >= 60) {
            const next = new Date(now);
            next.setMinutes(0, 0, 0);
            next.setHours(next.getHours() + 1);
            return next.getTime();
        } else if (intervalMin === 30) {
            const next = new Date(now);
            const currentMin = next.getMinutes();
            if (currentMin < 30) {
                next.setMinutes(30, 0, 0);
            } else {
                next.setMinutes(0, 0, 0);
                next.setHours(next.getHours() + 1);
            }
            return next.getTime();
        } else {
            if (!data?.generatedAt) return Date.now() + intervalMs;
            const next = new Date(data.generatedAt);
            next.setMinutes(next.getMinutes() + intervalMin);
            if (next.getTime() <= now.getTime()) {
                const nextFromNow = new Date(now);
                const currentMin = nextFromNow.getMinutes();
                const nextSlot = Math.ceil(currentMin / intervalMin) * intervalMin;
                nextFromNow.setMinutes(nextSlot, 0, 0);
                if (nextFromNow.getTime() <= now.getTime()) {
                    nextFromNow.setMinutes(nextFromNow.getMinutes() + intervalMin);
                }
                return nextFromNow.getTime();
            }
            return next.getTime();
        }
    }, [data?.generatedAt, refreshInterval]);

    // Extract beacon and buoy names from live sources for StatusBadges
    const { beaconName, buoyName } = useMemo(() => {
        let beacon = '';
        let buoy = '';
        const liveSources = current?.sources;
        if (liveSources) {
            Object.values(liveSources).forEach((src) => {
                const s = src as { source?: string; sourceName?: string };
                if (s?.source === 'beacon' && s?.sourceName && !beacon) {
                    beacon = s.sourceName;
                } else if (s?.source === 'buoy' && s?.sourceName && !buoy) {
                    buoy = s.sourceName;
                }
            });
        }
        return { beaconName: beacon, buoyName: buoy };
    }, [current]);

    const widgetTrends = useMemo(() => {
        if (!hourly || hourly.length < 2 || !safeActive) return undefined;
        const nextHour = hourly[1];
        const trends: Record<string, 'up' | 'down' | 'stable'> = {};

        const compare = (
            currentVal: number | null | undefined,
            next: number | null | undefined,
            threshold = 0.5,
        ): 'up' | 'down' | 'stable' => {
            if (currentVal == null || next == null) return 'stable';
            const diff = next - currentVal;
            if (Math.abs(diff) < threshold) return 'stable';
            return diff > 0 ? 'up' : 'down';
        };

        trends['windSpeed'] = compare(safeActive.windSpeed, nextHour.windSpeed, 0.5);
        trends['windGust'] = compare(safeActive.windGust, nextHour.windGust, 0.5);
        trends['waveHeight'] = compare(safeActive.waveHeight, nextHour.waveHeight, 0.1);
        trends['waterTemperature'] = compare(safeActive.waterTemperature, nextHour.waterTemperature, 0.2);
        trends['pressure'] = compare(safeActive.pressure, nextHour.pressure, 0.3);
        trends['visibility'] = compare(safeActive.visibility, nextHour.visibility, 0.5);

        return trends;
    }, [hourly, safeActive]);

    // Which arrows earn red. The alarm colour used to fire on any change, so a
    // 3 kt breeze rising to 4 and the barometer easing at 1026 hPa were drawn
    // as warnings (UX scorecard run 9). Red is kept for a threshold crossed:
    // wind rising to 15 kt, gusts to 20 kt, sea to 2 m, visibility falling
    // under 2 nm, and a 3 hPa fall over three hours (the gale line, see
    // utils/barometerTendency). Internal units: kt, ft, km, hPa. Live card
    // only: the trends read now against the coming hours, which says nothing
    // about a later card's own hour.
    const widgetTrendAlarms = useMemo(() => {
        if (activeDay !== 0 || activeHour !== 0) return undefined;
        if (!widgetTrends || !hourly || hourly.length < 2 || !safeActive) return undefined;
        const nextHour = hourly[1];
        const risesTo = (now: number | null | undefined, next: number | null | undefined, limit: number) =>
            now != null && next != null && next > now && next >= limit;
        const fallsBelow = (now: number | null | undefined, next: number | null | undefined, limit: number) =>
            now != null && next != null && next < now && next < limit;
        const inThreeHours = hourly[3]?.pressure;
        return {
            windSpeed: widgetTrends.windSpeed === 'up' && risesTo(safeActive.windSpeed, nextHour.windSpeed, 15),
            windGust: widgetTrends.windGust === 'up' && risesTo(safeActive.windGust, nextHour.windGust, 20),
            waveHeight: widgetTrends.waveHeight === 'up' && risesTo(safeActive.waveHeight, nextHour.waveHeight, 6.56),
            visibility:
                widgetTrends.visibility === 'down' && fallsBelow(safeActive.visibility, nextHour.visibility, 3.704),
            pressure:
                widgetTrends.pressure === 'down' &&
                safeActive.pressure != null &&
                inThreeHours != null &&
                safeActive.pressure - inThreeHours >= 3,
        };
    }, [activeDay, activeHour, widgetTrends, hourly, safeActive]);

    // Helper to generate proper date labels
    //
    // Derive purely from dayIndex (row position in the vertical carousel),
    // NOT from `data.forecast[dayIndex].isoDate`. Hero.tsx's dayRows[] is
    // sorted + deduped so row 0 = today, row 1 = tomorrow, row N = today + N.
    // But `data.forecast` is the raw provider array — if any provider
    // front-loads yesterday or today (common UTC-offset quirk: e.g. the
    // first WeatherKit daily entry has yesterday's UTC date because it
    // represents local-today and the day is still before UTC midnight),
    // `data.forecast[1]` resolves to today and the label reads "Fri 24"
    // on a row that actually contains tomorrow's data.
    //
    // Since the carousel is guaranteed chronological, the label is purely
    // a function of the row's position relative to today.
    const getDateLabel = (dayIndex: number): string => {
        if (dayIndex === 0) return 'TODAY';
        const d = new Date();
        d.setDate(d.getDate() + dayIndex);
        return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    };

    // Helper to generate time label for active hour
    const getTimeLabel = (): string => {
        if (activeDay === 0 && activeHour === 0) {
            // Live card - show current hour
            const now = new Date();
            const currentHour = now.getHours();
            const nextHour = (currentHour + 1) % 24;
            return `${String(currentHour).padStart(2, '0')}:00 - ${String(nextHour).padStart(2, '0')}:00`;
        }

        // DAY-OVERVIEW slide: a forecast day opens on a whole-day summary, and
        // that card is an AVERAGE — it stands for no particular hour, so an hour
        // range on it is simply false (Shane 2026-07-18). Every OTHER card keeps
        // its range: overview, then 00:00-01:00, 01:00-02:00, … as you swipe
        // (Shane 2026-07-19).
        //
        // Keyed on the RAW slide index, not the hour: the overview and 00:00 both
        // report hour 0, so an hour test cannot separate them.
        if (activeDay > 0 && activeSlideIdx === 0) return '';

        // For other hours, calculate based on activeHour index
        // For TODAY: activeHour 0 = NOW, 1 = next hour, etc.
        // For FORECAST days: activeHour 0 = 00:00, 1 = 01:00, etc.
        if (activeDay === 0) {
            // TODAY - offset by current hour
            const now = new Date();
            const currentHour = now.getHours();
            const hour = (currentHour + activeHour) % 24;
            const nextHour = (hour + 1) % 24;
            return `${String(hour).padStart(2, '0')}:00 - ${String(nextHour).padStart(2, '0')}:00`;
        } else {
            // FORECAST - start from midnight
            const hour = activeHour;
            const nextHour = (hour + 1) % 24;
            return `${String(hour).padStart(2, '0')}:00 - ${String(nextHour).padStart(2, '0')}:00`;
        }
    };

    // Use Global Settings for Units
    // Fallback to defaults only if settings are missing (rare)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const units: UnitPreferences = settings?.units || {
        speed: 'kts',
        length: 'ft',
        waveHeight: 'ft',
        temp: 'C',
        distance: 'nm',
        tideHeight: 'm',
    };

    const contextValue = React.useMemo(
        () => ({
            current,
            forecast: data?.forecast,
            hourly,
            tides: data?.tides || [],
            tideHourly: data?.tideHourly || [],
            boatingAdvice: boatingAdvice || '',
            lockerItems: lockerItems,
            // WeatherContext owns GPS-follow naming and updates this snapshot
            // without starting the background-location engine at launch.
            locationName: data?.locationName,
            timeZone: data?.timeZone,
            modelUsed: data?.modelUsed,
            isLandlocked: isLandlocked,
            locationType: data?.locationType,
            isPro: isPro,

            units: units,

            // UI State
            isSpeaking: isPlaying,
            isBuffering: false,
            isAudioPreloading: false,
            isNightMode: props.isNightMode,
            backgroundUpdating: props.isRefreshing || false,
            handleAudioBroadcast: handleAudioBroadcast,
            shareReport: shareReport,
            onTriggerUpgrade: props.onTriggerUpgrade,
            onOpenMap: props.onOpenMap,

            settings: {},
            weatherData: data,
            tideGUIDetails: data?.tideGUIDetails,
        }),
        [
            current,
            data,
            hourly,
            boatingAdvice,
            lockerItems,
            isLandlocked,
            isPro,
            units,
            props.isNightMode,
            props.isRefreshing,
            isPlaying,
            handleAudioBroadcast,
            shareReport,
            props.onTriggerUpgrade,
            props.onOpenMap,
        ],
    );

    const moon = getMoonPhase(new Date(widgetCardTime));

    // GUARD: All hooks above, early return here is safe
    if (!data || !current || !safeActive) {
        return (
            <div className="h-dvh w-full flex flex-col items-center justify-center bg-slate-950 text-white px-4 py-8">
                {/* isOffline (internetProbe-verified WAN reachability), NOT
                    navigator.onLine. On a boat the phone is joined to the Pi's
                    wifi LAN, so navigator.onLine reads TRUE while the uplink is
                    dead — and this screen sat on "Loading conditions…" forever
                    instead of saying there was no connection. The probe is the
                    only thing that knows the difference, and it was already
                    being read three lines from here for the staleness banner.

                    The fetch guards further up deliberately still use
                    navigator.onLine: there, "the OS says there is no network at
                    all" is the cheap conservative check, and a probe
                    false-positive must not stop us trying the Pi. */}
                {isOffline ? (
                    <div className="text-center max-w-xs">
                        <div className="w-10 h-10 mx-auto mb-5 rounded-full bg-white/5 border border-white/10 flex items-center justify-center">
                            <svg
                                className="w-5 h-5 text-white/70"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={1.5}
                            >
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    d="M8.288 15.038a5.25 5.25 0 017.424 0M5.106 11.856c3.807-3.808 9.98-3.808 13.788 0M1.924 8.674c5.565-5.565 14.587-5.565 20.152 0"
                                />
                                <line x1="4" y1="4" x2="20" y2="20" strokeLinecap="round" />
                            </svg>
                        </div>
                        <p className="text-base text-white/80 font-medium mb-1">No connection</p>
                        <p className="text-sm text-white/60 leading-relaxed">Cached data will appear when available</p>
                    </div>
                ) : (
                    /* Full-width skeleton mirroring the real dashboard column:
                       hero card on top, sub-card, then a short list — same
                       widths the loaded layout paints (full-bleed with px-4). */
                    <div className="w-full max-w-2xl mx-auto space-y-4">
                        <ShimmerBlock variant="hero" />
                        <ShimmerBlock variant="card" />
                        <ShimmerBlock variant="list" rows={3} />
                        <p className="text-sm text-white/40 font-medium text-center mt-4">Loading conditions…</p>
                    </div>
                )}
            </div>
        );
    }

    return (
        <DashboardWidgetContext.Provider value={contextValue as DashboardWidgetContextType}>
            <DndContext
                sensors={dndSensors}
                onDragStart={handleDndDragStart}
                onDragOver={handleDndDragOver}
                onDragEnd={handleDndDragEnd}
            >
                {/* ── OFFSHORE BOUNDARY TOAST ── */}
                <OffshoreBoundaryToast visible={offshore.justCrossed} modelName={offshore.offshoreModel} />

                {/* First-time tutorial coach marks — shows once per install
                (gated internally via localStorage) with 3 slides covering
                chevron → Essential mode + horizontal hour swipe + vertical
                day swipe gestures. */}
                <Suspense fallback={null}>
                    <GlassTutorial />
                </Suspense>

                <div
                    className={`${landscapeFlow ? 'min-h-dvh' : 'h-dvh overflow-hidden'} w-full flex flex-col relative bg-slate-950`}
                    // Which glassLayout rhythm is in force, for cards that must size
                    // themselves to its trimmed slots (warnings row 32, conditions
                    // header 56) via Tailwind's in-data-[glass-rhythm=…] variants.
                    data-glass-rhythm={shortPortrait ? 'short' : landscapeFlow ? 'landscape' : undefined}
                >
                    {' '}
                    {/* Flex Root */}
                    {/* ── REFRESH IN PROGRESS ──
                        This used to be a full-screen backdropFilter: blur(8px).
                        The reasoning was sound — do not let anyone read a number
                        that is about to change — but the premise had rotted: the
                        comment claimed "the fetch now lands in under 3 s", while
                        the pipeline waits on Promise.allSettled over five members
                        each bounded at 8 s, and staleRefresh was only cleared in
                        that pipeline's finally. So on an ordinary morning the
                        cached report was decrypted and painted in ~80-400 ms and
                        then deliberately made UNREADABLE for another 1-3 s, and
                        up to 8-16 s in the worst case. That is what "taking ages
                        to connect the weather" actually was: the data was there
                        the whole time (Shane 2026-08-13).

                        The staleness SIGNAL is not lost — it was never the only
                        one. StalenessBanner carried that job until 2026-08-13,
                        when Shane removed it — "it is there regardless now, and
                        it is staying on the screen because the weather is 2 hrs
                        old" — a permanent warning being no warning at all. The
                        remaining signals are the amber offline pill beside the
                        location, and the forecast-model pill, which already
                        pulses while a refresh is in flight and tints red when
                        the last one failed. So the signal is LABELLING, not
                        OBSCURING: this bar says "updating" while the numbers
                        stay legible, which is what a skipper glancing at wind
                        speed actually needs.

                        pointer-events-none: it must never eat a tap. */}
                    {staleRefresh && (
                        <div
                            className="absolute inset-x-0 top-0 z-200 h-0.5 overflow-hidden pointer-events-none"
                            aria-hidden="true"
                        >
                            <div className="h-full w-full animate-pulse bg-linear-to-r from-transparent via-sky-400/70 to-transparent" />
                        </div>
                    )}
                    {/* ── THE STALENESS PILL (Shane, 2026-08-20) ──
                        "if the data is stale, it should show a small message in
                        the middle of the screen … beautifully laid out and not
                        some horrible toast message."

                        Third design in the staleness lineage, deliberately:
                        the permanent banner was removed 2026-08-13 ("it is
                        there regardless now" — a warning that never leaves is
                        no warning), and the full-screen blur before it hid
                        data that was already painted. This one earns its
                        moment: it appears ONLY while BOTH are true — the
                        painted report is over an hour old AND a refresh is
                        actually in flight — and the refresh pipeline's finally
                        dismisses it, so it cannot become wallpaper. It labels;
                        it never obscures; it eats no taps. Age, not the word
                        "stale": age is honest and self-calibrating, a
                        judgement invites arguing with the app. */}
                    {(() => {
                        const ageMs = data?.generatedAt ? Date.now() - Date.parse(data.generatedAt) : 0;
                        const ageMin = Math.floor(ageMs / 60_000);
                        if (!(staleRefresh && ageMin >= 60)) return null;
                        const ageLabel = ageMin >= 120 ? `${Math.floor(ageMin / 60)} h` : `${ageMin} min`;
                        return (
                            <div
                                className="absolute inset-x-0 top-[38%] z-210 flex justify-center pointer-events-none animate-in fade-in duration-300"
                                role="status"
                                aria-live="polite"
                            >
                                <div className="flex items-center gap-2.5 rounded-full border border-sky-400/25 bg-slate-950/85 px-4 py-2 shadow-lg shadow-black/40 backdrop-blur-md">
                                    <span
                                        className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-sky-400/30 border-t-sky-300"
                                        aria-hidden="true"
                                    />
                                    <span className="text-[12px] font-semibold tracking-wide text-sky-100/90">
                                        Updated {ageLabel} ago
                                        <span className="text-sky-300/80"> — refreshing…</span>
                                    </span>
                                </div>
                            </div>
                        );
                    })()}
                    {/* 2. Main Content Area */}
                    <div className="flex-1 relative w-full min-h-0">
                        {/* MAIN CAROUSEL / GRID */}
                        {!isDetailMode && (
                            <div
                                className={landscapeFlow ? 'relative w-full' : 'absolute inset-0'}
                                style={
                                    landscapeFlow
                                        ? {
                                              // badges top + badge row + a breath, so the column scrolls to the footer
                                              minHeight: glassSafeTopOffset(
                                                  (isExpanded
                                                      ? glassTopLayout.heroContainerExpandedTopPx
                                                      : glassTopLayout.heroContainerCollapsedTopPx) +
                                                      landscapeHeroHeightPx +
                                                      glassTopLayout.cardGapPx +
                                                      12 +
                                                      42 +
                                                      24,
                                              ),
                                          }
                                        : undefined
                                }
                            >
                                {/* Compact Header Row - Warnings + Sunrise/Sunset/Rainfall.
                                    It starts one shared Glass gap below the location card. */}
                                <div
                                    className={`shrink-0 z-120 w-full bg-linear-to-b from-slate-950/80 [.display-light_&]:from-slate-200/80 to-transparent px-4 pb-0 ${glassLayerPos} left-0 right-0 pointer-events-none`}
                                    style={{ top: glassSafeTopOffset(glassTopLayout.compactHeaderTopPx) }}
                                >
                                    <div className="pointer-events-auto">
                                        <CompactHeaderRow
                                            alerts={data.alerts}
                                            sunrise={activeDayData?.sunrise || current?.sunrise}
                                            sunset={activeDayData?.sunset || current?.sunset}
                                            moonPhase={moon.emoji}
                                            moonPhaseName={moon.phase}
                                            dashboardMode={userSettings.dashboardMode || 'full'}
                                            onToggleDashboardMode={handleToggleDashboardMode}
                                            onOpenSunMoon={sunMoonPlaced ? openSunMoon : undefined}
                                        />
                                        {sunMoonDay && sunMoonPlaced && (
                                            <Suspense fallback={null}>
                                                <SunMoonSheet
                                                    onClose={closeSunMoon}
                                                    lat={data.coordinates!.lat}
                                                    lon={data.coordinates!.lon}
                                                    timeZone={data.timeZone}
                                                    isoDate={sunMoonDay.isoDate}
                                                    isToday={sunMoonDay.isToday}
                                                />
                                            </Suspense>
                                        )}
                                    </div>
                                </div>

                                {/* Covers the fixed card stack until the scrollable forecast deck. */}
                                <div
                                    className={`${glassLayerPos} top-0 left-0 right-0 bg-slate-950 z-100 transition-all duration-300`}
                                    style={{
                                        height: isExpanded
                                            ? glassSafeTopOffset(glassTopLayout.heroContainerExpandedTopPx)
                                            : glassSafeTopOffset(glassTopLayout.heroContainerCollapsedTopPx),
                                    }}
                                ></div>

                                {/* Conditions header — held to the same 8px Glass rhythm.
                                    z-115, one step over the card layers below it: its
                                    first-run coach mark hangs off the card's foot over
                                    the grid instead of sitting on the temperature (UX
                                    scorecard run 7). The card itself stays in its slot. */}
                                <div
                                    className={`${glassLayerPos} left-0 right-0 z-115 px-4`}
                                    style={{ top: glassSafeTopOffset(glassTopLayout.heroHeaderTopPx) }}
                                >
                                    {/* Section headings for VoiceOver's rotor: the Glass
                                        had only its h1, so there was no jumping to the
                                        tides or the forecast source (UX scorecard run 9). */}
                                    <h2 className="sr-only">
                                        {activeDay === 0 && activeHour === 0 ? 'Conditions now' : 'Forecast conditions'}
                                    </h2>
                                    <HeroHeader
                                        data={safeActive}
                                        units={units}
                                        isLive={activeDay === 0 && activeHour === 0}
                                        isDay={isActiveDay}
                                        dateLabel={getDateLabel(activeDay)}
                                        timeLabel={getTimeLabel()}
                                        timeZone={data.timeZone}
                                        sources={safeActive.sources}
                                        isExpanded={isExpanded}
                                        locationType={data.locationType}
                                        onToggleExpand={isInland || isOffshore ? undefined : handleToggleExpand}
                                        onReturnToToday={activeDay > 0 ? handleReturnToToday : undefined}
                                    />
                                </div>

                                {/* CURRENT CONDITIONS CARD - Collapsed mode only.
                                Transition choreography:
                                - 200ms ease-out per user spec (feels crisp, not laggy)
                                - translateY(-14px) gives a perceptible glide without going too
                                  far out of the layout frame
                                - `visibility` REMOVED because it's a binary property that can't
                                  be interpolated — toggling it instantly hid the element
                                  mid-fade, which is exactly why the old swap felt "appeared"
                                  instead of "glided". pointer-events + opacity cover
                                  functional hide; the element is invisible to screen-readers
                                  via opacity:0 and to clicks via pointer-events:none. */}
                                <div
                                    className={`${glassLayerPos} left-0 right-0 z-110 px-4 transition-[opacity,transform] duration-200 ease-out`}
                                    aria-hidden={isExpanded}
                                    ref={(element) => {
                                        if (element)
                                            (element as HTMLDivElement & { inert: boolean }).inert = isExpanded;
                                    }}
                                    style={{
                                        top: glassSafeTopOffset(glassTopLayout.primaryCardTopPx),
                                        opacity: !isExpanded ? 1 : 0,
                                        transform: !isExpanded ? 'translateY(0)' : 'translateY(-14px)',
                                        pointerEvents: !isExpanded ? 'auto' : 'none',
                                        willChange: 'opacity, transform',
                                    }}
                                >
                                    <CurrentConditionsCard data={current} units={units} timeZone={data.timeZone} />
                                </div>

                                {/* FIXED WIDGETS - Slide down when expanded.
                                Same transition semantics as CurrentConditionsCard above so the
                                two layers cross-fade in sync. */}
                                <div
                                    className={`${glassLayerPos} left-0 right-0 z-110 px-4 transition-[opacity,transform] duration-200 ease-out`}
                                    aria-hidden={!isExpanded}
                                    ref={(element) => {
                                        if (element)
                                            (element as HTMLDivElement & { inert: boolean }).inert = !isExpanded;
                                    }}
                                    style={{
                                        top: glassSafeTopOffset(glassTopLayout.primaryCardTopPx),
                                        opacity: isExpanded ? 1 : 0,
                                        transform: isExpanded ? 'translateY(0)' : 'translateY(-14px)',
                                        pointerEvents: isExpanded ? 'auto' : 'none',
                                        willChange: 'opacity, transform',
                                    }}
                                >
                                    <HeroWidgets
                                        data={safeActive}
                                        units={units}
                                        cardTime={widgetCardTime}
                                        sources={widgetSources}
                                        trends={widgetTrends}
                                        trendAlarms={widgetTrendAlarms}
                                        isLive={activeDay === 0 && activeHour === 0}
                                        locationType={data.locationType}
                                        hourly={hourly}
                                        forecast={data.forecast}
                                        coordinates={data.coordinates}
                                        spreadMetric={spreadMetric}
                                        onSpreadHandled={handleSpreadHandled}
                                        emptyDayNote={activeDay > 0 ? shownDayRangeNote : null}
                                    />
                                </div>

                                {/* HERO CONTAINER - Shifts up when collapsed to reclaim dead space.
                                    Its top is calculated from the rendered card heights so it
                                    preserves the same 8px gap in either dashboard mode. */}
                                <div
                                    className={`${glassLayerPos} left-0 right-0 z-120 bg-slate-950 transition-[top] duration-300 flex flex-col pt-0 ${
                                        // Clipping is fine when there is room. On a short
                                        // viewport the hero would otherwise be a sliver with
                                        // no scroll escape, so let it scroll instead.
                                        glassTopLayout.isShortViewport ? 'overflow-y-auto' : 'overflow-hidden'
                                    }`}
                                    style={{
                                        // Rain card to carousel on the same gap as the rest of
                                        // the stack (6 on a 667 pt phone, where every point of
                                        // tide card counts), not a fixed 8.
                                        gap: `${glassTopLayout.cardGapPx}px`,
                                        top: isExpanded
                                            ? glassSafeTopOffset(glassTopLayout.heroContainerExpandedTopPx)
                                            : glassSafeTopOffset(glassTopLayout.heroContainerCollapsedTopPx),
                                        ...(landscapeFlow
                                            ? { height: `${landscapeHeroHeightPx}px` }
                                            : { bottom: glassHeroBottom }),
                                    }}
                                >
                                    {/* STATIC RAIN FORECAST — always visible */}
                                    <div className="shrink-0 px-4">
                                        <h2 className="sr-only">Rain</h2>
                                        <RainForecastCard
                                            data={minutelyRain}
                                            timeZone={data.timeZone}
                                            rainSummary={rainSummary}
                                            source={rainSource}
                                            status={rainStatus}
                                            // A nowcast: on another day or hour it says 'Right now:'.
                                            isLive={activeDay === 0 && activeHour === 0}
                                            coordinates={data.coordinates}
                                        />
                                    </div>
                                    {/* A day past the model's range holds only its
                                        'Beyond ICON's range' card and no tide, so the
                                        heading says what is there (UX scorecard run 10). */}
                                    <h2 className="sr-only">
                                        {!isExpanded
                                            ? 'Map'
                                            : activeDay > 0 && shownDayRangeNote
                                              ? 'Forecast by day'
                                              : (data.locationType === 'coastal' || data.locationType === 'inshore') &&
                                                  !isLandlocked
                                                ? 'Tides'
                                                : 'Hourly forecast'}
                                    </h2>
                                    <HeroSection
                                        current={current}
                                        forecasts={data.forecast}
                                        units={units}
                                        generatedAt={data.generatedAt}
                                        locationName={props.displayTitle}
                                        tides={data.tides}
                                        tideHourly={data.tideHourly}
                                        timeZone={data.timeZone}
                                        hourly={hourly}
                                        modelUsed={data.modelUsed}
                                        guiDetails={data.tideGUIDetails}
                                        coordinates={data.coordinates}
                                        locationType={data.locationType}
                                        utcOffset={data.utcOffset}
                                        className="px-4"
                                        onTimeSelect={handleTimeSelect}
                                        onDayChange={handleDayChange}
                                        onHourChange={handleHourChange}
                                        onSlideIndexChange={handleSlideIndexChange}
                                        onActiveDataChange={handleActiveDataChange}
                                        isEssentialMode={!isExpanded}
                                        vessel={userSettings.vessel}
                                        minutelyRain={minutelyRain}
                                        forecastModelLabel={forecastModelLabel}
                                        compact={shortPortrait}
                                        onShownDayChange={handleShownDayChange}
                                    />
                                </div>

                                {/* STALENESS BANNER — REMOVED 2026-04-28
                                    User feedback: "the layout stays exactly the
                                    same during no connection times as well as when
                                    connections. can we also remove the No Connection
                                    box. primarily can we ensure that the app looks
                                    the same in both states." The fixed-position
                                    banner sat between the location pill and the
                                    CompactHeaderRow. When offline / stale / errored,
                                    it appeared and visually broke the Glass page's
                                    consistent rhythm. The banner is now retired
                                    from this surface — connection / freshness
                                    diagnostics live in the System Status modal
                                    (the "i" button) where they belong, alongside
                                    the new NMEA rate sparklines. The Glass page
                                    presents the same calm view regardless of
                                    connection state. */}

                                {/* STATIC BADGES - Fixed at bottom, outside hero scroll */}
                                {/* Height is ~42px. Bottom is 74px. Top of badges is 74+42 = 116px.
                                Hero container bottom is 120px.
                                Gap = 120 - 116 = 4px. (Adjusted per user request to be 4px tighter)
                            */}
                                <div
                                    ref={glassFooterRef}
                                    className={`${glassLayerPos} left-0 right-0 z-125 px-4`}
                                    style={
                                        landscapeFlow
                                            ? {
                                                  top: glassSafeTopOffset(
                                                      (isExpanded
                                                          ? glassTopLayout.heroContainerExpandedTopPx
                                                          : glassTopLayout.heroContainerCollapsedTopPx) +
                                                          landscapeHeroHeightPx +
                                                          glassTopLayout.cardGapPx +
                                                          12,
                                                  ),
                                              }
                                            : { bottom: `calc(env(safe-area-inset-bottom) + ${glassFooterBottomPx}px)` }
                                    }
                                >
                                    <h2 className="sr-only">Forecast source</h2>
                                    <div
                                        className={`rounded-xl bg-black/40 ${t.border.default} ${shortPortrait ? 'px-2 py-1' : 'p-2'}`}
                                    >
                                        <StatusBadges
                                            isLandlocked={isLandlocked}
                                            locationName={props.displayTitle || ''}
                                            displaySource={data.modelUsed || 'Model'}
                                            nextUpdate={nextUpdateTime}
                                            fallbackInland={false}
                                            stationId={undefined}
                                            locationType={data.locationType}
                                            beaconName={beaconName}
                                            buoyName={buoyName}
                                            isOffshore={offshore.isOffshore}
                                            sources={widgetSources}
                                            activeData={safeActive}
                                            isLive={activeDay === 0 && activeHour === 0}
                                            modelUsed={data.modelUsed}
                                            generatedAt={data.generatedAt}
                                            coordinates={data.coordinates}
                                        />
                                    </div>
                                </div>

                                {landscapeFlow && (
                                    <>
                                        {/* The column's last pixel: once it is on screen there is
                                            nothing more below, and the fold cue goes. */}
                                        <div
                                            ref={landscapeEndRef}
                                            className="absolute bottom-0 left-0 h-px w-full pointer-events-none"
                                            aria-hidden="true"
                                        />
                                        {landscapeMoreBelow && (
                                            <div
                                                data-testid="glass-fold-cue"
                                                // A solid full-width band with a hairline top,
                                                // not a fade: over the fade the chip sat inside
                                                // the BARO cell, across the grid's bottom border
                                                // and right under '1025' (UX scorecard run 10).
                                                className="fixed inset-x-0 bottom-0 z-130 h-[calc(22px+env(safe-area-inset-bottom))] flex items-center justify-center pb-[env(safe-area-inset-bottom)] bg-slate-950 border-t border-white/12 [.display-light_&]:border-slate-300! pointer-events-none animate-in fade-in duration-300"
                                                aria-hidden="true"
                                            >
                                                {/* Words on a chip of its own: a bare chevron at
                                                    the bottom centre sat in the BARO cell and read
                                                    as a BARO control (UX scorecard run 8). Sky-200
                                                    because daylight takes it to sky-700 (4.7:1 on
                                                    the pale chip); sky-300 goes to sky-600, 3.4:1.
                                                    A 16 pt chip centred on its own 22 pt solid band,
                                                    below the grid's digits: over the grid it read as
                                                    BARO's (runs 9, 10). It bounces twice, then rests. */}
                                                <span
                                                    className="flex items-center gap-1 rounded-full border border-white/10 bg-slate-900/90 py-0 pl-2.5 pr-2 text-xs leading-[14px] font-bold text-sky-200 animate-bounce-subtle"
                                                    style={{ animationIterationCount: 2 }}
                                                >
                                                    More below
                                                    <svg
                                                        viewBox="0 0 24 24"
                                                        fill="none"
                                                        stroke="currentColor"
                                                        strokeWidth="2.5"
                                                        strokeLinecap="round"
                                                        strokeLinejoin="round"
                                                        className="h-3.5 w-3.5"
                                                    >
                                                        <polyline points="6 9 12 15 18 9" />
                                                    </svg>
                                                </span>
                                            </div>
                                        )}
                                    </>
                                )}
                            </div>
                        )}

                        {/* DETAILED GRIDS / LOG PAGE - Full height container for proper internal scrolling */}
                        {isDetailMode && (
                            <div className="absolute inset-0 overflow-hidden">
                                <React.Suspense
                                    fallback={
                                        // Skeleton cards, not text — the house loading
                                        // discipline (see LogPage's own rule).
                                        <div className="h-full bg-slate-950 p-4 space-y-3 overflow-hidden">
                                            {[0, 1, 2, 3].map((i) => (
                                                <div
                                                    key={i}
                                                    className="rounded-2xl bg-white/5 border border-white/6 h-28 animate-pulse"
                                                    style={{ animationDelay: `${i * 120}ms` }}
                                                />
                                            ))}
                                        </div>
                                    }
                                >
                                    <LogPage />
                                </React.Suspense>
                            </div>
                        )}
                    </div>
                </div>
            </DndContext>
        </DashboardWidgetContext.Provider>
    );
});
