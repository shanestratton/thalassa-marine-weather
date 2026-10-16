import { describe, expect, it } from 'vitest';
import {
    advanceEngineRunCounter,
    declareEngineRunning,
    endEngineRunCounter,
    engineRunSummary,
    newEngineRunCounter,
    observeEngineRpm,
    validEngineRunCounter,
} from '../services/shiplog/engineRunCounter';

const T = 1_800_000_000_000;
describe('voyage engine time evidence', () => {
    it('keeps undeclared departure time unknown and counts exact toggle boundaries through reload', () => {
        let c = newEngineRunCounter('voyage-one', T);
        c = declareEngineRunning(c, true, T + 60_000);
        c = JSON.parse(JSON.stringify(c));
        c = declareEngineRunning(c, false, T + 3_660_000);
        c = endEngineRunCounter(c, T + 3_720_000);
        expect(engineRunSummary(c)).toEqual({
            seconds: 3600,
            loggedSeconds: 3600,
            measuredSeconds: 0,
            unknownSeconds: 60,
            clockUncertain: false,
            ended: true,
        });
        expect(c.offMs).toBe(60_000);
    });
    it('does not equate a missing or expired RPM reading with engine off', () => {
        let c = newEngineRunCounter('rpm', T);
        c = observeEngineRpm(c, 900, T, T);
        c = advanceEngineRunCounter(c, T + 60_000);
        expect(engineRunSummary(c)).toMatchObject({ seconds: 13, measuredSeconds: 13, unknownSeconds: 47 });
    });
    it('uses a measured zero only while fresh then falls back to an explicit log declaration', () => {
        let c = declareEngineRunning(newEngineRunCounter('mixed', T), true, T);
        c = observeEngineRpm(c, 0, T + 10_000, T + 10_000);
        c = endEngineRunCounter(c, T + 60_000);
        expect(engineRunSummary(c)).toMatchObject({
            seconds: 47,
            loggedSeconds: 47,
            measuredSeconds: 0,
            unknownSeconds: 0,
        });
        expect(c.offMs).toBe(13_000);
    });
    it('never extends a repeated, delayed, future, negative or nonfinite source sample', () => {
        let c = observeEngineRpm(newEngineRunCounter('invalid', T), 1000, T, T);
        c = observeEngineRpm(c, 1000, T, T + 10_000);
        c = observeEngineRpm(c, 1000, T, T + 20_000);
        c = observeEngineRpm(c, 1000, T + 40_000, T + 30_000);
        c = observeEngineRpm(c, -1, T + 35_000, T + 35_000);
        c = observeEngineRpm(c, Number.NaN, T + 39_000, T + 39_000);
        c = endEngineRunCounter(c, T + 60_000);
        expect(engineRunSummary(c)).toMatchObject({ seconds: 13, unknownSeconds: 47 });
    });
    it('counts fresh successive RPM windows once without back-filling network delays', () => {
        let c = newEngineRunCounter('measured', T);
        c = observeEngineRpm(c, 1000, T, T + 2000);
        c = observeEngineRpm(c, 1100, T + 10_000, T + 12_000);
        c = endEngineRunCounter(c, T + 30_000);
        expect(engineRunSummary(c)).toMatchObject({ seconds: 21, measuredSeconds: 21, unknownSeconds: 9 });
    });
    it('requires review after a backwards clock and never resumes invented elapsed time', () => {
        let c = declareEngineRunning(newEngineRunCounter('clock', T), true, T);
        c = advanceEngineRunCounter(c, T + 60_000);
        c = advanceEngineRunCounter(c, T - 1000);
        c = endEngineRunCounter(c, T + 120_000);
        expect(engineRunSummary(c)).toMatchObject({ seconds: 60, unknownSeconds: 60, clockUncertain: true });
    });
    it('freezes end time for duplicate stop callbacks and refuses corrupted persisted totals', () => {
        const c = endEngineRunCounter(declareEngineRunning(newEngineRunCounter('ended', T), true, T), T + 60_000);
        expect(endEngineRunCounter(c, T + 600_000)).toEqual(c);
        expect(validEngineRunCounter(c, 'other-voyage')).toBe(false);
        expect(validEngineRunCounter({ ...c, logOnMs: 3_600_000 }, 'ended')).toBe(false);
        expect(validEngineRunCounter({ ...c, rpm: { running: true, atMs: T + 600_000 } }, 'ended')).toBe(false);
    });
});
