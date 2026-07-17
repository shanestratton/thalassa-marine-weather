import React from 'react';
import type { VoyageLogData, VoyageLogTelemetry } from '../voyageLogApi';

interface TopNavProps {
    vessel: VoyageLogData['vessel'];
    telemetry: VoyageLogTelemetry | null;
    entryCount: number;
}

const VESSEL_TYPE_LABEL: Record<string, string> = {
    sail: 'Sailing vessel',
    power: 'Power vessel',
    observer: 'Vessel',
};

export default function TopNav({ vessel, telemetry, entryCount }: TopNavProps) {
    const specs = [VESSEL_TYPE_LABEL[vessel.type] ?? 'Vessel', vessel.model].filter(Boolean).join(' · ');

    return (
        <header className="h-16 shrink-0 bg-slate-900 border-b border-slate-700/80 flex items-center justify-between px-4 sm:px-6 shadow-md z-20 relative">
            {/* Brand & vessel */}
            <div className="flex items-center gap-3 sm:gap-4 min-w-0">
                <h1 className="text-lg sm:text-xl font-bold tracking-[0.2em] text-blue-500 uppercase shrink-0">
                    Thalassa
                </h1>
                <div className="h-7 w-px bg-slate-700 shrink-0" />
                <div className="flex flex-col min-w-0">
                    <span className="text-sm font-bold text-slate-100 truncate">{vessel.name}</span>
                    <span className="text-[11px] text-slate-400 truncate">{specs}</span>
                </div>
            </div>

            {/* Status */}
            <div className="flex items-center gap-3 sm:gap-4 shrink-0">
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
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-700 text-[11px] font-bold uppercase tracking-wider text-slate-300 hover:text-white hover:border-slate-500 transition-colors"
                    title="Skipper? Sign in and build a passage on the big screen"
                >
                    ⚓ Skipper
                </a>
                <span className="hidden sm:block text-[11px] font-mono text-slate-500">
                    {entryCount} {entryCount === 1 ? 'entry' : 'entries'}
                </span>
                {telemetry ? (
                    <span className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-emerald-400">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                        Live
                    </span>
                ) : (
                    <span className="text-[11px] font-mono text-slate-500">No telemetry yet</span>
                )}
            </div>
        </header>
    );
}
