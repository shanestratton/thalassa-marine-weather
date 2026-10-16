/** Synthetic public terrain, real downloader, real service worker and real Mapbox renderer. */
import mapboxgl from 'mapbox-gl';
import { downloadReliefArea, hydrateRelief, reliefStorage } from '../../services/OfflineReliefService';
import { offlineReliefUrl, subscribeOfflineRelief } from '../../services/offlineReliefRuntime';
import { initialReliefMapStyle } from '../../services/initialReliefMapStyle';
import { RELIEF_WEB_CACHE, RELIEF_WEB_MANIFEST_PATH } from '../../services/offlineReliefPlan';
import {
    addReliefBase,
    offlineReliefStyle,
    reloadReliefSources,
    RELIEF_LAYER_IDS,
    setReliefPalette,
} from '../../components/map/reliefBase';

const errors: string[] = [];
let cacheBeforeHydrate: unknown;
const ready = (async () => {
    const cache = await caches.open(RELIEF_WEB_CACHE);
    const index = await cache.match(new URL(RELIEF_WEB_MANIFEST_PATH, location.href).href);
    const manifest = index ? await index.json() : null;
    const keys = await cache.keys();
    cacheBeforeHydrate = { keys: keys.length, manifestRows: manifest?.tiles?.length ?? null };
    await hydrateRelief();
    mapboxgl.accessToken = 'pk.fixture-offline-terrain';
    const initialStyle = reliefStorage().tiles
        ? await initialReliefMapStyle(
              'mapbox://styles/mapbox/dark-v11',
              'pk.fixture-offline-terrain',
              new AbortController().signal,
          )
        : offlineReliefStyle();
    const map = new mapboxgl.Map({
        container: 'map',
        style: initialStyle,
        center: [1.05, 0.95],
        zoom: 4,
        attributionControl: true,
        fadeDuration: 0,
        preserveDrawingBuffer: true,
        transformRequest: (url, type) => ({ url: type === 'Tile' ? (offlineReliefUrl(url) ?? url) : url }),
    });
    map.on('error', (event) => errors.push(event.error?.message ?? 'Map rendering error'));
    subscribeOfflineRelief(() => {
        if (map.getSource('relief-global-idx')) reloadReliefSources(map);
    });
    await new Promise<void>((resolve) =>
        map.on('load', () => {
            addReliefBase(map);
            for (const id of RELIEF_LAYER_IDS) map.setLayoutProperty(id, 'visibility', 'visible');
            setReliefPalette(map, 'day');
            resolve();
        }),
    );
    return map;
})();
Object.assign(window, {
    __offlineRelief: {
        ready: () => ready.then(() => true),
        save: async () => {
            const map = await ready,
                b = map.getBounds()!;
            let result: unknown;
            await downloadReliefArea(
                { north: b.getNorth(), south: b.getSouth(), west: b.getWest(), east: b.getEast() },
                4,
                'https://tiles.thalassatiles.com/v1',
                new AbortController().signal,
                (p) => {
                    result = p;
                },
            );
            return { storage: reliefStorage(), result };
        },
        probe: async () => {
            const map = await ready;
            if (!map.loaded())
                await new Promise<void>((resolve) => {
                    map.once('idle', () => resolve());
                    map.triggerRepaint();
                });
            // Tile/source readiness can precede its first completed draw on
            // WebKit's software GPU. Read the pixels from a fresh render,
            // rather than an earlier frame containing only the background.
            await new Promise<void>((resolve) => {
                map.once('render', () => resolve());
                map.triggerRepaint();
            });
            const c = map.getCanvas(),
                gl = c.getContext('webgl2')!,
                rgba = new Uint8Array(4);
            gl.readPixels(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
            return {
                pixel: [...rgba],
                loaded: map.isSourceLoaded('relief-global-idx'),
                storage: reliefStorage(),
                offline: navigator.onLine === false,
                attribution: document.querySelector('.mapboxgl-ctrl-attrib')?.textContent,
                errors: errors.slice(-12),
                cacheBeforeHydrate,
            };
        },
    },
});
