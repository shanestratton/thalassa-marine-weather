/**
 * Build the QLD-coast anchorage dataset — regional tiles with baked fetch
 * tables (Anchorages v1, 2026-08-25; v2 = AU, v3 = the world 🙂).
 *
 * Sources (all open / official — NO invented safety facts):
 *   - OpenStreetMap (Overpass)  named bays/coves/inlets, seamark anchorages,
 *                               marinas, coastline, reefs      © OSM contributors (ODbL)
 *   - GBRMPA gbrmpa_open_data   no-anchoring areas, designated anchorages,
 *     (ArcGIS)                  marine-park zoning              © GBRMPA (CC BY)
 *
 * THE FETCH TABLES are the point of this build. Every anchorage point gets
 * two 36-sector tables (one number per 10° of true bearing, distance in NM
 * to the first blocker, capped at FETCH_CAP_NM = open water):
 *   - fetchLandNM — distance to the first COASTLINE crossing. Land blocks
 *     wind and sea alike: this is the wind-protection table.
 *   - fetchReefNM — distance to the first coastline OR charted REEF
 *     crossing. A reef breaks swell and sea but not wind — GBR designated
 *     anchorages live in the lee of reefs, and a land-only table would call
 *     every one of them "exposed 360°".
 * The verdict engine (services/anchorages/anchorageVerdict.ts) combines the
 * tables with the forecast at sail time; nothing about weather is baked here.
 *
 * Output layout (served from /public, runtime-cached by sw.js):
 *   public/anchorages/qld/index.json          tile directory: ids, bboxes, counts
 *   public/anchorages/qld/<tile>.geojson      anchorage/marina points + fetch tables
 *   public/anchorages/qld/<tile>-noanchor.geojson
 *   public/anchorages/qld/<tile>-zoning.geojson
 *   public/anchorages/SOURCES.md              provenance + licence + safety note
 *
 * Tiles are 2°×2°, id = "t{south}e{west}" from the SW corner (t-22e148 spans
 * lat −22..−20, lon 148..150). The client loads every tile whose bbox
 * intersects a radius around the boat/location box.
 *
 * Overpass etiquette: sequential queries, polite sleeps, retry/backoff on
 * 429/504, and every raw response cached in scripts/anchorages/.cache/ so a
 * re-run (or a crash mid-build) never re-downloads what it already has.
 *
 * Re-run:  node scripts/anchorages/build-qld.mjs            (needs network)
 *          node scripts/anchorages/build-qld.mjs t-22e148   (single tile, for testing)
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'public', 'anchorages', 'qld');
const CACHE = join(dirname(fileURLToPath(import.meta.url)), '.cache');
mkdirSync(OUT, { recursive: true });
mkdirSync(CACHE, { recursive: true });

// ─── coverage: the QLD coast, Gulf to border ───
const QLD = { s: -28.5, w: 138, n: -9, e: 154.5 };
const TILE_DEG = 2;
const FETCH_CAP_NM = 15; // beyond this a sector is "open water"
const SECTORS = 36; // one per 10° true
const COAST_MARGIN_DEG = 0.35; // ≈ 21 NM — rays must see past the tile edge

const onlyTile = process.argv[2] || null;

const UA = { 'User-Agent': 'thalassa-anchorages-build (marine app, contact via github.com/shanestratton)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Cached fetch: raw responses land in .cache/ keyed by a stable name. */
async function getJSONCached(cacheKey, url, opts) {
    const file = join(CACHE, cacheKey + '.json');
    if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
    for (let attempt = 0; ; attempt++) {
        const r = await fetch(url, { ...opts, headers: { ...UA, ...(opts?.headers || {}) } });
        if (r.ok) {
            const data = await r.json();
            writeFileSync(file, JSON.stringify(data));
            return data;
        }
        if ((r.status === 429 || r.status === 504 || r.status === 502) && attempt < 4) {
            const wait = 15_000 * (attempt + 1);
            console.log(`    HTTP ${r.status} — backing off ${wait / 1000}s`);
            await sleep(wait);
            continue;
        }
        throw new Error(`HTTP ${r.status} for ${url.slice(0, 90)}`);
    }
}

const overpass = (cacheKey, query) =>
    getJSONCached(cacheKey, 'https://overpass-api.de/api/interpreter', {
        method: 'POST',
        body: 'data=' + encodeURIComponent(query),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

// ─── tiles ───
function tileId(s, w) {
    return `t${s}e${w}`;
}
function* tiles() {
    for (let s = Math.floor(QLD.s / TILE_DEG) * TILE_DEG; s < QLD.n; s += TILE_DEG) {
        for (let w = Math.floor(QLD.w / TILE_DEG) * TILE_DEG; w < QLD.e; w += TILE_DEG) {
            yield { id: tileId(s, w), s, w, n: s + TILE_DEG, e: w + TILE_DEG };
        }
    }
}

// ─── geometry helpers (lon/lat degrees) ───
function pointInRing(pt, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        const intersect = yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi;
        if (intersect) inside = !inside;
    }
    return inside;
}
function pointInGeom(pt, geom) {
    const polys = geom.type === 'MultiPolygon' ? geom.coordinates : geom.type === 'Polygon' ? [geom.coordinates] : [];
    for (const poly of polys) {
        if (!poly.length) continue;
        if (pointInRing(pt, poly[0]) && !poly.slice(1).some((h) => pointInRing(pt, h))) return true;
    }
    return false;
}
function representativePoint(geom) {
    const ring = geom.type === 'MultiPolygon' ? geom.coordinates[0][0] : geom.coordinates[0];
    let x = 0,
        y = 0;
    for (const [lx, ly] of ring) {
        x += lx;
        y += ly;
    }
    return [+(x / ring.length).toFixed(5), +(y / ring.length).toFixed(5)];
}

// ─── fetch tables: 36-sector ray casting against polyline segments ───
/**
 * Segments arrive as flat arrays of [lonA, latA, lonB, latB]. For one
 * anchorage we work on a local flat-earth grid in NM (fine at ≤15 NM):
 * x = Δlon·60·cos(lat₀), y = Δlat·60. A ray at true bearing θ is the
 * parametric line t·(sin θ, cos θ), t ≥ 0; the crossing with each segment
 * is a 2×2 solve, and the sector's fetch is the smallest positive t.
 */
function fetchTable(lat0, lon0, segments) {
    const cosLat = Math.cos((lat0 * Math.PI) / 180);
    // Prefilter once: only segments with an endpoint within the cap (plus
    // slack) can matter. Cheap Chebyshev test before the per-ray loop.
    const capDeg = FETCH_CAP_NM / 60 + 0.05;
    const near = [];
    for (const [ax, ay, bx, by] of segments) {
        if (
            (Math.abs(ax - lon0) < capDeg / cosLat || Math.abs(bx - lon0) < capDeg / cosLat) &&
            (Math.abs(ay - lat0) < capDeg || Math.abs(by - lat0) < capDeg)
        ) {
            near.push([(ax - lon0) * 60 * cosLat, (ay - lat0) * 60, (bx - lon0) * 60 * cosLat, (by - lat0) * 60]);
        }
    }
    const table = new Array(SECTORS).fill(FETCH_CAP_NM);
    for (let s = 0; s < SECTORS; s++) {
        const theta = (s * 10 * Math.PI) / 180;
        const dx = Math.sin(theta);
        const dy = Math.cos(theta);
        let best = FETCH_CAP_NM;
        for (const [ax, ay, bx, by] of near) {
            const ex = bx - ax;
            const ey = by - ay;
            const denom = dx * ey - dy * ex;
            if (Math.abs(denom) < 1e-12) continue; // parallel
            const t = (ax * ey - ay * ex) / denom; // distance along the ray
            if (t <= 0 || t >= best) continue;
            const u = (ax * dy - ay * dx) / denom; // position along the segment
            if (u < 0 || u > 1) continue;
            best = t;
        }
        table[s] = +best.toFixed(1);
    }
    return table;
}

/** Overpass ways → flat segment list. */
function waysToSegments(elements) {
    const segs = [];
    for (const e of elements || []) {
        if (e.type !== 'way' || !Array.isArray(e.geometry)) continue;
        for (let i = 1; i < e.geometry.length; i++) {
            const a = e.geometry[i - 1];
            const b = e.geometry[i];
            segs.push([a.lon, a.lat, b.lon, b.lat]);
        }
    }
    return segs;
}

// ─── per-tile source fetches ───
async function fetchOSMPoints(t) {
    const bbox = `${t.s},${t.w},${t.n},${t.e}`;
    const q = `[out:json][timeout:180];
(
  node["natural"="bay"](${bbox});
  way["natural"="bay"](${bbox});
  node["seamark:type"="anchorage"](${bbox});
  way["seamark:type"="anchorage"](${bbox});
  node["leisure"="marina"](${bbox});
  way["leisure"="marina"](${bbox});
);
out center tags;`;
    const d = await overpass(`osm-pts-${t.id}`, q);
    const navRe = /passage|channel|sound|\bpass\b|flats/i;
    const seen = new Set();
    const out = [];
    for (const e of d.elements || []) {
        const tags = e.tags || {};
        const isSeamark = tags['seamark:type'] === 'anchorage';
        // Seamark anchorages are charted objects — keep even unnamed ones;
        // bays/marinas without a name are unusable as a destination.
        const name = tags.name || tags['seamark:name'] || (isSeamark ? 'Charted anchorage' : null);
        if (!name) continue;
        const key = e.type + e.id;
        if (seen.has(key)) continue;
        seen.add(key);
        const lat = e.lat ?? e.center?.lat;
        const lon = e.lon ?? e.center?.lon;
        if (lat == null || lon == null) continue;
        out.push({
            lon: +lon.toFixed(5),
            lat: +lat.toFixed(5),
            name,
            kind: tags.leisure === 'marina' ? 'marina' : 'anchorage',
            source: 'OpenStreetMap',
            sourceRef: `${e.type}/${e.id}`,
            likelyAnchorage: isSeamark || !navRe.test(name),
        });
    }
    return out;
}

async function fetchCoastSegments(t) {
    const m = COAST_MARGIN_DEG;
    const bbox = `${t.s - m},${t.w - m},${t.n + m},${t.e + m}`;
    const q = `[out:json][timeout:300];
way["natural"="coastline"](${bbox});
out geom;`;
    const d = await overpass(`coast-${t.id}`, q);
    return waysToSegments(d.elements);
}

async function fetchReefSegments(t) {
    const m = COAST_MARGIN_DEG;
    const bbox = `${t.s - m},${t.w - m},${t.n + m},${t.e + m}`;
    const q = `[out:json][timeout:300];
(
  way["natural"="reef"](${bbox});
  relation["natural"="reef"](${bbox});
);
out geom;`;
    const d = await overpass(`reef-${t.id}`, q);
    // Relations carry member ways with geometry when asked with `out geom`.
    const els = [];
    for (const e of d.elements || []) {
        if (e.type === 'way') els.push(e);
        else if (e.type === 'relation') {
            for (const mm of e.members || []) {
                if (mm.type === 'way' && Array.isArray(mm.geometry)) els.push({ type: 'way', geometry: mm.geometry });
            }
        }
    }
    return waysToSegments(els);
}

// ─── GBRMPA (per-tile bbox queries; ids dedupe client-side) ───
const GB = 'https://services-ap1.arcgis.com/8gXWSCxaJlFIfiTr/arcgis/rest/services';
const arcQuery = (layer, t, extra = '') =>
    `${GB}/${layer}/query?where=1%3D1&outFields=*&outSR=4326&f=geojson` +
    `&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects` +
    `&geometry=${t.w},${t.s},${t.e},${t.n}${extra}`;

async function fetchNoAnchoring(t) {
    const g = await getJSONCached(
        `gbrmpa-noanchor-${t.id}`,
        arcQuery('Whitsundays_Plan_of_Management_no_anchoring_areas/FeatureServer/0', t),
    );
    return (g.features || []).map((f, i) => ({
        type: 'Feature',
        geometry: f.geometry,
        properties: {
            id: `gbrmpa-noanchor-${f.properties.OBJECTID ?? i}`,
            name: f.properties.LOC_NAME_S || 'No-anchoring area',
            type: f.properties.LOC_TYPE_S || 'No-anchoring area',
            source: 'GBRMPA',
            legal: `Whitsundays Plan of Management — Schedule ${f.properties.SCHEDULE_NO}, clause ${f.properties.CLAUSE_NO}`,
        },
    }));
}

async function fetchDesignated(t) {
    const g = await getJSONCached(
        `gbrmpa-desig-${t.id}`,
        arcQuery('Great_Barrier_Reef_Marine_Park_Designated_Anchorages_20/FeatureServer/60', t),
    );
    return (g.features || []).map((f) => {
        const p = f.properties;
        const [lon, lat] = representativePoint(f.geometry);
        return {
            lon,
            lat,
            name: p.AREA_DESCR || 'Designated anchorage',
            kind: 'designated_anchorage',
            source: 'GBRMPA',
            sourceRef: p.UNIQUE_ID || String(p.OBJECTID),
            notes: [p.COMMENT_, p.MANAREA && `Management area: ${p.MANAREA}`, p.LEG_NAME].filter(Boolean).join(' · '),
            likelyAnchorage: true,
        };
    });
}

const ZONE_COLORS = {
    'Green Zone': '#2fae5a',
    'Yellow Zone': '#e8c23f',
    'Light Blue Zone': '#7fc3dd',
    'Dark Blue Zone': '#3f6fb0',
    'Olive Green Zone': '#94a84f',
    'Buffer Zone': '#94a84f',
    'Orange Zone': '#e0822e',
    'Pink Zone': '#e58fb0',
    'Commonwealth Island Zone': '#b0b8bd',
    'Commonwealth Islands Zone': '#b0b8bd',
};

async function fetchZoning(t) {
    const g = await getJSONCached(
        `gbrmpa-zoning-${t.id}`,
        arcQuery('Great_Barrier_Reef_Marine_Park_Zoning_20/FeatureServer/53', t, '&maxAllowableOffset=0.001'),
    );
    return (g.features || []).map((f, i) => {
        const p = f.properties;
        return {
            type: 'Feature',
            geometry: f.geometry,
            properties: {
                id: `gbrmpa-zone-${p.OBJECTID ?? i}`,
                type: p.TYPE || 'Zone',
                zone: p.ALT_ZONE || p.TYPE || 'Zone',
                color: ZONE_COLORS[p.ALT_ZONE] || '#9aa7ad',
                name: p.NAME || null,
                permit: p.PERMIT_DESC || null,
                source: 'GBRMPA',
            },
        };
    });
}

// ─── build ───
const today = new Date().toISOString().slice(0, 10);
const index = { built: today, tileDeg: TILE_DEG, fetchCapNM: FETCH_CAP_NM, sectors: SECTORS, tiles: [] };

for (const t of tiles()) {
    if (onlyTile && t.id !== onlyTile) continue;
    console.log(`\n═══ ${t.id}  (${t.s}..${t.n}, ${t.w}..${t.e})`);

    const osm = await fetchOSMPoints(t);
    await sleep(1500);
    const designated = await fetchDesignated(t);
    const points = [...osm, ...designated].filter((p) => p.lat >= t.s && p.lat < t.n && p.lon >= t.w && p.lon < t.e);
    if (points.length === 0) {
        console.log('  no anchorages — skipping tile');
        await sleep(1000);
        continue;
    }
    console.log(`  ${points.length} points (${osm.length} OSM in-bbox, ${designated.length} designated)`);

    const coast = await fetchCoastSegments(t);
    await sleep(1500);
    const reef = await fetchReefSegments(t);
    await sleep(1500);
    console.log(`  coastline ${coast.length} segs, reef ${reef.length} segs`);

    console.log('  casting fetch tables…');
    for (const p of points) {
        p.fetchLandNM = fetchTable(p.lat, p.lon, coast);
        const reefTable = reef.length > 0 ? fetchTable(p.lat, p.lon, reef) : null;
        p.fetchReefNM = reefTable ? p.fetchLandNM.map((d, i) => Math.min(d, reefTable[i])) : p.fetchLandNM;
    }

    const noAnchor = await fetchNoAnchoring(t);
    const zoning = await fetchZoning(t);
    console.log(`  ${noAnchor.length} no-anchoring, ${zoning.length} zoning polys`);

    for (const p of points) {
        const hit = noAnchor.find((na) => pointInGeom([p.lon, p.lat], na.geometry));
        p.noAnchoring = !!hit;
        if (hit) p.noAnchoringName = hit.properties.name;
    }

    const pointFC = {
        type: 'FeatureCollection',
        meta: { region: 'QLD', tile: t.id, built: today, sources: ['OpenStreetMap (ODbL)', 'GBRMPA (CC BY)'] },
        features: points
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((p, i) => ({
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
                properties: {
                    id: p.sourceRef
                        ? `${p.source === 'GBRMPA' ? 'gbrmpa' : 'osm'}-${p.sourceRef.replace(/[^a-z0-9]/gi, '')}`
                        : `${t.id}-pt-${i}`,
                    name: p.name,
                    kind: p.kind,
                    source: p.source,
                    sourceRef: p.sourceRef,
                    likelyAnchorage: p.likelyAnchorage,
                    noAnchoring: p.noAnchoring,
                    noAnchoringName: p.noAnchoringName || null,
                    notes: p.notes || null,
                    fetchLandNM: p.fetchLandNM,
                    fetchReefNM: p.fetchReefNM,
                },
            })),
    };
    writeFileSync(join(OUT, `${t.id}.geojson`), JSON.stringify(pointFC));
    writeFileSync(
        join(OUT, `${t.id}-noanchor.geojson`),
        JSON.stringify({ type: 'FeatureCollection', meta: { tile: t.id, built: today }, features: noAnchor }),
    );
    writeFileSync(
        join(OUT, `${t.id}-zoning.geojson`),
        JSON.stringify({ type: 'FeatureCollection', meta: { tile: t.id, built: today }, features: zoning }),
    );
    index.tiles.push({
        id: t.id,
        bbox: [t.w, t.s, t.e, t.n],
        points: pointFC.features.length,
        noAnchor: noAnchor.length,
        zoning: zoning.length,
    });
    await sleep(2000);
}

if (!onlyTile) {
    writeFileSync(join(OUT, 'index.json'), JSON.stringify(index, null, 1));
    console.log(`\nWrote index.json — ${index.tiles.length} tiles with content`);
    const sources = `# QLD anchorage data — sources & provenance

Built ${today} by \`scripts/anchorages/build-qld.mjs\` (re-run to refresh).
Layout: 2°x2° tiles under \`qld/\`, directory in \`qld/index.json\`.

## Data sources
- **Anchorage positions & names, coastline, reefs** — © OpenStreetMap contributors, licensed **ODbL**. Named bays/coves/inlets, charted seamark anchorages and marinas along the QLD coast. Attribution required.
- **No-anchoring areas, designated anchorages, marine-park zoning** — © Great Barrier Reef Marine Park Authority (GBRMPA), \`gbrmpa_open_data\` ArcGIS org, licensed **CC BY**. Attribution required.
- **Forecasts consumed at verdict time** (not stored here) — Open-Meteo via the app's proxy; the verdict UI attributes them.

## Fetch tables
Every point carries \`fetchLandNM\` and \`fetchReefNM\`: 36 sectors x 10° true, distance (NM, capped ${FETCH_CAP_NM}) to the first OSM coastline / coastline-or-reef crossing, ray-cast at build time. They encode SHELTER GEOMETRY only — no depth, no holding, no weather.

## ⚓ Safety note (surface this in-app)
This is a **planning reference built from open data**, NOT a navigational chart and NOT a substitute for official charts, GBRMPA zoning maps, or the skipper's judgement. OSM positions are approximate and carry **no depth or holding data**; fetch tables inherit every gap in OSM coastline/reef mapping. Verdicts are advisory reads of this geometry plus a forecast — verify against official sources and your own eyes before anchoring.
`;
    writeFileSync(join(OUT, '..', 'SOURCES.md'), sources);
} else {
    console.log('\nSingle-tile run — index.json NOT written (run without args for the full build)');
}
console.log('Done.');
