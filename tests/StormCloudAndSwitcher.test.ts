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

describe('the IR cloud gets its alpha from the pixels', () => {
    it('ramps brightness to colour+alpha instead of relying on the stack', () => {
        expect(ir).toContain("'raster-color'");
        expect(ir).toContain("'raster-color-range': [0, 1]");
        // Luminance weights, not a single channel: the product is near-grey
        // but measurably not R==G==B.
        expect(ir).toContain("'raster-color-mix': [0.2126, 0.7152, 0.0722, 0]");
    });

    it('makes the measured clear-sky band fully transparent', () => {
        // Warm background measured at 96-160/255 → 0.38-0.63 normalised. The
        // ramp must still be at alpha 0 above that band, or clear sky paints
        // grey over the chart.
        const ramp = ir.slice(ir.indexOf("'raster-color': ["), ir.indexOf('},\n            },'));
        expect(ramp).toContain('0.64,\n                        \'rgba(255,255,255,0)\'');
        // …and cold tops must actually be visible.
        expect(ramp).toMatch(/1\.0,\s*'rgba\(255,255,255,0\.9\d\)'/);
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
