/**
 * mapLayers — pure builders for the ocean map: GeoJSON from the fleet summary
 * and the context file, the filter and weight expressions, and the boxes the
 * rows view is asked for. No mapbox-gl import (types only), so it stays in
 * the small page chunk and is unit-tested directly.
 *
 * GLOBAL: every coordinate here works anywhere. Cells are points (no cell
 * straddles the antimeridian, both grids are aligned to 0°), and viewport
 * boxes that cross it are split in two.
 */
import type { ContextFile, FleetCell, FleetRow, Group } from './oceanApi';
import { inBox } from './regions';

type Expression = unknown[];
interface PointFeature {
    type: 'Feature';
    geometry: { type: 'Point'; coordinates: [number, number] };
    properties: Record<string, string | number | boolean | null>;
}
export interface Collection {
    type: 'FeatureCollection';
    features: PointFeature[];
}

const point = (lon: number, lat: number, properties: PointFeature['properties']): PointFeature => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties,
});

/** Metres per pixel at zoom 0 on the equator (512 px tiles). */
const M_PER_PX_Z0 = 78271.517;

/**
 * Radius in pixels at zoom 0 of a disc of `metres` at this latitude.
 * groundRadius() below scales it by 2^zoom, so the disc keeps its true ground
 * size at every zoom.
 */
export const radiusAtZ0 = (metres: number, lat: number): number =>
    metres / (M_PER_PX_Z0 * Math.max(0.05, Math.cos((lat * Math.PI) / 180)));

export const groundRadius = (property = 'r0', minPx = 0): Expression => {
    // zoom may only feed a top-level interpolate, so the floor goes in each
    // stop. Stops every 2 zooms keep the disc at true size wherever it is
    // above the floor (base-2 exponential between true sizes is exact).
    const stops: unknown[] = [];
    for (let z = 0; z <= 22; z += 2) {
        const size = ['*', ['get', property], 2 ** z];
        stops.push(z, minPx > 0 ? ['max', minPx, size] : size);
    }
    return ['interpolate', ['exponential', 2], ['zoom'], ...stops];
};

/** The summary's 0.1° cells as points. Blurred cells carry their ~5.5 km half-width. */
export function fleetCellsGeoJson(cells: readonly FleetCell[]): Collection {
    return {
        type: 'FeatureCollection',
        features: cells.map((c) =>
            point(c.lon, c.lat, {
                g: c.group,
                sci: c.sci,
                gen: c.generalised,
                y: c.year,
                m: c.month,
                n: c.n,
                a: c.animals,
                r0: radiusAtZ0(5500, c.lat),
            }),
        ),
    };
}

/** Public rows (zoom 8 and closer), each with its uncertainty disc. */
export function fleetRowsGeoJson(rows: readonly FleetRow[]): Collection {
    return {
        type: 'FeatureCollection',
        features: rows.map((r) =>
            point(r.lon, r.lat, {
                id: r.id,
                g: r.group,
                sci: r.sci,
                name: r.name,
                gen: r.generalised,
                n: r.count,
                calf: r.calf,
                t: r.time,
                m: new Date(r.time).getUTCMonth() + 1,
                u: r.uncertaintyM,
                credit: r.credit,
                r0: radiusAtZ0(r.uncertaintyM, r.lat),
            }),
        ),
    };
}

/**
 * Historical record cells as points with flat properties (expressions cannot
 * index arrays inside GeoJSON properties): d = record-days, m1..m12 = the
 * month-dated record-days, cd = the cell size, r0 = its half-width.
 */
export function contextGeoJson(context: ContextFile | null): Collection {
    const features: PointFeature[] = [];
    for (const sp of context?.species ?? []) {
        for (const [lat, lon, days, months] of sp.cells) {
            const props: PointFeature['properties'] = {
                g: sp.group,
                sci: sp.sci,
                name: sp.name,
                d: days,
                cd: sp.cellDeg,
                y0: sp.years?.[0] ?? null,
                y1: sp.years?.[1] ?? null,
                r0: radiusAtZ0((sp.cellDeg * 111_320) / 2, lat),
            };
            for (let i = 0; i < 12; i += 1) props[`m${i + 1}`] = months?.[i] ?? 0;
            features.push(point(lon, lat, props));
        }
    }
    return { type: 'FeatureCollection', features };
}

interface SquareFeature {
    type: 'Feature';
    geometry: { type: 'Polygon'; coordinates: [number, number][][] };
    properties: PointFeature['properties'];
}

/**
 * The same historical cells as true squares (0.25° or 0.5°), for close zoom:
 * a record cell is an area, not a spot, and a square says so. Cells are
 * aligned to 0°, so no square crosses the antimeridian.
 */
export function contextSquaresGeoJson(context: ContextFile | null): {
    type: 'FeatureCollection';
    features: SquareFeature[];
} {
    const points = contextGeoJson(context).features;
    return {
        type: 'FeatureCollection',
        features: points.map((f) => {
            const [lon, lat] = f.geometry.coordinates;
            const h = Number(f.properties.cd) / 2;
            const ring: [number, number][] = [
                [lon - h, lat - h],
                [lon + h, lat - h],
                [lon + h, lat + h],
                [lon - h, lat + h],
                [lon - h, lat - h],
            ];
            return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: f.properties };
        }),
    };
}

/** Fleet filter: the chosen groups, and the month when one is chosen (UTC month of the floored time). */
export function fleetFilter(groups: readonly Group[], month: number): Expression {
    const byGroup = ['in', ['get', 'g'], ['literal', [...groups]]];
    return month ? ['all', byGroup, ['==', ['get', 'm'], month]] : ['all', byGroup];
}

/** Context filter: the chosen groups, and only cells with records in the chosen month. */
export function contextFilter(groups: readonly Group[], month: number): Expression {
    const byGroup = ['in', ['get', 'g'], ['literal', [...groups]]];
    return month ? ['all', byGroup, ['>', ['get', `m${month}`], 0]] : ['all', byGroup];
}

/** Heat weight: log-scaled record-days, so one colony census can't drown the coast. */
export function contextWeight(month: number): Expression {
    const key = month ? `m${month}` : 'd';
    return ['min', 1, ['/', ['ln', ['+', 1, ['get', key]]], ['ln', 64]]];
}

/**
 * Whole-degree boxes covering a viewport, each at most `max`° each way,
 * longitudes normalised to [-180, 180] and split at the antimeridian. The
 * server takes exactly this shape (api/ocean/[view].ts).
 */
export function rowBoxes(
    west: number,
    south: number,
    east: number,
    north: number,
    max = 10,
): Array<[number, number, number, number]> {
    const s = Math.max(-90, Math.floor(south));
    const n = Math.min(90, Math.ceil(north));
    if (!(n > s)) return [];
    let w = Math.floor(west);
    let e = Math.ceil(east);
    if (e - w >= 360) {
        w = -180;
        e = 180;
    } else {
        const shift = Math.floor((w + 180) / 360) * 360;
        w -= shift;
        e -= shift;
    }
    const lonSpans: Array<[number, number]> =
        e > 180
            ? [
                  [w, 180],
                  [-180, e - 360],
              ]
            : [[w, e]];
    const out: Array<[number, number, number, number]> = [];
    for (const [a, b] of lonSpans) {
        for (let x = a; x < b; x += max) {
            for (let y = s; y < n; y += max) out.push([y, x, Math.min(n, y + max), Math.min(b, x + max)]);
        }
    }
    return out;
}

export const boxKey = (box: readonly number[]): string => box.join(',');

/** fitBounds corners for a region box; a box that crosses the antimeridian uses east + 360. */
export function regionBounds(bbox: readonly [number, number, number, number]): [[number, number], [number, number]] {
    const [w, s, e, n] = bbox;
    return [
        [w, s],
        [e < w ? e + 360 : e, n],
    ];
}

export interface Tally {
    sightings: number;
    animals: number;
    species: number;
}

/** Fleet totals over the cells that pass a filter. */
export function tallyCells(cells: readonly FleetCell[], keep: (c: FleetCell) => boolean = () => true): Tally {
    let sightings = 0;
    let animals = 0;
    const species = new Set<string>();
    for (const c of cells) {
        if (!keep(c)) continue;
        sightings += c.n;
        animals += c.animals;
        if (c.sci) species.add(c.sci);
    }
    return { sightings, animals, species: species.size };
}

/** Context record-days and species over the shown groups and month, and the years they span. */
export function tallyContext(
    context: ContextFile | null,
    groups: readonly Group[],
    month: number,
    bbox?: readonly [number, number, number, number],
): { recordDays: number; species: number; years: [number, number] | null } {
    let recordDays = 0;
    let lo = Infinity;
    let hi = -Infinity;
    const species = new Set<string>();
    for (const sp of context?.species ?? []) {
        if (!groups.includes(sp.group)) continue;
        let days = 0;
        for (const [lat, lon, d, months] of sp.cells) {
            if (bbox && !inBox(lat, lon, bbox)) continue;
            days += month ? (months?.[month - 1] ?? 0) : d;
        }
        if (days <= 0) continue;
        recordDays += days;
        species.add(sp.sci);
        if (sp.years) {
            lo = Math.min(lo, sp.years[0]);
            hi = Math.max(hi, sp.years[1]);
        }
    }
    return { recordDays, species: species.size, years: species.size ? [lo, hi] : null };
}

/** Monthly bars for the scrubber: fleet sightings when there are any, else historical record-days. */
export function monthBars(
    cells: readonly FleetCell[],
    context: ContextFile | null,
    groups: readonly Group[],
): { source: 'fleet' | 'context' | 'none'; values: number[] } {
    const fleet = Array(12).fill(0) as number[];
    for (const c of cells) if (groups.includes(c.group)) fleet[c.month - 1] += c.n;
    if (fleet.some((v) => v > 0)) return { source: 'fleet', values: fleet };
    const ctx = Array(12).fill(0) as number[];
    for (const sp of context?.species ?? []) {
        if (!groups.includes(sp.group)) continue;
        sp.months.forEach((v, i) => (ctx[i] += v));
    }
    return ctx.some((v) => v > 0) ? { source: 'context', values: ctx } : { source: 'none', values: ctx };
}

export interface RegionReport {
    month: Tally;
    year: Tally;
    /** Species seen in the region this month and not in the three months before. */
    newThisMonth: string[];
    historical: Array<{ sci: string; name: string; recordDays: number }>;
    historicalYears: [number, number] | null;
}

/** The area report card, from the summary cells (UTC month buckets) and the context cells. */
export function regionReport(
    cells: readonly FleetCell[],
    context: ContextFile | null,
    bbox: readonly [number, number, number, number],
    now = new Date(),
): RegionReport {
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth() + 1;
    const here = cells.filter((c) => inBox(c.lat, c.lon, bbox));
    const monthIndex = (c: FleetCell) => c.year * 12 + (c.month - 1);
    const thisIndex = y * 12 + (m - 1);
    const month = tallyCells(here, (c) => monthIndex(c) === thisIndex);
    const year = tallyCells(here, (c) => c.year === y);
    const before = new Set(
        here.filter((c) => c.sci && monthIndex(c) < thisIndex && monthIndex(c) >= thisIndex - 3).map((c) => c.sci),
    );
    const newThisMonth = [
        ...new Set(
            here.filter((c) => c.sci && monthIndex(c) === thisIndex && !before.has(c.sci)).map((c) => c.sci as string),
        ),
    ];
    const historical: RegionReport['historical'] = [];
    let lo = Infinity;
    let hi = -Infinity;
    for (const sp of context?.species ?? []) {
        let days = 0;
        for (const [lat, lon, d] of sp.cells) if (inBox(lat, lon, bbox)) days += d;
        if (days > 0) {
            historical.push({ sci: sp.sci, name: sp.name, recordDays: days });
            if (sp.years) {
                lo = Math.min(lo, sp.years[0]);
                hi = Math.max(hi, sp.years[1]);
            }
        }
    }
    historical.sort((a, b) => b.recordDays - a.recordDays || a.sci.localeCompare(b.sci));
    return {
        month,
        year,
        newThisMonth,
        historical: historical.slice(0, 3),
        historicalYears: historical.length ? [lo, hi] : null,
    };
}

/**
 * Where a tooltip goes: beside the pointer (right and above by default, or
 * flipped by `left` / `below`), then clamped inside the map box so a pinned
 * tip on a phone never runs off the plate (it was clipped at 390 px wide,
 * close button and all).
 */
export function placeTip(
    anchor: { x: number; y: number; left: boolean; below: boolean },
    size: { w: number; h: number },
    box: { w: number; h: number },
    margin = 8,
): { x: number; y: number } {
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, Math.max(lo, hi)));
    const x = anchor.left ? anchor.x - size.w - 12 : anchor.x + 12;
    const y = anchor.below ? anchor.y + 14 : anchor.y - size.h - 10;
    return { x: clamp(x, margin, box.w - size.w - margin), y: clamp(y, margin, box.h - size.h - margin) };
}

/**
 * Call `onTimeout` after `ms` of VISIBLE time. Browsers run no animation
 * frames in a background tab (so Mapbox never fires 'load' there) while
 * timers still tick, so a plain timeout gave up on a map that was simply
 * waiting for the tab to be shown. Returns a cancel function.
 */
export function visibleTimeout(
    ms: number,
    onTimeout: () => void,
    visibility: () => DocumentVisibilityState = () => document.visibilityState,
    tickMs = 500,
): () => void {
    let seen = 0;
    const timer = setInterval(() => {
        if (visibility() !== 'visible') return;
        seen += tickMs;
        if (seen >= ms) {
            clearInterval(timer);
            onTimeout();
        }
    }, tickMs);
    return () => clearInterval(timer);
}
