/** Actual App/providers/bootstrap/registry with exact closed graph leaves and
 * fresh jsdom I/O spies. Not installation of ioFence into a real Window, native
 * Auth, SDK login, encryption, visual acceptance or physical/device evidence. */
import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import {
    requireNativePrivateMessagesForProcess,
    captureLegacyPrivateMessagePermit,
} from '../services/chat/e2ee/privateMessageCutover';
import { getAuthIdentityScope } from '../services/authIdentityScope';

describe('closed actual full App fixture mount', () => {
    it('imports behind denial, renders unavailable through actual registry and stays closed after fresh root remount', async () => {
        // Fresh owned jsdom only. Never load normal index, primary/native state,
        // or the general test setup's granted-capability/Supabase mocks.
        requireNativePrivateMessagesForProcess();
        const fetchSpy = vi.fn(async () => {
            throw new Error('Synthetic browser I/O refused');
        });
        const reject = vi.fn(() => {
            throw new Error('Synthetic browser I/O refused');
        });
        vi.stubGlobal('fetch', fetchSpy);
        window.fetch = fetchSpy;
        for (const name of ['XMLHttpRequest', 'WebSocket', 'EventSource', 'Worker', 'SharedWorker']) {
            vi.stubGlobal(name, reject);
            Object.defineProperty(window, name, { configurable: true, value: reject });
        }
        const [{ FullAppResearchRoot }, { createPrivateMessageResearchRuntime }, { useUIStore }, { useAuthStore }] =
            await Promise.all([
                import('../experiments/scuttlebutt-e2ee/full-app-pilot/FullAppResearchRoot'),
                import('../experiments/scuttlebutt-e2ee/app-pilot/runtime'),
                import('../stores/uiStore'),
                import('../stores/authStore'),
            ]);
        const nativeAttempt = vi.fn(async () => {
            throw new Error('Synthetic native I/O forbidden');
        });
        const native = new Proxy(
            {},
            {
                get() {
                    return nativeAttempt;
                },
            },
        );
        const sdkFactory = vi.fn(() => {
            throw new Error('SDK construction forbidden in unsupported fixture');
        });
        const createRuntime = vi.fn(() =>
            createPrivateMessageResearchRuntime({
                auth: { native: native as never, supported: () => false, createSdk: sdkFactory },
                native: native as never,
            }),
        );
        useUIStore.getState().setPage('chat');
        const view = render(<FullAppResearchRoot createRuntime={createRuntime} />);
        await screen.findByText(/The native private message test is unavailable/);
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 250));
        });
        expect(Object.keys(sessionStorage).filter((key) => key.startsWith('lazyRetry_'))).toEqual([]);
        expect(localStorage.getItem('thalassa_boundary_last')).toBeNull();
        expect(screen.getByText(/Account: unsupported/)).toBeInTheDocument();
        expect(useAuthStore.getState().user).toBeNull();
        expect(useAuthStore.getState().authChecked).toBe(true);
        expect(captureLegacyPrivateMessagePermit(getAuthIdentityScope())).toBeNull();
        expect(sdkFactory).not.toHaveBeenCalled();
        expect(createRuntime).toHaveBeenCalledTimes(1);
        view.unmount();
        await act(async () => {});
        useUIStore.getState().setPage('chat');
        render(<FullAppResearchRoot createRuntime={createRuntime} />);
        await screen.findByText(/The native private message test is unavailable/);
        expect(createRuntime).toHaveBeenCalledTimes(2);
        expect(useAuthStore.getState().user).toBeNull();
        expect(captureLegacyPrivateMessagePermit(getAuthIdentityScope())).toBeNull();
        expect(sdkFactory).not.toHaveBeenCalled();
        // Fixed counters describe only the supplied rejecting fixture spies.
        // They do not measure every platform/native operation or install ioFence.
        console.info(
            JSON.stringify({
                fixture: 'actual-app-unsupported-jsdom',
                fetchAttempts: fetchSpy.mock.calls.length,
                browserConstructorAttempts: reject.mock.calls.length,
                nativeProxyAttempts: nativeAttempt.mock.calls.length,
                sdkConstructions: sdkFactory.mock.calls.length,
                runtimeFactoryCalls: createRuntime.mock.calls.length,
            }),
        );
        cleanup();
        vi.unstubAllGlobals();
    });
});
