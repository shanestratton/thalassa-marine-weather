/**
 * CastOffHandoffNotices — the amber/green cards that report the Cast Off
 * handoff's GPS, route-line and public-page state, extracted verbatim from
 * pages/LogPage.tsx. The caller keeps the "is there anything to say?" guard.
 */
import React from 'react';
import { startHandoffGps, updateCastOffHandoff, type CastOffHandoff } from '../../services/castOffHandoff';

export const CastOffHandoffNotices: React.FC<{ castOffHandoff: CastOffHandoff; isTracking: boolean }> = ({
    castOffHandoff,
    isTracking,
}) => (
    <div className="px-4 mb-2 space-y-2">
        {castOffHandoff.gps === 'starting' && !isTracking && (
            <div className="rounded-xl border border-emerald-400/25 bg-emerald-500/10 px-3 py-2.5 flex items-center gap-2.5">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse shrink-0" />
                <p className="text-sm font-semibold text-emerald-100">
                    Underway — GPS voyage logging is starting for “{castOffHandoff.voyageName}”…
                </p>
            </div>
        )}
        {castOffHandoff.gps === 'failed' && (
            <div role="alert" className="rounded-xl border border-amber-400/25 bg-amber-500/10 px-3 py-2.5 space-y-2">
                <p className="text-sm font-semibold text-amber-100">
                    Passage is active, but GPS voyage logging did not start.
                    {castOffHandoff.gpsError ? ` ${castOffHandoff.gpsError}` : ''}
                </p>
                <button
                    type="button"
                    onClick={() => void startHandoffGps(true)}
                    className="min-h-[44px] rounded-xl border border-amber-300/25 bg-amber-400/15 px-3 py-2 text-xs font-black text-amber-100"
                >
                    Retry GPS Logging
                </button>
            </div>
        )}
        {castOffHandoff.followNote && (
            <div className="rounded-xl border border-amber-400/25 bg-amber-500/10 px-3 py-2.5 space-y-1.5">
                <p className="text-[11px] font-black uppercase tracking-[0.2em] text-amber-300">Route line not armed</p>
                <p className="text-sm text-amber-100">{castOffHandoff.followNote}</p>
                <button
                    type="button"
                    onClick={() => updateCastOffHandoff({ followNote: null })}
                    className="hit-target-44 rounded-lg border border-amber-300/20 px-2 py-1 text-xs font-black text-amber-200/80"
                >
                    Got it
                </button>
            </div>
        )}
        {(castOffHandoff.publishState === 'skipped' ||
            castOffHandoff.publishState === 'failed' ||
            castOffHandoff.publishState === 'queued') && (
            <div className="rounded-xl border border-amber-400/25 bg-amber-500/10 px-3 py-2.5 space-y-1.5">
                <p className="text-[11px] font-black uppercase tracking-[0.2em] text-amber-300">Public page</p>
                <p className="text-sm text-amber-100">
                    {castOffHandoff.publishState === 'skipped'
                        ? 'This route has no planned mirror the public page can draw. Open it in Route Tracer and save it again, then re-tick Show on the Public Page at your next Cast Off.'
                        : castOffHandoff.publishState === 'queued'
                          ? 'The public-page link is queued — it will publish automatically when the connection allows.'
                          : 'Publishing the route to the public page failed. It will keep retrying in the background while online.'}
                </p>
                <button
                    type="button"
                    onClick={() => updateCastOffHandoff({ publishState: 'private' })}
                    className="hit-target-44 rounded-lg border border-amber-300/20 px-2 py-1 text-xs font-black text-amber-200/80"
                >
                    Got it
                </button>
            </div>
        )}
    </div>
);
