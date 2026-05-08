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

import React, { useCallback, useEffect, useState } from 'react';

import { triggerHaptic } from '../../utils/system';
import {
    pickEncFile,
    isLikelyEncFile,
    checkPiHasGdal,
    importEncCell,
    type EncImportProgress,
} from '../../services/EncImportService';
import { getCoverage as getEncCoverage, removeCell as removeEncCell } from '../../services/enc/EncHazardService';
import type { EncCell } from '../../services/enc/types';
import { CATZOC_LABELS, isLowConfidenceCatzoc } from '../../services/enc/types';

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
    busy: boolean;
}> = ({ cell, onDelete, busy }) => {
    const [confirming, setConfirming] = useState(false);
    return (
        <div className="flex items-start gap-2 px-3 py-2 rounded-xl bg-white/[0.02] border border-white/[0.04]">
            <span className="text-base shrink-0 mt-0.5">{'\u{1F5FA}'}</span>
            <div className="flex-1 min-w-0">
                <p className="text-xs font-bold text-white truncate">
                    {cell.id}
                    <span className="ml-2 text-[10px] text-sky-300 font-mono">{cell.sourceHO}</span>
                </p>
                <p className="text-[11px] text-gray-500 truncate" title={formatBBox(cell.bbox)}>
                    {formatBBox(cell.bbox)}
                </p>
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

                        <button
                            onClick={handleImport}
                            disabled={importing}
                            className={`w-full py-3 rounded-xl text-xs font-black uppercase tracking-widest transition-all active:scale-95 ${
                                importing
                                    ? 'bg-amber-500/10 border border-amber-500/20 text-amber-400 cursor-not-allowed'
                                    : 'bg-sky-500/15 border border-sky-500/30 text-sky-400 hover:bg-sky-500/25'
                            }`}
                        >
                            {importing ? (
                                <span className="flex items-center justify-center gap-2">
                                    <span className="w-3 h-3 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
                                    {progress?.cellCount && progress.cellCount > 1
                                        ? `Importing ${progress.cellsDone ?? 0}/${progress.cellCount}...`
                                        : 'Importing...'}
                                </span>
                            ) : (
                                'Pick S-57 Cell (.000) or ENC .zip'
                            )}
                        </button>

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
                                    <CellRow key={cell.id} cell={cell} onDelete={handleDelete} busy={importing} />
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
