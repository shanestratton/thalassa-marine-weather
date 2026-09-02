import React, { useState, useEffect } from 'react';
import { useEnvironment } from '../../context/ThemeContext';
import { formatAge } from '../ui/DataFreshness';
import { MetricSource } from '../../types';
import type { WeatherModel } from '../../types';
import { useWeather } from '../../context/WeatherContext';
import { triggerHaptic } from '../../utils/system';
import { AlertTriangleIcon } from '../Icons';
import { useSettingsStore } from '../../stores/settingsStore';
import { resolveForecastModel, getForecastModelInfo, isSpitfire } from '../../services/weather/forecastModels';
import { listPublishedModels } from '../../services/weather/wxPublished';
import { spitfireLocationFor } from '../../services/weather/spitfire';
import { ModelPickerSheet } from './ModelPickerSheet';

interface StatusBadgesProps {
    isLandlocked: boolean;
    locationName: string;
    displaySource: string;
    nextUpdate: number | null;
    fallbackInland?: boolean;
    stationId?: string;
    locationType?: 'inshore' | 'coastal' | 'offshore' | 'inland';
    beaconName?: string;
    buoyName?: string;
    /** When offshore, show the user's selected model in the badge */
    offshoreModelLabel?: string;
    /** Pulsing indicator when offshore */
    isOffshore?: boolean;
    // Dynamic source data
    sources?: Record<string, MetricSource>;
    // Data source modal props
    activeData?: {
        windSpeed?: number | null;
        windGust?: number | null;
        windDirection?: string | number | null;
        waveHeight?: number | null;
        wavePeriod?: number | null;
        swellHeight?: number | null;
        swellPeriod?: number | null;
        waterTemperature?: number | null;
        airTemperature?: number | null;
        pressure?: number | null;
        visibility?: number | null;
        humidity?: number | null;
        cloudCover?: number | null;
        temperature?: number | null;
    };
    isLive?: boolean;
    modelUsed?: string;
    generatedAt?: string;
    coordinates?: { lat: number; lon: number };
}

// NOTE: the Data Sources modal was removed on 2026-04-23 (per-metric
// provenance was frequently wrong), and the legacy source-config tables +
// formatCacheAge helper that lingered afterwards were deleted 2026-07-20
// when the timer/refresh pill was replaced by the model picker — nothing
// referenced them any more.

export const StatusBadges: React.FC<StatusBadgesProps> = React.memo(
    ({
        isLandlocked,
        // The modal-only props (locationName, displaySource, stationId, …)
        // stay in the interface so Dashboard's call site doesn't change, but
        // are not destructured: the Data Sources modal was removed
        // (attribution was frequently wrong).
        fallbackInland,
        locationType,
        modelUsed,
        generatedAt,
        coordinates,
        offshoreModelLabel,
        isOffshore: isOffshoreProp,
    }) => {
        const env = useEnvironment();
        const { refreshData, loading, backgroundUpdating, error } = useWeather();
        const isSyncing = loading || backgroundUpdating;
        const badgeTextSize = env === 'onshore' ? 'text-[11px]' : 'text-xs';
        // Error state takes precedence over staleness — if the last
        // refresh failed, the user needs to know the data they're
        // looking at is from BEFORE the failure, not "live". Added
        // 2026-05-17 as part of the error-handling pass; previously
        // refreshData failures were silent and the pill kept ticking
        // down to next-update as if nothing happened.
        const hasError = !!error && !isSyncing;

        // BADGES Logic — each variant carries a label, tailwind color
        // classes (bg + text + border), an SVG glyph, and the breathing
        // glow class name that matches its colour.
        const offshore = isOffshoreProp ?? locationType === 'offshore';
        let statusBadgeLabel: string;
        let statusBadgeColor: string;
        let statusBadgeGlow: string;
        let statusBadgeIcon: React.ReactNode;
        let statusBadgePulse = false;

        // Shared tiny-icon style — matches the 12px label height
        const iconCls = 'w-3 h-3 shrink-0 opacity-90';

        if (offshore) {
            statusBadgeLabel = offshoreModelLabel ? `OFFSHORE (${offshoreModelLabel})` : 'OFFSHORE';
            // Gradient gives the pill depth vs a flat wash
            statusBadgeColor =
                'bg-linear-to-r from-sky-500/25 via-sky-500/20 to-sky-500/25 text-sky-200 border-sky-400/40';
            statusBadgeGlow = 'status-badge-glow-sky';
            // Compass rose — offshore = open water navigation
            statusBadgeIcon = (
                <svg className={iconCls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                    <circle cx="12" cy="12" r="9" strokeLinecap="round" />
                    <path d="M12 3v3M12 18v3M3 12h3M18 12h3" strokeLinecap="round" />
                    <path d="M15 9l-3 6-3-6 6 0z" fill="currentColor" stroke="none" opacity="0.9" />
                </svg>
            );
            statusBadgePulse = true;
        } else if (locationType === 'inland' || isLandlocked || fallbackInland) {
            statusBadgeLabel = 'INLAND';
            statusBadgeColor =
                'bg-linear-to-r from-amber-500/25 via-amber-500/20 to-amber-500/25 text-amber-200 border-amber-400/40';
            statusBadgeGlow = 'status-badge-glow-amber';
            // Little mountain silhouette
            statusBadgeIcon = (
                <svg className={iconCls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                    <path d="M3 19l6-10 4 6 3-4 5 8H3z" strokeLinejoin="round" strokeLinecap="round" />
                </svg>
            );
        } else if (locationType === 'inshore') {
            statusBadgeLabel = 'INSHORE';
            statusBadgeColor =
                'bg-linear-to-r from-teal-500/25 via-teal-500/20 to-teal-500/25 text-teal-200 border-teal-400/40';
            statusBadgeGlow = 'status-badge-glow-teal';
            // Anchor — tight-to-shore waters
            statusBadgeIcon = (
                <svg className={iconCls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                    <circle cx="12" cy="5" r="2" strokeLinecap="round" />
                    <path d="M12 7v13" strokeLinecap="round" />
                    <path d="M8 11h8" strokeLinecap="round" />
                    <path d="M5 15a7 7 0 0014 0" strokeLinecap="round" />
                </svg>
            );
        } else {
            statusBadgeLabel = 'COASTAL';
            statusBadgeColor =
                'bg-linear-to-r from-emerald-500/25 via-emerald-500/20 to-emerald-500/25 text-emerald-200 border-emerald-400/40';
            statusBadgeGlow = 'status-badge-glow-emerald';
            // Stylized wave
            statusBadgeIcon = (
                <svg className={iconCls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                    <path
                        d="M3 12c2-2 4-2 6 0s4 2 6 0 4-2 6 0M3 17c2-2 4-2 6 0s4 2 6 0 4-2 6 0"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    />
                </svg>
            );
        }

        // ── Forecast model pill ──
        // Replaced the old timer/refresh pill (2026-07-20): refresh is fully
        // automatic (30s scheduler + wake/reconnect handlers in
        // WeatherContext), and stale/error states already surface in the
        // the freshness strip above this row — the pill was redundant. That
        // strip was removed 2026-08-13, so THIS pill is now the primary
        // refresh/failure signal on the Glass: keep its pulse and red tint.
        // In its place: the forecast-model picker. A manual "Refresh now"
        // escape hatch lives inside the sheet.
        const updateSettings = useSettingsStore((s) => s.updateSettings);
        const glassModel = resolveForecastModel(useSettingsStore((s) => s.settings.forecastModel));
        const modelInfo = getForecastModelInfo(glassModel);
        const [showModelSheet, setShowModelSheet] = useState(false);

        // FORECAST AGE. generatedAt was threaded all the way down here and
        // then dropped on the floor (`generatedAt: _generatedAt`), so the
        // Glass — the app's primary weather surface — never said how old its
        // numbers were. DataFreshness.tsx was written for exactly this and
        // cites the 2026-05-17 audit; the strip that carried it was removed
        // 2026-08-13 as redundant and the age never came back. A stale
        // forecast that looks live is the one weather failure that matters.
        const [ageTick, setAgeTick] = useState(() => Date.now());
        useEffect(() => {
            const id = window.setInterval(() => setAgeTick(Date.now()), 30_000);
            return () => window.clearInterval(id);
        }, []);
        const generatedMs = generatedAt ? Date.parse(String(generatedAt)) : Number.NaN;
        const forecastAge = Number.isFinite(generatedMs) ? formatAge(Math.max(0, ageTick - generatedMs)) : null;
        // Past ~90 min the age tints amber so staleness is visible without
        // reading the number.
        const forecastAgeStale = Number.isFinite(generatedMs) && ageTick - generatedMs > 90 * 60 * 1000;

        // What ACTUALLY served this data, when the publisher says so. The
        // pill's face stays the pinned selection (it is a picker, and must
        // show what tapping it will change), but the accessible name and
        // tooltip no longer claim a model the server may not have used.
        const servedModel = typeof modelUsed === 'string' && modelUsed.trim() ? modelUsed.trim() : null;

        // SPITFIRE only exists where the wx box computes it, so both the pill
        // and the picker follow the boat's position.
        const spitfireLoc = spitfireLocationFor(coordinates?.lat ?? null, coordinates?.lon ?? null);
        // What the wx publisher carries for this cell (30-min cached, 2.5 s
        // bounded, [] until it answers). Drives the picker's grid list, and
        // lets Spitfire appear wherever the publisher has computed it — the
        // hardcoded location list remains as the pre-publisher fallback.
        const [publishedModels, setPublishedModels] = useState<string[]>([]);
        useEffect(() => {
            const lat = coordinates?.lat;
            const lon = coordinates?.lon;
            if (lat == null || lon == null) return;
            let live = true;
            void listPublishedModels(lat, lon).then((models) => {
                if (live) setPublishedModels(models);
            });
            return () => {
                live = false;
            };
        }, [coordinates?.lat, coordinates?.lon]);
        const spitfireSelected = isSpitfire(glassModel);
        const pillLabel = spitfireSelected ? 'SPITFIRE' : modelInfo?.label || 'AUTO';
        const pillHex = spitfireSelected ? '#facc15' : modelInfo?.hex || '#94a3b8';
        const pickModel = (id: WeatherModel) => {
            void triggerHaptic('medium');
            updateSettings({ forecastModel: id });
            setShowModelSheet(false);
        };

        return (
            <>
                <div className="px-0 shrink-0 relative z-20">
                    <div className="flex items-center justify-between gap-2 w-full mb-0">
                        {/* Location-type Badge — informational only (no longer
                            tappable; the Data Sources modal was removed because
                            per-metric attribution wasn't reliable). Keeps the
                            breathing glow and type-specific glyph so the pill
                            still reads at a glance. */}
                        <div
                            role="status"
                            aria-label={`Location type: ${statusBadgeLabel}`}
                            className={`px-2.5 py-1.5 rounded-lg border ${badgeTextSize} font-bold uppercase tracking-wider ${statusBadgeColor} ${statusBadgeGlow} min-w-[82px] text-center flex items-center justify-center gap-1.5`}
                        >
                            {statusBadgeIcon}
                            {statusBadgePulse && (
                                <span className="relative flex w-1.5 h-1.5 shrink-0">
                                    <span className="animate-ping absolute inset-0 rounded-full bg-sky-400 opacity-60" />
                                    <span className="relative w-1.5 h-1.5 rounded-full bg-sky-400" />
                                </span>
                            )}
                            {statusBadgeLabel}
                        </div>

                        {/* Forecast age — the primary staleness signal on the
                            Glass. Silent when there is no timestamp rather
                            than guessing at one. */}
                        {forecastAge && (
                            <span
                                role="status"
                                aria-label={`Forecast updated ${forecastAge}`}
                                className={`text-xs font-semibold tabular-nums truncate ${forecastAgeStale ? 'text-amber-300' : 'text-slate-300'}`}
                            >
                                {forecastAge}
                            </span>
                        )}

                        {/* Model Pill — opens the forecast-model picker sheet.
                            Shows the pinned model's name with its chart colour;
                            the triple-dot pulse plays while a (fully automatic)
                            refresh is in flight, and the pill tints red when
                            the last refresh failed (retry lives in the sheet
                            — the freshness strip that also offered it was
                            removed 2026-08-13, so the sheet is now the only
                            manual retry on this page). */}
                        <button
                            onClick={() => {
                                void triggerHaptic('light');
                                setShowModelSheet(true);
                            }}
                            aria-label={`${hasError ? 'Last refresh failed — ' : ''}${
                                servedModel ? `Choose forecast model — showing ${servedModel}` : 'Choose forecast model'
                            }`}
                            title={servedModel ? `Served by ${servedModel}` : undefined}
                            aria-haspopup="dialog"
                            className={`px-2.5 py-1.5 rounded-lg border ${badgeTextSize} font-bold uppercase tracking-wider flex items-center gap-1.5 justify-center cursor-pointer active:scale-[0.95] transition-transform min-w-[82px] ${
                                hasError
                                    ? 'bg-red-500/25 text-red-100 border-red-400/50 status-badge-glow-red'
                                    : isSyncing
                                      ? 'bg-sky-500/25 text-sky-100 border-sky-400/50 status-badge-sweep shadow-[0_0_12px_-2px_rgba(56,189,248,0.5)]'
                                      : 'bg-sky-500/20 text-sky-300 border-sky-500/30 status-badge-glow-sky'
                            }`}
                        >
                            {isSyncing ? (
                                <span className="flex items-center gap-0.5 shrink-0">
                                    <span
                                        className="w-1 h-1 rounded-full bg-sky-200"
                                        style={{ animation: 'hh-pulse 1.2s ease-in-out 0s infinite' }}
                                    />
                                    <span
                                        className="w-1 h-1 rounded-full bg-sky-200"
                                        style={{ animation: 'hh-pulse 1.2s ease-in-out 0.2s infinite' }}
                                    />
                                    <span
                                        className="w-1 h-1 rounded-full bg-sky-200"
                                        style={{ animation: 'hh-pulse 1.2s ease-in-out 0.4s infinite' }}
                                    />
                                </span>
                            ) : (
                                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: pillHex }} />
                            )}
                            {hasError && (
                                <span aria-hidden="true" className="flex shrink-0">
                                    <AlertTriangleIcon className="w-3 h-3" />
                                </span>
                            )}
                            {pillLabel}
                            {/* Chevron — signals this pill opens a picker */}
                            <svg
                                className="w-2.5 h-2.5 opacity-60 shrink-0"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={3}
                            >
                                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                            </svg>
                        </button>
                    </div>
                </div>

                <ModelPickerSheet
                    visible={showModelSheet}
                    currentModel={glassModel}
                    spitfireAvailable={!!spitfireLoc || publishedModels.includes('spitfire')}
                    spitfireLocationName={spitfireLoc?.name}
                    publishedModels={publishedModels}
                    onPick={pickModel}
                    onClose={() => setShowModelSheet(false)}
                    onRefresh={() => {
                        void triggerHaptic('light');
                        refreshData();
                    }}
                />

                {/* ── Removed 2026-04-23: Data Sources modal ───────────────
                    The portal-rendered modal that opened on tap of the
                    location-type pill was deleted because the per-metric
                    provenance it displayed was frequently incorrect — the
                    API pipeline didn't reliably propagate source attribution
                    for every metric, so users saw mismatched sources
                    (e.g. "Wind Speed: Apple Weather" when the actual value
                    came from Open-Meteo). Better to show nothing than to
                    mislead. The pill remains as a visual status indicator
                    only (no longer tappable).
                    Related props (sources, activeData, modelUsed, coordinates,
                    isLive) are still in StatusBadgesProps so Dashboard's call
                    site doesn't need to change — they're underscore-prefixed
                    in the destructure to signal intentional non-use. */}
            </>
        );
    },
);
