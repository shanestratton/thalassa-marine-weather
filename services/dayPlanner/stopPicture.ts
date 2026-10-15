/**
 * stopPicture — the stop page's route picture and shelter rose (build 132,
 * 132-PYD-9), worked out on the phone from what Plan Your Day already holds:
 * the OpenStreetMap coastline it read round the start (the one its shelter
 * and distances use; nothing new is asked), her start, the stop, the routed
 * line once there is one, and the stop's 36-sector land table. Pure:
 * components/dayPlanner/TodayStopPicture.tsx draws it, in its own chunk.
 *
 * NEVER A STRAIGHT LINE. No line is drawn until the stop is routed on her
 * charts: an estimate's straight line would cross the very land it draws.
 *
 * LAND IS OPENSTREETMAP ONLY, never guessed, and no chart features (licence
 * and clutter). OSM draws its coast with the land on the left, so each row of
 * the picture is crossed west to east and turns land or water at every coast
 * it meets: islands and headlands come out filled, with no closed shapes
 * needed. Where the coastline did not load, or OSM maps none in the picture,
 * it is drawn grey and says so, never as open sea; so is anything past the
 * ground the coastline was asked for.
 *
 * The picture is 200 × 100 units. Its marks keep to the middle (x 6-194, y
 * 12-78): the pin stands 11 units over the stop, and the bottom 22 units are
 * the band where the page writes what the land is and the wind, so no word
 * ever covers her start or the stop.
 */
import type { Segment } from '../weather/shelter/shelterGeometry';
import type { LatLon } from './places';
import { compass8 } from './today';

/** Rows of land, each two units tall. */
const ROWS = 50;
/** Where the marks' middle is drawn: over the band. */
const MID_Y = 45;
/**
 * How far round the start land is known, in degrees of latitude: the
 * coastline is asked for 60 km round the start and kept for its 0.1° cell
 * (coastlineSource), so 50 km (27 NM) is always inside what it holds.
 */
export const COAST_REACH_DEG = 0.45;

/** The picture's ground: its middle, in degrees of latitude east (x) and north (y) of the start, and its scale
 *  (units a degree). */
export interface PictureFrame {
    lat0: number;
    lon0: number;
    cos: number;
    cx: number;
    cy: number;
    scale: number;
}

const local = (f: PictureFrame, lon: number, lat: number): [number, number] => [
    (((((lon - f.lon0 + 180) % 360) + 360) % 360) - 180) * f.cos,
    lat - f.lat0,
];

/** Her start, the stop and the routed line, with room round them, never under 3 NM across. */
export function pictureFrame(start: LatLon, points: readonly LatLon[]): PictureFrame {
    const f: PictureFrame = {
        lat0: start.lat,
        lon0: start.lon,
        cos: Math.cos((start.lat * Math.PI) / 180),
        cx: 0,
        cy: 0,
        scale: 0,
    };
    let [x0, x1, y0, y1] = [0, 0, 0, 0];
    for (const p of points) {
        const [x, y] = local(f, p.lon, p.lat);
        [x0, x1, y0, y1] = [Math.min(x0, x), Math.max(x1, x), Math.min(y0, y), Math.max(y1, y)];
    }
    f.cx = (x0 + x1) / 2;
    f.cy = (y0 + y1) / 2;
    f.scale = Math.min(188 / ((x1 - x0) * 1.15 + 0.01), 66 / ((y1 - y0) * 1.15 + 0.01), 4000);
    return f;
}

/** Where a place is drawn, in the picture's units. */
export function pictureXY(f: PictureFrame, p: LatLon): [number, number] {
    const [x, y] = local(f, p.lon, p.lat);
    return [Math.round((100 + (x - f.cx) * f.scale) * 10) / 10, Math.round((MID_Y - (y - f.cy) * f.scale) * 10) / 10];
}

type Cut = [at: number, entersLand: boolean];

/** Land at `at` along a line, from the coasts that cross it (sorted): the last one before it decides, and before
 *  the first, its other side. Null when no coast crosses. */
function landAt(cuts: readonly Cut[], at: number): boolean | null {
    let land = cuts.length ? !cuts[0][1] : null;
    for (const [pos, enters] of cuts) {
        if (pos > at) break;
        land = enters;
    }
    return land;
}

/** The land as the picture draws it: 'none' when the coastline did not load, 'empty' when OSM maps no coast in
 *  the picture; otherwise its land as one path, and the ground past the coastline's reach as another. */
export type PictureLand = { kind: 'none' } | { kind: 'empty' } | { kind: 'land'; d: string; edge: string | null };

export function pictureLand(f: PictureFrame, coastline: readonly Segment[] | null): PictureLand {
    if (!coastline) return { kind: 'none' };
    const s = f.scale;
    const top = f.cy + MID_Y / s;
    const bottom = f.cy - (100 - MID_Y) / s;
    const rowY = (row: number) => f.cy + (MID_Y - row * 2 - 1) / s;
    const band: number[] = [];
    // The column through the middle, crossed south to north: a coast going east has its land on the north.
    const column: Cut[] = [];
    for (const seg of coastline) {
        if (seg?.length !== 2) continue;
        const [ax, ay] = local(f, seg[0][0], seg[0][1]);
        const [bx, by] = local(f, seg[1][0], seg[1][1]);
        if (Math.max(ay, by) >= bottom && Math.min(ay, by) <= top) band.push(ax, ay, bx, by);
        if (ax <= f.cx !== bx <= f.cx) column.push([ay + ((f.cx - ax) * (by - ay)) / (bx - ax), bx > ax]);
    }
    column.sort((a, b) => a[0] - b[0]);
    let d = '';
    const run = (row: number, from: number, to: number) => {
        const a = Math.max(0, 100 + (from - f.cx) * s);
        const b = Math.min(200, 100 + (to - f.cx) * s);
        // A little over two units tall, so no seam shows between rows.
        if (b > a) d += `M${a.toFixed(1)} ${row * 2}h${(b - a).toFixed(1)}v2.2h${(a - b).toFixed(1)}z`;
    };
    const flat: number[] = [];
    let middle: boolean | null = null;
    for (let row = 0; row < ROWS; row++) {
        const y = rowY(row);
        const cuts: Cut[] = [];
        // West to east: a coast going south has its land on the east, so crossing it enters land.
        for (let i = 0; i < band.length; i += 4) {
            const [ax, ay, bx, by] = [band[i], band[i + 1], band[i + 2], band[i + 3]];
            if (ay <= y !== by <= y) cuts.push([ax + ((y - ay) * (bx - ax)) / (by - ay), by < ay]);
        }
        if (!cuts.length) {
            flat.push(row);
            continue;
        }
        cuts.sort((a, b) => a[0] - b[0]);
        middle ??= landAt(cuts, f.cx);
        let from = cuts[0][1] ? null : -Infinity;
        for (const [x, enters] of cuts) {
            if (enters) from ??= x;
            else if (from !== null) {
                run(row, from, x);
                from = null;
            }
        }
        if (from !== null) run(row, from, Infinity);
    }
    if (flat.length === ROWS && !column.length) return { kind: 'empty' };
    // A row no coast crosses is all one thing: what the middle column says there, or (with no coast across that
    // column at all) what a row the coast does cross says at the middle.
    for (const row of flat) if ((landAt(column, rowY(row)) ?? middle) === true) run(row, -Infinity, Infinity);
    const [l, r] = [100 - (COAST_REACH_DEG + f.cx) * s, 100 + (COAST_REACH_DEG - f.cx) * s];
    const [t, b] = [MID_Y - (COAST_REACH_DEG - f.cy) * s, MID_Y + (COAST_REACH_DEG + f.cy) * s];
    const edge =
        l > 0 || r < 200 || t > 0 || b < 100
            ? `M0 0H200V100H0z M${l.toFixed(1)} ${t.toFixed(1)}H${r.toFixed(1)}V${b.toFixed(1)}H${l.toFixed(1)}z`
            : null;
    return { kind: 'land', d, edge };
}

/** What the picture says of its land: a few words in its band, and the whole of it for VoiceOver. */
export function pictureNote(land: PictureLand): { shown: string; said: string } {
    if (land.kind === 'none') return { shown: 'Land not loaded', said: "Land not drawn: the coastline didn't load" };
    if (land.kind === 'empty')
        return { shown: 'No coast mapped here', said: 'No coastline mapped here: land may be missing' };
    return land.edge
        ? { shown: 'Land © OpenStreetMap, to 27 NM', said: 'Land © OpenStreetMap, drawn to 27 NM from the start' }
        : { shown: 'Land © OpenStreetMap', said: 'Land © OpenStreetMap' };
}

/**
 * How far each of the 36 sectors shelters her, 0 to 1: a full lee within
 * 1 NM of land, none at 10 NM or more, as anchorageVerdict reads the same
 * table (its SHELTERED_NM and OPEN_NM).
 */
export const roseReach = (table: readonly number[]): number[] =>
    table.map((nm) => Math.min(1, Math.max(0, (10 - nm) / 9)));

/** The rose, 16 × 16: each sector a wedge toward its bearing, as long as the land there shelters her. */
export function rosePath(table: readonly number[]): string {
    let d = '';
    roseReach(table).forEach((reach, i) => {
        if (!(reach > 0)) return;
        const r = 7 * reach;
        const at = (deg: number) =>
            `${(8 + r * Math.sin((deg * Math.PI) / 180)).toFixed(2)} ${(8 - r * Math.cos((deg * Math.PI) / 180)).toFixed(2)}`;
        d += `M8 8L${at(i * 10 - 5)}A${r.toFixed(2)} ${r.toFixed(2)} 0 0 1 ${at(i * 10 + 5)}z`;
    });
    return d;
}

/** The rose in words: the points of the compass where land shelters her at least half (within about 5.5 NM). */
export function roseWords(table: readonly number[]): string {
    const points = new Map<string, number[]>();
    roseReach(table).forEach((reach, i) => {
        const point = compass8(i * 10);
        points.set(point, [...(points.get(point) ?? []), reach]);
    });
    const close = [...points]
        .filter(([, reach]) => reach.reduce((a, b) => a + b, 0) / reach.length >= 0.5)
        .map(([point]) => point);
    return `Shelter rose: ${close.length ? `land close to the ${close.join(', ')}` : 'no land close by'}`;
}
