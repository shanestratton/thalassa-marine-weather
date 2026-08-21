/**
 * @filesize-justified Cohesive algorithmic module — marching squares + pressure grid interpolation. Splitting would fragment the algorithm.
 */
/**
 * Isobar Service — Generates pressure contours from a NOAA GFS grid, with a
 * clearly-labelled Open-Meteo fallback if the primary source is unavailable.
 *
 * Pipeline:
 *   1. Fetch a global GFS pressure grid (or validate the fallback grid)
 *   2. Marching-squares contour algorithm → polylines at 4hPa intervals
 *   3. Detect H/L pressure centers (local extrema)
 *   4. Return GeoJSON Feature Collections for Mapbox GL rendering
 */

// ── Types ──────────────────────────────────────────────────────

interface PressureGrid {
    allHourlyPressure: number[][][]; // [hour][row][col] in hPa
    allHourlyWindSpeed: number[][][]; // [hour][row][col] in knots
    allHourlyWindDir: number[][][]; // [hour][row][col] in degrees
    lats: number[]; // South → North
    lons: number[]; // West → East
    rows: number;
    cols: number;
    totalHours: number;
    /** ISO timestamp of the GFS run (or null if the source doesn't expose one,
     *  e.g. the Open-Meteo fallback). Used to align scrubber "Now" to wall-
     *  clock time instead of forecast hour 0. */
    refTime: string | null;
    /** Forecast-hour offsets for the keyframes BEFORE interpolation, e.g.
     *  [0,6,12,…,42]. Combined with INTERP_STEPS=3 this gives 0,2,4,…,42
     *  sub-frames. Used to turn an age-in-hours into an index. */
    keyframeFhrs: number[];
    /** Hours per sub-frame after interpolation (2h for the GFS 6h/3-step case). */
    subFrameStepHours: number;
    /** The actual source behind the chart. Emergency fallback data must never
     *  be visually indistinguishable from the primary GFS grid. */
    source: 'gfs' | 'open-meteo';
}

// Runtime grid for a single hour (used by contour/barb generators)
interface HourGrid {
    values: number[][];
    forecastValues: number[][];
    windSpeeds: number[][];
    windDirs: number[][];
    lats: number[];
    lons: number[];
    rows: number;
    cols: number;
}

interface IsobarResult {
    contours: GeoJSON.FeatureCollection;
    centers: GeoJSON.FeatureCollection;
    barbs: GeoJSON.FeatureCollection;
    arrows: GeoJSON.FeatureCollection;
    tracks: GeoJSON.FeatureCollection;
    /** Canvas-rendered pressure gradient image (data URL) */
    heatmapDataUrl: string | null;
    /** Bounds for the heatmap image [west, south, east, north] */
    heatmapBounds: [number, number, number, number] | null;
}

// ── Constants ──────────────────────────────────────────────────

const ISOBAR_INTERVAL = 4; // hPa between contour lines (synoptic standard)
const GRID_RESOLUTION = 1.0; // degrees (1° ≈ 111km — fast, sufficient for synoptic scale)
const _GRID_RESOLUTION_ZOOMED = 0.5;
export const FORECAST_HOURS = 48; // 2-day forecast for timeline scrubber

import { fetchOpenMeteoPoints } from './openMeteoProxy';

import { createLogger } from '../../utils/createLogger';

const log = createLogger('isobars');

// ── NOAA GFS Pressure Grid Fetch (via Supabase Edge Function) ─
// Fetches decoded pressure grid as JSON from our edge function.
// No client-side GRIB2 parsing needed — server handles it all.

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || import.meta.env.VITE_SUPABASE_KEY || '';

// Forecast hours: 6h intervals over 42h = 8 keyframes — the edge function's
// maximum (parseForecastHours caps at 8 items). With INTERP_STEPS=3 this
// yields 22 sub-frames at 2h steps, so the isobars can follow the wind
// layer's 48h scrubber across nearly its whole range instead of freezing at
// +12h. GFS 1p00 publishes 3-hourly, so 6h spacing is a clean subset.
const GRIB_FORECAST_HOURS = [0, 6, 12, 18, 24, 30, 36, 42];

interface GfsGridResponse {
    frames: number[][][]; // [frameIdx][row_S_to_N][col_W_to_E] in hPa
    lats: number[]; // S→N
    lons: number[]; // W→E
    width: number;
    height: number;
    /** GFS run ISO timestamp — added 2026-04 so the client can align Now
     *  to wall-clock instead of the cycle hour. */
    refTime?: string;
    /** Forecast-hour offsets for the frames returned. */
    fhrs?: number[];
    north: number;
    south: number;
    east: number;
    west: number;
}

async function fetchPressureGridGfs(
    north: number,
    south: number,
    west: number,
    east: number,
): Promise<PressureGrid | null> {
    try {
        const url = `${SUPABASE_URL}/functions/v1/fetch-pressure-grid`;
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
            },
            body: JSON.stringify({ north, south, east, west, hours: GRIB_FORECAST_HOURS }),
        });

        if (!res.ok) {
            return null;
        }

        const data: GfsGridResponse = await res.json();

        if (!data.frames || data.frames.length === 0) return null;

        const { lats, lons, frames } = data;
        if (!Array.isArray(lats) || !Array.isArray(lons) || !Array.isArray(frames) || frames.length === 0) {
            return null;
        }
        const rows = lats.length;
        const cols = lons.length;
        const totalHours = frames.length;

        // Sanity check: lat/lon values must be in valid geographic range
        if (lats.some((l) => Math.abs(l) > 90.1) || lons.some((l) => Math.abs(l) > 360.1)) {
            return null;
        }

        // ── Smart orientation detection ──
        // Edge function should return frames[hour][row_lat][col_lon]
        // but verify by comparing frame dimensions to lat/lon array lengths.
        const frameRows = frames[0]?.length ?? 0;
        const frameCols = frames[0]?.[0]?.length ?? 0;
        const rectangular = frames.every(
            (frame) =>
                Array.isArray(frame) &&
                frame.length === frameRows &&
                frame.every((row) => Array.isArray(row) && row.length === frameCols && row.every(Number.isFinite)),
        );
        if (!rectangular) {
            log.warn('[ISOBAR] Rejected malformed GFS pressure-grid rows');
            return null;
        }

        const keyframeFhrs = data.fhrs ?? GRIB_FORECAST_HOURS;
        if (
            keyframeFhrs.length !== totalHours ||
            keyframeFhrs.some((hour) => !Number.isFinite(hour)) ||
            keyframeFhrs.length < 2
        ) {
            log.warn('[ISOBAR] Rejected GFS pressure grid with incomplete forecast-hour metadata');
            return null;
        }
        const keyframeStepHours = keyframeFhrs[1] - keyframeFhrs[0];
        if (
            !Number.isFinite(keyframeStepHours) ||
            keyframeStepHours <= 0 ||
            keyframeFhrs.some((hour, index) => index > 0 && hour - keyframeFhrs[index - 1] !== keyframeStepHours)
        ) {
            log.warn('[ISOBAR] Rejected GFS pressure grid with irregular forecast-hour spacing');
            return null;
        }

        let allHourlyPressure: number[][][];
        if (frameRows === rows && frameCols === cols) {
            // Frame is correctly oriented: frame[lat_row][lon_col]
            allHourlyPressure = frames;
        } else if (frameRows === cols && frameCols === rows) {
            // Frame is transposed: frame[lon_col][lat_row] — need to swap
            allHourlyPressure = frames.map((frame) => {
                const transposed: number[][] = [];
                for (let r = 0; r < rows; r++) {
                    const row: number[] = [];
                    for (let c = 0; c < cols; c++) {
                        row.push(frame[c][r]);
                    }
                    transposed.push(row);
                }
                return transposed;
            });
        } else {
            log.warn(
                `[ISOBAR] Rejected GFS pressure grid dimensions ${frameRows}×${frameCols}; expected ${rows}×${cols}`,
            );
            return null;
        }

        const emptyGrid: number[][] = Array.from({ length: rows }, () => new Array(cols).fill(0));
        const _allHourlyWindSpeed: number[][][] = frames.map(() => emptyGrid);
        const _allHourlyWindDir: number[][][] = frames.map(() => emptyGrid);

        // ── Interpolate between GRIB frames for smooth animation ──
        // Eight 6-hour GFS keyframes produce 22 two-hourly frames (0…42h).
        const INTERP_STEPS = 3;
        const interpPressure: number[][][] = [];

        for (let f = 0; f < totalHours - 1; f++) {
            const gridA = allHourlyPressure[f];
            const gridB = allHourlyPressure[f + 1];

            for (let step = 0; step < INTERP_STEPS; step++) {
                const t = step / INTERP_STEPS;
                const interpGrid: number[][] = [];
                for (let r = 0; r < rows; r++) {
                    const pRow: number[] = [];
                    for (let c = 0; c < cols; c++) {
                        pRow.push(gridA[r][c] + (gridB[r][c] - gridA[r][c]) * t);
                    }
                    interpGrid.push(pRow);
                }
                interpPressure.push(interpGrid);
            }
        }
        // Add final frame
        interpPressure.push(allHourlyPressure[totalHours - 1]);

        const interpTotal = interpPressure.length;
        const emptyGridInterp: number[][] = Array.from({ length: rows }, () => new Array(cols).fill(0));

        log.info('[ISOBAR] GFS lats ordering:', lats[0], '→', lats[lats.length - 1], '(passing through as-is)');

        return {
            allHourlyPressure: interpPressure,
            allHourlyWindSpeed: Array.from({ length: interpTotal }, () => emptyGridInterp),
            allHourlyWindDir: Array.from({ length: interpTotal }, () => emptyGridInterp),
            lats,
            lons,
            rows,
            cols,
            totalHours: interpTotal,
            refTime: data.refTime ?? null,
            keyframeFhrs,
            // 6h keyframes, 3 interpolation steps → 2h per sub-frame.
            subFrameStepHours: keyframeStepHours / INTERP_STEPS,
            source: 'gfs',
        };
    } catch (e) {
        return null;
    }
}

// ── Open-Meteo Grid Fetch (fallback) ──────────────────────────

export async function fetchPressureGrid(
    north: number,
    south: number,
    west: number,
    east: number,
    _zoom: number,
): Promise<PressureGrid | null> {
    try {
        // Use coarser resolution for wide views (dateline crossing gives -180 to 180)
        const lonSpan = east - west;
        const res = lonSpan > 180 ? 3.0 : GRID_RESOLUTION;

        // Build grid coordinates
        const lats: number[] = [];
        const lons: number[] = [];
        for (let lat = south; lat <= north; lat += res) lats.push(Math.round(lat * 100) / 100);
        for (let lon = west; lon <= east; lon += res) lons.push(Math.round(lon * 100) / 100);

        // Cap grid size to prevent massive requests
        if (lats.length * lons.length > 12000) {
            lats.length = 0;
            lons.length = 0;
            const bigRes = 3.0;
            for (let lat = south; lat <= north; lat += bigRes) lats.push(Math.round(lat * 100) / 100);
            for (let lon = west; lon <= east; lon += bigRes) lons.push(Math.round(lon * 100) / 100);
        }

        if (lats.length < 3 || lons.length < 3) return null;

        const sparseLatStep = Math.max((north - south) / 28, 0.5);
        const sparseLonStep = Math.max((east - west) / 28, 0.5);

        const points: { lat: number; lon: number }[] = [];
        for (let lat = south; lat <= north + 0.01; lat += sparseLatStep) {
            for (let lon = west; lon <= east + 0.01; lon += sparseLonStep) {
                points.push({
                    lat: Math.round(Math.min(lat, north) * 100) / 100,
                    lon: Math.round(Math.min(lon, east) * 100) / 100,
                });
            }
        }

        // Fetch all forecast hours of pressure + wind in one request
        const results = await fetchOpenMeteoPoints<{
            hourly?: {
                pressure_msl?: number[];
                wind_speed_10m?: number[];
                wind_direction_10m?: number[];
            };
        }>('forecast', points, {
            hourly: 'pressure_msl,wind_speed_10m,wind_direction_10m',
            forecast_hours: FORECAST_HOURS,
            // All points must share the same valid-time axis. Local time zones
            // would make grid index h represent different UTC instants across
            // the globe and distort moving synoptic systems.
            timezone: 'UTC',
        });

        const uniqueLats = [...new Set(points.map((p) => p.lat))].sort((a, b) => a - b);
        const uniqueLons = [...new Set(points.map((p) => p.lon))].sort((a, b) => a - b);

        // Determine actual number of hours returned
        const sampleHourly = results[0]?.hourly?.pressure_msl;
        const totalHours = sampleHourly?.length ?? FORECAST_HOURS;

        // Build hourly grids indexed by hour
        const allHourlyPressure: number[][][] = [];
        const allHourlyWindSpeed: number[][][] = [];
        const allHourlyWindDir: number[][][] = [];

        for (let h = 0; h < totalHours; h++) {
            const pGrid: number[][] = [];
            const wsGrid: number[][] = [];
            const wdGrid: number[][] = [];
            for (let r = 0; r < uniqueLats.length; r++) {
                const pRow: number[] = [];
                const wsRow: number[] = [];
                const wdRow: number[] = [];
                for (let c = 0; c < uniqueLons.length; c++) {
                    const idx = r * uniqueLons.length + c;
                    const hourly = results[idx]?.hourly;
                    const pressure = hourly?.pressure_msl?.[h];
                    if (typeof pressure !== 'number' || !Number.isFinite(pressure)) {
                        log.warn('[ISOBAR] Rejected incomplete Open-Meteo fallback pressure grid');
                        return null;
                    }
                    pRow.push(pressure);
                    wsRow.push((hourly?.wind_speed_10m?.[h] ?? 0) * 0.539957); // km/h → knots
                    wdRow.push(hourly?.wind_direction_10m?.[h] ?? 0);
                }
                pGrid.push(pRow);
                wsGrid.push(wsRow);
                wdGrid.push(wdRow);
            }
            allHourlyPressure.push(pGrid);
            allHourlyWindSpeed.push(wsGrid);
            allHourlyWindDir.push(wdGrid);
        }

        return {
            allHourlyPressure,
            allHourlyWindSpeed,
            allHourlyWindDir,
            lats: uniqueLats,
            lons: uniqueLons,
            rows: uniqueLats.length,
            cols: uniqueLons.length,
            totalHours,
            // Open-Meteo's hourly forecast is already wall-clock aligned
            // (hour 0 of its output corresponds to wall-clock "now"),
            // so we signal that by setting refTime to the current time
            // and subFrameStepHours to 1. Net effect: nowIdx = 0.
            refTime: new Date().toISOString(),
            keyframeFhrs: Array.from({ length: totalHours }, (_, i) => i),
            subFrameStepHours: 1,
            source: 'open-meteo',
        };
    } catch (e) {
        return null;
    }
}

// ── Hour Grid Extraction ───────────────────────────────────────

function extractHourGrid(grid: PressureGrid, hour: number): HourGrid {
    const h = Math.min(hour, grid.totalHours - 1);
    const forecastH = Math.min(h + 12, grid.totalHours - 1);
    return {
        values: grid.allHourlyPressure[h],
        forecastValues: grid.allHourlyPressure[forecastH],
        windSpeeds: grid.allHourlyWindSpeed[h],
        windDirs: grid.allHourlyWindDir[h],
        lats: grid.lats,
        lons: grid.lons,
        rows: grid.rows,
        cols: grid.cols,
    };
}

// ── Marching Squares Contour Generation ────────────────────────

function generateContourLines(grid: HourGrid, level: number): number[][][] {
    const { values, lats, lons, rows, cols } = grid;
    const segments: [number, number, number, number][] = []; // [lat1, lon1, lat2, lon2]

    for (let r = 0; r < rows - 1; r++) {
        for (let c = 0; c < cols - 1; c++) {
            // Four corners: TL, TR, BR, BL
            const tl = values[r][c];
            const tr = values[r][c + 1];
            const br = values[r + 1][c + 1];
            const bl = values[r + 1][c];

            // Marching squares case index (4-bit)
            const caseIdx =
                (tl >= level ? 8 : 0) | (tr >= level ? 4 : 0) | (br >= level ? 2 : 0) | (bl >= level ? 1 : 0);

            if (caseIdx === 0 || caseIdx === 15) continue; // All above or below

            // Interpolation helpers
            const lat0 = lats[r],
                lat1 = lats[r + 1];
            const lon0 = lons[c],
                lon1 = lons[c + 1];

            const lerp = (a: number, b: number, va: number, vb: number): number => {
                if (Math.abs(va - vb) < 0.001) return (a + b) / 2;
                return a + ((level - va) / (vb - va)) * (b - a);
            };

            // Edge midpoints (interpolated)
            const topLat = lat0,
                topLon = lerp(lon0, lon1, tl, tr);
            const rightLat = lerp(lat0, lat1, tr, br),
                rightLon = lon1;
            const bottomLat = lat1,
                bottomLon = lerp(lon0, lon1, bl, br);
            const leftLat = lerp(lat0, lat1, tl, bl),
                leftLon = lon0;

            // Generate segments based on case
            const addSeg = (la1: number, lo1: number, la2: number, lo2: number) => segments.push([la1, lo1, la2, lo2]);

            switch (caseIdx) {
                case 1:
                case 14:
                    addSeg(leftLat, leftLon, bottomLat, bottomLon);
                    break;
                case 2:
                case 13:
                    addSeg(bottomLat, bottomLon, rightLat, rightLon);
                    break;
                case 3:
                case 12:
                    addSeg(leftLat, leftLon, rightLat, rightLon);
                    break;
                case 4:
                case 11:
                    addSeg(topLat, topLon, rightLat, rightLon);
                    break;
                case 5: // Saddle
                    addSeg(topLat, topLon, leftLat, leftLon);
                    addSeg(bottomLat, bottomLon, rightLat, rightLon);
                    break;
                case 6:
                case 9:
                    addSeg(topLat, topLon, bottomLat, bottomLon);
                    break;
                case 7:
                case 8:
                    addSeg(topLat, topLon, leftLat, leftLon);
                    break;
                case 10: // Saddle
                    addSeg(topLat, topLon, rightLat, rightLon);
                    addSeg(leftLat, leftLon, bottomLat, bottomLon);
                    break;
            }
        }
    }

    // Chain segments into polylines
    return chainSegments(segments);
}

function chainSegments(segments: [number, number, number, number][]): number[][][] {
    if (segments.length === 0) return [];

    // ── O(n) hash-map chaining ──
    // Key = rounded coordinate string, Value = list of segment indices with that endpoint
    const PRECISION = 4; // decimal places for hash key (0.0001° ≈ 11m)
    const keyOf = (lat: number, lon: number) => `${lat.toFixed(PRECISION)},${lon.toFixed(PRECISION)}`;

    // Build adjacency map: endpoint → segment indices
    const endpointMap = new Map<string, number[]>();
    const addToMap = (key: string, idx: number) => {
        const list = endpointMap.get(key);
        if (list) list.push(idx);
        else endpointMap.set(key, [idx]);
    };

    const starts: [number, number][] = [];
    const ends: [number, number][] = [];
    const used = new Uint8Array(segments.length);

    for (let i = 0; i < segments.length; i++) {
        const [lat1, lon1, lat2, lon2] = segments[i];
        starts.push([lat1, lon1]);
        ends.push([lat2, lon2]);
        addToMap(keyOf(lat1, lon1), i);
        addToMap(keyOf(lat2, lon2), i);
    }

    const chains: number[][][] = [];

    // Find unused neighbor at a given endpoint
    const findNeighbor = (lat: number, lon: number, exclude: number): number => {
        const key = keyOf(lat, lon);
        const candidates = endpointMap.get(key);
        if (!candidates) return -1;
        for (const idx of candidates) {
            if (idx !== exclude && !used[idx]) return idx;
        }
        return -1;
    };

    for (let i = 0; i < segments.length; i++) {
        if (used[i]) continue;
        used[i] = 1;
        const chain: [number, number][] = [starts[i], ends[i]];

        // Extend forward
        let tail = chain[chain.length - 1];
        let next = findNeighbor(tail[0], tail[1], i);
        while (next >= 0) {
            used[next] = 1;
            const isStart = keyOf(starts[next][0], starts[next][1]) === keyOf(tail[0], tail[1]);
            const newPt = isStart ? ends[next] : starts[next];
            chain.push(newPt);
            tail = newPt;
            const prev = next;
            next = findNeighbor(tail[0], tail[1], prev);
        }

        // Extend backward
        let head = chain[0];
        next = findNeighbor(head[0], head[1], i);
        while (next >= 0) {
            used[next] = 1;
            const isStart = keyOf(starts[next][0], starts[next][1]) === keyOf(head[0], head[1]);
            const newPt = isStart ? ends[next] : starts[next];
            chain.unshift(newPt);
            head = newPt;
            const prev = next;
            next = findNeighbor(head[0], head[1], prev);
        }

        // Only keep chains with 4+ points (filters noise from tiny grid artifacts)
        if (chain.length >= 4) {
            chains.push(chain.map((p) => [p[1], p[0]])); // GeoJSON is [lon, lat]
        }
    }

    // Smooth all chains with Chaikin subdivision (2 passes — less aggressive for dense grids)
    return chains.map((c) => chaikinSmooth(c, 2));
}

// ── Chaikin Curve Subdivision ──────────────────────────────────
// Cuts corners iteratively to produce smooth, natural-looking curves.

function chaikinSmooth(points: number[][], iterations: number): number[][] {
    if (points.length < 3) return points;

    let pts = points;
    for (let iter = 0; iter < iterations; iter++) {
        const smoothed: number[][] = [pts[0]]; // Keep first point
        for (let i = 0; i < pts.length - 1; i++) {
            const p0 = pts[i],
                p1 = pts[i + 1];
            // Q = 3/4 * P0 + 1/4 * P1
            smoothed.push([0.75 * p0[0] + 0.25 * p1[0], 0.75 * p0[1] + 0.25 * p1[1]]);
            // R = 1/4 * P0 + 3/4 * P1
            smoothed.push([0.25 * p0[0] + 0.75 * p1[0], 0.25 * p0[1] + 0.75 * p1[1]]);
        }
        smoothed.push(pts[pts.length - 1]); // Keep last point
        pts = smoothed;
    }
    return pts;
}

function findPressureCenters(grid: HourGrid): { lat: number; lon: number; type: 'H' | 'L'; pressure: number }[] {
    const { values, lats, lons, rows, cols } = grid;

    if (rows < 3 || cols < 3) return [];

    // Grid spacing for parabolic refinement
    const dLat = lats.length > 1 ? Math.abs(lats[1] - lats[0]) : 1;
    const dLon = lons.length > 1 ? Math.abs(lons[1] - lons[0]) : 1;

    // ── SYNOPTIC-SCALE DETECTION (rewritten 2026-08-21) ─────────────────
    // The old test was "2 hPa above the mean of the 8 IMMEDIATE neighbours"
    // on a 1° grid — roughly 18 hPa per 1000 km, a tropical-cyclone eyewall
    // gradient. Real systems are two orders of magnitude flatter: measured on
    // a realistic global field, a 1026 hPa anticyclone core beat its
    // neighbours by 0.08 hPa and a 988 hPa low by 0.26 hPa. So the detector
    // returned NOTHING on ordinary weather, and a badge appeared only when a
    // cyclone wandered into frame — then vanished as interpolation smoothed
    // it away. That is "the H and L's are not consistent" (Shane, 2026-08-21).
    //
    // A centre is now judged the way an analyst judges one: is it the
    // extreme of its SYNOPTIC NEIGHBOURHOOD (a ring ~RADIUS_DEG away), and
    // does it stand out from that ring by a synoptic amount?
    const RADIUS_DEG = 5; // ~550 km — the scale a surface system actually lives at
    const PROMINENCE_HPA = 0.8; // hPa over the ring; real cores clear this, noise does not
    const MIN_SEP = 10; // degrees between same-type centres
    // Per-type cap across the WHOLE GLOBE. Three meant panning to the Coral
    // Sea showed nothing, because the three strongest systems on Earth were
    // elsewhere. Generous now; Mapbox symbol collision declutters what is
    // actually on screen.
    const MAX_CENTERS_PER_TYPE = 14;

    type Center = { lat: number; lon: number; type: 'H' | 'L'; pressure: number };
    const lows: Center[] = [];
    const highs: Center[] = [];

    type Candidate = { r: number; c: number; pressure: number; neighbourMean: number };
    const lowCandidates: Candidate[] = [];
    const highCandidates: Candidate[] = [];

    const rRad = Math.max(1, Math.round(RADIUS_DEG / dLat));
    const cRad = Math.max(1, Math.round(RADIUS_DEG / dLon));

    for (let r = rRad; r < rows - rRad; r++) {
        for (let c = cRad; c < cols - cRad; c++) {
            const val = values[r][c];

            // Extreme of its neighbourhood? (window scan, cheap and exact)
            let isMax = true;
            let isMin = true;
            for (let dr = -rRad; dr <= rRad && (isMax || isMin); dr++) {
                for (let dc = -cRad; dc <= cRad; dc++) {
                    if (dr === 0 && dc === 0) continue;
                    const nv = values[r + dr][c + dc];
                    if (nv > val) isMax = false;
                    if (nv < val) isMin = false;
                    if (!isMax && !isMin) break;
                }
            }
            if (!isMax && !isMin) continue;

            // Prominence against the RING at the radius — the pressure the
            // system is standing above or below, not its own neighbours'.
            let ringSum = 0;
            let ringCount = 0;
            for (let dr = -rRad; dr <= rRad; dr++) {
                for (let dc = -cRad; dc <= cRad; dc++) {
                    const onRing = Math.abs(dr) === rRad || Math.abs(dc) === cRad;
                    if (!onRing) continue;
                    ringSum += values[r + dr][c + dc];
                    ringCount++;
                }
            }
            if (ringCount === 0) continue;
            const neighbourMean = ringSum / ringCount;

            if (isMax && val - neighbourMean >= PROMINENCE_HPA) {
                highCandidates.push({ r, c, pressure: val, neighbourMean });
            } else if (isMin && neighbourMean - val >= PROMINENCE_HPA) {
                lowCandidates.push({ r, c, pressure: val, neighbourMean });
            }
        }
    }

    // Sort by gradient strength (how much the center differs from neighbours)
    lowCandidates.sort((a, b) => b.neighbourMean - b.pressure - (a.neighbourMean - a.pressure));
    highCandidates.sort((a, b) => b.pressure - b.neighbourMean - (a.pressure - a.neighbourMean));

    // ── Deduplicate by distance, refine position ──
    const refineAndAdd = (candidates: Candidate[], type: 'H' | 'L', output: Center[]) => {
        for (const pt of candidates) {
            if (output.length >= MAX_CENTERS_PER_TYPE) break;
            const lat = lats[pt.r];
            const lon = lons[pt.c];

            // Check distance from already-selected centers of same type
            const tooClose = output.some((c) => Math.abs(c.lat - lat) < MIN_SEP && Math.abs(c.lon - lon) < MIN_SEP);
            if (tooClose) continue;

            // Sub-grid parabolic interpolation for precise position
            let refinedLat = lat;
            let refinedLon = lon;
            const { r, c, pressure: val } = pt;
            const vN = values[r - 1][c],
                vS = values[r + 1][c];
            const denomLat = 2 * (vN - 2 * val + vS);
            if (Math.abs(denomLat) > 0.001) {
                const shift = -(vS - vN) / denomLat;
                refinedLat += Math.max(-0.5, Math.min(0.5, shift)) * dLat;
            }
            const vW = values[r][c - 1],
                vE = values[r][c + 1];
            const denomLon = 2 * (vW - 2 * val + vE);
            if (Math.abs(denomLon) > 0.001) {
                const shift = -(vE - vW) / denomLon;
                refinedLon += Math.max(-0.5, Math.min(0.5, shift)) * dLon;
            }

            output.push({ lat: refinedLat, lon: refinedLon, type, pressure: Math.round(val) });
        }
    };

    refineAndAdd(lowCandidates, 'L', lows);
    refineAndAdd(highCandidates, 'H', highs);

    const all = [...lows, ...highs];
    log.info(
        '[ISOBAR] Centers detected:',
        all.map((c) => `${c.type} ${c.pressure} @ ${c.lat.toFixed(1)},${c.lon.toFixed(1)}`).join(', '),
    );
    return all;
}

// ── Wind Barb Generation ──────────────────────────────────────

function generateWindBarbs(grid: HourGrid): GeoJSON.Feature[] {
    const { windSpeeds, windDirs, lats, lons, rows, cols } = grid;
    const features: GeoJSON.Feature[] = [];

    // Place barbs sparsely — at synoptic scale we want ~5-8 visible, not 100+
    // Step = 1/4 of grid dimension, minimum 5 cells (~5° at 1° resolution)
    const step = Math.max(5, Math.floor(Math.min(rows, cols) / 4));

    for (let r = 0; r < rows; r += step) {
        for (let c = 0; c < cols; c += step) {
            const speed = windSpeeds[r][c];
            const dir = windDirs[r][c];

            if (speed < 1) continue; // Skip calm

            // Encode barb components (standard WMO encoding)
            // Pennants (50kt), full barbs (10kt), half barbs (5kt)
            const pennants = Math.floor(speed / 50);
            const remaining = speed - pennants * 50;
            const fullBarbs = Math.floor(remaining / 10);
            const halfBarbs = Math.round((remaining - fullBarbs * 10) / 5);

            features.push({
                type: 'Feature',
                properties: {
                    speed: Math.round(speed),
                    direction: dir,
                    rotation: dir, // Mapbox uses this for icon rotation
                    pennants,
                    fullBarbs,
                    halfBarbs,
                    // Label for the speed value
                    label: `${Math.round(speed)}`,
                },
                geometry: {
                    type: 'Point',
                    coordinates: [lons[c], lats[r]],
                },
            });
        }
    }

    return features;
}

// ── Circulation Arrows Around H/L Centers ─────────────────────
// Places a small set of schematic arrows around each centre showing
// circulation direction (tangential to isobars). They deliberately do not
// claim to be observed/model wind vectors; the wind-barb layer owns that.
// NH: H=clockwise, L=anticlockwise. SH: reversed.

function generateCirculationArrows(
    centers: { lat: number; lon: number; type: 'H' | 'L'; pressure: number }[],
    grid: HourGrid,
): GeoJSON.Feature[] {
    const features: GeoJSON.Feature[] = [];

    // Keep the cues close to their centre so they read as a quiet circulation
    // hint, rather than a second, competing weather layer.
    const latStep = grid.lats.length > 1 ? Math.abs(grid.lats[1] - grid.lats[0]) : 1;
    const radius = Math.max(latStep * 1.5, 1.35);

    // Four diagonal positions are enough to communicate rotation without
    // surrounding each H/L with an attention-grabbing ring of arrows.
    const angles = [45, 135, 225, 315];

    for (const center of centers) {
        const isSouthern = center.lat < 0;

        // Geostrophic flow direction (tangent to circle):
        // NH High = clockwise  → tangent is angle + 90°
        // NH Low  = anticlockwise → tangent is angle - 90°
        // SH is reversed
        const tangentOffset = (() => {
            if (center.type === 'H') return isSouthern ? -90 : 90;
            return isSouthern ? 90 : -90;
        })();

        for (const angle of angles) {
            const rad = (angle * Math.PI) / 180;
            const arrowLat = center.lat + radius * Math.cos(rad);
            const arrowLon = center.lon + (radius * Math.sin(rad)) / Math.cos((center.lat * Math.PI) / 180);

            // Arrow points in the tangential direction
            const rotation = (angle + tangentOffset + 360) % 360;

            features.push({
                type: 'Feature',
                properties: {
                    rotation,
                    centerType: center.type,
                },
                geometry: {
                    type: 'Point',
                    coordinates: [arrowLon, arrowLat],
                },
            });
        }
    }

    return features;
}

// ── Main Exports ───────────────────────────────────────────────

/** Fetch + generate for a single hour */
export async function generateIsobars(
    north: number,
    south: number,
    west: number,
    east: number,
    zoom: number,
): Promise<{ grid: PressureGrid; result: IsobarResult } | null> {
    // Try GFS first (higher resolution, NOAA source), fallback to Open-Meteo
    let grid = await fetchPressureGridGfs(north, south, west, east);

    if (!grid) {
        grid = await fetchPressureGrid(north, south, west, east, zoom);
    }

    if (!grid) return null;
    const result = generateIsobarsFromGrid(grid, 0);
    return { grid, result };
}

/** Generate isobars for a specific hour from a cached grid (used by scrubber) */
/** Cache for heatmap reuse across interpolated sub-frames */
let _heatmapCache: { dataUrl: string; bounds: [number, number, number, number] } | null = null;
let _heatmapCacheHour = -1;

export function generateIsobarsFromGrid(grid: PressureGrid, hour: number, skipHeatmap = false): IsobarResult {
    const hourGrid = extractHourGrid(grid, hour);

    // Determine pressure range
    let minP = Infinity,
        maxP = -Infinity;
    for (const row of hourGrid.values) {
        for (const val of row) {
            if (val < minP) minP = val;
            if (val > maxP) maxP = val;
        }
    }

    // Generate contour levels at ISOBAR_INTERVAL spacing
    const startLevel = Math.floor(minP / ISOBAR_INTERVAL) * ISOBAR_INTERVAL;
    const endLevel = Math.ceil(maxP / ISOBAR_INTERVAL) * ISOBAR_INTERVAL;

    const contourFeatures: GeoJSON.Feature[] = [];

    for (let level = startLevel; level <= endLevel; level += ISOBAR_INTERVAL) {
        const chains = generateContourLines(hourGrid, level);
        for (const chain of chains) {
            contourFeatures.push({
                type: 'Feature',
                // Every second 4 hPa contour is a quiet visual major. The
                // field still contains the full synoptic 4 hPa spacing; the
                // renderer uses this flag to make the chart easier to scan.
                properties: { pressure: level, label: `${level}`, isMajor: level % 8 === 0 },
                geometry: { type: 'LineString', coordinates: chain },
            });
        }
    }

    // Find H/L centers
    const centers = findPressureCenters(hourGrid);
    const centerFeatures: GeoJSON.Feature[] = centers.map((c) => ({
        type: 'Feature',
        properties: { type: c.type, pressure: c.pressure, label: `${c.type}\n${c.pressure}` },
        geometry: { type: 'Point', coordinates: [c.lon, c.lat] },
    }));

    // Generate wind barbs
    const barbFeatures = generateWindBarbs(hourGrid);

    // Generate circulation arrows around H/L centers
    const arrowFeatures = generateCirculationArrows(centers, hourGrid);

    // Generate movement tracks (current hour → +12h)
    const trackFeatures = generateMovementTracks(centers, hourGrid);

    // Generate pressure gradient heatmap (skip for interpolated sub-frames — reuse cache)
    let heatmapDataUrl: string | null = null;
    let heatmapBounds: [number, number, number, number] | null = null;

    if (!skipHeatmap) {
        const heatmap = generatePressureHeatmap(hourGrid);
        if (heatmap) {
            heatmapDataUrl = heatmap.dataUrl;
            heatmapBounds = heatmap.bounds;
            _heatmapCache = heatmap;
            _heatmapCacheHour = hour;
        }
    } else if (_heatmapCache) {
        // Reuse nearest keyframe's heatmap for smooth scrubbing without re-rendering
        heatmapDataUrl = _heatmapCache.dataUrl;
        heatmapBounds = _heatmapCache.bounds;
    }

    return {
        contours: { type: 'FeatureCollection', features: contourFeatures },
        centers: { type: 'FeatureCollection', features: centerFeatures },
        barbs: { type: 'FeatureCollection', features: barbFeatures },
        arrows: { type: 'FeatureCollection', features: arrowFeatures },
        tracks: { type: 'FeatureCollection', features: trackFeatures },
        heatmapDataUrl,
        heatmapBounds,
    };
}

// ── Pressure Gradient Heatmap Generation ──────────────────────
// Creates a canvas-based raster image colored by pressure value.
// Low pressure (cyclones) → deep purple/blue
// High pressure (anticyclones) → light cyan/white
// Matches the Weatherzone synoptic chart aesthetic.

/**
 * The ramp is deliberately FIXED-ABSOLUTE, not data-relative: 1013 hPa must
 * be the neutral band on every chart, or the same colour would mean a
 * different pressure each frame and the legend could never be true. The old
 * signature took the frame's min/max and computed a range that nothing read
 * (`_rangeMin`/`_rangeMax`, deleted 2026-08-21) — dropped so the intent is
 * unambiguous.
 */
function generatePressureHeatmap(
    grid: HourGrid,
): { dataUrl: string; bounds: [number, number, number, number] } | null {
    if (typeof document === 'undefined') return null; // SSR guard
    if (grid.rows < 3 || grid.cols < 3) return null;

    const { values, lats, lons, rows, cols } = grid;

    // Canvas at native grid resolution (upscaled by Mapbox)
    const canvas = document.createElement('canvas');
    canvas.width = cols;
    canvas.height = rows;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    const imgData = ctx.createImageData(cols, rows);

    // Pressure color stops (hPa → RGBA)
    // Zoom Earth-inspired: distinct blue for lows → narrow neutral → distinct red/salmon for highs
    const colorStops: [number, number, number, number, number][] = [
        // [pressure_hPa, R, G, B, A]
        // ALPHA IS THE DESIGN (rebalanced 2026-08-21). Hue says which way the
        // pressure went — blue low, red high, the polarity every chart uses —
        // and ALPHA says how much you should care. Ordinary pressure near
        // 1013 nearly disappears so the chart is quiet where the weather is
        // quiet; the extremes hold their colour so a deep low reads across
        // the cabin. This column was invisible until today because the
        // heatmap shipped as JPEG, which has no alpha at all.
        [960, 10, 20, 110, 235], // Deep navy — extreme cyclone
        [975, 20, 50, 155, 225], // Rich blue — severe low
        [985, 35, 85, 185, 210], // Royal blue — cyclone
        [995, 50, 125, 200, 190], // Ocean blue — low pressure
        [1005, 80, 170, 205, 150], // Cyan/teal — mild low
        [1010, 140, 195, 195, 100], // Teal-grey — transition
        [1013, 200, 190, 170, 62], // Warm sand — standard (all but gone)
        [1016, 215, 170, 155, 100], // Light peach — transition
        [1020, 225, 145, 130, 150], // Salmon — moderate high
        [1025, 220, 115, 100, 180], // Warm red — high
        [1032, 210, 85, 75, 200], // Strong red — strong high
        [1042, 185, 60, 60, 215], // Deep red — extreme anticyclone
    ];

    /** Sample the ramp at one pressure. */
    const sampleRamp = (pressure: number): [number, number, number, number] => {
        if (pressure <= colorStops[0][0]) {
            const [, r0, g0, b0, a0] = colorStops[0];
            return [r0, g0, b0, a0];
        }
        const last = colorStops[colorStops.length - 1];
        if (pressure >= last[0]) return [last[1], last[2], last[3], last[4]];
        for (let s = 0; s < colorStops.length - 1; s++) {
            const [p0, r0, g0, b0, a0] = colorStops[s];
            const [p1, r1, g1, b1, a1] = colorStops[s + 1];
            if (pressure >= p0 && pressure <= p1) {
                const t = (pressure - p0) / (p1 - p0);
                return [r0 + (r1 - r0) * t, g0 + (g1 - g0) * t, b0 + (b1 - b0) * t, a0 + (a1 - a0) * t];
            }
        }
        return [0, 0, 0, 0];
    };

    // ── MERCATOR ROWS (2026-08-21) ──────────────────────────────────────
    // Mapbox's ImageSource projects the image's four corners into Mercator
    // and interpolates the texture LINEARLY across that quad. Painting canvas
    // rows linear in LATITUDE therefore slid the whole colour field poleward:
    // measured 1109 km off at Townsville, 1536 km at Newport, 2512 km at 50°S
    // — only the equator was right. The isobar contours are real GeoJSON and
    // project correctly, so the wash and the lines it belongs to disagreed
    // everywhere. That mismatch is why the chart "does not match any other
    // pressure map" (Shane, 2026-08-21).
    //
    // Painting each row at the latitude Mercator will actually put there
    // makes the wash land under its own isobars.
    const mercY = (latDeg: number): number => Math.log(Math.tan(Math.PI / 4 + (latDeg * Math.PI) / 360));
    const invMercY = (y: number): number => ((2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180) / Math.PI;
    const south0 = lats[0];
    const north0 = lats[rows - 1];
    const yNorth = mercY(north0);
    const ySouth = mercY(south0);

    for (let canvasRow = 0; canvasRow < rows; canvasRow++) {
        // Canvas row 0 is the TOP (north) edge of the image bounds.
        const f = rows > 1 ? canvasRow / (rows - 1) : 0;
        const lat = invMercY(yNorth + (ySouth - yNorth) * f);

        // Bilinear sample of the S→N grid at that latitude.
        const gridPos = ((lat - south0) / (north0 - south0)) * (rows - 1);
        const r0 = Math.max(0, Math.min(rows - 1, Math.floor(gridPos)));
        const r1 = Math.min(rows - 1, r0 + 1);
        const tRow = gridPos - r0;

        for (let c = 0; c < cols; c++) {
            const pressure = values[r0][c] + (values[r1][c] - values[r0][c]) * tRow;
            const [R, G, B, A] = sampleRamp(pressure);
            const px = (canvasRow * cols + c) * 4;
            imgData.data[px + 0] = Math.round(R);
            imgData.data[px + 1] = Math.round(G);
            imgData.data[px + 2] = Math.round(B);
            imgData.data[px + 3] = Math.round(A);
        }
    }

    ctx.putImageData(imgData, 0, 0);

    // Upscale 2× with bilinear smoothing (down from 4× — halves encoding time).
    // Mapbox GL's own raster resampling further smooths on the GPU, so 2× is plenty.
    const SCALE = 2;
    const smooth = document.createElement('canvas');
    smooth.width = cols * SCALE;
    smooth.height = rows * SCALE;
    const sCtx = smooth.getContext('2d');
    if (sCtx) {
        sCtx.imageSmoothingEnabled = true;
        sCtx.imageSmoothingQuality = 'high';
        sCtx.drawImage(canvas, 0, 0, smooth.width, smooth.height);
    }

    // Bounds: [west, south, east, north]
    const west = lons[0];
    const east = lons[cols - 1];
    const south = lats[0];
    const north = lats[rows - 1];

    return {
        // PNG, not JPEG (2026-08-21). JPEG has NO alpha channel, so the canvas
        // was composited onto solid black and every colour shipped multiplied
        // by its intended alpha: 1013 hPa's "warm sand" rgb(200,190,170) left
        // as rgb(96,103,94) — a dark olive — and 1042 hPa ended up the same
        // brightness as 995 hPa, so the field could not be read by luminance
        // at all. That is "the colors are not working for me". PNG keeps the
        // ramp's alpha column, which IS the design.
        dataUrl: (sCtx ? smooth : canvas).toDataURL('image/png'),
        bounds: [west, south, east, north],
    };
}
// ── Movement Track Generation ─────────────────────────────────
// Compares H/L positions at T=0 vs T+12h to show where systems are heading.

function generateMovementTracks(
    currentCenters: { lat: number; lon: number; type: 'H' | 'L'; pressure: number }[],
    hourGrid: HourGrid,
): GeoJSON.Feature[] {
    // Build a forecast grid using the forecastValues (current+12h)
    const forecastGrid: HourGrid = {
        ...hourGrid,
        values: hourGrid.forecastValues,
    };

    const futureCenters = findPressureCenters(forecastGrid);
    const features: GeoJSON.Feature[] = [];
    const used = new Set<number>(); // Track matched future centers

    for (const current of currentCenters) {
        // Find the closest future center of the SAME type
        let bestIdx = -1;
        let bestDist = Infinity;

        for (let i = 0; i < futureCenters.length; i++) {
            if (used.has(i)) continue;
            if (futureCenters[i].type !== current.type) continue;

            const dlat = futureCenters[i].lat - current.lat;
            const dlon = futureCenters[i].lon - current.lon;
            const dist = Math.sqrt(dlat * dlat + dlon * dlon);

            // Max matching distance: 10° (~1100km in 12h = ~92 km/h, reasonable for fast-movers)
            if (dist < bestDist && dist < 10) {
                bestDist = dist;
                bestIdx = i;
            }
        }

        if (bestIdx < 0) continue; // No match — system dissipated or formed
        used.add(bestIdx);

        const future = futureCenters[bestIdx];

        // Skip if barely moved (< 0.3° ≈ 33km — noise threshold)
        const dlat = future.lat - current.lat;
        const dlon = future.lon - current.lon;
        const distDeg = Math.sqrt(dlat * dlat + dlon * dlon);
        if (distDeg < 0.3) continue;

        // Distance in km (approximate)
        const distKm = distDeg * 111.32;
        const speedKmh = Math.round(distKm / 12); // km over 12h

        // Bearing
        const bearing = ((Math.atan2(dlon, dlat) * 180) / Math.PI + 360) % 360;
        const cardinal = bearingToCardinal(bearing);

        // GeoJSON LineString from current → future position
        features.push({
            type: 'Feature',
            properties: {
                type: current.type,
                speed: speedKmh,
                bearing: Math.round(bearing),
                cardinal,
                label: `${cardinal} ${speedKmh} km/h`,
                color: current.type === 'H' ? '#ef4444' : '#3b82f6',
            },
            geometry: {
                type: 'LineString',
                coordinates: [
                    [current.lon, current.lat],
                    [future.lon, future.lat],
                ],
            },
        });
    }

    return features;
}

function bearingToCardinal(deg: number): string {
    const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    return dirs[Math.round(deg / 22.5) % 16];
}
