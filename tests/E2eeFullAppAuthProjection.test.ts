// @vitest-environment jsdom
/** Synthetic projection/lifecycle fixtures only. No actual App mount, native
 * Auth, provider encryption, production service or independent review evidence.
 */
import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import type { ResearchAccount, ResearchAuthState } from '../experiments/scuttlebutt-e2ee/bridge-web/auth';
import {
    attachFullAppResearchAuth,
    createFullAppAuthProjection,
    fullAppAuthProjection,
    type FullAppAuthProjectionAttachment,
    type FullAppResearchAuthSource,
} from '../experiments/scuttlebutt-e2ee/full-app-pilot/authProjection';
import {
    handleNativeAppleCredentialRevocation,
    fenceSignedOutOnThisDevice,
    useAuthStore,
} from '../experiments/scuttlebutt-e2ee/full-app-pilot/authStore';
import { getAuthIdentityScope } from '../services/authIdentityScope';

const OWNER_A = '11111111-1111-4111-8111-111111111111';
const OWNER_B = '22222222-2222-4222-8222-222222222222';
const DEVICE_A = '33333333-3333-4333-8333-333333333333';
const DEVICE_B = '44444444-4444-4444-8444-444444444444';
const ORIGINAL_BINDING = 'projection-original-binding';
const bindings: FullAppAuthProjectionAttachment[] = [];
function authenticated(
    accountId = OWNER_A,
    deviceId = DEVICE_A,
    credentialBinding = ORIGINAL_BINDING,
): ResearchAuthState {
    return Object.freeze({
        status: 'authenticated',
        account: Object.freeze({ accountId, deviceId, credentialBinding, serverVerified: true as const }),
    });
}
function closed(status: ResearchAuthState['status'] = 'signed_out'): ResearchAuthState {
    return Object.freeze({ status, account: null });
}

function sourceFixture(initial = closed()) {
    let current = initial;
    const listeners = new Set<(state: ResearchAuthState) => void>();
    const captured: ((state: ResearchAuthState) => void)[] = [];
    const source: FullAppResearchAuthSource = {
        getState: vi.fn(() => current),
        subscribe: vi.fn((listener) => {
            captured.push(listener);
            listeners.add(listener);
            listener(current);
            return () => listeners.delete(listener);
        }),
    };
    return {
        source,
        captured,
        setCurrent(state: ResearchAuthState) {
            current = state;
        },
        emit(state: ResearchAuthState) {
            current = state;
            for (const listener of [...listeners]) listener(state);
        },
        listenerCount: () => listeners.size,
    };
}

beforeEach(() => {
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
            throw new Error('Network forbidden in Auth projection fixture');
        }),
    );
});
afterEach(() => {
    cleanup();
    for (const binding of bindings.splice(0)) binding.detach();
    expect(fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
});

describe('single Research authority presentation projection', () => {
    it('starts detached with stable frozen snapshots and no source or side effect', () => {
        const projection = createFullAppAuthProjection();
        expect(projection.getState()).toEqual({ status: 'detached', nativeOwner: null, generation: 0 });
        expect(projection.getState()).toBe(projection.getInitialState());
        expect(Object.isFrozen(projection.getState())).toBe(true);
    });
    it('subscribes exactly once to the existing source and accepts only public native facts', () => {
        const source = sourceFixture(authenticated());
        const projection = createFullAppAuthProjection();
        const listener = vi.fn();
        projection.subscribe(listener);
        const handle = projection.attach(source.source);
        expect(source.source.subscribe).toHaveBeenCalledTimes(1);
        expect(projection.getState()).toEqual({
            status: 'authenticated',
            nativeOwner: { accountId: OWNER_A, deviceId: DEVICE_A },
            generation: 2,
        });
        expect(listener).toHaveBeenCalledTimes(2);
        expect(Object.isFrozen(projection.getState().nativeOwner)).toBe(true);
        expect(JSON.stringify(projection.getState())).not.toContain(ORIGINAL_BINDING);
        handle.detach();
        expect(source.listenerCount()).toBe(0);
    });
    it.each(['unsupported', 'unavailable', 'signed_out', 'verifying'] as const)(
        'never projects account identity from %s, even with a supplied account',
        (status) => {
            const source = sourceFixture({ status, account: authenticated().account });
            const projection = createFullAppAuthProjection();
            const handle = projection.attach(source.source);
            expect(projection.getState().status).toBe(status);
            expect(projection.getState().nativeOwner).toBeNull();
            handle.detach();
        },
    );
    it.each([
        null,
        { status: 'unknown', account: null },
        { status: 'authenticated', account: null },
        { status: 'authenticated', account: {} },
        { status: 'authenticated', account: { ...authenticated().account, serverVerified: false } },
        { status: 'authenticated', account: { ...authenticated().account, accountId: 'not-an-account' } },
        { status: 'authenticated', account: { ...authenticated().account, accountId: `${OWNER_A}\n` } },
        { status: 'authenticated', account: { ...authenticated().account, deviceId: 'not-a-device' } },
        { status: 'authenticated', account: { ...authenticated().account, credentialBinding: '' } },
        { status: 'authenticated', account: { ...authenticated().account, credentialBinding: 'invalid space' } },
        { status: 'authenticated', account: { ...authenticated().account, credentialBinding: 'binding\n' } },
    ])('clears presentation for malformed controller snapshot %j', (invalid) => {
        const source = sourceFixture(authenticated());
        const projection = createFullAppAuthProjection();
        const handle = projection.attach(source.source);
        source.emit(invalid as ResearchAuthState);
        expect(projection.getState().status).toBe('unavailable');
        expect(projection.getState().nativeOwner).toBeNull();
        handle.detach();
    });
    it('does not read untrusted account/status getters or stringify diagnostics', () => {
        const getter = vi.fn(() => {
            throw new Error('Synthetic getter must not run');
        });
        const source = sourceFixture(
            Object.defineProperties({}, { status: { get: getter }, account: { get: getter } }) as ResearchAuthState,
        );
        const projection = createFullAppAuthProjection();
        const handle = projection.attach(source.source);
        expect(projection.getState().status).toBe('unavailable');
        expect(getter).not.toHaveBeenCalled();
        handle.detach();
    });
    it('removes current owner synchronously while a later verification is held', () => {
        const source = sourceFixture(authenticated());
        const projection = createFullAppAuthProjection();
        const handle = projection.attach(source.source);
        const previous = projection.getState();
        source.emit(closed('verifying'));
        expect(projection.getState().nativeOwner).toBeNull();
        expect(projection.getState().generation).toBeGreaterThan(previous.generation);
        handle.detach();
    });
    it('a late callback cannot restore an earlier owner after current source changes', () => {
        const previous = authenticated();
        const source = sourceFixture(previous);
        const projection = createFullAppAuthProjection();
        const handle = projection.attach(source.source);
        source.setCurrent(authenticated(OWNER_B, DEVICE_B, 'replacement-binding'));
        source.captured[0](previous);
        expect(projection.getState().status).toBe('unavailable');
        expect(projection.getState().nativeOwner).toBeNull();
        handle.detach();
    });
    it('a binding swap invalidates presentation generation even for the same account/device', () => {
        const source = sourceFixture(authenticated());
        const projection = createFullAppAuthProjection();
        const handle = projection.attach(source.source);
        const previous = projection.getState();
        source.emit(authenticated(OWNER_A, DEVICE_A, 'new-binding'));
        expect(projection.getState().nativeOwner).toEqual(previous.nativeOwner);
        expect(projection.getState()).not.toBe(previous);
        expect(projection.getState().generation).toBeGreaterThan(previous.generation);
        expect(JSON.stringify(projection.getState())).not.toContain('new-binding');
        handle.detach();
    });
    it('detects original binding mutation during source readback and remains closed', () => {
        const account: ResearchAccount = { ...authenticated().account! };
        const snapshot = { status: 'authenticated' as const, account };
        let calls = 0;
        const source: FullAppResearchAuthSource = {
            getState: () => {
                if (++calls === 2) Object.assign(account, { credentialBinding: 'changed-during-readback' });
                return snapshot;
            },
            subscribe(listener) {
                listener(snapshot);
                return () => {};
            },
        };
        const projection = createFullAppAuthProjection();
        const handle = projection.attach(source);
        expect(projection.getState().status).toBe('unavailable');
        expect(projection.getState().nativeOwner).toBeNull();
        handle.detach();
    });
    it('deactivation clears identity before source fencing and suppresses held publications', () => {
        const source = sourceFixture(authenticated());
        const projection = createFullAppAuthProjection();
        const handle = projection.attach(source.source);
        handle.deactivate();
        expect(projection.getState().status).toBe('inactive');
        expect(projection.getState().nativeOwner).toBeNull();
        source.emit(authenticated(OWNER_B, DEVICE_B, 'while-hidden'));
        expect(projection.getState().status).toBe('inactive');
        handle.detach();
    });
    it('reactivation never adopts a pre-hide snapshot; fresh verification is required', () => {
        const initial = authenticated();
        const source = sourceFixture(initial);
        const projection = createFullAppAuthProjection();
        const handle = projection.attach(source.source);
        handle.deactivate();
        handle.reactivate();
        source.captured[0](initial);
        expect(projection.getState().status).toBe('unavailable');
        expect(projection.getState().nativeOwner).toBeNull();
        source.emit(closed('verifying'));
        source.emit(authenticated());
        expect(projection.getState().status).toBe('authenticated');
        handle.detach();
    });
    it('reactivation also blocks a snapshot published while the composition was hidden', () => {
        const source = sourceFixture(authenticated());
        const projection = createFullAppAuthProjection();
        const handle = projection.attach(source.source);
        handle.deactivate();
        const hiddenSnapshot = authenticated(OWNER_B, DEVICE_B, 'hidden-publication');
        source.emit(hiddenSnapshot);
        handle.reactivate();
        source.captured[0](hiddenSnapshot);
        expect(projection.getState().status).toBe('unavailable');
        expect(projection.getState().nativeOwner).toBeNull();
        source.emit(authenticated(OWNER_B, DEVICE_B, 'visible-fresh-publication'));
        expect(projection.getState().nativeOwner).toEqual({ accountId: OWNER_B, deviceId: DEVICE_B });
        handle.detach();
    });
    it('old held callbacks and old handles cannot clear a replacement attachment', () => {
        const old = sourceFixture(authenticated());
        const next = sourceFixture(authenticated(OWNER_B, DEVICE_B, 'replacement'));
        const projection = createFullAppAuthProjection();
        const previousHandle = projection.attach(old.source);
        const currentHandle = projection.attach(next.source);
        const expected = projection.getState();
        old.captured[0](authenticated());
        previousHandle.deactivate();
        previousHandle.reactivate();
        previousHandle.detach();
        expect(projection.getState()).toBe(expected);
        expect(old.listenerCount()).toBe(0);
        currentHandle.detach();
    });
    it('a source that retains the callback then throws is terminally fenced, with healthy replacement allowed', () => {
        let snapshot = authenticated();
        let retained: ((state: ResearchAuthState) => void) | undefined;
        const source: FullAppResearchAuthSource = {
            getState: () => snapshot,
            subscribe(listener) {
                retained = listener;
                listener(snapshot);
                throw new Error('Synthetic subscribe failure after callback retention');
            },
        };
        const projection = createFullAppAuthProjection();
        const failedHandle = projection.attach(source);
        expect(projection.getState().status).toBe('unavailable');
        expect(projection.getState().nativeOwner).toBeNull();
        snapshot = authenticated(OWNER_B, DEVICE_B, 'retained-failed-binding');
        retained!(snapshot);
        failedHandle.deactivate();
        failedHandle.reactivate();
        failedHandle.detach();
        expect(projection.getState().status).toBe('unavailable');
        expect(projection.getState().nativeOwner).toBeNull();
        const healthy = sourceFixture(authenticated(OWNER_B, DEVICE_B, 'healthy-binding'));
        const healthyHandle = projection.attach(healthy.source);
        const expected = projection.getState();
        expect(expected.nativeOwner).toEqual({ accountId: OWNER_B, deviceId: DEVICE_B });
        retained!(snapshot);
        failedHandle.detach();
        expect(projection.getState()).toBe(expected);
        healthyHandle.detach();
    });
    it('reserves replacement before old unsubscribe reenters and never subscribes superseded outer attachment', () => {
        const projection = createFullAppAuthProjection();
        const nested = sourceFixture(authenticated(OWNER_B, DEVICE_B, 'nested-binding'));
        const outer = sourceFixture(authenticated());
        let nestedHandle: FullAppAuthProjectionAttachment | undefined;
        const oldSnapshot = authenticated();
        const stopOld = vi.fn(() => {
            nestedHandle = projection.attach(nested.source);
        });
        const oldSource: FullAppResearchAuthSource = {
            getState: () => oldSnapshot,
            subscribe(listener) {
                listener(oldSnapshot);
                return stopOld;
            },
        };
        const oldHandle = projection.attach(oldSource);
        const outerHandle = projection.attach(outer.source);
        expect(stopOld).toHaveBeenCalledTimes(1);
        expect(outer.source.subscribe).not.toHaveBeenCalled();
        expect(nested.listenerCount()).toBe(1);
        const expected = projection.getState();
        expect(expected.nativeOwner).toEqual({ accountId: OWNER_B, deviceId: DEVICE_B });
        outerHandle.detach();
        outerHandle.deactivate();
        outerHandle.reactivate();
        oldHandle.detach();
        expect(projection.getState()).toBe(expected);
        nestedHandle!.detach();
        expect(nested.listenerCount()).toBe(0);
    });
    it('does not subscribe an attachment superseded by its initial presentation publication', () => {
        const projection = createFullAppAuthProjection();
        const outer = sourceFixture(authenticated());
        const next = sourceFixture(authenticated(OWNER_B, DEVICE_B, 'presentation-replacement'));
        let nestedHandle: FullAppAuthProjectionAttachment | undefined;
        let replaced = false;
        const stopObserver = projection.subscribe((state) => {
            if (!replaced && state.status === 'unavailable') {
                replaced = true;
                nestedHandle = projection.attach(next.source);
            }
        });
        const outerHandle = projection.attach(outer.source);
        expect(outer.source.subscribe).not.toHaveBeenCalled();
        const expected = projection.getState();
        expect(expected.nativeOwner).toEqual({ accountId: OWNER_B, deviceId: DEVICE_B });
        outerHandle.detach();
        expect(projection.getState()).toBe(expected);
        stopObserver();
        nestedHandle!.detach();
    });
    it('cleans up a subscription returned after its initial callback installed a successor', () => {
        const projection = createFullAppAuthProjection();
        const next = sourceFixture(authenticated(OWNER_B, DEVICE_B, 'callback-replacement'));
        const snapshot = authenticated();
        const stopOld = vi.fn();
        const oldSource: FullAppResearchAuthSource = {
            getState: () => snapshot,
            subscribe(listener) {
                listener(snapshot);
                return stopOld;
            },
        };
        let nestedHandle: FullAppAuthProjectionAttachment | undefined;
        let replaced = false;
        const stopObserver = projection.subscribe((state) => {
            if (!replaced && state.nativeOwner?.accountId === OWNER_A) {
                replaced = true;
                nestedHandle = projection.attach(next.source);
            }
        });
        const oldHandle = projection.attach(oldSource);
        expect(stopOld).toHaveBeenCalledTimes(1);
        const expected = projection.getState();
        expect(expected.nativeOwner).toEqual({ accountId: OWNER_B, deviceId: DEVICE_B });
        oldHandle.detach();
        expect(projection.getState()).toBe(expected);
        stopObserver();
        nestedHandle!.detach();
    });
    it('terminal detach remains closed after later activate/callback actions', () => {
        const source = sourceFixture(authenticated());
        const projection = createFullAppAuthProjection();
        const handle = projection.attach(source.source);
        handle.detach();
        const expected = projection.getState();
        source.captured[0](authenticated());
        handle.deactivate();
        handle.reactivate();
        handle.detach();
        expect(projection.getState()).toBe(expected);
        expect(expected.status).toBe('detached');
    });
    it('source read failures clear presentation without publishing raw errors', () => {
        const source = sourceFixture(authenticated());
        const projection = createFullAppAuthProjection();
        const handle = projection.attach(source.source);
        vi.mocked(source.source.getState).mockImplementation(() => {
            throw new Error('Private synthetic diagnostic');
        });
        source.captured[0](authenticated());
        expect(projection.getState().status).toBe('unavailable');
        expect(JSON.stringify(projection.getState())).not.toContain('Private synthetic diagnostic');
        handle.detach();
    });
    it('a throwing observer cannot strand a later observer or the identity fence', () => {
        const projection = createFullAppAuthProjection();
        projection.subscribe(() => {
            throw new Error('Synthetic observer refusal');
        });
        const next = vi.fn();
        const stop = projection.subscribe(next);
        const source = sourceFixture(authenticated());
        const handle = projection.attach(source.source);
        handle.deactivate();
        expect(next).toHaveBeenCalledTimes(3);
        expect(projection.getState().nativeOwner).toBeNull();
        stop();
        handle.detach();
        expect(next).toHaveBeenCalledTimes(3);
    });
});

describe('closed main-App AuthStore compatibility', () => {
    it('keeps settled browse-only state despite a genuinely current native account', () => {
        const source = sourceFixture(authenticated());
        bindings.push(attachFullAppResearchAuth(source.source));
        expect(fullAppAuthProjection.getState().status).toBe('authenticated');
        expect(useAuthStore.getState()).toMatchObject({ user: null, authChecked: true });
        expect(useAuthStore.getState()).toBe(useAuthStore.getInitialState());
        expect(Object.isFrozen(useAuthStore.getState())).toBe(true);
    });
    it('supports selectors and whole-state hooks without supplying fabricated SDK profile fields', () => {
        function View() {
            const user = useAuthStore((snapshot) => snapshot.user);
            const checked = useAuthStore((snapshot) => snapshot.authChecked);
            const snapshot = useAuthStore();
            return React.createElement('p', {}, `${user === null}:${checked}:${snapshot.user === null}`);
        }
        render(React.createElement(View));
        expect(screen.getByText('true:true:true')).toBeTruthy();
        act(() => {
            const source = sourceFixture(authenticated());
            bindings.push(attachFullAppResearchAuth(source.source));
        });
        expect(screen.getByText('true:true:true')).toBeTruthy();
        expect(JSON.stringify(useAuthStore.getState())).not.toContain(OWNER_A);
    });
    it('supports getState/subscribe/unsubscribe and keeps old/current User null', () => {
        const listener = vi.fn();
        const unsubscribe = useAuthStore.subscribe(listener);
        const source = sourceFixture(authenticated());
        const handle = attachFullAppResearchAuth(source.source);
        bindings.push(handle);
        expect(listener).toHaveBeenCalledTimes(2);
        expect(listener.mock.calls.every(([next, previous]) => next.user === null && previous.user === null)).toBe(
            true,
        );
        unsubscribe();
        handle.deactivate();
        expect(listener).toHaveBeenCalledTimes(2);
    });
    it('rejects logout instead of silently acknowledging native or production sign-out', async () => {
        await expect(useAuthStore.getState().logout()).rejects.toThrow('Full App Research Auth mutation unavailable');
        expect(useAuthStore.getState().user).toBeNull();
    });
    it.each([undefined, false, true])('rejects imperative setState with replace=%j', (replace) => {
        const mutation = vi.fn(() => ({ authChecked: false }));
        expect(() => useAuthStore.setState(mutation, replace)).toThrow('Full App Research Auth mutation unavailable');
        expect(mutation).not.toHaveBeenCalled();
        expect(useAuthStore.getState().authChecked).toBe(true);
    });
    it('rejects the production Apple revocation API instead of claiming cleanup', async () => {
        await expect(handleNativeAppleCredentialRevocation('synthetic-apple-subject')).rejects.toThrow(
            'Full App Research Auth mutation unavailable',
        );
    });
    it('rejects the upstream local fence export without inspecting arguments or changing any authority presentation', async () => {
        const source = sourceFixture(authenticated());
        bindings.push(attachFullAppResearchAuth(source.source));
        const nativeBefore = fullAppAuthProjection.getState();
        const appBefore = useAuthStore.getState();
        const scopeBefore = getAuthIdentityScope();
        const getStateCalls = vi.mocked(source.source.getState).mock.calls.length;
        const subscribeCalls = vi.mocked(source.source.subscribe).mock.calls.length;
        const appListener = vi.fn(),
            nativeListener = vi.fn();
        const stopApp = useAuthStore.subscribe(appListener),
            stopNative = fullAppAuthProjection.subscribe(nativeListener);
        const getter = vi.fn(() => {
            throw new Error('Private argument must not be read');
        });
        try {
            await expect(fenceSignedOutOnThisDevice()).rejects.toThrow('Full App Research Auth mutation unavailable');
            await expect(
                Reflect.apply(fenceSignedOutOnThisDevice, undefined, [
                    Object.defineProperty({}, 'credential', { get: getter }),
                ]),
            ).rejects.toThrow('Full App Research Auth mutation unavailable');
            expect(getter).not.toHaveBeenCalled();
            expect(appListener).not.toHaveBeenCalled();
            expect(nativeListener).not.toHaveBeenCalled();
            expect(fullAppAuthProjection.getState()).toBe(nativeBefore);
            expect(useAuthStore.getState()).toBe(appBefore);
            expect(appBefore.user).toBeNull();
            expect(getAuthIdentityScope()).toBe(scopeBefore);
            expect(source.source.getState).toHaveBeenCalledTimes(getStateCalls);
            expect(source.source.subscribe).toHaveBeenCalledTimes(subscribeCalls);
        } finally {
            stopApp();
            stopNative();
        }
    });
    it('has no production/native/persistence/Auth-driver import or construction edge', () => {
        const projection = readFileSync(
            new NodeURL('../experiments/scuttlebutt-e2ee/full-app-pilot/authProjection.ts', import.meta.url),
            'utf8',
        );
        const store = readFileSync(
            new NodeURL('../experiments/scuttlebutt-e2ee/full-app-pilot/authStore.ts', import.meta.url),
            'utf8',
        );
        for (const text of [projection, store]) {
            expect(text).not.toMatch(/\b(?:createClient|new ResearchAuthController|registerPlugin|setInterval)\s*\(/);
            expect(text).not.toMatch(/\b(?:localStorage|sessionStorage|indexedDB|Preferences)\s*\./);
            expect(text).not.toMatch(/\.\s*(?:signIn|signOut|initialize|authenticate|currentAccount)\s*\(/);
            expect(text).not.toMatch(/from ['"](?:.*services\/supabase|.*stores\/authStore|@capacitor\/[^'"]+)['"]/);
            expect(text).not.toMatch(/\b(?:console|JSON)\s*\./);
        }
        expect(projection).toMatch(/import type \{ ResearchAccount, ResearchAuthController, ResearchAuthState \}/);
    });
});
