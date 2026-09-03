/**
 * LogStatsFullscreen — the fullscreen Voyage Statistics view of LogPage,
 * extracted verbatim from pages/LogPage.tsx. Rendered instead of the log
 * itself while `showStats` is set.
 */

import type { LogPageAction } from '../../hooks/useLogPageState';
import type { ShipLogEntry } from '../../types';
import { VoyageStatsPanel } from '../../components/VoyageStatsPanel';
import { StatBox } from './LogSubComponents';

export const LogStatsFullscreen: React.FC<{
    dispatch: (action: LogPageAction) => void;
    scopedStatsEntries: ShipLogEntry[];
    selectedVoyageId: string | null;
}> = ({ dispatch, scopedStatsEntries, selectedVoyageId }) => (
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
            {(() => {
                // All-Voyages aggregate excludes suggested/
                // planned routes (source='planned_route') so
                // they don't inflate distance / speed / entry
                // totals. A single selected voyage shows its
                // own entries verbatim (the user explicitly
                // drilled into it). 2026-05-20.
                const scopedEntries = scopedStatsEntries;

                let scopedDistance = 0;
                if (selectedVoyageId) {
                    // Single voyage: max cumulative distance
                    for (const e of scopedEntries) {
                        const d = e.cumulativeDistanceNM || 0;
                        if (d > scopedDistance) scopedDistance = d;
                    }
                } else {
                    // All voyages: sum each voyage's max cumulative distance
                    const voyageMap = new Map<string, number>();
                    scopedEntries.forEach((e) => {
                        const vid = e.voyageId || 'default';
                        const current = voyageMap.get(vid) || 0;
                        voyageMap.set(vid, Math.max(current, e.cumulativeDistanceNM || 0));
                    });
                    voyageMap.forEach((d) => {
                        scopedDistance += d;
                    });
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
        </div>
    </div>
);
