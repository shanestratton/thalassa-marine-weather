import React from 'react';
import type { PositionBroadcast } from '../../services/AnchorWatchSyncService';
import { MuteIcon } from '../Icons';
import { formatDistance } from './anchorUtils';

interface ShoreWatchReadingsProps {
    data: PositionBroadcast;
    fresh: boolean;
    isAlarm: boolean;
    statusLabel: string;
    showMute: boolean;
    muted: boolean;
    onMute: () => void;
}

/** Presentation only: displaying a shore fix must never own the live watch. */
export function ShoreWatchReadings({
    data,
    fresh,
    isAlarm,
    statusLabel,
    showMute,
    muted,
    onMute,
}: ShoreWatchReadingsProps) {
    // The Pi confirms successive breaches before raising its alarm. During
    // that interval, an outside-radius fix is not evidence of "Holding".
    // This is presentation only; do not bypass the watchkeeper's confirmation.
    const outsideRadius = fresh && !isAlarm && data.swingRadius > 0 && data.distance > data.swingRadius;
    const tone = isAlarm ? 'text-red-400' : fresh && !outsideRadius ? 'text-emerald-400' : 'text-amber-300';
    const accent = isAlarm ? '239,68,68' : fresh && !outsideRadius ? '16,185,129' : '245,158,11';
    const metrics = [
        { label: 'Swing Radius', value: formatDistance(data.swingRadius), color: 'text-slate-100' },
        {
            label: 'Rode',
            value: data.config?.rodeLength !== undefined ? `${Math.round(data.config.rodeLength)} m` : '--',
            color: 'text-slate-100',
        },
        {
            label: 'Depth',
            value: data.config?.waterDepth !== undefined ? `${data.config.waterDepth.toFixed(1)} m` : '--',
            color: 'text-slate-100',
        },
        {
            label: fresh ? 'Last Update' : 'Last-Known Update',
            value: new Date(data.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            color: 'text-slate-100',
        },
    ];
    return (
        <section
            aria-label="Vessel anchor readings"
            className="mx-auto flex w-full max-w-md shrink-0 flex-col items-center gap-3"
        >
            <div className="flex flex-col items-center gap-3">
                <div
                    className={`relative flex h-[clamp(7rem,18dvh,11rem)] w-[clamp(7rem,18dvh,11rem)] shrink-0 items-center justify-center rounded-full border-2 ${isAlarm && fresh ? 'motion-safe:animate-pulse' : ''}`}
                    style={{
                        borderColor: `rgba(${accent},0.45)`,
                        background: `radial-gradient(circle at 50% 40%, rgba(${accent},0.13), rgba(${accent},0.03) 72%)`,
                        boxShadow: `0 0 36px rgba(${accent},0.08), inset 0 0 22px rgba(${accent},0.05)`,
                    }}
                >
                    <div className="px-3 text-center">
                        <div
                            className={`font-mono text-[clamp(2rem,5dvh,3rem)] font-black leading-none tracking-tight tabular-nums ${isAlarm ? 'text-red-400' : 'text-slate-100'}`}
                        >
                            {data.distance.toFixed(0)}
                            <span className="ml-0.5 text-xl">m</span>
                        </div>
                        <div className="mt-2 text-xs font-medium text-slate-300">
                            {fresh ? 'from anchor' : 'last-known from anchor'}
                        </div>
                    </div>
                </div>
                <div
                    role="status"
                    aria-live="polite"
                    aria-atomic="true"
                    className={`inline-flex max-w-full items-center gap-2 rounded-full border px-4 py-1.5 text-center text-sm font-black uppercase tracking-wider ${tone}`}
                    style={{ borderColor: `rgba(${accent},0.25)`, background: `rgba(${accent},0.08)` }}
                >
                    <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-current" />
                    {outsideRadius ? 'Outside radius · checking' : statusLabel}
                </div>
            </div>
            {showMute && (
                <button
                    type="button"
                    aria-label="Mute alarm on this device only"
                    disabled={muted}
                    onClick={onMute}
                    className="min-h-11 w-full rounded-2xl border border-red-400/30 bg-red-700 px-4 py-3 text-sm font-bold text-white disabled:opacity-70"
                >
                    <span className="inline-flex items-center justify-center gap-2">
                        <MuteIcon className="h-4 w-4" />
                        {muted ? 'Muted on this device only' : 'Mute this device only'}
                    </span>
                    <span className="mt-1 block text-xs font-medium text-red-100">The vessel’s watch continues.</span>
                </button>
            )}
            <dl aria-label="Shore Watch metrics" className="grid w-full grid-cols-2 gap-2.5">
                {metrics.map(({ label, value, color }) => (
                    <div
                        key={label}
                        className="min-w-0 rounded-2xl border border-white/8 bg-slate-800/40 px-2 py-2 text-center"
                    >
                        <dt className="text-xs font-bold uppercase tracking-wider text-slate-400">{label}</dt>
                        <dd className={`mt-1 text-xl font-bold leading-tight tabular-nums ${color}`}>{value}</dd>
                    </div>
                ))}
            </dl>
        </section>
    );
}
