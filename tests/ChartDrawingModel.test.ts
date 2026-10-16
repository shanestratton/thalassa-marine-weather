import { it, expect } from 'vitest';
import {
    drawingGeometry,
    validateAnnotationLibrary,
    type AnnotationLibrary,
    type AnnotationGeometry,
} from '../services/chartAnnotations/model';
import { addDrawingPoint, finishDrawing, type DrawingDraft } from '../services/chartAnnotations/draft';
import { annotationsGeoJSON, annotationsGPX } from '../services/chartAnnotations/exports';
import { qualifiedRulerFix, boatRulerTo, boatRulerData } from '../services/chartAnnotations/ruler';
import type { InstrumentEvidence } from '../services/instruments/measurements';
const row = (geometry: AnnotationGeometry, id = '11111111-1111-4111-8111-111111111111') => ({
    id,
    revision: 1,
    createdAt: 1000,
    updatedAt: 1000,
    label: 'Café <bay> & marks',
    visible: true,
    geometry,
});
const library = (geometry: AnnotationGeometry): AnnotationLibrary => ({
    schema: 1,
    revision: 1,
    annotations: [row(geometry)],
});
const point: AnnotationGeometry = { type: 'Point', coordinates: [-1.330000000001, 1e-7] };
it('draw points preserve ordinary longitude exactly, wrap only world copies and close areas', () => {
    let draft: DrawingDraft = { kind: 'area', label: 'Area', points: [], moving: false };
    for (const [lon, lat] of [
        [179.8, 1],
        [180.2, 1],
        [180.2, 2],
    ])
        draft = addDrawingPoint(draft, lon, lat);
    expect(draft.points[1][0]).toBeCloseTo(-179.8, 10);
    const shape = finishDrawing(draft);
    expect(shape.type).toBe('Polygon');
    if (shape.type === 'Polygon') expect(shape.coordinates[0].at(-1)).toEqual(shape.coordinates[0][0]);
    expect(addDrawingPoint({ ...draft, kind: 'line', points: [] }, -1.330000000001, 1).points[0][0]).toBe(
        -1.330000000001,
    );
});
it('unfinished, crossed, coerced and oversized drawings refuse before saving', () => {
    expect(() => drawingGeometry('line', [[1, 1]])).toThrow('two');
    expect(() =>
        drawingGeometry('area', [
            [0, 0],
            [1, 1],
            [0, 1],
            [1, 0],
        ]),
    ).toThrow();
    expect(() =>
        drawingGeometry(
            'line',
            Array.from({ length: 257 }, (_, i) => [i / 100, 1]),
        ),
    ).toThrow('limit');
    expect(() => drawingGeometry('label', [[NaN, 1]])).toThrow();
    expect(() => validateAnnotationLibrary({ ...library(point), annotations: [row(point), row(point)] })).toThrow(
        'damaged',
    );
});
it('GeoJSON preserves geometry and GPX keeps exact point/line coordinates, schema order and plain Unicode labels', () => {
    const data = library(point);
    data.annotations.push(
        row(
            {
                type: 'LineString',
                coordinates: [
                    [1, 1],
                    [1.001, 1.002],
                ],
            },
            '22222222-2222-4222-8222-222222222222',
        ),
    );
    expect(
        JSON.parse(annotationsGeoJSON(data)).features.map((f: { geometry: AnnotationGeometry }) => f.geometry),
    ).toEqual(data.annotations.map((r) => r.geometry));
    const gpx = annotationsGPX(data),
        xml = new DOMParser().parseFromString(gpx, 'application/xml');
    expect(xml.querySelector('parsererror')).toBeNull();
    expect(xml.querySelector('wpt')?.getAttribute('lon')).toBe('-1.330000000001');
    expect(xml.querySelector('wpt')?.getAttribute('lat')).toBe('0.0000001');
    expect(xml.querySelector('wpt name')?.textContent).toBe('Café <bay> & marks');
    expect([...xml.documentElement.children].map((n) => n.localName)).toEqual(['metadata', 'wpt', 'trk']);
    expect(xml.querySelectorAll('time,ele,speed,route')).toHaveLength(0);
    expect(xml.querySelectorAll('trkpt')).toHaveLength(2);
});
it('GPX refuses the entire area or +180 export instead of losing its geometry', () => {
    expect(() =>
        annotationsGPX(
            library({
                type: 'Polygon',
                coordinates: [
                    [
                        [0, 0],
                        [1, 0],
                        [1, 1],
                        [0, 0],
                    ],
                ],
            }),
        ),
    ).toThrow('cannot preserve');
    expect(() => annotationsGPX(library({ type: 'Point', coordinates: [180, 1] }))).toThrow('+180');
});
const now = 100000;
const evidence = (): InstrumentEvidence => ({
    identity: 'qualified-boat-A',
    via: 'lan',
    position: { lat: 0, lon: 179.99, at: now - 1000 },
    readings: {
        headingTrue: { value: 90, at: now - 1500, unit: 'degrees', reference: 'true', source: 'physical-heading' },
    },
});
it('boat ruler uses original qualified fix, true geodesic bearing, dateline range and coherent optional heading', () => {
    const fix = qualifiedRulerFix(evidence(), now, 'owner:vessel')!;
    const ruler = boatRulerTo(fix, { lat: 0, lon: -179.99 }, now),
        data = boatRulerData(ruler, fix, now)!;
    expect(ruler.bearingTrue).toBeCloseTo(90, 8);
    expect(ruler.rangeNm).toBeCloseTo(1.2008, 3);
    expect(data.relative).toBeCloseTo(0, 8);
    expect(data.features).toHaveLength(2);
    const line = data.features[0].geometry;
    if (line.type === 'LineString') expect(line.coordinates[1][0]).toBeCloseTo(180.01, 8);
    const ring = data.features[1].geometry;
    if (ring.type === 'LineString') expect(ring.coordinates[0]).toEqual(ring.coordinates.at(-1));
});
it.each(['cloud', 'signalk'] as const)(
    'ruler refuses %s ownship privilege and never substitutes another position',
    (via) => {
        expect(qualifiedRulerFix({ ...evidence(), via }, now, 'owner')).toBeNull();
    },
);
it('stale/future/unowned fixes refuse; magnetic, stale or incoherent heading remains unknown', () => {
    const e = evidence();
    expect(qualifiedRulerFix({ ...e, position: { ...e.position!, at: now - 14000 } }, now, 'owner')).toBeNull();
    expect(qualifiedRulerFix({ ...e, position: { ...e.position!, at: now + 1 } }, now, 'owner')).toBeNull();
    expect(qualifiedRulerFix(e, now, '')).toBeNull();
    for (const change of [{ reference: 'magnetic' as const }, { at: now - 20000 }, { at: now - 10000 }]) {
        const bad = { ...e, readings: { headingTrue: { ...e.readings.headingTrue!, ...change } } };
        expect(qualifiedRulerFix(bad, now, 'owner')?.headingTrue).toBeNull();
    }
    const fix = qualifiedRulerFix(e, now, 'owner')!,
        ruler = boatRulerTo(fix, { lat: 0.01, lon: 179.99 }, now);
    expect(boatRulerData(ruler, { ...fix, identity: 'another-boat' }, now)).toBeNull();
    expect(boatRulerData(ruler, { ...fix, headingTrue: null, headingAt: null }, now)?.relative).toBeNull();
    expect(boatRulerData(ruler, fix, now + 13001)).toBeNull();
    expect(() => boatRulerTo(fix, { lat: 0, lon: 179.99 }, now + 13001)).toThrow('Fresh');
});
