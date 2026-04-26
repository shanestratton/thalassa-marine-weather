/**
 * MapHubOverlays — Pure presentational components for MapHub overlays.
 *
 * Contains: LayerFAB, ActionFABs, PassageBanner, WindLegend,
 * LayerLegendStrip, WindScrubber, RainScrubber, EmbeddedRainScrubber,
 * PointInput, ResultCard.
 */

import React, { useEffect, useRef, useState } from 'react';
import { type WeatherLayer } from './mapConstants';
import { type ActiveCyclone } from '../../services/weather/CycloneTrackingService';
import { type AvNavChart } from '../../services/AvNavService';
import { type AvNavConnectionStatus } from '../../services/AvNavService';
import { type ChartSource, type ChartSourceId } from '../../services/ChartCatalogService';
import { type OpenChart } from '../../services/MBTilesService';
import { triggerHaptic } from '../../utils/system';
import { AnchorIcon, LocalChartIcon, iconForChartSource } from './ChartSourceIcons';

// ── Resolve truncated ATCF storm names (10-char limit) ──
const NUMBER_NAMES: Record<number, string> = {
    1: 'One',
    2: 'Two',
    3: 'Three',
    4: 'Four',
    5: 'Five',
    6: 'Six',
    7: 'Seven',
    8: 'Eight',
    9: 'Nine',
    10: 'Ten',
    11: 'Eleven',
    12: 'Twelve',
    13: 'Thirteen',
    14: 'Fourteen',
    15: 'Fifteen',
    16: 'Sixteen',
    17: 'Seventeen',
    18: 'Eighteen',
    19: 'Nineteen',
    20: 'Twenty',
    21: 'Twenty-One',
    22: 'Twenty-Two',
    23: 'Twenty-Three',
    24: 'Twenty-Four',
    25: 'Twenty-Five',
    26: 'Twenty-Six',
    27: 'Twenty-Seven',
    28: 'Twenty-Eight',
    29: 'Twenty-Nine',
    30: 'Thirty',
    31: 'Thirty-One',
    32: 'Thirty-Two',
    33: 'Thirty-Three',
    34: 'Thirty-Four',
    35: 'Thirty-Five',
};

function resolveStormDisplayName(name: string): string {
    const raw = name.toUpperCase().replace(/[^A-Z]/g, '');
    let bestMatch = '';
    let bestLen = 0;
    for (const [, fullName] of Object.entries(NUMBER_NAMES)) {
        const stripped = fullName.replace(/-/g, '').toUpperCase();
        if (stripped.startsWith(raw) || raw.startsWith(stripped)) {
            const overlap = Math.min(stripped.length, raw.length);
            if (overlap > bestLen) {
                bestLen = overlap;
                bestMatch = fullName;
            }
        }
    }
    if (bestMatch) return bestMatch;
    return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
}

// ── PointInput ──
export const PointInput: React.FC<{
    label: string;
    point: { lat: number; lon: number; name: string } | null;
    color: string;
    isActive: boolean;
    onSet: () => void;
    onUseCurrent: () => void;
}> = ({ label, point, color, isActive, onSet, onUseCurrent }) => (
    <div
        className={`flex items-center gap-2 p-2.5 rounded-xl border transition-all ${
            isActive ? `bg-${color}-500/10 border-${color}-500/30` : 'bg-white/[0.03] border-white/[0.06]'
        }`}
    >
        <div className={`w-3 h-3 rounded-full shrink-0 ${color === 'emerald' ? 'bg-emerald-400' : 'bg-red-400'}`} />
        <div className="flex-1 min-w-0">
            <p className="text-[11px] text-gray-400 font-bold uppercase tracking-widest">{label}</p>
            <p className="text-xs text-white font-bold truncate">{point ? point.name : 'Not set'}</p>
        </div>
        <button
            aria-label="Use Current"
            onClick={onUseCurrent}
            className="text-[11px] text-sky-400 font-bold uppercase tracking-widest shrink-0 px-2 py-1 rounded-lg hover:bg-sky-500/10"
        >
            📍 Here
        </button>
        <button
            aria-label="Set location from map"
            onClick={onSet}
            className={`text-[11px] font-bold uppercase tracking-widest shrink-0 px-2 py-1 rounded-lg ${isActive ? 'text-amber-400 bg-amber-500/10' : 'text-gray-400 hover:bg-white/5'}`}
        >
            🗺️ Map
        </button>
    </div>
);

// ── ResultCard ──
export const ResultCard: React.FC<{ label: string; value: string }> = ({ label, value }) => (
    <div className="p-2.5 rounded-xl bg-white/[0.04] border border-white/[0.06] text-center">
        <p className="text-xs font-black text-white truncate">{value}</p>
        <p className="text-[11px] text-gray-400 font-bold uppercase tracking-widest">{label}</p>
    </div>
);

// ── Wind Speed Legend (velocity bar) ──
export const WindSpeedLegend: React.FC = () => (
    <div
        className="absolute right-3 z-[600] flex flex-col items-center gap-0.5"
        style={{ top: '50%', transform: 'translateY(-50%)' }}
    >
        <span className="text-[11px] font-bold text-white/60 uppercase tracking-wider mb-1">kts</span>
        <div
            className="rounded-full border border-white/15 shadow-lg"
            style={{
                width: 10,
                height: 140,
                background: 'linear-gradient(to bottom, #e05a50, #cc6650, #d9a060, #d9bf80, #a8b08c, #8ca5c7)',
            }}
        />
        <div
            className="flex flex-col items-end gap-0 mt-0.5"
            style={{ position: 'absolute', right: 16, top: 14, height: 140, justifyContent: 'space-between' }}
        >
            {['35+', '25', '20', '15', '10', '5'].map((label) => (
                <span key={label} className="text-[11px] font-semibold text-white/50 leading-none">
                    {label}
                </span>
            ))}
        </div>
    </div>
);

// ── Layer Legend Strip ──
export const LayerLegendStrip: React.FC<{
    activeLayer: WeatherLayer;
    activeLayers?: Set<WeatherLayer>;
    windMaxSpeed: number;
}> = ({ activeLayer, activeLayers, windMaxSpeed: _windMaxSpeed }) => {
    // Layers that have a legend definition
    // wind-gusts/visibility/cape removed 2026-04-22 with the Xweather decommission.
    const LEGEND_ELIGIBLE: WeatherLayer[] = ['temperature', 'clouds', 'pressure', 'waves', 'currents', 'sst'];

    // Determine which legend to show: prefer activeLayers Set, fallback to single activeLayer
    let legendLayer: WeatherLayer | null = null;
    if (activeLayers && activeLayers.size > 0) {
        for (const l of LEGEND_ELIGIBLE) {
            if (activeLayers.has(l)) {
                legendLayer = l;
                break;
            }
        }
    } else if (LEGEND_ELIGIBLE.includes(activeLayer)) {
        legendLayer = activeLayer;
    }

    if (!legendLayer) return null;

    const legends: Record<
        string,
        { gradient: string; topLabel: string; bottomLabel: string; topArrow: string; bottomArrow: string; icon: string }
    > = {
        temperature: {
            gradient: 'linear-gradient(to bottom, #ff0000, #ff6600, #ffcc00, #66ff66, #00ccff, #0033cc)',
            topLabel: 'HOT',
            bottomLabel: 'COLD',
            topArrow: '↑',
            bottomArrow: '↓',
            icon: '🌡️',
        },
        clouds: {
            gradient: 'linear-gradient(to bottom, #e0e0e0, #a0a0a0, #606060, #303030, #101010)',
            topLabel: 'THICK',
            bottomLabel: 'CLEAR',
            topArrow: '↑',
            bottomArrow: '↓',
            icon: '☁️',
        },
        pressure: {
            gradient: 'linear-gradient(to bottom, #ef4444, #f87171, #ffffff, #93c5fd, #3b82f6)',
            topLabel: 'HIGH',
            bottomLabel: 'LOW',
            topArrow: '↑',
            bottomArrow: '↓',
            icon: '🔵',
        },
        waves: {
            gradient: 'linear-gradient(to bottom, #c026d3, #ef4444, #f97316, #eab308, #22c55e, #3b82f6)',
            topLabel: '6m+',
            bottomLabel: 'CALM',
            topArrow: '↑',
            bottomArrow: '↓',
            icon: '🌊',
        },
        currents: {
            gradient: 'linear-gradient(to bottom, #ef4444, #f97316, #eab308, #06b6d4, #3b82f6, #1e3a5f)',
            topLabel: 'FAST',
            bottomLabel: 'SLOW',
            topArrow: '↑',
            bottomArrow: '↓',
            icon: '🔄',
        },
        sst: {
            gradient: 'linear-gradient(to bottom, #dc2626, #f97316, #eab308, #22c55e, #06b6d4, #2563eb)',
            topLabel: 'WARM',
            bottomLabel: 'COLD',
            topArrow: '↑',
            bottomArrow: '↓',
            icon: '🌡️',
        },
        // wind-gusts/visibility/cape gradient defs removed 2026-04-22
        // with the Xweather decommission.
    };

    const legend = legends[legendLayer];
    if (!legend) return null;

    return (
        <div
            className="absolute left-3 z-10 flex flex-col items-center pointer-events-none"
            style={{ top: '50%', transform: 'translateY(-50%)' }}
        >
            <div
                className="rounded-2xl px-2.5 py-3 flex flex-col items-center gap-1"
                style={{
                    background: 'rgba(15,23,42,0.85)',
                    backdropFilter: 'blur(12px)',
                    border: '1px solid rgba(255,255,255,0.08)',
                    boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
                }}
            >
                {/* Top arrow + label */}
                <span className="text-red-400 text-[11px] font-black leading-none">{legend.topArrow}</span>
                <span className="text-[11px] font-black text-white/80 uppercase tracking-[0.15em] leading-none">
                    {legend.topLabel}
                </span>

                {/* Gradient bar */}
                <div
                    className="w-2.5 rounded-full border border-white/10 my-1"
                    style={{ height: 100, background: legend.gradient }}
                />

                {/* Bottom label + arrow */}
                <span className="text-[11px] font-black text-white/80 uppercase tracking-[0.15em] leading-none">
                    {legend.bottomLabel}
                </span>
                <span className="text-sky-400 text-[11px] font-black leading-none">{legend.bottomArrow}</span>
            </div>
        </div>
    );
};

// ── Layer FAB Menu ──
// Redesigned: Base Weather (radio) + Tactical Overlays (checkbox) + Navigation (toggle)
export const LayerFABMenu: React.FC<{
    activeLayers: Set<WeatherLayer>;
    showLayerMenu: boolean;
    embedded: boolean;
    location: { lat: number; lon: number };
    initialZoom: number;
    center?: { lat: number; lon: number };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mapRef: React.MutableRefObject<any>;
    toggleLayer: (layer: WeatherLayer) => void;
    onSelectSeaState: (layer: WeatherLayer) => void;
    onSelectAtmosphere: (layer: WeatherLayer) => void;
    setShowLayerMenu: (v: boolean) => void;
    aisVisible?: boolean;
    onToggleAis?: () => void;
    chokepointVisible?: boolean;
    onToggleChokepoint?: () => void;
    weatherInspectMode?: boolean;
    onToggleWeatherInspect?: () => void;
    cycloneVisible?: boolean;
    onToggleCyclones?: () => void;
    cycloneStormName?: string | null;
    allCyclones?: ActiveCyclone[];
    userLat?: number;
    userLon?: number;
    onSelectStorm?: (storm: ActiveCyclone) => void;
    squallVisible?: boolean;
    onToggleSquall?: () => void;
    lightningVisible?: boolean;
    onToggleLightning?: () => void;
    vesselTrackingVisible?: boolean;
    onToggleVesselTracking?: () => void;
    onLocateVessel?: () => void;
    skCharts?: AvNavChart[];
    skChartIds?: Set<string>;
    skChartOpacity?: number;
    skConnectionStatus?: AvNavConnectionStatus;
    onToggleSkChart?: (id: string) => void;
    onSkChartOpacityChange?: (opacity: number) => void;
    onFlyToChart?: (chart: AvNavChart) => void;
    seamarkVisible?: boolean;
    onToggleSeamark?: () => void;
    seamarkFeatureCount?: number;
    seamarkLoading?: boolean;
    chartsActive?: boolean;
    seamarkMode?: 'full' | 'identify';
    tideStationsVisible?: boolean;
    onToggleTideStations?: () => void;
    tideStationCount?: number;
    tideStationLoading?: boolean;
    /** Marine Protected Areas (CAPAD vector overlay). Static toggle —
     *  only surfaces when MapHub passes a callback (gated on
     *  VITE_MPA_ENABLED). */
    mpaVisible?: boolean;
    onToggleMpa?: () => void;
    mpaFeatureCount?: number;
    chartCatalogSources?: ChartSource[];
    onToggleChartSource?: (id: ChartSourceId) => void;
    onChartSourceOpacity?: (id: ChartSourceId, opacity: number) => void;
    onFlyToChartSource?: (src: ChartSource) => void;
    onUpdateLinzKey?: (key: string) => void;
    localCharts?: OpenChart[];
    localChartIds?: Set<string>;
    localChartOpacity?: number;
    localChartsLoading?: boolean;
    onToggleLocalChart?: (fileName: string) => void;
    onLocalChartOpacityChange?: (opacity: number) => void;
    onFlyToLocalChart?: (chart: OpenChart) => void;
}> = ({
    activeLayers,
    showLayerMenu,
    embedded,
    location,
    initialZoom,
    center,
    mapRef,
    toggleLayer,
    onSelectSeaState,
    onSelectAtmosphere,
    setShowLayerMenu,
    aisVisible = false,
    onToggleAis,
    chokepointVisible = false,
    onToggleChokepoint,
    weatherInspectMode = false,
    onToggleWeatherInspect,
    cycloneVisible = false,
    onToggleCyclones,
    cycloneStormName = null,
    allCyclones = [],
    userLat = 0,
    userLon = 0,
    onSelectStorm,
    squallVisible = false,
    onToggleSquall,
    lightningVisible = false,
    onToggleLightning,
    vesselTrackingVisible = false,
    onToggleVesselTracking,
    onLocateVessel,
    skCharts = [],
    skChartIds = new Set<string>(),
    skChartOpacity = 0.7,
    skConnectionStatus = 'disconnected',
    onToggleSkChart,
    onSkChartOpacityChange,
    onFlyToChart,
    seamarkVisible = false,
    onToggleSeamark,
    seamarkFeatureCount = 0,
    seamarkLoading = false,
    chartsActive = false,
    seamarkMode: _seamarkMode = 'full',
    tideStationsVisible = false,
    onToggleTideStations,
    tideStationCount = 0,
    tideStationLoading = false,
    mpaVisible = false,
    onToggleMpa,
    mpaFeatureCount = 0,
    chartCatalogSources = [],
    onToggleChartSource,
    onChartSourceOpacity,
    onFlyToChartSource,
    onUpdateLinzKey,
    localCharts = [],
    localChartIds = new Set<string>(),
    localChartOpacity = 0.7,
    localChartsLoading = false,
    onToggleLocalChart,
    onLocalChartOpacityChange,
    onFlyToLocalChart,
}) => {
    // Total active count across all categories
    const totalActive =
        activeLayers.size +
        (cycloneVisible ? 1 : 0) +
        (squallVisible ? 1 : 0) +
        (lightningVisible ? 1 : 0) +
        (weatherInspectMode ? 1 : 0) +
        (aisVisible ? 1 : 0) +
        (vesselTrackingVisible ? 1 : 0) +
        (seamarkVisible ? 1 : 0) +
        (tideStationsVisible ? 1 : 0) +
        (chokepointVisible ? 1 : 0) +
        (mpaVisible ? 1 : 0);

    const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [stormMenuOpen, setStormMenuOpen] = useState(false);
    const [showCharts, setShowCharts] = useState(false);

    // Auto-dismiss menu after 8 seconds of inactivity
    useEffect(() => {
        if (!showLayerMenu) return;
        dismissTimer.current = setTimeout(() => setShowLayerMenu(false), 8000);
        return () => {
            if (dismissTimer.current) clearTimeout(dismissTimer.current);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [showLayerMenu, totalActive, stormMenuOpen, showCharts]);

    // Reset submenus when main menu closes
    useEffect(() => {
        if (!showLayerMenu) {
            setStormMenuOpen(false);
            setShowCharts(false);
        }
    }, [showLayerMenu]);

    // Mutual exclusion with the top-center ChartModes dropdown — when
    // this menu opens we dispatch an event the modes chip listens for
    // (closing itself), and we listen for the modes-chip-open event so
    // we close ourselves. Stops the two big dropdowns from visually
    // overlapping on narrow phones.
    useEffect(() => {
        if (showLayerMenu) window.dispatchEvent(new CustomEvent('thalassa:layer-menu-open'));
    }, [showLayerMenu]);
    useEffect(() => {
        const onModesOpen = () => setShowLayerMenu(false);
        window.addEventListener('thalassa:chart-modes-open', onModesOpen);
        return () => window.removeEventListener('thalassa:chart-modes-open', onModesOpen);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Sort cyclones by distance from user
    const sortedCyclones = [...allCyclones].sort((a, b) => {
        const dA = Math.hypot(a.currentPosition.lat - userLat, a.currentPosition.lon - userLon);
        const dB = Math.hypot(b.currentPosition.lat - userLat, b.currentPosition.lon - userLon);
        return dA - dB;
    });

    // Reusable section header
    const SectionHeader = ({ label, color }: { label: string; color: string }) => (
        <div className="px-4 pt-3 pb-1.5 flex items-center gap-2">
            <span
                className={`text-[10px] font-black uppercase tracking-[0.2em] ${
                    color === 'amber'
                        ? 'text-amber-400/80'
                        : color === 'cyan'
                          ? 'text-cyan-400/80'
                          : color === 'sky'
                            ? 'text-sky-400/80'
                            : color === 'emerald'
                              ? 'text-emerald-400/80'
                              : 'text-gray-400/80'
                }`}
            >
                {label}
            </span>
            <div
                className={`flex-1 h-px ${
                    color === 'amber'
                        ? 'bg-amber-400/10'
                        : color === 'cyan'
                          ? 'bg-cyan-400/10'
                          : color === 'sky'
                            ? 'bg-sky-400/10'
                            : color === 'emerald'
                              ? 'bg-emerald-400/10'
                              : 'bg-white/[0.06]'
                }`}
            />
        </div>
    );

    // Has any charts available
    const hasCharts = skCharts.length > 0 || chartCatalogSources.length > 0 || localCharts.length > 0;

    return (
        // Right-rail FAB column — anchors at top-[80px] so it clears the
        // safe-area + the ChartModes chip with a 16px gap. Stacks evenly
        // at 64px increments (48 FAB + 16 gap). The Offline FAB and the
        // Vessel Search FAB (both in MapHub.tsx) sit on the same
        // right-[16px] column at top-[144px] and top-[208px] respectively
        // so the entire right rail reads as one designed column.
        <div className={`absolute z-[700] flex flex-col items-end gap-2 top-[80px] right-[16px]`}>
            {/* ── FAB Button ── */}
            <button
                aria-label="Toggle chart layer menu"
                onClick={() => {
                    setShowLayerMenu(!showLayerMenu);
                    triggerHaptic('light');
                }}
                className={`relative border border-white/[0.08] rounded-2xl flex items-center justify-center shadow-2xl hover:bg-slate-800/90 transition-all active:scale-95 bg-slate-900/90 ${embedded ? 'w-8 h-8 rounded-xl' : 'w-12 h-12'}`}
            >
                <svg
                    className={`text-white ${embedded ? 'w-3.5 h-3.5' : 'w-5 h-5'}`}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={1.5}
                >
                    <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M6.429 9.75L2.25 12l4.179 2.25m0-4.5l5.571 3 5.571-3m-11.142 0L2.25 7.5 12 2.25l9.75 5.25-4.179 2.25m0 0L21.75 12l-4.179 2.25m0 0l4.179 2.25L12 21.75 2.25 16.5l4.179-2.25m11.142 0l-5.571 3-5.571-3"
                    />
                </svg>
                {totalActive > 0 && (
                    <span className="absolute -top-1 -right-1 w-4 h-4 bg-sky-500 rounded-full flex items-center justify-center text-[11px] font-black text-white shadow-lg shadow-sky-500/50">
                        {totalActive}
                    </span>
                )}
            </button>

            {embedded && (
                <button
                    onClick={() => {
                        const lat = center?.lat ?? location.lat;
                        const lon = center?.lon ?? location.lon;
                        mapRef.current?.flyTo({ center: [lon, lat], zoom: initialZoom, duration: 800 });
                    }}
                    className="w-8 h-8 rounded-xl border border-white/[0.08] flex items-center justify-center shadow-2xl hover:bg-slate-800/90 transition-all active:scale-95 bg-slate-900/90"
                    aria-label="Recenter map"
                >
                    <svg
                        className="w-3.5 h-3.5 text-sky-400"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2}
                    >
                        <circle cx="12" cy="12" r="3" />
                        <path strokeLinecap="round" d="M12 2v4m0 12v4M2 12h4m12 0h4" />
                    </svg>
                </button>
            )}

            {/* ═══ EXPANDED MENU ═══ */}
            {showLayerMenu && (
                <div
                    className="bg-slate-900/95 backdrop-blur-xl border border-white/[0.08] rounded-2xl overflow-hidden overflow-y-auto shadow-2xl animate-in fade-in slide-in-from-top-2 duration-200"
                    style={{ maxHeight: 'calc(100vh - 240px)', minWidth: 260 }}
                >
                    {/* Accent glow bar */}
                    <div className="h-[2px] bg-gradient-to-r from-transparent via-sky-500/40 to-transparent" />

                    {/* ═════════���════════════════════════════════ */}
                    {/* ── TACTICAL OVERLAYS (checkbox / additive) ── */}
                    {/* ══════════════════════════════════════════ */}
                    <SectionHeader label="Tactical Overlays" color="amber" />

                    {/* Severe Warnings */}
                    {onToggleCyclones && (
                        <button
                            aria-label="View active cyclone tracking"
                            onClick={() => {
                                if (allCyclones.length > 0) {
                                    setStormMenuOpen(!stormMenuOpen);
                                    triggerHaptic('light');
                                } else {
                                    onToggleCyclones();
                                    triggerHaptic('light');
                                }
                            }}
                            className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                                cycloneVisible ? 'bg-red-500/10 text-red-400' : 'text-gray-400 hover:bg-white/5'
                            }`}
                        >
                            <span className="text-lg">🌀</span>
                            <span className="text-[13px] font-bold flex-1">Severe Warnings</span>
                            {cycloneVisible ? (
                                <span className="flex items-center gap-1.5">
                                    <span className="w-1.5 h-1.5 rounded-full bg-red-400 shadow-lg shadow-red-400/50 animate-pulse" />
                                    <span className="text-[10px] font-bold text-red-400 uppercase tracking-wider">
                                        {resolveStormDisplayName(cycloneStormName || 'Active')}
                                    </span>
                                    <span
                                        role="button"
                                        tabIndex={0}
                                        aria-label="Dismiss storm tracking"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            onToggleCyclones();
                                            triggerHaptic('medium');
                                        }}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter') {
                                                e.stopPropagation();
                                                onToggleCyclones();
                                            }
                                        }}
                                        className="ml-0.5 w-5 h-5 rounded-full bg-red-500/25 border border-red-500/40 flex items-center justify-center text-red-300 hover:bg-red-500/50 hover:text-white transition-all active:scale-90 cursor-pointer"
                                    >
                                        <svg
                                            className="w-2.5 h-2.5"
                                            fill="none"
                                            viewBox="0 0 24 24"
                                            stroke="currentColor"
                                            strokeWidth={3}
                                        >
                                            <path
                                                strokeLinecap="round"
                                                strokeLinejoin="round"
                                                d="M6 18L18 6M6 6l12 12"
                                            />
                                        </svg>
                                    </span>
                                </span>
                            ) : allCyclones.length > 0 ? (
                                <span className="flex items-center gap-1">
                                    <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                                    <span className="text-[10px] font-bold text-amber-400">
                                        {allCyclones.length} active
                                    </span>
                                    <span className="text-gray-500 text-xs ml-0.5">{stormMenuOpen ? '▾' : '▸'}</span>
                                </span>
                            ) : (
                                <span className="text-[10px] text-gray-500">None active</span>
                            )}
                        </button>
                    )}

                    {/* Storm picker submenu */}
                    {stormMenuOpen && sortedCyclones.length > 0 && (
                        <div className="bg-black/30">
                            {sortedCyclones.map((storm, idx) => {
                                const distKm = Math.round(
                                    Math.hypot(
                                        (storm.currentPosition.lat - userLat) * 111,
                                        (storm.currentPosition.lon - userLon) *
                                            111 *
                                            Math.cos((userLat * Math.PI) / 180),
                                    ),
                                );
                                const catColors: Record<number, string> = {
                                    5: 'bg-fuchsia-500',
                                    4: 'bg-red-500',
                                    3: 'bg-orange-500',
                                    2: 'bg-amber-500',
                                    1: 'bg-yellow-500',
                                    0: 'bg-sky-500',
                                };
                                const isSelected = cycloneVisible && cycloneStormName === storm.name;
                                return (
                                    <button
                                        aria-label="Select Storm"
                                        key={`${storm.sid}-${idx}`}
                                        onClick={() => {
                                            onSelectStorm?.(storm);
                                            setStormMenuOpen(false);
                                            setShowLayerMenu(false);
                                            triggerHaptic('medium');
                                        }}
                                        className={`w-full flex items-center gap-2.5 pl-8 pr-4 py-2.5 text-left transition-colors ${
                                            isSelected ? 'bg-red-500/20 text-white' : 'text-gray-300 hover:bg-white/5'
                                        }`}
                                    >
                                        <span
                                            className={`w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-black text-white ${catColors[storm.category] ?? 'bg-gray-500'}`}
                                        >
                                            {storm.categoryLabel}
                                        </span>
                                        <div className="flex-1 min-w-0">
                                            <div className="text-xs font-bold truncate">
                                                {resolveStormDisplayName(storm.name)}
                                            </div>
                                            <div className="text-[11px] text-gray-500">
                                                {storm.maxWindKts}kt
                                                {storm.minPressureMb ? ` · ${storm.minPressureMb}hPa` : ''}
                                                {' · '}
                                                {distKm > 1000 ? `${Math.round(distKm / 1000)}k` : distKm}km
                                            </div>
                                        </div>
                                        {isSelected && (
                                            <span className="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse" />
                                        )}
                                    </button>
                                );
                            })}
                        </div>
                    )}

                    {/* Squall Radar + Lightning Strikes hidden 2026-04-23 —
                        Xweather gone, Blitzortung needs a server-side relay,
                        NOAA GOES IR + RainViewer squall replacement not wired yet.
                        Props still plumbed through so re-enable is a one-block uncomment. */}

                    {/* Weather Here */}
                    {onToggleWeatherInspect && (
                        <button
                            aria-label="Toggle weather inspect mode"
                            onClick={() => {
                                onToggleWeatherInspect();
                                triggerHaptic('light');
                            }}
                            className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                                weatherInspectMode ? 'bg-amber-500/10 text-amber-400' : 'text-gray-400 hover:bg-white/5'
                            }`}
                        >
                            <span className="text-lg">🌤️</span>
                            <span className="text-[13px] font-bold flex-1">Weather Here</span>
                            {weatherInspectMode ? (
                                <span className="flex items-center gap-1">
                                    <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shadow-lg shadow-amber-400/50 animate-pulse" />
                                    <span className="text-[10px] font-bold text-amber-400 uppercase tracking-wider">
                                        Tap Map
                                    </span>
                                </span>
                            ) : (
                                <span className="text-[10px] text-gray-500">Tap to inspect</span>
                            )}
                        </button>
                    )}

                    {/* ════════════════════���═════════════════════ */}
                    {/* ── SEA STATE (radio / exclusive) ────────── */}
                    {/* ══════════════════════════════════════════ */}
                    <SectionHeader label="Sea State" color="cyan" />

                    {[
                        { key: 'waves' as WeatherLayer, label: 'Wave Heights', icon: '🌊', hint: 'CMEMS' },
                        { key: 'currents' as WeatherLayer, label: 'Ocean Currents', icon: '🔄', hint: 'CMEMS' },
                        { key: 'sst' as WeatherLayer, label: 'Sea Surface Temp', icon: '🌡️', hint: 'CMEMS' },
                        { key: 'chl' as WeatherLayer, label: 'Chlorophyll', icon: '🌱', hint: 'CMEMS' },
                        { key: 'seaice' as WeatherLayer, label: 'Sea Ice', icon: '❄️', hint: 'CMEMS · polar' },
                        {
                            key: 'mld' as WeatherLayer,
                            label: 'Mixed Layer Depth',
                            icon: '📐',
                            hint: 'CMEMS · thermocline',
                        },
                    ].map((layer) => {
                        const isActive = activeLayers.has(layer.key);
                        return (
                            <button
                                aria-label={`Select ${layer.label} layer`}
                                key={layer.key}
                                onClick={() => {
                                    onSelectSeaState(layer.key);
                                    triggerHaptic('light');
                                }}
                                className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                                    isActive ? 'bg-cyan-500/10 text-cyan-400' : 'text-gray-400 hover:bg-white/5'
                                }`}
                            >
                                <div
                                    className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 transition-colors ${
                                        isActive ? 'border-cyan-400' : 'border-gray-600'
                                    }`}
                                >
                                    {isActive && (
                                        <div className="w-2 h-2 rounded-full bg-cyan-400 shadow-sm shadow-cyan-400/50" />
                                    )}
                                </div>
                                <span className="text-lg">{layer.icon}</span>
                                <span className="text-[13px] font-bold flex-1">{layer.label}</span>
                                {isActive ? (
                                    <span className="flex items-center gap-1">
                                        <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 shadow-lg shadow-cyan-400/50" />
                                        <span className="text-[10px] font-bold text-cyan-400 uppercase tracking-wider">
                                            Active
                                        </span>
                                    </span>
                                ) : (
                                    <span className="text-[10px] text-gray-500">{layer.hint}</span>
                                )}
                            </button>
                        );
                    })}

                    {/* ══════════════════════════════════════════ */}
                    {/* ── ATMOSPHERE (radio / exclusive) ────────── */}
                    {/* ══════════════════════════════════════════ */}
                    <SectionHeader label="Atmosphere" color="sky" />

                    {[
                        { key: 'velocity' as WeatherLayer, label: 'Wind', icon: '💨', hint: 'GFS particles' },
                        { key: 'rain' as WeatherLayer, label: 'Precipitation', icon: '🌧️', hint: 'Rainbow Global' },
                        { key: 'clouds' as WeatherLayer, label: 'Cloud Cover', icon: '☁️', hint: 'OWM' },
                        { key: 'temperature' as WeatherLayer, label: 'Temperature', icon: '🌡️', hint: 'OWM' },
                        { key: 'pressure' as WeatherLayer, label: 'Synoptic', icon: '📊', hint: 'GFS isobars' },
                        // Wind Gusts / Visibility / CAPE removed 2026-04-22 with Xweather decommission.
                    ].map((layer) => {
                        const isActive = activeLayers.has(layer.key);
                        return (
                            <button
                                aria-label={`Select ${layer.label} layer`}
                                key={layer.key}
                                onClick={() => {
                                    onSelectAtmosphere(layer.key);
                                    triggerHaptic('light');
                                }}
                                className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                                    isActive ? 'bg-sky-500/10 text-sky-400' : 'text-gray-400 hover:bg-white/5'
                                }`}
                            >
                                <div
                                    className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 transition-colors ${
                                        isActive ? 'border-sky-400' : 'border-gray-600'
                                    }`}
                                >
                                    {isActive && (
                                        <div className="w-2 h-2 rounded-full bg-sky-400 shadow-sm shadow-sky-400/50" />
                                    )}
                                </div>
                                <span className="text-lg">{layer.icon}</span>
                                <span className="text-[13px] font-bold flex-1">{layer.label}</span>
                                {isActive ? (
                                    <span className="flex items-center gap-1">
                                        <span className="w-1.5 h-1.5 rounded-full bg-sky-400 shadow-lg shadow-sky-400/50" />
                                        <span className="text-[10px] font-bold text-sky-400 uppercase tracking-wider">
                                            Active
                                        </span>
                                    </span>
                                ) : (
                                    <span className="text-[10px] text-gray-500">{layer.hint}</span>
                                )}
                            </button>
                        );
                    })}

                    {/* ══════════════════════════════════════════ */}
                    {/* ── NAVIGATION SYSTEMS (toggles) ────────── */}
                    {/* ══════════════════════════════════════════ */}
                    <SectionHeader label="Navigation" color="emerald" />

                    {/* AIS Vessels */}
                    {onToggleAis && (
                        <button
                            aria-label="Toggle AIS vessel layer"
                            onClick={() => {
                                onToggleAis();
                                triggerHaptic('light');
                            }}
                            className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                                aisVisible ? 'bg-emerald-500/10 text-emerald-400' : 'text-gray-400 hover:bg-white/5'
                            }`}
                        >
                            <span className="text-lg">⛴️</span>
                            <span className="text-[13px] font-bold flex-1">AIS Vessels</span>
                            {aisVisible && (
                                <span className="flex items-center gap-1">
                                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-lg shadow-emerald-400/50" />
                                    <span className="text-[10px] font-bold text-emerald-400 uppercase tracking-wider">
                                        Active
                                    </span>
                                </span>
                            )}
                        </button>
                    )}

                    {/* My Vessel */}
                    {onToggleVesselTracking && (
                        <button
                            aria-label="Toggle vessel tracking"
                            onClick={() => {
                                onToggleVesselTracking();
                                triggerHaptic('light');
                            }}
                            className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                                vesselTrackingVisible
                                    ? 'bg-emerald-500/10 text-emerald-400'
                                    : 'text-gray-400 hover:bg-white/5'
                            }`}
                        >
                            <span className="text-lg">📍</span>
                            <span className="text-[13px] font-bold flex-1">My Vessel</span>
                            {vesselTrackingVisible ? (
                                <span className="flex items-center gap-1">
                                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-lg shadow-emerald-400/50 animate-pulse" />
                                    <span className="text-[10px] font-bold text-emerald-400 uppercase tracking-wider">
                                        Live
                                    </span>
                                    {onLocateVessel && (
                                        <span
                                            role="button"
                                            tabIndex={0}
                                            aria-label="Fly to vessel position"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                onLocateVessel();
                                                setShowLayerMenu(false);
                                                triggerHaptic('medium');
                                            }}
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter') {
                                                    e.stopPropagation();
                                                    onLocateVessel();
                                                    setShowLayerMenu(false);
                                                }
                                            }}
                                            className="ml-1 w-5 h-5 rounded-full bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center hover:bg-emerald-500/40 transition-all active:scale-90 cursor-pointer"
                                        >
                                            <svg
                                                className="w-2.5 h-2.5 text-emerald-400"
                                                fill="none"
                                                viewBox="0 0 24 24"
                                                stroke="currentColor"
                                                strokeWidth={2.5}
                                            >
                                                <circle cx="12" cy="12" r="3" />
                                                <path strokeLinecap="round" d="M12 2v4m0 12v4M2 12h4m12 0h4" />
                                            </svg>
                                        </span>
                                    )}
                                </span>
                            ) : (
                                <span className="text-[10px] text-gray-500">GPS</span>
                            )}
                        </button>
                    )}

                    {/* Tide Stations */}
                    {onToggleTideStations && (
                        <button
                            aria-label="Toggle tide stations"
                            onClick={() => {
                                onToggleTideStations();
                                triggerHaptic('light');
                            }}
                            className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                                tideStationsVisible
                                    ? 'bg-emerald-500/10 text-teal-400'
                                    : 'text-gray-400 hover:bg-white/5'
                            }`}
                        >
                            <span className="text-lg">🌊</span>
                            <span className="text-[13px] font-bold flex-1">Tide Stations</span>
                            {tideStationsVisible ? (
                                <span className="flex items-center gap-1">
                                    {tideStationLoading ? (
                                        <>
                                            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                                            <span className="text-[10px] font-bold text-amber-400 uppercase tracking-wider">
                                                Loading
                                            </span>
                                        </>
                                    ) : (
                                        <>
                                            <span className="w-1.5 h-1.5 rounded-full bg-teal-400 shadow-lg shadow-teal-400/50" />
                                            <span className="text-[10px] font-bold text-teal-400 uppercase tracking-wider">
                                                {tideStationCount > 0 ? `${tideStationCount}` : 'Active'}
                                            </span>
                                        </>
                                    )}
                                </span>
                            ) : (
                                <span className="text-[10px] text-gray-500">Tap for predictions</span>
                            )}
                        </button>
                    )}

                    {/* Marine Protected Areas (No-Go zones) — CAPAD overlay */}
                    {onToggleMpa && (
                        <button
                            aria-label="Toggle marine reserves / no-go zones"
                            onClick={() => {
                                onToggleMpa();
                                triggerHaptic('light');
                            }}
                            className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                                mpaVisible ? 'bg-rose-500/10 text-rose-300' : 'text-gray-400 hover:bg-white/5'
                            }`}
                        >
                            <span className="text-lg">🛇</span>
                            <span className="text-[13px] font-bold flex-1">No-Go Zones</span>
                            {mpaVisible ? (
                                <span className="flex items-center gap-1">
                                    <span className="w-1.5 h-1.5 rounded-full bg-rose-400 shadow-lg shadow-rose-400/50" />
                                    <span className="text-[10px] font-bold text-rose-300 uppercase tracking-wider">
                                        {mpaFeatureCount > 0 ? `${mpaFeatureCount}` : 'Active'}
                                    </span>
                                </span>
                            ) : (
                                <span className="text-[10px] text-gray-500">Marine reserves</span>
                            )}
                        </button>
                    )}

                    {/* Sea Marks */}
                    {onToggleSeamark && (
                        <button
                            aria-label="Toggle interactive sea marks"
                            onClick={() => {
                                onToggleSeamark();
                                triggerHaptic('light');
                            }}
                            className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                                seamarkVisible
                                    ? chartsActive
                                        ? 'bg-violet-500/10 text-violet-400'
                                        : 'bg-emerald-500/10 text-teal-400'
                                    : 'text-gray-400 hover:bg-white/5'
                            }`}
                        >
                            <span className="text-lg">🔱</span>
                            <div className="flex-1">
                                <span className="text-[13px] font-bold">Sea Marks</span>
                                {chartsActive && seamarkVisible && (
                                    <p className="text-[10px] text-violet-400/60 mt-0.5">Identify mode — tap icons</p>
                                )}
                            </div>
                            {seamarkVisible ? (
                                <span className="flex items-center gap-1">
                                    {seamarkLoading ? (
                                        <>
                                            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                                            <span className="text-[10px] font-bold text-amber-400 uppercase tracking-wider">
                                                Loading
                                            </span>
                                        </>
                                    ) : (
                                        <>
                                            <span
                                                className={`w-1.5 h-1.5 rounded-full shadow-lg ${chartsActive ? 'bg-violet-400 shadow-violet-400/50' : 'bg-teal-400 shadow-teal-400/50'}`}
                                            />
                                            <span
                                                className={`text-[10px] font-bold uppercase tracking-wider ${chartsActive ? 'text-violet-400' : 'text-teal-400'}`}
                                            >
                                                {seamarkFeatureCount > 0
                                                    ? chartsActive
                                                        ? `ID · ${seamarkFeatureCount}`
                                                        : `${seamarkFeatureCount}`
                                                    : chartsActive
                                                      ? 'ID'
                                                      : 'z10+'}
                                            </span>
                                        </>
                                    )}
                                </span>
                            ) : (
                                <span className="text-[10px] text-gray-500">
                                    {chartsActive ? 'Tap to identify' : 'Tap to show'}
                                </span>
                            )}
                        </button>
                    )}

                    {/* Choke Points */}
                    {onToggleChokepoint && (
                        <button
                            aria-label="Toggle chokepoint layer"
                            onClick={() => {
                                onToggleChokepoint();
                                triggerHaptic('light');
                            }}
                            className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                                chokepointVisible ? 'bg-red-500/10 text-red-400' : 'text-gray-400 hover:bg-white/5'
                            }`}
                        >
                            <span className="text-lg">🔺</span>
                            <span className="text-[13px] font-bold flex-1">Choke Points</span>
                            {chokepointVisible && (
                                <span className="flex items-center gap-1">
                                    <span className="w-1.5 h-1.5 rounded-full bg-red-400 shadow-lg shadow-red-400/50" />
                                    <span className="text-[10px] font-bold text-red-400 uppercase tracking-wider">
                                        Active
                                    </span>
                                </span>
                            )}
                        </button>
                    )}

                    {/* ════════════════════════���═════════════════ */}
                    {/* ── CHARTS (collapsible) ────────────────── */}
                    {/* ══════════════════════════════════════════ */}
                    {hasCharts && (
                        <>
                            {/* Charts header — tappable to expand/collapse */}
                            <button
                                aria-label={showCharts ? 'Collapse charts' : 'Show charts'}
                                onClick={() => {
                                    setShowCharts(!showCharts);
                                    triggerHaptic('light');
                                    if (dismissTimer.current) clearTimeout(dismissTimer.current);
                                    dismissTimer.current = setTimeout(() => setShowLayerMenu(false), 8000);
                                }}
                                className="w-full px-4 pt-3 pb-1.5 flex items-center gap-2 hover:bg-white/5 transition-colors"
                            >
                                <span className="text-[10px] font-black uppercase tracking-[0.2em] text-violet-400/80">
                                    Charts
                                </span>
                                <div className="flex-1 h-px bg-violet-400/10" />
                                <svg
                                    className={`w-3 h-3 text-violet-400/60 transition-transform ${showCharts ? 'rotate-180' : ''}`}
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                    strokeWidth={2.5}
                                >
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                                </svg>
                            </button>

                            {showCharts && (
                                <>
                                    {/* AvNav Charts */}
                                    {skCharts.length > 0 && onToggleSkChart && (
                                        <>
                                            <div className="px-4 pt-2 pb-1">
                                                <div className="flex items-center gap-2">
                                                    <span className="text-[10px] font-black text-emerald-400/80 uppercase tracking-[0.15em]">
                                                        Nautical Charts
                                                    </span>
                                                    <span
                                                        className={`w-1.5 h-1.5 rounded-full ${skConnectionStatus === 'connected' ? 'bg-emerald-400 shadow-lg shadow-emerald-400/50' : skConnectionStatus === 'connecting' ? 'bg-amber-400 animate-pulse' : 'bg-gray-500'}`}
                                                    />
                                                    <span className="text-[10px] text-gray-500 ml-auto">AvNav</span>
                                                </div>
                                            </div>
                                            {skCharts.map((chart) => {
                                                const isActive = skChartIds.has(chart.id);
                                                return (
                                                    <button
                                                        aria-label={`Toggle chart ${chart.name}`}
                                                        key={chart.id}
                                                        onClick={() => {
                                                            onToggleSkChart(chart.id);
                                                            triggerHaptic('light');
                                                        }}
                                                        className={`w-full flex items-center gap-3 px-4 py-2 text-left transition-colors ${isActive ? 'bg-emerald-500/10 text-emerald-400' : 'text-gray-400 hover:bg-white/5'}`}
                                                    >
                                                        <AnchorIcon
                                                            className={`w-5 h-5 shrink-0 ${isActive ? 'text-emerald-400' : 'text-emerald-400/60'}`}
                                                        />
                                                        <div className="flex-1 min-w-0">
                                                            <span className="text-[13px] font-bold block truncate">
                                                                {chart.name}
                                                            </span>
                                                            {chart.description && (
                                                                <span className="text-[10px] text-gray-500 block truncate">
                                                                    {chart.description}
                                                                </span>
                                                            )}
                                                        </div>
                                                        {isActive ? (
                                                            <span className="flex items-center gap-1">
                                                                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-lg shadow-emerald-400/50" />
                                                                <span className="text-[10px] font-bold text-emerald-400 uppercase tracking-wider">
                                                                    On
                                                                </span>
                                                                {chart.bounds && onFlyToChart && (
                                                                    <span
                                                                        role="button"
                                                                        tabIndex={0}
                                                                        aria-label="Fly to chart area"
                                                                        onClick={(e) => {
                                                                            e.stopPropagation();
                                                                            onFlyToChart(chart);
                                                                            setShowLayerMenu(false);
                                                                            triggerHaptic('medium');
                                                                        }}
                                                                        onKeyDown={(e) => {
                                                                            if (e.key === 'Enter') {
                                                                                e.stopPropagation();
                                                                                onFlyToChart(chart);
                                                                                setShowLayerMenu(false);
                                                                            }
                                                                        }}
                                                                        className="ml-1 w-5 h-5 rounded-full bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center hover:bg-emerald-500/40 transition-all active:scale-90 cursor-pointer"
                                                                    >
                                                                        <svg
                                                                            className="w-2.5 h-2.5 text-emerald-400"
                                                                            fill="none"
                                                                            viewBox="0 0 24 24"
                                                                            stroke="currentColor"
                                                                            strokeWidth={2.5}
                                                                        >
                                                                            <path
                                                                                strokeLinecap="round"
                                                                                strokeLinejoin="round"
                                                                                d="M15 10.5a3 3 0 11-6 0 3 3 0 016 0z"
                                                                            />
                                                                            <path
                                                                                strokeLinecap="round"
                                                                                strokeLinejoin="round"
                                                                                d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1115 0z"
                                                                            />
                                                                        </svg>
                                                                    </span>
                                                                )}
                                                            </span>
                                                        ) : (
                                                            <span className="text-[10px] text-gray-500">
                                                                z{chart.minZoom}-{chart.maxZoom}
                                                            </span>
                                                        )}
                                                    </button>
                                                );
                                            })}
                                            {skChartIds.size > 0 && onSkChartOpacityChange && (
                                                <div className="px-4 py-1.5 flex items-center gap-2">
                                                    <span className="text-[10px] text-gray-500 font-bold uppercase tracking-wider shrink-0">
                                                        Opacity
                                                    </span>
                                                    <input
                                                        type="range"
                                                        min={0.1}
                                                        max={1}
                                                        step={0.05}
                                                        value={skChartOpacity}
                                                        onChange={(e) =>
                                                            onSkChartOpacityChange(parseFloat(e.target.value))
                                                        }
                                                        className="flex-1 h-1 accent-emerald-400 cursor-pointer"
                                                        style={{
                                                            WebkitAppearance: 'none',
                                                            background: `linear-gradient(to right, rgba(52,211,153,0.6) ${skChartOpacity * 100}%, rgba(255,255,255,0.1) ${skChartOpacity * 100}%)`,
                                                            borderRadius: 4,
                                                            height: 4,
                                                        }}
                                                    />
                                                    <span className="text-[10px] text-gray-400 font-mono w-8 text-right">
                                                        {Math.round(skChartOpacity * 100)}%
                                                    </span>
                                                </div>
                                            )}
                                        </>
                                    )}

                                    {/* Free Chart Sources */}
                                    {chartCatalogSources.length > 0 && onToggleChartSource && (
                                        <>
                                            <div className="h-px bg-white/[0.06] mx-3" />
                                            <div className="px-4 pt-2 pb-1">
                                                <span className="text-[10px] font-black text-sky-400/80 uppercase tracking-[0.15em]">
                                                    Free Charts
                                                </span>
                                            </div>
                                            {chartCatalogSources.map((src) => {
                                                const isActive = src.enabled && !!src.tileUrl;
                                                const needsKey = src.requiresKey && !src.tileUrl;
                                                return (
                                                    <div key={src.id}>
                                                        <button
                                                            aria-label={`Toggle ${src.name}`}
                                                            onClick={() => {
                                                                if (needsKey) {
                                                                    const key = prompt(
                                                                        'Enter your free LINZ API key\n(Get one at data.linz.govt.nz)',
                                                                    );
                                                                    if (key && key.length > 10 && onUpdateLinzKey) {
                                                                        onUpdateLinzKey(key);
                                                                        setTimeout(
                                                                            () => onToggleChartSource(src.id),
                                                                            100,
                                                                        );
                                                                    }
                                                                } else {
                                                                    onToggleChartSource(src.id);
                                                                }
                                                                triggerHaptic('light');
                                                            }}
                                                            className={`w-full flex items-center gap-3 px-4 py-2 text-left transition-colors ${isActive ? 'bg-sky-500/10 text-sky-400' : needsKey ? 'text-gray-500 hover:bg-white/5' : 'text-gray-400 hover:bg-white/5'}`}
                                                        >
                                                            {(() => {
                                                                const Icon = iconForChartSource(src.id);
                                                                return (
                                                                    <Icon
                                                                        className={`w-5 h-5 shrink-0 ${isActive ? 'text-sky-400' : needsKey ? 'text-amber-400/60' : 'text-sky-400/60'}`}
                                                                    />
                                                                );
                                                            })()}
                                                            <div className="flex-1 min-w-0">
                                                                <span className="text-[13px] font-bold block truncate">
                                                                    {src.name}
                                                                </span>
                                                                <span className="text-[10px] text-gray-500 block truncate">
                                                                    {src.description}
                                                                </span>
                                                            </div>
                                                            {isActive ? (
                                                                <span className="flex items-center gap-1">
                                                                    <span className="w-1.5 h-1.5 rounded-full bg-sky-400 shadow-lg shadow-sky-400/50" />
                                                                    <span className="text-[10px] font-bold text-sky-400 uppercase tracking-wider">
                                                                        On
                                                                    </span>
                                                                    {onFlyToChartSource && (
                                                                        <span
                                                                            role="button"
                                                                            tabIndex={0}
                                                                            aria-label="Fly to chart area"
                                                                            onClick={(e) => {
                                                                                e.stopPropagation();
                                                                                onFlyToChartSource(src);
                                                                                setShowLayerMenu(false);
                                                                                triggerHaptic('medium');
                                                                            }}
                                                                            onKeyDown={(e) => {
                                                                                if (e.key === 'Enter') {
                                                                                    e.stopPropagation();
                                                                                    onFlyToChartSource(src);
                                                                                    setShowLayerMenu(false);
                                                                                }
                                                                            }}
                                                                            className="ml-1 w-5 h-5 rounded-full bg-sky-500/20 border border-sky-500/30 flex items-center justify-center hover:bg-sky-500/40 transition-all active:scale-90 cursor-pointer"
                                                                        >
                                                                            <svg
                                                                                className="w-2.5 h-2.5 text-sky-400"
                                                                                fill="none"
                                                                                viewBox="0 0 24 24"
                                                                                stroke="currentColor"
                                                                                strokeWidth={2.5}
                                                                            >
                                                                                <path
                                                                                    strokeLinecap="round"
                                                                                    strokeLinejoin="round"
                                                                                    d="M15 10.5a3 3 0 11-6 0 3 3 0 016 0z"
                                                                                />
                                                                                <path
                                                                                    strokeLinecap="round"
                                                                                    strokeLinejoin="round"
                                                                                    d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1115 0z"
                                                                                />
                                                                            </svg>
                                                                        </span>
                                                                    )}
                                                                </span>
                                                            ) : needsKey ? (
                                                                <span className="text-[10px] text-amber-400/70 flex items-center gap-1">
                                                                    <svg
                                                                        className="w-3 h-3"
                                                                        fill="none"
                                                                        viewBox="0 0 24 24"
                                                                        stroke="currentColor"
                                                                        strokeWidth={2}
                                                                    >
                                                                        <path
                                                                            strokeLinecap="round"
                                                                            strokeLinejoin="round"
                                                                            d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z"
                                                                        />
                                                                    </svg>
                                                                    Setup
                                                                </span>
                                                            ) : (
                                                                <span className="text-[10px] text-gray-500">
                                                                    {src.region}
                                                                </span>
                                                            )}
                                                        </button>
                                                        {isActive && onChartSourceOpacity && (
                                                            <div className="px-4 py-1.5 flex items-center gap-2">
                                                                <span className="text-[10px] text-gray-500 font-bold uppercase tracking-wider shrink-0">
                                                                    Opacity
                                                                </span>
                                                                <input
                                                                    type="range"
                                                                    min={0.1}
                                                                    max={1}
                                                                    step={0.05}
                                                                    value={src.opacity}
                                                                    onChange={(e) =>
                                                                        onChartSourceOpacity(
                                                                            src.id,
                                                                            parseFloat(e.target.value),
                                                                        )
                                                                    }
                                                                    className="flex-1 h-1 accent-sky-400 cursor-pointer"
                                                                    style={{
                                                                        WebkitAppearance: 'none',
                                                                        background: `linear-gradient(to right, rgba(56,189,248,0.6) ${src.opacity * 100}%, rgba(255,255,255,0.1) ${src.opacity * 100}%)`,
                                                                        borderRadius: 4,
                                                                        height: 4,
                                                                    }}
                                                                />
                                                                <span className="text-[10px] text-gray-400 font-mono w-8 text-right">
                                                                    {Math.round(src.opacity * 100)}%
                                                                </span>
                                                            </div>
                                                        )}
                                                    </div>
                                                );
                                            })}
                                        </>
                                    )}

                                    {/* Local MBTiles Charts */}
                                    {localCharts.length > 0 && onToggleLocalChart && (
                                        <>
                                            <div className="h-px bg-white/[0.06] mx-3" />
                                            <div className="px-4 pt-2 pb-1 flex items-center gap-2">
                                                <span className="text-[10px] font-black text-purple-400/80 uppercase tracking-[0.15em]">
                                                    Charts on Phone
                                                </span>
                                                {localChartsLoading && (
                                                    <span className="w-3 h-3 border-2 border-purple-400 border-t-transparent rounded-full animate-spin" />
                                                )}
                                            </div>
                                            {localCharts.map((chart) => {
                                                const isActive = localChartIds.has(chart.fileName);
                                                return (
                                                    <div key={chart.fileName}>
                                                        <button
                                                            aria-label={`Toggle ${chart.name}`}
                                                            onClick={() => {
                                                                onToggleLocalChart(chart.fileName);
                                                                triggerHaptic('light');
                                                            }}
                                                            className={`w-full flex items-center gap-3 px-4 py-2 text-left transition-colors ${isActive ? 'bg-purple-500/10 text-purple-400' : 'text-gray-400 hover:bg-white/5'}`}
                                                        >
                                                            <LocalChartIcon
                                                                className={`w-5 h-5 shrink-0 ${isActive ? 'text-purple-400' : 'text-purple-400/60'}`}
                                                            />
                                                            <div className="flex-1 min-w-0">
                                                                <span className="text-[13px] font-bold block truncate">
                                                                    {chart.name}
                                                                </span>
                                                                <span className="text-[10px] text-gray-500 block truncate">
                                                                    {chart.memoryMB} MB · zoom{' '}
                                                                    {chart.metadata.minzoom ?? 0}-
                                                                    {chart.metadata.maxzoom ?? 18}
                                                                </span>
                                                            </div>
                                                            {isActive ? (
                                                                <span className="flex items-center gap-1">
                                                                    <span className="w-1.5 h-1.5 rounded-full bg-purple-400 shadow-lg shadow-purple-400/50" />
                                                                    <span className="text-[10px] font-bold text-purple-400 uppercase tracking-wider">
                                                                        On
                                                                    </span>
                                                                    {onFlyToLocalChart && chart.metadata.bounds && (
                                                                        <span
                                                                            role="button"
                                                                            tabIndex={0}
                                                                            aria-label="Fly to chart area"
                                                                            onClick={(e) => {
                                                                                e.stopPropagation();
                                                                                onFlyToLocalChart(chart);
                                                                                setShowLayerMenu(false);
                                                                                triggerHaptic('medium');
                                                                            }}
                                                                            onKeyDown={(e) => {
                                                                                if (e.key === 'Enter') {
                                                                                    e.stopPropagation();
                                                                                    onFlyToLocalChart(chart);
                                                                                    setShowLayerMenu(false);
                                                                                }
                                                                            }}
                                                                            className="ml-1 w-5 h-5 rounded-full bg-purple-500/20 border border-purple-500/30 flex items-center justify-center hover:bg-purple-500/40 transition-all active:scale-90 cursor-pointer"
                                                                        >
                                                                            <svg
                                                                                className="w-2.5 h-2.5 text-purple-400"
                                                                                fill="none"
                                                                                viewBox="0 0 24 24"
                                                                                stroke="currentColor"
                                                                                strokeWidth={2.5}
                                                                            >
                                                                                <path
                                                                                    strokeLinecap="round"
                                                                                    strokeLinejoin="round"
                                                                                    d="M15 10.5a3 3 0 11-6 0 3 3 0 016 0z"
                                                                                />
                                                                                <path
                                                                                    strokeLinecap="round"
                                                                                    strokeLinejoin="round"
                                                                                    d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1115 0z"
                                                                                />
                                                                            </svg>
                                                                        </span>
                                                                    )}
                                                                </span>
                                                            ) : (
                                                                <span className="text-[10px] text-gray-500">
                                                                    {chart.metadata.format}
                                                                </span>
                                                            )}
                                                        </button>
                                                        {isActive && onLocalChartOpacityChange && (
                                                            <div className="px-4 py-1.5 flex items-center gap-2">
                                                                <span className="text-[10px] text-gray-500 font-bold uppercase tracking-wider shrink-0">
                                                                    Opacity
                                                                </span>
                                                                <input
                                                                    type="range"
                                                                    min={0.1}
                                                                    max={1}
                                                                    step={0.05}
                                                                    value={localChartOpacity}
                                                                    onChange={(e) =>
                                                                        onLocalChartOpacityChange(
                                                                            parseFloat(e.target.value),
                                                                        )
                                                                    }
                                                                    className="flex-1 h-1 accent-purple-400 cursor-pointer"
                                                                    style={{
                                                                        WebkitAppearance: 'none',
                                                                        background: `linear-gradient(to right, rgba(168,85,247,0.6) ${localChartOpacity * 100}%, rgba(255,255,255,0.1) ${localChartOpacity * 100}%)`,
                                                                        borderRadius: 4,
                                                                        height: 4,
                                                                    }}
                                                                />
                                                                <span className="text-[10px] text-gray-400 font-mono w-8 text-right">
                                                                    {Math.round(localChartOpacity * 100)}%
                                                                </span>
                                                            </div>
                                                        )}
                                                    </div>
                                                );
                                            })}
                                        </>
                                    )}
                                </>
                            )}
                        </>
                    )}

                    {/* ── Clear All ── */}
                    {totalActive > 0 && (
                        <>
                            <div className="h-px bg-white/[0.06] mx-3 mt-1" />
                            <button
                                aria-label="Clear all active layers"
                                onClick={() => {
                                    toggleLayer('none');
                                    triggerHaptic('light');
                                    setShowLayerMenu(false);
                                }}
                                className="w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors text-red-400 hover:bg-red-500/10"
                            >
                                <span className="text-lg">✕</span>
                                <span className="text-[13px] font-bold flex-1">Clear All Layers</span>
                                <span className="text-[10px] text-red-400/60 font-mono">{totalActive}</span>
                            </button>
                        </>
                    )}
                </div>
            )}
        </div>
    );
};
