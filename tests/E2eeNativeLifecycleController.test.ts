// @vitest-environment node
/** Synthetic native/SDK replies only. No native authority, network or OS proof. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    ResearchAuthController,
    type NativeAccountResult,
    type ResearchAuthSdk,
} from '../experiments/scuttlebutt-e2ee/bridge-web/auth';
import {
    ResearchNativeLifecycleChannel,
    inspectResearchNativeLifecycle,
} from '../experiments/scuttlebutt-e2ee/bridge-web/nativeLifecycle';
import { createResearchPrivateMessageNativePlugin } from '../experiments/scuttlebutt-e2ee/bridge-web/privateMessagePort';
import {
    createManagedResearchFixture,
    lifecycleDescriptor,
    deferred,
    EPOCH_A,
    EPOCH_B,
    EPOCH_C,
    OWNER,
    DEVICE,
    BINDING,
} from './fixtures/researchNativeLifecycle';

const controllers: ResearchAuthController[] = [];
const channels: ResearchNativeLifecycleChannel[] = [];
const facts = {
    logPresent: false as const,
    composeEmpty: true as const,
    passwordEmpty: true as const,
    privateOpenEnabled: false as const,
    verificationControlsDisabled: true as const,
};
async function flush() {
    for (let n = 0; n < 50; n += 1) await Promise.resolve();
}
afterEach(async () => {
    controllers.splice(0).forEach((controller) => controller.dispose());
    channels.splice(0).forEach((channel) => channel.dispose());
    await flush();
});
function fixture(initial = lifecycleDescriptor()) {
    const value = createManagedResearchFixture(initial);
    controllers.push(value.controller);
    return value;
}

describe('managed lifecycle controller — synthetic race/evidence checks', () => {
    it('prepares public SDK configuration under initial suspension without a host/fence/token acquisition', async () => {
        const f = fixture(lifecycleDescriptor('suspended'));
        await f.controller.initialize();
        expect(f.createSdk).toHaveBeenCalledOnce();
        expect(f.sdk.stopAutoRefresh).toHaveBeenCalled();
        expect(f.native.fenceSession).not.toHaveBeenCalled();
        expect(f.sdk.getSession).not.toHaveBeenCalled();
        expect(f.sdk.signInWithPassword).not.toHaveBeenCalled();
        expect(f.controller.getState().account).toBeNull();
        expect(f.controller.canSignIn()).toBe(false);
        f.setNativeState('active');
        await flush();
        expect(f.controller.canSignIn()).toBe(true);
        expect(f.controller.getState().account).toBeNull();
    });
    it('refuses a required missing feature without falling back to ordinary native verification', async () => {
        const f = fixture();
        const native = {
            ...f.native,
            lifecycleState: undefined,
            addListener: undefined,
            acknowledgeClosedPresentation: undefined,
        };
        const controller = new ResearchAuthController({ ...f.dependencies, native });
        controllers.push(controller);
        await controller.initialize();
        expect(controller.getState().status).toBe('unavailable');
        expect(f.native.configuration).not.toHaveBeenCalled();
        expect(f.createSdk).not.toHaveBeenCalled();
        expect(f.native.fenceSession).not.toHaveBeenCalled();
    });
    it('reports unsupported web honestly without listener or native-state calls', async () => {
        const f = fixture();
        const controller = new ResearchAuthController({ ...f.dependencies, supported: () => false });
        controllers.push(controller);
        await controller.initialize();
        await controller.refreshNativeLifecycle();
        expect(controller.getState().status).toBe('unsupported');
        expect(f.native.addListener).not.toHaveBeenCalled();
        expect(f.native.lifecycleState).not.toHaveBeenCalled();
        expect(f.native.configuration).not.toHaveBeenCalled();
    });
    it('cancels a held acquire and late SDK event across background/ACK without another fence or Auth', async () => {
        const f = fixture();
        await f.controller.initialize();
        const held = deferred<Awaited<ReturnType<ResearchAuthSdk['signInWithPassword']>>>();
        vi.mocked(f.sdk.signInWithPassword).mockReturnValueOnce(held.promise);
        const signing = f.controller.signIn('a@fixture.invalid', 'synthetic-password');
        await flush();
        expect(f.native.fenceSession).toHaveBeenCalledWith({ mode: 'verify', epoch: EPOCH_A });
        f.setNativeState('suspended', EPOCH_B);
        await flush();
        f.setNativeState('foreground-covered', EPOCH_C);
        await flush();
        expect(await f.controller.acknowledgeClosedPresentation(EPOCH_C, facts)).toBe(true);
        held.resolve({ data: { session: { access_token: 'synthetic-held-token' } }, error: null });
        await signing;
        f.emitSdk('TOKEN_REFRESHED');
        await flush();
        expect(f.native.authenticate).not.toHaveBeenCalled();
        expect(f.native.fenceSession).toHaveBeenCalledTimes(1);
        expect(f.sdk.getSession).not.toHaveBeenCalled();
        expect(f.sdk.signOut).not.toHaveBeenCalled();
        await f.controller.reverify();
        expect(f.sdk.getSession).not.toHaveBeenCalled(); // First owner never verified: require explicit credentials.
        expect(f.controller.getState().account).toBeNull();
    });
    it('keeps owner metadata but requires explicit same-epoch verification after a valid close ACK', async () => {
        const f = fixture();
        await f.controller.initialize();
        await f.controller.signIn('a@fixture.invalid', 'synthetic-password');
        expect(f.controller.getState().status).toBe('authenticated');
        f.setNativeState('suspended', EPOCH_B);
        await flush();
        expect(f.controller.getState().account).toBeNull();
        expect(f.controller.getPublicPairingOwner()).toEqual({ accountId: OWNER, deviceId: DEVICE });
        f.setNativeState('foreground-covered', EPOCH_C);
        await flush();
        expect(f.controller.canSignIn()).toBe(false);
        expect(await f.controller.acknowledgeClosedPresentation(EPOCH_C, facts)).toBe(true);
        expect(f.controller.canSignIn()).toBe(true);
        expect(f.controller.getState().account).toBeNull();
        expect(f.native.fenceSession).toHaveBeenCalledTimes(1);
        await f.controller.reverify();
        expect(f.native.fenceSession).toHaveBeenLastCalledWith({ mode: 'verify', epoch: EPOCH_C });
        expect(f.native.authenticate).toHaveBeenLastCalledWith({
            accessToken: 'synthetic-lifecycle-token',
            authFence: BINDING,
            epoch: EPOCH_C,
        });
        expect(f.native.currentAccount).toHaveBeenLastCalledWith({ epoch: EPOCH_C });
    });
    it('does not acquire SDK tokens after a held fence response when the native hint was lost', async () => {
        const f = fixture();
        await f.controller.initialize();
        const held = deferred<{ status: 'fenced'; authFence: string }>();
        f.native.fenceSession.mockReturnValueOnce(held.promise);
        const signing = f.controller.signIn('a@fixture.invalid', 'synthetic-password');
        await flush();
        f.setNativeState('suspended', EPOCH_B, false);
        held.resolve({ status: 'fenced', authFence: BINDING });
        await signing;
        expect(f.sdk.signInWithPassword).not.toHaveBeenCalled();
        expect(f.native.authenticate).not.toHaveBeenCalled();
        expect(f.controller.getState().account).toBeNull();
    });
    it('refuses late native Auth publication after background and foreground ACK', async () => {
        const f = fixture();
        await f.controller.initialize();
        const held = deferred<NativeAccountResult>();
        f.native.authenticate.mockReturnValueOnce(held.promise);
        const signing = f.controller.signIn('a@fixture.invalid', 'synthetic-password');
        await flush();
        f.setNativeState('suspended', EPOCH_B);
        await flush();
        f.setNativeState('foreground-covered', EPOCH_C);
        await flush();
        await f.controller.acknowledgeClosedPresentation(EPOCH_C, facts);
        held.resolve({
            status: 'authenticated',
            account: { accountId: OWNER, deviceId: DEVICE, credentialBinding: BINDING, serverVerified: true },
        });
        await signing;
        expect(f.controller.getState().account).toBeNull();
        expect(f.native.currentAccount).not.toHaveBeenCalled();
    });
    it.each(['SIGNED_OUT', 'TOKEN_REFRESHED'])(
        'denies established active credentials on SDK %s without auto-reverification or quarantine',
        async (event) => {
            const f = fixture();
            await f.controller.initialize();
            await f.controller.signIn('a@fixture.invalid', 'synthetic-password');
            f.emitSdk(event);
            await flush();
            expect(f.controller.getState().account).toBeNull();
            expect(f.native.fenceSession).toHaveBeenCalledTimes(2);
            expect(f.native.fenceSession).toHaveBeenLastCalledWith({ mode: 'verify', epoch: EPOCH_A });
            expect(f.sdk.getSession).not.toHaveBeenCalled();
            expect(f.sdk.signOut).not.toHaveBeenCalled();
            expect(f.controller.getPublicPairingOwner()).not.toBeNull();
        },
    );
    it('skips the managed visibility fallback when native already closed, but fences same-active-epoch manual hiding', async () => {
        const f = fixture();
        await f.controller.initialize();
        await f.controller.signIn('a@fixture.invalid', 'synthetic-password');
        f.controller.suspend();
        await flush();
        expect(f.native.fenceSession).toHaveBeenCalledTimes(2);
        await f.controller.reverify();
        const before = f.native.fenceSession.mock.calls.length;
        f.setNativeState('suspended', EPOCH_B);
        f.controller.suspend();
        await flush();
        expect(f.native.fenceSession).toHaveBeenCalledTimes(before);
    });
    it('invalidates an existing PM port and refuses its held result instead of adopting a successor channel', async () => {
        const f = fixture();
        const port = createResearchPrivateMessageNativePlugin(f.native);
        await f.controller.initialize();
        await f.controller.signIn('a@fixture.invalid', 'synthetic-password');
        const held = deferred<unknown>();
        f.native.privateMessageIssue.mockReturnValueOnce(held.promise);
        const opening = port.connectCurrentAccount(BINDING);
        await flush();
        f.controller.dispose();
        const replacement = new ResearchAuthController(f.dependencies);
        controllers.push(replacement);
        await replacement.initialize();
        held.resolve({
            status: 'ready',
            authority: {
                accountId: OWNER,
                deviceId: DEVICE,
                lifecycleVersion: '77777777-7777-4777-8777-777777777777',
                serverVerified: true,
            },
            supportedContent: ['text'],
        });
        expect((await opening).status).toBe('unavailable');
        expect((await port.connectCurrentAccount(BINDING)).status).toBe('unavailable');
    });
});

describe('bounded descriptor/listener channel — synthetic transport', () => {
    it('refuses accessor/malformed phase without invoking private coercion', () => {
        const getter = vi.fn(() => {
            throw new Error('private-canary');
        });
        const raw = lifecycleDescriptor();
        Object.defineProperty(raw, 'epoch', { get: getter });
        expect(inspectResearchNativeLifecycle(raw)).toBeNull();
        expect(getter).not.toHaveBeenCalled();
        const coercion = vi.fn(() => 'active');
        expect(inspectResearchNativeLifecycle({ ...lifecycleDescriptor(), phase: { toString: coercion } })).toBeNull();
        expect(coercion).not.toHaveBeenCalled();
    });
    it('makes unchanged closed replay idempotent so a valid ACK can complete', async () => {
        const f = fixture(lifecycleDescriptor('foreground-covered', EPOCH_B));
        const invalidated = vi.fn(),
            channel = new ResearchNativeLifecycleChannel(f.native, true, invalidated);
        channels.push(channel);
        await channel.refresh();
        const initial = invalidated.mock.calls.length;
        await channel.refresh();
        await channel.refresh();
        expect(invalidated).toHaveBeenCalledTimes(initial);
        expect((await channel.acknowledge(EPOCH_B, facts))?.phase).toBe('active');
    });
    it('refuses two invalidated reads without returning cached active or recursively dispatching more', async () => {
        const f = fixture();
        await f.controller.initialize();
        f.native.lifecycleState.mockImplementation(async () => {
            f.emitNative(lifecycleDescriptor());
            return lifecycleDescriptor();
        });
        const before = f.native.lifecycleState.mock.calls.length;
        expect(await f.controller.refreshNativeLifecycle()).toBeNull();
        await flush();
        expect(f.native.lifecycleState).toHaveBeenCalledTimes(before + 2);
        expect(f.controller.canSignIn()).toBe(false);
        await f.controller.signIn('a@fixture.invalid', 'synthetic-password');
        await flush();
        expect(f.sdk.signInWithPassword).not.toHaveBeenCalled();
    });
    it('hands a late physical registration to the replacement owner without retaining the disposed callback', async () => {
        const f = fixture();
        const registration = deferred<void>();
        const original = f.native.addListener.getMockImplementation()!;
        f.native.addListener.mockImplementationOnce(async (event, listener) => {
            const handle = await original(event, listener);
            await registration.promise;
            return handle;
        });
        const first = f.controller.initialize();
        await flush();
        f.controller.dispose();
        const replacement = new ResearchAuthController(f.dependencies);
        controllers.push(replacement);
        const next = replacement.initialize();
        await flush();
        expect(f.native.addListener).toHaveBeenCalledTimes(1);
        registration.resolve();
        await first;
        await next;
        expect(replacement.canSignIn()).toBe(true);
        expect(f.controller.canSignIn()).toBe(false);
    });
    it('waits for old native listener removal before registering a replacement', async () => {
        const f = fixture();
        await f.controller.initialize();
        const removal = deferred<void>(),
            original = f.remove.getMockImplementation()!;
        f.remove.mockImplementationOnce(async () => {
            await removal.promise;
            await original();
        });
        f.controller.dispose();
        const replacement = new ResearchAuthController(f.dependencies);
        controllers.push(replacement);
        const next = replacement.initialize();
        await flush();
        expect(f.native.addListener).toHaveBeenCalledTimes(1);
        removal.resolve();
        await flush();
        await next;
        expect(f.native.addListener).toHaveBeenCalledTimes(2);
        expect(replacement.canSignIn()).toBe(true);
    });
});
