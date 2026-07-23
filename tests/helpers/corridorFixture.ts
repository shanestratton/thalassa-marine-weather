/**
 * Shared loader + injection recipe for the real-chart corridor fixtures
 * (ROUTING_COLLAB.md replies 5-6). Used by the golden lock AND the
 * scorecard baseline so the two can never drift. If Claude B exports
 * assembleInshoreLayers() from InshoreRouter.ts post-lock-in, swap the
 * recipe here for the shared export — one place to change.
 */

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import type { RouteRequest } from '../../services/inshoreRouterEngine';
import type { Feature, FeatureCollection } from 'geojson';

// ── Fixture loading ────────────────────────────────────────────────

export interface CorridorFixture {
    _meta: Record<string, unknown>;
    request: RouteRequest;
    cells: Record<string, FeatureCollection>;
    osm: Record<string, FeatureCollection>;
}

export function loadFixture(name: string): CorridorFixture {
    const path = join(__dirname, '..', 'fixtures', name);
    return JSON.parse(gunzipSync(readFileSync(path)).toString()) as CorridorFixture;
}

// ── Injection recipe (verbatim from ROUTING_COLLAB.md) ────────────

/** min(bbox widthM, heightM) >= m at mid-latitude — mirrors isPolygonWideEnough. */
function wide(f: Feature, m: number): boolean {
    let minLon = Infinity,
        maxLon = -Infinity,
        minLat = Infinity,
        maxLat = -Infinity;
    const walk = (coords: unknown): void => {
        if (Array.isArray(coords) && typeof coords[0] === 'number') {
            const [lon, lat] = coords as [number, number];
            if (lon < minLon) minLon = lon;
            if (lon > maxLon) maxLon = lon;
            if (lat < minLat) minLat = lat;
            if (lat > maxLat) maxLat = lat;
        } else if (Array.isArray(coords)) {
            for (const c of coords) walk(c);
        }
    };
    walk((f.geometry as { coordinates?: unknown }).coordinates);
    if (!isFinite(minLon)) return false;
    const midLat = ((minLat + maxLat) / 2) * (Math.PI / 180);
    const widthM = (maxLon - minLon) * 111_320 * Math.cos(midLat);
    const heightM = (maxLat - minLat) * 110_540;
    return Math.min(widthM, heightM) >= m;
}

/** cells + osm → the layer set production hands routeInshore. */

export function assembleLayers(fx: CorridorFixture): any {
    const m: any = {};
    for (const k of Object.keys(fx.cells)) m[k] = { type: 'FeatureCollection', features: [...fx.cells[k].features] };
    for (const k of ['COASTLINE', 'CANAL', 'NAVLINE', 'FAIRWY', 'DEPARE', 'OBSTRN'])
        m[k] ??= { type: 'FeatureCollection', features: [] };
    const o = fx.osm;
    for (const f of o.water.features) {
        m.DEPARE.features.push({ ...f, properties: { ...(f.properties ?? {}), DRVAL1: 10, DRVAL2: 10 } });
        const p = f.properties ?? {};
        const riverish =
            p.water === 'river' ||
            p.water === 'harbour' ||
            p.waterway === 'river' ||
            p.waterway === 'riverbank' ||
            p.harbour === 'yes';
        if (riverish && wide(f, 200))
            m.FAIRWY.features.push({
                ...f,
                properties: { ...(f.properties ?? {}), _promotePreferred: true, _source: 'osm-water-promoted' },
            });
    }
    for (const f of o.marina.features)
        m.DEPARE.features.push({ ...f, properties: { ...(f.properties ?? {}), DRVAL1: 5, DRVAL2: 5 } });
    for (const f of o.reef.features)
        m.OBSTRN.features.push({ ...f, properties: { ...(f.properties ?? {}), _class: 'osm-reef' } });
    for (const f of o.breakwater.features)
        (f.geometry.type.includes('Polygon') ? m.LNDARE : m.COASTLINE).features.push(f);
    for (const f of o.aeroway.features)
        if (f.geometry.type.includes('Polygon'))
            m.OBSTRN.features.push({ ...f, properties: { ...(f.properties ?? {}), _class: 'osm-aeroway' } });
    for (const f of o.coastline.features) m.COASTLINE.features.push(f);
    for (const f of o.canalLines.features) m.CANAL.features.push(f);
    for (const f of o.navLines.features) m.NAVLINE.features.push(f);
    return m;
}
