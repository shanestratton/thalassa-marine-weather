// @vitest-environment node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseNoaaIndex } from '../services/enc/noaaCatalogueContract';
import { noaaEditionChanges, parseNoaaRevisions } from '../services/enc/noaaEditionPolicy';

const indexValue = JSON.parse(
    readFileSync(new URL('./fixtures/noaa-publisher/generated-index.json', import.meta.url), 'utf8'),
);
const wire = readFileSync(new URL('./fixtures/noaa-publisher/generated-revisions.json.txt', import.meta.url));
const value = () => JSON.parse(wire.toString('utf8'));
const now = Date.parse('2026-10-17T00:00:00Z');
const index = parseNoaaIndex(indexValue);
const held = { cellId: 'US5CA1LK', sourceHO: 'US', licence: 'open', edition: 1, updateNumber: 0 };

describe('generation-owned NOAA revision metadata', () => {
    it('accepts exact Python wire bytes, source clocks and original edition/update issuance', () => {
        expect(wire.length).toBe(index.revisions!.bytes);
        expect(createHash('sha256').update(wire).digest('hex')).toBe(index.revisions!.sha256);
        expect(parseNoaaRevisions(value(), index, now)).toEqual([
            { id: 'US5CA1LK', edition: 1, update: 1, issued: '2026-04-22', baseIssued: '2026-02-13' },
        ]);
    });
    it('keeps existing manifests without revisions valid and explicitly incomplete', () => {
        const legacy = { ...indexValue };
        delete legacy.revisions;
        expect(parseNoaaIndex(legacy).revisions).toBeUndefined();
        expect(() => parseNoaaRevisions(value(), parseNoaaIndex(legacy), now)).toThrow(/incomplete/);
    });
    it.each([
        { ...indexValue.revisions, key: 'https://outside.invalid/revisions.json' },
        { ...indexValue.revisions, key: `generations/${'f'.repeat(24)}/revisions.json` },
        { ...indexValue.revisions, bytes: 1024 * 1024 + 1 },
        { ...indexValue.revisions, bytes: 0 },
        { ...indexValue.revisions, bytes: 1.5 },
        { ...indexValue.revisions, sha256: 'not-a-hash' },
        { ...indexValue.revisions, geometry: [] },
        null,
    ])('rejects a foreign, unbounded or malformed revision reference: %j', (revisions) => {
        expect(() => parseNoaaIndex({ ...indexValue, revisions })).toThrow();
    });
    it('rejects foreign generations, partial/duplicate/withdrawn cohorts and extra geometry', () => {
        for (const patch of [
            { generation: 'f'.repeat(24) },
            { cells: [] },
            { cells: [value().cells[0], value().cells[0]] },
            { cells: [{ ...value().cells[0], geometry: { type: 'Point', coordinates: [0, 0] } }] },
            { geometry: [] },
        ])
            expect(() => parseNoaaRevisions({ ...value(), ...patch }, index, now)).toThrow();
        expect(() => parseNoaaRevisions(value(), { ...index, withdrawn: ['US5CA1LK'] }, now)).toThrow();
        expect(() => parseNoaaRevisions(value(), { ...index, activeCells: 2 }, now)).toThrow();
    });
    it('rejects impossible revision dates, order, counts and identities', () => {
        for (const patch of [
            { id: 'AU5CA1LK' },
            { edition: 0 },
            { edition: 1.2 },
            { update: -1 },
            { update: 10000 },
            { issued: '2026-02-30' },
            { baseIssued: '2026-05-01' },
            { issued: '2027-01-01' },
        ])
            expect(() =>
                parseNoaaRevisions({ ...value(), cells: [{ ...value().cells[0], ...patch }] }, index, now),
            ).toThrow();
    });
    it('does not let a fresh check clock renew an old original source or accept future/invalid clocks', () => {
        for (const altered of [
            { ...index, sourceAt: '2026-10-01T00:00:00Z', checkedAt: '2026-10-16T23:59:00Z' },
            { ...index, sourceAt: '2026-10-17T01:00:00Z' },
            { ...index, checkedAt: '2026-10-17T01:00:00Z' },
            { ...index, sourceAt: 'not a source clock' },
            { ...index, checkedAt: '' },
        ])
            expect(() => parseNoaaRevisions(value(), altered, now)).toThrow();
        expect(() => parseNoaaRevisions(value(), index, NaN)).toThrow();
        expect(() => parseNoaaRevisions(value(), index, now + 9 * 86400000)).toThrow();
        for (const sourceAt of ['2026-02-30T00:00:00Z', '2026-10-16', '2026-10-16T04:59:07+00:00'])
            expect(() => parseNoaaIndex({ ...indexValue, sourceAt })).toThrow();
        expect(parseNoaaIndex({ ...indexValue, checkedAt: '2026-10-16T06:00:00.123456Z' }).checkedAt).toBe(
            '2026-10-16T06:00:00.123456Z',
        );
    });
    it('compares integer updates and retains unknown held updates instead of treating them as zero', () => {
        const rows = parseNoaaRevisions(value(), index, now);
        expect(noaaEditionChanges([held], rows)[0]).toMatchObject({ kind: 'update', heldUpdate: 0 });
        expect(noaaEditionChanges([{ ...held, updateNumber: 9 }], [{ ...rows[0], update: 10 }])[0]).toMatchObject({
            kind: 'update',
            heldUpdate: 9,
            available: { update: 10 },
        });
        expect(noaaEditionChanges([{ ...held, updateNumber: undefined }], rows)).toEqual([]);
        expect(noaaEditionChanges([{ ...held, edition: 0 }], rows)).toEqual([]);
        expect(noaaEditionChanges([{ ...held, edition: 2 }], rows)).toEqual([]);
        expect(noaaEditionChanges([{ ...held, licence: 'protected' }], rows)).toEqual([]);
        expect(noaaEditionChanges([{ ...held, source: 's63' }], rows)).toEqual([]);
        expect(noaaEditionChanges([{ ...held, source: 'pi-decrypt' }], rows)).toEqual([]);
        expect(() => noaaEditionChanges([held, held], rows)).toThrow(/Ambiguous/);
        expect(() => noaaEditionChanges([held], [...rows, ...rows])).toThrow(/Ambiguous/);
    });
});
