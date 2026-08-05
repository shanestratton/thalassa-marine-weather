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

describe('AlertMonitorService NMEA-silence watchdog', () => {
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

    it('fires after sustained backbone silence even when NmeaStore emits no more snapshots', () => {
        const lastUpdate = Date.now();
        AlertMonitorService.start();

        expect(mocks.nmeaStart).toHaveBeenCalledOnce();
        expect(mocks.listener).toBeTypeOf('function');

        // The rule starts violating just after 60 seconds and requires three
        // consecutive watchdog evaluations before it may fire.
        vi.advanceTimersByTime(63_000);

        expect(mocks.dispatchAlert).toHaveBeenCalledOnce();
        expect(mocks.dispatchAlert).toHaveBeenCalledWith(
            expect.objectContaining({
                ruleId: 'nmea-backbone-dead',
                title: 'NMEA offline',
                firstViolatingAt: lastUpdate + 61_000,
                firedAt: lastUpdate + 63_000,
            }),
        );

        AlertMonitorService.stop();
        vi.advanceTimersByTime(700_000);
        expect(mocks.dispatchAlert).toHaveBeenCalledOnce();
    });
});
