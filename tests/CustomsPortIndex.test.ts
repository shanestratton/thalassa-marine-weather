/**
 * Customs: a small synchronous port index, and the clearance guide as data
 * (build 126 bundle diet).
 *
 * isSameCountry decides whether a passage needs customs at all, and two
 * screens call it synchronously while they render (CrewManagement's cast-off
 * gate and the readiness card stack). So the part it needs, every country's
 * name and designated ports of entry plus the shorthand aliases, stays in
 * JavaScript as a few KB. The clearance guide itself (procedures, contacts,
 * documents, fees: about 40 KB) moved to public/data/customs-clearance.json
 * and loads when the customs card opens.
 *
 * The fixture records what the OLD module answered, before the split, for
 * every country key, country name, port of entry, alias and a spread of
 * free-text port names from around the world. The new index must give the
 * same answer for every one of them and every pair of them.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CUSTOMS_PORT_INDEX, findCountryKey, isSameCountry, resolveCountryName } from '../data/customsPortIndex';
import { joinClearance, type CountryClearanceDetails } from '../data/customsDb';

const ROOT = process.cwd();
const baseline = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/customs-same-country-baseline.json'), 'utf8')) as {
    countryOrder: string[];
    clearanceSha256: string;
    inputs: string[];
    resolveCountryName: string[];
    findCountryData: (string | null)[];
    isSameCountryHexRows: string[];
};
const details = JSON.parse(readFileSync(join(ROOT, 'public/data/customs-clearance.json'), 'utf8')) as Record<
    string,
    CountryClearanceDetails
>;

const bitsOf = (hex: string, n: number) =>
    [...hex]
        .map((h) => parseInt(h, 16).toString(2).padStart(4, '0'))
        .join('')
        .slice(0, n);

afterEach(() => vi.unstubAllGlobals());

describe('isSameCountry: old vs new over every port', () => {
    it('is synchronous and needs no file: it answers with every fetch failing', () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(() => {
                throw new Error('isSameCountry must not fetch');
            }),
        );
        const answer = isSameCountry('Falmouth', 'Las Palmas');
        expect(typeof answer).toBe('boolean');
        expect(answer).toBe(false);
        expect(isSameCountry('Opua', 'Auckland')).toBe(true);
    });

    it('resolves every recorded input to the same country', () => {
        const n = baseline.inputs.length;
        expect(n).toBeGreaterThan(300);
        const mismatches = baseline.inputs.filter((s, i) => resolveCountryName(s) !== baseline.resolveCountryName[i]);
        expect(mismatches).toEqual([]);
    });

    it('finds the same country record for every recorded input', () => {
        const mismatches = baseline.inputs.filter(
            (s, i) => (findCountryKey(s) ?? null) !== baseline.findCountryData[i],
        );
        expect(mismatches).toEqual([]);
    });

    it('gives the same answer for every pair of recorded inputs', () => {
        const n = baseline.inputs.length;
        const mismatches: string[] = [];
        baseline.inputs.forEach((a, i) => {
            const row = bitsOf(baseline.isSameCountryHexRows[i], n);
            baseline.inputs.forEach((b, j) => {
                if (isSameCountry(a, b) !== (row[j] === '1')) mismatches.push(`${a} | ${b}`);
            });
        });
        expect(mismatches.slice(0, 20)).toEqual([]);
    });

    it('keeps the empty-port rule: a missing port is never "same country"', () => {
        expect(isSameCountry(undefined, 'Sydney')).toBe(false);
        expect(isSameCountry('Sydney', '')).toBe(false);
        expect(isSameCountry(undefined, undefined)).toBe(false);
    });
});

describe('the index and the clearance guide split the old data without loss', () => {
    it('covers the same countries in the same order', () => {
        expect(Object.keys(CUSTOMS_PORT_INDEX)).toEqual(baseline.countryOrder);
        expect(Object.keys(details)).toEqual(baseline.countryOrder);
    });

    it('joins back into exactly the old clearance records', () => {
        const canonical = (v: unknown): unknown =>
            Array.isArray(v)
                ? v.map(canonical)
                : v && typeof v === 'object'
                  ? Object.fromEntries(
                        Object.keys(v as object)
                            .sort()
                            .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
                    )
                  : v;
        const joined = joinClearance(details);
        const sha = createHash('sha256')
            .update(JSON.stringify(canonical(joined)))
            .digest('hex');
        expect(sha).toBe(baseline.clearanceSha256);
    });

    it('keeps the clearance prose out of the synchronous module', () => {
        const index = readFileSync(join(ROOT, 'data/customsPortIndex.ts'), 'utf8');
        expect(index.length).toBeLessThan(16_000);
        expect(index).not.toMatch(/departureProcedure|arrivalProcedure|requiredDocuments/);
        const db = readFileSync(join(ROOT, 'data/customsDb.ts'), 'utf8');
        expect(db.length).toBeLessThan(16_000);
        expect(db).not.toContain('Maritime Arrivals Reporting System');
    });

    it('holds no country name or port list twice: those live in the index only', () => {
        for (const record of Object.values(details)) {
            expect(record).not.toHaveProperty('country');
            expect(record).not.toHaveProperty('portsOfEntry');
            expect(record).not.toHaveProperty('flag');
        }
    });
});
