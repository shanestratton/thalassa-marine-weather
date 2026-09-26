import React, { useId, useState } from 'react';
import type { PersonalRecords } from '../../services/shiplog/VoyageSummary';
import { PersonalRecordsStrip } from './PersonalRecordsStrip';
import { VoyageTotalsTiles } from './VoyageTotalsTiles';

export const VoyageStatsRollup: React.FC<{
    voyageStats: React.ComponentProps<typeof VoyageTotalsTiles>['voyageStats'];
    records: PersonalRecords;
    notice?: string;
    /** The lifetime (archive-inclusive) read failed and never succeeded, so
     *  the totals are this phone's recordings only — or nothing at all. */
    lifetimeUnavailable?: boolean;
}> = ({ voyageStats, records, notice, lifetimeUnavailable = false }) => {
    const [expanded, setExpanded] = useState(false);
    const panelId = useId();
    return (
        <section className="shrink-0 mx-4 mb-3 overflow-hidden rounded-2xl border border-sky-400/15 bg-slate-900/40">
            <button
                type="button"
                aria-expanded={expanded}
                aria-controls={panelId}
                aria-label="Voyage stats"
                onClick={() => setExpanded((open) => !open)}
                className="flex min-h-12 w-full items-center justify-between gap-3 px-4 py-3 text-left focus-visible:outline-2 focus-visible:outline-sky-400"
            >
                <span>
                    <span className="block text-xs font-black uppercase tracking-widest text-amber-300">
                        Voyage stats
                    </span>
                    {/* Never claim "includes archived" over totals that could
                        not include it (UX audit run 5: a skipper with forty
                        archived voyages read "0.0 nm lifetime"). */}
                    <span className="mt-1 block text-[11px] text-slate-400">
                        {lifetimeUnavailable
                            ? 'Lifetime unavailable · this phone only'
                            : 'Lifetime · includes archived'}
                    </span>
                </span>
                <span aria-hidden="true" className="flex items-center gap-2 text-xs font-bold text-sky-200">
                    {expanded ? 'Hide' : 'Show'}
                    <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        className={expanded ? 'rotate-180' : ''}
                    >
                        <path d="m6 9 6 6 6-6" />
                    </svg>
                </span>
            </button>
            <div id={panelId} hidden={!expanded} className="max-h-[40dvh] overflow-y-auto border-t border-white/5 pt-3">
                {notice && (
                    <p role="status" className="px-4 pb-3 text-xs text-amber-200">
                        {notice}
                    </p>
                )}
                <VoyageTotalsTiles
                    voyageStats={voyageStats}
                    unavailable={lifetimeUnavailable && voyageStats.voyageCount === 0}
                />
                {records.voyageCount > 0 && <PersonalRecordsStrip records={records} />}
            </div>
        </section>
    );
};
