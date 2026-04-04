/**
 * NmeaGaugeOverlay — Fullscreen modal overlay for NMEA instrument gauges.
 *
 * Renders the appropriate gauge type for the selected metric:
 *   - Compass: COG, Heading
 *   - Arc: TWS, STW, SOG, TWA, Water Temp
 *   - Depth: Depth
 *   - Tach: RPM
 *   - Bar: Voltage
 *
 * Glassmorphism backdrop with blur, tap-to-dismiss, back chevron.
 */
import React, { useEffect, useState, useCallback } from 'react';
import type { TimestampedMetric } from '../../services/NmeaStore';
import { CompassGauge } from './gauges/CompassGauge';
import { ArcGauge } from './gauges/ArcGauge';
import { DepthGauge } from './gauges/DepthGauge';
import { TachGauge } from './gauges/TachGauge';
import { BarGauge } from './gauges/BarGauge';
import { triggerHaptic } from '../../utils/system';

export type GaugeMetricId =
    | 'tws'
    | 'twa'
    | 'stw'
    | 'sog'
    | 'cog'
    | 'heading'
    | 'depth'
    | 'waterTemp'
    | 'rpm'
    | 'voltage';

interface GaugeConfig {
    component: React.ReactNode;
    title: string;
}

interface NmeaGaugeOverlayProps {
    metricId: GaugeMetricId;
    metric: TimestampedMetric;
    onClose: () => void;
}

export const NmeaGaugeOverlay: React.FC<NmeaGaugeOverlayProps> = ({ metricId, metric, onClose }) => {
    const [visible, setVisible] = useState(false);

    // ── Keel offset (persisted in localStorage) ──
    const OFFSET_KEY = 'thalassa_keel_offset';
    const [keelOffset, setKeelOffset] = useState<number>(() => {
        const saved = localStorage.getItem(OFFSET_KEY);
        return saved ? parseFloat(saved) : 0;
    });

    const updateOffset = useCallback(
        (delta: number) => {
            setKeelOffset((prev) => {
                const next = Math.round((prev + delta) * 10) / 10;
                // Can't go past 0 (no positive offset) and can't exceed current depth
                const maxOffset = metric.value != null ? -metric.value : 0;
                const clamped = Math.max(maxOffset, Math.min(0, next));
                localStorage.setItem(OFFSET_KEY, String(clamped));
                return clamped;
            });
        },
        [metric.value],
    );

    // Animate in
    useEffect(() => {
        requestAnimationFrame(() => {
            requestAnimationFrame(() => setVisible(true));
        });
    }, []);

    const handleClose = () => {
        triggerHaptic('light');
        setVisible(false);
        setTimeout(onClose, 300); // Wait for fade-out
    };

    // Build gauge config
    const gaugeConfig: Record<GaugeMetricId, GaugeConfig> = {
        cog: {
            title: 'Course Over Ground',
            component: (
                <CompassGauge value={metric.value} label="COG" accentColor="#22d3ee" freshness={metric.freshness} />
            ),
        },
        heading: {
            title: 'Heading',
            component: (
                <CompassGauge value={metric.value} label="HDG" accentColor="#f59e0b" freshness={metric.freshness} />
            ),
        },
        tws: {
            title: 'True Wind Speed',
            component: (
                <ArcGauge
                    value={metric.value}
                    min={0}
                    max={60}
                    unit="kts"
                    label="True Wind Speed"
                    accentColor="#38bdf8"
                    zones={[
                        { from: 0, to: 15, color: '#22c55e' },
                        { from: 15, to: 25, color: '#eab308' },
                        { from: 25, to: 40, color: '#f97316' },
                        { from: 40, to: 60, color: '#ef4444' },
                    ]}
                    majorTick={10}
                    freshness={metric.freshness}
                />
            ),
        },
        twa: {
            title: 'True Wind Angle',
            component: (
                <ArcGauge
                    value={metric.value}
                    min={0}
                    max={180}
                    unit="°"
                    label="True Wind Angle"
                    decimals={0}
                    accentColor="#a78bfa"
                    zones={[
                        { from: 0, to: 45, color: '#ef4444' }, // No-go zone
                        { from: 45, to: 90, color: '#22c55e' }, // Close haul / beam
                        { from: 90, to: 135, color: '#38bdf8' }, // Broad reach
                        { from: 135, to: 180, color: '#eab308' }, // Running
                    ]}
                    majorTick={30}
                    freshness={metric.freshness}
                />
            ),
        },
        stw: {
            title: 'Speed Through Water',
            component: (
                <ArcGauge
                    value={metric.value}
                    min={0}
                    max={15}
                    unit="kts"
                    label="Speed Through Water"
                    accentColor="#06b6d4"
                    zones={[
                        { from: 0, to: 5, color: '#38bdf8' },
                        { from: 5, to: 10, color: '#22c55e' },
                        { from: 10, to: 15, color: '#eab308' },
                    ]}
                    majorTick={5}
                    freshness={metric.freshness}
                />
            ),
        },
        sog: {
            title: 'Speed Over Ground',
            component: (
                <ArcGauge
                    value={metric.value}
                    min={0}
                    max={15}
                    unit="kts"
                    label="Speed Over Ground"
                    accentColor="#34d399"
                    zones={[
                        { from: 0, to: 5, color: '#38bdf8' },
                        { from: 5, to: 10, color: '#22c55e' },
                        { from: 10, to: 15, color: '#eab308' },
                    ]}
                    majorTick={5}
                    freshness={metric.freshness}
                />
            ),
        },
        depth: {
            title: 'Depth',
            component: (
                <DepthGauge value={metric.value} unit="m" freshness={metric.freshness} keelOffset={keelOffset} />
            ),
        },
        waterTemp: {
            title: 'Water Temperature',
            component: (
                <ArcGauge
                    value={metric.value}
                    min={0}
                    max={40}
                    unit="°C"
                    label="Water Temperature"
                    accentColor="#06b6d4"
                    zones={[
                        { from: 0, to: 10, color: '#3b82f6' }, // Cold
                        { from: 10, to: 20, color: '#06b6d4' }, // Cool
                        { from: 20, to: 28, color: '#22c55e' }, // Pleasant
                        { from: 28, to: 35, color: '#eab308' }, // Warm
                        { from: 35, to: 40, color: '#ef4444' }, // Hot
                    ]}
                    majorTick={5}
                    freshness={metric.freshness}
                />
            ),
        },
        rpm: {
            title: 'Engine RPM',
            component: <TachGauge value={metric.value} freshness={metric.freshness} />,
        },
        voltage: {
            title: 'Battery Voltage',
            component: (
                <BarGauge
                    value={metric.value}
                    min={10}
                    max={15}
                    unit="V"
                    label="Battery Voltage"
                    freshness={metric.freshness}
                />
            ),
        },
    };

    const config = gaugeConfig[metricId];

    return (
        <div
            className={`fixed inset-0 z-[9999] flex flex-col transition-all duration-300 ${
                visible ? 'opacity-100' : 'opacity-0'
            } bg-slate-950`}
        >
            {/* Header with back chevron — matches PageHeader style */}
            <div
                className="flex items-center gap-3 px-4 pt-safe-top"
                style={{ paddingTop: 'calc(env(safe-area-inset-top, 20px) + 12px)' }}
            >
                <button
                    onClick={handleClose}
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

                <span className="flex-1 text-center text-sm font-black text-white uppercase tracking-widest pr-12">
                    {config.title}
                </span>
            </div>

            {/* Gauge fills remaining space */}
            <div
                className="flex-1 flex items-center justify-center px-4 pb-safe-bottom"
                style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 20px) + 20px)' }}
            >
                <div
                    className={`w-full max-w-md transform transition-all duration-500 ${
                        visible ? 'scale-100 translate-y-0' : 'scale-90 translate-y-8'
                    }`}
                >
                    {config.component}

                    {/* Keel Offset Stepper — only for depth gauge */}
                    {metricId === 'depth' && (
                        <div className="flex items-center justify-center gap-4 mt-6">
                            <button
                                onClick={() => updateOffset(-0.1)}
                                disabled={metric.value != null && keelOffset <= -metric.value}
                                className="w-11 h-11 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center text-white text-xl font-bold hover:bg-white/10 active:scale-95 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                                aria-label="Decrease keel offset"
                            >
                                −
                            </button>
                            <div className="flex flex-col items-center min-w-[100px]">
                                <span className="text-lg font-black text-white tabular-nums font-mono">
                                    {keelOffset.toFixed(1)}m
                                </span>
                                <span className="text-[11px] font-bold uppercase tracking-[0.2em] text-gray-500">
                                    Keel Offset
                                </span>
                            </div>
                            <button
                                onClick={() => updateOffset(0.1)}
                                disabled={keelOffset >= 0}
                                className="w-11 h-11 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center text-white text-xl font-bold hover:bg-white/10 active:scale-95 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                                aria-label="Increase keel offset"
                            >
                                +
                            </button>
                        </div>
                    )}
                </div>
            </div>

            {/* Freshness indicator */}
            <div
                className="absolute bottom-6 left-0 right-0 flex justify-center"
                style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
            >
                <div className="flex items-center gap-2">
                    <div
                        className={`w-2 h-2 rounded-full ${
                            metric.freshness === 'live'
                                ? 'bg-emerald-400 animate-pulse'
                                : metric.freshness === 'stale'
                                  ? 'bg-amber-400'
                                  : 'bg-red-400'
                        }`}
                    />
                    <span className="text-[11px] font-bold uppercase tracking-[0.2em] text-gray-400">
                        {metric.freshness === 'live'
                            ? 'Live Data'
                            : metric.freshness === 'stale'
                              ? 'Stale Data'
                              : 'No Data'}
                    </span>
                </div>
            </div>
        </div>
    );
};
