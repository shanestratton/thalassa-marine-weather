/**
 * WeatherRoutingPanel — Interactive route planning overlay for the Map tab.
 *
 * Slides up from bottom, shows waypoint list, route analysis summary,
 * and weather-along-route cards. Integrates with WeatherMap via callbacks.
 */
import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import {
    computeRoute,
    formatDistance,
    formatDuration,
    formatETA,
    type RouteWaypoint,
    type RouteAnalysis,
    type RoutingConfig,
} from '../../services/WeatherRoutingService';
import { triggerHaptic } from '../../utils/system';

interface WeatherRoutingPanelProps {
    onRouteChange: (coords: [number, number][], waypoints: RouteWaypoint[]) => void;
    onClose: () => void;
    currentLat?: number;
    currentLon?: number;
    onAddWaypointMode: (enabled: boolean) => void;
}

export const WeatherRoutingPanel: React.FC<WeatherRoutingPanelProps> = ({
    onRouteChange,
    onClose,
    currentLat,
    currentLon,
    onAddWaypointMode,
}) => {
    const [waypoints, setWaypoints] = useState<RouteWaypoint[]>([]);
    const [analysis, setAnalysis] = useState<RouteAnalysis | null>(null);
    const [expanded, setExpanded] = useState(true);
    const [addingWaypoint, setAddingWaypoint] = useState(false);
    const [editingName, setEditingName] = useState<string | null>(null);
    const nameInputRef = useRef<HTMLInputElement>(null);

    // Route config
    const [speed, setSpeed] = useState(6);
    const [fuelRate, setFuelRate] = useState<string>('');
    const [showConfig, setShowConfig] = useState(false);

    // ── Recompute route when waypoints or config changes ──
    useEffect(() => {
        if (waypoints.length >= 2) {
            const result = computeRoute([...waypoints], {
                speed,
                departureTime: new Date(),
                fuelRate: fuelRate ? parseFloat(fuelRate) : null,
            });
            setAnalysis(result);
            onRouteChange(result.routeCoordinates, result.waypoints);
        } else {
            setAnalysis(null);
            onRouteChange([], waypoints);
        }
    }, [waypoints, speed, fuelRate, onRouteChange]);

    // ── Add waypoint at current location ──
    const addCurrentLocation = useCallback(() => {
        if (currentLat == null || currentLon == null) return;
        triggerHaptic('medium');
        const wp: RouteWaypoint = {
            id: `wp_${Date.now()}`,
            lat: Math.round(currentLat * 10000) / 10000,
            lon: Math.round(currentLon * 10000) / 10000,
            name: waypoints.length === 0 ? 'Departure' : `WP ${waypoints.length + 1}`,
        };
        setWaypoints(prev => [...prev, wp]);
    }, [currentLat, currentLon, waypoints.length]);

    // ── Add waypoint from map tap ──
    const handleMapWaypoint = useCallback((lat: number, lon: number) => {
        triggerHaptic('light');
        const wp: RouteWaypoint = {
            id: `wp_${Date.now()}`,
            lat: Math.round(lat * 10000) / 10000,
            lon: Math.round(lon * 10000) / 10000,
            name: waypoints.length === 0 ? 'Departure' : `WP ${waypoints.length + 1}`,
        };
        setWaypoints(prev => [...prev, wp]);
        setAddingWaypoint(false);
        onAddWaypointMode(false);
    }, [waypoints.length, onAddWaypointMode]);

    // Expose handleMapWaypoint to parent via window (simple bridge)
    useEffect(() => {
        (window as any).__routingAddWaypoint = handleMapWaypoint;
        return () => { delete (window as any).__routingAddWaypoint; };
    }, [handleMapWaypoint]);

    // ── Remove waypoint ──
    const removeWaypoint = useCallback((id: string) => {
        triggerHaptic('light');
        setWaypoints(prev => prev.filter(w => w.id !== id));
    }, []);

    // ── Reorder: move waypoint up ──
    const moveUp = useCallback((idx: number) => {
        if (idx <= 0) return;
        setWaypoints(prev => {
            const arr = [...prev];
            [arr[idx - 1], arr[idx]] = [arr[idx], arr[idx - 1]];
            return arr;
        });
    }, []);

    // ── Rename waypoint ──
    const handleRename = useCallback((id: string, name: string) => {
        setWaypoints(prev => prev.map(wp => wp.id === id ? { ...wp, name } : wp));
        setEditingName(null);
    }, []);

    // Focus name input when editing
    useEffect(() => {
        if (editingName && nameInputRef.current) {
            nameInputRef.current.focus();
            nameInputRef.current.select();
        }
    }, [editingName]);

    // Toggle add-waypoint mode
    const toggleAddMode = useCallback(() => {
        const next = !addingWaypoint;
        setAddingWaypoint(next);
        onAddWaypointMode(next);
        triggerHaptic('light');
    }, [addingWaypoint, onAddWaypointMode]);

    // ── Clear route ──
    const clearRoute = useCallback(() => {
        triggerHaptic('medium');
        setWaypoints([]);
        setAnalysis(null);
        onRouteChange([], []);
    }, [onRouteChange]);

    return (
        <div className={`absolute bottom-16 left-0 right-0 z-[900] transition-all duration-300 flex flex-col ${expanded ? 'max-h-[55vh]' : 'max-h-14'
            }`}>
            {/* Add-waypoint mode indicator */}
            {addingWaypoint && (
                <div className="mx-4 mb-2 px-4 py-2 bg-sky-600/90 backdrop-blur-xl rounded-2xl text-center animate-pulse">
                    <p className="text-xs font-black text-white tracking-widest">TAP MAP TO ADD WAYPOINT</p>
                </div>
            )}

            {/* ═══ MAIN PANEL ═══ */}
            <div className="mx-2 bg-slate-900/95 backdrop-blur-xl border border-white/[0.08] rounded-t-3xl shadow-2xl shadow-black/50 overflow-hidden flex flex-col">

                {/* ── Drag handle + header ── */}
                <button
                    onClick={() => setExpanded(!expanded)}
                    className="py-3 px-5 flex items-center gap-3 w-full shrink-0"
                >
                    <div className="w-10 h-1 bg-white/20 rounded-full mx-auto absolute left-1/2 -translate-x-1/2 top-2" />

                    <svg className="w-5 h-5 text-sky-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 6.75V15m6-6v8.25m.503 3.498l4.875-2.437c.381-.19.622-.58.622-1.006V4.82c0-.836-.88-1.38-1.628-1.006l-3.869 1.934c-.317.159-.69.159-1.006 0L9.503 3.252a1.125 1.125 0 00-1.006 0L3.622 5.689C3.24 5.88 3 6.27 3 6.695V19.18c0 .836.88 1.38 1.628 1.006l3.869-1.934c.317-.159.69-.159 1.006 0l4.994 2.497c.317.158.69.158 1.006 0z" />
                    </svg>

                    <div className="flex-1 text-left">
                        <h3 className="text-sm font-black text-white">Weather Routing</h3>
                        {analysis && (
                            <p className="text-[10px] text-gray-500 font-bold">
                                {formatDistance(analysis.totalDistance)} · {formatDuration(analysis.estimatedDuration)} · {waypoints.length} waypoints
                            </p>
                        )}
                    </div>

                    <button onClick={(e) => { e.stopPropagation(); onClose(); }} className="p-1.5 rounded-lg hover:bg-white/10">
                        <svg className="w-4 h-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                    </button>
                </button>

                {expanded && (
                    <div className="px-4 pb-4 overflow-y-auto flex-1">

                        {/* ── Route Summary Card (if computed) ── */}
                        {analysis && analysis.totalDistance > 0 && (
                            <div className="grid grid-cols-4 gap-2 mb-4">
                                <SummaryCard label="Distance" value={formatDistance(analysis.totalDistance)} icon="📏" />
                                <SummaryCard label="ETA" value={formatDuration(analysis.estimatedDuration)} icon="⏱️" />
                                <SummaryCard label="Arrival" value={formatETA(analysis.arrivalTime)} icon="🏁" />
                                <SummaryCard
                                    label="Fuel"
                                    value={analysis.fuelEstimate ? `${analysis.fuelEstimate} L` : '—'}
                                    icon="⛽"
                                />
                            </div>
                        )}

                        {/* ── Weather Along Route ── */}
                        {analysis && analysis.maxWindSpeed != null && (
                            <div className="flex items-center gap-2 mb-4 px-3 py-2 rounded-xl bg-white/[0.03] border border-white/[0.06]">
                                <span className="text-[10px] text-gray-500 font-bold uppercase tracking-widest">Route Wx:</span>
                                <span className="text-xs text-white font-bold">💨 {analysis.maxWindSpeed}kts max</span>
                                {analysis.maxWaveHeight != null && (
                                    <span className="text-xs text-white font-bold">🌊 {analysis.maxWaveHeight.toFixed(1)}m</span>
                                )}
                                <span className={`text-xs font-bold ${analysis.favorablePercentage > 50 ? 'text-emerald-400' : 'text-amber-400'}`}>
                                    ✓ {analysis.favorablePercentage}% favorable
                                </span>
                            </div>
                        )}

                        {/* ── Waypoint List ── */}
                        <div className="space-y-1.5 mb-4">
                            {waypoints.map((wp, idx) => (
                                <div key={wp.id} className="flex items-center gap-2 group">
                                    {/* Node connector */}
                                    <div className="flex flex-col items-center w-6 shrink-0">
                                        <div className={`w-3 h-3 rounded-full border-2 ${idx === 0 ? 'border-emerald-400 bg-emerald-400/30' :
                                                idx === waypoints.length - 1 ? 'border-red-400 bg-red-400/30' :
                                                    'border-sky-400 bg-sky-400/30'
                                            }`} />
                                        {idx < waypoints.length - 1 && (
                                            <div className="w-0.5 h-6 bg-white/10" />
                                        )}
                                    </div>

                                    {/* Waypoint info */}
                                    <div className="flex-1 py-1.5 px-3 rounded-xl bg-white/[0.03] border border-white/[0.06] flex items-center gap-2 min-w-0">
                                        {editingName === wp.id ? (
                                            <input
                                                ref={nameInputRef}
                                                defaultValue={wp.name}
                                                onBlur={(e) => handleRename(wp.id, e.target.value || wp.name)}
                                                onKeyDown={(e) => {
                                                    if (e.key === 'Enter') handleRename(wp.id, (e.target as HTMLInputElement).value || wp.name);
                                                }}
                                                className="flex-1 bg-transparent text-sm text-white font-bold outline-none"
                                            />
                                        ) : (
                                            <button onClick={() => setEditingName(wp.id)} className="flex-1 text-left min-w-0">
                                                <p className="text-xs font-black text-white truncate">{wp.name}</p>
                                                <p className="text-[9px] text-gray-600 font-mono">{wp.lat.toFixed(4)}, {wp.lon.toFixed(4)}</p>
                                            </button>
                                        )}

                                        {/* ETA badge */}
                                        {wp.arrivalTime && idx > 0 && (
                                            <span className="text-[8px] text-gray-500 font-bold shrink-0">
                                                {formatETA(wp.arrivalTime)}
                                            </span>
                                        )}

                                        {/* Move up */}
                                        {idx > 0 && (
                                            <button onClick={() => moveUp(idx)} className="p-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                                <svg className="w-3 h-3 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 15.75l7.5-7.5 7.5 7.5" />
                                                </svg>
                                            </button>
                                        )}

                                        {/* Remove */}
                                        <button onClick={() => removeWaypoint(wp.id)} className="p-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                            <svg className="w-3 h-3 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                                            </svg>
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>

                        {/* ── Action Buttons ── */}
                        <div className="flex gap-2">
                            <button
                                onClick={addCurrentLocation}
                                className="flex-1 py-2.5 bg-white/[0.04] border border-white/[0.08] rounded-xl text-[10px] font-black text-gray-400 uppercase tracking-widest hover:bg-white/[0.08] transition-all active:scale-[0.97] flex items-center justify-center gap-1.5"
                            >
                                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 10.5a3 3 0 11-6 0 3 3 0 016 0z" />
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1115 0z" />
                                </svg>
                                Current Pos
                            </button>

                            <button
                                onClick={toggleAddMode}
                                className={`flex-1 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all active:scale-[0.97] flex items-center justify-center gap-1.5 ${addingWaypoint
                                        ? 'bg-sky-600 text-white'
                                        : 'bg-white/[0.04] border border-white/[0.08] text-gray-400 hover:bg-white/[0.08]'
                                    }`}
                            >
                                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                                </svg>
                                {addingWaypoint ? 'Cancel' : 'Tap Map'}
                            </button>

                            {waypoints.length > 0 && (
                                <button
                                    onClick={clearRoute}
                                    className="px-3 py-2.5 bg-red-500/10 border border-red-500/20 rounded-xl text-[10px] font-black text-red-400 uppercase tracking-widest hover:bg-red-500/20 transition-all active:scale-[0.97]"
                                >
                                    Clear
                                </button>
                            )}
                        </div>

                        {/* ── Route Config (toggle) ── */}
                        <button
                            onClick={() => setShowConfig(!showConfig)}
                            className="mt-3 w-full text-left text-[9px] text-gray-600 font-bold uppercase tracking-widest hover:text-gray-400 transition-colors"
                        >
                            {showConfig ? '▼' : '▶'} Route Settings
                        </button>

                        {showConfig && (
                            <div className="mt-2 flex gap-3">
                                <div className="flex-1">
                                    <label className="text-[9px] text-gray-600 font-bold uppercase tracking-widest block mb-1">Speed (kts)</label>
                                    <input
                                        type="number"
                                        value={speed}
                                        onChange={e => setSpeed(Math.max(1, parseInt(e.target.value) || 6))}
                                        className="w-full bg-white/[0.04] border border-white/[0.06] rounded-lg px-2 py-1.5 text-sm text-white font-mono outline-none focus:border-sky-500/30"
                                    />
                                </div>
                                <div className="flex-1">
                                    <label className="text-[9px] text-gray-600 font-bold uppercase tracking-widest block mb-1">Fuel Rate (L/hr)</label>
                                    <input
                                        type="text"
                                        inputMode="decimal"
                                        value={fuelRate}
                                        onChange={e => setFuelRate(e.target.value)}
                                        placeholder="Optional"
                                        className="w-full bg-white/[0.04] border border-white/[0.06] rounded-lg px-2 py-1.5 text-sm text-white font-mono placeholder-gray-600 outline-none focus:border-sky-500/30"
                                    />
                                </div>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
};

// ── Summary Card ────────────────────────────────────────────────

const SummaryCard: React.FC<{ label: string; value: string; icon: string }> = ({ label, value, icon }) => (
    <div className="p-2.5 rounded-xl bg-white/[0.04] border border-white/[0.06] text-center">
        <span className="text-base">{icon}</span>
        <p className="text-xs font-black text-white mt-0.5 truncate">{value}</p>
        <p className="text-[8px] text-gray-600 font-bold uppercase tracking-widest">{label}</p>
    </div>
);
