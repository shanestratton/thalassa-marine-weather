import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArchivedVoyagesSection } from '../../pages/log/ArchivedVoyagesSection';
import { LogHistoryScroll } from '../../pages/log/LogHistoryScroll';
import { VoyageStatsRollup } from '../../pages/log/VoyageStatsRollup';
import type { VoyageSummary } from '../../services/shiplog/VoyageSummary';
import '../../index.css';

const summary = (id: string, start: number, distance: number, passageGroupId?: string): VoyageSummary => ({
    voyageId: id,
    passageGroupId,
    startedAt: '2026-09-23T22:30:00Z',
    departedAt: '2026-09-23T22:43:00Z',
    endedAt: '2026-09-24T01:23:00Z',
    totalDistanceNM: distance,
    entryCount: 820,
    avgSpeedKts: 6,
    hasManual: false,
    isPlannedRoute: false,
    isImported: false,
    firstLat: start,
    firstLon: 149,
    lastLat: start + 1,
    lastLon: 149,
    firstIsOnWater: true,
    landFraction: 0,
});

const params = new URLSearchParams(window.location.search);
// ?theme=light: the daylight remap, as App.tsx sets it on the root.
if (params.get('theme') === 'light') document.documentElement.classList.add('display-light');

const stats = { totalNm: 620.8, totalMs: 100 * 60 * 60 * 1000, voyageCount: 9 };
const records = {
    longestPassageNM: 306,
    longestPassageVoyageId: 'first',
    fastestAvgKts: 6.7,
    fastestVoyageId: 'daydream',
    longestDurationMs: 46 * 60 * 60 * 1000,
    longestDurationVoyageId: 'first',
    voyageCount: 9,
};

function Fixture() {
    const logMode = params.get('log') === '1';
    // ?tracking=1: the recording Log, the stats card above the live card.
    const tracking = params.get('tracking') === '1';
    const [open, setOpen] = useState(!logMode);
    const [voyages, setVoyages] = useState([
        summary('daydream', -20, 15.6),
        summary('butterfly', -21, 11.2),
        summary('third', -22, 57.9, 'north'),
        summary('second', -23, 230.1, 'north'),
        {
            ...summary('first', -27, 306, 'north'),
            startedAt: '2026-09-15T02:28:00Z',
            departedAt: '2026-09-15T02:28:00Z',
            endedAt: '2026-09-17T00:44:00Z',
        },
    ]);
    const archive = (
        <ArchivedVoyagesSection
            loggedArchivedVoyages={voyages}
            showArchived={open}
            setShowArchived={setOpen}
            handleUnarchiveVoyage={async (id) => setVoyages((current) => current.filter((v) => v.voyageId !== id))}
            handleRestorePassage={async (_group, ids) =>
                setVoyages((current) => current.filter((v) => !ids.includes(v.voyageId)))
            }
        />
    );
    if (logMode) {
        return (
            <main className="h-dvh overflow-hidden bg-slate-950 text-white">
                <header
                    role="banner"
                    aria-label="Log header"
                    className="fixed inset-x-0 top-0 z-10 flex h-14 items-center border-b border-white/10 bg-slate-950 px-4"
                >
                    <h1 className="text-lg font-black">Ship’s log</h1>
                </header>
                <div className="absolute inset-x-0 top-14 bottom-28 flex min-h-0 flex-col pt-3">
                    {/* As pages/LogPage.tsx: the pair anchored above the list. */}
                    <div
                        className={`log-journal-pair vessel-hub-journal mx-4 mb-3 grid shrink-0 gap-3 ${tracking ? 'log-journal-pair--single grid-cols-1' : 'grid-cols-2'}`}
                    >
                        <VoyageStatsRollup voyageStats={stats} records={records} />
                        {!tracking && archive}
                    </div>
                    {tracking ? (
                        <section
                            aria-label="Live voyage"
                            className="mx-4 flex flex-1 flex-col rounded-2xl border border-white/10 bg-slate-900/40 p-4"
                        >
                            <h2 className="text-sm font-bold">Recording · sample data</h2>
                            <div className="mt-3 min-h-[100px] flex-1 rounded-xl border border-white/5 bg-[#0b1220]" />
                        </section>
                    ) : (
                        <LogHistoryScroll>
                            <section aria-label="Current voyages" className="space-y-3">
                                {['Day sail', 'Harbour cruise', 'Passage south', 'Latest anchorage'].map(
                                    (title, index) => (
                                        <article
                                            key={title}
                                            aria-label={`Current voyage ${title}`}
                                            className="min-h-44 snap-start rounded-2xl border border-white/10 bg-slate-900/40 p-4"
                                        >
                                            <h2 className="text-sm font-bold">{title}</h2>
                                            <p className="mt-2 text-xs text-slate-400">
                                                Recorded voyage {index + 1} · sample data
                                            </p>
                                            <div
                                                className="mt-4 h-16 rounded-xl border border-sky-400/15 bg-sky-950/30"
                                                aria-hidden="true"
                                            />
                                        </article>
                                    ),
                                )}
                            </section>
                        </LogHistoryScroll>
                    )}
                </div>
                <footer
                    role="contentinfo"
                    aria-label="Tracking controls"
                    className="fixed inset-x-0 bottom-14 z-10 flex h-14 items-center border-t border-white/10 bg-slate-950 px-4"
                >
                    <button type="button" className="min-h-11 w-full rounded-xl bg-sky-500/20 text-sm font-bold">
                        {tracking ? 'Stop tracking' : 'Start tracking'}
                    </button>
                </footer>
                <nav
                    aria-label="Main"
                    className="fixed inset-x-0 bottom-0 z-10 flex h-14 border-t border-white/10 bg-slate-950"
                >
                    {['Weather', 'Map', 'Log', 'Vessel'].map((tab) => (
                        <button
                            key={tab}
                            type="button"
                            aria-current={tab === 'Log' ? 'page' : undefined}
                            className="min-h-11 min-w-11 flex-1 text-xs font-bold"
                        >
                            {tab}
                        </button>
                    ))}
                </nav>
            </main>
        );
    }
    return (
        <main className="h-dvh overflow-x-hidden overflow-y-auto bg-slate-950 px-3 pb-8 pt-6 text-white">
            <div className="mx-auto max-w-xl">
                <p className="text-xs font-extrabold tracking-widest text-sky-300">THALASSA</p>
                <h1 className="mt-2 text-2xl font-black">Ship’s log</h1>
                <p className="mt-1 text-xs text-slate-400">Layout preview · sample voyages only</p>
                {archive}
            </div>
        </main>
    );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
