import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NmeaStoreState } from '../services/NmeaStore';
const f = vi.hoisted(() => ({
    state: null as unknown as NmeaStoreState,
    listener: null as null | ((state: NmeaStoreState) => void),
}));
vi.mock('../services/NmeaStore', () => ({
    NmeaStore: {
        getState: () => f.state,
        subscribe: (listener: (state: NmeaStoreState) => void) => {
            f.listener = listener;
            return () => {
                f.listener = null;
            };
        },
    },
}));
import { TelemetryHistoryService as history } from '../services/TelemetryHistoryService';
import { setAuthIdentityScope } from '../services/authIdentityScope';
const NOW = 1_800_000_000_000;
function state(identity = 'fictional-a', at = NOW - 2000): NmeaStoreState {
    return {
        connectionStatus: 'remote',
        remote: { source: 'device', via: 'signalk', deviceLabel: 'Direct Signal K', reportedAt: NOW, receivedAt: NOW },
        instrumentEvidence: { identity, via: 'signalk', readings: {} },
        voltage: { value: null, lastUpdated: 0, freshness: 'dead' },
        rpm: { value: 1200, lastUpdated: at, freshness: 'live' },
        depth: { value: 3, lastUpdated: at, freshness: 'live' },
    } as NmeaStoreState;
}
beforeEach(() => {
    history.stop();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    setAuthIdentityScope('fictional-skipper');
    f.state = state();
});
afterEach(() => {
    history.stop();
    setAuthIdentityScope(null);
    vi.useRealTimers();
});
describe('source-clock telemetry history ownership', () => {
    it('records original clocks once and leaves unchanged/frozen data as a gap', () => {
        history.start();
        expect(history.getHistory('rpm', 60)).toEqual([{ t: NOW - 2000, value: 1200 }]);
        vi.setSystemTime(NOW + 1000);
        f.listener!(f.state);
        expect(history.getHistory('rpm', 60)).toHaveLength(1);
        vi.setSystemTime(NOW + 10000);
        f.listener!(f.state);
        expect(history.getHistory('depth', 60)).toEqual([{ t: NOW - 2000, value: 3 }]);
    });
    it('clears on account change synchronously while keeping the subscription alive', () => {
        history.start();
        setAuthIdentityScope('fictional-other');
        expect(history.getHistory('rpm', 60)).toEqual([]);
        expect(f.listener).not.toBeNull();
    });
    it('clears before accepting a new feed/session and resets the cadence gate', () => {
        history.start();
        f.state = state('fictional-b', NOW - 1000);
        f.state.rpm.value = 900;
        f.listener!(f.state);
        expect(history.getHistory('rpm', 60)).toEqual([{ t: NOW - 1000, value: 900 }]);
    });
    it('keeps legacy remote receipt-clock values unknown and uses explicit matching RPM when present', () => {
        f.state = state();
        f.state.remote!.via = 'lan';
        f.state.instrumentEvidence!.via = 'lan';
        history.start();
        expect(history.getHistory('rpm', 60)).toEqual([]);
        expect(history.getHistory('depth', 60)).toEqual([]);
        f.state.instrumentEvidence!.readings.rpm = {
            value: 1200,
            at: NOW - 4000,
            unit: 'rpm',
            source: 'Fictional engine',
        };
        vi.setSystemTime(NOW + 1000);
        f.listener!(f.state);
        expect(history.getHistory('rpm', 60)).toEqual([{ t: NOW - 4000, value: 1200 }]);
    });
    it('retains prior valid gateway history across a quiet gap without appending zeros', () => {
        f.state = state();
        f.state.connectionStatus = 'connected';
        f.state.remote = null;
        f.state.instrumentEvidence!.via = 'gateway';
        history.start();
        expect(history.getHistory('rpm', 60)).toHaveLength(1);
        vi.setSystemTime(NOW + 1000);
        f.state = { ...f.state, connectionStatus: 'disconnected', instrumentEvidence: undefined };
        f.listener!(f.state);
        expect(history.getHistory('rpm', 60)).toEqual([{ t: NOW - 2000, value: 1200 }]);
    });
});
