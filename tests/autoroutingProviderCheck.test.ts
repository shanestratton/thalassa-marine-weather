import { describe, expect, it } from 'vitest';
import {
    providerFeatureFinding,
    providerCheckSummary,
    snapshotProviderFindingDetails,
    snapshotProviderHazardGeometry,
    PROVIDER_HAZARD_MAX_VERTICES,
    type ProviderHazardGeometry,
} from '../supabase/functions/_shared/autorouting-provider-check';
// The client's hazard locator (services/providerHazardGeometry) went with the
// SevenCs client on 2026-10-01; these are the edge function's own cases.

const point = [153.095128, -27.1675];
const ring = [
    [153, -27],
    [153.1, -27],
    [153.1, -27.1],
    [153, -27],
];
const hole = [
    [153.04, -27.02],
    [153.05, -27.02],
    [153.05, -27.03],
    [153.04, -27.02],
];
const finding = (geometry?: unknown, properties: Record<string, unknown> = { type: 'danger', severity: 'Danger' }) =>
    providerFeatureFinding(properties, 17, geometry)!;
const geometries: ProviderHazardGeometry[] = [
    { type: 'Point', coordinates: point as [number, number] },
    {
        type: 'MultiPoint',
        coordinates: [
            [153, -27],
            [153.1, -27.1],
        ],
    },
    {
        type: 'LineString',
        coordinates: [
            [153, -27],
            [153.05, -27.04],
            [153.1, -27.1],
        ],
    },
    {
        type: 'MultiLineString',
        coordinates: [
            [
                [153, -27],
                [153.05, -27.04],
            ],
            [
                [153.06, -27.06],
                [153.1, -27.1],
            ],
        ],
    },
    { type: 'Polygon', coordinates: [ring, hole] as [number, number][][] },
    {
        type: 'MultiPolygon',
        coordinates: [[ring, hole], [ring.map(([lon, lat]) => [lon + 0.2, lat])]] as [number, number][][][],
    },
];

describe('exact bounded provider hazard geometry and provenance', () => {
    it.each(geometries)('retains every %j coordinate and original order without aliasing source data', (geometry) => {
        const original = structuredClone(geometry);
        const result = finding(geometry);
        expect(result.geometry).toEqual(original);
        expect(result.featureIndex).toBe(17); // source feature, not leg 17
        expect(result.geometry).not.toBe(geometry);
        expect(result.geometry?.coordinates).not.toBe(geometry.coordinates);
        expect(geometry).toEqual(original);
        const details = snapshotProviderFindingDetails(result)!;
        expect(details.geometry).toEqual(original);
        expect(details.geometry).not.toBe(result.geometry);
    });

    it('retains raw primitive properties with exact keys and explicitly counts omissions', () => {
        const properties = Object.fromEntries([
            ['type', 'danger'],
            ['severity', 'Warning'],
            ['UUID', 'raw-id-not-normalized'],
            ['dataSet', 'OC-cell'],
            ['class', 'OBSTRN'],
            ['nullable', null],
            ['count', 2],
            ['checked', true],
            ['html', '<img src=x onerror=alert(1)>'],
            ['nested', { unknown: true }],
            ['large', 'x'.repeat(513)],
            ['__proto__', 'forbidden'],
            ['constructor', 'forbidden'],
        ]);
        const result = finding(geometries[0], properties);
        expect(result.severity).toBe('caution');
        expect(result.providerSeverity).toBe('Warning');
        expect(result.provenance).toEqual({
            source: 'SevenCs GeoJSON',
            omittedPropertyCount: 4,
            properties: {
                type: 'danger',
                severity: 'Warning',
                UUID: 'raw-id-not-normalized',
                dataSet: 'OC-cell',
                class: 'OBSTRN',
                nullable: null,
                count: 2,
                checked: true,
                html: '<img src=x onerror=alert(1)>',
            },
        });
        expect(Object.hasOwn(result.provenance!.properties, '__proto__')).toBe(false);
        expect(Object.hasOwn(result.provenance!.properties, 'constructor')).toBe(false);
        const snapshot = snapshotProviderFindingDetails(result)!;
        result.provenance!.properties.UUID = 'mutated';
        expect(snapshot.provenance!.properties.UUID).toBe('raw-id-not-normalized');
    });

    it('does not attach an overall unsafe track geometry as a locatable hazard', () => {
        const result = finding(geometries[2], { type: 'track', safe: false });
        expect(result.severity).toBe('danger');
        expect(result.geometry).toBeUndefined();
        expect(result.provenance?.properties.safe).toBe(false);
        expect(snapshotProviderFindingDetails({ ...result, geometry: geometries[2] })).toBeNull();
    });

    it.each([
        undefined,
        null,
        { type: 'Point', coordinates: [153, NaN] },
        { type: 'Point', coordinates: [Infinity, -27] },
        { type: 'Point', coordinates: [-27, 153] },
        { type: 'Point', coordinates: [153, -27, 0] },
        { type: 'Point', coordinates: ['153', -27] },
        { type: 'LineString', coordinates: [[153, -27]] },
        { type: 'LineString', coordinates: [[153, -27], null, [153.1, -27]] },
        { type: 'MultiLineString', coordinates: [] },
        {
            type: 'Polygon',
            coordinates: [
                [
                    [153, -27],
                    [153.1, -27],
                    [153.1, -27.1],
                ],
            ],
        },
        { type: 'Polygon', coordinates: [ring, []] },
        { type: 'GeometryCollection', geometries: [geometries[0]] },
    ])('retains the warning but refuses unsupported/malformed location %j', (geometry) => {
        const result = finding(geometry);
        expect(result.severity).toBe('danger');
        expect(result.message).toContain('severity Danger');
        expect(result.geometry).toBeUndefined();
    });

    it('declines over-budget geometry without thinning vertices or removing its warning', () => {
        const geometry = {
            type: 'MultiPoint',
            coordinates: Array.from({ length: PROVIDER_HAZARD_MAX_VERTICES + 1 }, () => [...point]),
        };
        const result = finding(geometry);
        expect(result.geometry).toBeUndefined();
        expect(result.message).toContain('Provider check feature 18');
        expect(geometry.coordinates).toHaveLength(PROVIDER_HAZARD_MAX_VERTICES + 1);
    });

    it('bounds aggregate drawing work while retaining every finding and unmodified source snapshots', () => {
        const geometry = { type: 'MultiPoint', coordinates: Array.from({ length: 2_000 }, () => [...point]) };
        const findings = Array.from({ length: 6 }, (_, index) => ({ ...finding(geometry), featureIndex: index }));
        const result = providerCheckSummary(findings);
        expect(result.status).toBe('unsafe');
        expect(result.findings).toHaveLength(6);
        expect(result.findings.filter((item) => item.geometry)).toHaveLength(5);
        expect(result.findings[5].message).toBe(findings[5].message);
        expect(findings[5].geometry).toBeDefined();
    });

    it.each([
        { geometry: null },
        { geometry: { type: 'Point', coordinates: [153] } },
        { provenance: null },
        { provenance: { source: 'Other', properties: {}, omittedPropertyCount: 0 } },
        { provenance: { source: 'SevenCs GeoJSON', properties: { object: {} }, omittedPropertyCount: 0 } },
        { provenance: { source: 'SevenCs GeoJSON', properties: {}, omittedPropertyCount: -1 } },
        { provenance: { source: 'SevenCs GeoJSON', properties: {}, omittedPropertyCount: 0.5 } },
        { provenance: { source: 'SevenCs GeoJSON', properties: { long: 'x'.repeat(513) }, omittedPropertyCount: 0 } },
        {
            provenance: {
                source: 'SevenCs GeoJSON',
                properties: Object.fromEntries([['__proto__', 'bad']]),
                omittedPropertyCount: 0,
            },
        },
    ])('rejects malformed normalized optional details rather than making a locator %j', (details) => {
        expect(snapshotProviderFindingDetails(details)).toBeNull();
    });

    it('allows older findings without optional location/provenance', () => {
        expect(snapshotProviderFindingDetails({ featureIndex: 0, message: 'Legacy warning' })).toEqual({});
    });
});

describe('provider hazard geometry stays exact at the edges', () => {
    it.each([
        { type: 'Point', coordinates: [153, 90] },
        {
            type: 'LineString',
            coordinates: [
                [179.9, -27],
                [-179.9, -27],
            ],
        },
        {
            type: 'MultiPoint',
            coordinates: [
                [179.9, -27],
                [-179.9, -27],
            ],
        },
    ])('retains exact source %j', (geometry) => {
        expect(finding(geometry).geometry).toEqual(geometry);
    });

    it('snapshots geometry exactly', () => {
        expect(snapshotProviderHazardGeometry(geometries[0])).toEqual(geometries[0]);
    });
});
