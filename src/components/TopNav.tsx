import React from 'react';
import type { VoyageLogData, VoyageLogTelemetry } from '../voyageLogApi';
import { formatPublicAge, isPublicPositionFresh } from '../publicVoyageFreshness';

interface TopNavProps {
    vessel: VoyageLogData['vessel'];
    telemetry: VoyageLogTelemetry | null;
    /** Still passed by callers and tests; the count now lives in the diary's
     *  chapter head, so the masthead no longer renders it. */
    entryCount: number;
    /** Dashboard clock; advances independently of network responses. */
    nowMs: number;
    connectionLost: boolean;
    lastSuccessfulAt: number | null;
    /** Replaces the live-status chip while browsing historical material or
     *  the unassigned all-diary view. */
    viewStatus?: string;
    /** 'hero': the floating card over the chart (name, specs, status, the
     *  instruments row). 'bar': the docked one-row header above a phone
     *  panel, where the trip chip and chapter head already say the rest. */
    layout?: 'hero' | 'bar';
    /** The exact 'Last known · N ago' string, shown only after viewStatus. */
    positionLabel?: string | null;
    /** Freshness of the shared instruments, or null when none are shared. */
    instrumentStatus?: { live: boolean; age: string } | null;
    onOpenInstruments?: () => void;
}

const VESSEL_TYPE_LABEL: Record<string, string> = {
    sail: 'Sailing vessel',
    power: 'Power vessel',
    observer: 'Vessel',
};

export default function TopNav({
    vessel,
    telemetry,
    nowMs,
    connectionLost,
    lastSuccessfulAt,
    viewStatus,
    layout = 'hero',
    positionLabel = null,
    instrumentStatus = null,
    onOpenInstruments,
}: TopNavProps) {
    const specs = [VESSEL_TYPE_LABEL[vessel.type] ?? 'Vessel', vessel.model].filter(Boolean).join(' · ');
    const telemetryIsFresh =
        telemetry !== null && !telemetry.is_last_known && isPublicPositionFresh(telemetry.updated_at, nowMs);
    const isHero = layout === 'hero';

    const instrumentTone = instrumentStatus?.live ? 'live' : 'idle';
    const instrumentContent = instrumentStatus && (
        <>
            <span className="pv-dot" data-tone={instrumentTone} aria-hidden="true" />
            <span className="pv-num">
                {`Instruments · ${instrumentStatus.live ? `Live · ${instrumentStatus.age}` : `Last report ${instrumentStatus.age}`}`}
            </span>
        </>
    );

    return (
        <header className={`pv-masthead flex min-w-0 flex-col ${isHero ? 'gap-1.5' : 'gap-0.5'}`} data-layout={layout}>
            {/* Identity: exactly one h1 on the page, holding only the name. */}
            <div className="min-w-0">
                <h1 title={vessel.name} className="pv-boat-name">
                    {vessel.name}
                </h1>
                {isHero && specs && <p className="pv-specs hidden [@media(min-height:720px)]:block">{specs}</p>}
            </div>

            {/* LIVE vs LAST KNOWN. This used to read "Live" whenever telemetry
                existed at all — which became a lie the moment the page grew a
                last-known-position fallback, because telemetry then ALWAYS
                exists. A 21-hour-old berth fix under a pulsing green "Live" is
                worse than the blank it replaced: a viewer could plan around it.
                Under way breathes and says how fresh; moored is grey, still, and
                says when it was last seen. */}
            {connectionLost ? (
                <span role="status" aria-live="polite" className="pv-status" data-tone="warn">
                    <span className="pv-dot" data-tone="warn" aria-hidden="true" />
                    Connection lost · last update {formatPublicAge(lastSuccessfulAt, nowMs)}
                </span>
            ) : viewStatus ? (
                // In the docked bar the trip chip and the chapter head already
                // say which record this is, so the line is hero-only.
                isHero && (
                    <span className="pv-status" data-tone="idle">
                        <span className="pv-dot" data-tone="idle" aria-hidden="true" />
                        {viewStatus}
                        {positionLabel && <span className="pv-status__detail"> · {positionLabel}</span>}
                    </span>
                )
            ) : telemetry ? (
                !telemetryIsFresh ? (
                    <span className="pv-status" data-tone="idle">
                        <span className="pv-dot" data-tone="idle" aria-hidden="true" />
                        Not tracking · {formatPublicAge(telemetry.updated_at, nowMs)}
                    </span>
                ) : (
                    <span className="pv-status" data-tone="live">
                        <span className="pv-dot" data-tone="live" aria-hidden="true" />
                        Live · {formatPublicAge(telemetry.updated_at, nowMs)}
                    </span>
                )
            ) : (
                isHero && (
                    <span className="pv-status" data-tone="quiet">
                        No telemetry yet
                    </span>
                )
            )}

            {/* What the boat is reporting right now, in the panel's own
                'Live' / 'Last report' words. A door to the instruments when
                the page can open them; otherwise a plain line. */}
            {isHero &&
                instrumentStatus &&
                (onOpenInstruments ? (
                    <button
                        type="button"
                        onClick={onOpenInstruments}
                        className="pv-now"
                        data-tone={instrumentTone}
                        title="Open the instruments"
                    >
                        {instrumentContent}
                        <svg
                            className="pv-now__chev"
                            aria-hidden="true"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                        >
                            <path strokeLinecap="round" strokeLinejoin="round" d="m9 6 6 6-6 6" />
                        </svg>
                    </button>
                ) : (
                    <p className="pv-now" data-tone={instrumentTone}>
                        {instrumentContent}
                    </p>
                ))}
        </header>
    );
}
