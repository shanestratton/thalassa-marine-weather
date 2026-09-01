/**
 * EncCellManager — UI for importing & managing S-57 ENC vector
 * charts. Lives inside AvNavPage as a collapsible section beside
 * the existing raster Chart Locker.
 *
 * Two distinct things this UI does:
 *   1. Import a `.000` cell file from the user's device. The file
 *      is shipped to the boat's Pi for GDAL conversion, then the
 *      converted GeoJSON comes back to the device and gets indexed
 *      by EncHazardService. Routing immediately becomes ENC-aware
 *      for that area.
 *   2. List, inspect, and delete already-imported cells. Imported
 *      cells persist across app restarts (Capacitor Filesystem +
 *      localStorage metadata).
 *
 * UI states:
 *   - idle:     show import button + cell list
 *   - picking:  file picker is open (transient)
 *   - importing: progress bar + step label
 *   - done:     success flash → return to idle, list refreshed
 *   - error:    inline error banner under the import button
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/** Charts shown before the list asks permission to keep going. */
const CELL_PREVIEW_COUNT = 8;

import { triggerHaptic } from '../../utils/system';
import {
    pickEncFile,
    isLikelyEncFile,
    checkPiHasGdal,
    importEncCell,
    installEncFromUrl,
    syncEncFromPi,
    listPiInstalledCharts,
    encCellSyncKey,
    type EncImportProgress,
} from '../../services/EncImportService';
import { getCoverage as getEncCoverage, removeCell as removeEncCell } from '../../services/enc/EncHazardService';
import type { EncCell } from '../../services/enc/types';
import { CATZOC_LABELS, isLowConfidenceCatzoc } from '../../services/enc/types';
import { piCache } from '../../services/PiCacheService';
import { requestMapFit } from '../../stores/MapFitTargetStore';
import { useUI } from '../../context/UIContext';
import { ModalSheet } from '../ui/ModalSheet';
import { Button } from '../ui/Button';

// ── Helpers ────────────────────────────────────────────────────────

function formatBBox(bbox: [number, number, number, number]): string {
    const [minLon, minLat, maxLon, maxLat] = bbox;
    const lat = (n: number): string => `${Math.abs(n).toFixed(2)}°${n >= 0 ? 'N' : 'S'}`;
    const lon = (n: number): string => `${Math.abs(n).toFixed(2)}°${n >= 0 ? 'E' : 'W'}`;
    return `${lat(minLat)} ${lon(minLon)} → ${lat(maxLat)} ${lon(maxLon)}`;
}

function formatRelative(iso: string): string {
    const then = new Date(iso).getTime();
    if (!Number.isFinite(then)) return iso;
    const diffMs = Date.now() - then;
    const days = Math.floor(diffMs / (24 * 60 * 60 * 1000));
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 30) return `${days} days ago`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months} mo ago`;
    return `${Math.floor(days / 365)} yr ago`;
}

/**
 * Days since the hydrographic office issued this edition.
 * Hydrographic offices typically release weekly or monthly
 * updates, so anything older than ~90 days probably has newer
 * data the user could re-download.
 */
function daysSinceIssued(iso: string): number {
    const then = new Date(iso).getTime();
    if (!Number.isFinite(then)) return Number.POSITIVE_INFINITY;
    return Math.floor((Date.now() - then) / (24 * 60 * 60 * 1000));
}

function stalenessLabel(daysOld: number): { label: string; tone: 'fresh' | 'aging' | 'stale' } | null {
    if (daysOld <= 30) return { label: 'fresh', tone: 'fresh' };
    if (daysOld <= 90) return { label: `${Math.floor(daysOld / 30)} mo old`, tone: 'aging' };
    if (daysOld < 365) return { label: `${Math.floor(daysOld / 30)} mo old — check for updates`, tone: 'stale' };
    return { label: `${Math.floor(daysOld / 365)} yr old — check for updates`, tone: 'stale' };
}

// ── Subcomponents ─────────────────────────────────────────────────

const ImportProgressBar: React.FC<{ progress: EncImportProgress }> = ({ progress }) => {
    const colour =
        progress.phase === 'error' ? 'bg-red-500' : progress.phase === 'done' ? 'bg-emerald-400' : 'bg-sky-500';
    const label =
        progress.phase === 'reading'
            ? 'Reading file'
            : progress.phase === 'uploading'
              ? 'Uploading to Pi'
              : progress.phase === 'converting'
                ? 'Converting'
                : progress.phase === 'fetching'
                  ? 'Fetching result'
                  : progress.phase === 'storing'
                    ? 'Saving on device'
                    : progress.phase === 'done'
                      ? 'Done'
                      : 'Error';
    const pct = Math.max(0, Math.min(100, Math.round(progress.progress * 100)));
    return (
        <div className="space-y-1">
            <div className="flex items-center justify-between">
                <span className="text-[11px] uppercase tracking-wider font-bold text-gray-400">{label}</span>
                <span className="text-[11px] font-mono text-white/60">{pct}%</span>
            </div>
            <div className="w-full h-1.5 rounded-full bg-white/6 overflow-hidden">
                <div
                    className={`h-full rounded-full transition-all duration-300 ease-out ${colour}`}
                    style={{ width: `${pct}%` }}
                />
            </div>
            {progress.step && <p className="text-[11px] text-gray-500">{progress.step}</p>}
            {progress.error && <p className="text-[11px] text-red-400 mt-1">{progress.error}</p>}
        </div>
    );
};

const CellRow: React.FC<{
    cell: EncCell;
    onDelete: (cellId: string) => void;
    onShowOnMap: (cell: EncCell) => void;
    busy: boolean;
}> = ({ cell, onDelete, onShowOnMap, busy }) => {
    const [confirming, setConfirming] = useState(false);
    return (
        <div className="flex items-start gap-2 px-3 py-2 rounded-xl bg-white/2 border border-white/4">
            <button
                onClick={() => {
                    triggerHaptic('light');
                    onShowOnMap(cell);
                }}
                disabled={busy}
                className="hit-target-44 text-base shrink-0 mt-0.5 hover:scale-110 active:scale-95 transition-transform"
                title="Show coverage on map"
                aria-label={`Show ${cell.id} coverage on map`}
            >
                {'\u{1F5FA}'}
            </button>
            <div className="flex-1 min-w-0">
                <p className="text-xs font-bold text-white truncate">
                    {cell.id}
                    <span className="ml-2 text-[10px] text-sky-300 font-mono">{cell.sourceHO}</span>
                </p>
                <button
                    onClick={() => {
                        triggerHaptic('light');
                        onShowOnMap(cell);
                    }}
                    disabled={busy}
                    className="hit-target-44 text-[11px] text-gray-500 truncate hover:text-sky-300 active:scale-[0.99] transition-colors text-left w-full"
                    title="Show coverage on map"
                >
                    {formatBBox(cell.bbox)}
                </button>
                <p className="text-[11px] text-gray-400">
                    Edition {cell.edition} · Issued {cell.issued} · Imported {formatRelative(cell.importedAt)} ·{' '}
                    {cell.hazardCount.toLocaleString()} features
                </p>
                {cell.catzocRange && (
                    <p
                        className={`text-[11px] mt-0.5 ${
                            isLowConfidenceCatzoc(cell.catzocRange[1]) ? 'text-amber-400' : 'text-emerald-400'
                        }`}
                    >
                        {'⚡'} CATZOC {CATZOC_LABELS[cell.catzocRange[0]]}
                        {cell.catzocRange[0] !== cell.catzocRange[1] && `..${CATZOC_LABELS[cell.catzocRange[1]]}`}
                        {isLowConfidenceCatzoc(cell.catzocRange[1]) && ' — verify visually'}
                    </p>
                )}
                {(() => {
                    const days = daysSinceIssued(cell.issued);
                    const s = stalenessLabel(days);
                    if (!s || s.tone === 'fresh') return null;
                    const colour = s.tone === 'stale' ? 'text-amber-400' : 'text-gray-400';
                    return (
                        <p className={`text-[11px] mt-0.5 ${colour}`}>
                            {s.tone === 'stale' ? '⏱' : '·'} {s.label}
                        </p>
                    );
                })()}
            </div>
            {confirming ? (
                <div className="flex flex-col gap-1 shrink-0">
                    <button
                        onClick={() => {
                            triggerHaptic('heavy');
                            onDelete(cell.id);
                            setConfirming(false);
                        }}
                        disabled={busy}
                        className="min-h-[44px] px-2 py-1 rounded-md text-[10px] font-black uppercase tracking-wider bg-red-500/15 border border-red-500/30 text-red-400 hover:bg-red-500/25"
                    >
                        Delete
                    </button>
                    <button
                        onClick={() => {
                            triggerHaptic('light');
                            setConfirming(false);
                        }}
                        className="min-h-[44px] px-2 py-1 rounded-md text-[10px] uppercase tracking-wider bg-white/4 text-gray-400"
                    >
                        Cancel
                    </button>
                </div>
            ) : (
                <button
                    onClick={() => {
                        triggerHaptic('light');
                        setConfirming(true);
                    }}
                    disabled={busy}
                    className="hit-target-44 shrink-0 px-2 py-1 rounded-md text-[10px] font-black uppercase tracking-wider bg-white/4 hover:bg-white/8 text-gray-400"
                    title="Remove this cell from your device"
                >
                    Remove
                </button>
            )}
        </div>
    );
};

// ── Main component ────────────────────────────────────────────────

export const EncCellManager: React.FC = () => {
    const [expanded, setExpanded] = useState(false);
    /* The imported list is the one that ran long. The Pi picker below has been
       capped and filterable for a while; this had neither. */
    const [showAllCells, setShowAllCells] = useState(false);
    const [cells, setCells] = useState<EncCell[]>(() => getEncCoverage());
    const [progress, setProgress] = useState<EncImportProgress | null>(null);
    const [importing, setImporting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [lastSkipped, setLastSkipped] = useState<{ filename: string; error: string }[]>([]);
    const [urlDialogOpen, setUrlDialogOpen] = useState(false);
    const [urlInput, setUrlInput] = useState('');
    const [urlError, setUrlError] = useState<string | null>(null);
    const urlInstallInFlight = useRef(false);

    const refreshCells = useCallback(() => {
        setCells(getEncCoverage());
    }, []);

    useEffect(() => {
        if (expanded) refreshCells();
    }, [expanded, refreshCells]);

    const handleImport = useCallback(async () => {
        setError(null);
        setProgress(null);

        // Health check before opening picker — better UX to fail
        // fast than after the user has selected a file.
        const piErr = await checkPiHasGdal();
        if (piErr) {
            setError(piErr);
            return;
        }

        const file = await pickEncFile();
        if (!file) return;

        if (!isLikelyEncFile(file)) {
            setError(
                `"${file.name}" doesn't look like an S-57 ENC cell. ENC files end in .000 (or .001 for updates). If your charts are in OpenCPN's encrypted .oesenc format, those can't be used for routing — you'd need the raw S-57 cells from your hydrographic office.`,
            );
            return;
        }

        setImporting(true);
        setLastSkipped([]);
        try {
            const summary = await importEncCell(file, (p) => setProgress(p));
            refreshCells();
            if (summary.skipped.length > 0) setLastSkipped(summary.skipped);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setImporting(false);
            // Keep "done" progress on screen briefly, then clear.
            setTimeout(() => setProgress((p) => (p?.phase === 'done' ? null : p)), 2500);
        }
    }, [refreshCells]);

    const handleDelete = useCallback(
        async (cellId: string) => {
            try {
                await removeEncCell(cellId);
                refreshCells();
            } catch (err) {
                setError(`Failed to remove ${cellId}: ${err instanceof Error ? err.message : String(err)}`);
            }
        },
        [refreshCells],
    );

    const ui = useUI();

    /**
     * "Show on map" — stages a fit request for MapHub then
     * navigates to the map view. MapHub picks up the request when
     * its tab becomes active and frames the cell's bbox so the
     * user immediately sees their coverage area.
     */
    const handleShowOnMap = useCallback(
        (cell: EncCell) => {
            requestMapFit({
                bbox: cell.bbox,
                paddingPx: 80,
                maxZoom: 11,
                label: `cell ${cell.id}`,
            });
            ui.setPage('map');
        },
        [ui],
    );

    /**
     * "Install from URL" — Pi downloads the chart from a URL the
     * user pastes (typically a free NOAA ZIP), converts on the Pi,
     * and persists to its chart store. The phone then auto-syncs
     * the converted blob into the local cache.
     *
     * This is the "best of the best" flow — Pi has stable internet,
     * no iOS file-picker, and the resulting cells are available to
     * any device on the boat without re-uploading.
     */
    const openUrlInstallDialog = useCallback(() => {
        if (importing || urlInstallInFlight.current) return;
        setError(null);
        setProgress(null);
        setUrlInput('');
        setUrlError(null);
        setUrlDialogOpen(true);
    }, [importing]);

    /**
     * Fill the field from the clipboard.
     *
     * On a phone the link has just been copied out of a browser or an email, and
     * long-pressing a text box to find "Paste" is the fiddliest part of the whole
     * job. A clipboard read can be refused outright — Safari wants a gesture it
     * recognises, and a denied permission throws rather than returning empty — so
     * failure has to name the way round it rather than silently doing nothing.
     */
    const pasteFromClipboard = useCallback(async () => {
        try {
            const text = (await navigator.clipboard.readText()).trim();
            if (!text) {
                setUrlError('Clipboard is empty — copy the download link first.');
                return;
            }
            triggerHaptic('light');
            setUrlInput(text);
            setUrlError(null);
        } catch {
            setUrlError('Could not read the clipboard — long-press the box above and paste.');
        }
    }, []);

    const handleInstallFromUrl = useCallback(async () => {
        if (importing || urlInstallInFlight.current) return;
        const url = urlInput.trim();
        if (!url) {
            setUrlError('Paste a chart download link to continue.');
            return;
        }

        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch {
            setUrlError('That doesn’t look like a valid URL.');
            return;
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            setUrlError('Only http/https URLs are supported.');
            return;
        }

        urlInstallInFlight.current = true;
        setImporting(true);
        setLastSkipped([]);
        setUrlError(null);
        setProgress(null);
        try {
            const piErr = await checkPiHasGdal();
            if (piErr) {
                setUrlError(piErr);
                return;
            }
            const summary = await installEncFromUrl(url, undefined, (p) => setProgress(p));
            refreshCells();
            if (summary.skipped.length > 0) setLastSkipped(summary.skipped);
            setUrlDialogOpen(false);
            setUrlInput('');
        } catch (err) {
            setUrlError(err instanceof Error ? err.message : String(err));
        } finally {
            urlInstallInFlight.current = false;
            setImporting(false);
            setTimeout(() => setProgress((p) => (p?.phase === 'done' ? null : p)), 2500);
        }
    }, [importing, refreshCells, urlInput]);

    /**
     * "Sync from Pi" — pulls every chart the Pi has installed but
     * the phone doesn't, into the local cache. Uses edition equality
     * so re-runs are no-ops once everything is in sync.
     *
     * Run automatically on first expand of the panel — the user
     * shouldn't have to remember to tap a button to see what their
     * own boat already has.
     */
    const handleSyncFromPi = useCallback(async () => {
        setError(null);
        setProgress(null);

        const piErr = await checkPiHasGdal();
        if (piErr) {
            setError(piErr);
            return;
        }

        setImporting(true);
        setLastSkipped([]);
        try {
            const summary = await syncEncFromPi((p) => setProgress(p));
            refreshCells();
            if (summary.skipped.length > 0) setLastSkipped(summary.skipped);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setImporting(false);
            setTimeout(() => setProgress((p) => (p?.phase === 'done' ? null : p)), 2500);
        }
    }, [refreshCells]);

    // Pi-side installed-cell list. Fetched on every mount (NOT gated on
    // expanded) so we know up-front whether there are charts on the Pi
    // the user should sync — that lets us auto-expand the section and
    // surface the Sync button without making them tap blind. Cheap: one
    // small HTTP request, only when the Pi is reachable.
    //
    // We track each Pi cell's cellId AND edition because EncImportService
    // diffs on `cellId@edition`. A pure cellId match misses the case where
    // we regenerate the public-data pack with new layers / better
    // simplification — same name, newer content. Without edition awareness
    // the Sync button stays hidden and the device keeps running against
    // the stale local copy.
    // sourceHO and featureCount ride along so the per-chart picker below can
    // show which office issued a cell and roughly how big the pull is —
    // "FR466870" alone doesn't tell you it's Nouméa.
    const [piCellsSummary, setPiCellsSummary] = useState<
        { cellId: string; edition: number; sourceHO?: string; sizeBytes?: number }[] | null
    >(null);
    const [piListBusy, setPiListBusy] = useState(false);
    const refreshPiCells = useCallback(async () => {
        setPiListBusy(true);
        try {
            const piCells = await listPiInstalledCharts();
            setPiCellsSummary(
                piCells.map((c) => ({
                    cellId: c.cellId,
                    edition: c.edition ?? 0,
                    sourceHO: c.sourceHO,
                    sizeBytes: c.sizeBytes,
                })),
            );
        } catch (err) {
            // Surface it. An empty list and a broken list used to look
            // identical here, which is exactly how a rejected chart index hid
            // for a day behind "no cells imported yet".
            setPiCellsSummary(null);
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setPiListBusy(false);
        }
    }, []);

    // Re-list whenever the Pi becomes reachable, not just when LOCAL cells
    // change (Shane 2026-08-07: "no sync button in there").
    //
    // The old dependency was [cells.length]. Pairing does not change the local
    // cell count, so a device that listed the Pi BEFORE pairing — when the
    // identity gate correctly reported it unreachable and the listing came
    // back empty — never listed it again. piHasMoreThanLocal stayed false, the
    // Sync button is gated on that, and the entire Pi-sync path stayed
    // invisible with no way to retry. Pair, and the one affordance you need
    // was already gone.
    const [piReachable, setPiReachable] = useState(() => piCache.isAvailable());
    useEffect(() => {
        setPiReachable(piCache.isAvailable());
        return piCache.onStatusChange(() => setPiReachable(piCache.isAvailable()));
    }, []);
    useEffect(() => {
        void refreshPiCells();
    }, [cells.length, piReachable, refreshPiCells]);

    // Find Pi cells the device is either missing OR has at a stale
    // edition. Both count as "the user has something to sync".
    // encCellSyncKey is the SERVICE's definition of "already on this device",
    // shared rather than re-derived. This used to key on `cellId@edition`,
    // which silently disagreed with syncEncFromPi: a cell the Pi re-extracted
    // (same id, same chart edition, different bytes) read as already-held, so
    // the sheet claimed "Pi charts already in sync", the Sync button stayed
    // hidden, and the picker — gated on the same flag — was hidden too. The
    // improved charts were unreachable with the Pi sitting right there.
    const localCellKeys = useMemo(
        () => new Set(cells.map((c) => encCellSyncKey(c.id, c.edition ?? 0, c.sizeBytes))),
        [cells],
    );
    const missingOnDevice = useMemo(
        () =>
            (piCellsSummary ?? []).filter(
                ({ cellId, edition, sizeBytes }) => !localCellKeys.has(encCellSyncKey(cellId, edition, sizeBytes)),
            ),
        [piCellsSummary, localCellKeys],
    );
    const piHasMoreThanLocal = missingOnDevice.length > 0;

    // Per-chart pull. Auto-sync only fetches the 20 cells nearest the current
    // fix, so charts for a passage you haven't started yet are unreachable
    // without an uncapped sync of everything the Pi holds. This picker is the
    // targeted path: filter, tap, one cell.
    const [showPicker, setShowPicker] = useState(false);
    const [pickerFilter, setPickerFilter] = useState('');
    const [pullingCellId, setPullingCellId] = useState<string | null>(null);

    const pickerMatches = useMemo(() => {
        const q = pickerFilter.trim().toUpperCase();
        const matches = q ? missingOnDevice.filter((c) => c.cellId.toUpperCase().includes(q)) : missingOnDevice;
        // Cap the rendered rows — the Pi can hold 900+ cells and this list
        // lives inside a settings sheet. Filtering narrows it.
        return { rows: matches.slice(0, 40), total: matches.length };
    }, [missingOnDevice, pickerFilter]);

    const handleGetCell = useCallback(
        async (cellId: string) => {
            setError(null);
            setPullingCellId(cellId);
            try {
                await syncEncFromPi((p) => setProgress(p), { cellIds: [cellId] });
                refreshCells();
            } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
            } finally {
                setPullingCellId(null);
                setTimeout(() => setProgress((p) => (p?.phase === 'done' ? null : p)), 2500);
            }
        },
        [refreshCells],
    );

    /*
     * This used to auto-expand whenever the Pi held cells the phone did not,
     * to put the Sync button in front of the skipper. The intent was right and
     * the mechanism was wrong: it opened a list of every imported cell,
     * unasked, every time the page was opened — which is what made this
     * section feel like it scrolled forever (Shane 2026-08-28: "can we at
     * least roll them up into a heading card, so they do not endlessly
     * scroll").
     *
     * A summary line does that job without taking the screen: the collapsed
     * header now says how many charts are on the phone AND how many more the
     * Pi is holding, so there is something to act on without opening anything.
     */

    return (
        <>
            <div className="mb-3 p-4 rounded-2xl bg-white/3 border border-white/6">
                <button
                    onClick={() => {
                        triggerHaptic('light');
                        setExpanded(!expanded);
                    }}
                    className="w-full flex items-center gap-3"
                >
                    <span className="text-lg">{'\u{1F5FA}'}</span>
                    <div className="flex-1 text-left">
                        <p className="text-sm font-bold text-white">
                            ENC Charts{' '}
                            {/* "routing-grade vector" told a punter what the
                                data is; this tells them whether the card is
                                for them. Importing needs GDAL, which is on the
                                Pi and not on the phone. */}
                            <span className="text-[11px] text-sky-300 font-normal">(needs the Pi to import)</span>
                        </p>
                        <p className="text-[11px] text-gray-400">
                            {cells.length === 0
                                ? 'Paste a chart link — the Pi downloads and installs it'
                                : `${cells.length} chart${cells.length === 1 ? '' : 's'} on this phone` +
                                  (piHasMoreThanLocal ? ` · ${missingOnDevice.length} more on the Pi` : '')}
                        </p>
                    </div>
                    <svg
                        className={`w-4 h-4 text-gray-500 transition-transform ${expanded ? 'rotate-180' : ''}`}
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2}
                    >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                    </svg>
                </button>

                {expanded && (
                    <div className="mt-4 space-y-4">
                        {/* Paste-a-link is the whole point of having a Pi, so it is
                    the first thing in the card rather than something to find
                    below a paragraph about GDAL. The Pi downloads, converts and
                    shares with every device aboard; the phone-side upload below
                    is the fallback for a file you already have. */}
                        <div className="space-y-2">
                            {/* Primary action: Pi-direct URL install — the
                            "best of the best" path. Pi downloads, Pi
                            converts, all devices on the boat share. */}
                            <button
                                onClick={openUrlInstallDialog}
                                disabled={importing}
                                className={`w-full py-3 rounded-xl text-xs font-black uppercase tracking-widest transition-all active:scale-95 ${
                                    importing
                                        ? 'bg-amber-500/10 border border-amber-500/20 text-amber-400 cursor-not-allowed'
                                        : 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/25'
                                }`}
                            >
                                {importing && progress?.phase !== 'storing' && progress?.phase !== 'fetching' ? (
                                    <span className="flex items-center justify-center gap-2">
                                        <span className="w-3 h-3 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
                                        {progress?.cellCount && progress.cellCount > 1
                                            ? `Pi: ${progress.cellsDone ?? 0}/${progress.cellCount}...`
                                            : 'Pi installing...'}
                                    </span>
                                ) : (
                                    <span className="flex items-center justify-center gap-2">
                                        <span>{'\u{1F4E5}'}</span>
                                        <span>Install on Pi from URL</span>
                                    </span>
                                )}
                            </button>
                            <p className="text-[11px] text-gray-500 leading-relaxed">
                                Paste a chart download link and the Pi does the rest. Works for NOAA and other ENC
                                archives, o-charts sets, and ChartWorld S-63 (paste the exchange set and the permit
                                bundle, in either order).
                            </p>
                        </div>

                        {/* ── Import section ── */}
                        <div className="space-y-2">
                            <p className="text-[11px] font-bold uppercase tracking-widest text-white/40">
                                Import Cells
                            </p>
                            <p className="text-[11px] text-gray-500 leading-relaxed">
                                Pick a raw S-57 cell (<span className="font-mono text-sky-300">.000</span>) or a full
                                ENC <span className="font-mono text-sky-300">.zip</span> archive from your device. The
                                file is sent to your boat&apos;s Pi for conversion (GDAL does the heavy lifting), then
                                the converted vector data is stored on your phone and used by the routing validator
                                instead of GEBCO bathymetry — surveyed depths, coastlines, obstructions and wrecks
                                rather than 460&nbsp;m interpolated tiles.
                            </p>

                            {progress && (
                                <div className="px-3 py-2 rounded-xl bg-white/2 border border-white/4">
                                    <ImportProgressBar progress={progress} />
                                </div>
                            )}

                            {/* Secondary: phone-side upload, kept for cells
                            that aren't online (e.g. you have the .000
                            on your phone already from email/AirDrop). */}
                            <button
                                onClick={handleImport}
                                disabled={importing}
                                className={`w-full py-2.5 rounded-xl text-[11px] font-bold uppercase tracking-wider transition-all active:scale-95 ${
                                    importing
                                        ? 'bg-white/4 border border-white/6 text-gray-500 cursor-not-allowed'
                                        : 'bg-sky-500/10 border border-sky-500/20 text-sky-400 hover:bg-sky-500/20'
                                }`}
                            >
                                <span className="flex items-center justify-center gap-2">
                                    <span>{'\u{1F4F1}'}</span>
                                    <span>Upload from this device</span>
                                </span>
                            </button>

                            {/* Escape hatch when the Pi lists nothing.
                                Without this the entire Pi path is invisible
                                exactly when it has gone wrong — no button, no
                                message, nothing to press. Says which of the
                                two situations you are in, because "Pi has no
                                charts" and "the app cannot see the Pi" need
                                completely different fixes. */}
                            {!piHasMoreThanLocal && (
                                <button
                                    onClick={() => {
                                        triggerHaptic('light');
                                        void refreshPiCells();
                                    }}
                                    disabled={piListBusy}
                                    className="w-full py-2 rounded-xl text-[11px] font-bold uppercase tracking-wider bg-white/4 border border-white/8 text-white/60 hover:bg-white/8 active:scale-95 transition-all disabled:opacity-50"
                                >
                                    {piListBusy
                                        ? 'Checking Pi…'
                                        : piReachable
                                          ? (piCellsSummary?.length ?? 0) > 0
                                              ? 'Pi charts already in sync — check again'
                                              : 'Check Pi for charts'
                                          : 'Pi not connected — check again'}
                                </button>
                            )}

                            {/* Sync — surfaced when Pi has cellIds the device
                            doesn't (compared by ID, not by count, so stale
                            duplicate records on the device don't suppress
                            this button when there's actually new data to
                            pull). */}
                            {piHasMoreThanLocal && (
                                <button
                                    onClick={handleSyncFromPi}
                                    disabled={importing}
                                    className="w-full py-2 rounded-xl text-[11px] font-bold uppercase tracking-wider bg-amber-500/10 border border-amber-500/30 text-amber-300 hover:bg-amber-500/20 active:scale-95 transition-all"
                                >
                                    <span className="flex items-center justify-center gap-2">
                                        <span>{'\u{1F504}'}</span>
                                        <span>
                                            Sync {missingOnDevice.length} chart
                                            {missingOnDevice.length === 1 ? '' : 's'} from Pi
                                        </span>
                                    </span>
                                </button>
                            )}

                            {/* Targeted pull — see `showPicker` above. */}
                            {piHasMoreThanLocal && (
                                <>
                                    <button
                                        onClick={() => {
                                            triggerHaptic('light');
                                            setShowPicker((v) => !v);
                                        }}
                                        className="min-h-[44px] w-full py-1.5 text-[10px] font-semibold uppercase tracking-wider text-white/40 hover:text-white/70 transition-colors"
                                    >
                                        {showPicker ? 'Hide chart picker' : 'Or pick one chart…'}
                                    </button>

                                    {showPicker && (
                                        <div className="space-y-2">
                                            <input
                                                type="text"
                                                value={pickerFilter}
                                                onChange={(e) => setPickerFilter(e.target.value)}
                                                placeholder="Filter by cell id (e.g. FR46)"
                                                className="w-full px-3 py-2 rounded-xl bg-white/4 border border-white/8 text-[11px] text-white/80 placeholder:text-white/25 focus:outline-hidden focus:border-amber-500/40"
                                            />
                                            <div className="max-h-56 overflow-y-auto space-y-1">
                                                {pickerMatches.rows.map((c) => (
                                                    <div
                                                        key={`${c.cellId}@${c.edition}`}
                                                        className="flex items-center justify-between gap-2 px-3 py-2 rounded-xl bg-white/3 border border-white/6"
                                                    >
                                                        <div className="min-w-0">
                                                            <p className="font-mono text-[11px] text-white/80 truncate">
                                                                {c.cellId}
                                                            </p>
                                                            <p className="text-[10px] text-white/35">
                                                                {c.sourceHO ? `${c.sourceHO} · ` : ''}ed. {c.edition}
                                                                {c.sizeBytes
                                                                    ? ` · ${(c.sizeBytes / 1_048_576).toFixed(1)} MB`
                                                                    : ''}
                                                            </p>
                                                        </div>
                                                        <button
                                                            onClick={() => {
                                                                triggerHaptic('light');
                                                                void handleGetCell(c.cellId);
                                                            }}
                                                            disabled={importing || pullingCellId !== null}
                                                            className="hit-target-44 shrink-0 px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wider bg-amber-500/10 border border-amber-500/30 text-amber-300 hover:bg-amber-500/20 active:scale-95 disabled:opacity-40 transition-all"
                                                        >
                                                            {pullingCellId === c.cellId ? '…' : 'Get'}
                                                        </button>
                                                    </div>
                                                ))}
                                                {pickerMatches.total === 0 && (
                                                    <p className="px-3 py-2 text-[10px] text-white/35 italic">
                                                        No pending charts match that filter.
                                                    </p>
                                                )}
                                            </div>
                                            {pickerMatches.total > pickerMatches.rows.length && (
                                                <p className="text-[10px] text-white/30 italic">
                                                    Showing {pickerMatches.rows.length} of {pickerMatches.total} — type
                                                    to narrow.
                                                </p>
                                            )}
                                        </div>
                                    )}
                                </>
                            )}

                            {/* Charts follow the ACCOUNT, not just this device:
                                the Pi is unreachable from a browser ashore, so
                                without this the planner on the web can only ever
                                show the curated bucket. */}

                            {error && (
                                <div className="px-3 py-2 rounded-xl bg-red-500/6 border border-red-500/20">
                                    <p className="text-[11px] text-red-400 leading-relaxed">{error}</p>
                                </div>
                            )}

                            {lastSkipped.length > 0 && (
                                <div className="px-3 py-2 rounded-xl bg-amber-500/6 border border-amber-500/20">
                                    <p className="text-[11px] font-bold text-amber-300 mb-1">
                                        {lastSkipped.length} cell{lastSkipped.length === 1 ? '' : 's'} skipped during
                                        last import
                                    </p>
                                    <ul className="space-y-0.5">
                                        {lastSkipped.slice(0, 5).map((s) => (
                                            <li key={s.filename} className="text-[10px] text-amber-300/80">
                                                <span className="font-mono">{s.filename}</span>: {s.error}
                                            </li>
                                        ))}
                                        {lastSkipped.length > 5 && (
                                            <li className="text-[10px] text-amber-300/60 italic">
                                                …and {lastSkipped.length - 5} more
                                            </li>
                                        )}
                                    </ul>
                                </div>
                            )}
                        </div>

                        {/* ── Imported cells list ── */}
                        <div className="space-y-2">
                            <p className="text-[11px] font-bold uppercase tracking-widest text-white/40">
                                Charts on this phone
                            </p>
                            {cells.length === 0 ? (
                                <p className="text-[11px] text-gray-500 italic">
                                    No charts on this phone yet. Routing falls back to GEBCO bathymetry.
                                </p>
                            ) : (
                                <div className="space-y-2">
                                    {(showAllCells ? cells : cells.slice(0, CELL_PREVIEW_COUNT)).map((cell) => (
                                        <CellRow
                                            key={cell.id}
                                            cell={cell}
                                            onDelete={handleDelete}
                                            onShowOnMap={handleShowOnMap}
                                            busy={importing}
                                        />
                                    ))}
                                    {cells.length > CELL_PREVIEW_COUNT && (
                                        <button
                                            onClick={() => {
                                                triggerHaptic('light');
                                                setShowAllCells((v) => !v);
                                            }}
                                            className="w-full min-h-[44px] text-[11px] font-bold uppercase tracking-widest text-sky-300/90 hover:text-sky-200"
                                        >
                                            {showAllCells ? 'Show fewer' : `Show all ${cells.length} charts`}
                                        </button>
                                    )}
                                </div>
                            )}
                        </div>

                        {/* Where the charts actually are. Worth one plain
                            sentence: the Pi is a translator, not the place
                            your charts live, and a skipper whose Pi is ashore
                            should not be wondering whether their charts went
                            with it (Shane 2026-08-28). */}
                        <p className="text-[10px] text-gray-500 leading-relaxed px-1">
                            Your charts are stored on this phone and keep working with the Pi switched off. The Pi is
                            only used to convert a cell when you import one, and to hold spares you can pull down.
                        </p>

                        {/* ── Source attribution / honesty note ── */}
                        <div className="px-3 py-2 rounded-xl bg-white/2 border border-white/4">
                            <p className="text-[10px] text-gray-500 leading-relaxed">
                                <span className="text-amber-300 font-bold">Important:</span> ENCs improve accuracy where
                                you have them, but they aren&apos;t infallible. Pacific atolls have known position
                                errors of 100&ndash;500&nbsp;m in many cells. Always verify visually and cross-reference
                                paper/cruising-guide info before committing to a route. Source acknowledgement: cells
                                you import are the property of their issuing hydrographic office (AHO, NOAA, UKHO, etc.)
                                — Thalassa never uploads or redistributes them.
                            </p>
                        </div>
                    </div>
                )}
            </div>

            <ModalSheet
                isOpen={urlDialogOpen}
                onClose={() => {
                    if (urlInstallInFlight.current) return;
                    setUrlDialogOpen(false);
                    setUrlInput('');
                    setUrlError(null);
                }}
                title="Install ENC from URL"
                maxWidth="max-w-lg"
            >
                <form
                    className="space-y-4"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void handleInstallFromUrl();
                    }}
                >
                    <p className="text-xs leading-relaxed text-gray-300">
                        Paste a chart download link and the Pi does the rest — downloads it, unpacks it and installs it.
                        Works for an ENC ZIP or a single <span className="font-mono text-sky-300">.000</span> file, an
                        o-charts set, and ChartWorld S-63. For free NOAA charts, pick a cell at charts.noaa.gov and copy
                        its ZIP link.
                    </p>
                    <p className="text-xs leading-relaxed text-gray-400">
                        ChartWorld S-63 arrives in two parts and needs both: the exchange set from your order, and the
                        permit bundle from My Installations. Paste them one after the other — the order does not matter,
                        and the charts appear once both have landed.
                    </p>
                    <div>
                        <label
                            htmlFor="enc-install-url"
                            className="mb-2 block text-[11px] font-bold uppercase tracking-widest text-gray-400"
                        >
                            Chart URL
                        </label>
                        <input
                            id="enc-install-url"
                            type="url"
                            inputMode="url"
                            autoComplete="url"
                            autoCapitalize="none"
                            autoCorrect="off"
                            spellCheck={false}
                            autoFocus
                            maxLength={2048}
                            value={urlInput}
                            onChange={(event) => {
                                setUrlInput(event.target.value);
                                if (urlError) setUrlError(null);
                            }}
                            disabled={importing}
                            aria-invalid={urlError ? 'true' : 'false'}
                            aria-describedby={urlError ? 'enc-install-url-error' : 'enc-install-url-help'}
                            placeholder="https://example.gov/charts/cell.zip"
                            className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-3 text-sm text-white outline-hidden placeholder:text-gray-400 focus:border-sky-400 disabled:opacity-60"
                        />
                        <button
                            type="button"
                            onClick={() => void pasteFromClipboard()}
                            disabled={importing}
                            className="mt-2 w-full rounded-xl border border-sky-500/30 bg-sky-500/10 py-2.5 text-[11px] font-bold uppercase tracking-widest text-sky-300 transition-all active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            <span className="flex items-center justify-center gap-2">
                                <span>{'\u{1F4CB}'}</span>
                                <span>Paste link</span>
                            </span>
                        </button>
                        <p id="enc-install-url-help" className="mt-2 text-[11px] text-gray-500">
                            Only direct HTTP or HTTPS downloads are supported.
                        </p>
                        {urlError && (
                            <p
                                id="enc-install-url-error"
                                role="alert"
                                aria-live="assertive"
                                className="mt-2 rounded-lg border border-red-500/20 bg-red-500/8 px-3 py-2 text-xs text-red-300"
                            >
                                {urlError}
                            </p>
                        )}
                    </div>
                    <div className="flex gap-3">
                        <Button
                            variant="secondary"
                            type="button"
                            onClick={() => {
                                if (urlInstallInFlight.current) return;
                                setUrlDialogOpen(false);
                                setUrlInput('');
                                setUrlError(null);
                            }}
                            disabled={importing}
                            className="flex-1 text-gray-300 disabled:opacity-50"
                        >
                            Cancel
                        </Button>
                        <button
                            type="submit"
                            disabled={importing || !urlInput.trim()}
                            className="min-h-11 flex-1 rounded-xl border border-emerald-400/30 bg-emerald-500/20 px-4 py-3 text-sm font-black uppercase tracking-wider text-emerald-200 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            {importing ? 'Installing…' : 'Install on Pi'}
                        </button>
                    </div>
                </form>
            </ModalSheet>
        </>
    );
};

export default EncCellManager;
