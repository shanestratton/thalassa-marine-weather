import React, { Suspense, useEffect, useRef, useState } from 'react';
import { lazyRetry } from '../../utils/lazyRetry';
import { OverlayPortal } from '../ui/OverlayPortal';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { useSettingsStore } from '../../stores/settingsStore';
import { openExternalUrl } from '../../services/externalLinks';
import { chartsForPoint, chartCredit } from '../../services/weather/synopticCharts';
import {
    downloadSynopticChart,
    savedSynopticChart,
    type SavedSynopticChart,
} from '../../services/weather/synopticChartCache';

const MarineBulletinsSheet = lazyRetry(() => import('../weather/MarineBulletinsSheet'), 'MarineBulletinsSheet');

const clamp = (n: number) => Math.max(1, Math.min(6, n));
function ZoomChart({ src, title }: { src: string; title: string }) {
    const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
    const current = useRef(view);
    current.current = view;
    const pointers = useRef(new Map<number, { x: number; y: number }>());
    const start = useRef<{ scale: number; x: number; y: number; cx: number; cy: number; distance: number } | null>(
        null,
    );
    const begin = () => {
        const p = [...pointers.current.values()];
        if (!p.length) {
            start.current = null;
            return;
        }
        start.current = {
            ...current.current,
            cx: p.length === 2 ? (p[0].x + p[1].x) / 2 : p[0].x,
            cy: p.length === 2 ? (p[0].y + p[1].y) / 2 : p[0].y,
            distance: p.length === 2 ? Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) : 0,
        };
    };
    return (
        <>
            <div className="flex flex-wrap gap-2 py-2" role="group" aria-label="Chart zoom">
                <button
                    className="min-h-11 min-w-11 rounded-lg bg-white/10"
                    aria-label="Zoom out"
                    onClick={() => setView({ ...view, scale: clamp(view.scale / 1.5) })}
                >
                    −
                </button>
                <button
                    className="min-h-11 min-w-11 rounded-lg bg-white/10"
                    aria-label="Zoom in"
                    onClick={() => setView({ ...view, scale: clamp(view.scale * 1.5) })}
                >
                    +
                </button>
                <button
                    className="min-h-11 px-3 rounded-lg bg-white/10"
                    onClick={() => setView({ scale: 1, x: 0, y: 0 })}
                >
                    Fit chart
                </button>
                <span className="self-center text-xs text-slate-400">Pinch to zoom · drag to move</span>
            </div>
            <div
                role="region"
                aria-label="Official chart image"
                className="relative h-[min(52dvh,460px)] overflow-hidden rounded-xl bg-white"
                style={{ touchAction: 'none' }}
                onPointerDown={(event) => {
                    if (pointers.current.size >= 2) return;
                    const box = event.currentTarget.getBoundingClientRect();
                    pointers.current.set(event.pointerId, { x: event.clientX - box.left, y: event.clientY - box.top });
                    event.currentTarget.setPointerCapture?.(event.pointerId);
                    begin();
                }}
                onPointerMove={(event) => {
                    if (!pointers.current.has(event.pointerId) || !start.current) return;
                    const box = event.currentTarget.getBoundingClientRect();
                    pointers.current.set(event.pointerId, { x: event.clientX - box.left, y: event.clientY - box.top });
                    const p = [...pointers.current.values()];
                    const base = start.current;
                    const cx = p.length === 2 ? (p[0].x + p[1].x) / 2 : p[0].x;
                    const cy = p.length === 2 ? (p[0].y + p[1].y) / 2 : p[0].y;
                    const scale =
                        p.length === 2 && base.distance > 0
                            ? clamp((base.scale * Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y)) / base.distance)
                            : base.scale;
                    const ratio = scale / base.scale;
                    setView({ scale, x: cx - (base.cx - base.x) * ratio, y: cy - (base.cy - base.y) * ratio });
                }}
                onPointerUp={(event) => {
                    pointers.current.delete(event.pointerId);
                    begin();
                }}
                onPointerCancel={(event) => {
                    pointers.current.delete(event.pointerId);
                    begin();
                }}
            >
                <img
                    src={src}
                    alt={title}
                    draggable={false}
                    className="w-full h-full object-contain select-none"
                    style={{
                        transformOrigin: '0 0',
                        transform: `translate(${view.x}px,${view.y}px) scale(${view.scale})`,
                    }}
                />
            </div>
        </>
    );
}

export function SynopticChartSheet({
    point,
    onClose,
}: {
    point: { lat: number; lon: number } | null;
    onClose: () => void;
}) {
    const close = useRef<HTMLButtonElement>(null);
    const [marineOpen, setMarineOpen] = useState(false);
    const dialog = useFocusTrap<HTMLDivElement>(true, { initialFocusRef: close, onEscape: onClose });
    const charts = point ? chartsForPoint(point.lat, point.lon) : [];
    const [selected, setSelected] = useState(charts[0]?.id ?? '');
    const chart = charts.find((c) => c.id === selected) ?? charts[0];
    const chartId = chart?.id;
    const [saved, setSaved] = useState<SavedSynopticChart | null>(null);
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState('');
    const satellite = useSettingsStore((state) => state.settings.satelliteMode === true);
    const generation = useRef(0);
    useEffect(() => {
        const g = ++generation.current;
        setSaved(null);
        setNotice('');
        setBusy(false);
        if (chartId)
            void savedSynopticChart(chartId).then((entry) => {
                if (g === generation.current) setSaved(entry);
            });
        return () => {
            generation.current = g + 1;
        };
    }, [chartId]);
    const download = async () => {
        if (!chart) return;
        const g = generation.current;
        setBusy(true);
        setNotice('');
        try {
            const result = await downloadSynopticChart(chart, { explicit: true });
            if (g === generation.current) {
                setSaved(result.chart);
                setNotice(
                    result.offlineSaved ? 'Saved for offline use.' : 'Chart opened; offline saving was unavailable.',
                );
            }
        } catch {
            if (g === generation.current)
                setNotice('Download unavailable. Keep the saved chart or open the official source.');
        } finally {
            if (g === generation.current) setBusy(false);
        }
    };
    return (
        <>
            <OverlayPortal className="flex items-center justify-center bg-black/70 p-3" onClick={onClose}>
                <div
                    ref={dialog}
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="synoptic-title"
                    className="w-full max-w-3xl max-h-[94dvh] overflow-y-auto rounded-2xl border border-white/10 bg-slate-900 p-4 text-slate-100 shadow-2xl"
                    onClick={(e) => e.stopPropagation()}
                >
                    <div className="flex justify-between items-center gap-3">
                        <h2 id="synoptic-title" className="font-bold">
                            Official analysis charts
                        </h2>
                        <button
                            ref={close}
                            aria-label="Close official charts"
                            onClick={onClose}
                            className="min-h-11 min-w-11 rounded-lg bg-white/5"
                        >
                            ×
                        </button>
                    </div>
                    {!chart ? (
                        <p className="py-4 text-sm leading-relaxed">
                            {!point
                                ? 'A chart position is needed to choose an official source.'
                                : point.lat < -30
                                  ? 'No licence-free official chart is available here. Use the model isobars on the map.'
                                  : 'No reviewed official chart source covers this point. Use the model isobars on the map.'}{' '}
                            Model isobars are labelled forecasts; fronts are not computed.
                        </p>
                    ) : (
                        <>
                            <div
                                className="flex gap-2 overflow-x-auto py-2"
                                role="group"
                                aria-label="Official chart selection"
                            >
                                {charts.map((c) => (
                                    <button
                                        key={c.id}
                                        aria-pressed={c.id === chart.id}
                                        onClick={() => setSelected(c.id)}
                                        className={`min-h-11 shrink-0 rounded-lg border px-3 text-xs ${c.id === chart.id ? 'border-sky-400 bg-sky-500/15' : 'border-white/10 bg-white/5'}`}
                                    >
                                        {c.kind === 'analysis' ? 'Analysis' : `${c.leadHours} h forecast`}
                                    </button>
                                ))}
                            </div>
                            <p className="text-sm font-semibold">
                                {chart.title} · {chart.issuer}
                            </p>
                            <p className="mt-1 text-xs text-slate-300">
                                Valid time: read the time printed on the chart.
                            </p>
                            {saved && (
                                <p className="text-xs text-slate-400">
                                    Downloaded{' '}
                                    <time dateTime={new Date(saved.downloadedAt).toISOString()}>
                                        {new Date(saved.downloadedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC
                                    </time>{' '}
                                    · {Math.floor(Math.max(0, Date.now() - saved.downloadedAt) / 3600000)} h ago. This
                                    is the download age.
                                </p>
                            )}
                            {saved ? (
                                <ZoomChart
                                    key={`${chart.id}:${saved.downloadedAt}`}
                                    src={saved.dataUrl}
                                    title={chart.title}
                                />
                            ) : (
                                <p className="my-4 rounded-xl bg-white/5 p-4 text-sm text-slate-300">
                                    No chart saved. Download this chart before going offshore.
                                </p>
                            )}
                            {satellite && (
                                <p className="my-2 text-xs text-amber-200">
                                    Satellite Mode: charts never download automatically. The button below uses your
                                    connection.
                                </p>
                            )}
                            <button
                                disabled={busy}
                                onClick={() => void download()}
                                className="min-h-11 w-full rounded-xl border border-sky-400/30 bg-sky-500/15 px-3 py-2 text-sm font-semibold disabled:opacity-50"
                            >
                                {busy
                                    ? 'Downloading…'
                                    : `${saved ? 'Update saved chart' : 'Download chart'} · about ${chart.estimatedKb} KB`}
                            </button>
                            <p className="mt-1 text-xs text-slate-400">
                                One chart, maximum 2 MiB. Up to four charts saved within a 3 MiB cache.
                            </p>
                            {notice && (
                                <p role="status" className="my-2 text-sm text-amber-200">
                                    {notice}
                                </p>
                            )}
                            <p className="mt-3 text-xs text-slate-300">{chartCredit(chart)}</p>
                            <button
                                onClick={() => void openExternalUrl(chart.sourcePage)}
                                className="min-h-11 text-xs text-sky-300 underline underline-offset-2"
                            >
                                Open official source
                            </button>
                        </>
                    )}
                    <button
                        type="button"
                        onClick={() => setMarineOpen(true)}
                        className="mt-3 min-h-[44px] w-full rounded-xl border border-white/15 bg-white/5 px-3 text-sm font-semibold"
                    >
                        Marine weather bulletins
                    </button>
                </div>
            </OverlayPortal>
            {marineOpen && (
                <Suspense fallback={null}>
                    <MarineBulletinsSheet point={point} onClose={() => setMarineOpen(false)} />
                </Suspense>
            )}
        </>
    );
}
