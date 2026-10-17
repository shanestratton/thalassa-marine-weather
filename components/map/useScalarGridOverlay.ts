import { useLayoutEffect, useRef, useState, type MutableRefObject } from 'react';
import type mapboxgl from 'mapbox-gl';
import {
    renderScalarGridImage,
    type ScalarColourStop,
    type ScalarGrid,
    type ScalarImageBounds,
} from '../../services/weather/scalarGridImage';
import { cloudOverlayBeforeId, imageryTopIndex } from './imageryOrder';
import { retireScalarImage, type ScalarImageRetirement } from './scalarImageOwnership';

export type ScalarOverlayStatus = 'off' | 'loading' | 'ready' | 'unavailable' | 'stuck-visible';
export interface ScalarOverlayOptions {
    /** A fixed caller-owned namespace, e.g. observed-ssh. */
    readonly id: string;
    readonly label: string;
    readonly credit: string;
    readonly enabled: boolean;
    readonly grid: ScalarGrid | null;
    readonly stops: readonly ScalarColourStop[];
    /** Includes the original cohort, selected field and exact valid-time identity. */
    readonly revision: string;
    /** Process-local proof belonging to this grid/revision, never persisted. */
    readonly sourceCurrent: () => boolean;
    readonly bounds?: ScalarImageBounds;
}

/**
 * One 512² image/texture, no fetch, durable cache, camera move or frame history.
 * A different revision retires the old presentation before the replacement loads.
 * The caller owns the source lease and must keep it through this hook's lifetime.
 * Keep the supplied attribution in the credit rollup while status is stuck-visible,
 * even after user-off; only proven absent/hidden presentation may read off.
 */
export function useScalarGridOverlay(
    mapRef: MutableRefObject<mapboxgl.Map | null>,
    mapReady: boolean,
    options: ScalarOverlayOptions,
): ScalarOverlayStatus {
    const [status, setStatus] = useState<ScalarOverlayStatus>('off');
    const latest = useRef(options);
    const verifyRef = useRef<(() => void) | null>(null);
    const retirementRef = useRef<ScalarImageRetirement | null>(null);
    const mounted = useRef(false);
    const goneMapRef = useRef<mapboxgl.Map | null>(null);
    latest.current = options;
    const { id, enabled, grid, stops, revision, sourceCurrent, bounds } = options;
    const boundsKey = bounds?.join(',') ?? '';
    const paletteKey = JSON.stringify(stops);

    useLayoutEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);

    useLayoutEffect(() => {
        const map = mapRef.current;
        if (map && goneMapRef.current === map) {
            setStatus('off');
            return;
        }
        if (map && goneMapRef.current !== map) goneMapRef.current = null;
        const previous = retirementRef.current;
        if (previous) {
            previous.retry();
            if (!previous.done()) {
                setStatus(previous.state() === 'stuck-visible' ? 'stuck-visible' : enabled ? 'unavailable' : 'off');
                return;
            }
            retirementRef.current = null;
        }
        if (!enabled || !mapReady || !map) {
            setStatus('off');
            return;
        }
        if (!/^[a-z][a-z0-9-]{0,63}$/.test(id) || !grid) {
            setStatus('unavailable');
            return;
        }
        const sourceId = `${id}-source`;
        const layerId = `${id}-layer`;
        let live = true;
        let retired = false;
        let mapGone = false;
        let ownedSource: ReturnType<mapboxgl.Map['getSource']>;
        let readyTimer: ReturnType<typeof setTimeout> | null = null;

        const current = (): boolean => {
            try {
                return (
                    live &&
                    !retired &&
                    latest.current.enabled &&
                    latest.current.grid === grid &&
                    latest.current.revision === revision &&
                    sourceCurrent() &&
                    latest.current.sourceCurrent()
                );
            } catch {
                return false;
            }
        };
        const check = () => {
            if (!current()) throw new DOMException('Scalar source retired', 'AbortError');
        };
        const clearTimer = () => {
            if (readyTimer !== null) clearTimeout(readyTimer);
            readyTimer = null;
        };
        const removeOwned = () => {
            clearTimer();
            if (mapGone) {
                ownedSource = undefined;
                return 'absent' as const;
            }
            if (!retirementRef.current || retirementRef.current.done()) {
                retirementRef.current = retireScalarImage(
                    map,
                    sourceId,
                    layerId,
                    ownedSource,
                    options.label,
                    options.credit,
                    (outcome) => {
                        if (outcome === 'absent') ownedSource = undefined;
                        if (retirementRef.current?.mapGone()) goneMapRef.current = map;
                        if (mounted.current)
                            setStatus(
                                retirementRef.current?.mapGone()
                                    ? 'off'
                                    : outcome === 'stuck-visible'
                                      ? 'stuck-visible'
                                      : latest.current.enabled
                                        ? 'unavailable'
                                        : 'off',
                            );
                    },
                );
            }
            retirementRef.current.retry();
            return retirementRef.current.state();
        };
        const refuse = () => {
            retired = true;
            const outcome = removeOwned();
            if (live && outcome !== 'stuck-visible') setStatus('unavailable');
        };
        const paint = () => {
            if (!current()) {
                refuse();
                return;
            }
            try {
                // A new style owns no previous ImageSource; keep only its current identity.
                if (ownedSource && map.getSource(sourceId) !== ownedSource) ownedSource = undefined;
                if (map.getSource(sourceId) && !ownedSource) {
                    refuse();
                    return;
                }
                setStatus('loading');
                const image = renderScalarGridImage(grid, stops, { width: 512, height: 512, bounds, check });
                check();
                const canvas = document.createElement('canvas');
                canvas.width = image.width;
                canvas.height = image.height;
                const context = canvas.getContext('2d');
                if (!context) throw new Error('Scalar canvas unavailable');
                const pixels = context.createImageData(image.width, image.height);
                pixels.data.set(image.data);
                context.putImageData(pixels, 0, 0);
                const url = canvas.toDataURL('image/png');
                // 512² PNG has a bounded worst-case encoding; reject browser errors.
                if (!url.startsWith('data:image/png;base64,') || url.length > 2 * 1024 * 1024)
                    throw new Error('Scalar image encoding failed');
                check();
                clearTimer();
                readyTimer = setTimeout(() => {
                    if (live) refuse();
                }, 10_000);
                if (ownedSource) {
                    (ownedSource as mapboxgl.ImageSource).updateImage({ url, coordinates: image.coordinates });
                } else {
                    map.addSource(sourceId, { type: 'image', url, coordinates: image.coordinates });
                    ownedSource = map.getSource(sourceId);
                    if (!ownedSource) throw new Error('Scalar image source not installed');
                    check();
                    map.addLayer(
                        {
                            id: layerId,
                            type: 'raster',
                            source: sourceId,
                            paint: {
                                'raster-opacity': 1,
                                'raster-fade-duration': 0,
                                'raster-resampling': 'nearest',
                            },
                        },
                        cloudOverlayBeforeId(map.getStyle()?.layers ?? []),
                    );
                }
                check();
            } catch {
                refuse();
            }
        };
        const sourceData = (event: mapboxgl.MapSourceDataEvent) => {
            try {
                if (event.sourceId !== sourceId || map.getSource(sourceId) !== ownedSource) return;
                if (!current()) {
                    refuse();
                    return;
                }
                if (event.sourceDataType === 'content' && map.isSourceLoaded(sourceId)) {
                    clearTimer();
                    setStatus('ready');
                }
            } catch {
                refuse();
            }
        };
        const sourceError = (event: unknown) => {
            if (typeof event === 'object' && event !== null && 'sourceId' in event && event.sourceId === sourceId)
                refuse();
        };
        const verify = () => {
            if (!retired && !current()) refuse();
        };
        verifyRef.current = verify;
        const healOrder = () => {
            if (!current()) {
                refuse();
                return;
            }
            try {
                if (!ownedSource || map.getSource(sourceId) !== ownedSource) return;
                const layers = map.getStyle()?.layers ?? [];
                const index = layers.findIndex((layer) => layer.id === layerId);
                const base = imageryTopIndex(layers);
                const chart = layers.findIndex((layer) => layer.id.startsWith('enc-vec-'));
                if (index < 0) return;
                // Several scalar overlays can share this interval without endlessly
                // moving one another to the same immediately-after-imagery slot.
                if (chart >= 0 && base >= chart) {
                    // No slot can clear both while the base is misplaced. Keep
                    // the chart readable until its own imagery healer runs.
                    if (index > chart) map.moveLayer(layerId, layers[chart].id);
                    return;
                }
                if (chart >= 0 && index > chart) {
                    map.moveLayer(layerId, layers[chart].id);
                    return;
                }
                if (index > base) return;
                const before = cloudOverlayBeforeId(layers.filter((layer) => layer.id !== layerId));
                if (before !== layerId) map.moveLayer(layerId, before);
            } catch {
                /* The next style event retries a transitional style. */
            }
        };
        map.on('sourcedata', sourceData);
        map.on('error', sourceError);
        map.on('style.load', paint);
        map.on('styledata', healOrder);
        const mapRemoved = () => {
            mapGone = true;
            goneMapRef.current = map;
            retired = true;
            ownedSource = undefined;
            clearTimer();
            if (mounted.current) setStatus('off');
        };
        map.on('remove', mapRemoved);
        document.addEventListener('visibilitychange', verify);
        const clock = setInterval(verify, 1000);
        paint();
        return () => {
            live = false;
            if (verifyRef.current === verify) verifyRef.current = null;
            clearInterval(clock);
            document.removeEventListener('visibilitychange', verify);
            map.off('sourcedata', sourceData);
            map.off('error', sourceError);
            map.off('style.load', paint);
            map.off('styledata', healOrder);
            map.off('remove', mapRemoved);
            removeOwned();
        };
        // Palette/bounds values are bounded scalar descriptions, not object-identity leases.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mapReady, enabled, grid, revision, id, boundsKey, paletteKey]);

    // A new callback identity may carry a retired proof without changing the
    // actual grid. Check it before paint, but do not recreate a healthy image
    // merely because a parent supplied an equivalent inline function.
    useLayoutEffect(() => {
        verifyRef.current?.();
    });

    return status;
}
