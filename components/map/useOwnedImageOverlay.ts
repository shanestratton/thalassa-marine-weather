import { useLayoutEffect, useRef, useState, type MutableRefObject } from 'react';
import type mapboxgl from 'mapbox-gl';
import { cloudOverlayBeforeId, imageryTopIndex } from './imageryOrder';
import { retireScalarImage, type ScalarImageRetirement } from './scalarImageOwnership';

export type OwnedImageStatus = 'off' | 'loading' | 'ready' | 'unavailable' | 'stuck-visible';
export interface OwnedImageFrame {
    /** Caller-validated PNG, already bounded before decoding. No remote URL/refetch. */
    readonly url: string;
    readonly width: number;
    readonly height: number;
    readonly coordinates: [[number, number], [number, number], [number, number], [number, number]];
    /** Process-local idempotent release; ownership transfers to the renderer. */
    readonly release?: () => void;
}
export interface OwnedImageOverlayOptions {
    readonly id: string;
    readonly label: string;
    readonly credit: string;
    readonly enabled: boolean;
    readonly owner: object | null;
    readonly revision: string;
    readonly sourceCurrent: () => boolean;
    /** Stable synchronous factory for this owner/revision; one prepared frame per lifecycle. */
    readonly prepare: (check: () => void) => OwnedImageFrame;
    readonly maxEdge: 512 | 1024;
}
export function validateOwnedImageFrame(frame: OwnedImageFrame, maxEdge: 512 | 1024): void {
    if (
        ![512, 1024].includes(maxEdge) ||
        !Number.isInteger(frame.width) ||
        !Number.isInteger(frame.height) ||
        frame.width < 1 ||
        frame.height < 1 ||
        frame.width > maxEdge ||
        frame.height > maxEdge ||
        frame.url.length > (maxEdge === 512 ? 2 : 3) * 1024 * 1024 ||
        !(
            frame.url.startsWith('data:image/png;base64,') ||
            (frame.url.startsWith('blob:') &&
                !!frame.release &&
                new URL(frame.url).origin === new URL(location.href).origin)
        )
    )
        throw new Error('Owned image frame invalid');
    const c = frame.coordinates;
    if (
        !Array.isArray(c) ||
        c.length !== 4 ||
        c.some(
            (point) =>
                !Array.isArray(point) ||
                point.length !== 2 ||
                !point.every(Number.isFinite) ||
                Math.abs(point[0]) > 540 ||
                Math.abs(point[1]) > 85.05112878,
        ) ||
        c[0][0] !== c[3][0] ||
        c[1][0] !== c[2][0] ||
        c[0][1] !== c[1][1] ||
        c[2][1] !== c[3][1] ||
        c[0][0] >= c[1][0] ||
        c[0][1] <= c[2][1] ||
        c[1][0] - c[0][0] > 360
    )
        throw new Error('Owned image corners invalid');
}

/**
 * One owned image/texture, no fetch, durable cache, camera move or frame history.
 * A different revision retires the old presentation before the replacement loads.
 * The caller owns the source lease and must keep it through this hook's lifetime.
 * Keep the supplied attribution in the credit rollup while status is stuck-visible,
 * even after user-off; only proven absent/hidden presentation may read off.
 */
export function useOwnedImageOverlay(
    mapRef: MutableRefObject<mapboxgl.Map | null>,
    mapReady: boolean,
    options: OwnedImageOverlayOptions,
): OwnedImageStatus {
    const [status, setStatus] = useState<OwnedImageStatus>('off');
    const latest = useRef(options);
    const verifyRef = useRef<(() => void) | null>(null);
    const retirementRef = useRef<ScalarImageRetirement | null>(null);
    const mounted = useRef(false);
    const goneMapRef = useRef<mapboxgl.Map | null>(null);
    latest.current = options;
    const { id, enabled, owner, revision, sourceCurrent, prepare, maxEdge } = options;

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
        if (!/^[a-z][a-z0-9-]{0,63}$/.test(id) || !owner) {
            setStatus('unavailable');
            return;
        }
        const sourceId = `${id}-source`;
        const layerId = `${id}-layer`;
        let live = true;
        let retired = false;
        let mapGone = false;
        let ownedSource: ReturnType<mapboxgl.Map['getSource']>;
        let contentSeen = false;
        let prepared: OwnedImageFrame | null = null;
        let released = false;
        const release = () => {
            if (released || !prepared) return;
            released = true;
            try {
                prepared.release?.();
            } finally {
                prepared = null;
            }
        };
        let readyTimer: ReturnType<typeof setTimeout> | null = null;

        const current = (): boolean => {
            try {
                return (
                    live &&
                    !retired &&
                    mapRef.current === map &&
                    latest.current.enabled &&
                    latest.current.owner === owner &&
                    latest.current.prepare === prepare &&
                    latest.current.revision === revision &&
                    sourceCurrent() &&
                    latest.current.sourceCurrent()
                );
            } catch {
                return false;
            }
        };
        const check = () => {
            if (!current()) throw new DOMException('Image source retired', 'AbortError');
        };
        const clearTimer = () => {
            if (readyTimer !== null) clearTimeout(readyTimer);
            readyTimer = null;
        };
        const presentationOwned = (): boolean => {
            try {
                const layer = map.getLayer(layerId);
                return (
                    !!ownedSource &&
                    map.getSource(sourceId) === ownedSource &&
                    !!layer &&
                    layer.type === 'raster' &&
                    'source' in layer &&
                    layer.source === sourceId
                );
            } catch {
                return false;
            }
        };
        const removeOwned = () => {
            clearTimer();
            if (mapGone) {
                ownedSource = undefined;
                release();
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
                        if (outcome === 'absent') {
                            ownedSource = undefined;
                            release();
                        }
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
                if (map.getLayer(layerId) && !presentationOwned()) {
                    refuse();
                    return;
                }
                setStatus('loading');
                if (!prepared) {
                    prepared = prepare(check);
                    validateOwnedImageFrame(prepared, maxEdge);
                    prepared = {
                        ...prepared,
                        coordinates: prepared.coordinates.map((point) => [...point]) as OwnedImageFrame['coordinates'],
                    };
                }
                const image = prepared,
                    url = image.url;
                check();
                clearTimer();
                contentSeen = false;
                readyTimer = setTimeout(() => {
                    if (live) refuse();
                }, 10_000);
                if (ownedSource) {
                    (ownedSource as mapboxgl.ImageSource).updateImage({ url, coordinates: image.coordinates });
                } else {
                    map.addSource(sourceId, { type: 'image', url, coordinates: image.coordinates });
                    ownedSource = map.getSource(sourceId);
                    if (!ownedSource) throw new Error('Owned image source not installed');
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
                if (event.sourceDataType === 'content') contentSeen = true;
                if (contentSeen && presentationOwned() && map.isSourceLoaded(sourceId)) {
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
            else if (!retired && contentSeen) {
                try {
                    if (!presentationOwned()) {
                        refuse();
                        return;
                    }
                    if (map.isSourceLoaded(sourceId)) {
                        clearTimer();
                        setStatus('ready');
                    }
                } catch {
                    refuse();
                }
            }
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
            release();
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
        // Callback identity may change inline; its latest current proof is checked separately.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mapReady, enabled, owner, revision, id, prepare, maxEdge]);

    // A new callback identity may carry a retired proof without changing the
    // actual image owner. Check it before paint, but do not recreate a healthy image
    // merely because a parent supplied an equivalent inline function.
    useLayoutEffect(() => {
        verifyRef.current?.();
    });

    return status;
}
