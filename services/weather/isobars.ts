/**
 * Isobar Service — Generates pressure contour lines from Open-Meteo grid data.
 *
 * Pipeline:
 *   1. Fetch pressure grid from Open-Meteo (paid) for visible map bounds
 *   2. Marching-squares contour algorithm → polylines at 4hPa intervals
 *   3. Detect H/L pressure centers (local extrema)
 *   4. Return GeoJSON Feature Collections for Mapbox GL rendering
 */

// ── Types ──────────────────────────────────────────────────────

interface PressureGrid {
    allHourlyPressure: number[][][];  // [hour][row][col] in hPa
    allHourlyWindSpeed: number[][][]; // [hour][row][col] in knots
    allHourlyWindDir: number[][][];   // [hour][row][col] in degrees
    lats: number[];                   // South → North
    lons: number[];                   // West → East
    rows: number;
    cols: number;
    totalHours: number;
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

const ISOBAR_INTERVAL = 4;     // hPa between contour lines (synoptic standard)
const GRID_RESOLUTION = 1.0;   // degrees (1° ≈ 111km — fast, sufficient for synoptic scale)
const GRID_RESOLUTION_ZOOMED = 0.5;
export const FORECAST_HOURS = 48; // 2-day forecast for timeline scrubber

import { getOpenMeteoKey } from './keys';

// ── NOAA GFS Pressure Grid Fetch (via Supabase Edge Function) ─
// Fetches decoded pressure grid as JSON from our edge function.
// No client-side GRIB2 parsing needed — server handles it all.

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_KEY || '';

// Forecast hours: 3h intervals over 12h = 5 frames
const GRIB_FORECAST_HOURS = [0, 3, 6, 9, 12];

interface GfsGridResponse {
    frames: number[][][]; // [frameIdx][row_S_to_N][col_W_to_E] in hPa
    lats: number[];       // S→N
    lons: number[];       // W→E
    width: number;
    height: number;
    north: number;
    south: number;
    east: number;
    west: number;
}

async function fetchPressureGridGfs(
    north: number, south: number, west: number, east: number
): Promise<PressureGrid | null> {
    try {
        const url = `${SUPABASE_URL}/functions/v1/fetch-pressure-grid`;
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
            },
            body: JSON.stringify({ north, south, east, west, hours: GRIB_FORECAST_HOURS }),
        });

        if (!res.ok) {
            console.warn(`[Isobars-GFS] Edge function returned ${res.status}`);
            return null;
        }

        const data: GfsGridResponse = await res.json();

        if (!data.frames || data.frames.length === 0) return null;

        const { lats, lons, frames } = data;
        const rows = lats.length;
        const cols = lons.length;
        const totalHours = frames.length;

        // Data is already S→N, W→E — use directly as allHourlyPressure
        const allHourlyPressure: number[][][] = frames;
        const emptyGrid: number[][] = Array.from({ length: rows }, () => new Array(cols).fill(0));
        const allHourlyWindSpeed: number[][][] = frames.map(() => emptyGrid);
        const allHourlyWindDir: number[][][] = frames.map(() => emptyGrid);

        console.log(`[Isobars-GFS] Grid ${cols}×${rows}, ${totalHours} frames, bounds=[${south}→${north}]×[${west}→${east}]`);

        // ── Interpolate between GRIB frames for butter-smooth animation ──
        // 5 GRIB frames at 3h intervals → 25 sub-frames at 30-min intervals
        const INTERP_STEPS = 6;
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
        console.log(`[Isobars-GFS] Interpolated: ${totalHours} → ${interpTotal} sub-frames`);

        return {
            allHourlyPressure: interpPressure,
            allHourlyWindSpeed: Array.from({ length: interpTotal }, () => emptyGridInterp),
            allHourlyWindDir: Array.from({ length: interpTotal }, () => emptyGridInterp),
            lats,
            lons,
            rows,
            cols,
            totalHours: interpTotal,
        };
    } catch (e) {
        console.warn('[Isobars-GFS] Failed:', e);
        return null;
    }
}

// ── Open-Meteo Grid Fetch (fallback) ──────────────────────────

export async function fetchPressureGrid(
    north: number, south: number, west: number, east: number, zoom: number
): Promise<PressureGrid | null> {
    try {
        const res = GRID_RESOLUTION;

        // Build grid coordinates
        const lats: number[] = [];
        const lons: number[] = [];
        for (let lat = south; lat <= north; lat += res) lats.push(Math.round(lat * 100) / 100);
        for (let lon = west; lon <= east; lon += res) lons.push(Math.round(lon * 100) / 100);

        // Cap grid size to prevent massive requests
        if (lats.length * lons.length > 2500) {
            lats.length = 0;
            lons.length = 0;
            const bigRes = 2.0;
            for (let lat = south; lat <= north; lat += bigRes) lats.push(Math.round(lat * 100) / 100);
            for (let lon = west; lon <= east; lon += bigRes) lons.push(Math.round(lon * 100) / 100);
        }

        if (lats.length < 3 || lons.length < 3) return null;

        const sparseLatStep = Math.max((north - south) / 12, 0.5);
        const sparseLonStep = Math.max((east - west) / 12, 0.5);

        const points: { lat: number; lon: number }[] = [];
        for (let lat = south; lat <= north + 0.01; lat += sparseLatStep) {
            for (let lon = west; lon <= east + 0.01; lon += sparseLonStep) {
                points.push({
                    lat: Math.round(Math.min(lat, north) * 100) / 100,
                    lon: Math.round(Math.min(lon, east) * 100) / 100,
                });
            }
        }

        const multiLats = points.map(p => p.lat).join(',');
        const multiLons = points.map(p => p.lon).join(',');

        // Fetch all forecast hours of pressure + wind in one request
        const omKey = getOpenMeteoKey();
        if (!omKey) { console.warn('[Isobars] No Open-Meteo API key'); return null; }
        const url = `https://customer-api.open-meteo.com/v1/forecast?latitude=${multiLats}&longitude=${multiLons}&hourly=pressure_msl,wind_speed_10m,wind_direction_10m&forecast_hours=${FORECAST_HOURS}&timezone=auto&apikey=${omKey}`;

        const response = await fetch(url);
        if (!response.ok) return null;

        const data = await response.json();
        const results = Array.isArray(data) ? data : [data];

        const uniqueLats = [...new Set(points.map(p => p.lat))].sort((a, b) => a - b);
        const uniqueLons = [...new Set(points.map(p => p.lon))].sort((a, b) => a - b);

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
                    pRow.push(hourly?.pressure_msl?.[h] ?? 1013.25);
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
        };
    } catch (e) {
        console.warn('[Isobars] Failed to fetch pressure grid:', e);
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
                (tl >= level ? 8 : 0) |
                (tr >= level ? 4 : 0) |
                (br >= level ? 2 : 0) |
                (bl >= level ? 1 : 0);

            if (caseIdx === 0 || caseIdx === 15) continue; // All above or below

            // Interpolation helpers
            const lat0 = lats[r], lat1 = lats[r + 1];
            const lon0 = lons[c], lon1 = lons[c + 1];

            const lerp = (a: number, b: number, va: number, vb: number): number => {
                if (Math.abs(va - vb) < 0.001) return (a + b) / 2;
                return a + (level - va) / (vb - va) * (b - a);
            };

            // Edge midpoints (interpolated)
            const topLat = lat0, topLon = lerp(lon0, lon1, tl, tr);
            const rightLat = lerp(lat0, lat1, tr, br), rightLon = lon1;
            const bottomLat = lat1, bottomLon = lerp(lon0, lon1, bl, br);
            const leftLat = lerp(lat0, lat1, tl, bl), leftLon = lon0;

            // Generate segments based on case
            const addSeg = (la1: number, lo1: number, la2: number, lo2: number) =>
                segments.push([la1, lo1, la2, lo2]);

            switch (caseIdx) {
                case 1: case 14: addSeg(leftLat, leftLon, bottomLat, bottomLon); break;
                case 2: case 13: addSeg(bottomLat, bottomLon, rightLat, rightLon); break;
                case 3: case 12: addSeg(leftLat, leftLon, rightLat, rightLon); break;
                case 4: case 11: addSeg(topLat, topLon, rightLat, rightLon); break;
                case 5: // Saddle
                    addSeg(topLat, topLon, leftLat, leftLon);
                    addSeg(bottomLat, bottomLon, rightLat, rightLon);
                    break;
                case 6: case 9: addSeg(topLat, topLon, bottomLat, bottomLon); break;
                case 7: case 8: addSeg(topLat, topLon, leftLat, leftLon); break;
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
    const keyOf = (lat: number, lon: number) =>
        `${lat.toFixed(PRECISION)},${lon.toFixed(PRECISION)}`;

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
            chains.push(chain.map(p => [p[1], p[0]])); // GeoJSON is [lon, lat]
        }
    }

    // Smooth all chains with Chaikin subdivision (2 passes — less aggressive for dense grids)
    return chains.map(c => chaikinSmooth(c, 2));
}

// ── Chaikin Curve Subdivision ──────────────────────────────────
// Cuts corners iteratively to produce smooth, natural-looking curves.

function chaikinSmooth(points: number[][], iterations: number): number[][] {
    if (points.length < 3) return points;

    let pts = points;
    for (let iter = 0; iter < iterations; iter++) {
        const smoothed: number[][] = [pts[0]]; // Keep first point
        for (let i = 0; i < pts.length - 1; i++) {
            const p0 = pts[i], p1 = pts[i + 1];
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

// ── H/L Pressure Center Detection ─────────────────────────────

function findPressureCenters(grid: HourGrid): { lat: number; lon: number; type: 'H' | 'L'; pressure: number }[] {
    const { values, lats, lons, rows, cols } = grid;
    const centers: { lat: number; lon: number; type: 'H' | 'L'; pressure: number }[] = [];

    // Search window radius — must be LARGE to avoid noise on dense grids
    // At 1° grid: radius=5 → 11×11 window = 10° span (synoptic scale)
    const radius = Math.max(5, Math.floor(Math.min(rows, cols) / 8));

    // Minimum separation between centers in degrees (synoptic systems are ~10°+ apart)
    const MIN_SEP_DEG = 10;

    for (let r = radius; r < rows - radius; r++) {
        for (let c = radius; c < cols - radius; c++) {
            const val = values[r][c];
            let isMax = true, isMin = true;

            // Check all cells within the radius window
            scanLoop:
            for (let dr = -radius; dr <= radius; dr++) {
                for (let dc = -radius; dc <= radius; dc++) {
                    if (dr === 0 && dc === 0) continue;
                    const nr = r + dr, nc = c + dc;
                    if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
                    if (values[nr][nc] >= val) isMax = false;
                    if (values[nr][nc] <= val) isMin = false;
                    if (!isMax && !isMin) break scanLoop;
                }
            }

            if (isMax) centers.push({ lat: lats[r], lon: lons[c], type: 'H', pressure: Math.round(val) });
            if (isMin) centers.push({ lat: lats[r], lon: lons[c], type: 'L', pressure: Math.round(val) });
        }
    }

    // Sort by extremity (strongest first) so dedup keeps the most significant
    centers.sort((a, b) => {
        if (a.type === 'H' && b.type === 'H') return b.pressure - a.pressure; // Higher pressure first
        if (a.type === 'L' && b.type === 'L') return a.pressure - b.pressure; // Lower pressure first
        return 0;
    });

    // Deduplicate — keep strongest, reject any within MIN_SEP_DEG
    const filtered: typeof centers = [];
    for (const center of centers) {
        const tooClose = filtered.some(f =>
            f.type === center.type &&
            Math.abs(f.lat - center.lat) < MIN_SEP_DEG &&
            Math.abs(f.lon - center.lon) < MIN_SEP_DEG
        );
        if (!tooClose) filtered.push(center);
    }

    return filtered;
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
// Places arrows at 8 compass points around each center showing
// geostrophic wind direction (tangential to isobars).
// NH: H=clockwise, L=anticlockwise. SH: reversed.

function generateCirculationArrows(
    centers: { lat: number; lon: number; type: 'H' | 'L'; pressure: number }[],
    grid: HourGrid
): GeoJSON.Feature[] {
    const features: GeoJSON.Feature[] = [];

    // Arrow radius in degrees (~2° ≈ 220km  — visible at synoptic scale)
    const latStep = grid.lats.length > 1 ? Math.abs(grid.lats[1] - grid.lats[0]) : 1;
    const radius = Math.max(latStep * 1.8, 1.5);

    // 8 compass angles: N, NE, E, SE, S, SW, W, NW
    const angles = [0, 45, 90, 135, 180, 225, 270, 315];

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
            const arrowLon = center.lon + radius * Math.sin(rad) / Math.cos((center.lat * Math.PI) / 180);

            // Arrow points in the tangential direction
            const rotation = (angle + tangentOffset + 360) % 360;

            features.push({
                type: 'Feature',
                properties: {
                    rotation,
                    centerType: center.type,
                    color: center.type === 'H' ? '#ef4444' : '#3b82f6',
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
    north: number, south: number, west: number, east: number, zoom: number
): Promise<{ grid: PressureGrid; result: IsobarResult } | null> {
    // TODO: FIX GFS CONTOUR BUG — GFS data is correct (H/L values verified)
    // but contour lines render as vertical strings. The grid→contour coordinate
    // mapping is transposed somewhere. Needs console-level debugging.
    let grid = await fetchPressureGridGfs(north, south, west, east);

    if (!grid) {
        grid = await fetchPressureGrid(north, south, west, east, zoom);
    }

    if (!grid) return null;
    const result = generateIsobarsFromGrid(grid, 0);
    return { grid, result };
}

/** Generate isobars for a specific hour from a cached grid (used by scrubber) */
export function generateIsobarsFromGrid(grid: PressureGrid, hour: number): IsobarResult {
    const hourGrid = extractHourGrid(grid, hour);

    // Determine pressure range
    let minP = Infinity, maxP = -Infinity;
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
                properties: { pressure: level, label: `${level}` },
                geometry: { type: 'LineString', coordinates: chain },
            });
        }
    }

    // Find H/L centers
    const centers = findPressureCenters(hourGrid);
    const centerFeatures: GeoJSON.Feature[] = centers.map(c => ({
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

    // Generate pressure gradient heatmap
    const heatmap = generatePressureHeatmap(hourGrid, minP, maxP);

    return {
        contours: { type: 'FeatureCollection', features: contourFeatures },
        centers: { type: 'FeatureCollection', features: centerFeatures },
        barbs: { type: 'FeatureCollection', features: barbFeatures },
        arrows: { type: 'FeatureCollection', features: arrowFeatures },
        tracks: { type: 'FeatureCollection', features: trackFeatures },
        heatmapDataUrl: heatmap?.dataUrl ?? null,
        heatmapBounds: heatmap?.bounds ?? null,
    };
}

// ── Pressure Gradient Heatmap Generation ──────────────────────
// Creates a canvas-based raster image colored by pressure value.
// Low pressure (cyclones) → deep purple/blue
// High pressure (anticyclones) → light cyan/white
// Matches the Weatherzone synoptic chart aesthetic.

function generatePressureHeatmap(
    grid: HourGrid, minP: number, maxP: number
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
    // Inspired by Weatherzone: deep-blue lows → cyan mids → white highs
    const colorStops: [number, number, number, number, number][] = [
        // [pressure_hPa, R, G, B, A]
        [970, 60, 20, 120, 180],  // Deep purple — intense low
        [990, 40, 80, 180, 160],  // Royal blue — moderate low
        [1008, 50, 140, 210, 130],  // Ocean blue — neutral-low
        [1020, 120, 200, 230, 100],  // Cyan — neutral-high
        [1040, 200, 230, 245, 80],  // Light ice — strong high
    ];

    // Clamp range to observed data (with padding)
    const rangeMin = Math.max(960, minP - 4);
    const rangeMax = Math.min(1050, maxP + 4);

    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const pressure = values[r][c];

            // Interpolate color from stops
            let R = 0, G = 0, B = 0, A = 0;

            if (pressure <= colorStops[0][0]) {
                [, R, G, B, A] = colorStops[0];
            } else if (pressure >= colorStops[colorStops.length - 1][0]) {
                [, R, G, B, A] = colorStops[colorStops.length - 1];
            } else {
                // Find the two stops we're between
                for (let s = 0; s < colorStops.length - 1; s++) {
                    const [p0, r0, g0, b0, a0] = colorStops[s];
                    const [p1, r1, g1, b1, a1] = colorStops[s + 1];
                    if (pressure >= p0 && pressure <= p1) {
                        const t = (pressure - p0) / (p1 - p0);
                        R = r0 + (r1 - r0) * t;
                        G = g0 + (g1 - g0) * t;
                        B = b0 + (b1 - b0) * t;
                        A = a0 + (a1 - a0) * t;
                        break;
                    }
                }
            }

            // Grid is S→N (lats[0]=south), but canvas is top-down
            // So row 0 (south) should be at the bottom of the canvas
            const canvasRow = rows - 1 - r;
            const px = (canvasRow * cols + c) * 4;
            imgData.data[px + 0] = Math.round(R);
            imgData.data[px + 1] = Math.round(G);
            imgData.data[px + 2] = Math.round(B);
            imgData.data[px + 3] = Math.round(A);
        }
    }

    ctx.putImageData(imgData, 0, 0);

    // Bounds: [west, south, east, north]
    const west = lons[0];
    const east = lons[cols - 1];
    const south = lats[0];
    const north = lats[rows - 1];

    return {
        dataUrl: canvas.toDataURL('image/png'),
        bounds: [west, south, east, north],
    };
}
// ── Movement Track Generation ─────────────────────────────────
// Compares H/L positions at T=0 vs T+12h to show where systems are heading.

function generateMovementTracks(
    currentCenters: { lat: number; lon: number; type: 'H' | 'L'; pressure: number }[],
    hourGrid: HourGrid
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
        const bearing = (Math.atan2(dlon, dlat) * 180 / Math.PI + 360) % 360;
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
    const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
        'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    return dirs[Math.round(deg / 22.5) % 16];
}
