import { describe, it, expect } from 'vitest';
import { zipSync } from 'fflate';
import { wgs, shapeZip } from './helpers/userOverlayFixture';
import { normalizeOverlay, overlayDisplayData } from '../services/userOverlays/model';
import { kmlToGeoJSON } from '../services/userOverlays/kml';
import { geographicWgs84, shapefileToGeoJSON } from '../services/userOverlays/shapefile';
import { AreaEntryTracker, areaRelation, type EntryArea, type EntryFix } from '../services/userOverlays/entry';
const ring = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
    [0, 0],
];
const polygon = (coordinates = [ring]) => ({
    type: 'Feature',
    properties: { name: 'Private area', notes: 'not saved', url: 'https://never.invalid' },
    geometry: { type: 'Polygon', coordinates },
});
const area: EntryArea = {
    key: 'private:revision:one',
    label: 'A',
    source: 'user overlay',
    geometry: { type: 'Polygon', coordinates: [ring] },
};
const fix = (lon: number, at: number, extra: Partial<EntryFix> = {}): EntryFix => ({
    lat: 0.5,
    lon,
    at,
    identity: 'receiver-A',
    accuracyM: 5,
    source: 'original receiver',
    ...extra,
});
describe('bounded local overlay formats', () => {
    it('normalizes geometry and plain labels while discarding URLs/private attributes', () => {
        const p = normalizeOverlay(polygon());
        expect(p.vertices).toBe(5);
        expect(p.polygons).toBe(1);
        expect(p.data.features[0].properties).toEqual({ label: 'Private area' });
        expect(JSON.stringify(p)).not.toContain('never.invalid');
    });
    it.each([NaN, Infinity, '0', null])('rejects nonfinite/coerced coordinate %s', (v) =>
        expect(() =>
            normalizeOverlay(
                polygon([
                    [
                        [v, 0],
                        [1, 0],
                        [1, 1],
                        [0, 0],
                    ] as number[][],
                ]),
            ),
        ).toThrow(),
    );
    it('refuses foreign CRS, null/unclosed geometry and chart pack shapes', () => {
        for (const v of [
            { ...polygon(), crs: { name: 'EPSG:3857' } },
            { cells: [] },
            { layers: {} },
            { type: 'Feature', geometry: null },
            polygon([
                [
                    [0, 0],
                    [1, 0],
                    [1, 1],
                    [0, 1],
                ],
            ]),
        ])
            expect(() => normalizeOverlay(v)).toThrow();
    });
    it('enforces feature/vertex/line limits before retention', () => {
        expect(() =>
            normalizeOverlay({ type: 'FeatureCollection', features: Array.from({ length: 2001 }, () => polygon()) }),
        ).toThrow();
        expect(() =>
            normalizeOverlay({ type: 'LineString', coordinates: Array.from({ length: 5001 }, () => [0, 0]) }),
        ).toThrow();
    });
    it('renders a dateline polygon continuously without changing saved coordinates', () => {
        const p = normalizeOverlay(
            polygon([
                [
                    [179, 0],
                    [-179, 0],
                    [-179, 1],
                    [179, 1],
                    [179, 0],
                ],
            ]),
        );
        const d = overlayDisplayData(p.data);
        expect(JSON.stringify(d)).toContain('181');
        expect(JSON.stringify(p.data)).not.toContain('181');
    });
    it('reads KML namespace, multi geometry and holes as WGS84 without remote links', () => {
        const text =
            '<kml xmlns="http://www.opengis.net/kml/2.2"><Placemark><name>&lt;b&gt;Area&lt;/b&gt;</name><MultiGeometry><Point><coordinates>0,0</coordinates></Point><Polygon><outerBoundaryIs><LinearRing><coordinates>0,0 1,0 1,1 0,1 0,0</coordinates></LinearRing></outerBoundaryIs><innerBoundaryIs><LinearRing><coordinates>.2,.2 .3,.2 .3,.3 .2,.3 .2,.2</coordinates></LinearRing></innerBoundaryIs></Polygon></MultiGeometry></Placemark></kml>';
        const p = normalizeOverlay(kmlToGeoJSON(text));
        expect(p.data.features).toHaveLength(2);
        expect(p.polygons).toBe(1);
        expect(p.data.features[0].properties.label).toBe('<b>Area</b>');
    });
    it.each([
        '<!DOCTYPE kml [<!ENTITY x SYSTEM "file:///private">]><kml/>',
        '<kml><NetworkLink><Link><href>https://never.invalid</href></Link></NetworkLink></kml>',
        '<kml><GroundOverlay/></kml>',
        '<kml><Placemark><gx:Track xmlns:gx="x"/></Placemark></kml>',
    ])('refuses XML entities and linked/unsupported KML', (text) => expect(() => kmlToGeoJSON(text)).toThrow());
    it('reads an actual bounded deflated shapefile/DBF/PRJ set', () => {
        const p = normalizeOverlay(shapefileToGeoJSON(shapeZip()));
        expect(p.data.features[0]).toMatchObject({
            properties: { label: 'Buoy' },
            geometry: { type: 'Point', coordinates: [153, -27] },
        });
    });
    it('rejects projected WGS84, a missing/geocentric CRS and geographic radians', () => {
        for (const p of [
            'PROJCS["WGS84 UTM",' + wgs + ']',
            'GEOCS["WGS84"]',
            wgs.replace('"degree",0.0174532925199433', '"radian",1'),
            '',
        ]) {
            expect(geographicWgs84(p)).toBe(false);
            expect(() => shapefileToGeoJSON(shapeZip(p))).toThrow();
        }
    });
    it('rejects ZIP traversal, corruption, extra datasets and oversized advertised expansion', () => {
        expect(() => shapefileToGeoJSON(zipSync({ '../sample.shp': new Uint8Array(4) }))).toThrow();
        const zip = shapeZip();
        zip[40] ^= 255;
        expect(() => shapefileToGeoJSON(zip)).toThrow();
        expect(() => shapefileToGeoJSON(zipSync({ 'a.shp': new Uint8Array(4), 'b.shp': new Uint8Array(4) }))).toThrow();
    });
});
describe('original-clock outside-to-inside episodes', () => {
    it('starts unknown inside, establishes outside then emits one notice with original clock', () => {
        const t = new AreaEntryTracker();
        expect(t.update([area], fix(0.5, 1000), 1000)).toEqual([]);
        expect(t.update([area], fix(-0.2, 2000), 2000)).toEqual([]);
        expect(t.update([area], fix(0.5, 3000), 3000)).toMatchObject([{ at: 3000, label: 'A' }]);
        expect(t.update([area], fix(0.6, 4000), 4000)).toEqual([]);
    });
    it('holes and dateline polygons have independent inside/outside semantics', () => {
        const hole = {
            ...area,
            geometry: {
                type: 'Polygon' as const,
                coordinates: [
                    ring,
                    [
                        [0.2, 0.2],
                        [0.4, 0.2],
                        [0.4, 0.4],
                        [0.2, 0.4],
                        [0.2, 0.2],
                    ],
                ],
            },
        };
        expect(areaRelation(hole, fix(0.3, 1000, { lat: 0.3 }))).toBe('outside');
        const dateline = {
            ...area,
            geometry: {
                type: 'Polygon' as const,
                coordinates: [
                    [
                        [179, 0],
                        [-179, 0],
                        [-179, 1],
                        [179, 1],
                        [179, 0],
                    ],
                ],
            },
        };
        expect(areaRelation(dateline, fix(-179.5, 1000))).toBe('inside');
        expect(areaRelation(dateline, fix(0, 1000))).toBe('outside');
    });
    it('boundary noise, stale/future/repeated fixes never fire or rearm', () => {
        const t = new AreaEntryTracker();
        t.update([area], fix(-0.2, 1000), 1000);
        expect(t.update([area], fix(0, 2000), 2000)).toEqual([]);
        expect(t.update([area], fix(0.5, 1000), 2000)).toEqual([]);
        expect(t.update([area], fix(0.5, 50000), 3000)).toEqual([]);
        expect(t.update([area], fix(0.5, 3000), 50000)).toEqual([]);
        expect(t.update([area], fix(0.5, 50001), 50001)).toEqual([]);
    });
    it('unknown/omitted areas do not clear an episode and source/revision changes baseline anew', () => {
        const t = new AreaEntryTracker();
        t.update([area], fix(-0.2, 1000), 1000);
        t.update([area], fix(0.5, 2000), 2000);
        t.update([], fix(-0.2, 3000), 3000);
        expect(t.update([area], fix(0.5, 4000), 4000)).toEqual([]);
        expect(t.update([area], fix(0.5, 5000, { identity: 'different vessel' }), 5000)).toEqual([]);
        expect(t.update([{ ...area, key: 'revision2' }], fix(0.5, 6000), 6000)).toEqual([]);
    });
    it('distinct unnamed polygon keys both fire; invalid accuracy and caps remain unknown', () => {
        const t = new AreaEntryTracker(),
            both = [area, { ...area, key: 'second' }];
        t.update(both, fix(-0.2, 1000), 1000);
        expect(t.update(both, fix(0.5, 2000), 2000)).toHaveLength(2);
        t.reset();
        t.update(both, fix(-0.2, 3000), 3000);
        expect(t.update(both, fix(0.5, 4000, { accuracyM: 1000 }), 4000)).toEqual([]);
        expect(
            t.update(
                Array.from({ length: 2001 }, () => area),
                fix(0.5, 5000),
                5000,
            ),
        ).toEqual([]);
    });
});

it('self-crossing rings, outside/nested holes and source-marked ENC exports refuse', () => {
    expect(() =>
        normalizeOverlay(
            polygon([
                [
                    [0, 0],
                    [2, 0],
                    [1, 2],
                    [1, -1],
                    [0, 1],
                    [0, 0],
                ],
            ]),
        ),
    ).toThrow();
    expect(() =>
        normalizeOverlay(
            polygon([
                ring,
                [
                    [2, 2],
                    [3, 2],
                    [3, 3],
                    [2, 3],
                    [2, 2],
                ],
            ]),
        ),
    ).toThrow();
    const f = polygon();
    f.properties = { ...f.properties, _cellId: 'AU5TEST1' } as typeof f.properties;
    expect(() => normalizeOverlay(f)).toThrow('chart');
    expect(geographicWgs84(wgs + ']')).toBe(false);
    expect(geographicWgs84(wgs.slice(0, -1))).toBe(false);
});
it('capacity exhaustion stays visibly unknown until an explicit source/lifecycle reset', () => {
    const t = new AreaEntryTracker();
    t.update(
        Array.from({ length: 2001 }, () => area),
        fix(-0.2, 1000),
        1000,
    );
    expect(t.limited).toBe(true);
    t.update([area], fix(-0.2, 2000), 2000);
    expect(t.update([area], fix(0.5, 3000), 3000)).toEqual([]);
    expect(t.limited).toBe(true);
    t.reset();
    expect(t.limited).toBe(false);
    t.update([area], fix(-0.2, 4000), 4000);
    expect(t.update([area], fix(0.5, 5000), 5000)).toHaveLength(1);
});
