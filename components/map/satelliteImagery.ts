/**
 * satelliteImagery — the observed satellite cloud layer ("Sat cloud", W1-10):
 * its source, frame times, colours and coverage. Pure, React-free, map-free.
 *
 * SOURCE. NOAA/NESDIS GMGSI longwave infrared (~12 µm), served by nowCOAST's
 * GeoServer WMS: one hourly global mosaic of GOES-East, GOES-West, Meteosat 0°,
 * Meteosat IODC and Himawari. Public domain (NODD: "can be used as desired";
 * attribution requested, altered imagery must not pass as NOAA's). CORS is `*`
 * and the CSP already allows *.noaa.gov, so the phone reads it directly: no
 * proxy, no edge function, no Pi, no database.
 *
 * WHY ONE IMAGE PER FRAME, NOT A TILE SOURCE (measured live 2026-10-07, see
 * tests/SatelliteLayer.test.ts). GeoServer contrast-stretches every GetMap
 * response by its own content: the same pixels read 122 in a z6 tile on their
 * own and 36 inside a 3x3-tile request, and adjacent tiles jumped 8–62 counts
 * at their seams. A z/x/y source would be a patchwork. One request for the
 * whole belt has one stretch and no seams.
 *
 * WHY EVERY FRAME IS ANCHORED BEFORE IT IS SHOWN. The stretch is a pure gain
 * (out = k · in, offset ~0) set by the brightest pixel in the request, and that
 * pixel is not always cloud. The 15Z frame requested at ±66° held a no-data
 * wedge (255) at 64.7–66°N, 91–93°E, near where the IODC and Himawari
 * footprints meet, and the whole frame came back 12% darker than the same frame at
 * ±60° (fit 0.8815·x + 0.1): its deep convection lost every cyan and red pixel.
 * So the phone measures each frame's tropical 99.9th percentile (satIrAnchor)
 * and rescales that frame onto the ramp's own scale, and a frame whose anchor
 * is out of the measured band is never shown. A fixed ramp on raw counts would
 * mean something different every hour.
 *
 * WHY ±60°. The service's own abstract gives 60°N–60°S. The polar no-data
 * wedges sit just past it (64.7°N at 15Z, 69.2°N at 14Z), the ±60° request kept
 * the same stretch in all seven frames measured (tropical p99.9 241–245), and the
 * 60–66° band was 94–99% painted anyway: at that slant cold sea and ice read as
 * cloud. Past 55° the clearest tenth of pixels already carries a veil (alpha
 * 0.13–0.18), hence the low-angle note there. Beyond 60° there is no imagery,
 * and the chip says so whenever the view reaches it.
 *
 * MEMORY (the 2 GB WebContent jetsam). One image source holds one 3072x1288
 * frame: ~15.8 MB decoded plus one GPU texture of the same size, which
 * updateImage refills in place because every frame has the same dimensions. It
 * does not grow with panning or zoom the way a tile cache does. Anchoring
 * decodes each new frame once more, one frame at a time, and frees it at once
 * (satIrPixels). The ≤6 frames' bytes are kept as data: URLs (~0.5 MB each).
 */
import type mapboxgl from 'mapbox-gl';

export const GMGSI_WMS_URL = 'https://nowcoast.noaa.gov/geoserver/satellite/wms';
export const GMGSI_LAYER = 'global_longwave_imagery_mosaic';
export const SAT_IR_CAPABILITIES_URL = `${GMGSI_WMS_URL}?service=WMS&version=1.3.0&request=GetCapabilities`;

export const SAT_IR_SOURCE_ID = 'sat-ir';
export const SAT_IR_LAYER_ID = 'sat-ir-layer';

/** Frames in the loop. The server keeps 5–7 hourly frames (measured). */
export const SAT_IR_MAX_FRAMES = 6;
/** Latitude the image covers, north and south (see the header). */
export const SAT_IR_EXTENT_DEG = 60;
/** Poleward of this the satellites look in at a low angle (measured veil, see the header). */
export const SAT_IR_LOW_ANGLE_DEG = 55;
/** 3072 px round the world: ~13 km a pixel at the equator, ~6.5 km at 60°. */
export const SAT_IR_IMAGE_WIDTH = 3072;

export const SAT_IR_CREDIT = 'NOAA/NESDIS GMGSI: GOES, Meteosat (EUMETSAT), Himawari (JMA)';

const R = 6378137;
const HALF_WORLD_M = Math.PI * R;
const mercatorY = (lat: number) => R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const EXTENT_Y_M = mercatorY(SAT_IR_EXTENT_DEG);

/** Pixel height that keeps the Mercator image square-pixelled: 1288. */
export const SAT_IR_IMAGE_HEIGHT = Math.round((SAT_IR_IMAGE_WIDTH * EXTENT_Y_M) / HALF_WORLD_M);

export interface SatIrFrame {
    /** The time exactly as the capabilities list it — it goes back in the URL. */
    iso: string;
    timeMs: number;
}

/** An instant the server listed: nothing else may reach the request URL. */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z$/;
const PERIOD = /^PT(?:(\d+)H)?(?:(\d+)M)?$/;

function instant(text: string): SatIrFrame | null {
    const iso = text.trim();
    const timeMs = INSTANT.test(iso) ? Date.parse(iso) : NaN;
    return Number.isFinite(timeMs) ? { iso, timeMs } : null;
}

/**
 * The longwave mosaic's time list from a WMS 1.3.0 GetCapabilities document,
 * oldest first. Scoped to that layer's own <Layer> element, so a neighbour's
 * list (the GOES layers carry 5-minute ones) is never read. Null when the layer
 * or its times are missing: the caller shows "unavailable", never a guess.
 */
export function parseGmgsiFrames(xml: string): SatIrFrame[] | null {
    const at = xml.indexOf(`<Name>${GMGSI_LAYER}</Name>`);
    if (at < 0) return null;
    const end = xml.indexOf('</Layer>', at);
    const block = xml.slice(at, end < 0 ? undefined : end);
    const list = /<Dimension\s+name="time"[^>]*>([^<]*)</i.exec(block)?.[1]?.trim();
    if (!list) return null;
    const frames: SatIrFrame[] = [];
    for (const item of list.split(',')) {
        const [start, stop, period] = item.split('/');
        if (stop === undefined) {
            const f = instant(start);
            if (f) frames.push(f);
            continue;
        }
        // start/end/period: hourly in practice; expanded, never extrapolated.
        const a = instant(start);
        const b = instant(stop);
        const p = PERIOD.exec(period?.trim() ?? '');
        const step = p ? (Number(p[1] ?? 0) * 60 + Number(p[2] ?? 0)) * 60_000 : 0;
        if (!a || !b || step <= 0) continue;
        for (let t = a.timeMs; t <= b.timeMs && frames.length < 500; t += step) {
            frames.push({ iso: new Date(t).toISOString(), timeMs: t });
        }
    }
    const byTime = new Map(frames.map((f) => [f.timeMs, f]));
    const sorted = [...byTime.values()].sort((x, y) => x.timeMs - y.timeMs);
    return sorted.length > 0 ? sorted : null;
}

/** A frame stamped further ahead of the phone's clock than this is not an observation. */
const FUTURE_SLACK_MS = 10 * 60_000;

/**
 * The frames to show: the newest SAT_IR_MAX_FRAMES the server listed. The
 * clock only ever REMOVES a frame (one stamped in the future); it never
 * creates one — that was the old GIBS "today at UTC midnight" bug.
 */
export function satIrFrames(all: readonly SatIrFrame[], nowMs: number): SatIrFrame[] {
    return all.filter((f) => f.timeMs <= nowMs + FUTURE_SLACK_MS).slice(-SAT_IR_MAX_FRAMES);
}

/**
 * One GetMap for the whole ±60° belt at one frame's time. Greyscale JPEG on a
 * black background: ~390 KB against ~3.4 MB as PNG (mean |diff| 1.6 counts),
 * and black is "warm", so anything the server leaves empty stays transparent.
 * Deterministic to the byte, so every phone shares the CDN's copy.
 */
export function satIrImageUrl(frame: SatIrFrame): string {
    const x = HALF_WORLD_M.toFixed(2);
    const y = EXTENT_Y_M.toFixed(2);
    return (
        `${GMGSI_WMS_URL}?service=WMS&version=1.3.0&request=GetMap&layers=${GMGSI_LAYER}&styles=` +
        `&format=image/jpeg&bgcolor=0x000000&crs=EPSG:3857` +
        `&width=${SAT_IR_IMAGE_WIDTH}&height=${SAT_IR_IMAGE_HEIGHT}&bbox=-${x},-${y},${x},${y}&time=${frame.iso}`
    );
}

/** Corners of that image (top-left, clockwise) for the Mapbox image source. */
export function satIrImageCoordinates(): [[number, number], [number, number], [number, number], [number, number]] {
    const e = SAT_IR_EXTENT_DEG;
    return [
        [-180, e],
        [180, e],
        [180, -e],
        [-180, -e],
    ];
}

// ── Anchoring: one frame's stretch, measured on the phone ──

/** Rows within this latitude anchor the frame: the tropics always hold deep convection. */
export const SAT_IR_TROPICS_DEG = 25;
/** Grey counts from here up are left out of the anchor: the no-data fill and the clipped top. */
export const SAT_IR_FILL_GREY = 253;
/**
 * The tropical 99.9th percentile the ramp is drawn for: the median of the seven
 * ±60° frames measured on 2026-10-07 (10Z–16Z read 242, 241, 244, 243, 243, 245, 244).
 */
export const SAT_IR_ANCHOR_GREY = 243;
/**
 * Anchors outside this band mean the stretch was set by something other than
 * cloud (the ±66° 15Z frame read 217) or that the image is not a usable frame;
 * such a frame is not shown. Inside it the gain is corrected (by +7% to −4% at most).
 */
export const SAT_IR_ANCHOR_BAND: readonly [number, number] = [228, 252];
/** More fill than this inside the tropics is a hole in the mosaic, not a stretch (natural: under 0.01%). */
const MAX_TROPICAL_FILL = 0.002;
const MIN_ANCHOR_PIXELS = 10_000;

/**
 * Which image rows lie within ±SAT_IR_TROPICS_DEG — the same rule the
 * measurements used (row centre inside the band). 424 rows from the top, 440
 * rows, in the 1288 px image.
 */
export function satIrTropicalRows(height: number): { first: number; count: number } {
    const limit = mercatorY(SAT_IR_TROPICS_DEG);
    let first = -1;
    let count = 0;
    for (let r = 0; r < height; r++) {
        const y = EXTENT_Y_M - ((r + 0.5) / height) * 2 * EXTENT_Y_M;
        if (Math.abs(y) < limit) {
            if (first < 0) first = r;
            count++;
        }
    }
    return { first: Math.max(0, first), count };
}

export type SatIrAnchor =
    | { usable: true; p999: number; scale: number }
    | { usable: false; p999: number | null; reason: 'empty' | 'no-data' | 'stretch' };

/**
 * A frame's anchor from its tropical grey histogram (256 bins): the 99.9th
 * percentile below the fill, and the gain that puts it at SAT_IR_ANCHOR_GREY.
 */
export function satIrAnchor(hist: ArrayLike<number>): SatIrAnchor {
    let total = 0;
    let fill = 0;
    for (let v = 0; v < 256; v++) {
        const n = hist[v] ?? 0;
        if (v >= SAT_IR_FILL_GREY) fill += n;
        else total += n;
    }
    if (total < MIN_ANCHOR_PIXELS) return { usable: false, p999: null, reason: 'empty' };
    let p999 = 0;
    for (let v = 0, seen = 0; v < SAT_IR_FILL_GREY; v++) {
        seen += hist[v] ?? 0;
        if (seen >= 0.999 * total) {
            p999 = v;
            break;
        }
    }
    if (fill / (total + fill) > MAX_TROPICAL_FILL) return { usable: false, p999, reason: 'no-data' };
    const [lo, hi] = SAT_IR_ANCHOR_BAND;
    if (p999 < lo || p999 > hi) return { usable: false, p999, reason: 'stretch' };
    return { usable: true, p999, scale: SAT_IR_ANCHOR_GREY / p999 };
}

/**
 * Enhanced-IR ramp over the ANCHORED grey value (cold = bright), measured on
 * the ±60° frames: clear sea and land at the six fixture sites read 68–94 (10th
 * percentile, all frames), so everything to 110 is transparent. Cloud fades in
 * as grey-white, a North Sea front (166–193) reads solid white, and in every
 * anchored frame the coldest ~2% of tropical pixels turn cyan and the coldest
 * ~0.4% red: deep convection. The anchor is what keeps those shares steady from
 * hour to hour; on raw counts the darkened ±66° 15Z frame had 0.18% cyan and no
 * red at all.
 */
export const SAT_IR_RAMP: ReadonlyArray<readonly [value: number, rgba: readonly [number, number, number, number]]> = [
    [110, [255, 255, 255, 0]],
    [145, [226, 232, 240, 0.45]],
    [185, [241, 245, 249, 0.8]],
    [205, [255, 255, 255, 0.85]],
    [225, [34, 211, 238, 0.9]],
    [242, [239, 68, 68, 0.95]],
];

const rgbaCss = ([r, g, b, a]: readonly number[]) => `rgba(${r},${g},${b},${a})`;

/** The ramp's colour at an anchored grey value — what the GPU draws, for tests and the legend. */
export function satIrColourAt(value: number): [number, number, number, number] {
    const stops = SAT_IR_RAMP;
    if (value <= stops[0][0]) return [...stops[0][1]] as [number, number, number, number];
    for (let i = 1; i < stops.length; i++) {
        const [v1, c1] = stops[i];
        if (value <= v1) {
            const [v0, c0] = stops[i - 1];
            const t = (value - v0) / (v1 - v0);
            return c0.map((c, k) => c + (c1[k] - c) * t) as [number, number, number, number];
        }
    }
    return [...stops[stops.length - 1][1]] as [number, number, number, number];
}

export const satIrAlphaAt = (value: number): number => satIrColourAt(value)[3];

/** The legend's bar: the ramp from its first stop to its last. */
export const SAT_IR_LEGEND_GRADIENT = `linear-gradient(90deg, ${SAT_IR_RAMP.map(
    ([v, c]) =>
        `${rgbaCss(c)} ${Math.round(((v - SAT_IR_RAMP[0][0]) / (SAT_IR_RAMP[SAT_IR_RAMP.length - 1][0] - SAT_IR_RAMP[0][0])) * 100)}%`,
).join(', ')})`;

/**
 * GL JS 3.19 feeds the channels as 0..1 (reliefBase.ts): scale the grey
 * (R = G = B) back to its 0..255 count, times this frame's anchor gain.
 */
export function satIrColorMix(scale: number): [number, number, number, number] {
    return [255 * scale, 0, 0, 0];
}

/** The raster layer's paint for a frame anchored with `scale`. */
export function satIrPaint(scale: number) {
    return {
        'raster-color': [
            'interpolate',
            ['linear'],
            ['raster-value'],
            0,
            rgbaCss(SAT_IR_RAMP[0][1]),
            ...SAT_IR_RAMP.flatMap(([v, c]) => [v, rgbaCss(c)]),
            255,
            rgbaCss(SAT_IR_RAMP[SAT_IR_RAMP.length - 1][1]),
        ] as mapboxgl.ExpressionSpecification,
        'raster-color-mix': satIrColorMix(scale),
        // The gain changes with the frame, in the same render as its pixels.
        'raster-color-mix-transition': { duration: 0, delay: 0 },
        'raster-color-range': [0, 255] as [number, number],
        'raster-resampling': 'linear' as const,
        // Frames swap in place; a fade would flash the chart between them.
        'raster-fade-duration': 0,
    };
}

/** What the view can see of the imagery. Worked out from the view's edges, not just its centre. */
export interface SatIrCoverage {
    /** The view's centre is past the imagery's northern or southern edge: nothing is drawn there. */
    outside: 'N' | 'S' | null;
    /** The view reaches past the imagery's northern / southern edge. */
    edgeNorth: boolean;
    edgeSouth: boolean;
    /** The view reaches the low-angle band. */
    lowAngle: boolean;
}

export const SAT_IR_FULL_COVERAGE: SatIrCoverage = {
    outside: null,
    edgeNorth: false,
    edgeSouth: false,
    lowAngle: false,
};

export function satIrCoverage(view: { centreLat: number; north?: number; south?: number }): SatIrCoverage {
    const { centreLat } = view;
    const north = Number.isFinite(view.north) ? (view.north as number) : centreLat;
    const south = Number.isFinite(view.south) ? (view.south as number) : centreLat;
    return {
        outside: centreLat > SAT_IR_EXTENT_DEG ? 'N' : centreLat < -SAT_IR_EXTENT_DEG ? 'S' : null,
        edgeNorth: north > SAT_IR_EXTENT_DEG,
        edgeSouth: south < -SAT_IR_EXTENT_DEG,
        lowAngle: north > SAT_IR_LOW_ANGLE_DEG || south < -SAT_IR_LOW_ANGLE_DEG,
    };
}

export const sameSatIrCoverage = (a: SatIrCoverage, b: SatIrCoverage): boolean =>
    a.outside === b.outside && a.edgeNorth === b.edgeNorth && a.edgeSouth === b.edgeSouth && a.lowAngle === b.lowAngle;

/**
 * The chip's caveat for what is in view, or null when the view is all inside
 * the good imagery. Past the edge nothing is drawn, and empty chart reads
 * exactly like clear sky, so the edge is said first.
 */
export function satIrCoverageNote(c: SatIrCoverage): string | null {
    if (c.outside) return `No satellite cloud imagery past ${SAT_IR_EXTENT_DEG}°${c.outside}`;
    const edge = c.edgeNorth && c.edgeSouth ? 'N/S' : c.edgeNorth ? 'N' : c.edgeSouth ? 'S' : '';
    if (edge) return `no imagery past ${SAT_IR_EXTENT_DEG}°${edge}`;
    if (c.lowAngle) return `low satellite angle past ${SAT_IR_LOW_ANGLE_DEG}°`;
    return null;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "Satellite IR 14:00 UTC · 1 h old" — the frame's own time, always UTC. */
export function satIrAgeLabel(frameMs: number, nowMs: number): string {
    const d = new Date(frameMs);
    const minutes = Math.max(0, Math.round((nowMs - frameMs) / 60_000));
    const age = minutes < 60 ? `${minutes} min old` : `${Math.round(minutes / 60)} h old`;
    return `Satellite IR ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC · ${age}`;
}
