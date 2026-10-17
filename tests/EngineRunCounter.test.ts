import { describe, expect, it } from 'vitest';
import {
    advanceEngineRunCounter,
    declareEngineRunning,
    endEngineRunCounter,
    engineRunSummary,
    newEngineRunCounter,
    observeEngineRpm,
    observeEngineEvidence,
    observeQualifiedEngineRpm,
    suspendEngineRunCounter,
    validEngineRunCounter,
} from '../services/shiplog/engineRunCounter';
import type { InstrumentEvidence } from '../services/instruments/measurements';

const T = 1_800_000_000_000;
describe('voyage engine time evidence', () => {
    const evidence = (at: number, identity = 'session-one', meterIdentity = 'boat-one'): InstrumentEvidence => ({
        identity,
        meterIdentity,
        via: 'signalk',
        readings: { rpm: { value: 900, at, unit: 'rpm', source: 'engine', engineId: 'main', engineCount: 1 } },
    });
    it('retires missing feeds immediately and never resurrects their repeated source clock', () => {
        let c = observeEngineEvidence(newEngineRunCounter('retired', T), evidence(T), T);
        c = observeEngineEvidence(c, undefined, T + 2000);
        c = observeEngineEvidence(c, evidence(T), T + 4000);
        c = endEngineRunCounter(c, T + 10_000);
        expect(engineRunSummary(c)).toMatchObject({ measuredSeconds: 2, unknownSeconds: 8 });
    });
    it('requires new clocks after a same-vessel reconnect and preserves its unobserved gap', () => {
        let c = observeEngineEvidence(newEngineRunCounter('reconnect', T), evidence(T), T);
        c = observeEngineEvidence(c, undefined, T + 2000);
        c = observeEngineEvidence(c, evidence(T, 'session-two'), T + 3000);
        c = observeEngineEvidence(c, evidence(T + 6000, 'session-two'), T + 6000);
        c = endEngineRunCounter(c, T + 10_000);
        expect(engineRunSummary(c)).toMatchObject({ measuredSeconds: 6, unknownSeconds: 4 });
        expect(c.rpmSessionIdentity).toBe('session-two');
    });
    it('does not combine another vessel using the same engine name, including after reload', () => {
        let c = observeEngineEvidence(newEngineRunCounter('boat-swap', T), evidence(T), T);
        c = JSON.parse(JSON.stringify(c));
        c = observeEngineEvidence(c, evidence(T + 2000, 'foreign-session', 'boat-two'), T + 2000);
        c = endEngineRunCounter(c, T + 10_000);
        expect(engineRunSummary(c)).toMatchObject({ measuredSeconds: 2, unknownSeconds: 8 });
        expect(c.rpmFeedIdentity).toBe('boat-one');
    });
    it('keeps an independent skipper declaration when instrument evidence retires', () => {
        let c = declareEngineRunning(newEngineRunCounter('declared', T), true, T);
        c = observeEngineEvidence(c, evidence(T), T);
        c = observeEngineEvidence(c, undefined, T + 2000);
        c = endEngineRunCounter(c, T + 10_000);
        expect(engineRunSummary(c)).toMatchObject({ measuredSeconds: 2, loggedSeconds: 8, unknownSeconds: 0 });
    });
    it('refuses duplicate-clock engine conflicts and unqualified legacy RPM before binding a feed', () => {
        let c = observeEngineRpm(newEngineRunCounter('legacy', T), 900, T, T);
        c = observeEngineEvidence(c, evidence(T + 1000), T + 1000);
        const conflict = evidence(T + 1000);
        conflict.readings.rpm!.engineId = 'another';
        c = observeEngineEvidence(c, conflict, T + 2000);
        c = endEngineRunCounter(c, T + 10_000);
        expect(engineRunSummary(c)).toMatchObject({ measuredSeconds: 1, unknownSeconds: 9 });
        expect(validEngineRunCounter({ ...c, rpmLastSourceAt: T + 20_000 }, 'legacy')).toBe(false);
    });
    it('requires one identified engine and refuses to combine another engine into its maintenance meter', () => {
        const reading = (engineId: string, engineCount = 1) => ({
            value: 900,
            at: T,
            unit: 'rpm',
            engineId,
            engineCount,
        });
        let c = observeQualifiedEngineRpm(newEngineRunCounter('engines', T), reading('port', 2), T);
        c = observeQualifiedEngineRpm(c, { ...reading('port'), at: T + 10_000 }, T + 10_000);
        c = observeQualifiedEngineRpm(c, { ...reading('starboard'), at: T + 20_000 }, T + 20_000);
        c = endEngineRunCounter(c, T + 30_000);
        expect(engineRunSummary(c)).toMatchObject({ measuredSeconds: 10, unknownSeconds: 20 });
        expect(c.rpmEngineId).toBe('port');
    });
    it('never assigns an engine identity from missing metadata, future samples or legacy gauge state', () => {
        let c = observeEngineRpm(newEngineRunCounter('unqualified', T), 900, T, T);
        c = observeQualifiedEngineRpm(c, undefined, T + 1000);
        c = observeQualifiedEngineRpm(c, { value: 900, at: T + 1000, unit: 'rpm' }, T + 1000);
        c = observeQualifiedEngineRpm(
            c,
            { value: 900, at: T + 30_000, unit: 'rpm', engineId: 'port', engineCount: 1 },
            T + 2000,
        );
        c = endEngineRunCounter(c, T + 10_000);
        expect(engineRunSummary(c)).toMatchObject({ measuredSeconds: 0, unknownSeconds: 10 });
        expect(c.rpmEngineId).toBeUndefined();
    });
    it('keeps a pause or different-account interval unknown rather than carrying a declaration across it', () => {
        let c = declareEngineRunning(newEngineRunCounter('pause', T), true, T);
        c = suspendEngineRunCounter(c, T + 60_000);
        c = advanceEngineRunCounter(c, T + 660_000);
        c = declareEngineRunning(c, true, T + 720_000);
        c = endEngineRunCounter(c, T + 780_000);
        expect(engineRunSummary(c)).toMatchObject({ seconds: 120, unknownSeconds: 660 });
    });
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
