import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NmeaStoreState, TimestampedMetric } from '../services/NmeaStore';
import type { PassageEtaInput } from '../services/passageEta';
import { passageEtaBoatObservation, passageEtaLanPosition, usePassageEta } from '../hooks/usePassageEta';

const feeds = vi.hoisted(() => ({
    state: {} as NmeaStoreState,
    boat: true,
    endpoint: { host: 'gateway', port: 1456, deviceId: 'receiver-a' },
    identity: { key: 'user:a', generation: 0 },
    authListeners: new Set<() => void>(),
    nmeaListeners: new Set<(state: NmeaStoreState) => void>(),
}));
vi.mock('../services/NmeaStore', () => ({
    NmeaStore: {
        getState: () => feeds.state,
        isBoatFeed: () => feeds.boat,
        subscribe: (callback: (state: NmeaStoreState) => void) => {
            feeds.nmeaListeners.add(callback);
            return () => feeds.nmeaListeners.delete(callback);
        },
    },
    getNmeaFreshness: (at: number, now: number) =>
        !Number.isFinite(at) || at <= 0 || at > now + 1_000 || now - at > 13_000
            ? 'dead'
            : now - at > 6_500
              ? 'stale'
              : 'live',
}));
vi.mock('../services/NmeaListenerService', () => ({
    NmeaListenerService: { getConnectionInfo: () => feeds.endpoint },
}));
vi.mock('../services/authIdentityScope', () => ({
    getAuthIdentityScope: () => feeds.identity,
    subscribeAuthIdentityScope: (callback: () => void) => {
        feeds.authListeners.add(callback);
        return () => feeds.authListeners.delete(callback);
    },
}));

const NOW = Date.UTC(2026, 8, 21, 2);
const HOUR = 3_600_000;
const route = {};
const input: PassageEtaInput = { routeKey: route, remainingNm: 60, cruiseKts: 6, departureMs: null, forecastOn: false };
const metric = (value: number, at = Date.now()): TimestampedMetric => ({ value, lastUpdated: at, freshness: 'live' });
function direct(speed = 9, at = Date.now()) {
    feeds.state.connectionStatus = 'connected';
    feeds.state.remote = null;
    feeds.state.gpsSource = 'NMEA gateway';
    feeds.state.sog = metric(speed, at);
}
function lan(at = Date.now(), speed = 9) {
    const seconds = (at - NOW) / 1_000;
    feeds.state.connectionStatus = 'remote';
    feeds.state.remote = {
        source: 'pi',
        via: 'lan',
        deviceLabel: 'boat-pi',
        positionSampleAt: at,
        reportedAt: at,
        receivedAt: at,
    };
    feeds.state.gpsSource = 'nmea.receiver-a';
    feeds.state.latitude = metric(-27 + (seconds / 3_600) * (speed / 60), at);
    feeds.state.longitude = metric(153, at);
    feeds.state.sog = metric(40, at); // Deliberately unrelated cached wire SOG.
}
function advanceDirect(ticks: number, speed = 9) {
    for (let i = 0; i < ticks; i++) {
        direct(speed, Date.now() + 15_000);
        act(() => vi.advanceTimersByTime(15_000));
    }
}
function advanceLan(ticks: number, speed = 9) {
    for (let i = 0; i < ticks; i++) {
        lan(Date.now() + 15_000, speed);
        act(() => vi.advanceTimersByTime(15_000));
    }
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    feeds.boat = true;
    feeds.endpoint = { host: 'gateway', port: 1456, deviceId: 'receiver-a' };
    feeds.identity = { key: 'user:a', generation: 0 };
    feeds.state = {} as NmeaStoreState;
    direct();
});
afterEach(() => {
    cleanup();
    feeds.authListeners.clear();
    feeds.nmeaListeners.clear();
    vi.useRealTimers();
});

describe('ETA observations cannot substitute receipt time or another feed', () => {
    it('accepts fresh direct boat SOG with its observation time', () => {
        expect(passageEtaBoatObservation(feeds.state, true, 'receiver-a', NOW)).toEqual({
            at: NOW,
            speedKts: 9,
            source: 'receiver-a',
        });
        expect(passageEtaBoatObservation(feeds.state, false, 'phone', NOW)).toBeNull();
        expect(passageEtaBoatObservation(feeds.state, true, 'receiver-a', NOW + 7_000)).toBeNull();
    });
    it('never treats LAN or cloud receipt-stamped SOG as a source observation', () => {
        lan();
        expect(passageEtaBoatObservation(feeds.state, true, 'pi', NOW)).toBeNull();
        feeds.state.remote!.via = 'cloud';
        expect(passageEtaBoatObservation(feeds.state, true, 'pi', NOW)).toBeNull();
        expect(passageEtaLanPosition(feeds.state, true, 'pi', NOW)).toBeNull();
    });
    it('requires actual Pi LAN position source time and paired coordinates, never fresh ZDA alone', () => {
        lan();
        expect(passageEtaLanPosition(feeds.state, true, 'pi', NOW)?.at).toBe(NOW);
        feeds.state.remote!.positionSampleAt = NOW - 60_000;
        expect(passageEtaLanPosition(feeds.state, true, 'pi', NOW)).toBeNull();
        delete feeds.state.remote!.positionSampleAt;
        expect(passageEtaLanPosition(feeds.state, true, 'pi', NOW)).toBeNull();
        lan();
        feeds.state.latitude.lastUpdated -= 5_000;
        expect(passageEtaLanPosition(feeds.state, true, 'pi', NOW)).toBeNull();
        lan();
        feeds.state.remote!.source = 'device';
        expect(passageEtaLanPosition(feeds.state, true, 'pi', NOW)).toBeNull();
    });
});

describe('stable passage ETA hook', () => {
    it('warms up with cruise, then uses three minutes of fresh boat observations', () => {
        const { result } = renderHook(() => usePassageEta(input));
        expect(result.current).toMatchObject({ basis: 'cruise', arrivalMs: NOW + 10 * HOUR });
        advanceDirect(11);
        expect(result.current.basis).toBe('cruise');
        advanceDirect(1);
        expect(result.current).toMatchObject({ basis: 'average', speedKts: 9, sampleMinutes: 3 });
    });
    it('computes Pi average from original timed positions, never its misleading cached SOG', () => {
        lan();
        const { result } = renderHook(() => usePassageEta(input));
        advanceLan(13);
        expect(result.current.basis).toBe('cruise');
        advanceLan(1);
        expect(result.current).toMatchObject({ basis: 'average', speedKts: 9, sampleMinutes: 3 });
    });
    it('does not repaint each GPS distance or speed change; normal updates wait a minute', () => {
        const { result, rerender } = renderHook((props: PassageEtaInput) => usePassageEta(props), {
            initialProps: input,
        });
        const first = result.current;
        rerender({ ...input, remainingNm: 59.99 });
        advanceDirect(1);
        expect(result.current).toBe(first);
        rerender({ ...input, remainingNm: 59.9 });
        advanceDirect(2);
        expect(result.current).toBe(first);
        advanceDirect(1);
        expect(result.current.arrivalMs).toBe(first.arrivalMs);
    });
    it.each([null, NaN, -1])(
        'immediately hides ETA when distance becomes %s and warms up anew on recovery',
        (remainingNm) => {
            const { result, rerender } = renderHook((props: PassageEtaInput) => usePassageEta(props), {
                initialProps: input,
            });
            advanceDirect(12);
            expect(result.current.basis).toBe('average');
            const clock = Date.now();
            rerender({ ...input, remainingNm });
            expect(result.current).toMatchObject({ basis: 'unavailable', arrivalMs: null, sampleMinutes: 0 });
            expect(Date.now()).toBe(clock);
            advanceDirect(12);
            expect(result.current.basis).toBe('unavailable');
            rerender({ ...input, remainingNm: 55 });
            expect(result.current).toMatchObject({ basis: 'cruise', speedKts: 6, sampleMinutes: 0 });
        },
    );
    it('does not repaint or manufacture samples from ordinary instrument updates', () => {
        const { result } = renderHook(() => usePassageEta(input));
        const initial = result.current;
        for (let i = 1; i <= 10; i++) {
            act(() => {
                vi.advanceTimersByTime(1_000);
                direct(9 + i / 10);
                feeds.nmeaListeners.forEach((callback) => callback(feeds.state));
            });
            expect(result.current).toBe(initial);
        }
        expect(result.current.sampleMinutes).toBe(0);
    });
    it.each(['stale', 'cloud', 'receiver'])(
        'immediately drops learned speed on a %s health notification, without waiting for the poll',
        (reason) => {
            const { result } = renderHook(() => usePassageEta(input));
            advanceDirect(12);
            expect(result.current.basis).toBe('average');
            act(() => {
                if (reason === 'stale') feeds.state.sog.freshness = 'stale';
                if (reason === 'cloud') {
                    lan();
                    feeds.state.remote!.via = 'cloud';
                    feeds.boat = false;
                }
                if (reason === 'receiver') feeds.endpoint.host = 'different-gateway';
                feeds.nmeaListeners.forEach((callback) => callback(feeds.state));
            });
            expect(result.current).toMatchObject({ basis: 'cruise', speedKts: 6, sampleMinutes: 0 });
        },
    );
    it('invalidates a Pi average as soon as its position clock expires, even with a fresh receipt/ZDA', () => {
        lan();
        const { result } = renderHook(() => usePassageEta(input));
        advanceLan(14);
        expect(result.current.basis).toBe('average');
        const originalAt = feeds.state.remote!.positionSampleAt;
        act(() => {
            vi.advanceTimersByTime(7_000);
            lan();
            feeds.state.remote!.positionSampleAt = originalAt;
            feeds.nmeaListeners.forEach((callback) => callback(feeds.state));
        });
        expect(result.current).toMatchObject({ basis: 'cruise', sampleMinutes: 0 });
    });
    it('holds arrival steady as boat progress cancels elapsed wall time', () => {
        const initialProps = { ...input, cruiseKts: 9 };
        const { result, rerender } = renderHook((props: PassageEtaInput) => usePassageEta(props), { initialProps });
        const arrival = result.current.arrivalMs;
        for (let tick = 1; tick <= 20; tick++) {
            rerender({ ...initialProps, remainingNm: 60 - (9 * tick * 15) / 3_600 });
            advanceDirect(1);
            expect(result.current.arrivalMs).toBe(arrival);
        }
        expect(result.current.basis).toBe('average');
    });
    it('does not freeze rolling cruise ETA after a backward device-clock correction', () => {
        feeds.boat = false;
        const { result } = renderHook(() => usePassageEta(input));
        expect(result.current.arrivalMs).toBe(NOW + 10 * HOUR);
        act(() => {
            vi.setSystemTime(NOW - 2 * HOUR);
            vi.advanceTimersByTime(15_000);
        });
        expect(result.current).toMatchObject({ basis: 'cruise', arrivalMs: NOW + 8 * HOUR });
    });
    it('uses new departure/cruising configuration immediately and keeps scheduled ETA fixed', () => {
        const { result, rerender } = renderHook((props: PassageEtaInput) => usePassageEta(props), {
            initialProps: input,
        });
        advanceDirect(12);
        expect(result.current.basis).toBe('average');
        rerender({ ...input, forecastOn: true, departureMs: NOW + 24 * HOUR, cruiseKts: 5 });
        expect(result.current).toMatchObject({ basis: 'cruise', speedKts: 5, arrivalMs: NOW + 36 * HOUR });
        advanceDirect(8, 12);
        expect(result.current.arrivalMs).toBe(NOW + 36 * HOUR);
        rerender({ ...input, forecastOn: true });
        expect(result.current.basis).toBe('average');
    });
    it('clears learned speed when data stops, rather than keeping an old average', () => {
        const { result } = renderHook(() => usePassageEta(input));
        advanceDirect(12);
        expect(result.current.basis).toBe('average');
        act(() => vi.advanceTimersByTime(15_000));
        expect(result.current).toMatchObject({ basis: 'cruise', sampleMinutes: 0, speedKts: 6 });
    });
    it('cannot build history from repeated position timestamps with fresh receipt clocks', () => {
        lan();
        const { result } = renderHook(() => usePassageEta(input));
        for (let i = 0; i < 16; i++) {
            lan(Date.now() + 15_000);
            feeds.state.remote!.positionSampleAt = NOW;
            act(() => vi.advanceTimersByTime(15_000));
        }
        expect(result.current).toMatchObject({ basis: 'cruise', sampleMinutes: 0 });
    });
    it('drops an average on a receiver, route or account change', () => {
        const { result, rerender } = renderHook((props: PassageEtaInput) => usePassageEta(props), {
            initialProps: input,
        });
        advanceDirect(12);
        feeds.endpoint.host = 'other-gateway';
        advanceDirect(1);
        expect(result.current.basis).toBe('cruise');
        advanceDirect(12);
        expect(result.current.basis).toBe('average');
        rerender({ ...input, routeKey: {} });
        expect(result.current.basis).toBe('cruise');
        advanceDirect(12);
        expect(result.current.basis).toBe('average');
        act(() => {
            feeds.identity = { key: 'user:b', generation: 1 };
            feeds.authListeners.forEach((callback) => callback());
        });
        expect(result.current).toMatchObject({ basis: 'cruise', sampleMinutes: 0 });
    });
    it('does not project an ETA while stopped at anchor', () => {
        const { result } = renderHook(() => usePassageEta(input));
        advanceDirect(12);
        advanceDirect(9, 0.2);
        expect(result.current).toMatchObject({ basis: 'stopped', arrivalMs: null, speedKts: 0 });
        advanceDirect(24, 0.2);
        expect(result.current).toMatchObject({ basis: 'stopped', arrivalMs: null, speedKts: 0 });
    });
    it('ignores cloud feeds and releases polling/subscriptions when unmounted', () => {
        lan();
        feeds.state.remote!.via = 'cloud';
        feeds.boat = false;
        const { result, unmount } = renderHook(() => usePassageEta(input));
        act(() => vi.advanceTimersByTime(5 * 60_000));
        expect(result.current).toMatchObject({ basis: 'cruise', sampleMinutes: 0 });
        unmount();
        expect(vi.getTimerCount()).toBe(0);
        expect(feeds.authListeners.size).toBe(0);
        expect(feeds.nmeaListeners.size).toBe(0);
    });
});
