import { act, cleanup, renderHook } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const reader = vi.hoisted(() => vi.fn());
const native = vi.hoisted(() => ({
    enabled: false,
    state: vi.fn(),
    handler: null as null | ((state: { isActive: boolean }) => void),
}));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => native.enabled } }));
vi.mock('@capacitor/app', () => ({
    App: {
        getState: native.state,
        addListener: async (_name: string, handler: (state: { isActive: boolean }) => void) => {
            native.handler = handler;
            return {
                remove: async () => {
                    native.handler = null;
                },
            };
        },
    },
}));
const vessel = vi.hoisted(() => {
    let state = { activeVesselId: 'vessel-a' };
    const listeners = new Set<(next: typeof state, previous: typeof state) => void>();
    return {
        subscribe: (fn: (next: typeof state, previous: typeof state) => void) => {
            listeners.add(fn);
            return () => {
                listeners.delete(fn);
            };
        },
        getState: () => state,
        setState: (next: typeof state) => {
            const before = state;
            state = next;
            for (const fn of listeners) fn(state, before);
        },
    };
});
vi.mock('../stores/settingsStore', () => ({ useSettingsStore: vessel }));
vi.mock('../services/routing/readOwnTrackRoute', () => ({ readOwnTrackRoute: reader }));
import { useTrackRouteRead } from '../components/map/useTrackRouteRead';
import { getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';
import { useSettingsStore } from '../stores/settingsStore';
const draft = {
    points: [
        { lat: -27, lon: 153 },
        { lat: -27.001, lon: 153 },
    ],
    inputCount: 2,
    toleranceM: 30,
    requiresChartCheck: true,
};
function pending() {
    let resolve!: (value: typeof draft) => void;
    const promise = new Promise<typeof draft>((done) => (resolve = done));
    return { promise, resolve };
}
beforeEach(() => {
    native.enabled = false;
    native.state.mockReset().mockResolvedValue({ isActive: true });
    reader.mockReset();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    setAuthIdentityScope('a');
    useSettingsStore.setState({ activeVesselId: 'vessel-a' });
});
afterEach(() => {
    cleanup();
    vi.useRealTimers();
});
describe('latest track read owns adoption only while the exact action remains current', () => {
    it('returns a complete draft to the current request', async () => {
        reader.mockResolvedValue(draft);
        const { result } = renderHook(() => useTrackRouteRead(true, 'original'), {
            wrapper: ({ children }) => <React.StrictMode>{children}</React.StrictMode>,
        });
        expect(await result.current.read('voyage', getAuthIdentityScope())).toEqual(draft);
    });
    it.each(['account', 'vessel', 'foreground', 'geometry', 'inactive', 'unmount', 'explicit'] as const)(
        'retires a late read after %s, including A/B/A transitions',
        async (kind) => {
            const held = pending();
            reader.mockReturnValue(held.promise);
            const hook = renderHook(({ active, geometry }) => useTrackRouteRead(active, geometry), {
                initialProps: { active: true, geometry: 'original' },
            });
            let operation!: ReturnType<typeof hook.result.current.read>;
            await act(async () => {
                operation = hook.result.current.read('voyage', getAuthIdentityScope());
                await Promise.resolve();
            });
            act(() => {
                if (kind === 'account') {
                    setAuthIdentityScope('b');
                    setAuthIdentityScope('a');
                }
                if (kind === 'vessel') {
                    useSettingsStore.setState({ activeVesselId: 'b' });
                    useSettingsStore.setState({ activeVesselId: 'vessel-a' });
                }
                if (kind === 'foreground') {
                    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
                    document.dispatchEvent(new Event('visibilitychange'));
                    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
                }
                if (kind === 'geometry') hook.rerender({ active: true, geometry: 'other' });
                if (kind === 'inactive') hook.rerender({ active: false, geometry: 'original' });
                if (kind === 'unmount') hook.unmount();
                if (kind === 'explicit') hook.result.current.cancel();
            });
            held.resolve(draft);
            await expect(operation).resolves.toBeNull();
        },
    );
    it('a second click supersedes the first without the late first clearing its controller', async () => {
        const first = pending(),
            second = pending();
        reader.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
        const { result } = renderHook(() => useTrackRouteRead(true, 'original'));
        let a!: ReturnType<typeof result.current.read>, b!: ReturnType<typeof result.current.read>;
        await act(async () => {
            a = result.current.read('a');
            await Promise.resolve();
        });
        await act(async () => {
            b = result.current.read('b');
            await Promise.resolve();
        });
        first.resolve(draft);
        await expect(a).resolves.toBeNull();
        second.resolve(draft);
        await expect(b).resolves.toEqual(draft);
    });
    it('settles the twenty-second deadline even if an adapter ignores AbortSignal', async () => {
        vi.useFakeTimers();
        reader.mockReturnValue(new Promise(() => {}));
        const { result } = renderHook(() => useTrackRouteRead(true, 'original'));
        let operation!: ReturnType<typeof result.current.read>;
        await act(async () => {
            operation = result.current.read('voyage');
            await Promise.resolve();
        });
        const assertion = expect(operation).rejects.toThrow('timed out');
        await act(async () => {
            await vi.advanceTimersByTimeAsync(20_000);
        });
        await assertion;
    });
    it('native background retires the read even before document visibility catches up', async () => {
        native.enabled = true;
        const held = pending();
        reader.mockReturnValue(held.promise);
        const { result } = renderHook(() => useTrackRouteRead(true, 'original'));
        await act(async () => {
            await Promise.resolve();
        });
        let operation!: ReturnType<typeof result.current.read>;
        await act(async () => {
            operation = result.current.read('voyage');
            await Promise.resolve();
        });
        act(() => native.handler!({ isActive: false }));
        held.resolve(draft);
        await expect(operation).resolves.toBeNull();
    });
});
