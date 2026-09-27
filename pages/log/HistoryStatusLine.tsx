/**
 * HistoryStatusLine — the one page-level line the Ship's Log shows when BOTH
 * account-history reads failed (lifetime totals and the archive).
 *
 * Those two reads share one reload and almost always one cause, yet each card
 * used to head the page with its own failure wording and its own Retry, about
 * 200 pt apart (UX scorecard run 7). This line says it once, names the cause
 * only when the app already knows it (probe-verified offline), and carries the
 * single Retry that re-runs both loads. The cards stay collapsed under it,
 * keeping their short status lines.
 */
import React, { useId } from 'react';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import { HISTORY_PHONE_ONLY } from './logPageHelpers';

export const HistoryStatusLine: React.FC<{
    /** Re-runs the lifetime and archive loads together. */
    onRetry: () => void;
    /** Either load is in flight after this line's Retry. */
    retrying: boolean;
}> = ({ onRetry, retrying }) => {
    const offline = !useOnlineStatus();
    const textId = useId();
    return (
        <div className="shrink-0 mx-4 mb-3 flex items-center justify-between gap-3 rounded-2xl border border-amber-400/25 bg-amber-400/10 py-1.5 pl-4 pr-1.5">
            {/* amber-100/90, not amber-100: daylight maps plain amber-100 to
                amber-700, which measured 3.9:1 on this tint; the /90 step maps
                to amber-800 (#92400e, about 5.5:1). At night the two are alike
                (UX scorecard run 8). */}
            <p id={textId} role="status" className="text-xs leading-snug text-amber-100/90">
                {HISTORY_PHONE_ONLY}
                {offline ? ' You’re offline.' : ''}
            </p>
            <button
                type="button"
                onClick={onRetry}
                disabled={retrying}
                aria-describedby={textId}
                className="min-h-[44px] shrink-0 rounded-xl border border-sky-400/25 bg-sky-400/10 px-3.5 text-xs font-bold text-sky-200 transition-colors hover:bg-sky-400/20 disabled:opacity-60"
            >
                {retrying ? 'Retrying…' : 'Retry'}
            </button>
        </div>
    );
};
