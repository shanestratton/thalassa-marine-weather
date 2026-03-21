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
import { triggerHaptic } from '../../utils/system';

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
            aria-label="Set"
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
        <span className="text-[8px] font-bold text-white/60 uppercase tracking-wider mb-1">kts</span>
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
                <span key={label} className="text-[8px] font-semibold text-white/50 leading-none">
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
    const LEGEND_ELIGIBLE: WeatherLayer[] = ['temperature', 'clouds', 'pressure'];

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
                <span className="text-[9px] font-black text-white/80 uppercase tracking-[0.15em] leading-none">
                    {legend.topLabel}
                </span>

                {/* Gradient bar */}
                <div
                    className="w-2.5 rounded-full border border-white/10 my-1"
                    style={{ height: 100, background: legend.gradient }}
                />

                {/* Bottom label + arrow */}
                <span className="text-[9px] font-black text-white/80 uppercase tracking-[0.15em] leading-none">
                    {legend.bottomLabel}
                </span>
                <span className="text-sky-400 text-[11px] font-black leading-none">{legend.bottomArrow}</span>
            </div>
        </div>
    );
};

// ── Layer FAB Menu ──
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
}> = ({
    activeLayers,
    showLayerMenu,
    embedded,
    location,
    initialZoom,
    center,
    mapRef,
    toggleLayer,
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
}) => {
    const activeCount = activeLayers.size;
    const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [stormMenuOpen, setStormMenuOpen] = useState(false);

    // Auto-dismiss menu after 5 seconds of inactivity
    useEffect(() => {
        if (!showLayerMenu) return;
        dismissTimer.current = setTimeout(() => setShowLayerMenu(false), 8000);
        return () => {
            if (dismissTimer.current) clearTimeout(dismissTimer.current);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [showLayerMenu, activeCount, stormMenuOpen]); // reset on every toggle

    // Reset submenu when main menu closes
    useEffect(() => {
        if (!showLayerMenu) setStormMenuOpen(false);
    }, [showLayerMenu]);

    // Sort cyclones by distance from user
    const sortedCyclones = [...allCyclones].sort((a, b) => {
        const dA = Math.hypot(a.currentPosition.lat - userLat, a.currentPosition.lon - userLon);
        const dB = Math.hypot(b.currentPosition.lat - userLat, b.currentPosition.lon - userLon);
        return dA - dB;
    });

    return (
        <div className={`absolute z-[500] flex flex-col items-end gap-2 top-14 right-4`}>
            <button
                aria-label="Menu"
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
                {activeCount > 0 && (
                    <span className="absolute -top-1 -right-1 w-4 h-4 bg-sky-500 rounded-full flex items-center justify-center text-[11px] font-black text-white shadow-lg shadow-sky-500/50">
                        {activeCount}
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

            {showLayerMenu && (
                <div
                    className="bg-slate-900/95 border border-white/[0.08] rounded-2xl overflow-hidden overflow-y-auto shadow-2xl animate-in fade-in slide-in-from-top-2 duration-200"
                    style={{ maxHeight: 'calc(100vh - 240px)' }}
                >
                    {/* ── Major Storms (top of menu) ── */}
                    {onToggleCyclones && (
                        <>
                            <button
                                aria-label="Cyclones"
                                onClick={() => {
                                    if (allCyclones.length > 0) {
                                        setStormMenuOpen(!stormMenuOpen);
                                        triggerHaptic('light');
                                    } else {
                                        onToggleCyclones();
                                        triggerHaptic('light');
                                    }
                                }}
                                className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors ${
                                    cycloneVisible
                                        ? 'bg-red-500/15 text-red-400 border-l-2 border-red-400'
                                        : 'text-gray-400 hover:bg-white/5 border-l-2 border-transparent'
                                }`}
                            >
                                <span className="text-xl">🌀</span>
                                <span className="text-sm font-bold flex-1">Major Storms</span>
                                {cycloneVisible ? (
                                    <span className="flex items-center gap-1.5">
                                        <span className="w-1.5 h-1.5 rounded-full bg-red-400 shadow-lg shadow-red-400/50 animate-pulse" />
                                        <span className="text-[11px] font-bold text-red-400 uppercase tracking-wider">
                                            {cycloneStormName || 'Active'}
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
                                            onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onToggleCyclones(); } }}
                                            className="ml-0.5 w-5 h-5 rounded-full bg-red-500/25 border border-red-500/40 flex items-center justify-center text-red-300 hover:bg-red-500/50 hover:text-white transition-all active:scale-90 cursor-pointer"
                                        >
                                            <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                                                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                                            </svg>
                                        </span>
                                    </span>
                                ) : allCyclones.length > 0 ? (
                                    <span className="flex items-center gap-1">
                                        <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                                        <span className="text-[11px] font-bold text-amber-400">
                                            {allCyclones.length} active
                                        </span>
                                        <span className="text-gray-500 text-xs ml-1">{stormMenuOpen ? '▾' : '▸'}</span>
                                    </span>
                                ) : (
                                    <span className="text-[11px] text-gray-500">None active</span>
                                )}
                            </button>

                            {/* ── Storm picker submenu ── */}
                            {stormMenuOpen && sortedCyclones.length > 0 && (
                                <div className="bg-black/30">
                                    {sortedCyclones.map((storm) => {
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
                                        const isSelected = cycloneStormName === storm.name;
                                        return (
                                            <button
                                                aria-label="Select Storm"
                                                key={storm.sid}
                                                onClick={() => {
                                                    onSelectStorm?.(storm);
                                                    setStormMenuOpen(false);
                                                    setShowLayerMenu(false);
                                                    triggerHaptic('medium');
                                                }}
                                                className={`w-full flex items-center gap-2.5 pl-8 pr-4 py-2.5 text-left transition-colors ${
                                                    isSelected
                                                        ? 'bg-red-500/20 text-white'
                                                        : 'text-gray-300 hover:bg-white/5'
                                                }`}
                                            >
                                                <span
                                                    className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-black text-white ${catColors[storm.category] ?? 'bg-gray-500'}`}
                                                >
                                                    {storm.categoryLabel}
                                                </span>
                                                <div className="flex-1 min-w-0">
                                                    <div className="text-xs font-bold truncate">{storm.name}</div>
                                                    <div className="text-[10px] text-gray-500">
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
                            <div className="h-px bg-white/[0.06] mx-3" />
                        </>
                    )}

                    {/* ── Weather Here ── */}
                    {onToggleWeatherInspect && (
                        <>
                            <button
                                aria-label="Toggle"
                                onClick={() => {
                                    onToggleWeatherInspect();
                                    triggerHaptic('light');
                                }}
                                className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors ${weatherInspectMode ? 'bg-amber-500/20 text-amber-400 border-l-2 border-amber-400' : 'text-gray-400 hover:bg-white/5 border-l-2 border-transparent'}`}
                            >
                                <span className="text-xl">🌤️</span>
                                <span className="text-sm font-bold flex-1">Weather Here</span>
                                {weatherInspectMode ? (
                                    <span className="flex items-center gap-1">
                                        <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shadow-lg shadow-amber-400/50 animate-pulse" />
                                        <span className="text-[11px] font-bold text-amber-400 uppercase tracking-wider">
                                            Tap Map
                                        </span>
                                    </span>
                                ) : (
                                    <span className="text-[11px] text-gray-500">Tap to enable</span>
                                )}
                            </button>
                            <div className="h-px bg-white/[0.06] mx-3" />
                        </>
                    )}

                    {/* ── AIS Vessels ── */}
                    {onToggleAis && (
                        <>
                            <button
                                aria-label="Toggle"
                                onClick={() => {
                                    onToggleAis();
                                    triggerHaptic('light');
                                }}
                                className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors ${aisVisible ? 'bg-sky-500/20 text-sky-400 border-l-2 border-sky-400' : 'text-gray-400 hover:bg-white/5 border-l-2 border-transparent'}`}
                            >
                                <span className="text-xl">⛴️</span>
                                <span className="text-sm font-bold flex-1">AIS Vessels</span>
                                {aisVisible && (
                                    <span className="flex items-center gap-1">
                                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-lg shadow-emerald-400/50" />
                                        <span className="text-[11px] font-bold text-emerald-400 uppercase tracking-wider">
                                            Active
                                        </span>
                                    </span>
                                )}
                            </button>
                            <div className="h-px bg-white/[0.06] mx-3" />
                        </>
                    )}

                    {/* ── Weather layers: Rain, Wind, Temp, Clouds, Sea Marks ── */}
                    {(
                        [
                            { key: 'rain', label: 'Rain', icon: '🌧️' },
                            { key: 'velocity', label: 'Wind', icon: '💨' },
                            { key: 'pressure', label: 'Synoptic', icon: '📊' },
                            { key: 'temperature', label: 'Temp', icon: '🌡️' },
                            { key: 'clouds', label: 'Clouds', icon: '☁️' },
                            { key: 'sea', label: 'Sea Marks', icon: '⚓' },
                        ] as const
                    ).map((layer) => {
                        const isActive = activeLayers.has(layer.key);
                        return (
                            <button
                                aria-label="Layer"
                                key={layer.key}
                                onClick={() => {
                                    toggleLayer(layer.key);
                                    triggerHaptic('light');
                                }}
                                className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors ${isActive ? 'bg-sky-500/20 text-sky-400 border-l-2 border-sky-400' : 'text-gray-400 hover:bg-white/5 border-l-2 border-transparent'}`}
                            >
                                <span className="text-xl">{layer.icon}</span>
                                <span className="text-sm font-bold flex-1">{layer.label}</span>
                                {isActive && (
                                    <span className="flex items-center gap-1">
                                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-lg shadow-emerald-400/50" />
                                        <span className="text-[11px] font-bold text-emerald-400 uppercase tracking-wider">
                                            Active
                                        </span>
                                    </span>
                                )}
                            </button>
                        );
                    })}

                    {/* ── Chokepoints (last) ── */}
                    {onToggleChokepoint && (
                        <>
                            <div className="h-px bg-white/[0.06] mx-3" />
                            <button
                                aria-label="Toggle"
                                onClick={() => {
                                    onToggleChokepoint();
                                    triggerHaptic('light');
                                }}
                                className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors ${chokepointVisible ? 'bg-red-500/15 text-red-400 border-l-2 border-red-400' : 'text-gray-400 hover:bg-white/5 border-l-2 border-transparent'}`}
                            >
                                <span className="text-xl">🔺</span>
                                <span className="text-sm font-bold flex-1">Chokepoints</span>
                                {chokepointVisible && (
                                    <span className="flex items-center gap-1">
                                        <span className="w-1.5 h-1.5 rounded-full bg-red-400 shadow-lg shadow-red-400/50" />
                                        <span className="text-[11px] font-bold text-red-400 uppercase tracking-wider">
                                            Active
                                        </span>
                                    </span>
                                )}
                            </button>
                        </>
                    )}

                    {/* ── Clear All ── */}
                    {activeCount > 0 && (
                        <>
                            <div className="h-px bg-white/[0.06] mx-3" />
                            <button
                                aria-label="Layer"
                                onClick={() => {
                                    toggleLayer('none');
                                    triggerHaptic('light');
                                    setShowLayerMenu(false);
                                }}
                                className="w-full flex items-center gap-3 px-4 py-3 text-left transition-colors text-red-400 hover:bg-red-500/10 border-l-2 border-transparent"
                            >
                                <span className="text-xl">🗺️</span>
                                <span className="text-sm font-bold flex-1">Clear All</span>
                            </button>
                        </>
                    )}
                </div>
            )}
        </div>
    );
};
