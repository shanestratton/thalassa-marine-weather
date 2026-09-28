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
    listRecentEncInstalls,
    resumeEncInstall,
    encCellSyncKey,
    type EncImportProgress,
    type EncImportSummary,
    type EncInstallReceipt,
} from '../../services/EncImportService';
import { getCoverage as getEncCoverage, removeCell as removeEncCell } from '../../services/enc/EncHazardService';
import type { EncCell } from '../../services/enc/types';
import { CATZOC_LABELS, isLowConfidenceCatzoc } from '../../services/enc/types';
import { piCache } from '../../services/PiCacheService';
import { requestMapFit } from '../../stores/MapFitTargetStore';
import { useUI } from '../../context/UIContext';
import { ModalSheet } from '../ui/ModalSheet';
import { Button } from '../ui/Button';
import {
    ENC_DELIVERY_MAX_TEXT,
    parseEncChartDelivery,
    type EncChartDeliveryPackage,
} from '../../services/encChartDelivery';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent } from '../../services/authIdentityScope';
import { getPairing } from '../../services/PiPairingService';

// ── Helpers ────────────────────────────────────────────────────────

interface DeliveryInstall {
    package: EncChartDeliveryPackage;
    status: 'queued' | 'installing' | 'complete' | 'failed' | 'phone-pending' | 'pi-pending';
    message: string;
    jobId?: string;
}

/** Service/provider text can contain signed URLs. Never render it in this flow. */
function deliveryFailure(error: unknown): string {
    const message = error instanceof Error ? error.message : '';
    if (/checksum|sha.?256/i.test(message))
        return 'The package checksum did not match. Copy the latest delivery email and try again.';
    if (/expir|\b40[13]\b|forbidden/i.test(message))
        return 'The download link may have expired. Copy a fresh delivery email and try again.';
    if (/licen[cs]e|decrypt|key file/i.test(message))
        return 'The Pi could not unlock this chart package. Check its chart licence and try again.';
    return 'This package could not finish. Check your boat Wi-Fi and Pi connection, then retry.';
}

function deliveryProgress(progress: EncImportProgress): EncImportProgress {
    return {
        phase: progress.phase,
        progress: Number.isFinite(progress.progress) ? progress.progress : 0,
        step:
            progress.phase === 'done'
                ? 'Package processed; checking phone availability.'
                : 'The Pi is processing this package.',
    };
}

function packageCounts(value: EncImportSummary['packageSummary']): string | undefined {
    if (
        !value ||
        ![value.new, value.updated, value.unchanged, value.total].every(
            (count) => Number.isSafeInteger(count) && count >= 0 && count <= 1_000_000,
        ) ||
        value.new + value.updated + value.unchanged !== value.total
    )
        return undefined;
    return `${value.new} new, ${value.updated} updated, ${value.unchanged} unchanged`;
}

function missingDepthArea(skip: EncImportSummary['skipped'][number]): boolean {
    return /^[a-z0-9_.-]+: no DEPARE\/DRGARE depth-area coverage; the pack cannot verify water depths\.$/i.test(
        skip.error,
    );
}

/** Explain known phone failures without reflecting private URLs or arbitrary
 * provider text. Only the exact local depth validator error is an exclusion. */
function phoneCopyReasons(skipped: EncImportSummary['skipped']): EncImportSummary['skipped'] {
    return skipped.map((skip, index) => {
        const excluded = missingDepthArea(skip);
        const filename =
            excluded && /^[a-z0-9_.-]{1,100}$/i.test(skip.filename) ? skip.filename : `Phone copy ${index + 1}`;
        let error =
            'The phone copy did not finish for an unclassified reason. Check the Pi and phone before retrying sync.';
        if (excluded)
            error =
                'Excluded from phone use: missing DEPARE/DRGARE depth-area coverage. This chart cannot verify water depths; the same file needs corrected data before it can be used.';
        else if (/storage|quota|disk|no space/i.test(skip.error))
            error = 'Phone storage could not retain this chart. Free space, then retry Sync charts.';
        else if (/checksum|signature|integrity|signed|hash/i.test(skip.error))
            error = 'Chart integrity could not be verified. Check the Pi chart library before retrying.';
        else if (/timeout|timed out|network|fetch|connect|unreachable|wi.?fi|reconnect/i.test(skip.error))
            error = 'The connection or download did not finish. Reconnect to your paired Pi, then retry Sync charts.';
        else if (/payload|schema|invalid|malformed|unsupported|geometry|coordinate|depth/i.test(skip.error))
            error =
                'The phone rejected this chart’s format or data. Check the chart source; another sync may not resolve this.';
        return { filename, error };
    });
}

function deliverySummary(summary: EncImportSummary): string {
    const changes = packageCounts(summary.packageSummary);
    const counts = changes ? ` ${changes}.` : '';
    if (summary.skipped.length) {
        const excluded = summary.skipped.filter(missingDepthArea).length;
        const other = summary.skipped.length - excluded;
        const copied = summary.cells.length
            ? ` ${summary.cells.length} chart${summary.cells.length === 1 ? '' : 's'} copied to this phone.`
            : '';
        const exclusions = excluded
            ? ` ${excluded} chart${excluded === 1 ? '' : 's'} excluded from phone use: no DEPARE/DRGARE depth-area coverage. These files need corrected data; repeating the same sync will not add them.`
            : '';
        const incomplete = other
            ? ' Phone copy is incomplete. Check the skipped reasons; connection or storage issues can be retried with Sync charts or Sync from Pi.'
            : '';
        return `${summary.installedOnPi ? 'Installed on Pi.' : 'Package processed.'}${copied}${exclusions}${incomplete} Do not reinstall the Pi package.${counts}`;
    }
    return `${summary.cells.length ? `${summary.cells.length} chart${summary.cells.length === 1 ? '' : 's'} available on this phone.` : summary.installedOnPi ? 'Installed on Pi. No new charts were copied to this phone.' : 'Package processed. No new charts were copied to this phone.'}${counts}`;
}

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
                        {'⚡'} Survey confidence (CATZOC) {CATZOC_LABELS[cell.catzocRange[0]]}
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
    const [deliveries, setDeliveries] = useState<DeliveryInstall[]>([]);
    const [urlBatchVersion, setUrlBatchVersion] = useState(0);
    const [recentInstalls, setRecentInstalls] = useState<EncInstallReceipt[]>([]);
    const [recentInstallsBusy, setRecentInstallsBusy] = useState(false);
    const [recentInstallsError, setRecentInstallsError] = useState<string | null>(null);
    const [receiptNotes, setReceiptNotes] = useState<Record<string, string>>({});
    const [resumingReceiptId, setResumingReceiptId] = useState<string | null>(null);
    const urlInstallInFlight = useRef(false);
    const mountedRef = useRef(true);
    // One shared, cancellable timer for "keep 'done' on screen, then clear".
    // Four separate uncancelled setTimeouts used to survive unmount and fire
    // setState on a dead component if the skipper left the tab mid-import.
    const progressClearRef = useRef<number | null>(null);

    const scheduleProgressClear = useCallback(() => {
        if (progressClearRef.current !== null) window.clearTimeout(progressClearRef.current);
        progressClearRef.current = window.setTimeout(() => {
            progressClearRef.current = null;
            setProgress((p) => (p?.phase === 'done' ? null : p));
        }, 2500);
    }, []);

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            if (progressClearRef.current !== null) window.clearTimeout(progressClearRef.current);
        };
    }, []);

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
            scheduleProgressClear();
        }
    }, [refreshCells, scheduleProgressClear]);

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
     * Keep this session's results when reopened. Delivery secrets remain only
     * in component memory and are never used as React keys or progress labels.
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
                setUrlError('Clipboard is empty — copy the delivery email or download link first.');
                return;
            }
            triggerHaptic('light');
            setUrlInput(text);
            setUrlError(null);
        } catch {
            setUrlError('Could not read the clipboard — long-press the box above and paste.');
        }
    }, []);

    const handleInstallFromUrl = useCallback(
        async (retryFailed = false) => {
            if (importing || urlInstallInFlight.current) return;
            let queue: EncChartDeliveryPackage[];
            if (retryFailed)
                queue = deliveries.filter((entry) => entry.status === 'failed').map((entry) => entry.package);
            else {
                const parsed = parseEncChartDelivery(urlInput);
                if (parsed.errors.length) {
                    setUrlError(parsed.errors.join(' '));
                    return;
                }
                queue = parsed.packages.filter(
                    (entry) =>
                        !deliveries.some(
                            (previous) => previous.package.url === entry.url && previous.status !== 'failed',
                        ),
                );
                if (!queue.length) {
                    setUrlError(
                        'These packages are already listed in this window. Use their results or recent Pi install to continue; they will not be downloaded again.',
                    );
                    return;
                }
            }
            if (!queue.length) return;
            urlInstallInFlight.current = true;
            const scope = getAuthIdentityScope();
            const piBase = piCache.baseUrl;
            const pairingKey = getPairing()?.publicKeySpki;
            const authorityCurrent = () =>
                isAuthIdentityScopeCurrent(scope) &&
                piCache.baseUrl === piBase &&
                getPairing()?.publicKeySpki === pairingKey;
            setImporting(true);
            setLastSkipped([]);
            setUrlError(null);
            setProgress(null);
            setUrlInput('');
            setDeliveries((previous) => [
                ...previous.filter((entry) => !queue.some((item) => item.url === entry.package.url)),
                ...queue.map(
                    (entry): DeliveryInstall => ({
                        package: entry,
                        status: 'queued',
                        message: 'Waiting for the previous package.',
                    }),
                ),
            ]);
            const update = (
                entry: EncChartDeliveryPackage,
                status: DeliveryInstall['status'],
                message: string,
                jobId?: string,
            ) => {
                if (mountedRef.current)
                    setDeliveries((previous) =>
                        previous.map((row) =>
                            row.package.url === entry.url
                                ? { ...row, status, message, ...(jobId ? { jobId } : {}) }
                                : row,
                        ),
                    );
            };
            try {
                for (const [index, entry] of queue.entries()) {
                    if (!mountedRef.current) break;
                    if (!authorityCurrent()) {
                        for (const remaining of queue.slice(index))
                            update(
                                remaining,
                                'failed',
                                'The account or paired Pi changed. Start again on the intended boat connection.',
                            );
                        break;
                    }
                    update(entry, 'installing', 'Installing on Pi…');
                    setProgress(null);
                    try {
                        // o-charts uses the Pi's licensed decoder, not GDAL. The
                        // installer itself checks the paired Pi's availability.
                        const summary = await installEncFromUrl(
                            entry.url,
                            entry.filename,
                            (value) => {
                                if (mountedRef.current && authorityCurrent()) setProgress(deliveryProgress(value));
                            },
                            entry.expectedSha256 ? { expectedSha256: entry.expectedSha256 } : undefined,
                        );
                        if (!mountedRef.current) break;
                        if (!authorityCurrent()) {
                            update(
                                entry,
                                'failed',
                                'The account or paired Pi changed. The result could not be confirmed on this connection.',
                            );
                            continue;
                        }
                        refreshCells();
                        if (summary.skipped.length)
                            setLastSkipped((previous) => [...previous, ...phoneCopyReasons(summary.skipped)]);
                        update(entry, summary.skipped.length ? 'phone-pending' : 'complete', deliverySummary(summary));
                    } catch (err) {
                        if (err instanceof Error && err.name === 'EncInstallPendingError') {
                            const jobId = (err as Error & { jobId?: unknown }).jobId;
                            update(
                                entry,
                                'pi-pending',
                                'The Pi may still be installing this package. Close this window and use Continue install under Recent Pi installs; do not download it again.',
                                typeof jobId === 'string' ? jobId : undefined,
                            );
                            for (const remaining of queue.slice(index + 1))
                                update(
                                    remaining,
                                    'failed',
                                    'Not started. Continue the earlier Pi installation first, then retry this package.',
                                );
                            break;
                        }
                        update(entry, 'failed', deliveryFailure(err));
                    }
                }
            } finally {
                urlInstallInFlight.current = false;
                if (mountedRef.current) {
                    setImporting(false);
                    setProgress(null);
                    setUrlBatchVersion((value) => value + 1);
                }
            }
        },
        [deliveries, importing, refreshCells, urlInput],
    );

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
            scheduleProgressClear();
        }
    }, [refreshCells, scheduleProgressClear]);

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
        { cellId: string; edition: number; sourceHO?: string; sizeBytes?: number; contentSha256?: string }[] | null
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
                    contentSha256: c.contentSha256,
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
    }, [cells.length, piReachable, refreshPiCells, urlBatchVersion]);

    useEffect(() => {
        if (!expanded) return;
        let current = true;
        const scope = getAuthIdentityScope();
        const pairingKey = getPairing()?.publicKeySpki;
        const piBase = piCache.baseUrl;
        setRecentInstallsBusy(true);
        setRecentInstallsError(null);
        void listRecentEncInstalls()
            .then((receipts) => {
                if (
                    current &&
                    isAuthIdentityScopeCurrent(scope) &&
                    getPairing()?.publicKeySpki === pairingKey &&
                    piCache.baseUrl === piBase
                ) {
                    setRecentInstalls([...receipts].sort((a, b) => b.startedAt - a.startedAt).slice(0, 3));
                    setDeliveries((rows) =>
                        rows.map((row) =>
                            row.status === 'pi-pending' &&
                            receipts.some((receipt) => receipt.id === row.jobId && receipt.status === 'error')
                                ? {
                                      ...row,
                                      status: 'failed',
                                      message: 'The Pi confirmed this installation failed. You can retry this package.',
                                  }
                                : row,
                        ),
                    );
                }
            })
            .catch(() => {
                if (current)
                    setRecentInstallsError(
                        'Recent installs are unavailable. Reconnect to your paired Pi and check again.',
                    );
            })
            .finally(() => {
                if (current) setRecentInstallsBusy(false);
            });
        return () => {
            current = false;
        };
    }, [expanded, piReachable, urlBatchVersion]);

    const handleResumeInstall = useCallback(
        async (receipt: EncInstallReceipt) => {
            if (importing || urlInstallInFlight.current) return;
            urlInstallInFlight.current = true;
            const scope = getAuthIdentityScope();
            const pairingKey = getPairing()?.publicKeySpki;
            const piBase = piCache.baseUrl;
            const current = () =>
                mountedRef.current &&
                isAuthIdentityScopeCurrent(scope) &&
                getPairing()?.publicKeySpki === pairingKey &&
                piCache.baseUrl === piBase;
            setImporting(true);
            setResumingReceiptId(receipt.id);
            setProgress(null);
            setLastSkipped([]);
            setReceiptNotes((notes) => ({
                ...notes,
                [receipt.id]: 'Checking the existing Pi installation; no new download is started.',
            }));
            try {
                const summary = await resumeEncInstall(receipt.id, (value) => {
                    if (current()) setProgress(deliveryProgress(value));
                });
                if (!current()) return;
                refreshCells();
                setLastSkipped(phoneCopyReasons(summary.skipped));
                setReceiptNotes((notes) => ({ ...notes, [receipt.id]: deliverySummary(summary) }));
                setDeliveries((rows) =>
                    rows.map((row) =>
                        row.jobId === receipt.id
                            ? {
                                  ...row,
                                  status: summary.skipped.length ? 'phone-pending' : 'complete',
                                  message: deliverySummary(summary),
                              }
                            : row,
                    ),
                );
            } catch (err) {
                if (current()) setReceiptNotes((notes) => ({ ...notes, [receipt.id]: deliveryFailure(err) }));
            } finally {
                urlInstallInFlight.current = false;
                if (mountedRef.current) {
                    setImporting(false);
                    setResumingReceiptId(null);
                    setProgress(null);
                    setUrlBatchVersion((version) => version + 1);
                }
            }
        },
        [importing, refreshCells],
    );

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
        () => new Set(cells.map((c) => encCellSyncKey(c.id, c.edition ?? 0, c.sizeBytes, c.contentSha256))),
        [cells],
    );
    const missingOnDevice = useMemo(
        () =>
            (piCellsSummary ?? []).filter(
                ({ cellId, edition, sizeBytes, contentSha256 }) =>
                    !localCellKeys.has(encCellSyncKey(cellId, edition, sizeBytes, contentSha256)),
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
                scheduleProgressClear();
            }
        },
        [refreshCells, scheduleProgressClear],
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
                                        <span aria-hidden="true">{'\u{1F4E5}'}</span>
                                        <span>Add or update charts</span>
                                    </span>
                                )}
                            </button>
                            <p className="text-[11px] text-gray-500 leading-relaxed">
                                Paste your o-charts delivery email or chart download links. The Pi installs new charts
                                and updates, then copies available charts to this phone.
                            </p>
                        </div>

                        <section aria-label="Recent chart installs" className="space-y-2">
                            <div className="flex items-center justify-between gap-2">
                                <p className="text-[11px] font-bold uppercase tracking-widest text-white/40">
                                    Recent Pi installs
                                </p>
                                <button
                                    type="button"
                                    disabled={importing || recentInstallsBusy}
                                    onClick={() => setUrlBatchVersion((version) => version + 1)}
                                    className="min-h-11 text-[11px] font-bold text-sky-300 disabled:opacity-50"
                                >
                                    {recentInstallsBusy ? 'Checking installs…' : 'Check recent installs'}
                                </button>
                            </div>
                            <p className="text-[11px] text-gray-400">
                                Closed the app or lost Wi-Fi? Continue an existing install here without downloading it
                                again.
                            </p>
                            {recentInstallsError && (
                                <p className="text-xs text-amber-300" role="status">
                                    {recentInstallsError}
                                </p>
                            )}
                            {!recentInstallsBusy && !recentInstallsError && !recentInstalls.length && (
                                <p className="text-[11px] text-gray-500">No recent installs reported by this Pi.</p>
                            )}
                            {recentInstalls.map((receipt, index) => (
                                <div
                                    key={receipt.id}
                                    className="rounded-xl border border-white/8 bg-white/2 p-3 space-y-2"
                                >
                                    <p className="text-xs font-bold text-white">Recent install {index + 1}</p>
                                    <p className="text-[11px] text-gray-300">
                                        {receipt.status === 'error'
                                            ? 'The Pi could not finish this install. Paste the delivery again to retry.'
                                            : receipt.status === 'done'
                                              ? receipt.resultKind === 'installed'
                                                  ? 'Installed on Pi. Phone availability is checked when you sync.'
                                                  : receipt.resultKind === 'staged'
                                                    ? 'Files received on Pi. Add the matching licensed chart or permit bundle to finish; these charts are not ready.'
                                                    : 'Processing finished on Pi.'
                                              : 'This installation is still in progress on the Pi.'}
                                    </p>
                                    {packageCounts(receipt.packageSummary) && (
                                        <p className="text-[11px] text-gray-400">
                                            {packageCounts(receipt.packageSummary)}
                                        </p>
                                    )}
                                    {receiptNotes[receipt.id] && (
                                        <p role="status" className="text-xs text-gray-300">
                                            {receiptNotes[receipt.id]}
                                        </p>
                                    )}
                                    {resumingReceiptId === receipt.id && progress && (
                                        <ImportProgressBar progress={progress} />
                                    )}
                                    {receipt.status === 'error' ? (
                                        <button
                                            type="button"
                                            disabled={importing}
                                            onClick={openUrlInstallDialog}
                                            className="min-h-11 text-xs font-bold text-sky-300 disabled:opacity-50"
                                        >
                                            Paste delivery again
                                        </button>
                                    ) : (
                                        (receipt.status !== 'done' || receipt.resultKind === 'installed') && (
                                            <button
                                                type="button"
                                                disabled={importing}
                                                onClick={() => void handleResumeInstall(receipt)}
                                                className="min-h-11 text-xs font-bold text-sky-300 disabled:opacity-50"
                                            >
                                                {resumingReceiptId === receipt.id
                                                    ? 'Working…'
                                                    : receipt.status === 'done'
                                                      ? 'Sync charts'
                                                      : 'Continue install'}
                                            </button>
                                        )
                                    )}
                                </div>
                            ))}
                        </section>

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
                                                            <p className="text-[10px] text-white/60">
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
                                                    <p className="px-3 py-2 text-[10px] text-white/60">
                                                        No pending charts match that filter.
                                                    </p>
                                                )}
                                            </div>
                                            {pickerMatches.total > pickerMatches.rows.length && (
                                                <p className="text-[10px] text-white/60">
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
                                        {lastSkipped.length} item{lastSkipped.length === 1 ? '' : 's'} not added to this
                                        phone during the last import or sync
                                    </p>
                                    <ul className="space-y-0.5">
                                        {lastSkipped.slice(0, 5).map((s, index) => (
                                            <li key={index} className="text-[10px] text-amber-300/80">
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
                        <p className="text-[10px] text-gray-400 leading-relaxed px-1">
                            Your charts are stored on this phone and keep working with the Pi switched off. The Pi is
                            only used to convert a cell when you import one, and to hold spares you can pull down.
                        </p>

                        {/* ── Source attribution / honesty note ── */}
                        <div className="px-3 py-2 rounded-xl bg-white/2 border border-white/4">
                            <p className="text-[10px] text-gray-400 leading-relaxed">
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
                title="Add or update charts"
                maxWidth="max-w-lg"
            >
                <form
                    className="space-y-4"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void handleInstallFromUrl(false);
                    }}
                >
                    <p className="text-xs leading-relaxed text-gray-300">
                        Copy the whole o-charts delivery email, or paste up to four direct download links. New charts
                        and updates use the same button. Keep this window open while the Pi works through them.
                    </p>
                    <p className="text-xs leading-relaxed text-gray-400">
                        Connect to your boat&apos;s Wi-Fi; the Pi needs internet to download. If the email includes a
                        SHA256 checksum, it is checked automatically. You do not need to find one yourself.
                    </p>
                    <div>
                        <label
                            htmlFor="enc-install-url"
                            className="mb-2 block text-[11px] font-bold uppercase tracking-widest text-gray-400"
                        >
                            Delivery emails or download links
                        </label>
                        <textarea
                            id="enc-install-url"
                            autoComplete="off"
                            autoCapitalize="none"
                            autoCorrect="off"
                            spellCheck={false}
                            autoFocus
                            maxLength={ENC_DELIVERY_MAX_TEXT}
                            rows={5}
                            value={urlInput}
                            onChange={(event) => {
                                setUrlInput(event.target.value);
                                if (urlError) setUrlError(null);
                            }}
                            disabled={importing}
                            aria-invalid={urlError ? 'true' : 'false'}
                            aria-describedby={urlError ? 'enc-install-url-error' : 'enc-install-url-help'}
                            placeholder="Paste your delivery email or chart links here"
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
                                <span>Paste from clipboard</span>
                            </span>
                        </button>
                        <p id="enc-install-url-help" className="mt-2 text-[11px] text-gray-500">
                            Direct HTTP or HTTPS downloads only. Links stay in this window and are sent only to your
                            paired Pi for installation. Do not share private delivery links.
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
                    {deliveries.length > 0 && (
                        <section aria-label="Chart package results" aria-live="polite" className="space-y-2">
                            {deliveries.map((entry, index) => (
                                <div key={index} className="rounded-xl border border-white/10 bg-white/3 p-3">
                                    <p className="text-sm font-bold text-white">{entry.package.label}</p>
                                    <p
                                        className={`mt-1 text-xs ${entry.status === 'failed' ? 'text-red-300' : entry.status === 'phone-pending' || entry.status === 'pi-pending' ? 'text-amber-300' : 'text-gray-300'}`}
                                    >
                                        {entry.message}
                                    </p>
                                    {entry.package.expectedSha256 && (
                                        <p className="mt-1 text-[11px] text-gray-400">Publisher checksum included</p>
                                    )}
                                    {entry.status === 'installing' && progress && (
                                        <div className="mt-2">
                                            <ImportProgressBar progress={progress} />
                                        </div>
                                    )}
                                </div>
                            ))}
                            {deliveries.some((entry) => entry.status === 'failed') && (
                                <button
                                    type="button"
                                    disabled={importing}
                                    onClick={() => void handleInstallFromUrl(true)}
                                    className="min-h-11 w-full rounded-xl border border-amber-400/30 bg-amber-500/10 px-4 py-3 text-xs font-bold text-amber-200 disabled:opacity-50"
                                >
                                    Retry failed packages
                                </button>
                            )}
                        </section>
                    )}
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
                            {deliveries.length ? 'Close' : 'Cancel'}
                        </Button>
                        <button
                            type="submit"
                            disabled={importing || !urlInput.trim()}
                            className="min-h-11 flex-1 rounded-xl border border-emerald-400/30 bg-emerald-500/20 px-4 py-3 text-sm font-black uppercase tracking-wider text-emerald-200 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            {importing ? 'Installing…' : 'Add or update on Pi'}
                        </button>
                    </div>
                </form>
            </ModalSheet>
        </>
    );
};

export default EncCellManager;
