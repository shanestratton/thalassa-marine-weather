import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArchivedVoyagesSection } from '../../pages/log/ArchivedVoyagesSection';
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

function Fixture() {
    const [open, setOpen] = useState(true);
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
    return (
        <main className="h-dvh overflow-x-hidden overflow-y-auto bg-slate-950 px-3 pb-8 pt-6 text-white">
            <div className="mx-auto max-w-xl">
                <p className="text-xs font-extrabold tracking-widest text-sky-300">THALASSA</p>
                <h1 className="mt-2 text-2xl font-black">Ship’s log</h1>
                <p className="mt-1 text-xs text-slate-400">Layout preview · sample voyages only</p>
                <ArchivedVoyagesSection
                    loggedArchivedVoyages={voyages}
                    showArchived={open}
                    setShowArchived={setOpen}
                    handleUnarchiveVoyage={async (id) =>
                        setVoyages((current) => current.filter((v) => v.voyageId !== id))
                    }
                    handleRestorePassage={async (_group, ids) =>
                        setVoyages((current) => current.filter((v) => !ids.includes(v.voyageId)))
                    }
                />
            </div>
        </main>
    );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
