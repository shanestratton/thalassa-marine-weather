/** Explicit offline download of Thalassa's public terrain, never Mapbox/OSM or licensed charts. */
import React, { useState, useMemo, useRef, useEffect } from 'react';
import type mapboxgl from 'mapbox-gl';
import { Capacitor } from '@capacitor/core';
import { ModalSheet } from '../ui/ModalSheet';
import { RELIEF_TILE_BASE } from './reliefBase';
import { planReliefArea, type ReliefBounds } from '../../services/offlineReliefPlan';
import {
    deleteSavedRelief,
    downloadReliefArea,
    hydrateRelief,
    reliefStorage,
    type ReliefProgress,
} from '../../services/OfflineReliefService';
import { subscribeOfflineRelief } from '../../services/offlineReliefRuntime';
import { satelliteModeBlocks } from '../../services/networkPolicy';
import { RELIEF_DISPLAY_REGIONS } from '../../services/reliefDisplayRegions';

interface OfflineAreaModalProps {
    isOpen: boolean;
    onClose: () => void;
    map: mapboxgl.Map | null;
}
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
export const OfflineAreaModal: React.FC<OfflineAreaModalProps> = ({ isOpen, onClose, map }) => {
    const [detail, setDetail] = useState(9),
        [progress, setProgress] = useState<ReliefProgress | null>(null);
    const [storage, setStorage] = useState(reliefStorage),
        [error, setError] = useState('');
    const [deleting, setDeleting] = useState(false);
    const abort = useRef<AbortController | null>(null);
    const bounds = useMemo<ReliefBounds | null>(() => {
        const b = isOpen ? map?.getBounds() : null;
        if (!b) return null;
        const span = b.getEast() - b.getWest(),
            wrap = (lon: number) => ((((lon + 180) % 360) + 360) % 360) - 180;
        return {
            north: Math.min(90, b.getNorth()),
            south: Math.max(-90, b.getSouth()),
            west: span >= 360 ? -180 : wrap(b.getWest()),
            east: span >= 360 ? 180 : wrap(b.getEast()),
        };
    }, [isOpen, map]);
    const plan = useMemo(() => {
        try {
            return bounds ? planReliefArea(bounds, detail, RELIEF_TILE_BASE) : null;
        } catch {
            return null;
        }
    }, [bounds, detail]);
    useEffect(() => {
        if (!isOpen) return;
        let alive = true;
        const stop = subscribeOfflineRelief(() => {
            if (alive) setStorage(reliefStorage());
        });
        hydrateRelief()
            .then(() => {
                if (alive) setStorage(reliefStorage());
            })
            .catch((e) => {
                if (alive) setError(e.message);
            });
        return () => {
            alive = false;
            stop();
            abort.current?.abort();
        };
    }, [isOpen]);
    const downloading = progress?.phase === 'downloading',
        busy = downloading || deleting,
        satellite = satelliteModeBlocks('offline-download');
    const close = () => {
        abort.current?.abort();
        setProgress(null);
        onClose();
    };
    const download = async () => {
        if (!bounds || busy) return;
        setError('');
        abort.current = new AbortController();
        try {
            await downloadReliefArea(bounds, detail, RELIEF_TILE_BASE, abort.current.signal, setProgress);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Relief download unavailable.');
        }
    };
    const remove = async () => {
        setDeleting(true);
        try {
            setError('');
            await deleteSavedRelief();
            setStorage(reliefStorage());
            setProgress(null);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Delete failed.');
        } finally {
            setDeleting(false);
        }
    };
    return (
        <ModalSheet isOpen={isOpen} onClose={close} title="Offline Relief" maxWidth="max-w-md">
            <div className="space-y-3 text-xs leading-relaxed text-gray-300">
                <p>
                    Save relief for the visible area: global zoom 0–9, Australia 250 m zoom 8–10, GBR 30 m zoom 8–13,
                    and 61 surveyed New Zealand coastal patches zoom 8–14. Sparse gaps keep coarse fallback; zoom is not
                    survey accuracy.
                </p>
                <p>
                    Australia is approximately MSL. New Zealand retains native NZVD2016 heights, not MSL; no vertical
                    conversion. GEBCO fallback is approximately MSL. This mixed-datum display is not for navigation or
                    depth sampling.
                </p>
                <p className="rounded-xl border border-amber-500/25 bg-amber-500/10 p-3 text-amber-100">
                    Mapbox imagery, place labels and public OSM tiles are not stored. Free NOAA and imported public
                    charts stay in Chart Locker; licensed charts require your boat Pi connection.
                </p>
                <p>
                    {Capacitor.isNativePlatform()
                        ? 'Saved in persistent app storage.'
                        : 'Saved in this browser; clearing site data removes it.'}{' '}
                    The 128 MiB limit removes the least recently used saved terrain first.
                </p>
                {bounds && (
                    <p className="font-mono text-gray-400">
                        {bounds.south.toFixed(2)}°, {bounds.west.toFixed(2)}° → {bounds.north.toFixed(2)}°,{' '}
                        {bounds.east.toFixed(2)}°
                    </p>
                )}
                <label className="block">
                    Maximum detail: <strong>zoom {detail}</strong>
                    <input
                        aria-label="Maximum relief detail"
                        className="block w-full min-h-[44px] accent-sky-400"
                        type="range"
                        min={4}
                        max={Math.max(13, ...RELIEF_DISPLAY_REGIONS.map((region) => region.maxzoom))}
                        step={1}
                        value={detail}
                        disabled={busy}
                        onChange={(e) => setDetail(Number(e.target.value))}
                    />
                </label>
                <p>
                    {plan
                        ? `${plan.tileCount.toLocaleString()} terrain files · about ${mb(plan.estimatedBytes)}. Actual size varies; missing all-land tiles are skipped.`
                        : 'Choose a map area first.'}
                </p>
                {plan?.tooLarge && (
                    <p role="alert" className="text-amber-200">
                        Area too large. Zoom in or lower the detail (maximum 4,096 terrain files).
                    </p>
                )}
                {satellite && (
                    <p role="status" className="text-amber-200">
                        Satellite Mode blocks bulk relief downloads. Saved terrain remains available.
                    </p>
                )}
                <div className="flex items-center justify-between gap-3 rounded-xl bg-white/5 p-3">
                    <p>
                        {storage.tiles.toLocaleString()} saved files · {mb(storage.bytes)} / 128 MiB
                    </p>
                    <button
                        className="min-h-[44px] px-3 rounded-lg bg-red-500/10 text-red-200 disabled:opacity-40"
                        disabled={busy || !storage.tiles}
                        onClick={() => void remove()}
                    >
                        Delete saved relief
                    </button>
                </div>
                {progress && (
                    <div role="status" aria-live="polite">
                        <p>
                            {progress.phase === 'downloading'
                                ? `Downloading ${progress.current} / ${progress.total}`
                                : progress.phase === 'cancelled'
                                  ? 'Cancelled'
                                  : progress.phase === 'error'
                                    ? 'Download needs attention'
                                    : 'Download finished'}
                        </p>
                        <progress
                            className="w-full accent-sky-400"
                            max={Math.max(1, progress.total)}
                            value={progress.current}
                        />
                        <p>{progress.message}</p>
                    </div>
                )}
                {error && (
                    <p role="alert" className="text-red-200">
                        {error}
                    </p>
                )}
                <div className="flex gap-2">
                    <button className="min-h-[44px] px-4 rounded-xl bg-white/5" onClick={close}>
                        Close
                    </button>
                    {downloading ? (
                        <button
                            className="min-h-[44px] flex-1 rounded-xl bg-amber-500/15 text-amber-200"
                            onClick={() => abort.current?.abort()}
                        >
                            Cancel download
                        </button>
                    ) : (
                        <button
                            className="min-h-[44px] flex-1 rounded-xl bg-sky-500/15 text-sky-200 disabled:opacity-40"
                            disabled={!plan || plan.tooLarge || satellite || deleting}
                            onClick={() => void download()}
                        >
                            Download relief
                        </button>
                    )}
                </div>
            </div>
        </ModalSheet>
    );
};
