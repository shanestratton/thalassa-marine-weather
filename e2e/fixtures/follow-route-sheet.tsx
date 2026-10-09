import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { VoyageSummary } from '../../services/shiplog/VoyageSummary';
import type { TraceCheckState } from '../../services/traceBackgroundCheck';
import '../../index.css';

if (!import.meta.env.DEV)
    throw new Error('The follow-route-sheet fixture is available only through the development server.');

// Isolation: page-only storage and no network. Fictional routes only (the
// repo is public): a three-leg Solent passage and a Riviera day sail.
class FixtureStorage implements Storage {
    private entries = new Map<string, string>();
    get length() {
        return this.entries.size;
    }
    clear() {
        this.entries.clear();
    }
    getItem(key: string) {
        return this.entries.get(String(key)) ?? null;
    }
    key(index: number) {
        return [...this.entries.keys()][index] ?? null;
    }
    removeItem(key: string) {
        this.entries.delete(String(key));
    }
    setItem(key: string, value: string) {
        this.entries.set(String(key), String(value));
    }
}
Object.defineProperty(window, 'localStorage', { configurable: true, value: new FixtureStorage() });
Object.defineProperty(window, 'sessionStorage', { configurable: true, value: new FixtureStorage() });
window.fetch = async () =>
    new Response(JSON.stringify({ error: 'Follow-sheet fixture: network disabled.' }), { status: 503 });

const params = new URLSearchParams(location.search);
// Safe areas, as env() would resolve them on the phone this size stands for
// (test browsers report 0): ?safe=top,bottom in px.
const [safeTop, safeBottom] = (params.get('safe') ?? '0,0').split(',').map(Number);
const safe = document.createElement('style');
safe.textContent = `[data-follow-sheet-overlay] {
    padding-top: max(1rem, ${safeTop}px) !important;
    padding-bottom: calc(4rem + ${safeBottom}px + 1rem) !important;
}`;
document.head.append(safe);

const [{ FollowRoutePromptSheet }, { getAuthIdentityScope }] = await Promise.all([
    import('../../pages/log/FollowRoutePromptSheet'),
    import('../../services/authIdentityScope'),
]);
type SheetProps = React.ComponentProps<typeof FollowRoutePromptSheet>;
type Row = SheetProps['followPromptRows'][number];
type Status = Extract<Row, { type: 'choice' }>['row']['choice']['followStatus'];

const summary = (voyageId: string, nm: number, pts: number, from: [number, number], to: [number, number]) => ({
    voyageId,
    entryCount: pts,
    startedAt: '2026-09-20T08:00:00.000Z',
    endedAt: '2026-09-20T08:00:00.000Z',
    totalDistanceNM: nm,
    avgSpeedKts: 0,
    hasManual: false,
    isPlannedRoute: true,
    isImported: false,
    firstLat: from[0],
    firstLon: from[1],
    lastLat: to[0],
    lastLon: to[1],
    firstIsOnWater: true,
    landFraction: 0,
});

const choice = (
    voyageId: string,
    savedRouteId: string,
    legName: string,
    nm: number,
    pts: number,
    followStatus: Status,
    leg?: number,
): Row => ({
    type: 'choice',
    key: voyageId,
    row: {
        choice: {
            summary: summary(voyageId, nm, pts, [50.85, -1.31], [50.6, -2.45]),
            reversible: false,
            savedRouteId,
            followStatus,
            ...(leg ? { tripId: 'trip-solent', legOrdinal: leg, tripName: 'Hamble - Weymouth (Passage)' } : {}),
            legName,
        },
        kind: leg ? 'leg' : 'standalone',
        groupKey: leg ? 'trip-solent' : voyageId,
        legOrdinal: leg,
        stamp: 0,
    },
});

const rows: Row[] = [
    { type: 'passage', key: 'trip-solent', name: 'Hamble - Weymouth (Passage)' },
    choice(
        'v1',
        't1',
        'Hamble - Yarmouth',
        18.6,
        24,
        { tone: 'unchecked', code: 'aged', reason: 'Last checked 4 Sep' },
        1,
    ),
    choice(
        'v2',
        't2',
        'Yarmouth - Poole',
        21.3,
        41,
        { tone: 'unchecked', code: 'draft', reason: 'Checked at 2.10 m draft, now 2.40 m' },
        2,
    ),
    choice(
        'v3',
        't3',
        'Poole - Weymouth',
        27.9,
        33,
        { tone: 'finding', code: 'finding', reason: 'Pins 14→15: crosses charted land' },
        3,
    ),
    choice('v4', 't4', 'Antibes - Îles de Lérins', 6.2, 9, {
        tone: 'checked',
        code: 'ok',
        reason: null,
        checkedAt: '2026-10-03T09:00:00.000Z',
    }),
];

function Fixture() {
    const [open, setOpen] = useState(true);
    const [notice, setNotice] = useState<string | null>(
        params.has('notice') ? 'Pins 14→15: crosses charted land' : null,
    );
    const [loadingId, setLoadingId] = useState<string | null>(null);
    // ?prestart: the sheet as the slide opens it, before the voyage exists.
    const [preStart, setPreStart] = useState(params.has('prestart'));
    const [outcome, setOutcome] = useState('waiting');
    const dialogRef = useRef<HTMLDivElement>(null);
    const dismissRef = useRef<HTMLButtonElement>(null);
    const preStartAnswer = useRef<VoyageSummary | 'none' | null>(null);
    const startTracking = useRef(() => {});
    const checks = new Map<string, TraceCheckState>();
    if (params.has('checking')) checks.set('t2', { phase: 'checking', done: 12, total: 41 });
    return (
        <main className="h-dvh overflow-hidden bg-slate-950 p-4 text-white">
            {/* The Log page's header, as the app draws it. */}
            <header className="pt-[max(0.5rem,env(safe-area-inset-top))]">
                <h1 className="ui-page-title">Log</h1>
            </header>
            <output data-testid="outcome" className="mt-4 block text-sm text-slate-300">
                {outcome}
            </output>
            {/* The real tab bar's geometry (App.tsx): fixed, z-900, a 4rem row
                above the home-indicator inset, opaque. */}
            <nav
                aria-label="Main"
                className="fixed bottom-0 left-0 right-0 z-900 border-t pb-[env(safe-area-inset-bottom)]"
                style={{ background: 'rgb(10, 15, 20)', borderColor: 'rgba(56, 189, 248, 0.12)' }}
            >
                <div className="flex justify-around items-center h-16 mx-auto px-4 text-xs font-bold text-slate-300">
                    <span>THE GLASS</span>
                    <span>OBS</span>
                    <span className="text-sky-300">LOG</span>
                    <span>VESSEL</span>
                </div>
            </nav>
            {open && (
                <FollowRoutePromptSheet
                    dismissFollowPrompt={() => {
                        setOpen(false);
                        setOutcome('just recording');
                    }}
                    closeFollowPrompt={() => {
                        setOpen(false);
                        setOutcome('closed');
                    }}
                    followPromptDialogRef={dialogRef}
                    followPromptDismissRef={dismissRef}
                    followNotice={notice}
                    setFollowNotice={setNotice}
                    followPromptRows={rows}
                    openRouteInTracer={async (id) => setOutcome(`tracer ${id}`)}
                    checkStates={checks}
                    onCheckNow={(id) => setOutcome(`check ${id}`)}
                    onStopCheck={(id) => setOutcome(`stop ${id}`)}
                    canReview={() => false}
                    onReview={(id) => setOutcome(`review ${id}`)}
                    acceptFindingFor={(id) => setOutcome(`accepted ${id}`)}
                    fetchingRouteId={null}
                    followPromptLoadingId={loadingId}
                    setFollowPromptLoadingId={setLoadingId}
                    followPromptVoyageId="active-voyage"
                    identityScope={getAuthIdentityScope()}
                    preStartSheetOpen={preStart}
                    setPreStartSheetOpen={setPreStart}
                    preStartAnswerRef={preStartAnswer}
                    startTrackingVerifiedRef={startTracking}
                    applyFollowPick={async (s) => setOutcome(`follow ${s.voyageId}`)}
                />
            )}
        </main>
    );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
