import React, { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ModalSheet } from '../ui/ModalSheet';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
} from '../../services/authIdentityScope';
import { getPairing } from '../../services/PiPairingService';
import { loadPiTrackHistory, PiTrackHistoryError, type PiTrackHistory } from '../../services/piTrackHistory';
import {
    piTrackCsv,
    piTrackGpx,
    piTrackMapEntries,
    trackGraph,
    TRACK_GRAPH_FIELDS,
} from '../../services/piTrackReplay';
import { shareFileBlob } from '../../utils/sharePdf';

const TrackMapViewer = lazy(() => import('../TrackMapViewer').then((module) => ({ default: module.TrackMapViewer })));
const inputTime = (at: number) => new Date(at).toISOString().slice(0, 16);
const utc = (at: number) => new Date(at).toISOString().replace('T', ' ').replace('Z', ' UTC');
const button = 'min-h-11 rounded-lg border border-white/20 px-3 py-2 text-sm text-white disabled:opacity-40';

export default function PiTrackHistorySheet({
    onClose,
    lastMs,
    readHistory = loadPiTrackHistory,
}: {
    onClose: () => void;
    lastMs?: number | null;
    /** Composition seam for the presentation fixture; production uses only the pinned reader. */
    readHistory?: typeof loadPiTrackHistory;
}) {
    const scope = useRef(getAuthIdentityScope()).current;
    const pairing = useRef(getPairing()).current;
    const initialTo = useRef(
        Math.ceil(
            Math.min(
                typeof lastMs === 'number' && Number.isFinite(lastMs) && lastMs >= 0 ? lastMs : Date.now(),
                Date.now(),
            ) / 60_000,
        ) * 60_000,
    ).current;
    const [fromText, setFromText] = useState(inputTime(Math.max(0, initialTo - 86_400_000)));
    const [toText, setToText] = useState(inputTime(initialTo));
    const [data, setData] = useState<PiTrackHistory | null>(null);
    const [busy, setBusy] = useState(false),
        [error, setError] = useState<string | null>(null);
    const [map, setMap] = useState(false),
        [index, setIndex] = useState(0),
        [playing, setPlaying] = useState(false);
    const [sharing, setSharing] = useState(false),
        [notice, setNotice] = useState<string | null>(null);
    const controller = useRef<AbortController | null>(null),
        alive = useRef(true),
        started = useRef(false);
    const close = useRef(onClose);
    close.current = onClose;
    const current = useCallback(() => {
        const now = getPairing();
        return (
            alive.current &&
            isAuthIdentityScopeCurrent(scope) &&
            now?.publicKeySpki === pairing?.publicKeySpki &&
            now?.deviceId === pairing?.deviceId &&
            now?.pairedAt === pairing?.pairedAt
        );
    }, [scope, pairing]);
    const read = useCallback(
        async (cursor?: string) => {
            if (!current()) return;
            controller.current?.abort();
            const request = new AbortController();
            controller.current = request;
            setBusy(true);
            setError(null);
            setNotice(null);
            setData(null);
            setPlaying(false);
            setIndex(0);
            try {
                const from = Date.parse(fromText + ':00Z'),
                    to = Date.parse(toText + ':00Z');
                if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || from > to) {
                    setError('Choose a valid UTC track window.');
                    return;
                }
                const result = await readHistory({ from, to, cursor, signal: request.signal, isCurrent: current });
                if (current() && !request.signal.aborted) setData(result);
            } catch (cause) {
                if (current() && !request.signal.aborted)
                    setError(cause instanceof PiTrackHistoryError ? cause.message : 'Could not read the boat track.');
            } finally {
                if (current() && !request.signal.aborted) setBusy(false);
            }
        },
        [current, fromText, toText, readHistory],
    );
    useEffect(() => {
        alive.current = true;
        const fence = () => {
            if (current()) return;
            controller.current?.abort();
            setData(null);
            setMap(false);
            setPlaying(false);
            close.current();
        };
        const unsubscribe = subscribeAuthIdentityScope(fence);
        window.addEventListener('storage', fence);
        // Pairing has no React store; also fence changes made by native/other app surfaces.
        const timer = setInterval(fence, 250);
        return () => {
            alive.current = false;
            controller.current?.abort();
            unsubscribe();
            clearInterval(timer);
            window.removeEventListener('storage', fence);
        };
    }, [current]);
    useEffect(() => {
        if (!started.current) {
            started.current = true;
            void read();
        }
    }, [read]);
    useEffect(() => {
        if (!playing || map || !data?.points.length) return;
        const timer = setInterval(
            () =>
                setIndex((value) => {
                    if (value >= data.points.length - 1) {
                        setPlaying(false);
                        return value;
                    }
                    return value + 1;
                }),
            500,
        );
        return () => clearInterval(timer);
    }, [playing, map, data]);
    const graphs = useMemo(
        () => (data ? TRACK_GRAPH_FIELDS.map((field) => ({ ...field, ...trackGraph(data, field.key) })) : []),
        [data],
    );
    const entries = useMemo(() => (data ? piTrackMapEntries(data) : []), [data]);
    const selected = data?.points[index];
    const edited = data && (Date.parse(fromText + ':00Z') !== data.from || Date.parse(toText + ':00Z') !== data.to);
    const share = async (format: 'csv' | 'gpx') => {
        if (!data || sharing || !current()) return;
        setSharing(true);
        setNotice(null);
        try {
            const text = format === 'csv' ? piTrackCsv(data) : piTrackGpx(data);
            const mime = format === 'csv' ? 'text/csv;charset=utf-8' : 'application/gpx+xml';
            const name = `boat-track-${new Date(data.from).toISOString().slice(0, 10)}-${data.truncated ? 'partial-' : ''}${data.points[0]?.sample_id ?? 'empty'}-${Date.now()}.${format}`;
            if (!current()) return;
            const outcome = await shareFileBlob(new Blob([text], { type: mime }), name, 'Boat track window', mime);
            if (current() && outcome === 'downloaded') setNotice('Track file downloaded.');
        } catch {
            if (current()) setNotice('Could not share the track file.');
        } finally {
            if (current()) setSharing(false);
        }
    };
    return (
        <>
            <ModalSheet isOpen onClose={onClose} title="Boat track history" zIndex="z-1000">
                <p className="text-sm text-white/70">
                    Private copies from your paired Pi. Values recorded by the boat, without forecast substitutions.
                    Nothing is uploaded.
                </p>
                <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <label className="min-w-0 text-xs text-white/70">
                        From (UTC)
                        <input
                            type="datetime-local"
                            aria-label="Track from UTC"
                            value={fromText}
                            onChange={(event) => setFromText(event.target.value)}
                            className="mt-1 block min-h-11 w-full min-w-0 rounded-lg border border-white/20 bg-slate-800 p-2 text-sm text-white"
                        />
                    </label>
                    <label className="min-w-0 text-xs text-white/70">
                        To (UTC)
                        <input
                            type="datetime-local"
                            aria-label="Track to UTC"
                            value={toText}
                            onChange={(event) => setToText(event.target.value)}
                            className="mt-1 block min-h-11 w-full min-w-0 rounded-lg border border-white/20 bg-slate-800 p-2 text-sm text-white"
                        />
                    </label>
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                    <button className={button} disabled={busy} onClick={() => void read()}>
                        Load window
                    </button>
                    {busy && (
                        <button
                            className={button}
                            onClick={() => {
                                controller.current?.abort();
                                setBusy(false);
                                setNotice('Read cancelled; no track loaded.');
                            }}
                        >
                            Cancel read
                        </button>
                    )}
                </div>
                {busy && (
                    <p role="status" className="mt-3 text-sm text-white/70">
                        Reading the paired Pi...
                    </p>
                )}
                {error && (
                    <p role="alert" className="mt-3 text-sm text-amber-300">
                        {error}
                    </p>
                )}
                {data && (
                    <div className="mt-4 space-y-3">
                        <p className="break-words text-xs text-white/70">
                            {utc(data.from)} to {utc(data.to)}. {data.points.length.toLocaleString()} loaded fixes.
                        </p>
                        {data.truncated && (
                            <div
                                role="status"
                                className="rounded-lg border border-amber-500/40 p-2 text-sm text-amber-200"
                            >
                                Partial window: other fixes are not included in this view or its exports. Choose a
                                shorter window{data.nextCursor ? ' or load the next bounded batch.' : '.'}
                                {data.nextCursor && (
                                    <button
                                        className={button + ' mt-2 w-full'}
                                        disabled={busy || !!edited}
                                        onClick={() => void read(data.nextCursor!)}
                                    >
                                        Load remaining batch
                                    </button>
                                )}
                            </div>
                        )}
                        {edited && (
                            <p className="text-xs text-amber-200">
                                Window edited. Press Load window; the displayed data and exports still describe the
                                loaded window.
                            </p>
                        )}
                        {!data.points.length ? (
                            <p className="text-sm text-white/70">
                                No fixes were loaded for this window. This does not say whether recording is on.
                            </p>
                        ) : (
                            <>
                                <p className="text-xs text-white/60">
                                    Missing measurements stay blank. Graphs and GPX break at gaps over five minutes; no
                                    interpolation fills them.
                                </p>
                                <div className="flex flex-wrap gap-2">
                                    <button className={button} onClick={() => setPlaying(!playing)}>
                                        {playing ? 'Pause replay' : 'Replay fixes'}
                                    </button>
                                    <button
                                        className={button}
                                        onClick={(event) => {
                                            if (current()) {
                                                event.currentTarget.focus({ preventScroll: true });
                                                setMap(true);
                                                setPlaying(false);
                                            }
                                        }}
                                    >
                                        View track map
                                    </button>
                                </div>
                                <label className="block text-xs text-white/70">
                                    Recorded fix {index + 1} of {data.points.length}
                                    <input
                                        type="range"
                                        min="0"
                                        max={Math.max(0, data.points.length - 1)}
                                        value={index}
                                        aria-label="Recorded track fix"
                                        onChange={(event) => {
                                            setIndex(Number(event.target.value));
                                            setPlaying(false);
                                        }}
                                        className="block min-h-11 w-full"
                                    />
                                </label>
                                {selected && (
                                    <p
                                        data-testid="track-selected-time"
                                        className="break-words text-xs font-mono text-white"
                                    >
                                        {utc(selected.at_ms)}
                                    </p>
                                )}
                                {graphs.map((graph) => (
                                    <figure key={graph.key} className="min-w-0 rounded-lg border border-white/10 p-2">
                                        <figcaption className="flex flex-wrap justify-between gap-1 text-xs text-white/80">
                                            <span>
                                                {graph.label} ({graph.unit})
                                            </span>
                                            <span>
                                                {selected?.[graph.key] == null
                                                    ? 'Unknown'
                                                    : selected[graph.key]!.toFixed(1)}
                                            </span>
                                        </figcaption>
                                        {graph.count ? (
                                            <>
                                                <svg
                                                    viewBox="0 0 280 72"
                                                    role="img"
                                                    aria-label={`${graph.label}: ${graph.minimum!.toFixed(1)} to ${graph.maximum!.toFixed(1)} ${graph.unit}, ${graph.count} measurements`}
                                                    className="block h-20 w-full"
                                                >
                                                    {graph.paths.map((path, key) => (
                                                        <path
                                                            key={key}
                                                            d={path}
                                                            fill="none"
                                                            stroke="#38bdf8"
                                                            strokeWidth="1.5"
                                                            strokeLinecap="round"
                                                        />
                                                    ))}
                                                    {selected && (
                                                        <line
                                                            x1={
                                                                4 +
                                                                (272 * (selected.at_ms - data.from)) /
                                                                    Math.max(1, data.to - data.from)
                                                            }
                                                            x2={
                                                                4 +
                                                                (272 * (selected.at_ms - data.from)) /
                                                                    Math.max(1, data.to - data.from)
                                                            }
                                                            y1="4"
                                                            y2="68"
                                                            stroke="#fbbf24"
                                                        />
                                                    )}
                                                </svg>
                                                <p className="text-[11px] text-white/50">
                                                    {graph.minimum!.toFixed(1)} to {graph.maximum!.toFixed(1)}{' '}
                                                    {graph.unit}
                                                </p>
                                            </>
                                        ) : (
                                            <p className="py-4 text-xs text-white/50">No recorded measurements</p>
                                        )}
                                    </figure>
                                ))}
                                <p className="text-xs text-white/60">
                                    The local position plot uses no chart imagery or network. Lines stop at gaps over
                                    five minutes; recorded fixes do not prove where the boat went between them.
                                </p>
                                <div className="flex flex-wrap gap-2">
                                    <button className={button} disabled={sharing} onClick={() => void share('csv')}>
                                        Export CSV
                                    </button>
                                    <button className={button} disabled={sharing} onClick={() => void share('gpx')}>
                                        Export GPX
                                    </button>
                                </div>
                            </>
                        )}
                    </div>
                )}
                {notice && (
                    <p role="status" className="mt-3 text-sm text-white/70">
                        {notice}
                    </p>
                )}
            </ModalSheet>
            {map && data && current() && (
                <Suspense fallback={<p role="status">Opening local track map...</p>}>
                    <TrackMapViewer
                        isOpen
                        onClose={() => setMap(false)}
                        entries={entries}
                        privateReplay
                        partialReplay={data.truncated}
                    />
                </Suspense>
            )}
        </>
    );
}
