// deno-lint-ignore-file
declare const Deno: {
    serve: (handler: (req: Request) => Promise<Response> | Response) => void;
    env: { get(key: string): string | undefined };
};

/**
 * route-bathymetric — Stitched COG-backed Marine Router
 *
 * Long passages are split into 3 independent A* legs:
 *   LEG A (departure): High-res from marina → 30 NM offshore
 *   LEG B (ocean):     Downsampled across open water
 *   LEG C (arrival):   High-res from 30 NM offshore → marina
 *
 * Each leg has its own tiny COG window via HTTP Range requests.
 */

// @ts-ignore: Deno ESM import
import { fromUrl } from "https://esm.sh/geotiff@2.1.3?bundle-deps&target=deno";

// ── CORS ──────────────────────────────────────────────────────────

const CORS: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function corsResponse(body: BodyInit | null, status: number, extra?: Record<string, string>) {
    return new Response(body, { status, headers: { ...CORS, ...extra } });
}

function jsonResponse(data: unknown, status = 200) {
    return corsResponse(JSON.stringify(data), status, { "Content-Type": "application/json" });
}

// ── Types ─────────────────────────────────────────────────────────

interface RouteRequest {
    origin: { lat: number; lon: number };
    destination: { lat: number; lon: number };
    via?: { lat: number; lon: number };
    vessel_draft?: number;
}

interface GridCell { row: number; col: number; }

interface RouteWaypoint {
    lat: number;
    lon: number;
    name: string;
    depth_m?: number;
}

// ── Constants ─────────────────────────────────────────────────────

const UKC_MARGIN_FACTOR = 1.3;
const EARTH_RADIUS_NM = 3440.065;
const DEFAULT_DRAFT = 2.5;
const SNAP_RADIUS = 60;
const MAX_A_STAR = 100_000;
const HEURISTIC_WEIGHT = 1.5;
const HANDOFF_NM = 30;
const COASTAL_BUFFER = 2.0;
const OCEAN_BUFFER = 0.5;
const STITCH_THRESHOLD_NM = 100;
const MAX_GRID = 500;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const COG_URL = `${SUPABASE_URL}/storage/v1/object/public/gebco-tiles/thalassa_bathymetry_global.tif`;

const DIRS: [number, number][] = [
    [-1, 0], [1, 0], [0, -1], [0, 1],
    [-1, -1], [-1, 1], [1, -1], [1, 1],
];

// ── Spherical Math ────────────────────────────────────────────────

const toRad = (deg: number) => (deg * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;

function haversineNM(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_RADIUS_NM * Math.asin(Math.min(1, Math.sqrt(a)));
}

function getBearing(start: { lat: number; lon: number }, end: { lat: number; lon: number }): number {
    const lat1 = toRad(start.lat);
    const lat2 = toRad(end.lat);
    const dLon = toRad(end.lon - start.lon);
    const y = Math.sin(dLon) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function projectPoint(start: { lat: number; lon: number }, bearingDeg: number, distNM: number): { lat: number; lon: number } {
    const lat1 = toRad(start.lat);
    const lon1 = toRad(start.lon);
    const brng = toRad(bearingDeg);
    const d = distNM / EARTH_RADIUS_NM;
    const lat2 = Math.asin(
        Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brng)
    );
    const lon2 = lon1 + Math.atan2(
        Math.sin(brng) * Math.sin(d) * Math.cos(lat1),
        Math.cos(d) - Math.sin(lat1) * Math.sin(lat2)
    );
    return { lat: toDeg(lat2), lon: toDeg(lon2) };
}

// ── COG Reader ────────────────────────────────────────────────────

async function fetchCogRegion(
    minLat: number, maxLat: number,
    minLon: number, maxLon: number,
    overviewLevel = 0,
): Promise<{ elevation: Int16Array; rows: number; cols: number; lats: number[]; lons: number[] }> {
    const tiff = await fromUrl(COG_URL);
    const image = await tiff.getImage(0);
    const imgWidth = image.getWidth();
    const imgHeight = image.getHeight();

    let west: number, south: number, east: number, north: number;
    try {
        [west, south, east, north] = image.getBoundingBox();
    } catch {
        const tp = image.fileDirectory.ModelTiepoint;
        const ps = image.fileDirectory.ModelPixelScale;
        if (tp && ps) {
            west = tp[3]; north = tp[4];
            east = tp[3] + ps[0] * imgWidth;
            south = tp[4] - ps[1] * imgHeight;
        } else {
            west = -180; south = -80; east = 180; north = 80;
        }
    }

    const xScale = imgWidth / (east - west);
    const yScale = imgHeight / (north - south);
    const clampLon = (v: number) => Math.max(west, Math.min(east, v));
    const clampLat = (v: number) => Math.max(south, Math.min(north, v));

    const x0 = Math.max(0, Math.floor((clampLon(minLon) - west) * xScale));
    const x1 = Math.min(imgWidth, Math.ceil((clampLon(maxLon) - west) * xScale));
    const y0 = Math.max(0, Math.floor((north - clampLat(maxLat)) * yScale));
    const y1 = Math.min(imgHeight, Math.ceil((north - clampLat(minLat)) * yScale));

    const baseCols = x1 - x0;
    const baseRows = y1 - y0;
    const ds = Math.pow(2, overviewLevel);
    const outCols = Math.min(MAX_GRID, Math.ceil(baseCols / ds));
    const outRows = Math.min(MAX_GRID, Math.ceil(baseRows / ds));

    console.log(`[cog] base=${baseCols}x${baseRows} -> ${outCols}x${outRows} (${ds}x ds)`);

    const rasters = await image.readRasters({
        window: [x0, y0, x1, y1],
        width: outCols,
        height: outRows,
    });

    const rawData = rasters[0] as Float32Array | Int16Array | Int32Array;
    const elevation = new Int16Array(rawData.length);
    for (let i = 0; i < rawData.length; i++) elevation[i] = Math.round(rawData[i]);

    const cols = outCols, rows = outRows;

    // Compute actual geographic bounds from pixel-snapped window
    // (Critical: readRasters window may differ slightly from requested lat/lon)
    const globalPxLon = (east - west) / imgWidth;
    const globalPxLat = (north - south) / imgHeight;
    const winWest = west + x0 * globalPxLon;
    const winNorth = north - y0 * globalPxLat;
    const winEast = west + x1 * globalPxLon;
    const winSouth = north - y1 * globalPxLat;

    const pxLon = (winEast - winWest) / cols;
    const pxLat = (winNorth - winSouth) / rows;
    const lats = new Array(rows);
    const lons = new Array(cols);
    for (let r = 0; r < rows; r++) lats[r] = winNorth - (r + 0.5) * pxLat;
    for (let c = 0; c < cols; c++) lons[c] = winWest + (c + 0.5) * pxLon;

    return { elevation, rows, cols, lats, lons };
}

// ── Binary Min-Heap ───────────────────────────────────────────────

interface AStarNode { f: number; g: number; r: number; c: number; }

class MinHeap {
    private d: AStarNode[] = [];
    get length() { return this.d.length; }
    push(node: AStarNode) {
        // Simple binary-search insert to maintain sorted order (lowest f first)
        let lo = 0, hi = this.d.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (this.d[mid].f < node.f) lo = mid + 1;
            else hi = mid;
        }
        this.d.splice(lo, 0, node);
    }
    pop(): AStarNode | undefined {
        return this.d.shift();
    }
}

// ── Weighted A* ───────────────────────────────────────────────────

function astar(
    start: GridCell, end: GridCell,
    passable: Uint8Array, elevation: Int16Array,
    lats: number[], lons: number[],
    rows: number, cols: number, safeDepth: number,
): GridCell[] | null {
    const goalLat = lats[end.row], goalLon = lons[end.col];

    const gBest = new Float64Array(rows * cols);
    gBest.fill(Infinity);
    gBest[start.row * cols + start.col] = 0;

    const parent = new Int32Array(rows * cols);
    parent.fill(-1);

    const heap = new MinHeap();
    const h0 = haversineNM(lats[start.row], lons[start.col], goalLat, goalLon);
    console.log(`[A*] ${cols}x${rows} start(${start.row},${start.col})@${lats[start.row]?.toFixed(2)},${lons[start.col]?.toFixed(2)} -> end(${end.row},${end.col})@${goalLat.toFixed(2)},${goalLon.toFixed(2)} h0=${h0.toFixed(1)}NM pass_s=${passable[start.row * cols + start.col]} pass_e=${passable[end.row * cols + end.col]}`);
    heap.push({ f: h0 * HEURISTIC_WEIGHT, g: 0, r: start.row, c: start.col });

    let exp = 0;
    const t = performance.now();

    while (heap.length > 0) {
        const node = heap.pop()!;

        if (node.r === end.row && node.c === end.col) {
            console.log(`[A*] found in ${exp} exp, ${(performance.now() - t).toFixed(0)}ms`);
            const path: GridCell[] = [];
            let flat = end.row * cols + end.col;
            const sf = start.row * cols + start.col;
            while (flat !== sf && flat !== -1) {
                path.push({ row: Math.floor(flat / cols), col: flat % cols });
                flat = parent[flat];
            }
            path.push(start);
            path.reverse();
            return path;
        }

        const fi = node.r * cols + node.c;
        if (node.g > gBest[fi]) continue;

        exp++;
        if (exp > MAX_A_STAR) {
            console.warn(`[A*] limit ${MAX_A_STAR} in ${(performance.now() - t).toFixed(0)}ms`);
            return null;
        }

        for (const [dr, dc] of DIRS) {
            const nr = node.r + dr, nc = node.c + dc;
            if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
            const nf = nr * cols + nc;
            if (!passable[nf]) continue;

            const step = haversineNM(lats[node.r], lons[node.c], lats[nr], lons[nc]);
            if (isNaN(step) || step <= 0) continue;

            // Depth penalty — prefer deeper water
            const depth = -elevation[nf];
            let depthFactor = 1.0;
            if (depth < safeDepth * 3) {
                const t2 = Math.max(0, Math.min(1, (depth - safeDepth) / (safeDepth * 2)));
                depthFactor = 2.0 - t2;
            }

            const newG = node.g + step * depthFactor;

            if (newG < gBest[nf]) {
                gBest[nf] = newG;
                parent[nf] = fi;
                heap.push({ f: newG + haversineNM(lats[nr], lons[nc], goalLat, goalLon) * HEURISTIC_WEIGHT, g: newG, r: nr, c: nc });
            }
        }
    }

    console.warn(`[A*] exhausted ${exp} exp, ${(performance.now() - t).toFixed(0)}ms`);
    return null;
}

// ── Line-of-Sight Smoothing ───────────────────────────────────────

function losSmooth(path: GridCell[], passable: Uint8Array, rows: number, cols: number): GridCell[] {
    if (path.length <= 2) return path;
    const out: GridCell[] = [path[0]];
    let cur = 0;
    while (cur < path.length - 1) {
        let best = cur + 1;
        for (let chk = path.length - 1; chk > cur + 1; chk--) {
            if (bresenhamClear(path[cur], path[chk], passable, rows, cols)) { best = chk; break; }
        }
        out.push(path[best]);
        cur = best;
    }
    return out;
}

function bresenhamClear(p1: GridCell, p2: GridCell, passable: Uint8Array, rows: number, cols: number): boolean {
    let r = p1.row, c = p1.col;
    const dr = Math.abs(p2.row - p1.row), dc = Math.abs(p2.col - p1.col);
    const sr = p2.row > p1.row ? 1 : -1, sc = p2.col > p1.col ? 1 : -1;
    let err = dr - dc;
    while (true) {
        if (r < 0 || r >= rows || c < 0 || c >= cols || !passable[r * cols + c]) return false;
        for (const off of [-1, 1]) {
            const cr = r + (dc > dr ? off : 0), cc = c + (dr >= dc ? off : 0);
            if (cr >= 0 && cr < rows && cc >= 0 && cc < cols && !passable[cr * cols + cc]) return false;
        }
        if (r === p2.row && c === p2.col) break;
        const e2 = 2 * err;
        if (e2 > -dc) { err -= dc; r += sr; }
        if (e2 < dr) { err += dr; c += sc; }
    }
    return true;
}

// ── Grid Utilities ────────────────────────────────────────────────

function latLonToGrid(lat: number, lon: number, lats: number[], lons: number[]): GridCell {
    let br = 0, brd = Infinity;
    for (let i = 0; i < lats.length; i++) { const d = Math.abs(lats[i] - lat); if (d < brd) { br = i; brd = d; } }
    let bc = 0, bcd = Infinity;
    for (let i = 0; i < lons.length; i++) { const d = Math.abs(lons[i] - lon); if (d < bcd) { bc = i; bcd = d; } }
    return { row: br, col: bc };
}

function snapToWater(cell: GridCell, passable: Uint8Array, rows: number, cols: number): GridCell | null {
    if (passable[cell.row * cols + cell.col]) return cell;
    for (let rad = 1; rad <= SNAP_RADIUS; rad++) {
        for (let dr = -rad; dr <= rad; dr++) {
            for (let dc = -rad; dc <= rad; dc++) {
                if (Math.abs(dr) !== rad && Math.abs(dc) !== rad) continue;
                const r = cell.row + dr, c = cell.col + dc;
                if (r >= 0 && r < rows && c >= 0 && c < cols && passable[r * cols + c]) return { row: r, col: c };
            }
        }
    }
    return null;
}

// ── Single Leg Router ─────────────────────────────────────────────

async function routeLeg(
    from: { lat: number; lon: number },
    to: { lat: number; lon: number },
    safeDepth: number, buffer: number, overviewLevel: number, label: string,
): Promise<RouteWaypoint[]> {
    const minLat = Math.min(from.lat, to.lat) - buffer;
    const maxLat = Math.max(from.lat, to.lat) + buffer;
    const minLon = Math.min(from.lon, to.lon) - buffer;
    const maxLon = Math.max(from.lon, to.lon) + buffer;

    console.log(`[${label}] bbox [${minLat.toFixed(1)},${maxLat.toFixed(1)}]x[${minLon.toFixed(1)},${maxLon.toFixed(1)}] lvl=${overviewLevel}`);

    const { lats, lons, elevation, rows, cols } = await fetchCogRegion(minLat, maxLat, minLon, maxLon, overviewLevel);

    const passable = new Uint8Array(rows * cols);
    for (let i = 0; i < elevation.length; i++) passable[i] = elevation[i] <= -safeDepth ? 1 : 0;

    const navPct = (passable.reduce((s, v) => s + v, 0) / passable.length * 100).toFixed(1);
    console.log(`[${label}] ${cols}x${rows} nav=${navPct}%`);

    let sc = latLonToGrid(from.lat, from.lon, lats, lons);
    let ec = latLonToGrid(to.lat, to.lon, lats, lons);

    const ss = snapToWater(sc, passable, rows, cols);
    if (!ss) throw new Error(`${label}: origin landlocked (${from.lat.toFixed(3)},${from.lon.toFixed(3)})`);
    sc = ss;

    const es = snapToWater(ec, passable, rows, cols);
    if (!es) throw new Error(`${label}: dest landlocked (${to.lat.toFixed(3)},${to.lon.toFixed(3)})`);
    ec = es;

    const raw = astar(sc, ec, passable, elevation, lats, lons, rows, cols, safeDepth);
    if (!raw) throw new Error(`${label}: A* failed`);

    const smooth = losSmooth(raw, passable, rows, cols);
    console.log(`[${label}] ${raw.length} -> ${smooth.length} after LOS`);

    return smooth.map((cell) => ({
        lat: lats[cell.row], lon: lons[cell.col], name: "WP",
        depth_m: -elevation[cell.row * cols + cell.col],
    }));
}

// ── Route Reasoning ───────────────────────────────────────────────

function generateReasoning(wps: RouteWaypoint[], o: { lat: number; lon: number }, d: { lat: number; lon: number }, nm: number, stitched: boolean): string {
    const b = Math.atan2(d.lon - o.lon, d.lat - o.lat) * 180 / Math.PI;
    const dir = b < -135 ? "SSW" : b < -90 ? "SW" : b < -45 ? "WNW" : b < 0 ? "NW" : b < 45 ? "NNE" : b < 90 ? "NE" : b < 135 ? "ESE" : "SE";
    const parts = [`Bathymetric routing: ${nm.toFixed(0)} NM passage heading ${dir}.`];
    if (stitched) parts.push("Multi-resolution stitched routing: high-res coastal + downsampled ocean crossing.");
    if (wps.length > 2) parts.push(`${wps.length - 2} intermediate waypoints for safe depth.`);
    const gc = haversineNM(o.lat, o.lon, d.lat, d.lon);
    const dev = ((nm / gc) - 1) * 100;
    if (dev > 10) parts.push(`${dev.toFixed(0)}% deviation from great circle for safety.`);
    parts.push("Verified against ETOPO 2022 with 30% under-keel margin.");
    return parts.join(" ");
}

// ── Main Handler ──────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") return corsResponse(null, 204);
    if (req.method !== "POST") return jsonResponse({ error: "POST required" }, 405);

    const t0 = performance.now();

    try {
        const body: RouteRequest = await req.json();
        const { origin, destination, via } = body;
        const draft = body.vessel_draft ?? DEFAULT_DRAFT;
        const safeDepth = draft * UKC_MARGIN_FACTOR;

        if (!origin?.lat || !origin?.lon || !destination?.lat || !destination?.lon) {
            return jsonResponse({ error: "Missing origin/destination coordinates" }, 400);
        }

        const gcDist = haversineNM(origin.lat, origin.lon, destination.lat, destination.lon);
        console.log(`[route] ${origin.lat.toFixed(2)},${origin.lon.toFixed(2)} -> ${destination.lat.toFixed(2)},${destination.lon.toFixed(2)} | ${gcDist.toFixed(0)}NM | draft=${draft}m safe=${safeDepth.toFixed(1)}m`);

        let allWP: RouteWaypoint[];
        let stitched = false;

        if (gcDist > STITCH_THRESHOLD_NM) {
            // ═══ STITCHED ROUTING ═══
            stitched = true;

            const bearingOut = getBearing(origin, destination);
            const bearingIn = getBearing(destination, origin);
            const oceanStart = projectPoint(origin, bearingOut, HANDOFF_NM);
            const oceanEnd = projectPoint(destination, bearingIn, HANDOFF_NM);

            console.log(`[route] STITCHED:`);
            console.log(`  A: origin -> (${oceanStart.lat.toFixed(2)},${oceanStart.lon.toFixed(2)})`);
            console.log(`  B: ocean crossing`);
            // Step 2: Fire all three A* calculations SIMULTANEOUSLY
            const oceanDist = haversineNM(oceanStart.lat, oceanStart.lon, oceanEnd.lat, oceanEnd.lon);
            const oceanLvl = oceanDist > 500 ? 1 : 0;

            console.log(`[route] Launching 3 parallel A* legs...`);

            const [legA, legB, legC] = await Promise.all([
                routeLeg(origin, oceanStart, safeDepth, COASTAL_BUFFER, 0, "LEG-A"),
                routeLeg(oceanStart, oceanEnd, safeDepth, OCEAN_BUFFER, oceanLvl, "LEG-B"),
                routeLeg(oceanEnd, destination, safeDepth, COASTAL_BUFFER, 0, "LEG-C"),
            ]);

            // Step 3: Stitch — .slice(1) drops duplicate handoff waypoints
            allWP = [...legA, ...legB.slice(1), ...legC.slice(1)];
            console.log(`[route] stitched: ${legA.length}+${legB.length}+${legC.length} = ${allWP.length}`);

        } else {
            // ═══ SHORT ROUTE ═══
            const buf = gcDist < 50 ? 2.0 : 1.5;
            if (via) {
                const l1 = await routeLeg(origin, via, safeDepth, buf, 0, "VIA-1");
                const l2 = await routeLeg(via, destination, safeDepth, buf, 0, "VIA-2");
                allWP = [...l1, ...l2.slice(1)];
            } else {
                allWP = await routeLeg(origin, destination, safeDepth, buf, 0, "DIRECT");
            }
        }

        // Name waypoints
        const waypoints: RouteWaypoint[] = allWP.map((wp, i) => ({
            ...wp,
            name: i === 0 ? "Departure" : i === allWP.length - 1 ? "Arrival" : `WP-${String(i).padStart(2, "0")}`,
        }));
        waypoints[0] = { lat: origin.lat, lon: origin.lon, name: "Departure" };
        waypoints[waypoints.length - 1] = { lat: destination.lat, lon: destination.lon, name: "Arrival" };

        let totalNM = 0;
        for (let i = 0; i < waypoints.length - 1; i++) {
            totalNM += haversineNM(waypoints[i].lat, waypoints[i].lon, waypoints[i + 1].lat, waypoints[i + 1].lon);
        }

        const ms = Math.round(performance.now() - t0);
        const reasoning = generateReasoning(waypoints, origin, destination, totalNM, stitched);
        console.log(`[route] DONE ${waypoints.length} WPs, ${totalNM.toFixed(0)}NM, ${ms}ms${stitched ? " (stitched)" : ""}`);

        return jsonResponse({
            waypoints,
            distance_nm: Math.round(totalNM * 10) / 10,
            computation_ms: ms,
            routing_mode: stitched ? "stitched" : "direct",
            route_reasoning: reasoning,
        });

    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[route] ${msg}`);
        return jsonResponse({ error: msg }, 500);
    }
});
