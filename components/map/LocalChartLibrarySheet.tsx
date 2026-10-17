import React from 'react';
import { Capacitor } from '@capacitor/core';
import { ModalSheet } from '../ui/ModalSheet';
import {
    importLocalChart,
    listLocalCharts,
    removeLocalChart,
    subscribeLocalChartLibrary,
    type LocalChartListing,
} from '../../services/charts/localChartLibrary';
import { finishOpenedChart, peekOpenedChart, OPEN_CHART_EVENT } from '../../services/charts/openedChartQueue';
import { subscribeAuthIdentityScope } from '../../services/authIdentityScope';
import type { LocalChartRights } from '../../services/charts/localChartLibraryContract';

const button = 'min-h-[44px] rounded-lg border border-white/20 px-3 py-2 text-sm disabled:opacity-40';
export default function LocalChartLibrarySheet({
    onClose,
    activeId,
    onDisplay,
    onStop,
    status,
}: {
    onClose(): void;
    activeId: string | null;
    onDisplay(id: string): void;
    onStop(): void;
    status: string;
}) {
    const [charts, setCharts] = React.useState<LocalChartListing[]>([]);
    const [rights, setRights] = React.useState<LocalChartRights | ''>('');
    const [notice, setNotice] = React.useState(''),
        [busy, setBusy] = React.useState(false);
    const [revision, refresh] = React.useReducer((value: number) => value + 1, 0);
    const [attachment, setAttachment] = React.useState(peekOpenedChart);
    const mounted = React.useRef(false),
        sequence = React.useRef(0),
        pending = React.useRef<AbortController | null>(null);
    const input = React.useRef<HTMLInputElement>(null);
    React.useEffect(() => {
        mounted.current = true;
        const invalidate = () => {
            sequence.current++;
        };
        const unsubscribe = subscribeLocalChartLibrary(refresh);
        const attached = () => {
            setAttachment(peekOpenedChart());
            setRights('');
        };
        window.addEventListener(OPEN_CHART_EVENT, attached);
        const auth = subscribeAuthIdentityScope(() => {
            mounted.current = false;
            invalidate();
            pending.current?.abort();
            setCharts([]);
            setRights('');
            setAttachment(null);
            onClose();
        });
        return () => {
            mounted.current = false;
            invalidate();
            pending.current?.abort();
            unsubscribe();
            auth();
            window.removeEventListener(OPEN_CHART_EVENT, attached);
        };
    }, [onClose]);
    React.useEffect(() => {
        const token = ++sequence.current;
        void listLocalCharts({ isCurrent: () => mounted.current && sequence.current === token })
            .then((next) => {
                if (mounted.current && token === sequence.current) setCharts(next);
            })
            .catch((error: unknown) => {
                if (mounted.current && token === sequence.current) {
                    setCharts([]);
                    setNotice(error instanceof Error ? error.message : 'Saved charts unavailable.');
                }
            });
    }, [revision]);
    const run = async (action: (signal: AbortSignal) => Promise<void>) => {
        if (pending.current || !mounted.current) return;
        const controller = new AbortController();
        pending.current = controller;
        setBusy(true);
        setNotice('');
        try {
            await action(controller.signal);
        } catch (error) {
            if (mounted.current && !controller.signal.aborted)
                setNotice(error instanceof Error ? error.message : 'Local chart operation failed.');
        } finally {
            if (pending.current === controller) pending.current = null;
            if (mounted.current) {
                setBusy(false);
                refresh();
            }
        }
    };
    const save = (source: File | { url: string; name: string } | 'native-picker') => {
        if (!rights) return;
        if (attachment && source === attachment && peekOpenedChart()?.token !== attachment.token) {
            setAttachment(null);
            setRights('');
            setNotice('This opened attachment expired. Open it again from Files or Mail.');
            return;
        }
        void run(async (signal) => {
            await importLocalChart(source, rights, { signal, isCurrent: () => mounted.current });
            if (signal.aborted || !mounted.current) return;
            if (attachment) finishOpenedChart(attachment.token);
            setAttachment(null);
            setRights('');
            setNotice('Saved privately. Choose Display to open this chart.');
        });
    };
    const close = () => {
        pending.current?.abort();
        if (attachment) finishOpenedChart(attachment.token);
        onClose();
    };
    return (
        <ModalSheet
            isOpen
            onClose={close}
            title="Your local charts"
            maxWidth="max-w-lg"
            zIndex="z-10060"
            footer={
                <button className={`${button} w-full text-slate-100`} onClick={close}>
                    Done
                </button>
            }
        >
            <div className="min-w-0 space-y-4 text-sm text-slate-200">
                <p>
                    Keep only charts you made or charts with an open licence allowing this use. Licensed or encrypted
                    commercial charts stay on the boat’s Pi.
                </p>
                <p className="text-xs text-slate-400">
                    Private on this device. No cloud copy. Up to 8 files / 64 MiB in total; 32 MiB per file. Your
                    declaration and a filename do not verify the licence, chart contents, edition or datum. Browser
                    storage encoding overhead counts against the same quota.
                </p>
                <fieldset className="space-y-2" disabled={busy}>
                    <legend className="font-semibold">Before importing this file</legend>
                    {(
                        [
                            ['own', 'I created this chart and own the rights to its content.'],
                            ['open', 'This chart has an open licence permitting this use.'],
                        ] as const
                    ).map(([value, label]) => (
                        <label key={value} className="flex min-h-[44px] items-start gap-2 py-2">
                            <input
                                type="radio"
                                name="local-chart-rights"
                                value={value}
                                checked={rights === value}
                                onChange={() => setRights(value)}
                                className="mt-1 h-5 w-5 shrink-0"
                            />
                            <span>{label}</span>
                        </label>
                    ))}
                </fieldset>
                {attachment && (
                    <section className="space-y-2 rounded-lg border border-sky-600/50 p-3">
                        <p className="break-words">Opened attachment: {attachment.name}</p>
                        <button
                            className={`${button} w-full`}
                            disabled={!rights || busy}
                            onClick={() => save(attachment)}
                        >
                            Import this attachment
                        </button>
                    </section>
                )}
                <input
                    ref={input}
                    type="file"
                    accept=".mbtiles,.kap,.bsb,.tif,.tiff"
                    className="hidden"
                    aria-label="Choose local chart file"
                    onChange={(event) => {
                        const file = event.target.files?.[0];
                        event.target.value = '';
                        if (file) save(file);
                    }}
                />
                <button
                    className={`${button} w-full text-sky-200`}
                    disabled={!rights || busy}
                    onClick={() => (Capacitor.isNativePlatform() ? save('native-picker') : input.current?.click())}
                >
                    {busy ? 'Working…' : 'Import a chart file'}
                </button>
                <p className="text-xs text-slate-400">
                    MBTiles raster, KAP image (including satellite KAP), or supported GeoTIFF. A .bsb catalogue is not
                    an image: choose its .kap file. Unsupported projections and encodings report an error. KAP and
                    GeoTIFF source images are limited to 1024 × 1024 pixels; export larger charts as an MBTiles pyramid.
                </p>
                <p role="status" aria-live="polite" className="break-words text-amber-200">
                    {notice || status}
                </p>
                <section aria-label="Saved charts" className="space-y-2">
                    <h4 className="font-bold">Saved charts ({charts.length}/8)</h4>
                    {charts.length === 0 && (
                        <p className="text-slate-400">No admitted saved charts are listed for this account.</p>
                    )}
                    {charts.map((chart) => (
                        <article key={chart.id} className="space-y-2 rounded-xl border border-white/15 p-3">
                            <p className="break-words font-semibold">{chart.name}</p>
                            {chart.unavailable && (
                                <p className="text-xs text-amber-200">
                                    Saved copy {chart.unavailable === 'missing' ? 'is missing' : 'has changed'}. Remove
                                    this entry, then import the original again.
                                </p>
                            )}
                            <p className="text-xs text-slate-400">
                                {(chart.bytes / 1048576).toFixed(1)} MiB · {chart.kind.toUpperCase()} ·{' '}
                                {chart.rights === 'own' ? 'Your rights declaration' : 'Open licence declaration'}
                            </p>
                            <div className="grid grid-cols-2 gap-2">
                                <button
                                    className={button}
                                    disabled={busy || (!!chart.unavailable && activeId !== chart.id)}
                                    aria-pressed={activeId === chart.id}
                                    onClick={() => {
                                        setNotice('');
                                        if (activeId === chart.id) onStop();
                                        else onDisplay(chart.id);
                                    }}
                                >
                                    {activeId === chart.id ? 'Close chart' : 'Display'}
                                </button>
                                <button
                                    className={`${button} text-rose-200`}
                                    disabled={busy}
                                    onClick={() =>
                                        void run(async (signal) => {
                                            if (activeId === chart.id) onStop();
                                            await removeLocalChart(chart.id, {
                                                signal,
                                                isCurrent: () => mounted.current,
                                            });
                                            if (mounted.current && !signal.aborted)
                                                setNotice('Saved chart removed from this device.');
                                        })
                                    }
                                >
                                    Remove
                                </button>
                            </div>
                        </article>
                    ))}
                </section>
                <p className="text-xs text-slate-400">
                    Display overlays only. Imported chart pixels never supply routing depths, clearance, tides,
                    anchor-watch limits or alarms. Check the original chart and current official information.
                </p>
            </div>
        </ModalSheet>
    );
}
