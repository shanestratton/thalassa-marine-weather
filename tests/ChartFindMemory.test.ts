import { beforeEach, describe, expect, it } from 'vitest';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import type { EncConversionResult } from '../services/enc/types';
import {
    captureChartFindCell,
    chartFindMemoryStats,
    chartFindResultCurrent,
    chartFindTokenCurrent,
    dropChartFindCell,
    indexChartFindCell,
    retireChartFindCell,
    retireChartFindMemory,
    searchChartFindMemory,
} from '../services/enc/chartFindMemory';
const blob = (cellId = 'AU5TEST1', names = ['Harbour']): EncConversionResult => ({
    cellId,
    sourceHO: cellId.slice(0, 2),
    edition: 1,
    issued: '2026-10-16',
    bbox: [150, -28, 152, -26],
    layers: {
        SEAARE: {
            type: 'FeatureCollection',
            features: names.map((OBJNAM) => ({
                type: 'Feature',
                properties: { OBJNAM },
                geometry: { type: 'Point', coordinates: [151, -27] },
            })),
        },
    },
});
const allow = () => true;
beforeEach(() => retireChartFindMemory());
describe('chart search RAM fences and caps', () => {
    it('will not republish a late parse or select an old result after cell/account/Pi retirement', () => {
        for (const retire of [
            () => retireChartFindCell('au5test1'),
            retireChartFindMemory,
            () => setAuthIdentityScope('another-owner'),
        ]) {
            setAuthIdentityScope('first-owner');
            const token = captureChartFindCell('AU5TEST1');
            expect(indexChartFindCell(token, blob(), 'protected')).toBe(true);
            const result = searchChartFindMemory('harbour', allow).matches[0];
            expect(chartFindResultCurrent(result)).toBe(true);
            retire();
            expect(chartFindResultCurrent(result)).toBe(false);
            expect(indexChartFindCell(token, blob(), 'protected')).toBe(false);
            expect(searchChartFindMemory('harbour', allow).matches).toEqual([]);
        }
    });
    it('requires actual opaque token identity and matching canonical cell identity', () => {
        const token = captureChartFindCell('au5test1')!;
        expect(captureChartFindCell('AU5TEST1')).toBe(token);
        expect(chartFindTokenCurrent({ ...token })).toBe(false);
        expect(captureChartFindCell('../private')).toBeNull();
        expect(indexChartFindCell(token, blob('AU5OTHER'), 'protected')).toBe(false);
        expect(indexChartFindCell(token, blob(), 'protected')).toBe(true);
        dropChartFindCell('au5test1');
        expect(chartFindTokenCurrent(token)).toBe(true);
        expect(searchChartFindMemory('harbour', allow).matches).toHaveLength(0);
    });
    it('applies the live permission predicate before exposing any protected name/point', () => {
        indexChartFindCell(captureChartFindCell('AU5TEST1'), blob(), 'protected');
        indexChartFindCell(captureChartFindCell('US5TEST1'), blob('US5TEST1', ['Open Harbour']), 'open');
        const query = searchChartFindMemory('harbour', (_, licence) => licence === 'open');
        expect(query.cells).toBe(1);
        expect(query.matches.map((row) => row.name)).toEqual(['Open Harbour']);
        expect(query.matches[0]).not.toHaveProperty('search');
    });
    it('keeps only eight indexes/1MiB, caps pending tokens at256 and reports capped query coverage', () => {
        for (let n = 0; n < 9; n++) {
            const id = `AU5TEST${n}`;
            indexChartFindCell(
                captureChartFindCell(id),
                blob(
                    id,
                    Array.from({ length: 600 }, (_, i) => `Harbour ${i}`),
                ),
                'protected',
            );
        }
        expect(chartFindMemoryStats().cells).toBeLessThanOrEqual(8);
        expect(chartFindMemoryStats().bytes).toBeLessThanOrEqual(1024 * 1024);
        const query = searchChartFindMemory('harbour', allow);
        expect(query.matches).toHaveLength(20);
        expect(query.limited).toBe(true);
        for (let n = 0; n < 300; n++) captureChartFindCell(`US5CELL${n}`);
        expect(chartFindMemoryStats().tokenCount).toBe(256);
        expect(chartFindMemoryStats().cells).toBe(0);
    });
});
