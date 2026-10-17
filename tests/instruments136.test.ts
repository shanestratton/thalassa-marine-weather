import { describe, expect, it } from 'vitest';
import { measuredCurrent } from '../services/instruments/measuredCurrent';
import { sailingPerformance } from '../services/instruments/performance';
import { instrumentLaylines } from '../services/instruments/laylines';
import type { InstrumentEvidence, InstrumentReading } from '../services/instruments/measurements';
import type { ResolvedRoutingPolar } from '../services/routingPolar';
import { calculateBearing } from '../utils/navigationCalculations';

const NOW = Date.UTC(2026, 9, 16, 10);
const read = (
    value: number,
    unit: InstrumentReading['unit'],
    reference?: InstrumentReading['reference'],
    at = NOW - 1000,
): InstrumentReading => ({ value, unit, reference, at, source: 'Fictional sensor' });
function evidence(): InstrumentEvidence {
    return {
        identity: 'fictional-boat',
        via: 'gateway',
        readings: {
            sog: read(Math.sqrt(26), 'knots', 'ground'),
            cogTrue: read((Math.atan2(1, 5) * 180) / Math.PI, 'degrees', 'true'),
            stw: read(5, 'knots', 'water'),
            headingTrue: read(0, 'degrees', 'true'),
            tws: read(15, 'knots'),
            twaSigned: read(60, 'degrees', 'relative'),
            twdTrue: read(60, 'degrees', 'true'),
        },
    };
}
const POLAR: ResolvedRoutingPolar = {
    source: 'manual',
    label: 'Fictional boat measured table',
    reason: 'Manually supplied',
    signature: 'fictional',
    polar: {
        windSpeeds: [10, 20],
        angles: [45, 90, 135, 180],
        matrix: [
            [4, 8],
            [4, 8],
            [4, 8],
            [4, 8],
        ],
    },
};
const VESSEL = { type: 'sail' as const, closeHauledTwa: 45 };
const perf = (e = evidence(), extra: Partial<Parameters<typeof sailingPerformance>[0]> = {}) =>
    sailingPerformance({ evidence: e, polar: POLAR, vessel: VESSEL, propulsion: 'sail', now: NOW, ...extra });

describe('instrument-derived current', () => {
    it('subtracts water from ground as earth-frame vectors, not scalar speed/course differences', () => {
        const result = measuredCurrent(evidence(), NOW);
        expect(result.kind).toBe('available');
        if (result.kind !== 'available') throw Error('Expected current');
        expect(result.eastKts).toBeCloseTo(1);
        expect(result.northKts).toBeCloseTo(0);
        expect(result.driftKts).toBeCloseTo(1);
        expect(result.setTrueDeg).toBeCloseTo(90);
        expect(result.leewayDeg).toBeNull();
        expect(result.leewaySource).toBeNull();
        expect(result.observedAt).toBe(NOW - 1000);
        expect(result.provenance).toBe('instrument-derived');
    });
    it('applies only explicit signed leeway and has no invented north bearing at zero drift', () => {
        const e = evidence();
        e.readings.sog = read(5, 'knots', 'ground');
        e.readings.cogTrue = read(10, 'degrees', 'true');
        e.readings.leeway = read(10, 'degrees', 'relative');
        const result = measuredCurrent(e, NOW);
        if (result.kind !== 'available') throw Error('Expected current');
        expect(result.driftKts).toBeCloseTo(0);
        expect(result.setTrueDeg).toBeNull();
        expect(result.leewayDeg).toBe(10);
        e.readings.leeway = read(-10, 'degrees', 'relative');
        const port = measuredCurrent(e, NOW);
        if (port.kind !== 'available') throw Error('Expected current');
        expect(port.eastKts).toBeGreaterThan(1.7);
    });
    for (const [field, patch] of [
        ['headingTrue', { reference: 'magnetic' }],
        ['headingTrue', { at: 0 }],
        ['headingTrue', { value: 6668 }],
        ['stw', { unit: 'degrees' }],
        ['stw', { value: -1 }],
        ['sog', { value: NaN }],
        ['cogTrue', { reference: 'relative' }],
        ['sog', { at: NOW + 1001 }],
        ['stw', { at: NOW - 13001 }],
    ] as const)
        it(`refuses invalid ${field} evidence ${JSON.stringify(patch)}`, () => {
            const e = evidence();
            Object.assign(e.readings[field]!, patch);
            expect(measuredCurrent(e, NOW).kind).toBe('unavailable');
        });
    it('refuses asynchronous, slow and implausible vectors; old receipt times never repair missing sensor time', () => {
        const e = evidence();
        e.readings.stw!.at = NOW - 8000;
        expect(measuredCurrent(e, NOW)).toMatchObject({ reason: 'not-simultaneous' });
        e.readings.stw = read(0.2, 'knots', 'water');
        expect(measuredCurrent(e, NOW)).toMatchObject({ reason: 'too-slow' });
        e.readings.stw = read(90, 'knots', 'water');
        expect(measuredCurrent(e, NOW)).toMatchObject({ reason: 'implausible-current' });
    });
    it('marks stale real evidence and refuses an invalid supplied correction rather than replacing it with zero', () => {
        const e = evidence();
        for (const reading of Object.values(e.readings)) reading.at = NOW - 7000;
        expect(measuredCurrent(e, NOW)).toMatchObject({
            kind: 'available',
            freshness: 'stale',
            observedAt: NOW - 7000,
        });
        e.readings.leeway = read(30, 'degrees', 'relative', NOW - 7000);
        expect(measuredCurrent(e, NOW)).toMatchObject({ reason: 'leeway-unusable' });
    });
});

describe('polar performance without fabricated sailing speed', () => {
    it('uses interpolated polar figures and STW for VMG and percentage, with generic boat geometry', () => {
        const e = evidence();
        e.readings.stw = read(3, 'knots', 'water');
        e.readings.sog = read(20, 'knots', 'ground');
        const p = perf(e);
        if (p.kind !== 'available') throw Error('Expected performance');
        expect(p.vmgKts).toBeCloseTo(1.5);
        expect(p.referenceSpeedKts).toBeCloseTo(6);
        expect(p.performancePct).toBeCloseTo(50);
        expect(p.upwind).toMatchObject({ angleDeg: 45, speedKts: 6 });
        expect(p.downwind).toMatchObject({ angleDeg: 180, speedKts: 6 });
        expect(p.upwind!.vmgKts).toBeCloseTo(6 * Math.SQRT1_2);
        expect(p.polarLabel).toBe(POLAR.label);
    });
    it('keeps missing water speed, unknown propulsion and no-go speeds unknown rather than substituting SOG', () => {
        const e = evidence();
        delete e.readings.stw;
        expect(perf(e)).toMatchObject({ kind: 'available', vmgKts: null, performancePct: null });
        expect(perf(evidence(), { propulsion: 'unknown' })).toMatchObject({
            kind: 'available',
            performancePct: null,
            pointOfSail: null,
        });
        const noGo = evidence();
        noGo.readings.twaSigned = read(10, 'degrees', 'relative');
        expect(perf(noGo)).toMatchObject({ kind: 'available', referenceSpeedKts: null, performancePct: null });
    });
    it('suppresses motor boats and actual engine use, refuses wind extrapolation and malformed polar cells', () => {
        expect(perf(evidence(), { vessel: { type: 'power' } })).toMatchObject({ reason: 'not-sailing-boat' });
        expect(perf(evidence(), { propulsion: 'engine' })).toMatchObject({ reason: 'engine-running' });
        const e = evidence();
        e.readings.tws = read(30, 'knots');
        expect(perf(e)).toMatchObject({ reason: 'wind-outside-polar' });
        expect(perf(evidence(), { polar: { ...POLAR, polar: { ...POLAR.polar, matrix: [[NaN, 0]] } } })).toMatchObject({
            reason: 'polar-unavailable',
        });
    });
    it('derives true wind only from true-reference heading, labels fallback/source scaling and does not borrow stale wind', () => {
        const e = evidence();
        delete e.readings.twdTrue;
        expect(perf(e)).toMatchObject({ kind: 'available', windFromTrueDeg: 60 });
        e.readings.headingTrue!.reference = 'magnetic';
        expect(perf(e)).toMatchObject({ kind: 'available', windFromTrueDeg: null });
        e.readings.twaSigned!.at = NOW - 8000;
        expect(perf(e)).toMatchObject({ reason: 'wind-not-simultaneous' });
        expect(
            perf(evidence(), {
                polar: { ...POLAR, source: 'default', label: 'Generic cruising polar', routingScale: 0.85 },
            }),
        ).toMatchObject({ polarSource: 'default', polarLabel: 'Generic cruising polar', routingScale: 0.85 });
    });
    it('corrects measured VMG only for a fresh signed leeway observation', () => {
        const e = evidence();
        e.readings.stw = read(4, 'knots', 'water');
        e.readings.leeway = read(10, 'degrees', 'relative');
        const p = perf(e);
        if (p.kind !== 'available') throw Error('Expected performance');
        expect(p.vmgKts).toBeCloseTo(4 * Math.cos((50 * Math.PI) / 180));
        expect(p.leewayApplied).toBe(true);
        e.readings.leeway!.at = NOW - 20000;
        expect(perf(e)).toMatchObject({ kind: 'available', leewayApplied: false });
        expect((perf(e) as { vmgKts: number }).vmgKts).toBeCloseTo(2);
    });
});

describe('current-corrected local layline guides', () => {
    const boat = { lat: 0, lon: 0 },
        mark = { lat: 0.02, lon: 0 };
    function values() {
        const e = evidence();
        e.readings.twaSigned = read(60, 'degrees', 'relative');
        e.readings.twdTrue = read(0, 'degrees', 'true');
        const p = perf(e),
            c = measuredCurrent(e, NOW);
        if (p.kind !== 'available' || c.kind !== 'available') throw Error('Expected instruments');
        return { p, c };
    }
    it('adds measured current to target water vectors with true-bearing labels, and clearly states the local assumption', () => {
        const { p, c } = values();
        const lines = instrumentLaylines({ boat, mark, performance: p, current: c, now: NOW })!;
        expect(lines.correction).toBe('local-instrument-current');
        expect(lines.note).toContain('assumed unchanged');
        const port = lines.lines.find((line) => line.tack === 'port')!;
        expect(port.groundCourseTrueDeg).toBeGreaterThan(port.headingTrueDeg);
        expect(calculateBearing(port.points[0].lat, port.points[0].lon, mark.lat, mark.lon)).toBeCloseTo(
            port.groundCourseTrueDeg,
            1,
        );
    });
    it('keeps unknown/stale/cloud/other-boat currents explicitly uncorrected and refuses absent sailing state or distant marks', () => {
        const { p, c } = values();
        for (const current of [
            null,
            { ...c, identity: 'another-boat' },
            { ...c, via: 'cloud' as const },
            { ...c, observedAt: NOW - 7000 },
        ])
            expect(instrumentLaylines({ boat, mark, performance: p, current, now: NOW })).toMatchObject({
                correction: 'uncorrected',
            });
        expect(
            instrumentLaylines({ boat, mark, performance: { ...p, propulsion: 'unknown' }, current: c, now: NOW }),
        ).toBeNull();
        expect(instrumentLaylines({ boat, mark: { lat: 1, lon: 1 }, performance: p, current: c, now: NOW })).toBeNull();
    });
    it('keeps dateline guides in one local world copy', () => {
        const { p, c } = values();
        const lines = instrumentLaylines({
            boat: { lat: 0, lon: 179.99 },
            mark: { lat: 0.01, lon: -179.99 },
            performance: p,
            current: c,
            now: NOW,
        })!;
        expect(lines).not.toBeNull();
        for (const line of lines.lines) expect(Math.abs(line.points[0].lon - line.points[1].lon)).toBeLessThan(1);
    });
});
