/**
 * useGribDownload — React hook that wires the GRIB download pipeline:
 *
 *   Screen bounds (MapRef) → area check (NetworkMode) → fetch (ResumableGribFetcher)
 *   → decode (decodeWindBinary) → feed (WindParticleLayer.setWindData)
 *
 * In broadband mode, bypasses screen bounds and requests the global dataset.
 * Exposes isDownloading, downloadProgress, downloadError state for UI feedback.
 */

import { useState, useCallback, useRef } from 'react';
import type { MapRef } from 'react-map-gl/maplibre';
import { getGribBoundsFromMap, type GribBounds } from '../../components/map/ThalassaMap';
import { ResumableGribFetcher } from './ResumableGribFetcher';
import { decodeWindBinary, type DecodedWindField } from './decodeWindBinary';
import { useNetworkMode } from '../../contexts/NetworkModeContext';

// ── Types ──────────────────────────────────────────────────────

export interface GribDownloadState {
    isDownloading: boolean;
    downloadProgress: number;
    downloadError: string | null;
}

export interface GribDownloadActions {
    handleDownloadRequest: () => Promise<void>;
    cancelDownload: () => void;
}

export interface UseGribDownloadOptions {
    /** Base URL for the GRIB endpoint. Bounds appended as query params. */
    endpoint: string;
    /** URL for global (full-earth) dataset. Used in broadband mode. */
    globalEndpoint?: string;
    /** Map ref for extracting screen bounds. */
    mapRef: React.RefObject<MapRef | null>;
    /** Callback with decoded wind field on success. */
    onWindData: (field: DecodedWindField, bounds: GribBounds) => void;
}

// ── Helpers ────────────────────────────────────────────────────

const GLOBAL_BOUNDS: GribBounds = {
    north: 90,
    south: -90,
    east: 180,
    west: -180,
};

function buildGribUrl(endpoint: string, bounds: GribBounds, resolution: number): string {
    const params = new URLSearchParams({
        north: bounds.north.toFixed(4),
        south: bounds.south.toFixed(4),
        east: bounds.east.toFixed(4),
        west: bounds.west.toFixed(4),
        resolution: resolution.toFixed(2),
    });
    const separator = endpoint.includes('?') ? '&' : '?';
    return `${endpoint}${separator}${params.toString()}`;
}

function computeAreaDeg2(bounds: GribBounds): number {
    return Math.abs(bounds.north - bounds.south) * Math.abs(bounds.east - bounds.west);
}

// ── Hook ───────────────────────────────────────────────────────

export function useGribDownload(
    options: UseGribDownloadOptions,
): GribDownloadState & GribDownloadActions {
    const { endpoint, globalEndpoint, mapRef, onWindData } = options;
    const { isSatelliteMode, maxSatelliteAreaDeg2 } = useNetworkMode();

    const [isDownloading, setIsDownloading] = useState(false);
    const [downloadProgress, setDownloadProgress] = useState(0);
    const [downloadError, setDownloadError] = useState<string | null>(null);

    const abortRef = useRef<AbortController | null>(null);

    const cancelDownload = useCallback(() => {
        abortRef.current?.abort();
        abortRef.current = null;
    }, []);

    const handleDownloadRequest = useCallback(async () => {
        let bounds: GribBounds;
        let url: string;

        if (isSatelliteMode) {
            // ── Satellite mode: screen bounds + area check + high-res 0.25° ──
            if (!mapRef.current) {
                setDownloadError('Map not ready');
                return;
            }

            bounds = getGribBoundsFromMap(mapRef.current);
            const area = computeAreaDeg2(bounds);

            if (area > maxSatelliteAreaDeg2) {
                setDownloadError(
                    `Area too large for Satellite Mode (${area.toFixed(0)}°² > ${maxSatelliteAreaDeg2}°²). Please zoom in.`,
                );
                return;
            }

            url = buildGribUrl(endpoint, bounds, 0.25);
        } else {
            // ── Global mode: full earth + low-res 1.0° to save GPU memory ──
            bounds = GLOBAL_BOUNDS;
            url = globalEndpoint ?? buildGribUrl(endpoint, GLOBAL_BOUNDS, 1.0);
        }

        // ── Begin download ──
        setIsDownloading(true);
        setDownloadProgress(0);
        setDownloadError(null);

        const abortController = new AbortController();
        abortRef.current = abortController;

        try {
            const fetcher = new ResumableGribFetcher(url, {
                maxRetries: isSatelliteMode ? 15 : 5,
                retryDelay: isSatelliteMode ? 8000 : 3000,
                signal: abortController.signal,
                onProgress: ({ downloadedBytes, totalBytes }) => {
                    if (totalBytes && totalBytes > 0) {
                        setDownloadProgress(
                            Math.min(99, Math.round((downloadedBytes / totalBytes) * 100)),
                        );
                    }
                },
            });

            const buffer = await fetcher.fetch();
            setDownloadProgress(100);

            const field = decodeWindBinary(buffer);
            onWindData(field, bounds);
        } catch (err: unknown) {
            if (abortController.signal.aborted) {
                setDownloadError('Download cancelled');
            } else {
                const message = err instanceof Error ? err.message : 'Download failed';
                setDownloadError(message);
                console.error('[useGribDownload]', err);
            }
        } finally {
            setIsDownloading(false);
            abortRef.current = null;
        }
    }, [endpoint, globalEndpoint, mapRef, isSatelliteMode, maxSatelliteAreaDeg2, onWindData]);

    return {
        isDownloading,
        downloadProgress,
        downloadError,
        handleDownloadRequest,
        cancelDownload,
    };
}
