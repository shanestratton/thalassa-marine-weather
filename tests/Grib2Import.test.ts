import { describe, it, expect } from 'vitest';
import { decodeGrib2Import } from '../services/weather/decodeGrib2Import';
import { decodeGrib1File } from '../services/weather/decodeGrib1Wind';
import { decodeGribImportRequest, gribTransferables } from '../services/weather/gribImportProtocol';
import { sampleImportedGrib, sampleWindGrid } from '../services/weather/importedGribSample';
import { importedGribPressure } from '../services/weather/importedGribPressure';
import {
    pressureFrameValidAt,
    pressureFrameWithinCoverage,
    pressureProvenance,
} from '../services/weather/pressureProvenance';
import { encodeWindTexture } from '../services/weather/windGridEncoding';
import { grib2Message, grib2Pair, alterSection } from './fixtures/grib2ImportFixtures';
import { concatenate, message } from './fixtures/grib1Fixtures';
describe('untrusted GRIB2 imports', () => {
    for (const scan of [0, 32, 64, 96, 128, 160, 192, 224])
        it(`normalizes scan${scan} without reversing vector signs`, () => {
            const file = decodeGrib2Import(grib2Pair({ scan }));
            expect([...file.wind!.u[0]]).toEqual([1, 2, 3, 4, 5, 6]);
            expect(file.wind!.lats).toEqual([-2, -1]);
            expect(file.wind!.lons).toEqual([-30, -29, -28]);
        });
    it('pairs reordered U/V and pressure by actual nonuniform times and carries the run', () => {
        const file = decodeGrib2Import(
            concatenate(
                grib2Message({ component: 'v', lead: 9 }),
                grib2Message({ component: 'p', lead: 12, reference: 100000, bits: 0 }),
                grib2Message({ lead: 0 }),
                grib2Message({ lead: 9 }),
                grib2Message({ component: 'v' }),
                grib2Message({ component: 'p', reference: 101000, bits: 0 }),
            ),
        );
        expect(file.wind!.stepHours).toEqual([0, 9]);
        expect(file.pressure!.stepHours).toEqual([0, 12]);
        expect([...file.pressure!.frames[0]]).toEqual(Array(6).fill(1010));
        expect(file.refTime).toBe('2026-01-01T00:00:00.000Z');
        expect(file.wind!.validUntil).toBe('2026-01-01T09:00:00.000Z');
        expect(gribTransferables(file)).toHaveLength(8);
    });
    it('decodes constant negative reference and signed scales across byte boundaries', () => {
        const g = decodeGrib2Import(
            grib2Pair({ reference: -5, binary: -1, decimal: -1, bits: 13, values: [1, 2, 3, 4, 5, 6] }),
        ).wind!;
        expect([...g.u[0]]).toEqual([-45, -40, -35, -30, -25, -20]);
    });
    it('keeps bitmap holes unknown and encodes transparent alpha', () => {
        const wind = decodeGrib2Import(grib2Pair({ bitmap: [true, false, true, true, true, true] })).wind!;
        expect(Number.isNaN(wind.u[0][1])).toBe(true);
        const rgba = encodeWindTexture(wind, 0);
        expect(rgba[7]).toBe(0);
        expect(rgba[3]).toBe(255);
    });
    for (const [name, section, change, code] of [
        ['complex packing', 5, (v: DataView) => v.setUint16(9, 2), 'UNSUPPORTED_PACKING'],
        ['rotated grid', 3, (v: DataView) => v.setUint16(12, 1), 'UNSUPPORTED_GRID'],
        ['grid relative vectors', 3, (v: DataView) => v.setUint8(54, 0x38), 'UNSUPPORTED_GRID'],
        ['alternating rows', 3, (v: DataView) => v.setUint8(71, 16), 'UNSUPPORTED_GRID'],
        ['averaged product', 4, (v: DataView) => v.setUint16(7, 8), 'UNSUPPORTED_PRODUCT'],
        ['reused bitmap', 6, (v: DataView) => v.setUint8(5, 254), 'UNSUPPORTED_BITMAP'],
        ['false count', 5, (v: DataView) => v.setUint32(5, 7), 'MALFORMED'],
        ['impossible date', 1, (v: DataView) => v.setUint8(14, 13), 'MALFORMED'],
        ['huge allocation', 3, (v: DataView) => v.setUint32(30, 0xffffffff), 'LIMIT'],
    ] as const)
        it(`rejects${name} explicitly`, () => {
            const changed = alterSection(grib2Message(), section, change);
            expect(() => decodeGrib2Import(concatenate(changed, grib2Message({ component: 'v' })))).toThrow(
                expect.objectContaining({ code }),
            );
        });
    it('rejects mixed runs, duplicate components, missing V and corrupt framing', () => {
        expect(() => decodeGrib2Import(concatenate(grib2Message(), grib2Message({ component: 'v', hour: 6 })))).toThrow(
            expect.objectContaining({ code: 'MIXED_SOURCE' }),
        );
        expect(() => decodeGrib2Import(concatenate(grib2Message(), grib2Message()))).toThrow(
            expect.objectContaining({ code: 'DUPLICATE_WIND' }),
        );
        expect(() => decodeGrib2Import(grib2Message().buffer as ArrayBuffer)).toThrow(
            expect.objectContaining({ code: 'INCOMPLETE_WIND' }),
        );
        const broken = new Uint8Array(grib2Pair());
        broken[broken.length - 1] = 0;
        expect(() => decodeGrib2Import(broken.buffer)).toThrow(expect.objectContaining({ code: 'MALFORMED' }));
        expect(() => decodeGrib2Import(grib2Pair().slice(0, -1))).toThrow(
            expect.objectContaining({ code: 'MALFORMED' }),
        );
    });
    it('cancels and sends only validated decoded content through the Worker protocol', () => {
        expect(() => decodeGrib2Import(grib2Pair(), () => false)).toThrow(
            expect.objectContaining({ code: 'CANCELLED' }),
        );
        const reply = decodeGribImportRequest({ id: 1, buffer: grib2Pair() }, () => true);
        expect(reply.type).toBe('decoded');
        const bad = decodeGribImportRequest({ id: 2, buffer: new Uint8Array([80, 75]).buffer }, () => true);
        expect(bad).toMatchObject({ type: 'error', code: 'NOT_GRIB' });
    });
});
describe('actual wind and pressure coverage', () => {
    const input = () =>
        concatenate(
            message({ parameter: 2, level: 102, height: 0, reference: 100000, bits: 0 }),
            message({ parameter: 2, level: 102, height: 0, p1: 12, reference: 101200, bits: 0 }),
            message({ values: Array(6).fill(3) }),
            message({ parameter: 34, values: Array(6).fill(4) }),
            message({ p1: 6, values: Array(6).fill(6) }),
            message({ parameter: 34, p1: 6, values: Array(6).fill(8) }),
        );
    it('supports pressure-only GRIB1 without inventing wind', () => {
        const file = decodeGrib1File(
            concatenate(message({ parameter: 2, level: 102, height: 0, reference: 100000, bits: 0 })),
        );
        expect(file.wind).toBeNull();
        expect([...file.pressure!.frames[0]]).toEqual(Array(6).fill(1000));
    });
    it('uses physical values/UTC and refuses space/time outside each field', () => {
        const file = decodeGrib1File(input()),
            at = Date.parse(file.refTime) + 3 * 3600000;
        expect(sampleImportedGrib(file, -1.5, -29, at)).toEqual({
            wind: { speedKts: 7.5 * 1.943844, directionFromDeg: 216.86989764584402 },
            pressureHpa: 1003,
        });
        expect(sampleImportedGrib(file, -1.5, -29, at + 4 * 3600000).wind).toBeNull();
        expect(sampleImportedGrib(file, 0, 0, at)).toEqual({ wind: null, pressureHpa: null });
        expect(sampleImportedGrib(file, -1, -29, Date.parse(file.refTime) - 1)).toEqual({
            wind: null,
            pressureHpa: null,
        });
    });
    it('preserves pressure step times and provenance without provider labels', () => {
        const file = decodeGrib1File(input()),
            grid = importedGribPressure(file)!;
        expect(pressureFrameValidAt(grid, 1)).toBe(Date.parse(file.refTime) + 12 * 3600000);
        expect(pressureFrameWithinCoverage(grid, Date.parse(file.refTime) + 13 * 3600000)).toBeNull();
        expect(pressureProvenance(grid.source, file.refTime, Date.parse(file.refTime)).label).toContain(
            'Imported GRIB',
        );
        expect(Number.isNaN(grid.allHourlyWindSpeed[0][0][0])).toBe(true);
    });
    it('sampling respects missing cells and skips only zero-weight unknown neighbours', () => {
        const file = decodeGrib2Import(grib2Pair({ bitmap: [true, false, true, true, true, true] })),
            at = Date.parse(file.refTime);
        expect(sampleImportedGrib(file, -2, -30, at).wind).not.toBeNull();
        expect(sampleImportedGrib(file, -2, -29.5, at).wind).toBeNull();
    });
    it('shared downloaded-grid sampling refuses absent clocks, invalid axes and endpoint extrapolation', () => {
        const wind = decodeGrib1File(input()).wind!,
            at = Date.parse(wind.refTime) + 3 * 3600000;
        expect(sampleWindGrid(wind, -1.5, -29, at)?.speedKts).toBeCloseTo(7.5 * 1.943844);
        expect(sampleWindGrid({ ...wind, refTime: undefined }, -1.5, -29, at)).toBeNull();
        expect(sampleWindGrid({ ...wind, stepHours: [6, 0] }, -1.5, -29, at)).toBeNull();
        expect(sampleWindGrid(wind, -1.5, -29, at + 4 * 3600000)).toBeNull();
    });
});
