/**
 * The observed satellite cloud layer (W1-10): NOAA/NESDIS GMGSI longwave IR,
 * one image per frame from nowCOAST's WMS, anchored on the phone and coloured
 * on the GPU.
 *
 * Every number pinned here was MEASURED against the live service on
 * 2026-10-07 (15:10–16:40 UTC), not assumed:
 *   - GeoServer contrast-stretches each GetMap response by its own content.
 *     The same pixels read 122 alone and 36 inside a 3x3-tile request, and
 *     adjacent z6 tiles jumped 8–62 counts at their seams. A z/x/y tile source
 *     cannot be honest on this server; ONE global image per frame has one
 *     stretch and no seams.
 *   - That stretch is a pure gain set by the request's brightest pixel, and the
 *     brightest pixel is not always cloud. The 15Z frame requested at ±66° held
 *     a no-data wedge at 64.7–66°N and came back 12% darker than the same frame
 *     at ±60° (tropical p99.9 217 against 245): under a fixed ramp its deep
 *     convection lost every red pixel. The fixtures below are those frames'
 *     tropical histograms, and the anchor must set that frame aside.
 *   - The server advertises nearestValue=1: a TIME just outside its window is
 *     snapped to the nearest kept frame (09Z returned 10Z's bytes), so frame
 *     times must come from a fresh capabilities list.
 */
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { existsSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type mapboxgl from 'mapbox-gl';
import type { MutableRefObject } from 'react';

const policy = vi.hoisted(() => ({ blocked: false }));
vi.mock('../services/networkPolicy', () => ({ satelliteModeBlocks: () => policy.blocked }));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

/** Which measured frame each requested time "decodes" to on the fake phone. */
const pixels = vi.hoisted(() => ({
    byTime: {} as Record<string, string>,
    fallback: '13Z_pm60',
    // jsdom's Blob has no text(); its FileReader reads it.
    text: (blob: Blob) =>
        new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(reader.error);
            reader.readAsText(blob);
        }),
}));
vi.mock('../components/map/satIrPixels', () => ({
    satIrTropicalHistogram: vi.fn(async (blob: Blob) => {
        const time = await pixels.text(blob);
        return Uint32Array.from(FIXTURE.frames[pixels.byTime[time] ?? pixels.fallback].hist);
    }),
    satIrDataUrl: vi.fn(async (blob: Blob) => `data:image/jpeg;base64,${btoa(await pixels.text(blob))}`),
}));

import {
    GMGSI_LAYER,
    SAT_IR_ANCHOR_BAND,
    SAT_IR_ANCHOR_GREY,
    SAT_IR_CREDIT,
    SAT_IR_EXTENT_DEG,
    SAT_IR_IMAGE_HEIGHT,
    SAT_IR_IMAGE_WIDTH,
    SAT_IR_LAYER_ID,
    SAT_IR_LOW_ANGLE_DEG,
    SAT_IR_MAX_FRAMES,
    SAT_IR_SOURCE_ID,
    parseGmgsiFrames,
    satIrAgeLabel,
    satIrAlphaAt,
    satIrAnchor,
    satIrColorMix,
    satIrColourAt,
    satIrCoverage,
    satIrCoverageNote,
    satIrFrames,
    satIrImageCoordinates,
    satIrImageUrl,
    satIrPaint,
    satIrTropicalRows,
} from '../components/map/satelliteImagery';
import { latestFrameAtOrBefore } from '../components/map/rainTimeAxis';
import { cloudOverlayBeforeId } from '../components/map/imageryOrder';
import { satIrHealTarget, useSatelliteLayer, type SatIrState } from '../components/map/useSatelliteLayer';
import { SatelliteIrCredit } from '../components/map/SatelliteIrCredit';
import { LAYER_FRAME_ZOOM, type WeatherLayer } from '../components/map/mapConstants';
import { MAX_LAYERS, weatherLayerCap, withWeatherLayerAdded } from '../components/map/useWeatherLayers';

interface FixtureFrame {
    extentDeg: number;
    height: number;
    firstRow: number;
    rows: number;
    hist: number[];
}
/** Tropical grey histograms of real frames (decoded with PIL; see the fixture's own note). */
const FIXTURE = JSON.parse(readFileSync('tests/fixtures/gmgsi-tropical-histograms-2026-10-07.json', 'utf8')) as {
    source: string;
    frames: Record<string, FixtureFrame>;
};
const APP_FRAMES = ['10Z_pm60', '11Z_pm60', '12Z_pm60', '13Z_pm60', '14Z_pm60', '15Z_pm60', '16Z_pm60'];

const iso = (h: number) => `2026-10-07T${String(h).padStart(2, '0')}:00:00.000Z`;
const ms = (h: number, m = 0) => Date.UTC(2026, 9, 7, h, m);

/**
 * The real capabilities' longwave layer (2026-10-07 15:12 UTC), trimmed, between
 * two neighbours whose time lists must NOT be read: the parser is scoped to the
 * named layer.
 */
const CAPS = `<?xml version="1.0" encoding="UTF-8"?><WMS_Capabilities version="1.3.0"><Capability><Layer>
  <Layer queryable="1" opaque="0"><Name>global_shortwave_imagery_mosaic</Name>
    <Dimension name="time" default="2026-10-07T09:00:00Z" units="ISO8601" nearestValue="1">2026-10-07T08:00:00.000Z,2026-10-07T09:00:00.000Z</Dimension>
  </Layer>
  <Layer queryable="1" opaque="0">
    <Name>global_longwave_imagery_mosaic</Name>
    <Title>Global Satellite Longwave Imagery</Title>
    <CRS>EPSG:3857</CRS>
    <CRS>CRS:84</CRS>
    <EX_GeographicBoundingBox>
      <westBoundLongitude>-179.99994344357404</westBoundLongitude>
      <eastBoundLongitude>179.95499090311822</eastBoundLongitude>
      <southBoundLatitude>-72.74472336303444</southBoundLatitude>
      <northBoundLatitude>72.73681640625001</northBoundLatitude>
    </EX_GeographicBoundingBox>
    <Dimension name="time" default="2026-10-07T14:00:00Z" units="ISO8601" nearestValue="1">2026-10-07T10:00:00.000Z,2026-10-07T11:00:00.000Z,2026-10-07T12:00:00.000Z,2026-10-07T13:00:00.000Z,2026-10-07T14:00:00.000Z</Dimension>
  </Layer>
  <Layer queryable="1" opaque="0"><Name>goes_longwave_imagery</Name>
    <Dimension name="time" default="2026-10-07T15:08:00Z" units="ISO8601" nearestValue="1">2026-10-07T15:03:00.000Z,2026-10-07T15:08:00.000Z</Dimension>
  </Layer>
</Layer></Capability></WMS_Capabilities>`;

/** Fixture sites, worldwide: the plan's six. */
const SITES: Record<string, [lat: number, lon: number]> = {
    'Mediterranean (Ionian)': [37.5, 18.0],
    'Caribbean (Antigua)': [17.0, -61.8],
    'North Sea': [54.0, 3.0],
    'US East (New Jersey)': [38.9, -74.0],
    Tahiti: [-17.5, -149.6],
    Whitsundays: [-20.27, 148.72],
};

/**
 * MEASURED in the ±60° 3072 px frames, 10Z–15Z, after each frame's anchor gain:
 * the 10th percentile of a 3°x3° box at each site (clear sea or land), and the
 * North Sea front's 10th percentile while it sat over the site (12Z–15Z).
 */
const CLEAR_SKY_P10: Record<string, number[]> = {
    'Mediterranean (Ionian)': [88, 89, 89, 85, 79, 82],
    'Caribbean (Antigua)': [88, 94, 87, 76, 68, 72],
    'US East (New Jersey)': [84, 87, 87, 82, 75, 78],
    Tahiti: [87, 89, 87, 83, 78, 81],
    Whitsundays: [77, 82, 83, 79, 71, 76],
};
const NORTH_SEA_FRONT_P10 = [166, 193, 189, 181];

/** Share of a histogram at or above `grey` once multiplied by `scale` (what the GPU's colour mix does). */
function shareAtOrAbove(hist: readonly number[], grey: number, scale = 1): number {
    let total = 0;
    let above = 0;
    hist.forEach((n, v) => {
        total += n;
        if (v * scale >= grey) above += n;
    });
    return above / total;
}

describe('capabilities, never the clock', () => {
    it('reads the longwave layer’s own time list, in order', () => {
        const frames = parseGmgsiFrames(CAPS);
        expect(frames?.map((f) => f.iso)).toEqual([iso(10), iso(11), iso(12), iso(13), iso(14)]);
        expect(frames?.map((f) => f.timeMs)).toEqual([ms(10), ms(11), ms(12), ms(13), ms(14)]);
    });

    it('expands a start/end/period list the same way', () => {
        const xml = CAPS.replace(
            /(<Name>global_longwave_imagery_mosaic<\/Name>[\s\S]*?nearestValue="1">)[^<]*/,
            '$12026-10-07T09:00:00.000Z/2026-10-07T14:00:00.000Z/PT1H',
        );
        expect(parseGmgsiFrames(xml)?.map((f) => f.timeMs)).toEqual([9, 10, 11, 12, 13, 14].map((h) => ms(h)));
    });

    it('returns null, not a guessed frame, when the layer or its times are missing', () => {
        expect(parseGmgsiFrames('<WMS_Capabilities/>')).toBeNull();
        expect(
            parseGmgsiFrames(
                CAPS.replace(/<Dimension name="time"[^>]*>[^<]*(?=<\/Dimension>)/g, '<Dimension name="time">'),
            ),
        ).toBeNull();
        // Only well-formed instants reach a URL.
        expect(
            parseGmgsiFrames(CAPS.replace(iso(14), '2026-10-07T14:00:00.000Z&sld_body=x'))?.map((f) => f.iso),
        ).toEqual([iso(10), iso(11), iso(12), iso(13)]);
    });

    it('keeps at most six of the newest frames and never invents one', () => {
        const all = [8, 9, 10, 11, 12, 13, 14].map((h) => ({ iso: iso(h), timeMs: ms(h) }));
        const kept = satIrFrames(all, ms(15, 12));
        expect(SAT_IR_MAX_FRAMES).toBe(6);
        expect(kept.map((f) => f.iso)).toEqual([9, 10, 11, 12, 13, 14].map(iso));
        // Two days later the list is still the capabilities' list: a stale
        // clock never manufactures "now".
        expect(satIrFrames(all, ms(15) + 2 * 86_400_000).map((f) => f.iso)).toEqual(kept.map((f) => f.iso));
        // A time stamped ahead of the phone's clock by more than a few minutes
        // is not an observation yet.
        expect(satIrFrames([...all, { iso: iso(18), timeMs: ms(18) }], ms(15)).at(-1)?.iso).toBe(iso(14));
    });
});

describe('one image per frame, one stretch, no seams', () => {
    it('asks for the whole ±60° belt as one EPSG:3857 JPEG at the frame’s own time', () => {
        const url = new URL(satIrImageUrl({ iso: iso(14), timeMs: ms(14) }));
        expect(url.origin).toBe('https://nowcoast.noaa.gov'); // CSP already allows *.noaa.gov
        const q = url.searchParams;
        expect(q.get('request')).toBe('GetMap');
        expect(q.get('layers')).toBe(GMGSI_LAYER);
        expect(q.get('crs')).toBe('EPSG:3857');
        expect(q.get('format')).toBe('image/jpeg');
        expect(q.get('bgcolor')).toBe('0x000000');
        expect(q.get('time')).toBe(iso(14));
        expect(q.get('width')).toBe(String(SAT_IR_IMAGE_WIDTH));
        expect(q.get('height')).toBe(String(SAT_IR_IMAGE_HEIGHT));
        expect([SAT_IR_IMAGE_WIDTH, SAT_IR_IMAGE_HEIGHT]).toEqual([3072, 1288]);
        const [minx, miny, maxx, maxy] = q.get('bbox')!.split(',').map(Number);
        expect(minx).toBeCloseTo(-20037508.34, 1);
        expect(maxx).toBeCloseTo(20037508.34, 1);
        // Symmetric about the equator at 60°: y = R·ln(tan(45° + 30°)).
        expect(maxy).toBeCloseTo(8399737.89, 1);
        expect(miny).toBe(-maxy);
        // Not a tile template, and nothing the CDN's WAF refuses.
        expect(url.href).not.toContain('{bbox-epsg-3857}');
        expect(url.href.toLowerCase()).not.toContain('sld');
    });

    it('is byte-identical for every phone asking for the same frame (a shared CDN hit)', () => {
        const f = { iso: iso(13), timeMs: ms(13) };
        expect(satIrImageUrl(f)).toBe(satIrImageUrl({ ...f }));
    });

    it('pins the image to the same belt the request asked for, inside the service’s own 60°N–60°S', () => {
        expect(SAT_IR_EXTENT_DEG).toBe(60);
        expect(satIrImageCoordinates()).toEqual([
            [-180, 60],
            [180, 60],
            [180, -60],
            [-180, -60],
        ]);
    });
});

describe('each frame anchored before it is shown (the 15Z regression)', () => {
    it('reads the same tropical rows the measurements used', () => {
        expect(satIrTropicalRows(SAT_IR_IMAGE_HEIGHT)).toEqual({ first: 424, count: 440 });
        const f = FIXTURE.frames['15Z_pm60'];
        expect([f.height, f.firstRow, f.rows]).toEqual([SAT_IR_IMAGE_HEIGHT, 424, 440]);
    });

    it.each(APP_FRAMES)('anchors every frame the app asks for: %s', (key) => {
        const anchor = satIrAnchor(FIXTURE.frames[key].hist);
        expect(anchor.usable).toBe(true);
        if (!anchor.usable) return;
        expect(anchor.p999).toBeGreaterThanOrEqual(241);
        expect(anchor.p999).toBeLessThanOrEqual(245);
        // A small gain: the ±60° stretch held in all seven frames.
        expect(Math.abs(anchor.scale - 1)).toBeLessThan(0.01);
    });

    it('sets aside the ±66° 15Z and 16Z frames, whose stretch a no-data wedge set', () => {
        const wedge = satIrAnchor(FIXTURE.frames['15Z_pm66'].hist);
        expect(wedge).toEqual({ usable: false, p999: 217, reason: 'stretch' });
        expect(wedge.p999).toBeLessThan(SAT_IR_ANCHOR_BAND[0]);
        // The wedge was still there an hour later.
        expect(satIrAnchor(FIXTURE.frames['16Z_pm66'].hist)).toMatchObject({ usable: false, reason: 'stretch' });
        // Not ±66° as such: the 14Z frame at ±66° had no wedge in the belt and anchors.
        expect(satIrAnchor(FIXTURE.frames['14Z_pm66'].hist).usable).toBe(true);
    });

    it('keeps the cyan and red tiers meaning the same in every frame shown', () => {
        for (const key of APP_FRAMES) {
            const anchor = satIrAnchor(FIXTURE.frames[key].hist);
            if (!anchor.usable) throw new Error(`${key} not anchored`);
            const hist = FIXTURE.frames[key].hist;
            // Cyan from 215, red from 235 (anchored grey): deep convection.
            expect(shareAtOrAbove(hist, 215, anchor.scale)).toBeGreaterThan(0.015);
            expect(shareAtOrAbove(hist, 215, anchor.scale)).toBeLessThan(0.025);
            expect(shareAtOrAbove(hist, 235, anchor.scale)).toBeGreaterThan(0.003);
            expect(shareAtOrAbove(hist, 235, anchor.scale)).toBeLessThan(0.005);
        }
        // What a fixed ramp on raw counts would have shown for the darkened
        // frame: the same storms, almost no cyan and no red at all.
        const raw = FIXTURE.frames['15Z_pm66'].hist;
        expect(shareAtOrAbove(raw, 215)).toBeLessThan(0.002);
        expect(shareAtOrAbove(raw, 235)).toBe(0);
        // Its pixels are a pure gain of the good frame's: the anchor's gain recovers the tiers.
        expect(shareAtOrAbove(raw, 215, SAT_IR_ANCHOR_GREY / 217)).toBeGreaterThan(0.015);
    });

    it('refuses an image that is not a usable frame', () => {
        const blank = new Array(256).fill(0);
        expect(satIrAnchor(blank)).toMatchObject({ usable: false, reason: 'empty' });
        const black = [...blank];
        black[0] = 1_351_680;
        expect(satIrAnchor(black)).toMatchObject({ usable: false, reason: 'stretch' });
        // A hole in the mosaic over the tropics (a satellite missing) is not a stretch to correct.
        const holed = [...FIXTURE.frames['13Z_pm60'].hist];
        holed[255] += 20_000;
        expect(satIrAnchor(holed)).toMatchObject({ usable: false, reason: 'no-data' });
    });

    it('puts each frame’s gain into the GPU’s colour mix, applied at once', () => {
        expect(satIrColorMix(1)).toEqual([255, 0, 0, 0]);
        expect(satIrColorMix(SAT_IR_ANCHOR_GREY / 241)[0]).toBeCloseTo(257.1, 1);
        const paint = satIrPaint(1.0083);
        expect(paint['raster-color-mix']).toEqual(satIrColorMix(1.0083));
        expect(paint['raster-color-mix-transition']).toEqual({ duration: 0, delay: 0 });
        expect(paint['raster-color-range']).toEqual([0, 255]);
        expect(paint['raster-fade-duration']).toBe(0);
        expect((paint['raster-color'] as unknown[]).slice(0, 3)).toEqual(['interpolate', ['linear'], ['raster-value']]);
    });
});

describe('the enhanced-IR ramp, measured on real frames', () => {
    it.each(Object.entries(CLEAR_SKY_P10))('leaves clear sky transparent: %s', (_site, values) => {
        // The frames are opaque (alpha 255 on 100% of pixels, measured): only
        // the ramp can let the chart show through.
        for (const v of values) expect(satIrAlphaAt(v)).toBe(0);
        // With room for the drift measured between frames.
        for (const v of values) expect(satIrAlphaAt(v + 15)).toBe(0);
    });

    it('paints a North Sea front as solid white cloud', () => {
        for (const v of NORTH_SEA_FRONT_P10) {
            expect(satIrAlphaAt(v)).toBeGreaterThanOrEqual(0.6);
            const [r, g, b] = satIrColourAt(v);
            expect(Math.min(r, g, b)).toBeGreaterThan(220);
        }
    });

    it('turns the coldest tops cyan, then red', () => {
        const cyan = satIrColourAt(225);
        expect(cyan[2]).toBeGreaterThan(cyan[0] + 100); // blue-green, not white
        const red = satIrColourAt(242);
        expect(red[0]).toBeGreaterThan(red[1] + 100);
        expect(red[0]).toBeGreaterThan(red[2] + 100);
        expect(satIrAlphaAt(255)).toBeGreaterThan(0.9);
    });

    it('never gets more transparent as the cloud gets colder', () => {
        let last = 0;
        for (let v = 0; v <= 255; v++) {
            const a = satIrAlphaAt(v);
            expect(a).toBeGreaterThanOrEqual(last);
            last = a;
        }
    });
});

describe('coverage, said plainly, from the whole view', () => {
    it.each(Object.entries(SITES))('shows imagery at %s', (_site, [lat]) => {
        const c = satIrCoverage({ centreLat: lat });
        expect(c.outside).toBeNull();
        expect(satIrCoverageNote(c)).toBe(lat > SAT_IR_LOW_ANGLE_DEG ? 'low satellite angle past 55°' : null);
    });

    it('says when the edge is in view although the centre is inside it (Stavanger, zoom 4)', () => {
        const c = satIrCoverage({ centreLat: 59.0, north: 66.4, south: 50.6 });
        expect(c.outside).toBeNull();
        expect(satIrCoverageNote(c)).toBe('no imagery past 60°N');
        // Cape Horn, looking south.
        expect(satIrCoverageNote(satIrCoverage({ centreLat: -56, north: -50, south: -62 }))).toBe(
            'no imagery past 60°S',
        );
        // The Bay of Biscay reaching up to Ireland: the low-angle band, not the edge.
        expect(satIrCoverageNote(satIrCoverage({ centreLat: 50, north: 56.2, south: 43.4 }))).toBe(
            'low satellite angle past 55°',
        );
        // A world view sees both edges.
        expect(satIrCoverageNote(satIrCoverage({ centreLat: 0, north: 80, south: -80 }))).toBe(
            'no imagery past 60°N/S',
        );
    });

    it('says there is no imagery when the centre is past it, north and south', () => {
        expect(satIrCoverageNote(satIrCoverage({ centreLat: 64.1 }))).toBe('No satellite cloud imagery past 60°N'); // Reykjavik
        expect(satIrCoverage({ centreLat: 69.6 }).outside).toBe('N'); // Tromsø
        expect(satIrCoverage({ centreLat: -62.2 }).outside).toBe('S'); // South Shetlands
        expect(satIrCoverageNote(satIrCoverage({ centreLat: -77.8 }))).toBe('No satellite cloud imagery past 60°S'); // Ross Sea
    });
});

describe('the age chip', () => {
    it('reads the frame’s UTC time and its age', () => {
        expect(satIrAgeLabel(ms(14), ms(15, 12))).toBe('Satellite IR 14:00 UTC · 1 h old');
        expect(satIrAgeLabel(ms(4), ms(6, 20))).toBe('Satellite IR 04:00 UTC · 2 h old');
        expect(satIrAgeLabel(ms(14), ms(14, 40))).toBe('Satellite IR 14:00 UTC · 40 min old');
    });
});

describe('the rain radar’s time axis', () => {
    const frames = [10, 11, 12, 13, 14].map((h) => ({ timeMs: ms(h) }));
    it('shows the newest observation the radar moment had already seen', () => {
        expect(latestFrameAtOrBefore(frames, ms(13, 58))).toBe(3);
        expect(latestFrameAtOrBefore(frames, ms(14, 10))).toBe(4);
        expect(latestFrameAtOrBefore(frames, ms(14))).toBe(4);
        // A forecast moment holds the latest observation; the chip says its time.
        expect(latestFrameAtOrBefore(frames, ms(17))).toBe(4);
        expect(latestFrameAtOrBefore(frames, ms(9))).toBe(-1);
        expect(latestFrameAtOrBefore([{}, { timeMs: ms(12) }], ms(13))).toBe(1);
    });
});

// ── The hook against a fake map ─────────────────────────────────────────────

type Handler = (event: Record<string, unknown>) => void;

function fakeMap(styleLayers = ['background', 'satellite-base-layer', 'enc-vec-depare', 'place-city']) {
    const handlers = new Map<string, Set<Handler>>();
    const layers = styleLayers.map((id) => ({ id, type: /^place-|^settlement-/.test(id) ? 'symbol' : 'raster' }));
    const sources = new Map<string, { updateImage: ReturnType<typeof vi.fn>; spec: unknown }>();
    const camera = { easeTo: vi.fn(), flyTo: vi.fn(), jumpTo: vi.fn(), panTo: vi.fn(), setZoom: vi.fn() };
    const view = { lat: -20.27, north: -14.5, south: -26.0 };
    const place = (id: string, beforeId?: string) => {
        const from = layers.findIndex((l) => l.id === id);
        const [layer] = layers.splice(from, 1);
        const at = beforeId ? layers.findIndex((l) => l.id === beforeId) : -1;
        if (at >= 0) layers.splice(at, 0, layer);
        else layers.push(layer);
    };
    const map = {
        ...camera,
        getStyle: () => ({ layers: [...layers] }),
        getCenter: () => ({ lng: 148.72, lat: view.lat }),
        getBounds: () => ({ getNorth: () => view.north, getSouth: () => view.south }),
        getSource: (id: string) => sources.get(id),
        getLayer: (id: string) => layers.find((l) => l.id === id),
        addSource: vi.fn((id: string, spec: unknown) => {
            const src = { updateImage: vi.fn(), spec };
            sources.set(id, src);
        }),
        removeSource: vi.fn((id: string) => sources.delete(id)),
        addLayer: vi.fn((layer: { id: string; type: string }, beforeId?: string) => {
            layers.push({ id: layer.id, type: layer.type });
            place(layer.id, beforeId);
        }),
        removeLayer: vi.fn((id: string) => {
            const at = layers.findIndex((l) => l.id === id);
            if (at >= 0) layers.splice(at, 1);
        }),
        // A real reorder, so the order healer is tested against what it does.
        moveLayer: vi.fn((id: string, beforeId?: string) => place(id, beforeId)),
        setPaintProperty: vi.fn(),
        on: vi.fn((type: string, fn: Handler) => {
            if (!handlers.has(type)) handlers.set(type, new Set());
            handlers.get(type)!.add(fn);
        }),
        off: vi.fn((type: string, fn: Handler) => handlers.get(type)?.delete(fn)),
    };
    const emit = (type: string, event: Record<string, unknown> = {}) =>
        act(() => {
            for (const fn of [...(handlers.get(type) ?? [])]) fn(event);
        });
    const ids = () => layers.map((l) => l.id);
    return { map: map as unknown as mapboxgl.Map, raw: map, camera, sources, layers, ids, place, emit, view };
}

function capsResponse(xml = CAPS) {
    return Promise.resolve(new Response(xml, { status: 200, headers: { 'content-type': 'text/xml' } }));
}

/** A frame's "JPEG": its own time, so the fake decode knows which measured frame it is. */
function frameResponse(url: string) {
    return Promise.resolve(
        new Response(new URL(url).searchParams.get('time') ?? '', {
            status: 200,
            headers: { 'content-type': 'image/jpeg' },
        }),
    );
}

type HookProps = { enabled: boolean; follow: number | null };

function mount(map: mapboxgl.Map, initial: HookProps = { enabled: true, follow: null }) {
    const mapRef = { current: map } as MutableRefObject<mapboxgl.Map | null>;
    return renderHook(({ enabled, follow }: HookProps) => useSatelliteLayer(mapRef, true, enabled, follow), {
        initialProps: initial,
    });
}

/** The frame time a data: URL handed to Mapbox carries (the fake JPEG is its time). */
const frameOf = (url: string) => atob(url.slice(url.indexOf(',') + 1));
/** What an image source fires once a requested image has arrived (seen live in GL JS 3.19). */
const PAINTED = { sourceId: SAT_IR_SOURCE_ID, sourceDataType: 'metadata', isSourceLoaded: true };
const scaleOf = (key: string) => {
    const a = satIrAnchor(FIXTURE.frames[key].hist);
    if (!a.usable) throw new Error(`${key} not anchored`);
    return a.scale;
};

describe('useSatelliteLayer', () => {
    let fetchMock: ReturnType<typeof vi.fn>;
    /** GetMap requests by time. */
    let imageRequests: string[];
    let failImages: (time: string) => boolean;
    beforeEach(() => {
        policy.blocked = false;
        pixels.byTime = {};
        imageRequests = [];
        failImages = () => false;
        vi.useFakeTimers({ shouldAdvanceTime: true });
        vi.setSystemTime(ms(15, 12));
        fetchMock = vi.fn((url: string) => {
            if (url.includes('request=GetCapabilities')) return capsResponse();
            const time = new URL(url).searchParams.get('time') ?? '';
            imageRequests.push(time);
            if (failImages(time)) return Promise.reject(new TypeError('Load failed'));
            return frameResponse(url);
        });
        vi.stubGlobal('fetch', fetchMock);
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    const advance = (msToGo: number) =>
        act(async () => {
            await vi.advanceTimersByTimeAsync(msToGo);
        });

    it('mounts ONE image source of the newest frame, under the chart and ENC, and never moves the camera', async () => {
        pixels.byTime[iso(14)] = '11Z_pm60';
        const { map, raw, camera, ids, emit } = fakeMap();
        const before = cloudOverlayBeforeId(map.getStyle()!.layers as { id: string; type?: string }[]);
        const { result } = mount(map);
        await waitFor(() => expect(raw.addSource).toHaveBeenCalledTimes(1));
        expect(fetchMock.mock.calls[0][0]).toContain('request=GetCapabilities');
        // The frame's bytes were read once, from the frame's own URL.
        expect(fetchMock.mock.calls[1][0]).toBe(satIrImageUrl({ iso: iso(14), timeMs: ms(14) }));
        expect(imageRequests).toEqual([iso(14)]);
        const [id, spec] = raw.addSource.mock.calls[0] as [string, { type: string; url: string; coordinates: unknown }];
        expect(id).toBe(SAT_IR_SOURCE_ID);
        expect(spec.type).toBe('image');
        // Mapbox gets those same bytes, not the URL again: nothing downloads twice.
        expect(spec.url.startsWith('data:image/jpeg;base64,')).toBe(true);
        expect(frameOf(spec.url)).toBe(iso(14));
        expect(spec.coordinates).toEqual(satIrImageCoordinates());
        const [layer, beforeId] = raw.addLayer.mock.calls[0] as [
            { id: string; type: string; source: string; paint: Record<string, unknown> },
            string,
        ];
        expect(layer).toMatchObject({ id: SAT_IR_LAYER_ID, type: 'raster', source: SAT_IR_SOURCE_ID });
        // Drawn with its own frame's gain.
        expect(layer.paint['raster-color-mix']).toEqual(satIrColorMix(scaleOf('11Z_pm60')));
        expect(beforeId).toBe(before);
        // Above the opaque imagery, below the chart.
        expect(ids().indexOf(SAT_IR_LAYER_ID)).toBeGreaterThan(ids().indexOf('satellite-base-layer'));
        expect(ids().indexOf(SAT_IR_LAYER_ID)).toBeLessThan(ids().indexOf('enc-vec-depare'));
        expect(result.current.status).toBe('loading');
        // Not every sourcedata is the image: a 'content' pass comes first.
        emit('sourcedata', { sourceId: SAT_IR_SOURCE_ID, sourceDataType: 'content', isSourceLoaded: false });
        expect(result.current.status).toBe('loading');
        expect(result.current.frameTimeMs).toBeNull();

        emit('sourcedata', PAINTED);
        await waitFor(() => expect(result.current.status).toBe('ready'));
        expect(result.current.frameTimeMs).toBe(ms(14));
        expect(result.current.frameCount).toBe(5);
        expect(result.current.coverage.outside).toBeNull();
        for (const fn of Object.values(camera)) expect(fn).not.toHaveBeenCalled();
    });

    it('swaps a frame’s gain in with its pixels, not before', async () => {
        pixels.byTime[iso(13)] = '15Z_pm60';
        pixels.byTime[iso(14)] = '11Z_pm60';
        const { map, raw, sources, emit } = fakeMap();
        const view = mount(map, { enabled: true, follow: ms(14, 10) });
        await waitFor(() => expect(raw.addSource).toHaveBeenCalledTimes(1));
        emit('sourcedata', PAINTED);
        view.rerender({ enabled: true, follow: ms(13, 30) });
        const src = sources.get(SAT_IR_SOURCE_ID)!;
        await waitFor(() => expect(src.updateImage).toHaveBeenCalledTimes(1));
        expect(frameOf(src.updateImage.mock.calls[0][0].url)).toBe(iso(13));
        // The old frame is still on screen: its gain stays until the new pixels land.
        expect(raw.setPaintProperty).not.toHaveBeenCalled();
        emit('sourcedata', PAINTED);
        expect(raw.setPaintProperty).toHaveBeenCalledWith(
            SAT_IR_LAYER_ID,
            'raster-color-mix',
            satIrColorMix(scaleOf('15Z_pm60')),
        );
        await waitFor(() => expect(view.result.current.frameTimeMs).toBe(ms(13)));
    });

    it('never shows a frame whose stretch cannot be anchored; the chip names the frame it does show', async () => {
        // The newest frame darkened 12% by a no-data wedge, as the ±66° 15Z frame was.
        pixels.byTime[iso(14)] = '15Z_pm66';
        const { map, raw, emit } = fakeMap();
        const { result } = mount(map);
        await waitFor(() => expect(raw.addSource).toHaveBeenCalledTimes(1));
        expect(frameOf((raw.addSource.mock.calls[0][1] as { url: string }).url)).toBe(iso(13));
        emit('sourcedata', PAINTED);
        await waitFor(() => expect(result.current.frameTimeMs).toBe(ms(13)));
        expect(result.current.frameCount).toBe(4);
        expect(imageRequests).toEqual([iso(14), iso(13)]);
    });

    it('says unavailable when no listed frame can be anchored', async () => {
        pixels.fallback = '15Z_pm66';
        try {
            const { map, raw } = fakeMap();
            const { result } = mount(map);
            await waitFor(() => expect(result.current.status).toBe('unavailable'));
            expect(raw.addSource).not.toHaveBeenCalled();
            expect(imageRequests).toHaveLength(5);
        } finally {
            pixels.fallback = '13Z_pm60';
        }
    });

    it('follows the rain scrubber with the same single source', async () => {
        const { map, raw, sources, emit } = fakeMap();
        const view = mount(map, { enabled: true, follow: ms(13, 58) });
        await waitFor(() => expect(raw.addSource).toHaveBeenCalledTimes(1));
        expect(frameOf((raw.addSource.mock.calls[0][1] as { url: string }).url)).toBe(iso(13));
        emit('sourcedata', PAINTED);
        await waitFor(() => expect(view.result.current.frameTimeMs).toBe(ms(13)));
        expect(view.result.current.following).toBe(true);

        view.rerender({ enabled: true, follow: ms(14, 10) });
        const src = sources.get(SAT_IR_SOURCE_ID)!;
        await waitFor(() => expect(src.updateImage).toHaveBeenCalledTimes(1));
        expect(frameOf(src.updateImage.mock.calls[0][0].url)).toBe(iso(14));
        // A forecast moment past the imagery holds the latest observation.
        emit('sourcedata', PAINTED);
        view.rerender({ enabled: true, follow: ms(17) });
        await act(async () => undefined);
        expect(src.updateImage).toHaveBeenCalledTimes(1);
        expect(raw.addSource).toHaveBeenCalledTimes(1);
        expect(view.result.current.frameTimeMs).toBe(ms(14));
    });

    it('loops up to six real frames by swapping the one image, waiting for each to paint', async () => {
        const { map, raw, sources, emit } = fakeMap();
        const view = mount(map);
        await waitFor(() => expect(raw.addSource).toHaveBeenCalledTimes(1));
        emit('sourcedata', PAINTED);
        await waitFor(() => expect(view.result.current.status).toBe('ready'));
        act(() => view.result.current.setPlaying(true));
        const src = sources.get(SAT_IR_SOURCE_ID)!;
        await waitFor(() => expect(src.updateImage).toHaveBeenCalledTimes(1));
        expect(frameOf(src.updateImage.mock.calls[0][0].url)).toBe(iso(10)); // the loop starts at the oldest
        // Not painted yet: the loop must not run ahead of the pixels.
        await advance(3000);
        expect(src.updateImage).toHaveBeenCalledTimes(1);
        emit('sourcedata', PAINTED);
        await advance(1100);
        await waitFor(() => expect(src.updateImage).toHaveBeenCalledTimes(2));
        expect(frameOf(src.updateImage.mock.calls[1][0].url)).toBe(iso(11));
        expect(raw.addSource).toHaveBeenCalledTimes(1);
        act(() => view.result.current.setPlaying(false));
        await waitFor(() => expect(frameOf(src.updateImage.mock.calls.at(-1)![0].url)).toBe(iso(14)));
    });

    it('holds the newest frame a beat, downloads each frame once, and hands the clock to the rain scrubber', async () => {
        const { map, raw, sources, emit } = fakeMap();
        const view = mount(map);
        await waitFor(() => expect(raw.addSource).toHaveBeenCalledTimes(1));
        emit('sourcedata', PAINTED);
        act(() => view.result.current.setPlaying(true));
        const src = sources.get(SAT_IR_SOURCE_ID)!;
        const requested = () => src.updateImage.mock.calls.map((c) => frameOf(c[0].url));
        // Paint each requested frame, then let one loop step pass.
        const step = async () => {
            emit('sourcedata', PAINTED);
            await advance(1000);
        };
        await waitFor(() => expect(requested()).toEqual([iso(10)]));
        for (let i = 0; i < 4; i++) {
            await step();
            await waitFor(() => expect(requested()).toHaveLength(i + 2));
        }
        expect(requested()).toEqual([10, 11, 12, 13, 14].map(iso));
        await step(); // the newest frame holds
        expect(requested().length).toBe(5);
        await step();
        expect(requested().at(-1)).toBe(iso(10));
        // Round the loop again: the bytes are already on the phone.
        expect([...imageRequests].sort()).toEqual([10, 11, 12, 13, 14].map(iso));
        // Rain comes up: its scrubber's moment decides, and the loop is over.
        view.rerender({ enabled: true, follow: ms(12, 30) });
        await waitFor(() => expect(requested().at(-1)).toBe(iso(12)));
        expect(view.result.current.playing).toBe(false);
        expect(view.result.current.following).toBe(true);
    });

    it('reads a fresh frame list when a loop starts, so a frame the server has dropped is not asked for', async () => {
        const { map, raw, emit } = fakeMap();
        const view = mount(map);
        await waitFor(() => expect(raw.addSource).toHaveBeenCalledTimes(1));
        emit('sourcedata', PAINTED);
        const capsReads = () => fetchMock.mock.calls.filter(([u]) => String(u).includes('GetCapabilities')).length;
        expect(capsReads()).toBe(1);
        act(() => view.result.current.setPlaying(true));
        await waitFor(() => expect(capsReads()).toBe(2));
    });

    it('asks again for a first frame that failed, so "retrying" is true', async () => {
        failImages = () => true;
        const { map, raw, emit } = fakeMap();
        const { result } = mount(map);
        await waitFor(() => expect(result.current.status).toBe('unavailable'));
        expect(imageRequests).toEqual([iso(14)]);
        expect(raw.addSource).not.toHaveBeenCalled();
        // The link comes back; two minutes on, the same frame is asked for again.
        failImages = () => false;
        await advance(2 * 60_000 + 100);
        await waitFor(() => expect(raw.addSource).toHaveBeenCalledTimes(1));
        expect(imageRequests).toEqual([iso(14), iso(14)]);
        emit('sourcedata', PAINTED);
        await waitFor(() => expect(result.current.status).toBe('ready'));
    });

    it('hands a frame Mapbox could not draw over again after the same wait', async () => {
        const { map, raw, sources, emit } = fakeMap();
        const { result } = mount(map);
        await waitFor(() => expect(raw.addSource).toHaveBeenCalledTimes(1));
        emit('error', { sourceId: SAT_IR_SOURCE_ID, error: new Error('decode') });
        await waitFor(() => expect(result.current.status).toBe('unavailable'));
        const src = sources.get(SAT_IR_SOURCE_ID)!;
        expect(src.updateImage).not.toHaveBeenCalled();
        await advance(2 * 60_000 + 100);
        await waitFor(() => expect(src.updateImage).toHaveBeenCalledTimes(1));
        expect(frameOf(src.updateImage.mock.calls[0][0].url)).toBe(iso(14));
    });

    it('stops a loop that keeps failing instead of asking once a second for ever', async () => {
        const { map, raw, emit } = fakeMap();
        const view = mount(map);
        await waitFor(() => expect(raw.addSource).toHaveBeenCalledTimes(1));
        emit('sourcedata', PAINTED);
        await waitFor(() => expect(view.result.current.status).toBe('ready'));
        // The link drops as the loop starts: no older frame has been read yet.
        failImages = (time) => time !== iso(14);
        act(() => view.result.current.setPlaying(true));
        await advance(30_000);
        expect(view.result.current.playing).toBe(false);
        expect(imageRequests.filter((t) => t !== iso(14)).length).toBeLessThanOrEqual(2);
        // What was on screen stays, honestly labelled.
        expect(view.result.current.status).toBe('ready');
        expect(view.result.current.frameTimeMs).toBe(ms(14));
    });

    it('fetches nothing in Satellite Mode and says why', async () => {
        policy.blocked = true;
        const { map, raw } = fakeMap();
        const { result } = mount(map);
        await act(async () => undefined);
        expect(result.current.status).toBe('blocked');
        expect(fetchMock).not.toHaveBeenCalled();
        expect(raw.addSource).not.toHaveBeenCalled();
    });

    it('reports unavailable, honestly, when the capabilities cannot be read', async () => {
        fetchMock.mockImplementation(() => Promise.resolve(new Response('nope', { status: 503 })));
        const { map, raw } = fakeMap();
        const { result } = mount(map);
        await waitFor(() => expect(result.current.status).toBe('unavailable'));
        expect(raw.addSource).not.toHaveBeenCalled();
    });

    it('takes its layer and source away when switched off', async () => {
        const { map, raw } = fakeMap();
        const view = mount(map);
        await waitFor(() => expect(raw.addSource).toHaveBeenCalledTimes(1));
        view.rerender({ enabled: false, follow: null });
        await waitFor(() => expect(raw.removeSource).toHaveBeenCalledWith(SAT_IR_SOURCE_ID));
        expect(raw.removeLayer).toHaveBeenCalledWith(SAT_IR_LAYER_ID);
        expect(view.result.current.status).toBe('off');
    });

    it('says when the view reaches past the imagery, not only when its centre does', async () => {
        const { map, raw, view, emit } = fakeMap();
        const { result } = mount(map);
        await waitFor(() => expect(raw.addSource).toHaveBeenCalledTimes(1));
        expect(satIrCoverageNote(result.current.coverage)).toBeNull();
        // Stavanger at zoom 4: the centre has imagery, the top of the screen does not.
        Object.assign(view, { lat: 59.0, north: 66.4, south: 50.6 });
        emit('moveend');
        await waitFor(() => expect(satIrCoverageNote(result.current.coverage)).toBe('no imagery past 60°N'));
        Object.assign(view, { lat: 70.6, north: 73, south: 68 }); // North Cape
        emit('moveend');
        await waitFor(() => expect(result.current.coverage.outside).toBe('N'));
    });

    it('stays under the chart when ENC mounts underneath it after it was switched on', async () => {
        // A wide open-ocean view: no ENC yet, so useMapInit appended the imagery to the top.
        const { map, raw, ids, place, layers, emit } = fakeMap([
            'background',
            'settlement-major-label',
            'place-city',
            'satellite-base-layer',
            'hybrid-base-layer',
            'route-line',
        ]);
        mount(map);
        await waitFor(() => expect(raw.addSource).toHaveBeenCalledTimes(1));
        expect(ids()).toEqual([
            'background',
            'settlement-major-label',
            'place-city',
            'satellite-base-layer',
            'hybrid-base-layer',
            SAT_IR_LAYER_ID,
            'route-line',
        ]);
        // The healer settles while the imagery itself still sits on top: no loop.
        emit('styledata');
        await advance(400);
        expect(raw.moveLayer).not.toHaveBeenCalled();
        // Zoomed into a charted harbour: ENC inserts below the labels, then
        // MapHub demotes both imagery layers under it.
        layers.splice(1, 0, { id: 'enc-vec-depare', type: 'fill' }, { id: 'enc-vec-lights', type: 'symbol' });
        place('satellite-base-layer', 'enc-vec-depare');
        place('hybrid-base-layer', 'enc-vec-depare');
        emit('styledata');
        await advance(400);
        const order = ids();
        expect(order.indexOf(SAT_IR_LAYER_ID)).toBeLessThan(order.indexOf('enc-vec-depare'));
        expect(order.indexOf(SAT_IR_LAYER_ID)).toBeGreaterThan(order.indexOf('hybrid-base-layer'));
        // Settled: more style passes move nothing.
        const moves = raw.moveLayer.mock.calls.length;
        emit('styledata');
        await advance(400);
        expect(raw.moveLayer.mock.calls.length).toBe(moves);
        expect(satIrHealTarget(map.getStyle()!.layers as { id: string }[])).toBeNull();
    });
});

describe('the credit and chip', () => {
    const base: SatIrState = {
        status: 'ready',
        frameTimeMs: ms(14),
        frameCount: 5,
        coverage: satIrCoverage({ centreLat: -20.27 }),
        playing: false,
        following: false,
    };
    const chip = (state: Partial<SatIrState> = {}) =>
        render(
            createElement(SatelliteIrCredit, {
                state: { ...base, ...state },
                nowMs: ms(15, 12),
                top: '0px',
                onTogglePlay: vi.fn(),
            }),
        );

    it('names every agency on the credits strip, with the frame time and age', () => {
        expect(SAT_IR_CREDIT).toBe('NOAA/NESDIS GMGSI: GOES, Meteosat (EUMETSAT), Himawari (JMA)');
        const { container } = chip();
        expect(screen.getByText(SAT_IR_CREDIT)).toBeInTheDocument();
        expect(screen.getByText('Satellite IR 14:00 UTC · 1 h old')).toBeInTheDocument();
        expect(container.querySelector('[data-map-credit]')).not.toBeNull();
        expect(screen.getByRole('button', { name: 'Play satellite loop' })).toBeInTheDocument();
    });

    it('shows the reason it is paused in Satellite Mode', () => {
        chip({ status: 'blocked', frameTimeMs: null, frameCount: 0 });
        expect(screen.getByText(/paused in Satellite Mode/)).toBeInTheDocument();
        expect(screen.queryByRole('button')).toBeNull();
    });

    it('warns, beside the age, when the view reaches past the imagery', () => {
        chip({ coverage: satIrCoverage({ centreLat: 59.0, north: 66.4, south: 50.6 }) });
        const line = screen.getByText('Satellite IR 14:00 UTC · 1 h old · no imagery past 60°N');
        expect(line.className).toContain('text-amber-200');
    });

    it('says plainly where there is no imagery at all', () => {
        chip({ coverage: satIrCoverage({ centreLat: 69.6 }) });
        expect(screen.getByText('No satellite cloud imagery past 60°N')).toBeInTheDocument();
    });

    it('hands the loop to the rain scrubber while rain is up', () => {
        chip({ following: true });
        expect(screen.queryByRole('button', { name: /satellite loop/ })).toBeNull();
    });
});

describe('wiring', () => {
    const read = (path: string) => readFileSync(path, 'utf8');

    it('is a plain toggle in the Sky menu that frames no zoom', () => {
        const menu = read('components/map/RadialHelmMenu.tsx');
        const sky = menu.slice(menu.indexOf("id: 'atmosphere'"), menu.indexOf('// ── Routes / charts'));
        expect(sky).toContain("layerKey: 'satIR'");
        // The model "Clouds" item stays: observed and modelled cloud are both offered.
        expect(sky).toContain("layerKey: 'clouds'");
        // Layer toggles never move the camera.
        expect(LAYER_FRAME_ZOOM['satIR' as WeatherLayer]).toBeUndefined();
    });

    it('lets all six Sky layers stack, but gives the sixth slot only to the satellite cloud', () => {
        const sky: WeatherLayer[] = ['wind', 'rain', 'pressure', 'clouds', 'temperature'];
        let on = new Set<WeatherLayer>();
        for (const layer of [...sky, 'satIR' as const]) on = withWeatherLayerAdded(on, layer);
        expect(on.size).toBe(6);
        // Five tiled Sky layers and a sea layer cannot all be up: 'clouds' goes, as before.
        const sea = withWeatherLayerAdded(new Set(sky), 'sea');
        expect(sea.size).toBe(MAX_LAYERS);
        expect(sea.has('clouds')).toBe(false);
        // With the satellite cloud up, a sea layer still evicts a tiled layer, not it.
        const six = withWeatherLayerAdded(on, 'sea');
        expect(six.size).toBe(6);
        expect(six.has('satIR')).toBe(true);
        expect(six.has('clouds')).toBe(false);
        expect(weatherLayerCap(new Set(sky))).toBe(5);
        expect(weatherLayerCap(new Set(sky), 'satIR')).toBe(6);
    });

    it('owns up to not following the passage look-ahead', () => {
        // Observed imagery cannot be at a future moment: the scrubber names it.
        expect(read('components/map/useWeatherLayers.ts')).toContain("['satIR', 'satellite cloud']");
    });

    it('mounts on the Obs chart with its credit, key and loading state', () => {
        const hub = read('components/map/MapHub.tsx');
        expect(hub).toContain('useSatelliteLayer(');
        expect(hub).toContain('<SatelliteIrCredit');
        expect(hub).toContain("satelliteIr: weather.activeLayers.has('satIR')");
        expect(hub).toContain("satLoading={satellite.status === 'loading'}");
    });

    it('anchors through imageryOrder and consults Satellite Mode', () => {
        const hook = read('components/map/useSatelliteLayer.ts');
        expect(hook).toContain("from './imageryOrder'");
        expect(hook).toContain('cloudOverlayBeforeId(');
        expect(hook).toContain("satelliteModeBlocks('raster')");
        // One source: the frames swap through updateImage, never a source per frame.
        expect(hook).toContain('updateImage(');
        expect((hook.match(/addSource\(/g) ?? []).length).toBe(1);
    });

    it('hands Mapbox data: URLs, which the CSP lets fetch() read (blob: it does not)', () => {
        for (const [file, csp] of [
            ['index.html', /connect-src([^;]*);/.exec(read('index.html'))?.[1]],
            ['vercel.json', /connect-src([^;]*);/.exec(read('vercel.json'))?.[1]],
        ] as const) {
            expect(csp, file).toBeDefined();
            const sources = csp!.trim().split(/\s+/);
            expect(sources, file).toContain('data:');
            expect(
                sources.some((s) => s === 'https://*.noaa.gov' || s === 'https://nowcoast.noaa.gov'),
                file,
            ).toBe(true);
        }
    });

    it('is worldwide: no national service or country in the source', () => {
        for (const file of [
            'components/map/satelliteImagery.ts',
            'components/map/satIrPixels.ts',
            'components/map/useSatelliteLayer.ts',
        ]) {
            expect(read(file)).not.toMatch(/\b(BOM|Bureau of Meteorology|Australia|Queensland)\b/);
        }
    });

    it('the dead SatelliteImageryService is gone', () => {
        expect(existsSync('services/weather/SatelliteImageryService.ts')).toBe(false);
    });
});
