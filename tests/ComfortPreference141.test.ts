import { describe, expect, it } from 'vitest';
import { seaComfort, waterlineM } from '../utils/seaComfort';
import { validComfortPreference } from '../utils/comfortPreference';
import { qualifyComfortPreference, type PrivateComfortReport } from '../services/comfort/qualifyPreference';
const profile = { type: 'sail' as const, length: 40, revision: 1 };
const part = { hM: 0.9, periodS: 8, fromDeg: 90 };
const parts = { total: part, windSea: null, swell: null, secondarySwell: null };
const report = (n: number, level = 0): PrivateComfortReport => ({
    qualified: true,
    operation: `real-fixture-${n}`,
    voyageId: `fixture-voyage-${n % 3}`,
    capturedAt: '2026-10-17T00:00:00Z',
    fetchedAt: '2026-10-17T00:00:00Z',
    validAt: '2026-10-17T00:00:00Z',
    level,
    parts,
});
describe('private subjective comfort preference', () => {
    it('starts with exact unchanged beta thresholds', () => {
        const p = qualifyComfortPreference(profile, []);
        expect(p.adjustments.size).toBe(0);
        expect(seaComfort(parts, profile, p)).toEqual(seaComfort(parts, profile));
    });
    it('requires six reports across three voyages for each physical input', () => {
        expect(
            qualifyComfortPreference(
                profile,
                Array.from({ length: 5 }, (_, n) => report(n)),
            ).adjustments.size,
        ).toBe(0);
        expect(
            qualifyComfortPreference(
                profile,
                Array.from({ length: 12 }, (_, n) => ({ ...report(n), voyageId: `v${n % 2}` })),
            ).adjustments.size,
        ).toBe(0);
        const p = qualifyComfortPreference(
            profile,
            Array.from({ length: 6 }, (_, n) => report(n)),
        );
        expect(p.adjustments.size).toBe(-1);
        expect(p.qualified.size).toEqual({ reports: 6, voyages: 3 });
        expect(p.qualified.steepness).toEqual({ reports: 0, voyages: 0 });
        expect(p.adjustments.steepness).toBe(0);
        expect(seaComfort(parts, profile, p)?.word).toBe('Comfortable');
        expect(seaComfort(parts, profile, p)?.reason).toContain('personal preference');
    });
    it('uses a median of voyage medians, so a dense passage does not dominate', () => {
        const reports = [
            ...Array.from({ length: 100 }, (_, n) => ({ ...report(n, 3), voyageId: 'dense' })),
            ...Array.from({ length: 4 }, (_, n) => ({ ...report(n + 100, 0), voyageId: n < 2 ? 'quiet1' : 'quiet2' })),
        ];
        expect(qualifyComfortPreference(profile, reports).adjustments.size).toBe(-1);
    });
    it('deduplicates capture operations and refuses invalid levels/clocks/parts', () => {
        const sample = report(1);
        expect(qualifyComfortPreference(profile, Array(20).fill(sample)).qualified.size.reports).toBe(1);
        for (const change of [
            { qualified: false },
            { level: 4 },
            { validAt: 'garbage' },
            { validAt: '2026-10-16T00:00:00Z' },
            { parts: { ...parts, total: { ...part, hM: NaN } } },
        ])
            expect(
                qualifyComfortPreference(
                    profile,
                    Array.from({ length: 6 }, (_, n) => ({ ...report(n), ...change })),
                ).qualified.size.reports,
            ).toBe(0);
        expect(
            qualifyComfortPreference(
                profile,
                Array.from({ length: 121 }, (_, n) => report(n)),
            ).qualified.size.reports,
        ).toBe(0);
    });
    it('clamps preference to one word and never lowers rough/very rough WMO floors', () => {
        const p = qualifyComfortPreference(
            profile,
            Array.from({ length: 6 }, (_, n) => report(n)),
        );
        for (const [hM, word] of [
            [2.5, 'Uncomfortable'],
            [4, 'Hard going'],
        ] as const)
            expect(
                seaComfort(
                    { ...parts, total: { ...part, hM } },
                    { ...profile, length: 100 },
                    { ...p, profile: { ...profile, length: 100 } },
                )?.word,
            ).toBe(word);
        expect(
            qualifyComfortPreference(
                profile,
                Array.from({ length: 6 }, (_, n) => report(n, 3)),
            ).adjustments.size,
        ).toBe(1);
    });
    it('cannot borrow a different boat profile or malformed/unqualified adjustment', () => {
        const p = qualifyComfortPreference(
            profile,
            Array.from({ length: 6 }, (_, n) => report(n)),
        );
        for (const wrong of [
            { ...profile, length: 55 },
            { ...profile, type: 'power' as const },
        ]) {
            expect(validComfortPreference(p, wrong)).toBe(false);
            expect(seaComfort(parts, wrong, p)).toEqual(seaComfort(parts, wrong));
        }
        expect(validComfortPreference({ ...p, adjustments: { ...p.adjustments, size: -2 } }, profile)).toBe(false);
        expect(
            validComfortPreference({ ...p, qualified: { ...p.qualified, size: { reports: 5, voyages: 3 } } }, profile),
        ).toBe(false);
    });
    it('invalid physical values remain unknown, including infinite profile lengths', () => {
        expect(waterlineM({ ...profile, length: Infinity })).toBeNull();
        expect(seaComfort({ ...parts, total: { ...part, hM: Infinity } }, profile)).toBeNull();
        expect(seaComfort({ ...parts, total: { ...part, periodS: NaN } }, profile)).toBeNull();
        expect(seaComfort({ ...parts, total: { ...part, periodS: null } }, profile)?.word).toBeNull();
    });
});
