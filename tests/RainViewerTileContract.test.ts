import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
    buildRainViewerTileUrl,
    normalizeRainViewerHost,
    RAINVIEWER_COLOR_SCHEME,
    RAINVIEWER_MAP_TILE_SIZE,
    RAINVIEWER_NATIVE_MAX_ZOOM,
    RAINVIEWER_TILE_HOST,
} from '../services/weather/api/rainviewerTiles';

const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('RainViewer tile contract', () => {
    it('pins the current provider limits and Universal Blue palette', () => {
        expect(RAINVIEWER_NATIVE_MAX_ZOOM).toBe(7);
        expect(RAINVIEWER_MAP_TILE_SIZE).toBe(512);
        expect(RAINVIEWER_COLOR_SCHEME).toBe(2);

        expect(
            buildRainViewerTileUrl('/v2/radar/4a75da0daf3a', {
                host: 'https://tilecache.rainviewer.com',
                zoom: '{z}',
                x: '{x}',
                y: '{y}',
            }),
        ).toBe('https://tilecache.rainviewer.com/v2/radar/4a75da0daf3a/512/{z}/{x}/{y}/2/1_1.png');
    });

    it('accepts only RainViewer-owned HTTPS hosts from the index', () => {
        expect(normalizeRainViewerHost('https://tilecache.rainviewer.com/path')).toBe(
            'https://tilecache.rainviewer.com',
        );
        expect(normalizeRainViewerHost('http://tilecache.rainviewer.com')).toBe(RAINVIEWER_TILE_HOST);
        expect(normalizeRainViewerHost('https://rainviewer.example.com')).toBe(RAINVIEWER_TILE_HOST);
        expect(normalizeRainViewerHost('not a url')).toBe(RAINVIEWER_TILE_HOST);
    });

    it('keeps every map source at the native ceiling so close zooms are overzoomed', () => {
        const chart = source('components/map/useWeatherLayers.ts');
        const embedded = source('components/map/useEmbeddedRain.ts');
        const mapHub = source('components/map/MapHub.tsx');

        for (const consumer of [chart, embedded]) {
            expect(consumer).toContain('tileSize: RAINVIEWER_MAP_TILE_SIZE');
            expect(consumer).toContain('maxzoom: RAINVIEWER_NATIVE_MAX_ZOOM');
        }
        expect(chart).not.toContain('maxzoom: 10');
        expect(mapHub).toContain('showEmbeddedRainViewerAttribution');
    });

    it('keeps Pi requests inside z0-7 and uses XYZ order with palette 2', () => {
        const route = source('pi-cache/src/routes/tiles.ts');
        const scheduler = source('pi-cache/src/scheduler.ts');

        expect(route).toContain('zoom > 7');
        expect(route).toContain('(?:\\d{10}|[a-f0-9]{12})');
        expect(route).toContain('/512/${zoom}/${tileX}/${tileY}/2/1_1.png');
        expect(scheduler).toContain('/512/${z}/${x}/${y}/2/1_1.png');
        expect(scheduler).not.toContain('${z}/${y}/${x}/4/1_1.png');
        expect(route).toContain('const key = `passthrough-tile:${url}`');
        expect(scheduler).toContain('const key = `passthrough-tile:${url}`');
    });

    it('validates Rainbow forecast and cloud zoom ranges at the server boundary', () => {
        const proxy = source('supabase/functions/proxy-rainbow/index.ts');

        expect(proxy).toContain("const maxZoom = layer === 'clouds' ? 7 : 12");
        expect(proxy).toContain('forecast % 600 !== 0');
    });
});
