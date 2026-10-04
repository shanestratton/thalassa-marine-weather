// @vitest-environment jsdom
// Actual research DOM/entrypoint with fixture Auth and native messaging only.
// Not a physical-device, hosted exchange or independent security-review test.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import type { ResearchAuthState } from '../experiments/scuttlebutt-e2ee/bridge-web/auth';
import type {
    ResearchMessagingController,
    ResearchMessagingNativePlugin,
} from '../experiments/scuttlebutt-e2ee/bridge-web/messaging';

type Reason = 'verification_failed' | 'verification_lost' | 'credentials_rejected' | null;
class FixtureAuth {
    private state: ResearchAuthState = { status: 'signed_out', account: null };
    private reason: Reason = null;
    private listeners = new Set<(state: ResearchAuthState) => void>();
    initialize = vi.fn(async () => undefined);
    reverify = vi.fn(async () => undefined);
    signIn = vi.fn(async () => undefined);
    signOut = vi.fn(async () => undefined);
    checkCurrentAccount = vi.fn(async () => undefined);
    getState() {
        return this.state;
    }
    getUnavailableReason() {
        return this.reason;
    }
    canSignIn() {
        return true;
    }
    canSignOut() {
        return true;
    }
    subscribe(listener: (state: ResearchAuthState) => void) {
        this.listeners.add(listener);
        listener(this.state);
        return () => this.listeners.delete(listener);
    }
    publish(state: ResearchAuthState, reason: Reason = null) {
        this.state = state;
        this.reason = reason;
        for (const listener of this.listeners) listener(state);
    }
    dispose() {
        this.listeners.clear();
    }
}
const fixture = vi.hoisted(() => ({
    auth: null as unknown as FixtureAuth,
    native: null as unknown as ResearchMessagingNativePlugin,
    controller: null as unknown as ResearchMessagingController,
}));
vi.mock('../experiments/scuttlebutt-e2ee/bridge-web/auth', () => ({
    RESEARCH_PLUGIN_NAME: 'ScuttlebuttResearchAuth',
    researchNativePlugin: {},
    ResearchAuthController: vi.fn(function () {
        return fixture.auth;
    }),
}));
vi.mock('../experiments/scuttlebutt-e2ee/bridge-web/messaging', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../experiments/scuttlebutt-e2ee/bridge-web/messaging')>();
    return {
        ...actual,
        createResearchMessagingController: (auth: FixtureAuth) => {
            fixture.controller = new actual.ResearchMessagingController({
                auth,
                native: fixture.native,
                supported: () => true,
            });
            return fixture.controller;
        },
    };
});
const methods: (keyof ResearchMessagingNativePlugin)[] = [
    'messageState',
    'messagePairingCard',
    'messageInspectPeerCard',
    'messageConfirmPeer',
    'messageRegisterDevice',
    'messageClaimPeer',
    'messageRefreshPolicy',
    'messageThread',
    'messagePrepareText',
    'messageSendPending',
    'messageSyncInbox',
];
async function boot() {
    vi.resetModules();
    vi.useFakeTimers();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const html = readFileSync(
        new NodeURL('../experiments/scuttlebutt-e2ee/bridge-web/index.html', import.meta.url),
        'utf8',
    );
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    document.body.replaceChildren(...Array.from(parsed.body.childNodes));
    fixture.auth = new FixtureAuth();
    fixture.native = Object.fromEntries(
        methods.map((method) => [method, vi.fn(async () => ({ status: 'unavailable', reason: 'unavailable' }))]),
    ) as unknown as ResearchMessagingNativePlugin;
    await import('../experiments/scuttlebutt-e2ee/bridge-web/main');
    return fixture;
}
function button(id: string) {
    return document.getElementById(id) as HTMLButtonElement;
}
afterEach(() => {
    window.dispatchEvent(new Event('pagehide'));
    fixture.controller?.dispose();
    fixture.auth?.dispose();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('research pairing verification controls — executed DOM with fixture authority', () => {
    it('offers explicit inline reverify after account loss, without auto-enrollment or messaging', async () => {
        const f = await boot();
        f.auth.publish({ status: 'unavailable', account: null }, 'verification_lost');
        expect(document.getElementById('auth-status')?.textContent).toBe('Account verification needs renewing');
        expect(document.getElementById('pairing-auth-status')?.textContent).toContain('do not log out');
        expect(button('register-device').disabled).toBe(true);
        expect(button('read-state').disabled).toBe(true);
        expect(button('reverify-pairing').disabled).toBe(false);
        button('reverify-pairing').click();
        expect(f.auth.reverify).toHaveBeenCalledTimes(1);
        expect(f.auth.signOut).not.toHaveBeenCalled();
        for (const method of methods) expect(f.native[method]).not.toHaveBeenCalled();
    });
    it.each(['signed_out', 'verifying', 'unsupported'] as const)('locks inline reverify while %s', async (status) => {
        const f = await boot();
        f.auth.publish({ status, account: null });
        expect(button('reverify-pairing').disabled).toBe(true);
        button('reverify-pairing').click();
        expect(f.auth.reverify).not.toHaveBeenCalled();
        expect(button('register-device').disabled).toBe(true);
    });
    it('enables setup only after fixture native-verified authority and clears it during reverify', async () => {
        const f = await boot();
        f.auth.publish({
            status: 'authenticated',
            account: {
                accountId: '55555555-5555-4555-8555-555555555555',
                deviceId: '66666666-6666-4666-8666-666666666666',
                credentialBinding: '11111111-1111-4111-8111-111111111111',
                serverVerified: true,
            },
        });
        expect(button('register-device').disabled).toBe(false);
        expect(button('read-state').disabled).toBe(false);
        expect(button('send-message').disabled).toBe(true);
        expect(document.getElementById('pairing-auth-status')?.textContent).toContain('short-lived');
        f.auth.publish({ status: 'verifying', account: null });
        expect(button('register-device').disabled).toBe(true);
        expect(button('reverify-pairing').disabled).toBe(true);
        for (const method of methods) expect(f.native[method]).not.toHaveBeenCalled();
    });
    it('clears displayed fixture plaintext and drafts synchronously when verification starts', async () => {
        const f = await boot();
        const binding = '11111111-1111-4111-8111-111111111111';
        f.auth.publish({
            status: 'authenticated',
            account: {
                accountId: '55555555-5555-4555-8555-555555555555',
                deviceId: '66666666-6666-4666-8666-666666666666',
                credentialBinding: binding,
                serverVerified: true,
            },
        });
        f.controller.setDraft('fixture draft, not a real message');
        vi.mocked(f.native.messageThread).mockResolvedValue({
            status: 'thread',
            credentialBinding: binding,
            messages: [
                {
                    clientMessageId: '33333333-3333-4333-8333-333333333333',
                    direction: 'incoming',
                    delivery: 'received',
                    text: 'fixture plaintext canary, not a real message',
                    reason: null,
                    localCreatedAtMillis: null,
                },
            ],
            unresolvedCount: 0,
            outgoingCapacity: 16,
            incomingCapacity: 16,
        });
        await f.controller.readThread();
        expect(document.body.textContent).toContain('fixture plaintext canary');
        expect((document.getElementById('message-draft') as HTMLTextAreaElement).value).toContain('fixture draft');
        f.auth.publish({ status: 'verifying', account: null });
        expect(document.body.textContent).not.toContain('fixture plaintext canary');
        expect((document.getElementById('message-draft') as HTMLTextAreaElement).value).toBe('');
        expect(button('register-device').disabled).toBe(true);
        expect(button('send-message').disabled).toBe(true);
    });
    it('keeps the periodic check read-only rather than silently reverifying or enrolling', async () => {
        const f = await boot();
        await vi.advanceTimersByTimeAsync(15_000);
        expect(f.auth.checkCurrentAccount).toHaveBeenCalledTimes(1);
        expect(f.auth.reverify).not.toHaveBeenCalled();
        for (const method of methods) expect(f.native[method]).not.toHaveBeenCalled();
    });
    it('does not label a first verification failure as rejected credentials or proven expiry', async () => {
        const f = await boot();
        f.auth.publish({ status: 'unavailable', account: null }, 'verification_failed');
        expect(document.getElementById('auth-status')?.textContent).toBe('Account verification did not complete');
        expect(document.getElementById('auth-detail')?.textContent).toContain('does not prove');
        expect(document.getElementById('auth-status')?.textContent).not.toMatch(/expired|rejected/);
    });
    it('shows the fixed Research-credential advice only for the whitelisted credential reason', async () => {
        const f = await boot();
        f.auth.publish({ status: 'unavailable', account: null }, 'credentials_rejected');
        expect(document.getElementById('auth-status')?.textContent).toBe('Research sign-in rejected');
        expect(document.getElementById('auth-detail')?.textContent).toContain('separate from normal Thalassa');
        expect(button('register-device').disabled).toBe(true);
    });
});
