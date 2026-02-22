/**
 * Isobar Service — Generates pressure contour lines from Open-Meteo grid data.
 *
 * Pipeline:
 *   1. Fetch pressure grid from Open-Meteo for visible map bounds
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
}

// ── Constants ──────────────────────────────────────────────────

const ISOBAR_INTERVAL = 4;     // hPa between contour lines (synoptic standard)
const GRID_RESOLUTION = 1.0;   // degrees (1° ≈ 111km — fast, sufficient for synoptic scale)
const GRID_RESOLUTION_ZOOMED = 0.5;
export const FORECAST_HOURS = 48; // 2-day forecast for timeline scrubber

// ── Open-Meteo Grid Fetch ──────────────────────────────────────

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

        const sparseLatStep = Math.max((north - south) / 8, 0.5);
        const sparseLonStep = Math.max((east - west) / 8, 0.5);

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
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${multiLats}&longitude=${multiLons}&hourly=pressure_msl,wind_speed_10m,wind_direction_10m&forecast_hours=${FORECAST_HOURS}&timezone=auto`;

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

    const EPS = 0.001;
    const match = (a: number, b: number) => Math.abs(a - b) < EPS;
    const matchPt = (a: [number, number], b: [number, number]) => match(a[0], b[0]) && match(a[1], b[1]);

    // Convert to start/end point pairs
    const segs: { start: [number, number]; end: [number, number]; used: boolean }[] =
        segments.map(s => ({ start: [s[0], s[1]], end: [s[2], s[3]], used: false }));

    const chains: number[][][] = [];

    for (let i = 0; i < segs.length; i++) {
        if (segs[i].used) continue;
        segs[i].used = true;
        const chain: [number, number][] = [segs[i].start, segs[i].end];

        // Extend forward
        let changed = true;
        while (changed) {
            changed = false;
            for (let j = 0; j < segs.length; j++) {
                if (segs[j].used) continue;
                const tail = chain[chain.length - 1];
                if (matchPt(tail, segs[j].start)) {
                    chain.push(segs[j].end);
                    segs[j].used = true;
                    changed = true;
                } else if (matchPt(tail, segs[j].end)) {
                    chain.push(segs[j].start);
                    segs[j].used = true;
                    changed = true;
                }
            }
        }

        // Extend backward
        changed = true;
        while (changed) {
            changed = false;
            for (let j = 0; j < segs.length; j++) {
                if (segs[j].used) continue;
                const head = chain[0];
                if (matchPt(head, segs[j].end)) {
                    chain.unshift(segs[j].start);
                    segs[j].used = true;
                    changed = true;
                } else if (matchPt(head, segs[j].start)) {
                    chain.unshift(segs[j].end);
                    segs[j].used = true;
                    changed = true;
                }
            }
        }

        // Only keep chains with 3+ points for smooth rendering
        if (chain.length >= 2) {
            chains.push(chain.map(p => [p[1], p[0]])); // GeoJSON is [lon, lat]
        }
    }

    // Smooth all chains with Chaikin subdivision (3 passes)
    return chains.map(c => chaikinSmooth(c, 3));
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

    // Minimum distance between centers (in grid cells)
    const minSep = 2;

    for (let r = 1; r < rows - 1; r++) {
        for (let c = 1; c < cols - 1; c++) {
            const val = values[r][c];
            let isMax = true, isMin = true;

            // Check all 8 neighbors
            for (let dr = -1; dr <= 1; dr++) {
                for (let dc = -1; dc <= 1; dc++) {
                    if (dr === 0 && dc === 0) continue;
                    const nr = r + dr, nc = c + dc;
                    if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
                    if (values[nr][nc] >= val) isMax = false;
                    if (values[nr][nc] <= val) isMin = false;
                }
            }

            if (isMax) centers.push({ lat: lats[r], lon: lons[c], type: 'H', pressure: Math.round(val) });
            if (isMin) centers.push({ lat: lats[r], lon: lons[c], type: 'L', pressure: Math.round(val) });
        }
    }

    // Deduplicate nearby centers — keep strongest
    const filtered: typeof centers = [];
    for (const center of centers) {
        const tooClose = filtered.some(f =>
            f.type === center.type &&
            Math.abs(f.lat - center.lat) < minSep * (lats[1] - lats[0]) &&
            Math.abs(f.lon - center.lon) < minSep * (lons[1] - lons[0])
        );
        if (!tooClose) filtered.push(center);
    }

    return filtered;
}

// ── Wind Barb Generation ──────────────────────────────────────

function generateWindBarbs(grid: HourGrid): GeoJSON.Feature[] {
    const { windSpeeds, windDirs, lats, lons, rows, cols } = grid;
    const features: GeoJSON.Feature[] = [];

    // Place barbs at every other grid point to avoid clutter
    const step = Math.max(1, Math.floor(Math.min(rows, cols) / 6));

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

/** Fetch + generate for a single hour (legacy, for initial load) */
export async function generateIsobars(
    north: number, south: number, west: number, east: number, zoom: number
): Promise<{ grid: PressureGrid; result: IsobarResult } | null> {
    const grid = await fetchPressureGrid(north, south, west, east, zoom);
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

    return {
        contours: { type: 'FeatureCollection', features: contourFeatures },
        centers: { type: 'FeatureCollection', features: centerFeatures },
        barbs: { type: 'FeatureCollection', features: barbFeatures },
        arrows: { type: 'FeatureCollection', features: arrowFeatures },
        tracks: { type: 'FeatureCollection', features: trackFeatures },
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
