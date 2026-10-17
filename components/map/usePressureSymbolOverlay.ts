import { useLayoutEffect, useRef, useState, type MutableRefObject } from 'react';
import type mapboxgl from 'mapbox-gl';
import type { AtmosView } from '../../services/weather/api/atmosSession';
import { atmosPressureSymbols } from '../../services/weather/atmosPressure';
import { retireScalarImage, type ScalarImageRetirement } from './scalarImageOwnership';
import type { ScalarOverlayStatus } from './useScalarGridOverlay';
import { cloudOverlayBeforeId, imageryTopIndex } from './imageryOrder';

const SOURCE = 'atmos-pressure-symbols';
const IDS = ['atmos-pressure-lines', 'atmos-pressure-labels', 'atmos-pressure-centers'] as const;

/** One selected, bounded GeoJSON frame; its source identity is retained until proven absent. */
export function usePressureSymbolOverlay(
    mapRef: MutableRefObject<mapboxgl.Map | null>,
    mapReady: boolean,
    enabled: boolean,
    view: AtmosView | null,
    credit: string,
): ScalarOverlayStatus {
    const [status, setStatus] = useState<ScalarOverlayStatus>('off');
    const latest = useRef({ enabled, view });
    latest.current = { enabled, view };
    const pending = useRef<ScalarImageRetirement[]>([]);
    const goneMap = useRef<mapboxgl.Map | null>(null);
    const mounted = useRef(false);
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
        let live = true,
            retired = false;
        let source: ReturnType<mapboxgl.Map['getSource']>;
        let contentSeen = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let lifecycleTimer: ReturnType<typeof setTimeout> | undefined;
        let orderTimer: ReturnType<typeof setTimeout> | undefined;
        const publish = (next: ScalarOverlayStatus) => {
            if (live && mounted.current) setStatus(next);
        };
        const current = () => {
            try {
                return (
                    enabled &&
                    view !== null &&
                    latest.current.enabled &&
                    latest.current.view === view &&
                    view.isCurrent()
                );
            } catch {
                return false;
            }
        };
        const clearTimer = () => {
            if (timer !== undefined) clearTimeout(timer);
            if (lifecycleTimer !== undefined) clearTimeout(lifecycleTimer);
            if (orderTimer !== undefined) clearTimeout(orderTimer);
            timer = undefined;
            lifecycleTimer = undefined;
            orderTimer = undefined;
        };
        const retire = () => {
            clearTimer();
            retired = true;
            if (goneMap.current === map) {
                publish('off');
                return;
            }
            if (pending.current.every((item) => item.done())) {
                pending.current = IDS.map((id) =>
                    retireScalarImage(map, SOURCE, id, source, 'Pressure contours', credit, () => {
                        const removed = pending.current.some((item) => item.mapGone());
                        if (removed) goneMap.current = map;
                        const stuck = pending.current.some((item) => !item.done() && item.state() === 'stuck-visible');
                        publish(
                            removed ? 'off' : stuck ? 'stuck-visible' : latest.current.enabled ? 'unavailable' : 'off',
                        );
                    }),
                );
            }
            for (const item of pending.current) item.retry();
            for (const item of pending.current) item.retry();
            const stuck = pending.current.some((item) => !item.done() && item.state() === 'stuck-visible');
            publish(stuck ? 'stuck-visible' : enabled ? 'unavailable' : 'off');
        };
        const verify = () => {
            if (!live || retired) return;
            if (!current()) {
                retire();
                return;
            }
            try {
                if (
                    map.getSource(SOURCE) !== source ||
                    IDS.some((id) => {
                        const layer = map.getLayer(id);
                        return !layer || !('source' in layer) || layer.source !== SOURCE;
                    })
                ) {
                    retire();
                    return;
                }
                const layers = map.getStyle()?.layers ?? [];
                const base = imageryTopIndex(layers),
                    chart = layers.findIndex((layer) => layer.id.startsWith('enc-vec-'));
                const misplaced = IDS.some((id) => {
                    const index = layers.findIndex((layer) => layer.id === id);
                    return (
                        index >= 0 &&
                        (chart >= 0 && base >= chart ? index > chart : index < base || (chart >= 0 && index > chart))
                    );
                });
                if (misplaced && orderTimer === undefined)
                    orderTimer = setTimeout(() => {
                        orderTimer = undefined;
                        if (!current() || retired) return;
                        try {
                            if (map.getSource(SOURCE) !== source) {
                                retire();
                                return;
                            }
                            const fresh = map.getStyle()?.layers ?? [];
                            const enc = fresh.find((layer) => layer.id.startsWith('enc-vec-'))?.id;
                            for (const id of IDS) if (map.getLayer(id)) map.moveLayer(id, enc);
                        } catch {
                            retire();
                        }
                    }, 0);
                if (contentSeen && map.isSourceLoaded(SOURCE)) {
                    if (timer !== undefined) clearTimeout(timer);
                    timer = undefined;
                    publish('ready');
                }
            } catch {
                retire();
            }
        };
        const mount = () => {
            if (!live || retired || !current()) return;
            for (const item of pending.current) item.retry();
            if (pending.current.some((item) => !item.done())) {
                publish('stuck-visible');
                return;
            }
            try {
                if (source && map.getSource(SOURCE) === source) {
                    verify();
                    return;
                }
                if (map.getSource(SOURCE) || IDS.some((id) => map.getLayer(id))) {
                    retire();
                    return;
                }
                publish('loading');
                contentSeen = false;
                const symbols = atmosPressureSymbols(view!);
                if (!current()) {
                    retire();
                    return;
                }
                const data: GeoJSON.FeatureCollection = {
                    type: 'FeatureCollection',
                    features: [...symbols.contours.features, ...symbols.centers.features],
                };
                const before = cloudOverlayBeforeId(map.getStyle()?.layers ?? []);
                map.addSource(SOURCE, { type: 'geojson', data });
                source = map.getSource(SOURCE);
                if (!source) throw new Error('Pressure source not installed');
                map.addLayer(
                    {
                        id: IDS[0],
                        type: 'line',
                        source: SOURCE,
                        filter: ['==', '$type', 'LineString'],
                        paint: {
                            'line-color': '#bae6fd',
                            'line-width': ['case', ['get', 'isMajor'], 1.8, 0.8],
                            'line-opacity': 0.8,
                        },
                    },
                    before,
                );
                map.addLayer(
                    {
                        id: IDS[1],
                        type: 'symbol',
                        source: SOURCE,
                        filter: ['all', ['==', '$type', 'LineString'], ['==', 'isDetail', false]],
                        layout: { 'symbol-placement': 'line', 'text-field': ['get', 'label'], 'text-size': 11 },
                        paint: { 'text-color': '#e0f2fe', 'text-halo-color': '#020617', 'text-halo-width': 1.5 },
                    },
                    before,
                );
                map.addLayer(
                    {
                        id: IDS[2],
                        type: 'symbol',
                        source: SOURCE,
                        filter: ['==', '$type', 'Point'],
                        layout: { 'text-field': ['get', 'label'], 'text-size': 17 },
                        paint: { 'text-color': '#e0f2fe', 'text-halo-color': '#020617', 'text-halo-width': 2 },
                    },
                    before,
                );
                timer = setTimeout(retire, 10_000);
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
                if (!map.getSource(SOURCE)) source = undefined;
            } catch {
                retire();
                return;
            }
            retired = false;
            mount();
        };
        const removed = () => {
            goneMap.current = map;
            retired = true;
            clearTimer();
            publish('off');
        };
        const sourceData = (event: mapboxgl.MapSourceDataEvent) => {
            // GeoJSONSource emits metadata after its first successful worker parse,
            // then content for subsequent updates. Both belong to this new source.
            if (
                event.sourceId !== SOURCE ||
                (event.sourceDataType !== 'content' && event.sourceDataType !== 'metadata')
            )
                return;
            contentSeen = true;
            verify();
        };
        const lifecycle = () => {
            if (lifecycleTimer !== undefined || retired) return;
            lifecycleTimer = setTimeout(() => {
                lifecycleTimer = undefined;
                mount();
            }, 0);
        };
        map.on('style.load', styleLoaded);
        map.on('sourcedata', sourceData);
        map.on('styledata', lifecycle);
        map.on('idle', lifecycle);
        map.on('remove', removed);
        const interval = setInterval(verify, 1000);
        if (enabled && view) mount();
        else retire();
        return () => {
            live = false;
            clearInterval(interval);
            clearTimer();
            map.off('style.load', styleLoaded);
            map.off('sourcedata', sourceData);
            map.off('styledata', lifecycle);
            map.off('idle', lifecycle);
            map.off('remove', removed);
            retire();
        };
    }, [mapRef, mapReady, enabled, view, credit]);
    return status;
}
