// Generated from components/map/satelliteImagery.ts; source SHA256 cfa0ea4bb5c050d61d60892d302a3f7c4be1561149aa4f8224c905383678f582
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
