import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    ascatViewportTiles,
    decodeAscatIndex,
    decodeAscatPointer,
    decodeAscatTile,
} from '../services/weather/ascatContract';
const fixture = JSON.parse(readFileSync(resolve('tests/fixtures/ascat141-packet.json'), 'utf8'));
const pointerRaw = JSON.parse(fixture.resources['latest.json']);
const pointer = () => decodeAscatPointer(pointerRaw, fixture.now);
const indexRaw = () => JSON.parse(fixture.resources[`generations/${pointerRaw.generation}/index.json`]);
const index = () => decodeAscatIndex(indexRaw(), pointer(), fixture.now);
const tileRaw = () => JSON.parse(fixture.resources[`generations/${pointerRaw.generation}/tile-66-12.json`]);
describe('141 satellite original cohort trust boundary', () => {
    it('accepts the actual Python cohort builder fixture while retaining original time, zero and source ordinal', () => {
        expect(fixture.synthetic).toBe(true);
        const rows = decodeAscatTile(tileRaw(), '66-12', index(), fixture.now);
        expect(rows).toHaveLength(2);
        expect(rows[0]).toEqual([154, -27, 1792221000, 12, 135, 0]);
        expect(rows[1][3]).toBe(0);
        expect(index().sources[0].doi).toBe('10.15770/EUM_SAF_OSI_NRT_2019');
    });
    it.each([
        'effectiveResolutionKm',
        'samplingKm',
        'direction',
        'windBasis',
        'qc',
        'licence',
        'coverage',
        'copyright',
    ])('refuses wrong or missing %s rather than infer a continuous wind field', (field) => {
        const raw = indexRaw();
        raw[field] = 'unknown';
        expect(() => decodeAscatIndex(raw, pointer(), fixture.now)).toThrow();
    });
    it('refuses aliases, duplicates and changed original filename/orbit clocks', () => {
        for (const mutate of [
            (v: ReturnType<typeof indexRaw>) => {
                v.sources[0].dataset = 'osisaf_ascat_a_coa';
            },
            (v: ReturnType<typeof indexRaw>) => {
                v.sources.push(v.sources[0]);
            },
            (v: ReturnType<typeof indexRaw>) => {
                v.sources[0].orbitStart--;
            },
            (v: ReturnType<typeof indexRaw>) => {
                v.sources[0].processedAt = fixture.now + 1;
            },
        ]) {
            const raw = indexRaw();
            mutate(raw);
            expect(() => decodeAscatIndex(raw, pointer(), fixture.now)).toThrow();
        }
    });
    it('holds expired/future availability and original tile count/source/units corruption', () => {
        expect(() => decodeAscatPointer(pointerRaw, pointerRaw.expiresAt)).toThrow();
        expect(() => decodeAscatPointer(pointerRaw, pointerRaw.generatedAt - 61)).toThrow();
        for (const mutate of [
            (v: ReturnType<typeof tileRaw>) => {
                v.rows[0][5] = 1;
            },
            (v: ReturnType<typeof tileRaw>) => {
                v.rows[0][4] = 360;
            },
            (v: ReturnType<typeof tileRaw>) => {
                v.rows[0][2] = fixture.now + 1;
            },
            (v: ReturnType<typeof tileRaw>) => {
                v.rows[0][0] = 1;
            },
            (v: ReturnType<typeof tileRaw>) => {
                v.rows.push(v.rows[0]);
            },
        ]) {
            const raw = tileRaw();
            mutate(raw);
            expect(() => decodeAscatTile(raw, '66-12', index(), fixture.now)).toThrow();
        }
    });
    it('bounds dateline and ordinary viewports to nine fixed tiles, never a world request', () => {
        expect(ascatViewportTiles([153, -28, 155, -26])).toEqual(['66-12']);
        expect(ascatViewportTiles([179, -1, -179, 1])).toEqual(['0-17', '0-18', '71-17', '71-18']);
        expect(() => ascatViewportTiles([-180, -80, 180, 80])).toThrow(/Zoom in/);
        expect(() => ascatViewportTiles([0, 0, 15, 15])).not.toThrow();
        expect(() => ascatViewportTiles([1, 1, 16, 16])).toThrow(/nine tiles/);
        expect(() => ascatViewportTiles([NaN, 0, 1, 1])).toThrow();
    });
});
