/**
 * Build the bundled Whitsundays anchorage dataset for the in-app reference.
 *
 * Sources (all open / official — NO invented safety facts):
 *   - OpenStreetMap (Overpass)         named bays/coves/inlets + marinas   © OpenStreetMap contributors (ODbL)
 *   - GBRMPA gbrmpa_open_data (ArcGIS) no-anchoring areas, designated      © Great Barrier Reef Marine Park Authority (CC BY)
 *                                      anchorages (Whitsundays Plan of Management)
 *
 * Outputs (served from /public, cached offline by sw.js):
 *   - public/anchorages/whitsundays.geojson              points: anchorages, marinas, official designated anchorages
 *   - public/anchorages/whitsundays-no-anchoring.geojson polygons: GBRMPA no-anchoring areas
 *   - public/anchorages/SOURCES.md                       provenance + licence + safety note
 *
 * Re-run:  node scripts/anchorages/build-whitsundays.mjs   (needs network)
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'public', 'anchorages');
mkdirSync(OUT, { recursive: true });

const BBOX = { s: -20.6, w: 148.4, n: -19.9, e: 149.15 }; // Whitsundays
const UA = { headers: { 'User-Agent': 'thalassa-anchorages-build' } };
const getJSON = async (url, opts) => {
  const r = await fetch(url, { ...UA, ...opts });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url.slice(0, 80)}`);
  return r.json();
};

// ─── ray-casting point-in-polygon (lon/lat), handles Polygon + MultiPolygon ───
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
    if (pointInRing(pt, poly[0])) {
      // outer ring hit; ensure not in a hole
      const inHole = poly.slice(1).some((h) => pointInRing(pt, h));
      if (!inHole) return true;
    }
  }
  return false;
}
function representativePoint(geom) {
  const ring = geom.type === 'MultiPolygon' ? geom.coordinates[0][0] : geom.coordinates[0];
  let x = 0, y = 0;
  for (const [lx, ly] of ring) { x += lx; y += ly; }
  return [+(x / ring.length).toFixed(5), +(y / ring.length).toFixed(5)];
}

// ─── 1. OSM named anchorages + marinas via Overpass ───
async function fetchOSM() {
  const q = `[out:json][timeout:120];
(
  node["natural"="bay"](${BBOX.s},${BBOX.w},${BBOX.n},${BBOX.e});
  way["natural"="bay"](${BBOX.s},${BBOX.w},${BBOX.n},${BBOX.e});
  node["leisure"="marina"](${BBOX.s},${BBOX.w},${BBOX.n},${BBOX.e});
  way["leisure"="marina"](${BBOX.s},${BBOX.w},${BBOX.n},${BBOX.e});
);
out center tags;`;
  const d = await getJSON('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    body: 'data=' + encodeURIComponent(q),
    headers: { ...UA.headers, 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  const navRe = /passage|channel|sound|\bpass\b|flats/i;
  const seen = new Set();
  const out = [];
  for (const e of d.elements || []) {
    const t = e.tags || {};
    if (!t.name) continue;
    const key = e.type + e.id;
    if (seen.has(key)) continue;
    seen.add(key);
    const lat = e.lat ?? e.center?.lat;
    const lon = e.lon ?? e.center?.lon;
    if (lat == null || lon == null) continue;
    out.push({
      lon: +lon.toFixed(5),
      lat: +lat.toFixed(5),
      name: t.name,
      kind: t.leisure === 'marina' ? 'marina' : 'anchorage',
      source: 'OpenStreetMap',
      sourceRef: `${e.type}/${e.id}`,
      likelyAnchorage: !navRe.test(t.name),
    });
  }
  return out;
}

// ─── 2. GBRMPA layers ───
const GB = 'https://services-ap1.arcgis.com/8gXWSCxaJlFIfiTr/arcgis/rest/services';
const arcQuery = (layer, bbox) => {
  let u = `${GB}/${layer}/query?where=1%3D1&outFields=*&outSR=4326&f=geojson`;
  if (bbox) u += `&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&geometry=${BBOX.w},${BBOX.s},${BBOX.e},${BBOX.n}`;
  return u;
};

async function fetchNoAnchoring() {
  const g = await getJSON(arcQuery('Whitsundays_Plan_of_Management_no_anchoring_areas/FeatureServer/0', false));
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

async function fetchDesignated() {
  const g = await getJSON(arcQuery('Great_Barrier_Reef_Marine_Park_Designated_Anchorages_20/FeatureServer/60', true));
  return (g.features || []).map((f) => {
    const p = f.properties;
    const [lon, lat] = representativePoint(f.geometry);
    return {
      lon, lat,
      name: p.AREA_DESCR || 'Designated anchorage',
      kind: 'designated_anchorage',
      source: 'GBRMPA',
      sourceRef: p.UNIQUE_ID || String(p.OBJECTID),
      notes: [p.COMMENT_, p.MANAREA && `Management area: ${p.MANAREA}`, p.LEG_NAME].filter(Boolean).join(' · '),
      likelyAnchorage: true,
    };
  });
}

// GBR Marine Park Zoning — official zone colours (Zoning Plan 2003).
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
const zoneColor = (alt) => ZONE_COLORS[alt] || '#9aa7ad';

async function fetchZoning() {
    // Layer 53 = "Great Barrier Reef Marine Park Zoning". maxAllowableOffset
    // generalises the polygons server-side (~55 m) — the raw geometry is ~4 MB,
    // far too heavy to bundle; an overlay fill doesn't need vertex-perfect edges.
    const g = await getJSON(arcQuery('Great_Barrier_Reef_Marine_Park_Zoning_20/FeatureServer/53', true) + '&maxAllowableOffset=0.0005');
    return (g.features || []).map((f, i) => {
        const p = f.properties;
        return {
            type: 'Feature',
            geometry: f.geometry,
            properties: {
                id: `gbrmpa-zone-${p.OBJECTID ?? i}`,
                type: p.TYPE || 'Zone',
                zone: p.ALT_ZONE || p.TYPE || 'Zone',
                color: zoneColor(p.ALT_ZONE),
                name: p.NAME || null,
                permit: p.PERMIT_DESC || null,
                source: 'GBRMPA',
            },
        };
    });
}

// ─── build ───
console.log('Fetching OSM (Overpass)…');
const osm = await fetchOSM();
console.log(`  ${osm.length} OSM features (${osm.filter((o) => o.kind === 'anchorage').length} anchorages, ${osm.filter((o) => o.kind === 'marina').length} marinas)`);

console.log('Fetching GBRMPA no-anchoring areas…');
const noAnchor = await fetchNoAnchoring();
console.log(`  ${noAnchor.length} no-anchoring polygons`);

console.log('Fetching GBRMPA designated anchorages…');
const designated = await fetchDesignated();
console.log(`  ${designated.length} designated anchorages`);

console.log('Fetching GBRMPA marine-park zoning…');
const zoning = await fetchZoning();
const zoneCounts = {};
for (const z of zoning) zoneCounts[z.properties.zone] = (zoneCounts[z.properties.zone] || 0) + 1;
console.log(`  ${zoning.length} zoning polygons —`, JSON.stringify(zoneCounts));

// flag any point sitting inside a no-anchoring polygon
const points = [...osm, ...designated];
let flagged = 0;
for (const p of points) {
  const hit = noAnchor.find((na) => pointInGeom([p.lon, p.lat], na.geometry));
  p.noAnchoring = !!hit;
  if (hit) { p.noAnchoringName = hit.properties.name; flagged += 1; }
}
console.log(`  flagged ${flagged} point(s) inside a GBRMPA no-anchoring area:`);
for (const p of points.filter((x) => x.noAnchoring)) console.log(`    ⚠ ${p.name}  → ${p.noAnchoringName}`);

const today = new Date().toISOString().slice(0, 10);

const pointFC = {
  type: 'FeatureCollection',
  meta: { region: 'Whitsundays', built: today, sources: ['OpenStreetMap (ODbL)', 'GBRMPA (CC BY)'] },
  features: points
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p, i) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
      properties: {
        id: p.sourceRef ? `${p.source === 'GBRMPA' ? 'gbrmpa' : 'osm'}-${p.sourceRef.replace(/[^a-z0-9]/gi, '')}` : `pt-${i}`,
        name: p.name,
        kind: p.kind,
        source: p.source,
        sourceRef: p.sourceRef,
        likelyAnchorage: p.likelyAnchorage,
        noAnchoring: p.noAnchoring,
        noAnchoringName: p.noAnchoringName || null,
        notes: p.notes || null,
      },
    })),
};

const noAnchorFC = { type: 'FeatureCollection', meta: { region: 'Whitsundays', built: today, source: 'GBRMPA (CC BY)' }, features: noAnchor };
const zoningFC = { type: 'FeatureCollection', meta: { region: 'Whitsundays', built: today, source: 'GBRMPA (CC BY)' }, features: zoning };

writeFileSync(join(OUT, 'whitsundays.geojson'), JSON.stringify(pointFC));
writeFileSync(join(OUT, 'whitsundays-no-anchoring.geojson'), JSON.stringify(noAnchorFC));
writeFileSync(join(OUT, 'whitsundays-zoning.geojson'), JSON.stringify(zoningFC));

const sources = `# Whitsundays anchorage data — sources & provenance

Built ${today} by \`scripts/anchorages/build-whitsundays.mjs\` (re-run to refresh).

## Data sources
- **Anchorage positions & names** — © OpenStreetMap contributors, licensed **ODbL**. Named bays, coves, inlets and marinas in the Whitsundays bounding box. Attribution required.
- **No-anchoring areas, designated anchorages, marine-park zoning** — © Great Barrier Reef Marine Park Authority (GBRMPA), \`gbrmpa_open_data\` ArcGIS org, licensed **CC BY**. From the Whitsundays Plan of Management + GBR Marine Park Zoning Plan 2003. Attribution required.

## Files
- \`whitsundays.geojson\` — point features: anchorages (OSM), marinas (OSM), official designated anchorages (GBRMPA). Each carries \`noAnchoring\` = true if it falls inside a GBRMPA no-anchoring polygon.
- \`whitsundays-no-anchoring.geojson\` — GBRMPA no-anchoring area polygons.
- \`whitsundays-zoning.geojson\` — GBRMPA marine-park zoning polygons (zone type + official colour + permitted-use description). Determines what you may legally do at an anchorage (fishing/collecting), not just whether you can anchor.

## ⚓ Safety note (surface this in-app)
This is a **planning reference built from open data**, NOT a navigational chart and NOT a substitute for official charts, the GBRMPA zoning maps, or the skipper's judgement. OSM bay positions are approximate and carry **no depth, holding or protection data**. Always verify against official sources (GBRMPA zoning, AHO charts, Beacon to Beacon) and your own eyes before anchoring. No-anchoring areas change — confirm current GBRMPA data before relying on it.
`;
writeFileSync(join(OUT, 'SOURCES.md'), sources);

console.log(`\nWrote ${pointFC.features.length} points + ${noAnchor.length} no-anchoring + ${zoning.length} zoning polygons to public/anchorages/`);
