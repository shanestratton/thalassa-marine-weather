/**
 * LogStatsFullscreen — the fullscreen Voyage Statistics view of LogPage,
 * extracted verbatim from pages/LogPage.tsx. Rendered instead of the log
 * itself while `showStats` is set.
 */

import type { LogPageAction } from '../../hooks/useLogPageState';
import type { ShipLogEntry } from '../../types';
import { VoyageStatsPanel } from '../../components/VoyageStatsPanel';
import { StatBox } from './LogSubComponents';
import type { LifetimeVoyageStats } from '../../utils/lifetimeVoyageStats';
import { VoyageTotalsTiles } from './VoyageTotalsTiles';
import { PersonalRecordsStrip } from './PersonalRecordsStrip';
import { LIFETIME_PHONE_ONLY, lifetimeUnavailableNotice } from './logPageHelpers';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';

export const LogStatsFullscreen: React.FC<{
    dispatch: (action: LogPageAction) => void;
    scopedStatsEntries: ShipLogEntry[];
    selectedVoyageId: string | null;
    lifetimeStats: LifetimeVoyageStats;
    lifetimeStatsNotice?: string;
    /** The lifetime (archive-inclusive) read failed and never succeeded, so
     *  the totals are this phone's recordings only — or nothing at all. */
    lifetimeUnavailable?: boolean;
}> = ({
    dispatch,
    scopedStatsEntries,
    selectedVoyageId,
    lifetimeStats,
    lifetimeStatsNotice,
    lifetimeUnavailable = false,
}) => {
    // Nothing loaded and the history read failed: '--', not a hard 0.0 that
    // reads as "never sailed" (same rule as VoyageStatsRollup).
    const totalsUnavailable = lifetimeUnavailable && lifetimeStats.totals.voyageCount === 0;
    const offline = !useOnlineStatus();
    // Same words as the Log's Voyage stats card.
    const notice = lifetimeUnavailable
        ? lifetimeUnavailableNotice(lifetimeStats.totals.voyageCount, offline)
        : lifetimeStatsNotice;
    return (
        <div className="flex flex-col h-full">
            <div className="flex items-center justify-between p-4 border-b border-white/10">
                <h2 className="text-lg font-bold text-white">Voyage Statistics</h2>
                <button
                    aria-label="Close statistics"
                    onClick={() => dispatch({ type: 'SHOW_STATS', show: false })}
                    className="p-2 text-slate-400 hover:text-white hover:bg-white/10 rounded-lg transition-colors"
                >
                    <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                </button>
            </div>
            <div className="flex-1 overflow-auto p-4 md:p-8 flex flex-col justify-center md:max-w-3xl md:mx-auto">
                {!selectedVoyageId ? (
                    <>
                        <p className="mb-4 text-center text-sm font-semibold text-purple-200">
                            {lifetimeUnavailable ? LIFETIME_PHONE_ONLY : 'Lifetime · includes archived voyages'}
                        </p>
                        {notice && (
                            <p role="status" className="mb-4 text-sm text-amber-200">
                                {notice}
                            </p>
                        )}
                        <VoyageTotalsTiles voyageStats={lifetimeStats.totals} unavailable={totalsUnavailable} />
                        {lifetimeStats.records.voyageCount > 0 && (
                            <PersonalRecordsStrip records={lifetimeStats.records} />
                        )}
                        <p className="mt-4 text-center text-xs text-slate-400">
                            {totalsUnavailable
                                ? 'Recorded entries unavailable.'
                                : `${lifetimeStats.entryCount.toLocaleString()} recorded entries.`}{' '}
                            Sea time is the sum of each voyage, excluding time between trips. Select a voyage for its
                            speed and weather detail.
                        </p>
                    </>
                ) : (
                    <>
                        {(() => {
                            // Point-level detail is only for the explicitly
                            // selected voyage, never a partial lifetime timeline.
                            const scopedEntries = scopedStatsEntries;

                            let scopedDistance = 0;
                            for (const e of scopedEntries) {
                                const d = e.cumulativeDistanceNM || 0;
                                if (d > scopedDistance) scopedDistance = d;
                            }

                            const speedEntries = scopedEntries.filter((e) => e.speedKts && e.speedKts > 0);
                            const scopedAvgSpeed =
                                speedEntries.length > 0
                                    ? speedEntries.reduce((sum, e) => sum + (e.speedKts || 0), 0) / speedEntries.length
                                    : 0;
                            return (
                                <div className="grid grid-cols-3 gap-3 mb-4">
                                    <StatBox label="Distance" value={`${(scopedDistance ?? 0).toFixed(1)} NM`} />
                                    <StatBox label="Avg Speed" value={`${(scopedAvgSpeed ?? 0).toFixed(1)} kts`} />
                                    <StatBox label="Entries" value={scopedEntries.length} />
                                </div>
                            );
                        })()}
                        <VoyageStatsPanel entries={scopedStatsEntries} />
                    </>
                )}
            </div>
        </div>
    );
};
