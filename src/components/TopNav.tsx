import React from 'react';
import type { VoyageLogData, VoyageLogTelemetry } from '../voyageLogApi';
import { formatPublicAge, isPublicPositionFresh } from '../publicVoyageFreshness';

interface TopNavProps {
    vessel: VoyageLogData['vessel'];
    telemetry: VoyageLogTelemetry | null;
    entryCount: number;
    /** Dashboard clock; advances independently of network responses. */
    nowMs: number;
    connectionLost: boolean;
    lastSuccessfulAt: number | null;
    /** Replaces the live-status chip while browsing historical material or
     *  the unassigned all-diary view. */
    viewStatus?: string;
}

const VESSEL_TYPE_LABEL: Record<string, string> = {
    sail: 'Sailing vessel',
    power: 'Power vessel',
    observer: 'Vessel',
};

export default function TopNav({
    vessel,
    telemetry,
    entryCount,
    nowMs,
    connectionLost,
    lastSuccessfulAt,
    viewStatus,
}: TopNavProps) {
    const specs = [VESSEL_TYPE_LABEL[vessel.type] ?? 'Vessel', vessel.model].filter(Boolean).join(' · ');
    const telemetryIsFresh =
        telemetry !== null && !telemetry.is_last_known && isPublicPositionFresh(telemetry.updated_at, nowMs);

    return (
        <header className="relative z-20 grid shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 border-b border-teal-200/15 bg-linear-to-r from-slate-950 via-slate-900 to-teal-950/70 px-3 py-1.5 shadow-md lg:flex lg:justify-between lg:gap-3 lg:px-6 lg:py-3">
            {/* Brand & vessel */}
            <div className="col-start-1 row-start-1 flex min-w-0 flex-1 flex-col lg:gap-1">
                <span className="text-[9px] leading-3 font-semibold tracking-[0.18em] text-teal-300 uppercase lg:text-xs">
                    Thalassa
                </span>
                <div className="flex flex-col min-w-0">
                    <h1
                        title={vessel.name}
                        className="text-lg lg:text-2xl font-semibold tracking-tight text-slate-100 truncate"
                    >
                        {vessel.name}
                    </h1>
                    <span className="hidden text-xs text-slate-400 truncate lg:block">{specs}</span>
                </div>
            </div>

            {/* Status */}
            <div className="contents lg:flex lg:max-w-[45%] lg:flex-wrap lg:items-center lg:justify-end lg:gap-x-4 lg:gap-y-1 lg:text-right">
                {/* Skipper door — the public log page's only outbound link.
                    RELATIVE /plan (Shane 2026-07-17: "it defaults back to
                    www.thalassawx.app/plan rather than boat-name.thalassawx.app
                    /plan"). This tracking page is served on the vessel
                    subdomain, so a relative link keeps the punter on THEIR
                    boat's planner (serene-summer.thalassawx.app/plan) — the
                    old absolute apex link 308-redirected to www and dropped
                    the handle. Sign-in happens on the subdomain now (its own
                    per-origin session), which is the intended per-vessel model.
                    Still supabase-free here — a plain <a>, not an auth flow. */}
                <a
                    href="/plan"
                    className="col-start-2 row-start-1 row-span-2 flex items-center gap-1.5 min-h-[44px] px-3 py-1.5 rounded-lg border border-slate-700 text-[11px] font-bold uppercase tracking-wider text-slate-300 hover:text-white hover:border-slate-500 transition-colors"
                    title="Skipper? Sign in and build a passage on the big screen"
                >
                    ⚓ Skipper
                </a>
                <span className="hidden lg:block text-[11px] font-mono text-slate-400">
                    {entryCount} {entryCount === 1 ? 'entry' : 'entries'}
                </span>
                {/* LIVE vs LAST KNOWN. This used to read "Live" whenever telemetry
                    existed at all — which became a lie the moment the page grew a
                    last-known-position fallback, because telemetry then ALWAYS
                    exists. A 21-hour-old berth fix under a pulsing green "Live" is
                    worse than the blank it replaced: a viewer could plan around it.
                    Under way pulses and says how fresh; moored is grey, still, and
                    says when it was last seen. */}
                {connectionLost ? (
                    <span
                        role="status"
                        aria-live="polite"
                        className="col-start-1 row-start-2 flex items-center gap-1.5 text-xs leading-4 font-semibold text-amber-300 lg:text-[11px] lg:uppercase lg:tracking-wider"
                    >
                        <span className="w-1.5 h-1.5 shrink-0 rounded-full bg-amber-400" />
                        Connection lost · last update {formatPublicAge(lastSuccessfulAt, nowMs)}
                    </span>
                ) : viewStatus ? (
                    <span className="col-start-1 row-start-2 flex items-center gap-1.5 text-xs leading-4 font-semibold text-slate-300 lg:text-[11px] lg:uppercase lg:tracking-wider">
                        <span className="w-1.5 h-1.5 shrink-0 rounded-full bg-slate-500" />
                        {viewStatus}
                    </span>
                ) : telemetry ? (
                    !telemetryIsFresh ? (
                        <span className="col-start-1 row-start-2 flex items-center gap-1.5 text-xs leading-4 font-semibold text-slate-300 lg:text-[11px] lg:uppercase lg:tracking-wider">
                            <span className="w-1.5 h-1.5 shrink-0 rounded-full bg-slate-500" />
                            Not tracking · {formatPublicAge(telemetry.updated_at, nowMs)}
                        </span>
                    ) : (
                        <span className="col-start-1 row-start-2 flex items-center gap-1.5 text-xs leading-4 font-semibold text-emerald-400 lg:text-[11px] lg:uppercase lg:tracking-wider">
                            <span className="w-1.5 h-1.5 shrink-0 rounded-full bg-emerald-400 animate-pulse" />
                            Live · {formatPublicAge(telemetry.updated_at, nowMs)}
                        </span>
                    )
                ) : (
                    <span className="col-start-1 row-start-2 text-xs leading-4 text-slate-300 lg:text-[11px] lg:font-mono">
                        No telemetry yet
                    </span>
                )}
            </div>
        </header>
    );
}
