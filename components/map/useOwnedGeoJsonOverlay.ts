import { useLayoutEffect, useRef, useState, type MutableRefObject } from 'react';
import type mapboxgl from 'mapbox-gl';
import { cloudOverlayBeforeId, imageryTopIndex } from './imageryOrder';
import { retireScalarImage, type ScalarImageRetirement } from './scalarImageOwnership';
import type { ScalarOverlayStatus } from './useScalarGridOverlay';

type VectorLayer =
    | Omit<mapboxgl.LineLayerSpecification, 'id' | 'source'>
    | Omit<mapboxgl.SymbolLayerSpecification, 'id' | 'source'>;
export interface OwnedGeoJsonOverlayOptions {
    readonly namespace: string;
    readonly label: string;
    readonly credit: string;
    readonly enabled: boolean;
    readonly owner: object | null;
    readonly revision: string;
    readonly sourceCurrent: () => boolean;
    /** Stable caller-owned factory; may read nullable current bounds. No fetch or cache. */
    readonly createData: (map: mapboxgl.Map) => GeoJSON.FeatureCollection;
    readonly layers: readonly { readonly suffix: string; readonly specification: VectorLayer }[];
    readonly maxFeatures: number;
    readonly maxVertices: number;
    readonly refreshOnMoveEnd?: boolean;
}

/** Owned snapshot with bounded plain properties and Mercator-safe point/line geometry. */
export function boundedOverlayGeoJson(
    data: GeoJSON.FeatureCollection,
    maxFeatures: number,
    maxVertices: number,
): GeoJSON.FeatureCollection {
    if (
        !Number.isSafeInteger(maxFeatures) ||
        maxFeatures < 1 ||
        maxFeatures > 6032 ||
        !Number.isSafeInteger(maxVertices) ||
        maxVertices < 1 ||
        maxVertices > 120028 ||
        data?.type !== 'FeatureCollection' ||
        !Array.isArray(data.features) ||
        data.features.length > maxFeatures
    )
        throw new Error('Overlay feature bound exceeded');
    let vertices = 0,
        bytes = 64;
    const charge = (amount: number) => {
        bytes += amount;
        if (bytes > 4 * 1024 * 1024) throw new Error('Overlay byte bound exceeded');
    };
    const position = (value: GeoJSON.Position) => {
        if (
            !Array.isArray(value) ||
            value.length !== 2 ||
            !Number.isFinite(value[0]) ||
            !Number.isFinite(value[1]) ||
            Math.abs(value[0]) > 180 ||
            Math.abs(value[1]) > 85.05112878 ||
            ++vertices > maxVertices
        )
            throw new Error('Overlay coordinate bound exceeded');
        charge(String(value[0]).length + String(value[1]).length + 4);
        return [value[0], value[1]];
    };
    const line = (value: GeoJSON.Position[]) => {
        if (!Array.isArray(value) || value.length < 2 || value.length > maxVertices)
            throw new Error('Overlay line invalid');
        charge(2);
        return Array.from(value, position);
    };
    const features = Array.from(data.features, (feature): GeoJSON.Feature => {
        if (feature?.type !== 'Feature' || !feature.geometry) throw new Error('Overlay feature invalid');
        charge(128);
        const properties: Record<string, string | number | boolean | null> = Object.create(null);
        if (
            feature.properties !== null &&
            (typeof feature.properties !== 'object' || Array.isArray(feature.properties))
        )
            throw new Error('Overlay properties invalid');
        const keys = Object.keys(feature.properties ?? {});
        if (keys.length > 12) throw new Error('Overlay property bound exceeded');
        for (const key of keys) {
            const value: unknown = feature.properties![key];
            if (
                key.length > 64 ||
                (!['string', 'number', 'boolean'].includes(typeof value) && value !== null) ||
                (typeof value === 'string' && value.length > 256) ||
                (typeof value === 'number' && !Number.isFinite(value))
            )
                throw new Error('Overlay property invalid');
            charge(key.length * 6 + (typeof value === 'string' ? value.length * 6 : 32) + 8);
            properties[key] = value as string | number | boolean | null;
        }
        const geometry = feature.geometry;
        if (geometry.type === 'Point')
            return {
                type: 'Feature',
                geometry: { type: 'Point', coordinates: position(geometry.coordinates) },
                properties,
            };
        if (geometry.type === 'LineString')
            return {
                type: 'Feature',
                geometry: { type: 'LineString', coordinates: line(geometry.coordinates) },
                properties,
            };
        if (
            geometry.type !== 'MultiLineString' ||
            !Array.isArray(geometry.coordinates) ||
            geometry.coordinates.length > maxVertices
        )
            throw new Error('Overlay geometry invalid');
        return {
            type: 'Feature',
            geometry: { type: 'MultiLineString', coordinates: Array.from(geometry.coordinates, line) },
            properties,
        };
    });
    return { type: 'FeatureCollection', features };
}

/** One bounded frame and source. No transport, geometry history, persistence or camera changes. */
export function useOwnedGeoJsonOverlay(
    mapRef: MutableRefObject<mapboxgl.Map | null>,
    mapReady: boolean,
    options: OwnedGeoJsonOverlayOptions,
): ScalarOverlayStatus {
    const [status, setStatus] = useState<ScalarOverlayStatus>('off');
    const latest = useRef(options),
        pending = useRef<ScalarImageRetirement | null>(null);
    const goneMap = useRef<mapboxgl.Map | null>(null),
        mounted = useRef(false);
    latest.current = options;
    const {
        namespace,
        enabled,
        owner,
        revision,
        sourceCurrent,
        createData,
        layers,
        maxFeatures,
        maxVertices,
        refreshOnMoveEnd,
    } = options;
    useLayoutEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);
    useLayoutEffect(() => {
        const map = mapRef.current;
        if (map && goneMap.current === map) {
            setStatus('off');
            return;
        }
        if (!map || !mapReady) {
            setStatus(enabled ? 'unavailable' : 'off');
            return;
        }
        if (
            !/^[a-z][a-z0-9-]{0,47}$/.test(namespace) ||
            layers.length < 1 ||
            layers.length > 6 ||
            new Set(layers.map((item) => item.suffix)).size !== layers.length ||
            layers.some(
                (item) =>
                    !/^[a-z][a-z0-9-]{0,23}$/.test(item.suffix) ||
                    !['line', 'symbol'].includes(item.specification.type),
            )
        ) {
            setStatus('unavailable');
            return;
        }
        const sourceId = `${namespace}-source`,
            ids = layers.map((item) => `${namespace}-${item.suffix}`);
        let live = true,
            retired = false,
            parsed = false;
        let source: ReturnType<mapboxgl.Map['getSource']>;
        let readyTimer: ReturnType<typeof setTimeout> | undefined,
            orderTimer: ReturnType<typeof setTimeout> | undefined,
            lifecycleTimer: ReturnType<typeof setTimeout> | undefined,
            moveTimer: ReturnType<typeof setTimeout> | undefined;
        const publish = (value: ScalarOverlayStatus) => {
            if (live && mounted.current) setStatus(value);
        };
        const current = () => {
            try {
                return (
                    live &&
                    enabled &&
                    owner !== null &&
                    latest.current.enabled &&
                    latest.current.owner === owner &&
                    latest.current.revision === revision &&
                    sourceCurrent() &&
                    latest.current.sourceCurrent()
                );
            } catch {
                return false;
            }
        };
        const clearTimers = () => {
            for (const timer of [readyTimer, orderTimer, lifecycleTimer, moveTimer])
                if (timer !== undefined) clearTimeout(timer);
            readyTimer = orderTimer = lifecycleTimer = moveTimer = undefined;
        };
        const retirementState = () => {
            if (pending.current?.mapGone()) goneMap.current = map;
            publish(
                goneMap.current === map
                    ? 'off'
                    : pending.current?.state() === 'stuck-visible'
                      ? 'stuck-visible'
                      : latest.current.enabled
                        ? 'unavailable'
                        : 'off',
            );
        };
        const retire = () => {
            clearTimers();
            retired = true;
            if (goneMap.current === map) {
                publish('off');
                return;
            }
            if (!pending.current || pending.current.done())
                pending.current = retireScalarImage(
                    map,
                    sourceId,
                    ids,
                    source,
                    options.label,
                    options.credit,
                    retirementState,
                );
            pending.current.retry();
            retirementState();
        };
        const owned = () =>
            map.getSource(sourceId) === source &&
            ids.every((id, index) => {
                const layer = map.getLayer(id);
                return (
                    layer &&
                    layer.type === layers[index].specification.type &&
                    'source' in layer &&
                    layer.source === sourceId
                );
            });
        const verify = () => {
            if (!live || retired) return;
            if (!current()) {
                retire();
                return;
            }
            try {
                if (!source || !owned()) {
                    retire();
                    return;
                }
                const stack = map.getStyle()?.layers ?? [],
                    base = imageryTopIndex(stack),
                    chart = stack.findIndex((layer) => layer.id.startsWith('enc-vec-'));
                if (
                    ids.some((id) => {
                        const index = stack.findIndex((layer) => layer.id === id);
                        return (
                            index >= 0 &&
                            (chart >= 0 && base >= chart
                                ? index > chart
                                : index < base || (chart >= 0 && index > chart))
                        );
                    }) &&
                    orderTimer === undefined
                )
                    orderTimer = setTimeout(() => {
                        orderTimer = undefined;
                        if (!current() || retired) return;
                        try {
                            if (!owned()) {
                                retire();
                                return;
                            }
                            const before = (map.getStyle()?.layers ?? []).find((layer) =>
                                layer.id.startsWith('enc-vec-'),
                            )?.id;
                            for (const id of ids) map.moveLayer(id, before);
                        } catch {
                            retire();
                        }
                    }, 0);
                if (parsed && map.isSourceLoaded(sourceId)) {
                    if (readyTimer !== undefined) clearTimeout(readyTimer);
                    readyTimer = undefined;
                    publish('ready');
                }
            } catch {
                retire();
            }
        };
        const mount = () => {
            if (!live || retired || !current()) return;
            pending.current?.retry();
            if (pending.current && !pending.current.done()) {
                retirementState();
                return;
            }
            try {
                if (source && map.getSource(sourceId) === source) {
                    verify();
                    return;
                }
                if (map.getSource(sourceId) || ids.some((id) => map.getLayer(id))) {
                    retire();
                    return;
                }
                publish('loading');
                parsed = false;
                const data = boundedOverlayGeoJson(createData(map), maxFeatures, maxVertices);
                if (!current()) {
                    retire();
                    return;
                }
                const before = cloudOverlayBeforeId(map.getStyle()?.layers ?? []);
                map.addSource(sourceId, { type: 'geojson', data });
                source = map.getSource(sourceId);
                if (!source) throw new Error('Overlay source not installed');
                for (let index = 0; index < layers.length; index++) {
                    if (!current()) {
                        retire();
                        return;
                    }
                    map.addLayer({ ...layers[index].specification, id: ids[index], source: sourceId }, before);
                }
                readyTimer = setTimeout(retire, 10_000);
                verify();
            } catch {
                retire();
            }
        };
        const styleLoaded = () => {
            if (!current()) {
                retire();
                return;
            }
            try {
                if (!map.getSource(sourceId)) source = undefined;
            } catch {
                retire();
                return;
            }
            retired = false;
            mount();
        };
        const sourceData = (event: mapboxgl.MapSourceDataEvent) => {
            // First successful GeoJSON worker parse is metadata; subsequent loads are content.
            if (event.sourceId !== sourceId || !['metadata', 'content'].includes(event.sourceDataType ?? '')) return;
            parsed = true;
            verify();
        };
        const removed = () => {
            goneMap.current = map;
            retired = true;
            clearTimers();
            publish('off');
        };
        const lifecycle = () => {
            if (lifecycleTimer !== undefined || retired) return;
            lifecycleTimer = setTimeout(() => {
                lifecycleTimer = undefined;
                mount();
            }, 0);
        };
        const moveEnd = () => {
            if (!refreshOnMoveEnd || moveTimer !== undefined || retired) return;
            moveTimer = setTimeout(() => {
                moveTimer = undefined;
                if (!current()) {
                    retire();
                    return;
                }
                // Replace rather than setData: the new worker completion has its own source identity.
                retire();
                if (!pending.current?.done() || !current()) return;
                source = undefined;
                retired = false;
                mount();
            }, 100);
        };
        map.on('style.load', styleLoaded);
        map.on('sourcedata', sourceData);
        map.on('styledata', lifecycle);
        map.on('idle', lifecycle);
        map.on('remove', removed);
        map.on('moveend', moveEnd);
        const interval = setInterval(() => (source ? verify() : mount()), 1000);
        if (enabled && owner) mount();
        else retire();
        return () => {
            live = false;
            clearInterval(interval);
            clearTimers();
            map.off('style.load', styleLoaded);
            map.off('sourcedata', sourceData);
            map.off('styledata', lifecycle);
            map.off('idle', lifecycle);
            map.off('remove', removed);
            map.off('moveend', moveEnd);
            retire();
        };
    }, [
        mapRef,
        mapReady,
        namespace,
        enabled,
        owner,
        revision,
        sourceCurrent,
        createData,
        layers,
        maxFeatures,
        maxVertices,
        refreshOnMoveEnd,
        options.label,
        options.credit,
    ]);
    return status;
}
