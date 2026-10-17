import type mapboxgl from 'mapbox-gl';
import type { LocalChartDisplay } from '../../services/charts/localChartDisplay';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
} from '../../services/authIdentityScope';
import { toast } from '../Toast';

export type LocalChartPresentationStatus = 'loading' | 'displayed' | 'off' | 'unavailable' | 'stuck-visible';
const SOURCE = 'retained-local-chart-source',
    LAYER = 'retained-local-chart-layer';
/** One caller-owned raster; removal proof owns file/URL lifetime, including style and auth races. */
export function mountLocalChartPresentation(
    map: mapboxgl.Map,
    display: LocalChartDisplay,
    current: () => boolean,
    onStatus: (status: LocalChartPresentationStatus) => void,
) {
    const token = crypto.randomUUID();
    const scope = getAuthIdentityScope();
    let owned: ReturnType<mapboxgl.Map['getSource']>,
        retired = false,
        gone = false,
        released = false;
    let warning: number | undefined, readyTimer: ReturnType<typeof setTimeout> | undefined;
    let savedVisibility: string | undefined;
    let retiringBusy = false,
        everInstalled = false,
        contentSeen = false;
    const container = map.getContainer();
    const live = () => {
        try {
            return !retired && !gone && current() && display.isCurrent();
        } catch {
            return false;
        }
    };
    const layerOwned = () => {
        const layer = map.getLayer(LAYER);
        const metadata = layer && 'metadata' in layer ? layer.metadata : undefined;
        return (
            !!layer &&
            layer.type === 'raster' &&
            'source' in layer &&
            layer.source === SOURCE &&
            metadata !== null &&
            typeof metadata === 'object' &&
            'thalassaLocalChartOwner' in metadata &&
            metadata.thalassaLocalChartOwner === token
        );
    };
    const release = () => {
        if (released) return;
        released = true;
        clearTimeout(readyTimer);
        display.release();
        unsubscribe();
        clearInterval(clock);
        map.off('style.load', paint);
        map.off('sourcedata', loaded);
        map.off('error', error);
        map.off('idle', retry);
        map.off('styledata', retry);
        map.off('remove', removed);
        if (warning !== undefined) toast.dismiss(warning);
    };
    const unhideAfterCleanRender = () => {
        if (savedVisibility === undefined || gone) return;
        const prior = savedVisibility;
        const restore = () => {
            if (container.style.visibility === 'hidden' && !map.getSource(SOURCE) && !map.getLayer(LAYER)) {
                container.style.visibility = prior;
                savedVisibility = undefined;
            } else if (savedVisibility !== undefined) {
                onStatus('stuck-visible');
                warning = toast.persistentError(
                    'A private chart clearance was interrupted by an unexpected map change. Reopen Obs to clear it.',
                );
                map.once('remove', () => {
                    savedVisibility = undefined;
                    if (warning !== undefined) toast.dismiss(warning);
                });
            }
        };
        map.once('render', restore);
        map.triggerRepaint();
    };
    function retry() {
        if (!retired || released || retiringBusy) return;
        retiringBusy = true;
        try {
            if (gone || (!map.getSource(SOURCE) && !map.getLayer(LAYER))) {
                unhideAfterCleanRender();
                release();
                onStatus('off');
                return;
            }
            if (owned && map.getSource(SOURCE) === owned) {
                if (map.getLayer(LAYER) && !layerOwned()) throw new Error('Foreign local-chart layer');
                if (map.getLayer(LAYER)) map.removeLayer(LAYER);
                if (map.getLayer(LAYER)) throw new Error('Local-chart layer still present');
                map.removeSource(SOURCE);
                if (map.getSource(SOURCE)) throw new Error('Local-chart source still present');
                unhideAfterCleanRender();
                release();
                onStatus('off');
                return;
            }
        } catch {
            /* Keep the exact source/URL until absence is proved on a later lifecycle event. */
        } finally {
            retiringBusy = false;
        }
        onStatus('stuck-visible');
        if (warning === undefined)
            warning = toast.persistentError(
                'A private local chart could not be removed. Do not rely on this layer. Close and reopen Obs to clear it.',
                { label: 'Retry', onClick: retry },
            );
    }
    const retire = (privateFence = false) => {
        if (released) return;
        if ((privateFence || !isAuthIdentityScopeCurrent(scope)) && everInstalled && savedVisibility === undefined) {
            // Fence the previous account's already drawn pixels synchronously.
            // Restore only after a real render with our source/layer absent.
            savedVisibility = container.style.visibility;
            container.style.visibility = 'hidden';
        }
        retired = true;
        clearTimeout(readyTimer);
        retry();
    };
    function paint() {
        if (!live()) {
            retire();
            return;
        }
        try {
            if (owned && map.getSource(SOURCE) !== owned) {
                if (map.getSource(SOURCE)) {
                    retire();
                    return;
                }
                owned = undefined;
            }
            if ((map.getSource(SOURCE) && !owned) || (map.getLayer(LAYER) && !layerOwned())) {
                if (!everInstalled) {
                    release();
                    onStatus('unavailable');
                    return;
                }
                retire();
                return;
            }
            contentSeen = false;
            onStatus('loading');
            clearTimeout(readyTimer);
            if (!owned) {
                map.addSource(SOURCE, display.source);
                owned = map.getSource(SOURCE);
                if (!owned) throw new Error('Local chart source was not installed.');
                everInstalled = true;
            }
            if (!map.getLayer(LAYER)) {
                const before = map.getStyle()?.layers?.find((layer) => layer.type === 'symbol')?.id;
                map.addLayer(
                    {
                        id: LAYER,
                        type: 'raster',
                        source: SOURCE,
                        metadata: { thalassaLocalChartOwner: token },
                        paint: { 'raster-opacity': 1, 'raster-fade-duration': 0, 'raster-resampling': 'nearest' },
                    },
                    before,
                );
            }
            if (!contentSeen)
                readyTimer = setTimeout(() => {
                    retire();
                    onStatus(released ? 'unavailable' : 'stuck-visible');
                }, 10_000);
        } catch {
            retire();
            onStatus(released ? 'unavailable' : 'stuck-visible');
        }
    }
    function loaded(event: mapboxgl.MapSourceDataEvent) {
        if (event.sourceId !== SOURCE || !event.isSourceLoaded) return;
        if (!live() || map.getSource(SOURCE) !== owned || !layerOwned()) {
            retire();
            return;
        }
        contentSeen = true;
        clearTimeout(readyTimer);
        onStatus('displayed');
    }
    function error(event: mapboxgl.ErrorEvent) {
        if ('sourceId' in event && event.sourceId === SOURCE) {
            retire();
            onStatus(released ? 'unavailable' : 'stuck-visible');
        }
    }
    function removed() {
        gone = true;
        retired = true;
        savedVisibility = undefined;
        release();
        onStatus('off');
    }
    const unsubscribe = subscribeAuthIdentityScope(() => retire(true));
    const clock = setInterval(() => {
        if (!live()) retire();
    }, 1000);
    map.on('style.load', paint);
    map.on('sourcedata', loaded);
    map.on('error', error);
    map.on('idle', retry);
    map.on('styledata', retry);
    map.on('remove', removed);
    paint();
    return {
        retire: () => retire(),
        done: () => released && savedVisibility === undefined,
        verify: () => {
            if (!live()) retire();
        },
    };
}
