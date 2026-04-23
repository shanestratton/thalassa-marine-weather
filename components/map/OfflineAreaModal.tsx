/**
 * OfflineAreaModal — "Download this area for offline use" UI.
 *
 * Reads the map's current bounds, lets the user pick a zoom range
 * (defaults to 8–13 — a good cruising sweet spot), shows a tile-count
 * and size estimate, and runs the download via MapOfflineService.
 *
 * Tiles are routed through the Pi when the boat network is up,
 * otherwise they're cached by the service worker on the phone.
 */
import React, { useState, useMemo, useRef, useCallback } from 'react';
import type mapboxgl from 'mapbox-gl';
import { ModalSheet } from '../ui/ModalSheet';
import { triggerHaptic } from '../../utils/system';
import { MapOfflineService, type OfflineBounds, type OfflineDownloadProgress } from '../../services/MapOfflineService';
import { piCache } from '../../services/PiCacheService';

interface OfflineAreaModalProps {
    isOpen: boolean;
    onClose: () => void;
    map: mapboxgl.Map | null;
}

const DEFAULT_MIN_ZOOM = 8;
const DEFAULT_MAX_ZOOM = 13;
const ZOOM_BOUNDS = { min: 4, max: 16 };

function formatBounds(b: OfflineBounds): string {
    return `${b.south.toFixed(2)}°, ${b.west.toFixed(2)}° → ${b.north.toFixed(2)}°, ${b.east.toFixed(2)}°`;
}

export const OfflineAreaModal: React.FC<OfflineAreaModalProps> = ({ isOpen, onClose, map }) => {
    const [minZoom, setMinZoom] = useState(DEFAULT_MIN_ZOOM);
    const [maxZoom, setMaxZoom] = useState(DEFAULT_MAX_ZOOM);
    const [progress, setProgress] = useState<OfflineDownloadProgress | null>(null);
    const abortRef = useRef<AbortController | null>(null);

    // Snapshot bounds at modal-open time so the estimate doesn't flicker
    // while the user tweaks the zoom range.
    const bounds = useMemo<OfflineBounds | null>(() => {
        if (!isOpen || !map) return null;
        const b = map.getBounds();
        if (!b) return null;
        return {
            north: b.getNorth(),
            south: b.getSouth(),
            east: b.getEast(),
            west: b.getWest(),
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen, map]);

    const tileCount = useMemo(() => {
        if (!bounds) return 0;
        return MapOfflineService.estimateTileCount(bounds, minZoom, maxZoom);
    }, [bounds, minZoom, maxZoom]);

    const sizeMB = useMemo(() => MapOfflineService.estimateSizeMB(tileCount), [tileCount]);

    const route: 'pi' | 'direct' = piCache.isAvailable() ? 'pi' : 'direct';

    const busy = progress?.phase === 'downloading';
    const done = progress?.phase === 'done';
    const cancelled = progress?.phase === 'cancelled';
    const errored = progress?.phase === 'error';

    const pct = progress && progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;

    const handleDownload = useCallback(async () => {
        if (!bounds || busy) return;
        triggerHaptic('medium');
        abortRef.current = new AbortController();
        setProgress({ phase: 'downloading', current: 0, total: tileCount, failed: 0, route, message: 'Starting…' });
        await MapOfflineService.downloadArea(
            { bounds, minZoom, maxZoom, signal: abortRef.current.signal },
            setProgress,
        );
    }, [bounds, busy, tileCount, minZoom, maxZoom, route]);

    const handleCancel = useCallback(() => {
        triggerHaptic('light');
        abortRef.current?.abort();
    }, []);

    const handleClose = useCallback(() => {
        if (busy) {
            abortRef.current?.abort();
        }
        setProgress(null);
        onClose();
    }, [busy, onClose]);

    const canDownload = bounds && tileCount > 0 && tileCount < 20000 && !busy;

    return (
        <ModalSheet isOpen={isOpen} onClose={handleClose} title="Download Offline Area" maxWidth="max-w-md">
            <div className="space-y-4 text-[13px] text-gray-300">
                {/* ── Route badge ── */}
                <div
                    className={`flex items-center gap-2 px-3 py-2 rounded-xl border ${
                        route === 'pi' ? 'bg-emerald-500/10 border-emerald-500/20' : 'bg-sky-500/10 border-sky-500/20'
                    }`}
                >
                    <span className="text-base">{route === 'pi' ? '\u2693' : '\u{1F4F1}'}</span>
                    <div className="flex-1">
                        <p className={`text-[12px] font-bold ${route === 'pi' ? 'text-emerald-300' : 'text-sky-300'}`}>
                            {route === 'pi' ? 'Saving to boat Pi' : 'Saving to phone'}
                        </p>
                        <p className="text-[11px] text-gray-500">
                            {route === 'pi'
                                ? 'Pi detected — tiles cached on boat network for all devices.'
                                : 'No Pi detected — tiles cached in the phone\u2019s browser.'}
                        </p>
                    </div>
                </div>

                {/* ── Bounds ── */}
                {bounds && (
                    <div className="px-3 py-2 rounded-xl bg-white/[0.03] border border-white/[0.06]">
                        <p className="text-[11px] font-bold uppercase tracking-widest text-white/40 mb-1">Area</p>
                        <p className="text-[12px] font-mono text-white/80">{formatBounds(bounds)}</p>
                    </div>
                )}

                {/* ── Zoom range ── */}
                <div className="space-y-2">
                    <div className="flex items-center justify-between">
                        <p className="text-[11px] font-bold uppercase tracking-widest text-white/40">Zoom range</p>
                        <p className="text-[12px] font-mono text-sky-300">
                            z{minZoom} – z{maxZoom}
                        </p>
                    </div>
                    <div className="flex items-center gap-3">
                        <label className="flex-1 flex items-center gap-2">
                            <span className="text-[11px] text-gray-500 w-8">Min</span>
                            <input
                                type="range"
                                min={ZOOM_BOUNDS.min}
                                max={ZOOM_BOUNDS.max}
                                value={minZoom}
                                onChange={(e) => {
                                    const v = Number(e.target.value);
                                    setMinZoom(v);
                                    if (v > maxZoom) setMaxZoom(v);
                                }}
                                disabled={busy}
                                className="flex-1 accent-sky-400"
                            />
                        </label>
                    </div>
                    <div className="flex items-center gap-3">
                        <label className="flex-1 flex items-center gap-2">
                            <span className="text-[11px] text-gray-500 w-8">Max</span>
                            <input
                                type="range"
                                min={ZOOM_BOUNDS.min}
                                max={ZOOM_BOUNDS.max}
                                value={maxZoom}
                                onChange={(e) => {
                                    const v = Number(e.target.value);
                                    setMaxZoom(v);
                                    if (v < minZoom) setMinZoom(v);
                                }}
                                disabled={busy}
                                className="flex-1 accent-sky-400"
                            />
                        </label>
                    </div>
                    <p className="text-[10px] text-gray-500 leading-relaxed">
                        Lower zooms show whole regions; higher zooms show harbours in detail. A 6-level range covers
                        most cruising needs.
                    </p>
                </div>

                {/* ── Estimate ── */}
                <div className="grid grid-cols-2 gap-2">
                    <div className="px-3 py-2 rounded-xl bg-white/[0.03] border border-white/[0.06]">
                        <p className="text-[10px] font-bold uppercase tracking-widest text-white/40">Tiles</p>
                        <p className="text-[14px] font-bold text-white tabular-nums">{tileCount.toLocaleString()}</p>
                    </div>
                    <div className="px-3 py-2 rounded-xl bg-white/[0.03] border border-white/[0.06]">
                        <p className="text-[10px] font-bold uppercase tracking-widest text-white/40">~ Size</p>
                        <p className="text-[14px] font-bold text-white tabular-nums">{sizeMB} MB</p>
                    </div>
                </div>

                {tileCount > 5000 && !busy && (
                    <p className="text-[11px] text-amber-400/80">
                        {'\u26A0'} Large download — consider lowering the max zoom or zooming the map to a smaller area.
                    </p>
                )}
                {tileCount >= 20000 && !busy && (
                    <p className="text-[11px] text-red-400">
                        Too many tiles. Please zoom in on the map or narrow the zoom range.
                    </p>
                )}

                {/* ── Progress ── */}
                {progress && progress.phase !== 'idle' && (
                    <div className="space-y-1.5">
                        <div className="flex items-center justify-between">
                            <span
                                className={`text-[11px] font-bold uppercase tracking-wider ${
                                    done
                                        ? 'text-emerald-400'
                                        : errored
                                          ? 'text-red-400'
                                          : cancelled
                                            ? 'text-amber-400'
                                            : 'text-sky-400'
                                }`}
                            >
                                {done
                                    ? '\u2713 Complete'
                                    : errored
                                      ? '\u2717 Failed'
                                      : cancelled
                                        ? 'Cancelled'
                                        : 'Downloading'}
                            </span>
                            <span className="text-[11px] text-white/60 font-mono">{pct}%</span>
                        </div>
                        <div className="w-full h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
                            <div
                                className={`h-full rounded-full transition-all duration-300 ease-out ${
                                    done
                                        ? 'bg-emerald-400'
                                        : errored
                                          ? 'bg-red-500'
                                          : cancelled
                                            ? 'bg-amber-500'
                                            : 'bg-sky-500'
                                }`}
                                style={{ width: `${pct}%` }}
                            />
                        </div>
                        <p className="text-[11px] text-gray-500">{progress.message}</p>
                    </div>
                )}

                {/* ── Actions ── */}
                <div className="flex gap-2 pt-2">
                    {busy ? (
                        <button
                            onClick={handleCancel}
                            className="flex-1 py-2.5 rounded-xl text-xs font-black uppercase tracking-widest bg-amber-500/15 border border-amber-500/30 text-amber-400 hover:bg-amber-500/25 transition-all active:scale-95"
                        >
                            Cancel
                        </button>
                    ) : (
                        <>
                            <button
                                onClick={handleClose}
                                className="px-4 py-2.5 rounded-xl text-xs font-bold uppercase tracking-widest bg-white/[0.04] border border-white/[0.08] text-gray-400 hover:bg-white/[0.08] transition-all active:scale-95"
                            >
                                Close
                            </button>
                            <button
                                onClick={handleDownload}
                                disabled={!canDownload}
                                className={`flex-1 py-2.5 rounded-xl text-xs font-black uppercase tracking-widest transition-all active:scale-95 ${
                                    canDownload
                                        ? 'bg-sky-500/15 border border-sky-500/30 text-sky-400 hover:bg-sky-500/25'
                                        : 'bg-white/[0.03] border border-white/[0.06] text-gray-600 cursor-not-allowed'
                                }`}
                            >
                                {done ? 'Download Again' : 'Download'}
                            </button>
                        </>
                    )}
                </div>
            </div>
        </ModalSheet>
    );
};
