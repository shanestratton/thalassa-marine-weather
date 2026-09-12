import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GpsPosition } from '../services/GpsService';
import type { RadioPositionFix, RadioPositionSource } from '../services/radioPosition';

const reads = vi.hoisted(() => ({
    bus: vi.fn(),
    pi: vi.fn(),
    cloud: vi.fn(),
    passivePhone: vi.fn(),
    explicitPhone: vi.fn(),
}));

vi.mock('../services/NmeaStore', () => ({ NmeaStore: { getState: vi.fn() } }));
vi.mock('../stores/settingsStore', async () => {
    const { create } = await import('zustand');
    return { useSettingsStore: create(() => ({ activeVesselId: 'boat-a' })) };
});
vi.mock('../services/radioPosition', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../services/radioPosition')>()),
    createRadioBusReader: () => ({ read: reads.bus, dispose: vi.fn() }),
    readRadioPiPosition: reads.pi,
    readRadioCloudPosition: reads.cloud,
}));
vi.mock('../services/GpsService', () => ({
    GpsService: {
        getCurrentPositionIfGranted: reads.passivePhone,
        requestCurrentForegroundPosition: reads.explicitPhone,
    },
}));

import {
    RADIO_BOAT_READ_TIMEOUT_MS,
    RADIO_PHONE_READ_TIMEOUT_MS,
    RADIO_POSITION_POLL_MS,
    useRadioPosition,
} from '../hooks/useRadioPosition';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import { useSettingsStore } from '../stores/settingsStore';

const T0 = Date.parse('2026-09-11T01:00:00Z');
const fix = (source: RadioPositionSource = 'bus', changes: Partial<RadioPositionFix> = {}): RadioPositionFix => ({
    latitude: -27.2,
    longitude: 153.1,
    timestamp: Date.now(),
    source,
    sourceLabel: 'Untrusted source label',
    isVessel: source !== 'phone',
    vesselId: source === 'cloud' ? 'boat-a' : null,
    receiverKey: `${source}:test`,
    speed: null,
    heading: null,
    accuracy: null,
    ...changes,
});
const phoneFix = (changes: Partial<GpsPosition> = {}): GpsPosition => ({
    latitude: -26.5,
    longitude: 153.2,
    timestamp: Date.now(),
    speed: 2,
    heading: 90,
    accuracy: 8,
    altitude: null,
    ...changes,
});
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((finish) => {
        resolve = finish;
    });
    return { promise, resolve };
}
const advance = async (milliseconds = 0) => {
    await act(async () => {
        await vi.advanceTimersByTimeAsync(milliseconds);
    });
};

beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    setAuthIdentityScope('radio-account-a');
    useSettingsStore.setState({ activeVesselId: 'boat-a' });
    reads.bus.mockReturnValue(null);
    reads.pi.mockResolvedValue(null);
    reads.cloud.mockResolvedValue(null);
    reads.passivePhone.mockResolvedValue(null);
    reads.explicitPhone.mockResolvedValue(null);
});
afterEach(() => {
    cleanup();
    setAuthIdentityScope(null);
    vi.useRealTimers();
});

describe('Radio Console position acquisition', () => {
    it('uses a proven bus fix immediately without asking the phone or starting tracking', async () => {
        reads.bus.mockReturnValue(fix());
        const { result } = renderHook(useRadioPosition);
        await advance();

        expect(result.current).toMatchObject({
            position: { source: 'bus', sourceLabel: 'Boat GPS', isVessel: true, timestamp: T0 },
            ageMs: 0,
            isLive: true,
            isFresh: true,
            acquiring: false,
            refreshing: false,
            error: false,
        });
        expect(reads.pi).not.toHaveBeenCalled();
        expect(reads.cloud).not.toHaveBeenCalled();
        expect(reads.passivePhone).not.toHaveBeenCalled();
        expect(reads.explicitPhone).not.toHaveBeenCalled();
    });

    it('prefers a Pi fix to cloud and phone', async () => {
        reads.pi.mockResolvedValue(fix('pi'));
        const { result } = renderHook(useRadioPosition);
        await advance();

        expect(result.current.position).toMatchObject({ source: 'pi', sourceLabel: 'Boat GPS (via Pi)' });
        expect(reads.cloud).not.toHaveBeenCalled();
        expect(reads.passivePhone).not.toHaveBeenCalled();
    });

    it('never calls a cloud observation LIVE, including one observed just now', async () => {
        reads.cloud.mockResolvedValue(fix('cloud'));
        const { result } = renderHook(useRadioPosition);
        await advance();

        expect(result.current).toMatchObject({
            position: { source: 'cloud', sourceLabel: 'Boat GPS (via cloud)', isVessel: true },
            isFresh: true,
            isLive: false,
        });
        expect(reads.passivePhone).not.toHaveBeenCalled();
    });

    it('labels the already-granted phone fallback as a device position, never the vessel', async () => {
        reads.passivePhone.mockResolvedValue(phoneFix());
        const { result } = renderHook(useRadioPosition);
        await advance();

        expect(result.current.position).toMatchObject({ source: 'phone', sourceLabel: 'Phone GPS', isVessel: false });
        expect(reads.explicitPhone).not.toHaveBeenCalled();
    });

    it('retains the boat coordinates and immediately drops LIVE/fresh after a transient failure', async () => {
        reads.bus.mockReturnValueOnce(fix());
        const { result } = renderHook(useRadioPosition);
        await advance();
        reads.passivePhone.mockImplementation(async () => phoneFix());

        await advance(RADIO_POSITION_POLL_MS);
        expect(result.current).toMatchObject({
            position: { latitude: -27.2, longitude: 153.1, timestamp: T0, source: 'bus' },
            ageMs: RADIO_POSITION_POLL_MS,
            isLive: false,
            isFresh: false,
            acquiring: false,
            error: true,
        });
        expect(reads.passivePhone).not.toHaveBeenCalled();
        await act(async () => result.current.requestGpsAccess());
        expect(reads.explicitPhone).not.toHaveBeenCalled();
        expect(result.current.position?.source).toBe('bus');
    });

    it('holds the phone fix during an acquisition miss instead of returning to the empty acquiring screen', async () => {
        reads.passivePhone.mockResolvedValueOnce(phoneFix());
        const { result } = renderHook(useRadioPosition);
        await advance();
        await advance(RADIO_POSITION_POLL_MS);

        expect(result.current).toMatchObject({
            position: { source: 'phone', timestamp: T0 },
            acquiring: false,
            isLive: false,
            isFresh: false,
            error: true,
        });
    });

    it('requires a newer observation to recover from a failed read', async () => {
        reads.bus.mockReturnValueOnce(fix());
        const { result } = renderHook(useRadioPosition);
        await advance();
        await advance(RADIO_POSITION_POLL_MS);
        reads.bus.mockReturnValue(fix('bus', { timestamp: T0 }));
        await act(async () => result.current.refresh());
        expect(result.current.error).toBe(true);
        expect(result.current.isLive).toBe(false);
        expect(result.current.position?.timestamp).toBe(T0);

        reads.bus.mockReturnValue(fix());
        await act(async () => result.current.refresh());
        expect(result.current.error).toBe(false);
        expect(result.current.isLive).toBe(true);
        expect(result.current.position?.timestamp).toBe(T0 + RADIO_POSITION_POLL_MS);
    });

    it('lets a valid vessel receiver supersede a newer phone observation', async () => {
        reads.passivePhone.mockResolvedValueOnce(phoneFix());
        const { result } = renderHook(useRadioPosition);
        await advance();
        reads.bus.mockReturnValue(fix('bus', { timestamp: T0 - 1_000 }));
        await act(async () => result.current.refresh());

        expect(result.current.position).toMatchObject({ source: 'bus', timestamp: T0 - 1_000, isVessel: true });
    });

    it('does not replace a newer boat observation with an older response from another lane', async () => {
        reads.bus.mockReturnValueOnce(fix());
        const { result } = renderHook(useRadioPosition);
        await advance();
        reads.pi.mockResolvedValue(fix('pi', { timestamp: T0 - 1_000, latitude: -20 }));
        await act(async () => result.current.refresh());

        expect(result.current.position).toMatchObject({ source: 'bus', timestamp: T0, latitude: -27.2 });
        expect(result.current.isLive).toBe(false);
    });

    it('ages a cached observation past ten seconds without freshening it on every successful poll', async () => {
        reads.bus.mockReturnValue(fix());
        const { result } = renderHook(useRadioPosition);
        await advance();
        await advance(10_000);
        expect(result.current.isLive).toBe(true);
        await advance(1_000);
        expect(result.current).toMatchObject({ ageMs: 11_000, isLive: false, isFresh: false });
        expect(result.current.position?.timestamp).toBe(T0);
    });

    it('does not overlap polling or refresh calls while a foreground request is pending', async () => {
        const pending = deferred<GpsPosition | null>();
        reads.passivePhone.mockReturnValue(pending.promise);
        const { result } = renderHook(useRadioPosition);
        await advance();
        let first!: Promise<void>;
        let second!: Promise<void>;
        act(() => {
            first = result.current.refresh();
            second = result.current.refresh();
        });
        expect(first).toBe(second);
        await advance(7_999);
        expect(reads.passivePhone).toHaveBeenCalledOnce();
        expect(result.current.acquiring).toBe(true);

        pending.resolve(phoneFix());
        await advance();
        await first;
        expect(result.current.acquiring).toBe(false);
        await advance(RADIO_POSITION_POLL_MS - 1);
        expect(reads.passivePhone).toHaveBeenCalledOnce();
    });

    it('bounds a hung native request and does not stack another native request after its deadline', async () => {
        reads.passivePhone.mockReturnValue(new Promise(() => {}));
        const { result, unmount } = renderHook(useRadioPosition);
        await advance(RADIO_PHONE_READ_TIMEOUT_MS);

        expect(result.current).toMatchObject({ position: null, acquiring: false, refreshing: false, error: true });
        await advance(3 * RADIO_POSITION_POLL_MS);
        expect(reads.passivePhone).toHaveBeenCalledOnce();
        unmount();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('times out a boat lane without accepting its late result or accumulating more reads', async () => {
        const pendingPi = deferred<RadioPositionFix | null>();
        reads.pi.mockReturnValue(pendingPi.promise);
        reads.passivePhone.mockImplementation(async () => phoneFix());
        const { result } = renderHook(useRadioPosition);
        await advance(RADIO_BOAT_READ_TIMEOUT_MS);
        expect(result.current.position?.source).toBe('phone');

        await advance(RADIO_POSITION_POLL_MS);
        expect(reads.pi).toHaveBeenCalledOnce();
        const phoneTimestamp = result.current.position?.timestamp;
        pendingPi.resolve(fix('pi', { latitude: -20 }));
        await advance();
        expect(result.current.position).toMatchObject({ source: 'phone', timestamp: phoneTimestamp });
    });

    it('queues one explicit permission action behind the existing passive request', async () => {
        const pending = deferred<GpsPosition | null>();
        reads.passivePhone.mockReturnValue(pending.promise);
        reads.explicitPhone.mockImplementation(async () => phoneFix());
        const { result } = renderHook(useRadioPosition);
        await advance();
        let first!: Promise<void>;
        let repeated!: Promise<void>;
        act(() => {
            first = result.current.requestGpsAccess();
            repeated = result.current.requestGpsAccess();
        });
        expect(first).toBe(repeated);
        expect(reads.explicitPhone).not.toHaveBeenCalled();
        pending.resolve(null);
        await advance();
        await first;

        expect(reads.explicitPhone).toHaveBeenCalledOnce();
        expect(reads.passivePhone).toHaveBeenCalledOnce();
        expect(result.current.position?.source).toBe('phone');
    });

    it('fences account changes and ignores an earlier account’s late boat response', async () => {
        const previous = deferred<RadioPositionFix | null>();
        reads.pi.mockReturnValueOnce(previous.promise).mockResolvedValueOnce(fix('pi', { latitude: -18 }));
        const { result } = renderHook(useRadioPosition);
        await advance();
        act(() => {
            setAuthIdentityScope('radio-account-b');
        });
        expect(result.current.position).toBeNull();
        await advance();
        expect(result.current.position?.latitude).toBe(-18);

        previous.resolve(fix('pi', { latitude: -35 }));
        await advance();
        expect(result.current.position?.latitude).toBe(-18);
        expect(reads.passivePhone).not.toHaveBeenCalled();
    });

    it('clears a held vessel fix when the account changes', async () => {
        reads.bus.mockReturnValueOnce(fix());
        const { result } = renderHook(useRadioPosition);
        await advance();
        expect(result.current.position?.isVessel).toBe(true);

        act(() => {
            setAuthIdentityScope('radio-account-b');
        });
        expect(result.current.position).toBeNull();
        await advance();
        expect(result.current.position).toBeNull();
    });

    it('clears retained coordinates synchronously when another pane selects a different vessel', async () => {
        reads.cloud.mockResolvedValueOnce(fix('cloud', { vesselId: 'boat-a' }));
        const { result } = renderHook(useRadioPosition);
        await advance();
        expect(result.current.position?.vesselId).toBe('boat-a');

        act(() => useSettingsStore.setState({ activeVesselId: 'boat-b' }));
        expect(result.current.position).toBeNull();
        await advance();
        expect(result.current.position).toBeNull();
        expect(reads.cloud).toHaveBeenLastCalledWith(expect.any(AbortSignal), 'boat-b');
    });

    it('fences pending reads against vessel changes within the same account', async () => {
        const previous = deferred<RadioPositionFix | null>();
        reads.cloud
            .mockReturnValueOnce(previous.promise)
            .mockResolvedValueOnce(fix('cloud', { vesselId: 'boat-b', latitude: -18 }));
        const { result } = renderHook(useRadioPosition);
        await advance();
        act(() => useSettingsStore.setState({ activeVesselId: 'boat-b' }));
        await advance();
        expect(result.current.position).toMatchObject({ vesselId: 'boat-b', latitude: -18 });

        previous.resolve(fix('cloud', { vesselId: 'boat-a', latitude: -35 }));
        await advance();
        expect(result.current.position).toMatchObject({ vesselId: 'boat-b', latitude: -18 });
    });

    it('refuses cloud coordinates for a different or unselected vessel', async () => {
        reads.cloud.mockResolvedValue(fix('cloud', { vesselId: 'boat-b' }));
        const { result } = renderHook(useRadioPosition);
        await advance();
        expect(result.current.position).toBeNull();

        act(() => useSettingsStore.setState({ activeVesselId: null }));
        await advance();
        expect(result.current.position).toBeNull();
    });

    it('cancels all timers and prevents later fallback or permission prompts after unmount', async () => {
        const pending = deferred<RadioPositionFix | null>();
        reads.pi.mockReturnValue(pending.promise);
        const { result, unmount } = renderHook(useRadioPosition);
        await advance();
        let request!: Promise<void>;
        act(() => {
            request = result.current.requestGpsAccess();
        });
        unmount();
        expect(vi.getTimerCount()).toBe(0);
        pending.resolve(null);
        await advance();
        await request;
        expect(reads.cloud).not.toHaveBeenCalled();
        expect(reads.passivePhone).not.toHaveBeenCalled();
        expect(reads.explicitPhone).not.toHaveBeenCalled();
    });

    it.each([
        { latitude: Number.NaN },
        { latitude: 91 },
        { longitude: -181 },
        { timestamp: 0 },
        { timestamp: T0 + 1 },
        { source: 'device' as RadioPositionSource },
    ])('rejects invalid fix data without inventing a replacement: %o', async (invalid) => {
        reads.bus.mockReturnValue(fix('bus', invalid));
        const { result } = renderHook(useRadioPosition);
        await advance();
        expect(result.current).toMatchObject({ position: null, isLive: false, isFresh: false, error: true });
    });

    it('keeps missing and invalid movement readings absent rather than inventing zero', async () => {
        reads.bus.mockReturnValue(fix('bus', { speed: -1, heading: 400, accuracy: Number.NaN }));
        const { result } = renderHook(useRadioPosition);
        await advance();
        expect(result.current.position).toMatchObject({ speed: null, heading: null, accuracy: null });
    });

    it('preserves receiver identity so the UI can reset confirmation on a physical receiver change', async () => {
        reads.pi.mockResolvedValueOnce(fix('pi', { receiverKey: 'pi:receiver-a' }));
        const { result } = renderHook(useRadioPosition);
        await advance();
        expect(result.current.position).toMatchObject({ receiverKey: 'pi:receiver-a', vesselId: null });

        // Distinct 1Hz receivers can supply the same observation timestamp.
        reads.pi.mockResolvedValueOnce(fix('pi', { receiverKey: 'pi:receiver-b' }));
        await act(async () => result.current.refresh());
        expect(result.current.position).toMatchObject({ receiverKey: 'pi:receiver-b', vesselId: null });
    });
});
