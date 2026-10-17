import { describe, expect, it } from 'vitest';
import { scoreOwnWind, ownWindEffectiveN } from '../pi-cache/src/ownBoatSkill/score';
import type { PrivateWindSample } from '../pi-cache/src/ownBoatSkill/store';
import type { VerifiedWindIssue } from '../pi-cache/src/ownBoatSkill/forecast';
import { decodeIssuedSkill } from '../services/weather/modelSkill';
const HOUR = 3600_000,
    NOW = Date.UTC(2026, 9, 17, 12),
    STATION = 'own:synthetic-vessel';
function evidence(count = 241) {
    const samples: PrivateWindSample[] = [],
        issues: VerifiedWindIssue[] = [];
    for (let i = 0; i < count; i++) {
        const hour = NOW - (count - i) * HOUR,
            at = hour + 60_000;
        samples.push({
            at,
            receivedAt: at + 1000,
            positionAt: at,
            cell: '-2725_15300',
            windMps: 10,
            rawWind: JSON.stringify({ value: 10, timestamp: new Date(at).toISOString(), $source: 'synthetic.WI' }),
        });
        for (const [model, scale] of [
            ['dwd_icon', 1],
            ['ecmwf_ifs025', 2],
        ] as const)
            issues.push({
                model,
                cell: '-2725_15300',
                runAt: hour - 3 * HOUR,
                capturedAt: hour - 120_000,
                sha256: 'a'.repeat(64),
                points: [[hour, 10 + (i % 2 ? scale : -scale)]],
            });
    }
    return { samples, issues };
}
const score = (e = evidence()) => scoreOwnWind(e.samples, e.issues, NOW, STATION);
describe('bounded private instrument/issued-forecast agreement', () => {
    it('admits genuinely qualified comparable lead evidence without changing any selected model', () => {
        const result = score()[0];
        expect(result).toMatchObject({ status: 'ready', closest: 'dwd_icon', automaticModelSelection: false });
        expect(result.models.dwd_icon).toMatchObject({
            pairs: 241,
            effectiveN: 241,
            spanHours: 240,
            mae: 1,
            medianLeadHours: 3,
        });
        expect(decodeIssuedSkill(result, STATION, 'wind_speed_mps', '0-6h', NOW / 1000).status).toBe('ready');
    });
    it('leaves short history and a single model warming with null MAE and no closest claim', () => {
        for (const e of [
            evidence(29),
            (() => {
                const e = evidence();
                e.issues = e.issues.filter((r) => r.model === 'dwd_icon');
                return e;
            })(),
        ]) {
            const result = score(e)[0];
            expect(result.status).toBe('warming');
            expect(result.closest).toBeNull();
            expect(Object.values(result.models).every((r) => r.mae === null)).toBe(true);
        }
    });
    it('does not invent independent samples from constant residuals or isolated hours', () => {
        expect(ownWindEffectiveN(Array.from({ length: 300 }, (_, i) => [i * HOUR, 1] as const))).toBe(1);
        expect(ownWindEffectiveN(Array.from({ length: 100 }, (_, i) => [i * 2 * HOUR, i % 2] as const))).toBe(1);
        expect(ownWindEffectiveN([])).toBe(0);
    });
    it('keeps exact ties visible without choosing an arbitrary winner', () => {
        const e = evidence();
        for (const row of e.issues)
            if (row.model === 'ecmwf_ifs025') row.points = row.points.map(([at, value]) => [at, 10 + (value - 10) / 2]);
        expect(score(e)[0]).toMatchObject({ status: 'ready', closest: null, tiedModels: ['dwd_icon', 'ecmwf_ifs025'] });
    });
    it('does not reuse old-position forecasts after the boat moves into a different exact cell', () => {
        const e = evidence();
        for (const row of e.samples) row.cell = '-2750_15300';
        expect(score(e)[0]).toMatchObject({ status: 'warming', models: {}, closest: null });
    });
    it('requires actual capture before the original measurement, even when the forecast valid hour is later', () => {
        const e = evidence();
        for (const row of e.issues) row.capturedAt = row.points[0][0] + 60_000;
        expect(score(e)[0].models).toEqual({});
    });
    it('chooses the longest issuer lead in the bin without looking at its error', () => {
        const e = evidence(1),
            first = e.issues[0],
            at = first.points[0][0];
        e.issues.push({ ...first, runAt: at - 6 * HOUR, capturedAt: at - 2 * HOUR, points: [[at, 30]] });
        expect(score(e)[0].models.dwd_icon.medianLeadHours).toBe(6);
    });
    it('does not compare models that were observed in different valid hours', () => {
        const e = evidence();
        e.issues = e.issues.filter((r, i) => (r.model === 'dwd_icon') === (Math.floor(i / 2) % 2 === 0));
        const result = score(e)[0];
        expect(result.status).toBe('warming');
        expect(Object.values(result.models).every((r) => r.pairs === 0 && r.mae === null)).toBe(true);
    });
    it('keeps the four issuer lead bins separate, including exact6/24/48/72h boundaries', () => {
        for (const [hours, expected] of [
            [6, 0],
            [24, 1],
            [48, 2],
            [72, 3],
        ] as const) {
            const e = evidence(1);
            for (const row of e.issues) row.runAt = row.points[0][0] - hours * HOUR;
            const result = score(e);
            expect(result[expected].models.dwd_icon.pairs).toBe(1);
            expect(result.filter((_, i) => i !== expected).every((r) => Object.keys(r.models).length === 0)).toBe(true);
        }
    });
    it('refuses cohorts over fixed limits instead of silently truncating them', () => {
        const e = evidence(338);
        expect(() => score(e)).toThrow(/bound/);
        const small = evidence(1);
        small.issues = Array(1025).fill(small.issues[0]);
        expect(() => score(small)).toThrow(/bound/);
    });
});
