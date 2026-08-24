/**
 * Two storm-view defects Shane reported on 2026-08-23, both of which had
 * survived an earlier "fix" because the earlier fix was reasoned from source
 * rather than measured.
 *
 * 1. "the satellite imagery is still not showing" — third report. Rounds one
 *    and two both moved the layer's ANCHOR. They could not have worked. The
 *    GIBS Clean-IR tile was fetched and inspected on 2026-08-23:
 *
 *      HTTP 200, 76 080 B, PNG colour type 6 (RGBA), 256×256
 *      alpha == 255 on 100% of sampled pixels
 *      luminance clusters 96-160/255 (warm background); cold tops > 192
 *
 *    It is an OPAQUE image with a mid-grey sky, not an overlay. Below the
 *    base imagery it is hidden; above it, it greys out the world. No anchor
 *    can show cloud and keep the chart — the alpha has to come from the
 *    pixels, which is what raster-color does (and what the precip half of
 *    this very file already does with Rainbow's grayscale dbz).
 *
 * 2. "we need a way to select a different storm without having to go back
 *    through the menu" — the cyclone view locks the camera on the selected
 *    storm, so the other storms' markers are off-screen and untappable.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createStormSwitcher } from '../components/map/useCycloneLayer';
import type { ActiveCyclone } from '../services/weather/CycloneTrackingService';

const squall = readFileSync('components/map/useSquallMap.ts', 'utf8');
const ir = squall.slice(squall.indexOf('function mountSatelliteLayer'), squall.indexOf('function mountSquallLayer'));

describe('the storm cloud layer', () => {
    it('takes the tile’s own alpha, because the tile finally has one', () => {
        // SUPERSEDED 2026-08-24, and worth keeping the history: the GIBS build
        // needed a raster-color luminance ramp because Himawari Band 13 is
        // satellite IMAGERY, not an overlay — measured RGBA with alpha 255 on
        // 100% of sampled pixels, clear sky a mid-grey at 96-160/255. No
        // anchor could show it and keep the chart, so the alpha had to be
        // synthesised from brightness.
        //
        // OpenWeatherMap clouds_new is a real overlay. Measured 2026-08-24,
        // z3 Coral Sea tile, 90 810 B: colour type 6, 35% of sampled pixels at
        // alpha 0 and NOT ONE at 255. Ramping it would fight alpha that is
        // already correct.
        const code = ir.replace(/\/\/[^\n]*/g, '');
        expect(code).not.toContain("'raster-color'");
        expect(code).not.toContain("'raster-color-mix'");
        expect(code).toContain("'raster-opacity'");
    });

    it('resamples smoothly, now that it is overzoomed rather than capped', () => {
        // GIBS stopped at z6 and used 'nearest' — sharp edges on a product
        // that could not sharpen further anyway. clouds_new runs to z9 and is
        // a smooth field, so linear is the honest choice past native.
        expect(ir).toContain("'raster-resampling': 'linear'");
    });

    it('anchors above the imagery and below the chart, not on a moving layer', () => {
        // 'settlement-major-label' looks like a stable high-water mark and is
        // not: MapHub's ordering pass RELOCATES it to encBottom whenever
        // imagery is lit, which is precisely Shane's configuration.
        // The anchor list now lives in ONE place, shared by both cloud
        // implementations (the GIBS layer here and the RealEarth layer the
        // cyclone view mounts). Two subsystems that anchor differently is how
        // one of them ended up under an opaque satellite tile.
        const order = readFileSync('components/map/imageryOrder.ts', 'utf8');
        expect(order).toContain("['satellite-base-layer', 'hybrid-base-layer', 'maptiler-ocean-layer']");
        const code = ir.slice(ir.indexOf('const imageryIdx ='), ir.indexOf('map.addLayer('));
        expect(code).toContain('cloudOverlayBeforeId(styleLayers)');
        expect(code).not.toContain("'settlement-major-label'");
        // If raster-color is ever not honoured, the chart still paints over
        // an opaque IR — a cosmetic failure rather than a blanked map.
        expect(order).toContain("l.id.startsWith('enc-vec-')");
    });

    it('says where it landed, so a fourth report is one log line', () => {
        expect(ir).toContain('at layer ${idx}/${styleLayers.length}');
        expect(ir).toContain('imageryIdx=${imageryIdx}');
    });
});

const storm = (sid: string, name: string): ActiveCyclone =>
    ({ sid, name, currentPosition: { lat: -20, lon: 150 } }) as unknown as ActiveCyclone;

describe('storm switcher', () => {
    const all = [storm('c', 'Moke'), storm('a', 'Lala'), storm('b', 'Saudel')];

    it('is not rendered when there is nothing to switch to', () => {
        expect(createStormSwitcher([storm('a', 'Lala')], storm('a', 'Lala'), () => {})).toBeNull();
        expect(createStormSwitcher([], storm('a', 'Lala'), () => {})).toBeNull();
    });

    it('steps in a stable order, not the feed order', () => {
        // cyclonesRef is rebuilt by the 30-minute refresh in whatever order
        // the feed returned. Stepping must not depend on that, or "next"
        // twice could land you back where you started.
        const picked: string[] = [];
        const bar = createStormSwitcher(all, storm('a', 'Lala'), (s) => picked.push(s.name))!;
        const [prev, , next] = [...bar.children] as HTMLButtonElement[];
        next.click();
        prev.click();
        // Alphabetical: Lala(0) → Moke(1) forward, → Saudel(2) wrapping back.
        expect(picked).toEqual(['Moke', 'Saudel']);
    });

    it('wraps both ways so no storm is a dead end', () => {
        const picked: string[] = [];
        const bar = createStormSwitcher(all, storm('b', 'Saudel'), (s) => picked.push(s.name))!;
        ([...bar.children][2] as HTMLButtonElement).click(); // next off the end
        expect(picked).toEqual(['Lala']);
    });

    it('shows position and name, and takes taps the card would otherwise eat', () => {
        const bar = createStormSwitcher(all, storm('c', 'Moke'), () => {})!;
        expect(bar.textContent).toContain('2 / 3');
        expect(bar.textContent).toContain('Moke');
        // The card behind this bar toggles expand on click.
        const src = readFileSync('components/map/useCycloneLayer.ts', 'utf8');
        const fn = src.slice(src.indexOf('export function createStormSwitcher'), src.indexOf("bar.appendChild(arrow('‹'"));
        expect(fn).toContain('e.stopPropagation();');
        // Helm control on a moving boat.
        expect(fn).toContain('min-width:44px;min-height:36px');
    });
});
