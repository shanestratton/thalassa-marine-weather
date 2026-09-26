import React from 'react';
import {
    gpsReceiverConnectionDetail,
    NO_GPS_FIX_LINE,
    type GpsDiagnosticsPresentation,
} from './gpsDiagnosticsPresentation';
import type { GpsReceiverStatus } from '../services/GpsReceiverStatusService';

/** The same source-separated GPS details in the info page and layout fixture. */
export const GpsDiagnosticsCards: React.FC<{
    sources: GpsDiagnosticsPresentation[];
    receiver?: GpsReceiverStatus;
    positionSource?: React.ReactNode;
}> = ({ sources, receiver, positionSource }) => (
    <div className="rounded-xl border border-white/10 bg-white/3 p-3 space-y-3" data-testid="gps-quality-panel">
        {positionSource}
        {sources.map((source) => {
            const phone = source.label === 'Phone location';
            const matchesReceiver =
                receiver && (phone ? receiver.kind !== 'vessel-nmea' : receiver.kind === 'vessel-nmea');
            // With no fix at all the card says so once (NO_GPS_FIX_LINE)
            // instead of a position line and three tiles that each word
            // "nothing" differently. The phone's own receiver line would only
            // repeat it, so it goes. An external or boat receiver's line is
            // news about the link ("connected · Waiting for GPS position",
            // "Through the cloud · 2 min ago"), not about the fix, so it stays
            // and the no-fix line still shows under it: a connected link must
            // never read as a position the card does not have.
            const showReceiver = matchesReceiver && !(source.noFix && receiver?.kind === 'phone');
            return (
                <section
                    key={source.label}
                    aria-label={source.label}
                    className={`space-y-2 rounded-xl border p-3 ${phone ? 'border-white/10 bg-black/10' : 'border-sky-400/20 bg-sky-500/5'}`}
                >
                    <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
                        <h3 className="text-xs font-semibold text-white">{source.label}</h3>
                        {!source.noFix && <p className="text-xs text-slate-400">{source.position}</p>}
                    </div>
                    {showReceiver && receiver && (
                        <p
                            className="flex items-start gap-2 text-xs text-slate-300"
                            data-testid="gps-receiver-connection"
                        >
                            <span
                                aria-hidden="true"
                                className={`mt-1 h-2 w-2 shrink-0 rounded-full ${receiver.active ? 'bg-sky-400' : 'bg-slate-500'}`}
                            />
                            <span>
                                {phone && receiver.kind !== 'phone' ? `${receiver.label} · ` : ''}
                                {gpsReceiverConnectionDetail(receiver)}
                            </span>
                        </p>
                    )}
                    {source.noFix && <p className="text-xs text-slate-300">{NO_GPS_FIX_LINE}</p>}
                    {!source.noFix && (
                        <dl className="grid grid-cols-3 gap-2">
                            {(
                                [
                                    ['Satellites', source.satellites],
                                    ['Fix quality', source.quality],
                                    ['Accuracy', source.accuracy],
                                ] as const
                            ).map(([label, metric]) => (
                                <div key={label} className="min-w-0 rounded-lg bg-black/15 px-2 py-2">
                                    <dt className="text-xs text-slate-400">{label}</dt>
                                    <dd
                                        className={`mt-1 break-words text-xs font-semibold ${metric.state === 'current' ? 'text-white' : metric.state === 'stale' ? 'text-amber-300' : 'text-slate-400'}`}
                                    >
                                        {metric.text}
                                    </dd>
                                </div>
                            ))}
                        </dl>
                    )}
                    {!source.noFix && source.hdop.state !== 'unknown' && (
                        <p className="text-xs text-slate-400">HDOP (geometry): {source.hdop.text}</p>
                    )}
                </section>
            );
        })}
    </div>
);
