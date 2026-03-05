/**
 * NmeaPage — Standalone NMEA Gateway dashboard for the Vessel Hub.
 *
 * Shows connection status, live instrument data, and connection controls.
 * Tap any instrument card to open a fullscreen gauge overlay.
 */
import React, { useState, useCallback } from 'react';
import { useNmeaStore, NmeaValue, NmeaStatusDot } from '../nmea/useNmeaStore';
import { NmeaListenerService } from '../../services/NmeaListenerService';
import { NmeaStore, type TimestampedMetric } from '../../services/NmeaStore';
import { triggerHaptic } from '../../utils/system';
import { PageHeader } from '../ui/PageHeader';
import { FormField } from '../ui/FormField';
import { NmeaGaugeOverlay, type GaugeMetricId } from '../nmea/NmeaGaugeOverlay';

interface NmeaPageProps {
    onBack: () => void;
}

export const NmeaPage: React.FC<NmeaPageProps> = ({ onBack }) => {
    const state = useNmeaStore();
    const [host, setHost] = useState(localStorage.getItem('nmea_host') || '192.168.1.1');
    const [port, setPort] = useState(localStorage.getItem('nmea_port') || '10110');
    const [connecting, setConnecting] = useState(false);
    const [activeGauge, setActiveGauge] = useState<{ id: GaugeMetricId; metric: TimestampedMetric } | null>(null);

    const isConnected = state.connectionStatus === 'connected';
    const isConnecting = state.connectionStatus === 'connecting';

    const handleConnect = useCallback(async () => {
        setConnecting(true);
        triggerHaptic('medium');
        try {
            localStorage.setItem('nmea_host', host);
            localStorage.setItem('nmea_port', port);
            NmeaListenerService.configure(host, parseInt(port, 10));
            NmeaListenerService.start();
            NmeaStore.start();
        } catch (e) {
            console.error('NMEA connect failed:', e);
        } finally {
            setConnecting(false);
        }
    }, [host, port]);

    const handleDisconnect = useCallback(() => {
        triggerHaptic('medium');
        NmeaStore.stop();
        NmeaListenerService.stop();
    }, []);

    const openGauge = useCallback((id: GaugeMetricId, metric: TimestampedMetric) => {
        triggerHaptic('light');
        setActiveGauge({ id, metric });
    }, []);

    // Instrument data cards — each maps to a gauge type
    const instruments: { label: string; id: GaugeMetricId; metric: TimestampedMetric; unit: string; icon: string }[] = [
        { label: 'True Wind Speed', id: 'tws', metric: state.tws, unit: 'kts', icon: '💨' },
        { label: 'True Wind Angle', id: 'twa', metric: state.twa, unit: '°', icon: '🧭' },
        { label: 'Speed Through Water', id: 'stw', metric: state.stw, unit: 'kts', icon: '🌊' },
        { label: 'Speed Over Ground', id: 'sog', metric: state.sog, unit: 'kts', icon: '📡' },
        { label: 'Course Over Ground', id: 'cog', metric: state.cog, unit: '°', icon: '🗺️' },
        { label: 'Heading', id: 'heading', metric: state.heading, unit: '°', icon: '⚓' },
        { label: 'Depth', id: 'depth', metric: state.depth, unit: 'm', icon: '🔵' },
        { label: 'Water Temperature', id: 'waterTemp', metric: state.waterTemp, unit: '°C', icon: '🌡️' },
        { label: 'Engine RPM', id: 'rpm', metric: state.rpm, unit: 'rpm', icon: '⚙️' },
        { label: 'Battery Voltage', id: 'voltage', metric: state.voltage, unit: 'V', icon: '🔋' },
    ];

    // Get the live metric for the active gauge (so it updates in real-time)
    const liveActiveMetric = activeGauge ? state[activeGauge.id as keyof typeof state] as TimestampedMetric : null;

    return (
        <div className="relative h-full bg-slate-950 overflow-hidden">
            <div className="flex flex-col h-full">

                <PageHeader
                    title="NMEA"
                    subtitle="Instrument Data"
                    onBack={onBack}
                    breadcrumbs={['Ship\'s Office', 'NMEA']}
                    action={<NmeaStatusDot />}
                />

                {/* Content — fills viewport */}
                <div className="flex-1 flex flex-col px-4 min-h-0 overflow-hidden" style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom) + 12px)' }}>

                    {/* ═══ CONNECTION CARD ═══ */}
                    <div className={`shrink-0 mb-3 p-4 rounded-2xl border transition-all ${isConnected
                        ? 'bg-emerald-500/10 border-emerald-500/20'
                        : 'bg-white/[0.03] border-white/[0.06]'
                        }`}>
                        <div className="flex items-center gap-3 mb-3">
                            <div className={`w-3 h-3 rounded-full ${isConnected ? 'bg-emerald-400' :
                                isConnecting ? 'bg-amber-400 animate-pulse' :
                                    'bg-gray-500'
                                }`} />
                            <h3 className="text-sm font-black text-white">
                                {isConnected ? 'Connected' : isConnecting ? 'Connecting...' : 'Disconnected'}
                            </h3>
                        </div>

                        {!isConnected && (
                            <div className="flex gap-2 mb-3">
                                <div className="flex-1">
                                    <FormField label="Host IP" value={host} onChange={setHost} placeholder="192.168.1.1" mono />
                                </div>
                                <div className="w-24">
                                    <FormField label="Port" value={port} onChange={setPort} placeholder="10110" mono inputMode="numeric" />
                                </div>
                            </div>
                        )}

                        <button
                            onClick={isConnected ? handleDisconnect : handleConnect}
                            disabled={connecting || isConnecting}
                            aria-label={isConnected ? 'Disconnect NMEA' : 'Connect NMEA'}
                            className={`w-full py-2.5 rounded-xl text-sm font-black uppercase tracking-widest transition-all active:scale-[0.97] disabled:opacity-50 ${isConnected
                                ? 'bg-red-500/20 text-red-400 border border-red-500/20 hover:bg-red-500/30'
                                : 'bg-gradient-to-r from-sky-600 to-sky-600 text-white shadow-lg shadow-sky-500/20 hover:from-sky-500 hover:to-sky-500'
                                }`}
                        >
                            {connecting || isConnecting ? (
                                <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin mx-auto" />
                            ) : isConnected ? 'Disconnect' : 'Connect'}
                        </button>
                    </div>

                    {/* ═══ INSTRUMENT GRID ═══ */}
                    <h3 className="shrink-0 text-label text-gray-500 font-bold uppercase tracking-widest mb-2">Live Instruments</h3>
                    <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden pb-4">
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                            {instruments.map(inst => (
                                <button
                                    key={inst.id}
                                    onClick={() => openGauge(inst.id, inst.metric)}
                                    className="p-3 rounded-2xl bg-white/[0.03] border border-white/[0.06] flex flex-col justify-between min-h-[90px]
                                               active:bg-white/[0.08] active:scale-[0.97] transition-all cursor-pointer text-left"
                                >
                                    <div className="flex items-center gap-2 mb-1">
                                        <span className="text-base">{inst.icon}</span>
                                        <span className="text-label text-gray-500 font-bold uppercase tracking-widest leading-tight">{inst.label}</span>
                                    </div>
                                    <NmeaValue
                                        metric={inst.metric}
                                        unit={inst.unit}
                                        decimals={inst.unit === '°' || inst.unit === 'rpm' ? 0 : 1}
                                        className="text-xl font-black"
                                    />
                                    {/* Subtle chevron hint */}
                                    <div className="mt-1 flex justify-end opacity-20">
                                        <svg className="w-3.5 h-3.5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                            <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                                        </svg>
                                    </div>
                                </button>
                            ))}
                        </div>
                    </div>
                </div>
            </div>

            {/* ═══ FULLSCREEN GAUGE OVERLAY ═══ */}
            {activeGauge && liveActiveMetric && (
                <NmeaGaugeOverlay
                    metricId={activeGauge.id}
                    metric={liveActiveMetric}
                    onClose={() => setActiveGauge(null)}
                />
            )}
        </div>
    );
};
