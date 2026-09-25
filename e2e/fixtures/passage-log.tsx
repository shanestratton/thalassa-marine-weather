import React from 'react';
import { createRoot } from 'react-dom/client';
import { PassageLogList } from '../../pages/log/PassageLogList';
import { VoyageCard } from '../../pages/log/LogSubComponents';
import { VoyageStatsRollup } from '../../pages/log/VoyageStatsRollup';
import { computePersonalRecords, type VoyageSummary } from '../../services/shiplog/VoyageSummary';
import '../../index.css';
const voyages: VoyageSummary[] = [8.15, 32.85, 46.27].map((hours, i) => ({
    voyageId: `fixture-${i}`,
    passageGroupId: 'fixture-passage',
    entryCount: 5000,
    startedAt: '2026-09-15T02:28:00Z',
    endedAt: new Date(Date.parse('2026-09-15T02:28:00Z') + hours * 3600000).toISOString(),
    totalDistanceNM: [57.9, 230.1, 306.4][i],
    avgSpeedKts: 6.5,
    hasManual: false,
    isPlannedRoute: false,
    isImported: false,
    firstLat: null,
    firstLon: null,
    lastLat: null,
    lastLon: null,
    firstIsOnWater: true,
    landFraction: 0,
    spanM: 300000,
}));
const noop = () => {};
const archiveRequests: { passageId: string; voyageIds: string[] }[] = [];
(window as unknown as { __passageArchiveRequests: typeof archiveRequests }).__passageArchiveRequests = archiveRequests;
createRoot(document.getElementById('root')!).render(
    <main className="mx-auto h-full max-w-[430px] overflow-y-auto bg-slate-950 py-8 text-white">
        <h1 className="px-4 mb-5 text-xl font-black">SHIP’S LOG · layout preview</h1>
        <VoyageStatsRollup
            voyageStats={{ totalNm: 594.4, totalMs: 87.27 * 3600000, voyageCount: 3 }}
            records={computePersonalRecords(voyages)}
        />
        <div className="px-4">
            <PassageLogList
                voyages={voyages}
                onArchivePassage={async (passageId, voyageIds) => {
                    // Fixture-only recorder: never imports or calls an archive service.
                    archiveRequests.push({ passageId, voyageIds });
                }}
                renderVoyage={(summary, first) => (
                    <VoyageCard
                        key={summary.voyageId}
                        summary={summary}
                        entries={[]}
                        filteredEntries={[]}
                        isSelected={first}
                        isExpanded={false}
                        suppressMiniMap
                        onToggle={noop}
                        onSelect={noop}
                        onDelete={noop}
                        onArchive={noop}
                        onShowMap={noop}
                        onFollowPlannedRoute={async () => false}
                        onDeleteEntry={noop}
                        onEditEntry={noop}
                    />
                )}
            />
        </div>
    </main>,
);
