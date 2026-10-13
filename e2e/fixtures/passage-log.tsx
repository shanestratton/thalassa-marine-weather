import React from 'react';
import { createRoot } from 'react-dom/client';
import { PassageLogList } from '../../pages/log/PassageLogList';
import { VoyageCard } from '../../pages/log/LogSubComponents';
import { VoyageStatsRollup } from '../../pages/log/VoyageStatsRollup';
import { computePersonalRecords, type VoyageSummary } from '../../services/shiplog/VoyageSummary';
import '../../index.css';
// Two standalone day sails above the passage, as the Log lists them newest
// first (128-HUES: a standalone voyage wears the sea hue, the passage purple).
const singles: VoyageSummary[] = [
    { id: 'fixture-single-0', hours: 2.67, nm: 15.6, at: '2026-09-24T01:10:00Z' },
    { id: 'fixture-single-1', hours: 2.85, nm: 17.9, at: '2026-09-23T00:40:00Z' },
].map(({ id, hours, nm, at }) => ({
    voyageId: id,
    entryCount: 820,
    startedAt: at,
    endedAt: new Date(Date.parse(at) + hours * 3600000).toISOString(),
    totalDistanceNM: nm,
    avgSpeedKts: 6.1,
    hasManual: false,
    isPlannedRoute: false,
    isImported: false,
    firstLat: null,
    firstLon: null,
    lastLat: null,
    lastLon: null,
    firstIsOnWater: true,
    landFraction: 0,
    spanM: 30000,
}));
const legs: VoyageSummary[] = [8.15, 32.85, 46.27].map((hours, i) => ({
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
const voyages = [...singles, ...legs];
// ?mode=light|night: the app's daylight class, or its night scrim (App.tsx).
const mode = new URLSearchParams(location.search).get('mode');
if (mode === 'light') document.documentElement.classList.add('display-light');
const noop = () => {};
const archiveRequests: { passageId: string; voyageIds: string[] }[] = [];
(window as unknown as { __passageArchiveRequests: typeof archiveRequests }).__passageArchiveRequests = archiveRequests;
createRoot(document.getElementById('root')!).render(
    <main className="mx-auto h-full max-w-[430px] overflow-y-auto bg-slate-950 py-8 text-white">
        <h1 className="px-4 mb-5 text-xl font-black">SHIP’S LOG · layout preview</h1>
        {/* The Log page's own pair box (pages/LogPage.tsx), so the stats card
            takes the height it has there, not the whole preview. */}
        <div className="log-journal-pair log-journal-pair--single vessel-hub-journal mx-4 mb-3 grid shrink-0 grid-cols-1 gap-3">
            <VoyageStatsRollup
                voyageStats={{ totalNm: 627.9, totalMs: 92.79 * 3600000, voyageCount: 5 }}
                records={computePersonalRecords(voyages)}
            />
        </div>
        <div className="px-4">
            <PassageLogList
                voyages={voyages}
                onArchivePassage={async (passageId, voyageIds) => {
                    // Fixture-only recorder: never imports or calls an archive service.
                    archiveRequests.push({ passageId, voyageIds });
                }}
                renderVoyage={(summary) => (
                    <VoyageCard
                        key={summary.voyageId}
                        summary={summary}
                        entries={[]}
                        filteredEntries={[]}
                        // The passage's first leg, as before the standalone
                        // voyages joined the list above it.
                        isSelected={summary.voyageId === 'fixture-0'}
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
        {mode === 'night' && (
            <div
                data-testid="night-scrim"
                aria-hidden="true"
                className="pointer-events-none fixed inset-0"
                style={{ backgroundColor: 'rgba(69, 10, 10, 0.25)', zIndex: 9000 }}
            />
        )}
    </main>,
);
