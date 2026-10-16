import React from 'react';
import { ModalSheet } from '../ui/ModalSheet';
import {
    chartFindSelectionCurrent,
    findChartObjects,
    readDownloadedChartFind,
    subscribeChartFindAccess,
    type ChartFindBounds,
} from '../../services/enc/chartFind';
import { subscribeAuthIdentityScope } from '../../services/authIdentityScope';
import type { ChartFindResult } from '../../services/enc/chartFindMemory';
const Agreement = React.lazy(() => import('./NoaaAgreementSheet'));
const button = 'min-h-[44px] rounded-lg border border-white/20 px-3 py-2 text-sm disabled:opacity-40';
export interface ChartFindSheetProps {
    onClose: () => void;
    bounds: ChartFindBounds | null;
    onFly: (result: ChartFindResult) => void;
}
export default function ChartFindSheet({ onClose, bounds, onFly }: ChartFindSheetProps) {
    const [query, setQuery] = React.useState('');
    const [view, setView] = React.useState<Awaited<ReturnType<typeof findChartObjects>>>(null);
    const [notice, setNotice] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const [agreement, setAgreement] = React.useState(false);
    const [revision, refresh] = React.useReducer((n: number) => n + 1, 0);
    const mounted = React.useRef(false),
        sequence = React.useRef(0),
        pending = React.useRef<AbortController | null>(null);
    React.useEffect(() => {
        mounted.current = true;
        const invalidate = () => {
            sequence.current++;
        };
        const unsubscribe = subscribeChartFindAccess(() => {
            invalidate();
            setView(null);
            refresh();
        });
        const auth = subscribeAuthIdentityScope(() => {
            invalidate();
            pending.current?.abort();
            setView(null);
            onClose();
        });
        return () => {
            mounted.current = false;
            invalidate();
            pending.current?.abort();
            unsubscribe();
            auth();
        };
    }, [onClose]);
    React.useEffect(() => {
        const seq = ++sequence.current;
        void findChartObjects(query)
            .then((next) => {
                if (mounted.current && sequence.current === seq) setView(next);
            })
            .catch(() => {
                if (mounted.current && sequence.current === seq) {
                    setView(null);
                    setNotice('Chart search is unavailable.');
                }
            });
    }, [query, revision]);
    async function read() {
        pending.current?.abort();
        const controller = new AbortController();
        pending.current = controller;
        setBusy(true);
        setNotice('');
        try {
            const result = await readDownloadedChartFind(bounds, {
                signal: controller.signal,
                isCurrent: () => mounted.current,
            });
            if (!mounted.current || controller.signal.aborted) return;
            setNotice(
                `${result.read} downloaded cell${result.read === 1 ? '' : 's'} read. ${result.unavailable ? `${result.unavailable} unavailable. ` : ''}${result.limited ? 'Partial area: zoom in and read again.' : ''}`,
            );
            refresh();
        } catch (error) {
            if (mounted.current && !controller.signal.aborted)
                setNotice(error instanceof Error ? error.message : 'Downloaded charts unavailable.');
        } finally {
            if (mounted.current && pending.current === controller) setBusy(false);
        }
    }
    async function select(result: ChartFindResult) {
        const seq = sequence.current;
        if (await chartFindSelectionCurrent(result)) {
            if (mounted.current && seq === sequence.current) onFly(result);
        } else if (mounted.current) {
            setNotice('That chart result is no longer available.');
            refresh();
        }
    }
    return (
        <>
            <ModalSheet
                isOpen
                onClose={onClose}
                title="Find on chart"
                maxWidth="max-w-lg"
                zIndex="z-10060"
                fitViewport
                footer={
                    <button type="button" className={`${button} w-full text-slate-100`} onClick={onClose}>
                        Done
                    </button>
                }
            >
                <div className="min-w-0 space-y-3 text-sm text-slate-200">
                    <label className="block">
                        Light character, mark or place
                        <input
                            className="mt-1 block min-h-[44px] w-full min-w-0 rounded-lg border border-white/25 bg-slate-900 px-3 text-base"
                            type="search"
                            autoComplete="off"
                            spellCheck={false}
                            maxLength={80}
                            value={query}
                            placeholder="Fl.G 3s · buoy · bay name"
                            onChange={(event) => setQuery(event.target.value)}
                        />
                    </label>
                    {view && (
                        <p className="text-xs">
                            {view.cells} loaded cell{view.cells === 1 ? '' : 's'} searchable.{' '}
                            {view.limited ? 'Partial index / first 20 matches; narrow the search.' : ''}
                        </p>
                    )}
                    {query.trim() && view && !view.matches.length && (
                        <p role="status">
                            No match in the available chart portions. This does not prove the object is absent.
                        </p>
                    )}
                    <ul className="space-y-2" aria-label="Chart matches">
                        {view?.matches.map((result) => (
                            <li key={result.key}>
                                <button
                                    type="button"
                                    className={`${button} w-full min-w-0 text-left`}
                                    onClick={() => void select(result)}
                                >
                                    <b className="block break-words" dir="auto">
                                        {result.name}
                                    </b>
                                    {result.character && <span className="block break-words">{result.character}</span>}
                                    <span className="block break-words text-xs text-slate-400">
                                        {result.kind} · {result.cellId} ·{' '}
                                        {result.licence === 'open' ? 'NOAA derived' : 'Licensed · aboard only'} · Find
                                    </span>
                                </button>
                            </li>
                        ))}
                    </ul>
                    {view?.consent === false ? (
                        <button
                            className={`${button} w-full`}
                            type="button"
                            onClick={(event) => {
                                event.currentTarget.focus({ preventScroll: true });
                                setAgreement(true);
                            }}
                        >
                            Read NOAA agreement
                        </button>
                    ) : (
                        <button
                            className={`${button} w-full`}
                            type="button"
                            disabled={busy || !view}
                            onClick={() => void read()}
                        >
                            Read downloaded NOAA around view
                        </button>
                    )}
                    {busy && (
                        <button
                            type="button"
                            className={`${button} w-full`}
                            onClick={() => {
                                pending.current?.abort();
                                setBusy(false);
                                setNotice('Local chart read cancelled.');
                            }}
                        >
                            Cancel read
                        </button>
                    )}
                    <p className="text-xs text-slate-400">
                        Downloaded NOAA works offline, including Satellite Mode. This button reads up to four local
                        cells and downloads nothing. Licensed charts are available only on the paired boat LAN.
                    </p>
                    {notice && (
                        <p role="status" className="break-words text-amber-100">
                            {notice}
                        </p>
                    )}
                    <p className="text-xs text-slate-400">
                        Find moves the camera to a chart label location. It does not create a route or verify safe
                        water. NOAA-derived display is not official ENC or a certified navigation system.{' '}
                        <a
                            className="text-sky-300 underline"
                            href="https://charts.noaa.gov/ENCs/"
                            target="_blank"
                            rel="noopener noreferrer"
                        >
                            NOAA source
                        </a>
                    </p>
                </div>
            </ModalSheet>
            <React.Suspense fallback={null}>
                {agreement && (
                    <Agreement
                        onClose={() => setAgreement(false)}
                        onAccepted={() => {
                            setAgreement(false);
                            refresh();
                        }}
                    />
                )}
            </React.Suspense>
        </>
    );
}
