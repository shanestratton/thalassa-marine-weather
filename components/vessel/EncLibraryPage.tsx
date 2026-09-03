import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
    importLocalEncPackFile,
    importLocalEncPackUrl,
    pickLocalEncPackFile,
    validateLocalEncPackUrl,
    type LocalEncPackProgress,
} from '../../services/enc/localEncPackImport';
import {
    getDisplayCoverage as getEncCoverage,
    removeCell as removeEncCell,
    subscribe as subscribeToEnc,
} from '../../services/enc/EncHazardService';
import type { EncCell } from '../../services/enc/types';
import { CATZOC_LABELS, isLowConfidenceCatzoc } from '../../services/enc/types';
import { PI_PUBLIC_BETA_UNAVAILABLE_MESSAGE } from '../../services/piPublicBetaBoundary';
import { requestMapFit } from '../../stores/MapFitTargetStore';
import { triggerHaptic } from '../../utils/system';
import { Button } from '../ui/Button';
import { ModalSheet } from '../ui/ModalSheet';
import { PageHeader } from '../ui/PageHeader';

interface EncLibraryPageProps {
    onBack: () => void;
    onOpenMap: () => void;
}

function getReferenceCoverage(): EncCell[] {
    return getEncCoverage().filter((cell) => cell.usage === 'reference');
}

function formatBBox([west, south, east, north]: [number, number, number, number]): string {
    const lat = (value: number): string => `${Math.abs(value).toFixed(2)}°${value >= 0 ? 'N' : 'S'}`;
    const lon = (value: number): string => `${Math.abs(value).toFixed(2)}°${value >= 0 ? 'E' : 'W'}`;
    return `${lat(south)} ${lon(west)} → ${lat(north)} ${lon(east)}`;
}

function issuedAgeLabel(issued: string): { text: string; stale: boolean } {
    const time = Date.parse(`${issued}T00:00:00Z`);
    if (!Number.isFinite(time)) return { text: 'issue date unavailable', stale: true };
    const days = Math.max(0, Math.floor((Date.now() - time) / 86_400_000));
    if (days < 31) return { text: 'issued this month', stale: false };
    if (days < 365) return { text: `issued ${Math.floor(days / 30)} months ago`, stale: days > 90 };
    const years = Math.floor(days / 365);
    return { text: `issued ${years} year${years === 1 ? '' : 's'} ago`, stale: true };
}

const EncLibraryCellRow: React.FC<{
    cell: EncCell;
    busy: boolean;
    onShow: (cell: EncCell) => void;
    onRemove: (cellId: string) => Promise<void>;
}> = ({ cell, busy, onShow, onRemove }) => {
    const [confirming, setConfirming] = useState(false);
    const age = issuedAgeLabel(cell.issued);
    return (
        <li className="rounded-2xl border border-white/[0.07] bg-white/[0.035] p-3">
            <div className="flex items-start gap-3">
                <button
                    type="button"
                    onClick={() => onShow(cell)}
                    disabled={busy}
                    className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-xl bg-sky-500/10 text-lg transition-colors hover:bg-sky-500/20 disabled:opacity-50"
                    aria-label={`Show ${cell.id} reference coverage on the chart`}
                >
                    {'\u{1F5FA}'}
                </button>
                <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-black text-white">
                        {cell.id}{' '}
                        <span className="ml-1 font-mono text-[10px] font-bold text-sky-300">
                            pack claims {cell.sourceHO}
                        </span>
                    </p>
                    <p className="mt-0.5 text-[11px] leading-snug text-gray-300">{formatBBox(cell.bbox)}</p>
                    <p className={`mt-1 text-[11px] ${age.stale ? 'text-amber-300' : 'text-gray-400'}`}>
                        Pack claims edition {cell.edition} · {age.text} · {cell.hazardCount.toLocaleString()} chart
                        features
                    </p>
                    {cell.catzocRange ? (
                        <p
                            className={`mt-1 text-[11px] ${
                                isLowConfidenceCatzoc(cell.catzocRange[1]) ? 'text-amber-300' : 'text-emerald-300'
                            }`}
                        >
                            Pack claims CATZOC {CATZOC_LABELS[cell.catzocRange[0]]}
                            {cell.catzocRange[0] === cell.catzocRange[1]
                                ? ''
                                : `–${CATZOC_LABELS[cell.catzocRange[1]]}`}
                            {isLowConfidenceCatzoc(cell.catzocRange[1]) ? ' · low/unassessed confidence' : ''}
                        </p>
                    ) : (
                        <p className="mt-1 text-[11px] text-amber-300">
                            CATZOC unavailable · survey quality unverified
                        </p>
                    )}
                </div>
                <div className="shrink-0">
                    {confirming ? (
                        <div className="flex flex-col gap-1">
                            <button
                                type="button"
                                disabled={busy}
                                onClick={() => void onRemove(cell.id).then(() => setConfirming(false))}
                                className="min-h-11 rounded-xl border border-red-400/30 bg-red-500/15 px-3 text-[10px] font-black uppercase tracking-wider text-red-300 disabled:opacity-50"
                                aria-label={`Confirm removal of ${cell.id}`}
                            >
                                Remove
                            </button>
                            <button
                                type="button"
                                onClick={() => setConfirming(false)}
                                className="min-h-11 rounded-xl px-3 text-[10px] font-bold uppercase tracking-wider text-gray-300"
                            >
                                Cancel
                            </button>
                        </div>
                    ) : (
                        <button
                            type="button"
                            disabled={busy}
                            onClick={() => {
                                triggerHaptic('light');
                                setConfirming(true);
                            }}
                            className="min-h-11 rounded-xl border border-white/10 bg-white/5 px-3 text-[10px] font-bold uppercase tracking-wider text-gray-300 disabled:opacity-50"
                            aria-label={`Remove ${cell.id} from this device`}
                        >
                            Remove
                        </button>
                    )}
                </div>
            </div>
        </li>
    );
};

function ImportProgress({ progress }: { progress: LocalEncPackProgress }) {
    const percent = Math.round(progress.progress * 100);
    return (
        <div className="rounded-xl border border-sky-400/20 bg-sky-500/[0.07] p-3" role="status" aria-live="polite">
            <div className="flex items-center justify-between gap-3 text-[11px] font-bold text-sky-200">
                <span>{progress.step}</span>
                <span className="font-mono">{percent}%</span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10">
                <div className="h-full rounded-full bg-sky-400 transition-[width]" style={{ width: `${percent}%` }} />
            </div>
        </div>
    );
}

/**
 * Production ENC library. Deliberately imports no Pi service and exposes no
 * discovery, pairing, sync or GDAL controls.
 */
/* One reader for both the first frame and every refresh. Seeding the state
   unsorted meant the first paint listed cells in storage order and the mount
   effect immediately re-read the coverage to re-sort it. */
function readSortedReferenceCoverage(): EncCell[] {
    return [...getReferenceCoverage()].sort((a, b) => a.id.localeCompare(b.id));
}

export const EncLibraryPage: React.FC<EncLibraryPageProps> = ({ onBack, onOpenMap }) => {
    const [cells, setCells] = useState<EncCell[]>(readSortedReferenceCoverage);
    const [busy, setBusy] = useState(false);
    const [progress, setProgress] = useState<LocalEncPackProgress | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);
    const [skipped, setSkipped] = useState<Array<{ filename: string; error: string }>>([]);
    const [query, setQuery] = useState('');
    const [urlOpen, setUrlOpen] = useState(false);
    const [url, setUrl] = useState('');
    const [urlError, setUrlError] = useState<string | null>(null);
    const inFlight = useRef(false);

    const refresh = useCallback(() => setCells(readSortedReferenceCoverage()), []);
    useEffect(() => {
        refresh();
        return subscribeToEnc(refresh);
    }, [refresh]);

    const begin = useCallback(() => {
        if (inFlight.current) return false;
        inFlight.current = true;
        setBusy(true);
        setError(null);
        setSuccess(null);
        setSkipped([]);
        setProgress(null);
        return true;
    }, []);

    const finish = useCallback(() => {
        inFlight.current = false;
        setBusy(false);
    }, []);

    const handleFile = useCallback(async () => {
        const file = await pickLocalEncPackFile();
        if (!file || !begin()) return;
        try {
            const result = await importLocalEncPackFile(file, setProgress);
            setSkipped(result.skipped);
            setSuccess(
                `${result.cells.length} unverified reference ENC cell${result.cells.length === 1 ? '' : 's'} imported to this device.`,
            );
            refresh();
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            finish();
        }
    }, [begin, finish, refresh]);

    const handleUrl = useCallback(async () => {
        if (!begin()) return;
        try {
            validateLocalEncPackUrl(url);
            const result = await importLocalEncPackUrl(url, setProgress);
            setSkipped(result.skipped);
            setSuccess(
                `${result.cells.length} unverified reference ENC cell${result.cells.length === 1 ? '' : 's'} imported to this device.`,
            );
            setUrlOpen(false);
            setUrl('');
            refresh();
        } catch (caught) {
            const message = caught instanceof Error ? caught.message : String(caught);
            setUrlError(message);
        } finally {
            finish();
        }
    }, [begin, finish, refresh, url]);

    const handleRemove = useCallback(
        async (cellId: string) => {
            if (!begin()) return;
            try {
                await removeEncCell(cellId);
                setSuccess(`${cellId} removed from this device.`);
                refresh();
            } catch (caught) {
                setError(`Could not remove ${cellId}: ${caught instanceof Error ? caught.message : String(caught)}`);
            } finally {
                finish();
            }
        },
        [begin, finish, refresh],
    );

    const showOnMap = useCallback(
        (cell: EncCell) => {
            triggerHaptic('light');
            requestMapFit({ bbox: cell.bbox, paddingPx: 80, maxZoom: 11, label: `ENC cell ${cell.id}` });
            onOpenMap();
        },
        [onOpenMap],
    );

    const visibleCells = useMemo(() => {
        const needle = query.trim().toUpperCase();
        if (!needle) return cells;
        return cells.filter((cell) => `${cell.id} ${cell.sourceHO}`.toUpperCase().includes(needle));
    }, [cells, query]);

    return (
        <div className="flex h-full w-full flex-col bg-slate-950 slide-up-enter">
            <PageHeader title="ENC Library" subtitle="Unverified reference overlays" onBack={onBack} />
            <main className="flex-1 overflow-y-auto px-4 pb-[calc(2rem+env(safe-area-inset-bottom))]">
                <div className="mx-auto max-w-2xl space-y-4">
                    <section
                        className="rounded-2xl border border-amber-400/30 bg-amber-500/10 p-4"
                        aria-labelledby="enc-inventory-heading"
                    >
                        <h2 id="enc-inventory-heading" className="text-sm font-black text-white">
                            {cells.length === 0
                                ? 'No reference ENC cells are installed'
                                : `${cells.length} reference ENC cell${cells.length === 1 ? '' : 's'} available`}
                        </h2>
                        <p className="mt-1 text-xs leading-relaxed text-gray-200">
                            {cells.length === 0
                                ? 'The chart will mark depths as unverified. Bathymetry estimates and satellite imagery are not ENC coverage.'
                                : 'These unsigned packs can be viewed as references, but are ignored by route checks and Cast Off because Thalassa cannot verify their publisher or authenticity.'}
                        </p>
                    </section>

                    <section
                        className="rounded-2xl border border-white/8 bg-white/[0.035] p-4"
                        aria-labelledby="enc-import-heading"
                    >
                        <h2 id="enc-import-heading" className="text-sm font-black text-white">
                            Import a converted ENC pack
                        </h2>
                        <p className="mt-1 text-xs leading-relaxed text-gray-300">
                            Choose a <span className="font-mono text-sky-300">.thalassaenc</span>,{' '}
                            <span className="font-mono text-sky-300">.json</span> or{' '}
                            <span className="font-mono text-sky-300">.geojson</span> pack in Thalassa&apos;s converted
                            ENC format. Files stay on this device. An HTTPS URL is fetched directly to this device and
                            is not uploaded to Thalassa. Imported packs remain unverified reference overlays. Packs are
                            limited to 16 MB on mobile; split a larger converted set into smaller files.
                        </p>
                        <div className="mt-3 grid gap-2 sm:grid-cols-2">
                            <button
                                type="button"
                                disabled={busy}
                                onClick={() => {
                                    triggerHaptic('light');
                                    void handleFile();
                                }}
                                className="min-h-12 rounded-xl border border-sky-400/30 bg-sky-500/15 px-4 text-xs font-black uppercase tracking-wider text-sky-200 transition-colors hover:bg-sky-500/25 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                Import from Files
                            </button>
                            <button
                                type="button"
                                disabled={busy}
                                onClick={() => {
                                    triggerHaptic('light');
                                    setUrlError(null);
                                    setUrlOpen(true);
                                }}
                                className="min-h-12 rounded-xl border border-emerald-400/30 bg-emerald-500/15 px-4 text-xs font-black uppercase tracking-wider text-emerald-200 transition-colors hover:bg-emerald-500/25 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                Import from HTTPS URL
                            </button>
                        </div>
                        <div className="mt-3 rounded-xl border border-amber-400/20 bg-amber-500/[0.07] p-3 text-[11px] leading-relaxed text-amber-100/85">
                            <p>
                                <strong>Raw/encrypted charts are different:</strong> this beta cannot decode S-57{' '}
                                <span className="font-mono">.000/.zip</span>, S-63{' '}
                                <span className="font-mono">.es57</span> or o-charts files on-device. Keep encrypted
                                charts in their licensed reader. Converting or importing a pack does not grant, transfer
                                or extend chart rights.
                            </p>
                        </div>
                    </section>

                    {progress && <ImportProgress progress={progress} />}
                    {error && (
                        <div
                            role="alert"
                            aria-live="assertive"
                            className="rounded-xl border border-red-400/25 bg-red-500/10 p-3 text-xs text-red-200"
                        >
                            {error}
                        </div>
                    )}
                    {success && (
                        <div
                            role="status"
                            aria-live="polite"
                            className="rounded-xl border border-emerald-400/25 bg-emerald-500/10 p-3 text-xs text-emerald-200"
                        >
                            {success}
                        </div>
                    )}
                    {skipped.length > 0 && (
                        <div
                            role="alert"
                            className="rounded-xl border border-amber-400/25 bg-amber-500/10 p-3 text-xs text-amber-100"
                        >
                            <p className="font-bold">
                                {skipped.length} source cell{skipped.length === 1 ? '' : 's'} did not convert in this
                                pack:
                            </p>
                            <ul className="mt-1 list-disc space-y-1 pl-5">
                                {skipped.slice(0, 10).map((item) => (
                                    <li key={`${item.filename}:${item.error}`}>
                                        {item.filename}: {item.error}
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}

                    <section
                        className="rounded-2xl border border-white/8 bg-white/2.5 p-4"
                        aria-labelledby="enc-cells-heading"
                    >
                        <div className="flex items-center justify-between gap-3">
                            <h2 id="enc-cells-heading" className="text-sm font-black text-white">
                                Reference overlays
                            </h2>
                            <span className="text-[11px] font-bold text-gray-400">{visibleCells.length} shown</span>
                        </div>
                        {cells.length > 8 && (
                            <label className="mt-3 block text-[11px] font-bold text-gray-300">
                                Filter cells
                                <input
                                    type="search"
                                    value={query}
                                    onChange={(event) => setQuery(event.target.value)}
                                    placeholder="Cell ID or office"
                                    className="mt-1 min-h-11 w-full rounded-xl border border-white/10 bg-slate-900 px-3 text-sm text-white outline-hidden placeholder:text-gray-500 focus:border-sky-400"
                                />
                            </label>
                        )}
                        {visibleCells.length === 0 ? (
                            <p className="mt-3 text-xs italic text-gray-400">
                                {cells.length === 0
                                    ? 'Import a converted pack to add an unverified reference overlay.'
                                    : 'No cells match this filter.'}
                            </p>
                        ) : (
                            <ul className="mt-3 space-y-2">
                                {visibleCells.map((cell) => (
                                    <EncLibraryCellRow
                                        key={cell.id}
                                        cell={cell}
                                        busy={busy}
                                        onShow={showOnMap}
                                        onRemove={handleRemove}
                                    />
                                ))}
                            </ul>
                        )}
                    </section>

                    <section
                        className="rounded-2xl border border-amber-400/20 bg-amber-500/6 p-4 text-[11px] leading-relaxed text-gray-300"
                        aria-labelledby="enc-safety-heading"
                    >
                        <h2 id="enc-safety-heading" className="font-black text-amber-200">
                            Navigation and licensing limits
                        </h2>
                        <p className="mt-1">
                            Thalassa cannot authenticate the publisher or contents of a file/URL pack. It is painted as
                            an unverified reference and ignored by route verification, hazards and Cast Off. Thalassa is
                            not an ECDIS; imported data may be old, incomplete, low-confidence or incorrectly converted.
                            Check edition and updates, CATZOC, official notices, the original licensed chart and what
                            you can see before navigating. Remote-island positions can be displaced by hundreds of
                            metres. Never treat an empty or pale map area as safe water.
                        </p>
                        <p className="mt-2 text-gray-400">
                            Pi discovery and sync stay separate from this library. {PI_PUBLIC_BETA_UNAVAILABLE_MESSAGE}
                        </p>
                    </section>
                </div>
            </main>

            <ModalSheet
                isOpen={urlOpen}
                onClose={() => {
                    if (inFlight.current) return;
                    setUrlOpen(false);
                    setUrl('');
                    setUrlError(null);
                }}
                title="Import ENC pack from URL"
                maxWidth="max-w-lg"
            >
                <form
                    className="space-y-4"
                    onSubmit={(event) => {
                        event.preventDefault();
                        setUrlError(null);
                        void handleUrl();
                    }}
                >
                    <p id="enc-pack-url-help" className="text-xs leading-relaxed text-gray-300">
                        Paste a direct HTTPS link that returns a converted Thalassa ENC JSON pack. It will remain an
                        unverified reference overlay. Web servers must allow the download; sign-in pages and raw chart
                        ZIPs are not pack URLs.
                    </p>
                    <div>
                        <label
                            htmlFor="enc-pack-url"
                            className="mb-1 block text-[11px] font-black uppercase tracking-wider text-gray-300"
                        >
                            Direct HTTPS URL
                        </label>
                        <input
                            id="enc-pack-url"
                            type="url"
                            inputMode="url"
                            autoComplete="url"
                            autoCapitalize="none"
                            autoCorrect="off"
                            spellCheck={false}
                            value={url}
                            onChange={(event) => {
                                setUrl(event.target.value);
                                setUrlError(null);
                            }}
                            disabled={busy}
                            maxLength={2048}
                            aria-invalid={urlError ? 'true' : 'false'}
                            aria-describedby={urlError ? 'enc-pack-url-error enc-pack-url-help' : 'enc-pack-url-help'}
                            placeholder="https://charts.example/my-pack.thalassaenc"
                            className="min-h-12 w-full rounded-xl border border-white/10 bg-white/5 px-3 text-sm text-white outline-hidden placeholder:text-gray-500 focus:border-sky-400 disabled:opacity-50"
                        />
                        {urlError && (
                            <p
                                id="enc-pack-url-error"
                                role="alert"
                                aria-live="assertive"
                                className="mt-2 rounded-xl border border-red-400/25 bg-red-500/10 p-3 text-xs text-red-200"
                            >
                                {urlError}
                            </p>
                        )}
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                        <Button
                            type="button"
                            disabled={busy}
                            onClick={() => {
                                setUrlOpen(false);
                                setUrl('');
                                setUrlError(null);
                            }}
                            className="text-gray-200 disabled:opacity-50"
                        >
                            Cancel
                        </Button>
                        <button
                            type="submit"
                            disabled={busy || !url.trim()}
                            className="min-h-12 rounded-xl border border-emerald-400/30 bg-emerald-500/20 px-4 text-sm font-black text-emerald-100 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            {busy ? 'Importing…' : 'Import to device'}
                        </button>
                    </div>
                </form>
            </ModalSheet>
        </div>
    );
};

export default EncLibraryPage;
