/**
 * WeatherBriefingCard — Pre-departure weather review for Passage Planning.
 *
 * Displays a weather briefing checklist that the captain must review
 * before departure. Includes a confirmation checkbox that turns the card
 * from red (unreviewed) to green (reviewed & accepted).
 *
 * When MultiModelResult data is available from the route planner,
 * it embeds the full ModelComparisonCard heat map.
 */

import React, { useState, useEffect, useCallback } from 'react';
import type { MultiModelResult } from '../../services/weather/MultiModelWeatherService';
import type { ForecastDay, WeatherModel } from '../../types/weather';
import { ModelComparisonCard } from './ModelComparisonCard';
import { triggerHaptic } from '../../utils/system';
import { useReadinessSync } from '../../hooks/useReadinessSync';

/**
 * Forecast model options for the briefing dropdown. Maps the user-
 * facing label to the WeatherModel value fetchFastWeather accepts.
 *
 *   best_match     → Open-Meteo's blended pick (default; usually GFS-
 *                    seamless globally, ICON in Europe)
 *   gfs_seamless   → NOAA GFS — 0.25° global workhorse
 *   ecmwf_ifs04    → ECMWF IFS — 0.1°, generally best overall
 *   icon_seamless  → DWD ICON — 0.125°, strong on Atlantic/Med
 *   bom_access_global → Australian BOM — best in Coral Sea, Tasman
 *
 * Cycling through these lets the skipper see how forecasts converge
 * (high confidence) or diverge (uncertainty — be cautious).
 */
const FORECAST_MODELS: { value: WeatherModel; label: string; provider: string }[] = [
    { value: 'best_match', label: 'Best match', provider: 'Open-Meteo blended' },
    { value: 'gfs_seamless', label: 'GFS', provider: 'NOAA · 0.25° global' },
    { value: 'ecmwf_ifs04', label: 'ECMWF IFS', provider: 'ECMWF · 0.1° global' },
    { value: 'icon_seamless', label: 'ICON', provider: 'DWD · 0.125° global' },
    { value: 'bom_access_global', label: 'ACCESS-G', provider: 'BOM · 0.15° AU/Pacific' },
];

/* ────────────────────────────────────────────────────────────── */

interface WeatherBriefingCardProps {
    voyageId?: string;
    departPort?: string;
    destPort?: string;
    /** Departure coords to anchor the forecast fetch */
    departureCoords?: { lat: number; lon: number };
    /** ISO timestamps bracketing the days the boat is at sea */
    departureTime?: string | null;
    eta?: string | null;
    multiModelData?: MultiModelResult | null;
    /** Callback: (reviewed: boolean) */
    onReviewedChange?: (reviewed: boolean) => void;
}

const BRIEFING_ITEMS = [
    { key: 'forecast', icon: '🌤️', label: 'Reviewed latest forecast for passage area' },
    { key: 'models', icon: '🔬', label: 'Compared available weather models (GFS, ECMWF, etc.)' },
    { key: 'wind', icon: '💨', label: 'Checked wind conditions are within vessel limits' },
    { key: 'swell', icon: '🌊', label: 'Assessed sea state and swell heights for comfort' },
    { key: 'systems', icon: '🌀', label: 'Checked for approaching weather systems or fronts' },
    { key: 'window', icon: '⏰', label: 'Identified optimal departure weather window' },
];

const STORAGE_KEY = 'thalassa_weather_briefing';

export const WeatherBriefingCard: React.FC<WeatherBriefingCardProps> = ({
    voyageId,
    departPort,
    destPort,
    departureCoords,
    departureTime,
    eta,
    multiModelData,
    onReviewedChange,
}) => {
    const [checkedItems, setCheckedItems] = useState<Record<string, boolean>>(() => {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            return stored ? JSON.parse(stored) : {};
        } catch {
            return {};
        }
    });

    // Forecast for the days the boat is at sea — fetched on mount and
    // re-fetched whenever the departure coords / dates change.
    const [passageForecast, setPassageForecast] = useState<ForecastDay[] | null>(null);
    const [forecastLoading, setForecastLoading] = useState(false);
    // Active forecast model — drives which numerical weather prediction
    // model the forecast is pulled from. Cycling through models lets
    // the user spot convergence (high confidence) or divergence
    // (forecasts disagree — proceed with caution). Stored to
    // localStorage so the user's preference sticks across reloads.
    const [forecastModel, setForecastModel] = useState<WeatherModel>(() => {
        try {
            const stored = localStorage.getItem('thalassa_briefing_model');
            if (stored && FORECAST_MODELS.some((m) => m.value === stored)) {
                return stored as WeatherModel;
            }
        } catch {
            /* ignore */
        }
        return 'best_match';
    });

    const { syncCheck } = useReadinessSync(voyageId, 'weather_briefing', checkedItems, setCheckedItems, STORAGE_KEY);

    // Fetch the actual weather forecast for the passage. We pull a 7-
    // day open-meteo forecast for the departure point and slice it to
    // the [departureTime, eta] window so the skipper sees exactly the
    // days they'll be at sea — not generic "weather here today".
    useEffect(() => {
        if (!departureCoords || !departureTime) {
            setPassageForecast(null);
            return;
        }
        let cancelled = false;
        const fetchForecast = async () => {
            setForecastLoading(true);
            try {
                const { fetchFastWeather } = await import('../../services/weather');
                // Pass the currently-selected model so the forecast
                // refreshes when the user switches models in the
                // dropdown. Default 'best_match' = Open-Meteo's
                // recommended-per-region pick (usually GFS-seamless).
                const report = await fetchFastWeather(departPort || 'Departure', departureCoords, forecastModel);
                if (cancelled) return;
                const depMs = Date.parse(departureTime);
                const arrMs = eta ? Date.parse(eta) : depMs + 7 * 24 * 3_600_000;
                const allDays = report.forecast || [];
                // Filter to days that overlap the passage window.
                // Open-Meteo's forecast.day is 'YYYY-MM-DD' or 'EEE'
                // depending on source, so we lean on isoDate when
                // available and fall back to date.
                const filtered = allDays.filter((d) => {
                    const iso = d.isoDate || d.date;
                    if (!iso) return false;
                    const dayMs = Date.parse(iso);
                    if (!isFinite(dayMs)) return false;
                    // Window is half-open [dep, arr+1day) so the arrival
                    // day is included.
                    return dayMs >= depMs - 12 * 3_600_000 && dayMs <= arrMs + 24 * 3_600_000;
                });
                setPassageForecast(filtered.length > 0 ? filtered : allDays.slice(0, 7));
            } catch (e) {
                console.warn('[WeatherBriefingCard] forecast fetch failed', e);
                if (!cancelled) setPassageForecast(null);
            } finally {
                if (!cancelled) setForecastLoading(false);
            }
        };
        fetchForecast();
        return () => {
            cancelled = true;
        };
    }, [departureCoords, departureTime, eta, departPort, forecastModel]);

    const totalItems = BRIEFING_ITEMS.length;
    const checkedCount = BRIEFING_ITEMS.filter((item) => checkedItems[item.key]).length;
    const allReviewed = checkedCount === totalItems;

    const toggleItem = useCallback(
        (key: string) => {
            setCheckedItems((prev) => {
                const next = { ...prev, [key]: !prev[key] };
                try {
                    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
                } catch {
                    /* ignore */
                }
                syncCheck(key, next[key]);
                return next;
            });
            triggerHaptic('light');
        },
        [syncCheck],
    );

    // Notify parent of review state
    useEffect(() => {
        onReviewedChange?.(allReviewed);
    }, [allReviewed, onReviewedChange]);

    return (
        <div className="space-y-4">
            {/* Route context */}
            {departPort && destPort && (
                <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-white/[0.03] border border-white/[0.06]">
                    <span className="text-[11px] text-gray-400 uppercase tracking-widest font-bold">Passage</span>
                    <span className="text-sm text-white font-semibold">
                        {departPort} → {destPort}
                    </span>
                </div>
            )}

            {/* ── Daily Passage Forecast ──
                The skipper needs to see weather for the days they'll be
                at sea — not a generic "weather here today" or a "run a
                route plan" placeholder. We pull a 7-day open-meteo
                report for the departure point and slice it to
                [departureTime, eta]. */}
            {(passageForecast || forecastLoading) && (
                <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4">
                    <h4 className="text-xs font-bold text-white uppercase tracking-widest mb-3 flex items-center gap-2">
                        🌤️ Forecast — Days at Sea
                        {passageForecast && passageForecast.length > 0 && (
                            <span className="ml-auto px-2 py-0.5 rounded-full text-[11px] font-bold bg-sky-500/10 border border-sky-500/20 text-sky-400">
                                {passageForecast.length} {passageForecast.length === 1 ? 'day' : 'days'}
                            </span>
                        )}
                    </h4>

                    {/* Forecast model dropdown — lets the skipper cycle
                        through GFS / ECMWF / ICON / ACCESS-G to see
                        how forecasts converge or diverge. Convergence
                        = high confidence, divergence = uncertainty
                        and a flag to be more cautious about timing.

                        Persists the selection in localStorage so the
                        user's preference sticks across reloads. */}
                    <div className="mb-3 flex items-center gap-2">
                        <label
                            htmlFor="briefing-model-select"
                            className="text-[10px] font-bold uppercase tracking-widest text-gray-400 shrink-0"
                        >
                            Model
                        </label>
                        <select
                            id="briefing-model-select"
                            value={forecastModel}
                            onChange={(e) => {
                                const next = e.target.value as WeatherModel;
                                setForecastModel(next);
                                try {
                                    localStorage.setItem('thalassa_briefing_model', next);
                                } catch {
                                    /* ignore */
                                }
                                triggerHaptic('light');
                            }}
                            className="flex-1 min-w-0 bg-slate-900/60 border border-white/10 rounded-lg px-3 py-1.5 text-[11px] text-white font-semibold outline-none focus:border-sky-500 transition-colors"
                            aria-label="Select forecast model"
                        >
                            {FORECAST_MODELS.map((m) => (
                                <option key={m.value} value={m.value}>
                                    {m.label} — {m.provider}
                                </option>
                            ))}
                        </select>
                    </div>
                    {forecastLoading && (
                        <div className="text-center py-6">
                            <div className="inline-block w-6 h-6 border-2 border-sky-400/30 border-t-sky-400 rounded-full animate-spin"></div>
                            <p className="text-xs text-gray-400 mt-2">Fetching passage forecast...</p>
                        </div>
                    )}
                    {!forecastLoading && passageForecast && passageForecast.length > 0 && (
                        <div className="space-y-1.5">
                            {passageForecast.map((day, i) => {
                                const wind = Math.round(day.windSpeed);
                                const gust = day.windGust ? Math.round(day.windGust) : Math.round(day.windSpeed * 1.3);
                                const wave = day.waveHeight.toFixed(1);
                                const isHeavy = day.windSpeed > 20 || day.waveHeight > 2.5;
                                return (
                                    <div
                                        key={`${day.isoDate || day.date}-${i}`}
                                        className={`flex items-center gap-3 px-3 py-2.5 rounded-xl border ${
                                            isHeavy
                                                ? 'bg-amber-500/[0.05] border-amber-500/15'
                                                : 'bg-white/[0.02] border-white/[0.06]'
                                        }`}
                                    >
                                        <div className="min-w-[48px]">
                                            <p className="text-sm font-bold text-white leading-tight">{day.day}</p>
                                            <p className="text-[10px] text-gray-400 uppercase tracking-wide">
                                                {day.date}
                                            </p>
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <p className="text-xs text-gray-300 capitalize truncate">{day.condition}</p>
                                            <div className="flex items-center gap-3 mt-0.5 flex-wrap">
                                                <span className="text-[11px] text-gray-400">
                                                    💨 <span className="text-white font-mono font-bold">{wind}</span>
                                                    <span className="text-amber-300/80">/{gust}</span> kn
                                                </span>
                                                <span className="text-[11px] text-gray-400">
                                                    🌊 <span className="text-white font-mono font-bold">{wave}</span> m
                                                </span>
                                                {day.swellPeriod && (
                                                    <span className="text-[11px] text-gray-400">
                                                        ⏱{' '}
                                                        <span className="text-white font-mono font-bold">
                                                            {Math.round(day.swellPeriod)}
                                                        </span>
                                                        s
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                        {isHeavy && (
                                            <span className="text-amber-400 text-base shrink-0" title="Heavy weather">
                                                ⚠️
                                            </span>
                                        )}
                                    </div>
                                );
                            })}
                            <p className="text-[10px] text-gray-500 mt-2 text-center">
                                Open-Meteo · forecast at departure point · review hourly detail before departure
                            </p>
                        </div>
                    )}
                </div>
            )}

            {/* ── Model Comparison (if data available) ── */}
            {multiModelData && (
                <div>
                    <h4 className="text-xs font-bold text-white uppercase tracking-widest mb-3 flex items-center gap-2">
                        🔬 Multi-Model Ensemble Comparison
                    </h4>
                    <ModelComparisonCard data={multiModelData} />
                </div>
            )}

            {/* ── No forecast & no model data ── */}
            {!passageForecast && !forecastLoading && !multiModelData && (
                <div className="bg-white/[0.02] border border-white/[0.06] rounded-xl p-4 text-center">
                    <span className="text-2xl">🛰️</span>
                    <p className="text-xs text-gray-400 mt-2 font-semibold">
                        {!departureCoords
                            ? 'Plan a route to see your passage forecast here.'
                            : 'Forecast unavailable — check connection.'}
                    </p>
                    <p className="text-[11px] text-gray-500 mt-1">GFS · ECMWF · ICON · ACCESS-G ensemble analysis</p>
                </div>
            )}

            {/* ── Weather Briefing Checklist ── */}
            <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4">
                <h4 className="text-xs font-bold text-white uppercase tracking-widest mb-3 flex items-center gap-2">
                    📋 Pre-Departure Weather Briefing
                    <span
                        className={`ml-auto px-2 py-0.5 rounded-full text-[11px] font-bold border ${
                            allReviewed
                                ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
                                : 'bg-sky-500/10 border-sky-500/20 text-sky-400'
                        }`}
                    >
                        {checkedCount}/{totalItems}
                    </span>
                </h4>
                <div className="space-y-1.5">
                    {BRIEFING_ITEMS.map((item) => {
                        const isChecked = !!checkedItems[item.key];
                        return (
                            <button
                                key={item.key}
                                onClick={() => toggleItem(item.key)}
                                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-all active:scale-[0.98] ${
                                    isChecked
                                        ? 'bg-emerald-500/10 border border-emerald-500/20'
                                        : 'bg-white/[0.02] border border-white/[0.06] hover:bg-white/[0.05]'
                                }`}
                            >
                                <div
                                    className={`w-[18px] h-[18px] rounded border-2 flex items-center justify-center shrink-0 transition-all ${
                                        isChecked
                                            ? 'bg-emerald-500 border-emerald-500'
                                            : 'border-gray-500 bg-transparent'
                                    }`}
                                >
                                    {isChecked && (
                                        <svg
                                            className="w-3 h-3 text-white"
                                            fill="none"
                                            viewBox="0 0 24 24"
                                            stroke="currentColor"
                                            strokeWidth={3}
                                        >
                                            <path
                                                strokeLinecap="round"
                                                strokeLinejoin="round"
                                                d="M4.5 12.75l6 6 9-13.5"
                                            />
                                        </svg>
                                    )}
                                </div>
                                <span className="text-sm mr-1">{item.icon}</span>
                                <span
                                    className={`text-xs flex-1 ${
                                        isChecked ? 'text-emerald-300 line-through opacity-70' : 'text-gray-300'
                                    }`}
                                >
                                    {item.label}
                                </span>
                            </button>
                        );
                    })}
                </div>
            </div>

            {/* ── All Reviewed Confirmation ── */}
            {allReviewed && (
                <div className="flex items-center gap-2 px-4 py-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 animate-in fade-in slide-in-from-bottom-2 duration-300">
                    <span className="text-lg">✅</span>
                    <div>
                        <p className="text-xs font-bold text-emerald-400">Weather Briefing Complete</p>
                        <p className="text-[11px] text-emerald-400/60 mt-0.5">
                            Passage weather conditions reviewed and assessed
                        </p>
                    </div>
                </div>
            )}
        </div>
    );
};
