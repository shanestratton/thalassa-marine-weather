import { describe, expect, it } from 'vitest';
import {
    calculatePassageEta,
    PassagePositionSpeed,
    PassageSpeedHistory,
    stabilizePassageEta,
    type PassageEtaInput,
} from '../services/passageEta';

const NOW = Date.UTC(2026, 8, 21, 2);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const input: PassageEtaInput = { routeKey: {}, remainingNm: 60, cruiseKts: 6, departureMs: null, forecastOn: false };
const sample = (seconds: number, speedKts = 6, source = 'boat') => ({ at: NOW + seconds * 1_000, speedKts, source });
function fill(history: PassageSpeedHistory, seconds = 180, speedKts = 6) {
    for (let t = 0; t <= seconds; t += 15) history.observe(sample(t, speedKts), NOW + t * 1_000);
}

describe('passage ETA clock and basis', () => {
    it('uses configured cruise before observed history is ready', () => {
        expect(calculatePassageEta(input, null, NOW)).toEqual({
            arrivalMs: NOW + 10 * HOUR,
            speedKts: 6,
            basis: 'cruise',
            sampleMinutes: 0,
        });
    });
    it('uses a chosen departure and cruise even if the actual boat is stopped or moving faster', () => {
        for (const history of [
            { averageKts: 12, stopped: false, sampleMinutes: 10 },
            { averageKts: null, stopped: true, sampleMinutes: 10 },
        ]) {
            const fixed = { ...input, forecastOn: true, departureMs: NOW + 24 * HOUR };
            expect(calculatePassageEta(fixed, history, NOW).arrivalMs).toBe(NOW + 34 * HOUR);
            expect(calculatePassageEta(fixed, history, NOW + 48 * HOUR)).toMatchObject({
                arrivalMs: NOW + 34 * HOUR,
                basis: 'cruise',
                sampleMinutes: 0,
            });
        }
    });
    it('live and Leave now use the recent average, not instantaneous speed', () => {
        for (const forecastOn of [false, true])
            expect(
                calculatePassageEta(
                    { ...input, forecastOn },
                    { averageKts: 10, stopped: false, sampleMinutes: 3 },
                    NOW,
                ),
            ).toMatchObject({ arrivalMs: NOW + 6 * HOUR, speedKts: 10, basis: 'average', sampleMinutes: 3 });
    });
    it('does not project an arrival from a moving old average once stopped', () => {
        expect(calculatePassageEta(input, { averageKts: 6, stopped: true, sampleMinutes: 8 }, NOW)).toEqual({
            arrivalMs: null,
            speedKts: 0,
            basis: 'stopped',
            sampleMinutes: 8,
        });
    });
    it.each([
        { routeKey: null },
        { remainingNm: null },
        { remainingNm: -1 },
        { remainingNm: NaN },
        { cruiseKts: 0 },
        { cruiseKts: Infinity },
        { forecastOn: true, departureMs: NaN },
    ])('fails closed on unavailable route, distance, speed or clock: %o', (change) => {
        expect(calculatePassageEta({ ...input, ...change }, null, NOW).basis).toBe('unavailable');
    });
    it('rounds arrival to a minute and suppresses one-minute jitter, not material changes', () => {
        const previous = calculatePassageEta(input, null, NOW + 10_000);
        expect(previous.arrivalMs).toBe(NOW + 10 * HOUR);
        const minute = { ...previous, arrivalMs: previous.arrivalMs! + MINUTE };
        expect(stabilizePassageEta(previous, minute)).toBe(previous);
        expect(stabilizePassageEta(previous, { ...minute, arrivalMs: minute.arrivalMs + MINUTE }).arrivalMs).toBe(
            previous.arrivalMs! + 2 * MINUTE,
        );
        expect(stabilizePassageEta(previous, { ...minute, basis: 'average' }).arrivalMs).toBe(minute.arrivalMs);
    });
});

describe('bounded recent boat speed history', () => {
    it('requires three actual minutes and deduplicates source observation timestamps', () => {
        const history = new PassageSpeedHistory();
        for (let i = 0; i < 100; i++) history.observe(sample(0), NOW);
        expect(history.summary(NOW).sampleMinutes).toBe(0);
        fill(history, 165);
        expect(history.summary(NOW + 165_000).averageKts).toBeNull();
        history.observe(sample(180), NOW + 180_000);
        expect(history.summary(NOW + 180_000)).toEqual({ averageKts: 6, sampleMinutes: 3, stopped: false });
    });
    it('weights elapsed time rather than the number of samples in a minute', () => {
        const history = new PassageSpeedHistory();
        for (const t of [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 90, 120, 150, 180])
            history.observe(sample(t, t < 60 ? 6 : 12), NOW + t * 1_000);
        expect(history.summary(NOW + 180_000).averageKts).toBeCloseTo(10);
    });
    it('uses minute medians so isolated plausible GPS speed spikes cannot move the ETA', () => {
        const history = new PassageSpeedHistory();
        for (let t = 0; t <= 180; t += 15) history.observe(sample(t, t % 60 === 15 ? 60 : 6), NOW + t * 1_000);
        expect(history.summary(NOW + 180_000).averageKts).toBe(6);
    });
    it('keeps only the recent ten minutes and drops the older speed regime', () => {
        const history = new PassageSpeedHistory();
        for (let t = 0; t <= 1_200; t += 15) history.observe(sample(t, t < 600 ? 6 : 9), NOW + t * 1_000);
        expect(history.summary(NOW + 1_200_000)).toEqual({ averageKts: 9, sampleMinutes: 10, stopped: false });
    });
    it('clears the moving average on source change, unavailable feed, gaps or invalid values', () => {
        for (const next of [sample(195, 6, 'other-boat'), null, sample(240), sample(195, 1_000)]) {
            const history = new PassageSpeedHistory();
            fill(history);
            history.observe(next, next?.at ?? NOW + 195_000);
            expect(history.summary(next?.at ?? NOW + 195_000).averageKts).toBeNull();
            expect(history.summary(next?.at ?? NOW + 195_000).sampleMinutes).toBe(0);
        }
        const history = new PassageSpeedHistory();
        fill(history);
        expect(history.summary(NOW + 240_000).averageKts).toBeNull();
    });
    it('reports sustained stopping before old moving samples age out and ignores a single spike', () => {
        const history = new PassageSpeedHistory();
        fill(history);
        for (let t = 195; t <= 330; t += 15) history.observe(sample(t, t === 285 ? 8 : 0.2), NOW + t * 1_000);
        expect(history.summary(NOW + 330_000)).toMatchObject({ stopped: true, averageKts: null });
        history.observe(sample(345, 6), NOW + 345_000);
        history.observe(sample(360, 6), NOW + 360_000);
        expect(history.summary(NOW + 360_000).stopped).toBe(false);
    });
});

describe('Pi original-position motion sampling', () => {
    const point = (seconds: number, lat = -27 + (seconds / 3_600) * (6 / 60)) => ({
        at: NOW + seconds * 1_000,
        lat,
        lon: 153,
        source: 'pi:receiver:position',
    });
    it('uses original fix time and a 30–60 second position span, without stored SOG', () => {
        const history = new PassagePositionSpeed();
        expect(history.observe(point(0), NOW)).toBeNull();
        expect(history.observe(point(15), NOW + 15_000)).toBeNull();
        const first = history.observe(point(30), NOW + 30_000)!;
        expect(first.speedKts).toBeCloseTo(6, 1);
        expect(first.at).toBe(NOW + 30_000);
        expect(history.observe(point(30), NOW + 31_000)).toBe(first);
        expect(history.observe(point(45), NOW + 45_000)!.speedKts).toBeCloseTo(6, 1);
    });
    it('treats ordinary anchor scatter as stopped, not apparent slow travel', () => {
        const positions = new PassagePositionSpeed();
        const speeds = new PassageSpeedHistory();
        for (let t = 0; t <= 240; t += 15) {
            const derived = positions.observe(point(t, -27 + (t % 30 ? 0.00004 : -0.00004)), NOW + t * 1_000);
            speeds.observe(derived, NOW + t * 1_000);
        }
        expect(speeds.summary(NOW + 240_000)).toMatchObject({ stopped: true, averageKts: null });
    });
    it('rejects source changes, gaps, reversed clocks and implausible coordinate hops', () => {
        for (const next of [{ ...point(45), source: 'other' }, point(120), point(15), point(45, -20)]) {
            const history = new PassagePositionSpeed();
            for (const t of [0, 15, 30]) history.observe(point(t), NOW + t * 1_000);
            expect(history.observe(next, Math.max(next.at, NOW + 30_000))).toBeNull();
        }
    });
    it('cannot create speed from tiny intervals or duplicate-clock changed positions', () => {
        const history = new PassagePositionSpeed();
        history.observe(point(0), NOW);
        expect(history.observe(point(1), NOW + 1_000)).toBeNull();
        expect(history.observe({ ...point(0), lat: -25 }, NOW)).toBeNull();
    });
});
