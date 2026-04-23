import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { createLogger } from '../utils/createLogger';
import { lazyRetry } from '../utils/lazyRetry';

const log = createLogger('Dashboard');
import { t } from '../theme';
import { useDashboardController } from '../hooks/useDashboardController';
import { triggerHaptic } from '../utils/system';

import { HeroSection } from './dashboard/Hero';
import { CompactHeaderRow } from './dashboard/CompactHeaderRow';
import { StatusBadges } from './dashboard/StatusBadges';
import { StalenessBanner } from './dashboard/StalenessBanner';
import { GlassTutorial } from './dashboard/GlassTutorial';
import { OffshoreBoundaryToast } from './dashboard/OffshoreBoundaryToast';
import { getMoonPhase } from './dashboard/WeatherHelpers';
import { useOffshoreStatus } from '../hooks/useOffshoreStatus';

const LogPage = lazyRetry(() => import('../pages/LogPage').then((m) => ({ default: m.LogPage })), 'LogPage_Dash');
import { HeroHeader } from './dashboard/HeroHeader';
import { HeroWidgets } from './dashboard/HeroWidgets';
import { CurrentConditionsCard } from './dashboard/CurrentConditionsCard';
import { RainForecastCard } from './dashboard/RainForecastCard';
import { ShimmerBlock } from './ui/ShimmerBlock';

import { useSettings } from '../context/SettingsContext';
import { useWeather } from '../context/WeatherContext';
import { useLiveLocationName } from '../hooks/useLiveLocationName';

import { DashboardWidgetContext, DashboardWidgetContextType } from './WidgetRenderer';
import { UnitPreferences, SourcedWeatherMetrics } from '../types';
import { fetchMinutelyRainWithSummary, MinutelyRain } from '../services/weather/api/weatherkit';
import { fetchRainbowPrecip } from '../services/weather/api/rainbowPrecip';
import { useSettingsStore } from '../stores/settingsStore';
import { useUIStore } from '../stores/uiStore';

/**
 * Unified rain data fetcher — routes to Rainbow.ai (Skipper) or WeatherKit (others).
 * Rainbow.ai provides 4-hour forecast at 1km resolution; WeatherKit gives 1-hour minutely.
 */
async function fetchRainData(
    lat: number,
    lon: number,
    useRainbow: boolean,
    cancelled: boolean,
    onData: (rain: MinutelyRain[], summary: string) => void,
): Promise<void> {
    if (cancelled) return;

    if (useRainbow) {
        try {
            const result = await fetchRainbowPrecip(lat, lon);
            if (cancelled) return;
            if (result && result.rain.length > 0) {
                onData(result.rain, result.summary);
                return;
            }
        } catch {
            // Rainbow.ai failed — fall through to WeatherKit
        }
    }

    // WeatherKit fallback (all tiers, or if Rainbow.ai fails)
    const { rain, summary } = await fetchMinutelyRainWithSummary(lat, lon);
    if (!cancelled) {
        onData(rain, summary);
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
        refreshInterval,
        settings,
    } = useDashboardController(props.viewMode);

    // Settings
    const { settings: userSettings, updateSettings } = useSettings();

    // Freshness signals for the StalenessBanner
    const { error: weatherError, backgroundUpdating, loading: weatherLoading, refreshData } = useWeather();

    // Live reverse-geocode of the user's GPS — polls every 10s, only
    // calls the geocoder if the punter has actually moved > 50m since
    // the last update. Gated on LocationStore.source === 'gps' so
    // pinned-map or searched locations aren't overwritten.
    const liveLocationName = useLiveLocationName();

    // Device-level offline signal (navigator.onLine). Flows into the
    // StalenessBanner so the user sees a subtle "No connection" strip
    // even when the cached data is still fresh — previously the banner
    // only surfaced after a fetch attempt actually failed.
    const isOffline = useUIStore((s) => s.isOffline);
    const isInland = data?.locationType === 'inland' || isLandlocked;
    const offshore = useOffshoreStatus(data?.locationType);
    const isOffshore = offshore.isOffshore;
    const isExpanded =
        isInland || isOffshore ? (isOffshore ? true : false) : userSettings.dashboardMode !== 'essential';

    // Derived UI Props
    const isDetailMode = props.viewMode === 'details';
    const [_selectedTime, setSelectedTime] = useState<number | undefined>(undefined);

    // Fixed header state management — refs + state for throttled updates
    // Refs hold the latest value instantly (no re-render). State triggers the UI update.
    const [activeDay, setActiveDay] = useState(0);
    const [activeHour, setActiveHour] = useState(0);
    const [activeDayData, setActiveDayData] = useState<SourcedWeatherMetrics | null>(null);
    const activeDayRef = useRef(0);
    const activeHourRef = useRef(0);
    const activeDayDataRef = useRef<SourcedWeatherMetrics | null>(null);
    const rafIdRef = useRef<number | null>(null);

    // Sync activeDayData ref & state with current when current first loads
    useEffect(() => {
        if (current && !activeDayDataRef.current) {
            activeDayDataRef.current = current;
            setActiveDayData(current);
        }
    }, [current]);

    // Minutely rain data — Rainbow.ai for Skipper tier, WeatherKit fallback for others
    const [minutelyRain, setMinutelyRain] = useState<MinutelyRain[]>([]);
    const [rainSummary, setRainSummary] = useState<string>('');
    const [_rainStatus, setRainStatus] = useState<'loading' | 'loaded' | 'error'>('loading');
    const precipRef = useRef<number>(0);
    precipRef.current = current?.precipitation ?? 0;
    const subscriptionTier = useSettingsStore((s) => s.settings.subscriptionTier);
    const isSkipper = subscriptionTier === 'owner';

    useEffect(() => {
        if (!data?.coordinates) return;
        const { lat, lon } = data.coordinates;
        let cancelled = false;
        setRainStatus('loading');

        // 5-minute local cache key to prevent re-fetch on every remount
        const source = isSkipper ? 'rainbow' : 'wk';
        const cacheKey = `thalassa_rain_${source}_${lat.toFixed(2)}_${lon.toFixed(2)}`;
        const cached = localStorage.getItem(cacheKey);
        if (cached) {
            try {
                const {
                    ts,
                    data: cachedData,
                    summary: cachedSummary,
                } = JSON.parse(cached) as { ts: number; data: MinutelyRain[]; summary?: string };
                if (Date.now() - ts < 5 * 60 * 1000 && cachedData.length > 0) {
                    setMinutelyRain(cachedData);
                    if (cachedSummary) setRainSummary(cachedSummary);
                    setRainStatus('loaded');
                    // Still set up the refresh timer below, but skip initial fetch
                    const rainTimer = setInterval(
                        () => {
                            if (document.hidden) return; // Battery: skip when backgrounded
                            if (!navigator.onLine || cancelled) return;
                            fetchRainData(lat, lon, isSkipper, cancelled, (rain, summary) => {
                                setMinutelyRain(rain);
                                setRainSummary(summary);
                                setRainStatus('loaded');
                                localStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), data: rain, summary }));
                            });
                        },
                        5 * 60 * 1000,
                    );
                    return () => {
                        cancelled = true;
                        clearInterval(rainTimer);
                    };
                }
            } catch (e) {
                log.warn('corrupted cache, continue with fresh fetch:', e);
            }
        }

        // ── Unified rain fetch: Rainbow.ai for Skipper, WeatherKit for others ──
        fetchRainData(lat, lon, isSkipper, cancelled, (rain, summary) => {
            if (rain.length > 0) {
                setMinutelyRain(rain);
                setRainSummary(summary);
                setRainStatus('loaded');
                localStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), data: rain, summary }));
            } else {
                const fallback = synthesizeFromHourly();
                setMinutelyRain(fallback);
                setRainStatus(fallback.length > 0 ? 'loaded' : 'error');
            }
        }).catch(() => {
            if (!cancelled) {
                const fallback = synthesizeFromHourly();
                setMinutelyRain(fallback);
                setRainStatus(fallback.length > 0 ? 'loaded' : 'error');
            }
        });

        // Live refresh every 5 minutes
        const rainTimer = setInterval(
            () => {
                if (document.hidden) return;
                if (!navigator.onLine) return;
                fetchRainData(lat, lon, isSkipper, cancelled, (rain, summary) => {
                    if (rain.length > 0) {
                        setMinutelyRain(rain);
                        setRainSummary(summary);
                        setRainStatus('loaded');
                        localStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), data: rain, summary }));
                    } else {
                        const fallback = synthesizeFromHourly();
                        setMinutelyRain(fallback);
                        setRainStatus(fallback.length > 0 ? 'loaded' : 'error');
                    }
                }).catch(() => {
                    if (!cancelled) {
                        const fallback = synthesizeFromHourly();
                        setMinutelyRain(fallback);
                        setRainStatus(fallback.length > 0 ? 'loaded' : 'error');
                    }
                });
            },
            5 * 60 * 1000,
        );

        return () => {
            cancelled = true;
            clearInterval(rainTimer);
        };

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
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [data?.coordinates?.lat, data?.coordinates?.lon, isSkipper]);

    // Stable scroll callbacks that batch state updates via rAF
    const handleTimeSelect = useCallback((time: number | undefined) => {
        // Only update selectedTime for TideWidget — no need to re-render carousel
        setSelectedTime(time);
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
    // back to `current` (live hour metrics). But `current` doesn't carry
    // daily high/low temps — those live on the forecast entries — so
    // the hi/lo indicators in HeroHeader showed '--' whenever the user
    // toggled to Essential mode. Merge today's high/low from the forecast
    // so the header stays complete regardless of mode.
    const safeActive = useMemo(() => {
        if (activeDayData) return activeDayData;
        if (!current) return current;
        const today = data?.forecast?.[0];
        if (!today) return current;
        return {
            ...current,
            highTemp: current.highTemp ?? today.highTemp,
            lowTemp: current.lowTemp ?? today.lowTemp,
        };
    }, [activeDayData, current, data?.forecast]);

    const widgetSources = useMemo(() => {
        return activeDay === 0 && activeHour === 0 ? current?.sources : safeActive?.sources;
    }, [activeDay, activeHour, current, safeActive]);

    // Compute day/night for the active card time (fixes "Sunny" at midnight)
    const isActiveDay = useMemo(() => {
        const activeData = safeActive;
        if (!activeData) {
            const h = new Date(widgetCardTime).getHours();
            return h >= 6 && h < 18;
        }
        const sRise = activeData.sunrise;
        const sSet = activeData.sunset;
        if (!sRise || !sSet || sRise === '--:--' || sSet === '--:--') {
            const h = new Date(widgetCardTime).getHours();
            return h >= 6 && h < 18;
        }
        try {
            const [rH, rM] = sRise
                .replace(/[^0-9:]/g, '')
                .split(':')
                .map(Number);
            const [sH, sM] = sSet
                .replace(/[^0-9:]/g, '')
                .split(':')
                .map(Number);
            if (isNaN(rH) || isNaN(sH)) {
                const h = new Date(widgetCardTime).getHours();
                return h >= 6 && h < 18;
            }
            const d = new Date(widgetCardTime);
            const rise = new Date(d);
            rise.setHours(rH, rM, 0, 0);
            const set = new Date(d);
            set.setHours(sH, sM, 0, 0);
            return d >= rise && d < set;
        } catch (e) {
            log.warn('Data fetch error:', e);
            const h = new Date(widgetCardTime).getHours();
            return h >= 6 && h < 18;
        }
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

    // Helper to generate proper date labels
    const getDateLabel = (dayIndex: number): string => {
        if (dayIndex === 0) return 'TODAY';

        const forecast = data?.forecast?.[dayIndex];
        if (forecast?.isoDate) {
            const [y, m, day] = forecast.isoDate.split('-').map(Number);
            const d = new Date(y, m - 1, day, 12, 0, 0);
            return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
        }

        return `DAY ${dayIndex + 1}`; // Fallback
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

        // For other hours, calculate based on activeHour index
        // For TODAY: activeHour 0 = NOW, 1 = next hour, etc.
        // For FORECAST days: activeHour 0 = 00:00, 1 = 01:00, etc.
        if (activeDay === 0) {
            // TODAY - offset by current hour
            const now = new Date();
            const currentHour = now.getHours();
            const hour = currentHour + activeHour;
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
            // Prefer the live GPS-derived name when available; fall back
            // to the name baked into the weather snapshot. The live name
            // only resolves when the user is in GPS-follow mode.
            locationName: liveLocationName || data?.locationName,
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
            liveLocationName,
        ],
    );

    // GUARD: All hooks above, early return here is safe
    if (!data || !current || !safeActive) {
        return (
            <div className="h-[100dvh] w-full flex flex-col items-center justify-center bg-black text-white p-8">
                <div className="text-center max-w-xs">
                    {!navigator.onLine ? (
                        <>
                            <div className="w-10 h-10 mx-auto mb-5 rounded-full bg-white/5 border border-white/10 flex items-center justify-center">
                                <svg
                                    className="w-5 h-5 text-white/30"
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
                            <p className="text-sm text-white/40 font-medium mb-1">No connection</p>
                            <p className="text-xs text-white/40 leading-relaxed">
                                Cached data will appear when available
                            </p>
                        </>
                    ) : (
                        <>
                            <div className="px-6 space-y-4 pt-2">
                                <ShimmerBlock variant="hero" />
                                <ShimmerBlock variant="card" />
                                <ShimmerBlock variant="list" rows={3} />
                            </div>
                            <p className="text-sm text-white/40 font-medium text-center mt-4">Loading conditions…</p>
                        </>
                    )}
                </div>
            </div>
        );
    }

    return (
        <DashboardWidgetContext.Provider value={contextValue as DashboardWidgetContextType}>
            {/* ── OFFSHORE BOUNDARY TOAST ── */}
            <OffshoreBoundaryToast visible={offshore.justCrossed} modelName={offshore.offshoreModel} />

            {/* First-time tutorial coach marks — shows once per install
                (gated internally via localStorage) with 3 slides covering
                chevron → Essential mode + horizontal hour swipe + vertical
                day swipe gestures. */}
            <GlassTutorial />

            <div className="h-[100dvh] w-full flex flex-col overflow-hidden relative bg-black">
                {' '}
                {/* Flex Root */}
                {/* ── STALE DATA BLUR OVERLAY ── */}
                {/* Triggers when data is >1hr stale (e.g. waking from overnight sleep).
                    Blurs the entire dashboard so the punter doesn't act on outdated info. */}
                {staleRefresh && (
                    <div
                        className="absolute inset-0 z-[200] flex items-center justify-center pointer-events-none transition-all duration-300"
                        style={{ backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}
                    >
                        <div className="bg-black/60 rounded-2xl px-6 py-4 flex flex-col items-center gap-3 border border-white/10 shadow-2xl pointer-events-auto">
                            <div className="w-6 h-6 border-2 border-sky-400 border-t-transparent rounded-full animate-spin" />
                            <span className="text-sm font-bold text-white/80 uppercase tracking-widest">Updating</span>
                            <span className="text-xs text-white/50">Fetching latest conditions…</span>
                        </div>
                    </div>
                )}
                {/* 2. Main Content Area */}
                <div className="flex-1 relative w-full min-h-0">
                    {/* MAIN CAROUSEL / GRID */}
                    {!isDetailMode && (
                        <div className="absolute inset-0">
                            {/* Compact Header Row - Warnings + Sunrise/Sunset/Rainfall */}
                            {/* App Header height is ~108px. With 18px gap (was 10px + 8px extra), top should be 126px */}
                            <div
                                className="flex-shrink-0 z-[120] w-full bg-gradient-to-b from-black/80 to-transparent px-4 pb-0 fixed left-0 right-0 pointer-events-none"
                                style={{ top: 'calc(max(8px, env(safe-area-inset-top)) + 126px)' }}
                            >
                                <div className="pointer-events-auto">
                                    <CompactHeaderRow
                                        alerts={data.alerts}
                                        sunrise={activeDayData?.sunrise || current?.sunrise}
                                        sunset={activeDayData?.sunset || current?.sunset}
                                        moonPhase={getMoonPhase(new Date(widgetCardTime)).emoji}
                                        dashboardMode={userSettings.dashboardMode || 'full'}
                                        onToggleDashboardMode={() => {
                                            triggerHaptic('light');
                                            const goingEssential = userSettings.dashboardMode !== 'essential';
                                            updateSettings({ dashboardMode: goingEssential ? 'essential' : 'full' });
                                            if (goingEssential) {
                                                // Reset to live so map/widgets show current data
                                                setActiveDay(0);
                                                setActiveHour(0);
                                                setActiveDayData(null);
                                                // Reset horizontal scroll to live position
                                                setTimeout(
                                                    () => window.dispatchEvent(new Event('hero-reset-scroll')),
                                                    10,
                                                );
                                            }
                                        }}
                                    />
                                </div>
                            </div>

                            {/* MAXIMUM BLOCKER - Covers entire gap up to carousel */}
                            <div
                                className="fixed top-[0px] left-0 right-0 bg-black z-[100] transition-all duration-300"
                                style={{
                                    height: isExpanded
                                        ? 'calc(max(8px, env(safe-area-inset-top)) + 420px)'
                                        : 'calc(max(8px, env(safe-area-inset-top)) + 340px)',
                                }}
                            ></div>

                            {/* FIXED HEADER - Positioned 7px below CompactHeaderRow (126 + 40 + 7 = 173) */}
                            <div
                                className="fixed left-0 right-0 z-[110] px-4"
                                style={{ top: 'calc(max(8px, env(safe-area-inset-top)) + 173px)' }}
                            >
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
                                    onToggleExpand={
                                        isInland || isOffshore
                                            ? undefined
                                            : () => {
                                                  triggerHaptic('light');
                                                  const goingEssential = isExpanded; // isExpanded means currently full, so toggling goes to essential
                                                  updateSettings({
                                                      dashboardMode: goingEssential ? 'essential' : 'full',
                                                  });
                                                  if (goingEssential) {
                                                      setActiveDay(0);
                                                      setActiveHour(0);
                                                      setActiveDayData(null);
                                                      // Reset horizontal scroll to live position
                                                      setTimeout(
                                                          () => window.dispatchEvent(new Event('hero-reset-scroll')),
                                                          10,
                                                      );
                                                  }
                                              }
                                    }
                                />
                            </div>

                            {/* CURRENT CONDITIONS CARD - Collapsed mode only (165 + 70 + 8 = 243) */}
                            <div
                                className="fixed left-0 right-0 z-[110] px-4 transition-all duration-300 ease-in-out"
                                style={{
                                    top: 'calc(max(8px, env(safe-area-inset-top)) + 251px)',
                                    opacity: !isExpanded ? 1 : 0,
                                    transform: !isExpanded ? 'translateY(0)' : 'translateY(-10px)',
                                    pointerEvents: !isExpanded ? 'auto' : 'none',
                                    visibility: !isExpanded ? 'visible' : 'hidden',
                                }}
                            >
                                <CurrentConditionsCard data={current} units={units} timeZone={data.timeZone} />
                            </div>

                            {/* FIXED WIDGETS - Slide down when expanded (165 + 70 + 8 = 243) */}
                            <div
                                className="fixed left-0 right-0 z-[110] px-4 transition-all duration-300 ease-in-out"
                                style={{
                                    top: 'calc(max(8px, env(safe-area-inset-top)) + 251px)',
                                    opacity: isExpanded ? 1 : 0,
                                    transform: isExpanded ? 'translateY(0)' : 'translateY(-10px)',
                                    pointerEvents: isExpanded ? 'auto' : 'none',
                                    visibility: isExpanded ? 'visible' : 'hidden',
                                }}
                            >
                                <HeroWidgets
                                    data={safeActive}
                                    units={units}
                                    cardTime={widgetCardTime}
                                    sources={widgetSources}
                                    trends={widgetTrends}
                                    isLive={activeDay === 0 && activeHour === 0}
                                    locationType={data.locationType}
                                    hourly={hourly}
                                />
                            </div>

                            {/* HERO CONTAINER - Shifts up when collapsed to reclaim dead space */}
                            {/* MATH: 
                                Expanded Top: 243 (widgets) + 160 (height) + 9 (gap) = 412px
                                Collapsed Top: 243 (conditions card) + 80 (height) + 9 (gap) = 332px
                            */}
                            <div
                                className="fixed left-0 right-0 z-[120] overflow-hidden bg-black transition-[top] duration-300 flex flex-col gap-[7px] pt-0"
                                style={{
                                    top: isExpanded
                                        ? 'calc(max(8px, env(safe-area-inset-top)) + 420px)'
                                        : 'calc(max(8px, env(safe-area-inset-top)) + 340px)',
                                    bottom: 'calc(env(safe-area-inset-bottom) + 124px)',
                                }}
                            >
                                {/* STATIC RAIN FORECAST — always visible */}
                                <div className="shrink-0 px-4">
                                    <RainForecastCard
                                        data={minutelyRain}
                                        timeZone={data.timeZone}
                                        rainSummary={rainSummary}
                                    />
                                </div>
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
                                    onActiveDataChange={handleActiveDataChange}
                                    isEssentialMode={!isExpanded}
                                    vessel={userSettings.vessel}
                                    minutelyRain={minutelyRain}
                                />
                            </div>

                            {/* HORIZONTAL POSITION DOTS - Shows current slide in horizontal scroll (full mode only) */}
                            {isExpanded && (
                                <div
                                    className="fixed left-0 right-0 z-[125] flex justify-center"
                                    style={{ bottom: 'calc(env(safe-area-inset-bottom) + 124px)' }}
                                >
                                    <div className="flex gap-[3px] px-4 py-1">
                                        {Array.from({ length: 24 }).map((_, i) => (
                                            <div
                                                key={i}
                                                className={`w-1 h-1 rounded-full transition-all duration-150 ${
                                                    i === activeHour
                                                        ? 'bg-sky-400 shadow-[0_0_3px_rgba(56,189,248,0.6)]'
                                                        : 'bg-white/20'
                                                }`}
                                            />
                                        ))}
                                    </div>
                                </div>
                            )}

                            {/* STALENESS BANNER — relocated to the TOP of the
                                screen, in the gap below the location search bar.
                                Previously this sat above the status badges at
                                the bottom, where it (a) visually clipped into
                                the tide graph and (b) left a wasteful empty
                                band at the top on offline/stale states. Now it
                                fills that top gap so offline users see the
                                indicator immediately on app open, and the tide
                                area stays clean. z-[130] keeps it above the
                                black blocker / CompactHeaderRow so it's always
                                readable. */}
                            <div
                                className="fixed left-0 right-0 z-[130] px-4"
                                style={{ top: 'calc(max(8px, env(safe-area-inset-top)) + 108px)' }}
                            >
                                <StalenessBanner
                                    generatedAt={data.generatedAt}
                                    stale={data._stale}
                                    staleAgeMinutes={data._staleAgeMinutes}
                                    error={weatherError}
                                    locationType={data.locationType}
                                    isOffline={isOffline}
                                    onRefresh={() => refreshData()}
                                    isSyncing={weatherLoading || backgroundUpdating}
                                />
                            </div>

                            {/* STATIC BADGES - Fixed at bottom, outside hero scroll */}
                            {/* Height is ~42px. Bottom is 74px. Top of badges is 74+42 = 116px.
                                Hero container bottom is 120px.
                                Gap = 120 - 116 = 4px. (Adjusted per user request to be 4px tighter)
                            */}
                            <div
                                className="fixed left-0 right-0 z-[125] px-4"
                                style={{ bottom: 'calc(env(safe-area-inset-bottom) + 74px)' }}
                            >
                                <div className={`rounded-xl bg-black/40 ${t.border.default} p-2`}>
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
                                        offshoreModelLabel={offshore.offshoreModel}
                                        sources={widgetSources}
                                        activeData={safeActive}
                                        isLive={activeDay === 0 && activeHour === 0}
                                        modelUsed={data.modelUsed}
                                        generatedAt={data.generatedAt}
                                        coordinates={data.coordinates}
                                    />
                                </div>
                            </div>
                        </div>
                    )}

                    {/* DETAILED GRIDS / LOG PAGE - Full height container for proper internal scrolling */}
                    {isDetailMode && (
                        <div className="absolute inset-0 overflow-hidden">
                            <React.Suspense
                                fallback={
                                    <div className="flex items-center justify-center h-full bg-black">
                                        <div className="text-white/60 text-sm">Loading Log...</div>
                                    </div>
                                }
                            >
                                <LogPage />
                            </React.Suspense>
                        </div>
                    )}
                </div>
            </div>
        </DashboardWidgetContext.Provider>
    );
});
