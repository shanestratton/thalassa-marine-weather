/**
 * Calypso's 'nmea-backbone-dead' rule is gone (129-08): it became the aboard
 * GPS/instruments-silent alarm in the app-wide under-way watch
 * (services/underway/instrumentsSilentRule.ts, tests/InstrumentsSilentAlarm.test.ts),
 * which needs neither Calypso, nor ElevenLabs, nor the internet, and fires
 * only with the phone aboard. Calypso's monitor keeps its other rules and no
 * longer runs a clock of its own for that one, so the two can never both
 * speak for the same silence.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    state: {} as Record<string, unknown>,
    listener: null as ((state: Record<string, unknown>) => void) | null,
    nmeaStart: vi.fn(),
    unsubscribe: vi.fn(),
    dispatchAlert: vi.fn(async () => undefined),
}));

vi.mock('../services/NmeaStore', () => ({
    NmeaStore: {
        start: mocks.nmeaStart,
        subscribe: (listener: (state: Record<string, unknown>) => void) => {
            mocks.listener = listener;
            return mocks.unsubscribe;
        },
        getState: () => mocks.state,
    },
}));

vi.mock('../services/AlertNotifier', () => ({
    dispatchAlert: mocks.dispatchAlert,
}));

import { AlertMonitorService } from '../services/AlertMonitorService';

const deadMetric = () => ({ value: null, lastUpdated: 0, freshness: 'dead' as const });

function silentNmeaState(lastAnyUpdate: number): Record<string, unknown> {
    return {
        tws: deadMetric(),
        twa: deadMetric(),
        stw: deadMetric(),
        heading: deadMetric(),
        depth: deadMetric(),
        depthSource: null,
        depthReference: null,
        depthOffsetM: null,
        sog: deadMetric(),
        cog: deadMetric(),
        waterTemp: deadMetric(),
        rpm: deadMetric(),
        voltage: deadMetric(),
        latitude: deadMetric(),
        longitude: deadMetric(),
        hdop: deadMetric(),
        satellites: deadMetric(),
        gpsFixQuality: null,
        connectionStatus: 'connected',
        lastAnyUpdate,
    };
}

describe('Calypso no longer carries the backbone-silence rule', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-05T04:00:00.000Z'));
        vi.clearAllMocks();
        mocks.listener = null;
        mocks.state = silentNmeaState(Date.now());
    });

    afterEach(() => {
        AlertMonitorService.stop();
        vi.useRealTimers();
    });

    it('stays silent through ten minutes of a dead backbone: the aboard alarm owns that now', () => {
        AlertMonitorService.start();
        expect(mocks.nmeaStart).toHaveBeenCalledOnce();
        vi.advanceTimersByTime(600_000);
        mocks.listener?.(mocks.state);
        expect(mocks.dispatchAlert).not.toHaveBeenCalled();
        // No clock of its own is left running for it.
        expect(vi.getTimerCount()).toBe(0);
    });

    it('names the rule nowhere, and the under-way watch carries the alarm instead', () => {
        const monitor = readFileSync('services/AlertMonitorService.ts', 'utf8');
        expect(monitor).not.toContain('nmea-backbone-dead');
        expect(monitor).not.toContain('setInterval');
        const watch = readFileSync('services/underway/UnderwayAlarmWatch.ts', 'utf8');
        expect(watch).toContain("'instruments-watch'");
        expect(watch).toContain("'instruments-silent'");
    });
});
