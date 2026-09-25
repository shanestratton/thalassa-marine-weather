import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrackingState } from '../services/shiplog/TrackingStateStore';

const recorder = vi.hoisted(() => ({
    state: { isTracking: false, isPaused: false, isRapidMode: false } as TrackingState,
    listeners: new Set<() => void>(),
    initialize: vi.fn(),
    startTracking: vi.fn(),
}));
vi.mock('../services/ShipLogService', () => ({
    ShipLogService: {
        getPublishedTrackingStatus: () => ({ ...recorder.state }),
        onTrackingStateChange: (listener: () => void) => {
            recorder.listeners.add(listener);
            listener();
            return () => recorder.listeners.delete(listener);
        },
        initialize: recorder.initialize,
        startTracking: recorder.startTracking,
    },
}));

import { useHudRecording, useHudRecordingActivation } from '../hooks/useHudRecording';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import {
    __resetPassageHudForTests,
    getPassageHudActivation,
    getPassageLookAhead,
    isPassageHudEnabled,
    isPassageHudOpen,
    setPassageHudEnabled,
    setPassageHudOpen,
    startPassageLookAhead,
} from '../stores/passageHudStore';
import { __resetPassageOverlayForTests, isPassageOverlayOn, setPassageOverlay } from '../stores/chartPassageOverlay';

function publish(state: Partial<TrackingState>) {
    recorder.state = { isTracking: false, isPaused: false, isRapidMode: false, ...state };
    recorder.listeners.forEach((listener) => listener());
}

beforeEach(() => {
    localStorage.clear();
    setAuthIdentityScope('hud-skipper');
    __resetPassageHudForTests();
    __resetPassageOverlayForTests();
    recorder.state = { isTracking: false, isPaused: false, isRapidMode: false };
    recorder.initialize.mockClear();
    recorder.startTracking.mockClear();
});
afterEach(cleanup);

describe('HUD recording subscription', () => {
    it('observes current recording, pause and stop without acquiring GPS', () => {
        const { result, unmount } = renderHook(useHudRecording);
        expect(result.current).toEqual(recorder.state);
        act(() => publish({ isTracking: true, currentVoyageId: 'recording-a' }));
        expect(result.current.currentVoyageId).toBe('recording-a');
        act(() => publish({ isPaused: true, currentVoyageId: 'recording-a' }));
        expect(result.current.isPaused).toBe(true);
        act(() => publish({}));
        expect(result.current.currentVoyageId).toBeUndefined();
        expect(recorder.initialize).not.toHaveBeenCalled();
        expect(recorder.startTracking).not.toHaveBeenCalled();
        unmount();
        expect(recorder.listeners.size).toBe(0);
    });

    it('rejects old-identity listener work after a switch', () => {
        publish({ isTracking: true, currentVoyageId: 'recording-a' });
        const { result } = renderHook(useHudRecording);
        const staleListener = [...recorder.listeners][0];
        act(() => {
            recorder.state = { isTracking: false, isPaused: false, isRapidMode: false };
            setAuthIdentityScope('other-hud-skipper');
        });
        expect(result.current.currentVoyageId).toBeUndefined();
        act(() => {
            recorder.state = { isTracking: true, isPaused: false, isRapidMode: false, currentVoyageId: 'old-result' };
            staleListener();
        });
        expect(result.current.currentVoyageId).toBeUndefined();
        act(() => publish({ isTracking: true, currentVoyageId: 'recording-b' }));
        expect(result.current.currentVoyageId).toBe('recording-b');
    });
});

describe('automatic recording HUD activation', () => {
    it('keeps idle and failed starts clean, then opens LIVE instruments and passage for route-free recording', () => {
        renderHook(useHudRecordingActivation);
        expect(isPassageHudEnabled()).toBe(false);
        expect(isPassageOverlayOn()).toBe(false);
        act(() => publish({ currentVoyageId: 'failed-start' }));
        expect(isPassageHudEnabled()).toBe(false);
        act(() => {
            startPassageLookAhead();
            publish({ isTracking: true, currentVoyageId: 'just-recording' });
        });
        expect(isPassageHudEnabled()).toBe(true);
        expect(isPassageHudOpen()).toBe(true);
        expect(isPassageOverlayOn()).toBe(true);
        expect(getPassageLookAhead().on).toBe(false);
    });

    it('activates an already running recording on app entry, then respects Hide and Off across resume and remount', () => {
        publish({ isTracking: true, currentVoyageId: 'recording-a' });
        const first = renderHook(useHudRecordingActivation);
        const activation = getPassageHudActivation();
        expect(isPassageHudOpen()).toBe(true);
        act(() => setPassageHudOpen(false));
        act(() => publish({ isPaused: true, currentVoyageId: 'recording-a' }));
        act(() => publish({ isTracking: true, currentVoyageId: 'recording-a' }));
        expect(isPassageHudOpen()).toBe(false);
        expect(getPassageHudActivation()).toBe(activation);
        act(() => {
            setPassageHudEnabled(false);
            setPassageOverlay(false);
        });
        first.unmount();
        renderHook(useHudRecordingActivation);
        expect(isPassageHudEnabled()).toBe(false);
        expect(isPassageOverlayOn()).toBe(false);
        act(() => publish({ isTracking: true, currentVoyageId: 'recording-b' }));
        expect(isPassageHudEnabled()).toBe(true);
        expect(isPassageHudOpen()).toBe(true);
        expect(getPassageHudActivation()).toBe(activation + 1);
    });

    it('starts a new recording LIVE even when the previous HUD was still enabled', () => {
        renderHook(useHudRecordingActivation);
        act(() => publish({ isTracking: true, currentVoyageId: 'recording-a' }));
        const activation = getPassageHudActivation();
        act(() => startPassageLookAhead());
        act(() => publish({ isTracking: true, currentVoyageId: 'recording-b' }));
        expect(getPassageLookAhead().on).toBe(false);
        expect(getPassageHudActivation()).toBe(activation + 1);
    });

    it('clears account-owned HUD and forecast, and allows the next account recording to activate', () => {
        renderHook(useHudRecordingActivation);
        act(() => publish({ isTracking: true, currentVoyageId: 'recording-a' }));
        act(() => startPassageLookAhead());
        act(() => {
            recorder.state = { isTracking: false, isPaused: false, isRapidMode: false };
            setAuthIdentityScope('other-hud-skipper');
        });
        expect(isPassageHudEnabled()).toBe(false);
        expect(isPassageHudOpen()).toBe(false);
        expect(isPassageOverlayOn()).toBe(false);
        expect(getPassageLookAhead().on).toBe(false);
        act(() => publish({ isTracking: true, currentVoyageId: 'recording-a' }));
        expect(isPassageHudEnabled()).toBe(true);
        act(() => {
            recorder.state = { isTracking: false, isPaused: false, isRapidMode: false };
            setAuthIdentityScope('hud-skipper');
        });
        expect(isPassageHudEnabled()).toBe(false);
        act(() => publish({ isTracking: true, currentVoyageId: 'recording-a' }));
        expect(isPassageHudEnabled()).toBe(true);
        expect(isPassageHudOpen()).toBe(true);
    });
});
