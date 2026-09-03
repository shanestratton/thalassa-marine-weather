/**
 * PersonalRecordsStrip — the career-bests strip (Farthest / Fastest avg /
 * Longest) shown under the gauge tiles, extracted verbatim from
 * pages/LogPage.tsx. The caller keeps the `!isTracking && voyageCount >= 2`
 * guard, so this renders only where it did before.
 */
import React from 'react';
import type { PersonalRecords } from '../../services/shiplog/VoyageSummary';

export const PersonalRecordsStrip: React.FC<{ records: PersonalRecords }> = ({ records }) => (
    <div className="px-4 mb-2">
        <div className="grid grid-cols-3 gap-2">
            {[
                {
                    label: 'Farthest',
                    value: `${records.longestPassageNM.toFixed(0)}`,
                    unit: 'NM',
                    icon: '🧭',
                },
                {
                    label: 'Fastest avg',
                    value: `${records.fastestAvgKts.toFixed(1)}`,
                    unit: 'kts',
                    icon: '⚡',
                },
                {
                    label: 'Longest',
                    value: (() => {
                        const h = records.longestDurationMs / 3600000;
                        return h >= 24 ? `${Math.floor(h / 24)}d` : `${Math.round(h)}h`;
                    })(),
                    unit: '',
                    icon: '⏱️',
                },
            ].map((r) => (
                <div
                    key={r.label}
                    className="rounded-xl bg-slate-900/40 border border-amber-500/15 px-2 py-2 text-center"
                >
                    <div className="text-[11px] uppercase tracking-wider text-amber-400/80 font-bold flex items-center justify-center gap-1">
                        <span>{r.icon}</span>
                        {r.label}
                    </div>
                    <div className="text-lg font-extrabold text-white tabular-nums mt-0.5">
                        {r.value}
                        {r.unit && <span className="text-[11px] text-white/60 ml-0.5">{r.unit}</span>}
                    </div>
                </div>
            ))}
        </div>
    </div>
);
