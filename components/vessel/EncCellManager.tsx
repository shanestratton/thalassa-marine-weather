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

import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { triggerHaptic } from '../../utils/system';
import {
    pickEncFile,
    isLikelyEncFile,
    checkPiHasGdal,
    importEncCell,
    installEncFromUrl,
    syncEncFromPi,
    listPiInstalledCharts,
    type EncImportProgress,
} from '../../services/EncImportService';
import { getCoverage as getEncCoverage, removeCell as removeEncCell } from '../../services/enc/EncHazardService';
import type { EncCell } from '../../services/enc/types';
import { CATZOC_LABELS, isLowConfidenceCatzoc } from '../../services/enc/types';
import { requestMapFit } from '../../stores/MapFitTargetStore';
import { useUI } from '../../context/UIContext';

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
            <div className="w-full h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
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
        <div className="flex items-start gap-2 px-3 py-2 rounded-xl bg-white/[0.02] border border-white/[0.04]">
            <button
                onClick={() => {
                    triggerHaptic('light');
                    onShowOnMap(cell);
                }}
                disabled={busy}
                className="text-base shrink-0 mt-0.5 hover:scale-110 active:scale-95 transition-transform"
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
                    className="text-[11px] text-gray-500 truncate hover:text-sky-300 active:scale-[0.99] transition-colors text-left w-full"
                    title="Show coverage on map"
                >
                    {formatBBox(cell.bbox)}
                </button>
                <p className="text-[11px] text-gray-600">
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
                        className="px-2 py-1 rounded-md text-[10px] font-black uppercase tracking-wider bg-red-500/15 border border-red-500/30 text-red-400 hover:bg-red-500/25"
                    >
                        Delete
                    </button>
                    <button
                        onClick={() => {
                            triggerHaptic('light');
                            setConfirming(false);
                        }}
                        className="px-2 py-1 rounded-md text-[10px] uppercase tracking-wider bg-white/[0.04] text-gray-400"
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
                    className="shrink-0 px-2 py-1 rounded-md text-[10px] font-black uppercase tracking-wider bg-white/[0.04] hover:bg-white/[0.08] text-gray-400"
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
    const [cells, setCells] = useState<EncCell[]>(() => getEncCoverage());
    const [progress, setProgress] = useState<EncImportProgress | null>(null);
    const [importing, setImporting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [lastSkipped, setLastSkipped] = useState<{ filename: string; error: string }[]>([]);

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
    const handleInstallFromUrl = useCallback(async () => {
        setError(null);
        setProgress(null);

        const piErr = await checkPiHasGdal();
        if (piErr) {
            setError(piErr);
            return;
        }

        const url = window.prompt(
            'Paste the URL of an ENC ZIP or .000 file.\n\n' +
                'Free NOAA charts: https://charts.noaa.gov/ENCs/ENCs.shtml — pick a cell, copy the ZIP link.\n\n' +
                'AHO requires a commercial license; their public site has metadata but not direct downloads.',
            '',
        );
        if (!url) return;

        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch {
            setError('That doesn’t look like a valid URL.');
            return;
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            setError('Only http/https URLs are supported.');
            return;
        }

        setImporting(true);
        setLastSkipped([]);
        try {
            const summary = await installEncFromUrl(url, undefined, (p) => setProgress(p));
            refreshCells();
            if (summary.skipped.length > 0) setLastSkipped(summary.skipped);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setImporting(false);
            setTimeout(() => setProgress((p) => (p?.phase === 'done' ? null : p)), 2500);
        }
    }, [refreshCells]);

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
    const [piCellsSummary, setPiCellsSummary] = useState<{ cellId: string; edition: number }[] | null>(null);
    useEffect(() => {
        let cancelled = false;
        listPiInstalledCharts()
            .then((piCells) => {
                if (!cancelled) setPiCellsSummary(piCells.map((c) => ({ cellId: c.cellId, edition: c.edition ?? 0 })));
            })
            .catch(() => {
                if (!cancelled) setPiCellsSummary(null);
            });
        return () => {
            cancelled = true;
        };
    }, [cells.length]);

    // Find Pi cells the device is either missing OR has at a stale
    // edition. Both count as "the user has something to sync".
    const localCellKeys = useMemo(() => new Set(cells.map((c) => `${c.id}@${c.edition ?? 0}`)), [cells]);
    const missingOnDevice = useMemo(
        () => (piCellsSummary ?? []).filter(({ cellId, edition }) => !localCellKeys.has(`${cellId}@${edition}`)),
        [piCellsSummary, localCellKeys],
    );
    const piHasMoreThanLocal = missingOnDevice.length > 0;

    // Auto-expand when there are cells on the Pi the device doesn't
    // have yet — surfaces the Sync button immediately on page load
    // instead of burying it behind a tap.
    useEffect(() => {
        if (piHasMoreThanLocal && !expanded) {
            setExpanded(true);
        }
        // We intentionally only fire on piHasMoreThanLocal transitions,
        // not on every render — if the user explicitly collapses after
        // a sync, they get to keep it collapsed.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [piHasMoreThanLocal]);

    return (
        <div className="mb-3 p-4 rounded-2xl bg-white/[0.03] border border-white/[0.06]">
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
                        ENC Charts <span className="text-[11px] text-sky-300 font-normal">(routing-grade vector)</span>
                    </p>
                    <p className="text-[11px] text-gray-400">
                        {cells.length === 0
                            ? 'Import S-57 .000 cells from your hydrographic office'
                            : `${cells.length} cell${cells.length === 1 ? '' : 's'} imported · used by routing engine`}
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
                    {/* ── Import section ── */}
                    <div className="space-y-2">
                        <p className="text-[11px] font-bold uppercase tracking-widest text-white/40">Import Cells</p>
                        <p className="text-[11px] text-gray-500 leading-relaxed">
                            Pick a raw S-57 cell (<span className="font-mono text-sky-300">.000</span>) or a full ENC{' '}
                            <span className="font-mono text-sky-300">.zip</span> archive from your device. The file is
                            sent to your boat&apos;s Pi for conversion (GDAL does the heavy lifting), then the converted
                            vector data is stored on your phone and used by the routing validator instead of GEBCO
                            bathymetry — surveyed depths, coastlines, obstructions and wrecks rather than 460&nbsp;m
                            interpolated tiles.
                        </p>

                        {progress && (
                            <div className="px-3 py-2 rounded-xl bg-white/[0.02] border border-white/[0.04]">
                                <ImportProgressBar progress={progress} />
                            </div>
                        )}

                        {/* Primary action: Pi-direct URL install — the
                            "best of the best" path. Pi downloads, Pi
                            converts, all devices on the boat share. */}
                        <button
                            onClick={handleInstallFromUrl}
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

                        {/* Secondary: phone-side upload, kept for cells
                            that aren't online (e.g. you have the .000
                            on your phone already from email/AirDrop). */}
                        <button
                            onClick={handleImport}
                            disabled={importing}
                            className={`w-full py-2.5 rounded-xl text-[11px] font-bold uppercase tracking-wider transition-all active:scale-95 ${
                                importing
                                    ? 'bg-white/[0.04] border border-white/[0.06] text-gray-500 cursor-not-allowed'
                                    : 'bg-sky-500/10 border border-sky-500/20 text-sky-400 hover:bg-sky-500/20'
                            }`}
                        >
                            <span className="flex items-center justify-center gap-2">
                                <span>{'\u{1F4F1}'}</span>
                                <span>Upload from this device</span>
                            </span>
                        </button>

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

                        {error && (
                            <div className="px-3 py-2 rounded-xl bg-red-500/[0.06] border border-red-500/20">
                                <p className="text-[11px] text-red-400 leading-relaxed">{error}</p>
                            </div>
                        )}

                        {lastSkipped.length > 0 && (
                            <div className="px-3 py-2 rounded-xl bg-amber-500/[0.06] border border-amber-500/20">
                                <p className="text-[11px] font-bold text-amber-300 mb-1">
                                    {lastSkipped.length} cell{lastSkipped.length === 1 ? '' : 's'} skipped during last
                                    import
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
                        <p className="text-[11px] font-bold uppercase tracking-widest text-white/40">Imported Cells</p>
                        {cells.length === 0 ? (
                            <p className="text-[11px] text-gray-500 italic">
                                No cells imported yet. Routing falls back to GEBCO bathymetry.
                            </p>
                        ) : (
                            <div className="space-y-2">
                                {cells.map((cell) => (
                                    <CellRow
                                        key={cell.id}
                                        cell={cell}
                                        onDelete={handleDelete}
                                        onShowOnMap={handleShowOnMap}
                                        busy={importing}
                                    />
                                ))}
                            </div>
                        )}
                    </div>

                    {/* ── Source attribution / honesty note ── */}
                    <div className="px-3 py-2 rounded-xl bg-white/[0.02] border border-white/[0.04]">
                        <p className="text-[10px] text-gray-500 leading-relaxed">
                            <span className="text-amber-300 font-bold">Important:</span> ENCs improve accuracy where you
                            have them, but they aren&apos;t infallible. Pacific atolls have known position errors of
                            100&ndash;500&nbsp;m in many cells. Always verify visually and cross-reference
                            paper/cruising-guide info before committing to a route. Source acknowledgement: cells you
                            import are the property of their issuing hydrographic office (AHO, NOAA, UKHO, etc.) —
                            Thalassa never uploads or redistributes them.
                        </p>
                    </div>
                </div>
            )}
        </div>
    );
};

export default EncCellManager;
