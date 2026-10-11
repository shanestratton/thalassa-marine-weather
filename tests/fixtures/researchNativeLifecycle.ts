/** Synthetic SDK/native lifecycle replies only; no host, transport or crypto. */
import { vi } from 'vitest';
import {
    ResearchAuthController,
    RESEARCH_LABEL,
    RESEARCH_SUPABASE_URL,
    type ResearchAuthNativePlugin,
    type ResearchAuthSdk,
    type ResearchAccount,
} from '../../experiments/scuttlebutt-e2ee/bridge-web/auth';
import type { ResearchNativeLifecycleDescriptor } from '../../experiments/scuttlebutt-e2ee/bridge-web/nativeLifecycle';
import type { ResearchPrivateMessagePluginBindings } from '../../experiments/scuttlebutt-e2ee/bridge-web/privateMessagePort';
export const EPOCH_A = '11111111-1111-4111-8111-111111111111';
export const EPOCH_B = '22222222-2222-4222-8222-222222222222';
export const EPOCH_C = '33333333-3333-4333-8333-333333333333';
export const OWNER = '44444444-4444-4444-8444-444444444444';
export const DEVICE = '55555555-5555-4555-8555-555555555555';
export const BINDING = '66666666-6666-4666-8666-666666666666';
export const PM_VERSION = '77777777-7777-4777-8777-777777777777';
export function lifecycleDescriptor(phase: ResearchNativeLifecycleDescriptor['phase'] = 'active', epoch = EPOCH_A) {
    return { version: 1 as const, epoch, phase, verificationAvailable: phase === 'active' };
}
export function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((yes) => {
        resolve = yes;
    });
    return { promise, resolve };
}
export function createManagedResearchFixture(initial = lifecycleDescriptor()) {
    let descriptor = initial;
    let nativeListener: ((raw: unknown) => void) | undefined;
    let sdkListener: Parameters<ResearchAuthSdk['onAuthStateChange']>[0] | undefined;
    let account: ResearchAccount | null = null;
    const closed = { status: 'unavailable' as const };
    const session = { data: { session: { access_token: 'synthetic-lifecycle-token' } }, error: null };
    const allowed = (epoch?: string) =>
        descriptor.phase === 'active' && descriptor.verificationAvailable && epoch === descriptor.epoch;
    const sdk: ResearchAuthSdk = {
        getSession: vi.fn(async () => session),
        signInWithPassword: vi.fn(async () => session),
        signOut: vi.fn(async () => ({ error: null })),
        stopAutoRefresh: vi.fn(),
        onAuthStateChange: vi.fn((callback) => {
            sdkListener = callback;
            return {
                data: {
                    subscription: {
                        unsubscribe: vi.fn(() => {
                            sdkListener = undefined;
                        }),
                    },
                },
            };
        }),
    };
    const remove = vi.fn(async () => {
        nativeListener = undefined;
    });
    const ready = () =>
        account && descriptor.phase === 'active'
            ? {
                  status: 'ready',
                  authority: { accountId: OWNER, deviceId: DEVICE, lifecycleVersion: PM_VERSION, serverVerified: true },
                  supportedContent: ['text'],
              }
            : closed;
    const native = {
        configuration: vi.fn<ResearchAuthNativePlugin['configuration']>(async () => ({
            status: 'configured',
            research: true,
            label: RESEARCH_LABEL,
            supabaseUrl: RESEARCH_SUPABASE_URL,
            publicApiKey: 'sb_publishable_research_fixture',
        })),
        lifecycleState: vi.fn(async () => ({ ...descriptor })),
        addListener: vi.fn<NonNullable<ResearchAuthNativePlugin['addListener']>>((_event, listener) => {
            if (nativeListener) throw new Error('One synthetic listener only');
            nativeListener = listener;
            return { remove };
        }),
        acknowledgeClosedPresentation: vi.fn<NonNullable<ResearchAuthNativePlugin['acknowledgeClosedPresentation']>>(
            async ({ epoch }) => {
                if (descriptor.phase !== 'foreground-covered' || descriptor.epoch !== epoch) return closed;
                descriptor = lifecycleDescriptor('active', epoch);
                return { ...descriptor };
            },
        ),
        fenceSession: vi.fn<ResearchAuthNativePlugin['fenceSession']>(async ({ epoch }) => {
            if (!allowed(epoch)) return closed;
            account = null;
            return { status: 'fenced', authFence: BINDING };
        }),
        authenticate: vi.fn<ResearchAuthNativePlugin['authenticate']>(async ({ epoch }) => {
            if (!allowed(epoch)) return closed;
            account = { accountId: OWNER, deviceId: DEVICE, credentialBinding: BINDING, serverVerified: true };
            return { status: 'authenticated', account };
        }),
        currentAccount: vi.fn<ResearchAuthNativePlugin['currentAccount']>(async (options) =>
            allowed(options?.epoch) && account ? { status: 'authenticated', account } : closed,
        ),
        messagePrivateAdmission: vi.fn(async () =>
            account && descriptor.phase === 'active'
                ? {
                      status: 'private_admission',
                      accountId: OWNER,
                      deviceId: DEVICE,
                      credentialBinding: BINDING,
                      selection: 'protected-required',
                  }
                : closed,
        ),
        privateMessageIssue: vi.fn<ResearchPrivateMessagePluginBindings['privateMessageIssue']>(async () => ready()),
        privateMessageReadiness: vi.fn(async () => ready()),
        privateMessagePermissions: vi.fn(async () => closed),
        privateMessageInbox: vi.fn(async () => closed),
        privateMessageThread: vi.fn(async () => closed),
        privateMessageSendText: vi.fn(async () => closed),
        privateMessageRetryPending: vi.fn(async () => closed),
    };
    const createSdk = vi.fn(() => sdk);
    const dependencies = { native, supported: () => true, createSdk, nativeLifecycleRequired: true };
    const controller = new ResearchAuthController(dependencies);
    return {
        native,
        sdk,
        createSdk,
        controller,
        dependencies,
        remove,
        descriptor: () => ({ ...descriptor }),
        setNativeState(phase: ResearchNativeLifecycleDescriptor['phase'], epoch = descriptor.epoch, signal = true) {
            descriptor = lifecycleDescriptor(phase, epoch);
            if (phase !== 'active') account = null;
            if (signal) nativeListener?.({ ...descriptor });
        },
        emitNative(raw: unknown) {
            nativeListener?.(raw);
        },
        emitSdk(event: string) {
            sdkListener?.(event, session.data.session);
        },
    };
}
