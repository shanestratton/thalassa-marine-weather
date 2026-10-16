import React from 'react';
import type { MeasuredCurrent } from '../../services/instruments/measuredCurrent';
import type { SailingPerformance } from '../../services/instruments/performance';
import { confirmUnderSail } from '../../services/instruments/underSail';
const number = (value: number | null, suffix = '') => (value === null ? '—' : `${value.toFixed(1)}${suffix}`);
export function InstrumentSampleTime({ at, now, via }: { at: number; now: number; via: string }) {
    return (
        <p className="text-xs text-gray-400">
            {via === 'cloud' ? 'Cloud copy · ' : via === 'signalk' ? 'Direct Signal K · ' : ''}Samples{' '}
            {new Date(at).toISOString().slice(11, 19)} UTC · {Math.max(0, Math.floor((now - at) / 1000))} s old
        </p>
    );
}
export function PerformanceReadout({
    performance: p,
    now,
    confirmed,
    engineRunning,
    onConfirm,
}: {
    performance: SailingPerformance;
    now: number;
    confirmed: boolean;
    engineRunning: boolean;
    onConfirm?: () => void;
}) {
    return (
        <div
            className={`flex min-h-0 flex-1 flex-col justify-evenly gap-2 overflow-y-auto pb-3 text-white ${now - p.observedAt > 6500 ? 'opacity-60' : ''}`}
        >
            <div className="text-center">
                <p className="text-xs text-gray-400">VMG through water · towards true wind</p>
                <p className="text-5xl font-black tabular-nums">
                    {number(p.vmgKts)} <span className="text-base">kn</span>
                </p>
            </div>
            {p.pointOfSail && <p className="text-center text-sm text-cyan-200">{p.pointOfSail.label}</p>}
            <dl className="grid grid-cols-2 gap-3 text-center">
                <div>
                    <dt className="text-xs text-gray-400">{p.mode === 'upwind' ? 'Upwind' : 'Downwind'} target TWA</dt>
                    <dd className="text-2xl font-bold">{number(p.target?.angleDeg ?? null, '°')}</dd>
                </div>
                <div>
                    <dt className="text-xs text-gray-400">Target water speed</dt>
                    <dd className="text-2xl font-bold">{number(p.target?.speedKts ?? null, ' kn')}</dd>
                </div>
                <div>
                    <dt className="text-xs text-gray-400">At this angle</dt>
                    <dd>{number(p.referenceSpeedKts, ' kn')}</dd>
                </div>
                <div>
                    <dt className="text-xs text-gray-400">Actual / polar</dt>
                    <dd>
                        {p.performancePct === null
                            ? '—'
                            : p.performancePct > 999
                              ? '>999%'
                              : `${Math.round(p.performancePct)}%`}
                    </dd>
                </div>
            </dl>
            <p className="text-xs text-gray-400">
                {p.polarLabel} · {p.polarSource}. Targets are polar estimates.{' '}
                {p.leewayApplied ? 'Explicit leeway applied to VMG.' : 'Leeway uncorrected.'}
            </p>
            <InstrumentSampleTime at={p.observedAt} now={now} via="local" />
            {!confirmed && (
                <>
                    <p className="text-xs text-amber-200">
                        Confirm that you are under sail to show the sailing percentage and laylines. No RPM reading
                        cannot prove sail.
                    </p>
                    <button
                        type="button"
                        className="min-h-11 rounded-lg border border-sky-300/40 px-3 text-sm"
                        disabled={engineRunning}
                        onClick={onConfirm ?? (() => confirmUnderSail(p.identity))}
                    >
                        Under sail
                    </button>
                </>
            )}
            {confirmed && (
                <button
                    type="button"
                    className="min-h-11 rounded-lg border border-white/20 px-3 text-sm"
                    onClick={() => confirmUnderSail(null)}
                >
                    Under sail confirmed · clear
                </button>
            )}
        </div>
    );
}
export function CurrentReadout({
    current: c,
    now,
    onHistory,
}: {
    current: MeasuredCurrent;
    now: number;
    onHistory?: () => void;
}) {
    return (
        <div
            className={`flex min-h-0 flex-1 flex-col justify-evenly gap-3 overflow-y-auto pb-3 text-white ${c.freshness === 'stale' ? 'opacity-60' : ''}`}
        >
            <div className="flex items-center justify-center gap-4">
                <svg aria-hidden="true" width="64" height="64" viewBox="0 0 64 64">
                    <circle cx="32" cy="32" r="30" fill="none" stroke="currentColor" opacity=".3" />
                    {c.setTrueDeg !== null && (
                        <path
                            d="M32 52V12M21 25L32 12l11 13"
                            fill="none"
                            stroke="#67e8f9"
                            strokeWidth="4"
                            transform={`rotate(${c.setTrueDeg} 32 32)`}
                        />
                    )}
                </svg>
                <div>
                    <p className="text-xs text-gray-400">Drift · instrument derived</p>
                    <p className="text-5xl font-black tabular-nums">
                        {number(c.driftKts)} <span className="text-base">kn</span>
                    </p>
                </div>
            </div>
            <p className="text-center text-2xl font-bold">
                Set {c.setTrueDeg === null ? '—' : `${String(Math.round(c.setTrueDeg) % 360).padStart(3, '0')}°T`}
            </p>
            <p className="text-xs text-gray-400">
                GPS ground vector minus speed-log water vector.{' '}
                {c.leewayDeg === null
                    ? 'Leeway uncorrected; this can bias the estimate.'
                    : `Leeway ${number(c.leewayDeg, '°')} · ${c.leewaySource}.`}{' '}
                This local estimate is separate from modelled current.
            </p>
            <InstrumentSampleTime at={c.observedAt} now={now} via={c.via} />
            {onHistory && (
                <button
                    type="button"
                    className="min-h-11 rounded-lg border border-white/20 px-3 text-sm"
                    onClick={onHistory}
                >
                    Recent Pi current history
                </button>
            )}
        </div>
    );
}
