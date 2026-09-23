// @vitest-environment node
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { FeatureCollection } from 'geojson';
import lineIntersect from '@turf/line-intersect';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { buildCanalDepartureGeometry, canalDepartureBbox } from '../services/canalDepartureGeometry';
import { decodeWaterFromTile } from '../services/mapboxWater';
import { describe, expect, it } from 'vitest';
import {
    loadRegionalOverlay,
    selectRegionalOverlay,
    NEWPORT_COVERAGE,
    REGIONAL_MAX_AGE_MS,
} from '../supabase/functions/_shared/regional-overlay';

const raw = JSON.parse(readFileSync('supabase/functions/osm-overlay/data/newport-v1.json', 'utf8'));
const now = Date.parse(raw.sourceAsOf) + 2 * 86_400_000;
const canal: [number, number, number, number] = [153.08724, -27.21675, 153.09686, -27.17273];
const mutatePayload = (change: (o: any) => void) => {
    const next = structuredClone(raw),
        overlay = JSON.parse(next.overlayJson);
    change(overlay);
    next.overlayJson = JSON.stringify(overlay);
    next.payloadSha256 = createHash('sha256').update(next.overlayJson).digest('hex');
    return next;
};

describe('controlled Newport canal data', () => {
    it('routes the real Newport bend with the regional obstacles, without bank or pontoon crossings', async () => {
        const features = decodeWaterFromTile(
            readFileSync('tests/fixtures/mapbox-water-16-60637-37918.mvt'),
            16,
            60637,
            37918,
        );
        const a = { lon: 153.0922886, lat: -27.2102277 },
            b = { lon: 153.0927659, lat: -27.2069373 };
        const bbox = canalDepartureBbox(a, b);
        const overlay = selectRegionalOverlay(await loadRegionalOverlay(raw), bbox, now)!;
        const obstacles = {
            type: 'FeatureCollection',
            features: ['berths', 'breakwater', 'aeroway', 'reef'].flatMap((k) => overlay[k as 'berths'].features),
        } as FeatureCollection;
        const result = buildCanalDepartureGeometry(a, b, bbox, { type: 'FeatureCollection', features }, obstacles);
        expect(result.coordinates.length).toBeGreaterThan(3);
        for (const obstacle of obstacles.features)
            if (obstacle.geometry.type !== 'Point')
                expect(
                    lineIntersect(
                        { type: 'LineString', coordinates: result.coordinates },
                        obstacle as Parameters<typeof lineIntersect>[1],
                    ).features,
                ).toHaveLength(0);
        for (let i = 1; i < result.coordinates.length; i++) {
            const a = result.coordinates[i - 1],
                b = result.coordinates[i];
            for (let n = 0; n <= 200; n++)
                expect(
                    features.some((f) =>
                        booleanPointInPolygon([a[0] + ((b[0] - a[0]) * n) / 200, a[1] + ((b[1] - a[1]) * n) / 200], f),
                    ),
                ).toBe(true);
        }
    });
    it('verifies the real bundle and returns attributed obstacles for the reported canal area', async () => {
        const data = await loadRegionalOverlay(raw);
        const result = selectRegionalOverlay(data, canal, now)!;
        expect(result.berths.features.length).toBeGreaterThan(100);
        expect(result.provenance).toMatchObject({
            region: 'newport-v1',
            sourceAsOf: raw.sourceAsOf,
            coverage: NEWPORT_COVERAGE,
        });
        expect(result.provenance.limitations).toContain('No depth');
    });
    it('does not substitute a partial region for an outside or straddling query', async () => {
        const data = await loadRegionalOverlay(raw);
        expect(selectRegionalOverlay(data, [153.05, -27.22, 153.08, -27.2], now)).toBeNull();
        expect(selectRegionalOverlay(data, [151, -29, 151.01, -28.99], now)).toBeNull();
        expect(selectRegionalOverlay(data, [...NEWPORT_COVERAGE], now)).not.toBeNull();
    });
    it('rechecks source age on every request, not fetch time or warm-isolate time', async () => {
        const data = await loadRegionalOverlay(raw);
        expect(selectRegionalOverlay(data, canal, now)).not.toBeNull();
        expect(() => selectRegionalOverlay(data, canal, Date.parse(raw.sourceAsOf) + REGIONAL_MAX_AGE_MS)).toThrow(
            'requires refresh',
        );
        expect(() => selectRegionalOverlay(data, canal, Date.parse(raw.sourceAsOf) - 1)).toThrow('requires refresh');
    });
    it('rejects future generation dates', async () => {
        const data = await loadRegionalOverlay({ ...raw, generatedAt: new Date(now + 600_000).toISOString() });
        expect(() => selectRegionalOverlay(data, canal, now)).toThrow('requires refresh');
    });
    it('rejects tampering even if the JSON still parses', async () => {
        await expect(loadRegionalOverlay({ ...raw, overlayJson: raw.overlayJson + ' ' })).rejects.toThrow('checksum');
    });
    it.each([
        { schema: 2 },
        { coverage: [153, -28, 154, -27] },
        { sourceAsOf: 'invalid' },
        { sourceUrl: 'https://example.com/other.pbf' },
        { licenseUrl: '' },
    ])('rejects invalid provenance %j', async (bad) => {
        await expect(loadRegionalOverlay({ ...raw, ...bad })).rejects.toThrow('manifest');
    });
    it('rejects missing collections or a truncated inventory', async () => {
        await expect(
            loadRegionalOverlay(
                mutatePayload((o) => {
                    delete o.reef;
                }),
            ),
        ).rejects.toThrow('collections');
        await expect(
            loadRegionalOverlay(
                mutatePayload((o) => {
                    o.berths.features.pop();
                }),
            ),
        ).rejects.toThrow('inventory');
    });
    it('rejects unsupported geometry and false per-feature bounding boxes', async () => {
        await expect(
            loadRegionalOverlay(
                mutatePayload((o) => {
                    o.berths.features[0].geometry.type = 'GeometryCollection';
                }),
            ),
        ).rejects.toThrow('geometry');
        await expect(
            loadRegionalOverlay(
                mutatePayload((o) => {
                    o.berths.features[0].bbox = [0, 0, 1, 1];
                }),
            ),
        ).rejects.toThrow('bounds');
    });
    it('keeps a crossing wall even if none of its vertices lie in the query', async () => {
        const data = await loadRegionalOverlay(raw);
        data.overlay.breakwater.features.push({
            type: 'Feature',
            properties: {},
            bbox: [153.085, -27.2, 153.1, -27.2],
            geometry: {
                type: 'LineString',
                coordinates: [
                    [153.085, -27.2],
                    [153.1, -27.2],
                ],
            },
        });
        expect(selectRegionalOverlay(data, canal, now)!.breakwater.features.at(-1)?.bbox).toEqual([
            153.085, -27.2, 153.1, -27.2,
        ]);
    });
    it('serves the region after auth but before legacy cache/Overpass and never caches its age away', () => {
        const source = readFileSync('supabase/functions/osm-overlay/index.ts', 'utf8');
        expect(source.indexOf('requireAuthenticatedOrPublicQuota(req')).toBeLessThan(
            source.indexOf('selectRegionalOverlay(await'),
        );
        expect(source.indexOf('selectRegionalOverlay(await')).toBeLessThan(
            source.indexOf(".from('osm_overlay_cache')"),
        );
        expect(source).toContain("'Cache-Control': 'no-store'");
        expect(source).toContain("'X-Overlay-Cache': 'regional'");
    });
});
