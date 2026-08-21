/**
 * Past and forecast rain must speak ONE colour language.
 *
 * The chart paints observed rain with RainViewer's server-baked palette and
 * forecast rain with an in-app ramp over grayscale dBZ tiles. Those are two
 * different rendering models, so nothing but a test keeps them describing the
 * same intensity scale — and when they drifted (observed baked at scheme 2,
 * forecast ramped to scheme 4) the chart changed its entire colour language
 * mid-scrub and the legend described colours the NOW frame never showed
 * (Shane, 2026-08-21).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RAINVIEWER_COLOR_SCHEME, buildRainViewerTileUrl } from '../services/weather/api/rainviewerTiles';

const read = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8');

/** The Weather Channel scheme — warm, high-contrast, what the ramp targets. */
const UNIFIED_SCHEME = 4;

describe('one palette, past and future', () => {
    it('observed tiles are baked in the scheme the forecast ramp targets', () => {
        expect(RAINVIEWER_COLOR_SCHEME).toBe(UNIFIED_SCHEME);
        const url = buildRainViewerTileUrl('/v2/radar/123', { zoom: 7, x: 1, y: 2 });
        expect(url).toContain(`/${UNIFIED_SCHEME}/1_1.png`);
    });

    it('the forecast ramp still declares which scheme it speaks', () => {
        // A ramp rewrite that forgets the scheme pairing is exactly how these
        // two halves drifted apart the first time.
        const ramp = read('components/map/isobarLayerSetup.ts');
        expect(ramp).toContain('RAINVIEWER_COLOR_RAMP');
        expect(ramp).toMatch(/scheme 4/i);
    });

    it('every surface builds its tiles through the one authority', () => {
        // Obs map, Glass hero radar and the chart page must not hand-roll a
        // URL with their own scheme digit.
        for (const file of [
            'components/map/useWeatherLayers.ts',
            'components/dashboard/hero/radarGlassEngine.ts',
        ]) {
            const source = read(file);
            expect(source).toContain('buildRainViewerTileUrl');
            // No literal RainViewer tile path with an inline scheme.
            expect(source).not.toMatch(/tilecache\.rainviewer\.com[^`'"]*\/\d\/1_1\.png/);
        }
    });
});

describe('rain reads as weather, not a stain', () => {
    it('radar and forecast frames share opacity AND enhancement', () => {
        const layers = read('components/map/useWeatherLayers.ts');
        // Both paint blocks carry the same three dials — one treatment, so
        // scrubbing across "now" changes the data, never the look.
        expect(layers.match(/'raster-saturation': RAIN_FRAME_SATURATION/g)?.length).toBe(2);
        expect(layers.match(/'raster-contrast': RAIN_FRAME_CONTRAST/g)?.length).toBe(2);
        expect(layers.match(/'raster-opacity': RAIN_FRAME_OPACITY/g)?.length).toBe(2);
    });
});
