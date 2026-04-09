/**
 * TheGlassPage — "Instrument Panel" fullscreen NMEA instrument dashboard.
 *
 * Premium multimeter view with:
 *   - SOG + AWS top row (2-col with sparklines)
 *   - TWS hero arc gauge (center, with rolling chart + MAX tracker)
 *   - Depth Sounder + COG Compass + Heel Angle (3-col)
 *   - NMEA Data (sensor status + voltage) + Voyage (trip dist) bottom row
 *
 * All data is live from the NmeaStore via useNmeaStore().
 * Sparklines store 60 samples of 1-second history in local state.
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNmeaStore } from './useNmeaStore';
import { ArcGauge } from './gauges/ArcGauge';
import { CompassGauge } from './gauges/CompassGauge';
import { triggerHaptic } from '../../utils/system';
import type { TimestampedMetric } from '../../services/NmeaStore';

interface TheGlassPageProps {
    onBack: () => void;
}

// ── Sparkline component — 60-sample rolling SVG polyline ──
const HISTORY_SIZE = 90; // 90 seconds of data

interface SparklineProps {
    history: number[];
    min: number;
    max: number;
    color: string;
    width?: number;
    height?: number;
    showAxes?: boolean;
    axisUnit?: string;
    label?: string;
}

const Sparkline: React.FC<SparklineProps> = ({
    history,
    min,
    max,
    color,
    width = 120,
    height = 50,
    showAxes = false,
    axisUnit,
    label,
}) => {
    if (history.length < 2) return <div style={{ width, height }} className="opacity-20" />;

    const range = max - min || 1;
    const padX = showAxes ? 24 : 4;
    const padY = 4;
    const chartW = width - padX * 2;
    const chartH = height - padY * 2;

    const points = history
        .map((v, i) => {
            const x = padX + (i / (HISTORY_SIZE - 1)) * chartW;
            const y = padY + chartH - ((v - min) / range) * chartH;
            return `${x},${y}`;
        })
        .join(' ');

    // Fill polygon (area under curve)
    const first = history[0];
    const firstX = padX + (0 / (HISTORY_SIZE - 1)) * chartW;
    const lastX = padX + ((history.length - 1) / (HISTORY_SIZE - 1)) * chartW;
    const bottomY = padY + chartH;
    const fillPoints = `${firstX},${bottomY} ${points} ${lastX},${bottomY}`;

    return (
        <svg width={width} height={height} className="block">
            {/* Gradient fill under line */}
            <defs>
                <linearGradient id={`spark-fill-${label}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={color} stopOpacity={0.3} />
                    <stop offset="100%" stopColor={color} stopOpacity={0.02} />
                </linearGradient>
            </defs>
            <polygon points={fillPoints} fill={`url(#spark-fill-${label})`} />
            <polyline points={points} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />

            {/* Axis labels */}
            {showAxes && (
                <>
                    <text x={2} y={padY + 4} fill="rgba(255,255,255,0.3)" fontSize="7" fontFamily="system-ui">
                        {max}
                        {axisUnit}
                    </text>
                    <text x={2} y={padY + chartH} fill="rgba(255,255,255,0.3)" fontSize="7" fontFamily="system-ui">
                        {min}
                        {axisUnit}
                    </text>
                </>
            )}
        </svg>
    );
};

// ── Heel gauge — inline level indicator ──
const HeelGauge: React.FC<{ degrees: number | null }> = ({ degrees }) => {
    const angle = degrees ?? 0;
    const side = angle >= 0 ? 'STBD' : 'PORT';
    const absAngle = Math.abs(angle);
    const isDead = degrees === null;

    return (
        <div className="flex flex-col items-center gap-1">
            {/* Circular heel gauge */}
            <div className="relative" style={{ width: 80, height: 80 }}>
                <svg viewBox="0 0 80 80" className="w-full h-full">
                    {/* Outer ring with color zones */}
                    <circle cx="40" cy="40" r="35" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="6" />
                    {/* Colored zone arc — green near center, yellow mid, red extreme */}
                    <circle
                        cx="40"
                        cy="40"
                        r="35"
                        fill="none"
                        stroke={absAngle > 25 ? '#ef4444' : absAngle > 15 ? '#eab308' : '#22c55e'}
                        strokeWidth="6"
                        strokeDasharray={`${(absAngle / 45) * 110} 220`}
                        strokeDashoffset={angle >= 0 ? 0 : -(absAngle / 45) * 110}
                        strokeLinecap="round"
                        opacity={isDead ? 0.2 : 0.6}
                        transform="rotate(-90 40 40)"
                    />
                    {/* Center fluid level indicator */}
                    <rect
                        x="20"
                        y="36"
                        width="40"
                        height="8"
                        rx="4"
                        fill="rgba(56,189,248,0.15)"
                        stroke="rgba(56,189,248,0.3)"
                        strokeWidth="0.5"
                    />
                    {/* Bubble indicator */}
                    <circle
                        cx={40 + (angle ?? 0) * 0.8}
                        cy="40"
                        r="3"
                        fill="#38bdf8"
                        opacity={isDead ? 0.2 : 0.9}
                        style={{ transition: 'cx 0.5s ease-out' }}
                    />
                    {/* Center tick marks */}
                    <line x1="40" y1="32" x2="40" y2="34" stroke="rgba(255,255,255,0.3)" strokeWidth="1" />
                </svg>
            </div>
            <div className="text-center">
                <span className="text-2xl font-black text-white tabular-nums font-mono">
                    {isDead ? '--' : `${absAngle}`}
                </span>
                <span className="text-sm font-bold text-gray-400">°</span>
                <p className="text-[10px] font-bold uppercase tracking-widest text-gray-500">{isDead ? '---' : side}</p>
            </div>
        </div>
    );
};

// ── Sensor status icon ──
const SensorIcon: React.FC<{ icon: string; label: string; active: boolean }> = ({ icon, label, active }) => (
    <div className="flex flex-col items-center gap-0.5">
        <span className={`text-lg ${active ? 'opacity-100' : 'opacity-20'}`}>{icon}</span>
        <span className={`text-[9px] font-bold uppercase tracking-wider ${active ? 'text-cyan-400' : 'text-gray-600'}`}>
            {label}
        </span>
    </div>
);

// ── Helper: use metric history ──
function useMetricHistory(metric: TimestampedMetric): { history: number[]; max: number; min: number } {
    const [history, setHistory] = useState<number[]>([]);
    const lastRef = useRef<number>(0);
    const maxRef = useRef<number>(-Infinity);
    const minRef = useRef<number>(Infinity);

    useEffect(() => {
        // Only push new values when metric updates
        if (metric.value !== null && metric.lastUpdated !== lastRef.current) {
            lastRef.current = metric.lastUpdated;
            const v = metric.value;
            if (v > maxRef.current) maxRef.current = v;
            if (v < minRef.current) minRef.current = v;
            setHistory((prev) => {
                const next = [...prev, v];
                return next.length > HISTORY_SIZE ? next.slice(-HISTORY_SIZE) : next;
            });
        }
    }, [metric.value, metric.lastUpdated]);

    return { history, max: maxRef.current, min: minRef.current };
}

// ══════════════════════════════════════════════
// THE GLASS PAGE
// ══════════════════════════════════════════════

export const TheGlassPage: React.FC<TheGlassPageProps> = ({ onBack }) => {
    const state = useNmeaStore();

    // Sparkline histories
    const sogHistory = useMetricHistory(state.sog);
    const twsHistory = useMetricHistory(state.tws);
    const depthHistory = useMetricHistory(state.depth);

    // TWS max tracker
    const [twsMax, setTwsMax] = useState<number>(0);
    useEffect(() => {
        if (state.tws.value !== null && state.tws.value > twsMax) {
            setTwsMax(state.tws.value);
        }
    }, [state.tws.value, twsMax]);

    // Trip distance accumulator (SOG × dt)
    const [tripDist, setTripDist] = useState<number>(0);
    const lastSogTime = useRef<number>(0);
    useEffect(() => {
        if (state.sog.value !== null && state.sog.freshness === 'live') {
            const now = Date.now();
            if (lastSogTime.current > 0) {
                const dtHours = (now - lastSogTime.current) / 3_600_000;
                setTripDist((prev) => prev + state.sog.value! * dtHours);
            }
            lastSogTime.current = now;
        }
    }, [state.sog.value, state.sog.freshness]);

    const handleBack = useCallback(() => {
        triggerHaptic('light');
        onBack();
    }, [onBack]);

    const isConnected = state.connectionStatus === 'connected';

    // Freshness helpers
    const sogFresh = state.sog.freshness;
    const twsFresh = state.tws.freshness;
    const depthFresh = state.depth.freshness;
    const cogFresh = state.cog.freshness;
    const voltageFresh = state.voltage.freshness;

    return (
        <div className="relative h-full bg-slate-950 overflow-hidden slide-up-enter">
            <div className="flex flex-col h-full">
                {/* ═══ HEADER ═══ */}
                <div
                    className="shrink-0 px-4 pt-4 pb-2 flex items-center gap-3"
                    style={{ paddingTop: 'calc(env(safe-area-inset-top, 20px) + 8px)' }}
                >
                    <button
                        onClick={handleBack}
                        aria-label="Go back"
                        className="p-2 rounded-xl bg-white/5 hover:bg-white/10 transition-colors min-w-[44px] min-h-[44px] flex items-center justify-center press"
                    >
                        <svg
                            className="w-5 h-5 text-gray-400"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={2}
                        >
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
                        </svg>
                    </button>
                    <div className="flex-1 text-center">
                        <h1 className="text-lg font-black text-white uppercase tracking-[0.2em]">Instrument Panel</h1>
                        <p className="text-[9px] font-bold uppercase tracking-[0.3em] text-gray-500">
                            Thalassa · The Sailor&apos;s Assistant
                        </p>
                    </div>
                    {/* Connection status dot */}
                    <div className="flex items-center gap-1.5 min-w-[44px] justify-end">
                        <div
                            className={`w-2 h-2 rounded-full ${
                                isConnected ? 'bg-emerald-400 animate-pulse' : 'bg-gray-500'
                            }`}
                        />
                        <span className="text-[9px] font-bold uppercase tracking-wider text-gray-500">
                            {isConnected ? 'Live' : 'Off'}
                        </span>
                    </div>
                </div>

                {/* ═══ INSTRUMENT PANEL ═══ */}
                <div
                    className="flex-1 min-h-0 overflow-y-auto px-3 pb-4"
                    style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 12px)' }}
                >
                    {/* ── ROW 1: SOG (left) + TWS GAUGE (center overlap) + AWS (right) ── */}
                    <div className="relative mb-2">
                        <div className="grid grid-cols-2 gap-2">
                            {/* SOG Card */}
                            <div className="p-3 rounded-2xl bg-white/[0.03] border border-white/[0.06]">
                                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-gray-400 mb-1">
                                    SOG
                                </p>
                                <div className="flex items-baseline gap-1">
                                    <span
                                        className={`text-3xl font-black tabular-nums font-mono ${sogFresh === 'dead' ? 'text-gray-500' : 'text-white'}`}
                                    >
                                        {state.sog.value !== null ? state.sog.value.toFixed(1) : '-- . --'}
                                    </span>
                                    <span className="text-xs font-bold text-gray-500">kts</span>
                                </div>
                                {/* Speed bar */}
                                <div className="mt-1.5 h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
                                    <div
                                        className="h-full rounded-full bg-gradient-to-r from-emerald-500 via-amber-500 to-rose-500 transition-all duration-500"
                                        style={{ width: `${Math.min(100, ((state.sog.value ?? 0) / 15) * 100)}%` }}
                                    />
                                </div>
                                {/* Sparkline */}
                                <div className="mt-2">
                                    <Sparkline
                                        history={sogHistory.history}
                                        min={Math.max(0, sogHistory.min - 2)}
                                        max={sogHistory.max + 2}
                                        color="#22d3ee"
                                        width={140}
                                        height={45}
                                        showAxes
                                        label="sog"
                                    />
                                    <p className="text-[8px] font-bold uppercase tracking-widest text-gray-600 text-center mt-0.5">
                                        Rolling Chart
                                    </p>
                                </div>
                            </div>

                            {/* AWS Card */}
                            <div className="p-3 rounded-2xl bg-white/[0.03] border border-white/[0.06]">
                                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-gray-400 mb-1">
                                    AWS
                                </p>
                                <div className="flex items-baseline gap-1">
                                    <span
                                        className={`text-3xl font-black tabular-nums font-mono ${twsFresh === 'dead' ? 'text-gray-500' : 'text-white'}`}
                                    >
                                        {state.tws.value !== null ? state.tws.value.toFixed(1) : '--'}
                                    </span>
                                    <span className="text-xs font-bold text-gray-500">kts</span>
                                </div>
                                {/* Wind speed bar */}
                                <div className="mt-1.5 h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
                                    <div
                                        className="h-full rounded-full bg-gradient-to-r from-sky-400 to-cyan-400 transition-all duration-500"
                                        style={{ width: `${Math.min(100, ((state.tws.value ?? 0) / 60) * 100)}%` }}
                                    />
                                </div>
                                {/* Apparent winds sparkline */}
                                <div className="mt-2">
                                    <Sparkline
                                        history={twsHistory.history}
                                        min={Math.max(0, twsHistory.min - 5)}
                                        max={twsHistory.max + 5}
                                        color="#a78bfa"
                                        width={140}
                                        height={45}
                                        showAxes
                                        label="aws"
                                    />
                                    <p className="text-[8px] font-bold uppercase tracking-widest text-gray-600 text-center mt-0.5">
                                        Apparent Winds
                                    </p>
                                </div>
                            </div>
                        </div>

                        {/* ── TWS HERO GAUGE (overlapping center) ── */}
                        <div className="flex justify-center -mt-6 mb-1 relative z-10">
                            <div
                                className="rounded-full p-1"
                                style={{
                                    background:
                                        'radial-gradient(circle, rgba(15,23,42,0.98) 60%, rgba(15,23,42,0.8) 100%)',
                                    boxShadow: '0 0 40px rgba(0,0,0,0.8), inset 0 0 30px rgba(0,0,0,0.5)',
                                    border: '2px solid rgba(255,255,255,0.08)',
                                }}
                            >
                                <div style={{ width: '200px', height: '200px' }}>
                                    <ArcGauge
                                        value={state.tws.value}
                                        min={0}
                                        max={60}
                                        unit="kts"
                                        label="TWS"
                                        accentColor="#ec4899"
                                        zones={[
                                            { from: 0, to: 15, color: '#22c55e' },
                                            { from: 15, to: 25, color: '#eab308' },
                                            { from: 25, to: 40, color: '#f97316' },
                                            { from: 40, to: 60, color: '#ef4444' },
                                        ]}
                                        majorTick={10}
                                        freshness={state.tws.freshness}
                                    />
                                </div>
                            </div>
                        </div>
                        {/* MAX wind readout */}
                        <div className="flex justify-center -mt-2 mb-2">
                            <div className="px-3 py-1 rounded-lg bg-white/[0.04] border border-white/[0.06]">
                                <span className="text-[9px] font-bold uppercase tracking-widest text-gray-500">
                                    MAX{' '}
                                </span>
                                <span className="text-xs font-black text-amber-400 tabular-nums font-mono">
                                    {twsMax > 0 ? twsMax.toFixed(1) : '-- . --'}
                                </span>
                                <span className="text-[9px] font-bold text-gray-500"> kts</span>
                            </div>
                        </div>
                    </div>

                    {/* ── ROW 2: DEPTH + COG COMPASS + HEEL ANGLE (3-col) ── */}
                    <div className="grid grid-cols-3 gap-2 mb-2">
                        {/* Depth Sounder */}
                        <div className="p-3 rounded-2xl bg-white/[0.03] border border-white/[0.06]">
                            <p className="text-[9px] font-black uppercase tracking-[0.15em] text-gray-400 mb-1">
                                Depth Sounder
                            </p>
                            <div className="flex items-baseline gap-0.5">
                                <span
                                    className={`text-2xl font-black tabular-nums font-mono ${depthFresh === 'dead' ? 'text-gray-500' : 'text-white'}`}
                                >
                                    {state.depth.value !== null ? state.depth.value.toFixed(1) : '-- . --'}
                                </span>
                                <span className="text-xs font-bold text-gray-500">m</span>
                            </div>
                            <p className="text-[8px] font-bold uppercase tracking-widest text-gray-600 mt-0.5">W</p>
                            <div className="mt-1">
                                <Sparkline
                                    history={depthHistory.history}
                                    min={0}
                                    max={Math.max(20, depthHistory.max + 5)}
                                    color="#22d3ee"
                                    width={100}
                                    height={55}
                                    showAxes
                                    axisUnit="m"
                                    label="depth"
                                />
                                <p className="text-[7px] font-bold uppercase tracking-widest text-gray-600 text-center mt-0.5">
                                    15 min chart
                                </p>
                            </div>
                        </div>

                        {/* COG Compass */}
                        <div className="p-2 rounded-2xl bg-white/[0.03] border border-white/[0.06] flex flex-col items-center">
                            <p className="text-[9px] font-black uppercase tracking-[0.15em] text-gray-400 mb-1">
                                COG Compass
                            </p>
                            <div style={{ width: '100%', maxWidth: '140px', aspectRatio: '1' }}>
                                <CompassGauge
                                    value={state.cog.value}
                                    label="COG"
                                    accentColor="#22d3ee"
                                    freshness={cogFresh}
                                />
                            </div>
                        </div>

                        {/* Heel Angle */}
                        <div className="p-3 rounded-2xl bg-white/[0.03] border border-white/[0.06] flex flex-col items-center">
                            <p className="text-[9px] font-black uppercase tracking-[0.15em] text-gray-400 mb-1">
                                Heel Angle
                            </p>
                            {/* Heel data not in NmeaStore yet — show placeholder */}
                            <HeelGauge degrees={null} />
                        </div>
                    </div>

                    {/* ── ROW 3: NMEA DATA + VOYAGE (2-col) ── */}
                    <div className="grid grid-cols-2 gap-2">
                        {/* NMEA Data */}
                        <div className="p-3 rounded-2xl bg-white/[0.03] border border-white/[0.06]">
                            <p className="text-[9px] font-black uppercase tracking-[0.15em] text-gray-400 mb-2">
                                NMEA Data
                            </p>
                            {/* Sensor status icons */}
                            <div className="flex items-center justify-around mb-2">
                                <SensorIcon icon="📍" label="GPS" active={state.latitude.freshness === 'live'} />
                                <SensorIcon icon="💨" label="Wind" active={state.tws.freshness === 'live'} />
                                <SensorIcon icon="🔵" label="Depth" active={state.depth.freshness === 'live'} />
                            </div>
                            {/* Battery voltage */}
                            <div className="flex items-center gap-2 mt-1">
                                <span className="text-lg">🔋</span>
                                <span
                                    className={`text-xl font-black tabular-nums font-mono ${voltageFresh === 'dead' ? 'text-gray-500' : 'text-white'}`}
                                >
                                    {state.voltage.value !== null ? state.voltage.value.toFixed(1) : '--'}
                                </span>
                                <span className="text-xs font-bold text-gray-500">V</span>
                            </div>
                        </div>

                        {/* Voyage */}
                        <div className="p-3 rounded-2xl bg-white/[0.03] border border-white/[0.06]">
                            <p className="text-[9px] font-black uppercase tracking-[0.15em] text-gray-400 mb-2">
                                Voyage
                            </p>
                            <p className="text-[10px] font-bold text-gray-500 mb-0.5">Trip Dist:</p>
                            <div className="flex items-baseline gap-1">
                                <span className="text-3xl font-black tabular-nums font-mono text-white">
                                    {tripDist > 0 ? tripDist.toFixed(1) : '--'}
                                </span>
                                <span className="text-xs font-bold text-gray-500">NM</span>
                            </div>
                            <p className="text-xl font-bold text-gray-600 mt-1">--</p>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};
