/** Real Research root/controller/port with a controlled PM leaf and synthetic
 * native/SDK replies. This tests committed DOM; it is not an OS/crypto proof. */
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrivateMessageResearchApp } from '../experiments/scuttlebutt-e2ee/app-pilot/PrivateMessageResearchApp';
import { createPrivateMessageResearchRuntime } from '../experiments/scuttlebutt-e2ee/app-pilot/runtime';
import { measureResearchClosedPresentation } from '../experiments/scuttlebutt-e2ee/bridge-web/nativeLifecycle';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import {
    createManagedResearchFixture,
    lifecycleDescriptor,
    deferred,
    EPOCH_B,
    EPOCH_C,
} from './fixtures/researchNativeLifecycle';

vi.mock('../components/LegacyChatPage', () => {
    throw new Error('Legacy page forbidden in lifecycle fixture');
});
const originalReady = Object.getOwnPropertyDescriptor(document, 'readyState');
let ready = 'complete';
const runtimes: ReturnType<typeof createPrivateMessageResearchRuntime>[] = [];
beforeEach(() => {
    ready = 'complete';
    Object.defineProperty(document, 'readyState', { configurable: true, get: () => ready });
});
afterEach(async () => {
    cleanup();
    runtimes.splice(0).forEach((runtime) => {
        runtime.admission.stop();
        runtime.auth.dispose();
    });
    setAuthIdentityScope(null);
    if (originalReady) Object.defineProperty(document, 'readyState', originalReady);
    else Reflect.deleteProperty(document, 'readyState');
    await act(async () => {
        await Promise.resolve();
    });
});
function mounted(initial = lifecycleDescriptor()) {
    const f = createManagedResearchFixture(initial);
    f.controller.dispose();
    const owned = createPrivateMessageResearchRuntime({ auth: f.dependencies, native: f.native });
    runtimes.push(owned);
    const view = render(
        <PrivateMessageResearchApp
            createRuntime={() => owned}
            renderPrivatePage={({ selection }) =>
                selection.kind === 'native-pilot' ? (
                    <div>
                        <div role="log">Synthetic private row</div>
                        <input aria-label="Message Paired sailor" defaultValue="synthetic draft" />
                    </div>
                ) : (
                    <p>Private unavailable</p>
                )
            }
        />,
    );
    return { f, owned, view };
}
async function signInAndOpen() {
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign in and verify' })).toBeEnabled());
    fireEvent.change(screen.getByLabelText('Test account email'), { target: { value: 'a@fixture.invalid' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'synthetic-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in and verify' }));
    await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Check native setup and open messages' })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Check native setup and open messages' }));
    await screen.findByRole('log');
}

describe('Research native scene invalidation and real committed DOM acknowledgement', () => {
    it('closes the existing PM port/drafts and acknowledges only the real closed DOM after React commits', async () => {
        const { f, owned, view } = mounted();
        await signInAndOpen();
        fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'synthetic unsent password' } });
        const original = f.native.acknowledgeClosedPresentation.getMockImplementation()!;
        f.native.acknowledgeClosedPresentation.mockImplementation(async (options) => {
            const root = view.container.querySelector('[data-research-private-window]')!;
            expect(measureResearchClosedPresentation(root)).toEqual(options.domFacts);
            expect(screen.queryByRole('log')).toBeNull();
            expect(screen.queryByLabelText('Message Paired sailor')).toBeNull();
            expect(screen.getByLabelText('Password')).toHaveValue('');
            expect(screen.getByRole('button', { name: 'Reverify' })).toBeDisabled();
            return original(options);
        });
        const fences = f.native.fenceSession.mock.calls.length;
        await act(async () => {
            f.setNativeState('suspended', EPOCH_B);
        });
        await waitFor(() => expect(screen.queryByRole('log')).toBeNull());
        expect((await owned.port.readiness()).status).toBe('unavailable');
        await act(async () => {
            f.setNativeState('foreground-covered', EPOCH_C);
        });
        await waitFor(() => expect(f.native.acknowledgeClosedPresentation).toHaveBeenCalledOnce());
        expect(f.native.acknowledgeClosedPresentation).toHaveBeenCalledWith({
            epoch: EPOCH_C,
            domFacts: {
                logPresent: false,
                composeEmpty: true,
                passwordEmpty: true,
                privateOpenEnabled: false,
                verificationControlsDisabled: true,
            },
        });
        await waitFor(() => expect(screen.getByRole('button', { name: 'Reverify' })).toBeEnabled());
        expect(screen.getByRole('button', { name: 'Check native setup and open messages' })).toBeDisabled();
        expect(owned.auth.getState().account).toBeNull();
        expect(f.native.fenceSession).toHaveBeenCalledTimes(fences);
        expect(f.sdk.getSession).not.toHaveBeenCalled();
        expect(f.sdk.signOut).not.toHaveBeenCalled();
    });
    it('waits for actual document completion rather than acknowledging while the initial page is loading', async () => {
        ready = 'loading';
        const { f } = mounted(lifecycleDescriptor('foreground-covered', EPOCH_B));
        await waitFor(() => expect(f.createSdk).toHaveBeenCalledOnce());
        expect(f.native.acknowledgeClosedPresentation).not.toHaveBeenCalled();
        await act(async () => {
            ready = 'complete';
            document.dispatchEvent(new Event('readystatechange'));
        });
        await waitFor(() => expect(f.native.acknowledgeClosedPresentation).toHaveBeenCalledOnce());
    });
    it('allows one changed-DOM recovery after a transient same-epoch refusal, without an unchanged retry loop', async () => {
        const { f, view } = mounted();
        await signInAndOpen();
        f.native.acknowledgeClosedPresentation.mockResolvedValueOnce({ status: 'unavailable' });
        await act(async () => {
            f.setNativeState('foreground-covered', EPOCH_B);
        });
        await waitFor(() => expect(f.native.acknowledgeClosedPresentation).toHaveBeenCalledTimes(1));
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(f.native.acknowledgeClosedPresentation).toHaveBeenCalledTimes(1);
        await act(async () => {
            const marker = document.createElement('span');
            marker.textContent = 'Changed closed presentation';
            view.container.querySelector('[data-research-private-window]')!.append(marker);
        });
        await waitFor(() => expect(f.native.acknowledgeClosedPresentation).toHaveBeenCalledTimes(2));
        await waitFor(() => expect(screen.getByRole('button', { name: 'Reverify' })).toBeEnabled());
    });
    it('does not publish an old acknowledgement into a later suspended epoch', async () => {
        const { f, owned } = mounted();
        await signInAndOpen();
        const held = deferred<unknown>();
        f.native.acknowledgeClosedPresentation.mockReturnValueOnce(held.promise);
        await act(async () => {
            f.setNativeState('foreground-covered', EPOCH_B);
        });
        await waitFor(() => expect(f.native.acknowledgeClosedPresentation).toHaveBeenCalledOnce());
        await act(async () => {
            f.setNativeState('suspended', EPOCH_C);
        });
        await act(async () => {
            held.resolve(lifecycleDescriptor('active', EPOCH_B));
        });
        expect(owned.auth.canSignIn()).toBe(false);
        expect(screen.getByRole('button', { name: 'Reverify' })).toBeDisabled();
        expect(owned.auth.getState().account).toBeNull();
        expect(f.native.acknowledgeClosedPresentation).toHaveBeenCalledOnce();
    });
    it('refuses missing/unsafe DOM controls instead of manufacturing closure facts', () => {
        const root = document.createElement('div');
        expect(measureResearchClosedPresentation(root)).toBeNull();
        root.innerHTML =
            '<input id="pilot-password" value=""><button disabled>Sign in and verify</button>' +
            '<button disabled>Reverify</button><button disabled>Explicit logout</button>' +
            '<button disabled>Check native setup and open messages</button>';
        expect(measureResearchClosedPresentation(root)?.composeEmpty).toBe(true);
        const log = document.createElement('div');
        log.setAttribute('role', 'log');
        root.append(log);
        expect(measureResearchClosedPresentation(root)).toBeNull();
    });
});
