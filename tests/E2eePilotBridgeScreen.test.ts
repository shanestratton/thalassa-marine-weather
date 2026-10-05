// @vitest-environment jsdom
// Actual research DOM/entrypoint with fixture Auth and native messaging only.
// Not a physical-device, hosted exchange or independent security-review test.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import type { ResearchAccount, ResearchAuthState } from '../experiments/scuttlebutt-e2ee/bridge-web/auth';
import type {
    ResearchMessagingController,
    ResearchMessagingNativePlugin,
} from '../experiments/scuttlebutt-e2ee/bridge-web/messaging';

type Reason = 'verification_failed' | 'verification_lost' | 'credentials_rejected' | null;
class FixtureAuth {
    private state: ResearchAuthState = { status: 'signed_out', account: null };
    private reason: Reason = null;
    private publicPairingOwner: Pick<ResearchAccount, 'accountId' | 'deviceId'> | null = null;
    private listeners = new Set<(state: ResearchAuthState) => void>();
    initialize = vi.fn(async () => undefined);
    reverify = vi.fn(async () => undefined);
    reverifyForPairing = vi.fn<() => Promise<ResearchAccount | null>>(async () =>
        this.state.status === 'authenticated' ? this.state.account : null,
    );
    signIn = vi.fn(async () => undefined);
    signOut = vi.fn<() => Promise<void>>(async () => undefined);
    checkCurrentAccount = vi.fn(async () => undefined);
    getState() {
        return this.state;
    }
    getUnavailableReason() {
        return this.reason;
    }
    getPublicPairingOwner() {
        return this.publicPairingOwner ? { ...this.publicPairingOwner } : null;
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
        if (state.status === 'signed_out' || state.status === 'unsupported') this.publicPairingOwner = null;
        else if (state.status === 'authenticated' && state.account)
            this.publicPairingOwner = {
                accountId: state.account.accountId,
                deviceId: state.account.deviceId,
            };
        for (const listener of this.listeners) listener(state);
    }
    dispose() {
        this.publicPairingOwner = null;
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
const BINDING = '11111111-1111-4111-8111-111111111111';
const RENEWED_BINDING = '22222222-2222-4222-8222-222222222222';
const OWN_CARD = '{"public":"screen-own-fixture-not-a-native-card"}';
const PEER_CARD = '{"public":"screen-peer-fixture-not-a-native-card"}';
const OWN_FINGERPRINT = 'a'.repeat(64);
const PEER_FINGERPRINT = 'b'.repeat(64);
const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
function account(credentialBinding = BINDING): ResearchAccount {
    return {
        accountId: '55555555-5555-4555-8555-555555555555',
        deviceId: '66666666-6666-4666-8666-666666666666',
        credentialBinding,
        serverVerified: true,
    };
}
function nativeFacts(credentialBinding = BINDING) {
    return {
        status: 'state',
        credentialBinding,
        pairing: 'unpaired',
        role: 'unpaired',
        fingerprint: null,
        registration: 'acknowledged',
        claim: 'none',
        policy: null,
    };
}
function mockPublicCards() {
    vi.mocked(fixture.native.messagePairingCard).mockImplementation(async ({ credentialBinding }) => ({
        status: 'pairing_card',
        credentialBinding,
        card: OWN_CARD,
        fingerprint: OWN_FINGERPRINT,
    }));
    vi.mocked(fixture.native.messageInspectPeerCard).mockImplementation(async ({ credentialBinding, card }) => ({
        status: 'peer_card',
        credentialBinding,
        card,
        fingerprint: PEER_FINGERPRINT,
    }));
}
async function settle() {
    for (let index = 0; index < 35; index += 1) await Promise.resolve();
}
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
    if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
    else Reflect.deleteProperty(navigator, 'clipboard');
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
    it('keeps same-owner public cards usable on expiry but clears current trust, drafts and message display', async () => {
        const f = await boot();
        f.auth.publish({ status: 'authenticated', account: account() });
        mockPublicCards();
        await f.controller.ownPairingCard();
        f.controller.setPeerCardInput(PEER_CARD);
        await f.controller.inspectPeerCard();
        const checkbox = document.getElementById('compared-peer') as HTMLInputElement;
        checkbox.checked = true;
        checkbox.dispatchEvent(new Event('change'));
        expect(button('confirm-peer').disabled).toBe(false);
        f.controller.setDraft('private draft fixture');
        vi.mocked(f.native.messageThread).mockResolvedValue({
            status: 'thread',
            credentialBinding: BINDING,
            messages: [
                {
                    clientMessageId: '33333333-3333-4333-8333-333333333333',
                    direction: 'incoming',
                    delivery: 'received',
                    text: 'private displayed fixture',
                    reason: null,
                    localCreatedAtMillis: null,
                },
            ],
            unresolvedCount: 0,
            outgoingCapacity: 16,
            incomingCapacity: 16,
        });
        await f.controller.readThread();
        f.auth.publish({ status: 'unavailable', account: null }, 'verification_lost');
        expect((document.getElementById('own-card') as HTMLTextAreaElement).value).toBe(OWN_CARD);
        expect((document.getElementById('peer-card') as HTMLTextAreaElement).value).toBe(PEER_CARD);
        expect((document.getElementById('peer-card') as HTMLTextAreaElement).disabled).toBe(false);
        expect(button('copy-card').disabled).toBe(false);
        expect(button('inspect-peer').disabled).toBe(false);
        expect(button('register-device').disabled).toBe(false);
        expect(checkbox.checked).toBe(false);
        expect(checkbox.disabled).toBe(true);
        expect(button('confirm-peer').disabled).toBe(true);
        expect(document.getElementById('peer-fingerprint')?.textContent).toBe('Inspect a public peer card first');
        expect((document.getElementById('message-draft') as HTMLTextAreaElement).value).toBe('');
        expect(document.body.textContent).not.toContain('private displayed fixture');
        for (const id of ['send-message', 'receive', 'claim-peer', 'refresh-policy', 'read-thread'])
            expect(button(id).disabled).toBe(true);
        const writeText = vi.fn(async () => undefined);
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
        button('copy-card').click();
        await settle();
        expect(writeText).toHaveBeenCalledExactlyOnceWith(OWN_CARD);
        expect(document.getElementById('copy-status')?.textContent).toContain('Public card copied');
        expect(f.native.messagePrepareText).not.toHaveBeenCalled();
        expect(f.native.messageSendPending).not.toHaveBeenCalled();
        expect(f.native.messageSyncInbox).not.toHaveBeenCalled();
    });
    it('renews one explicit setup action, then requires a fresh manual full-fingerprint comparison for Confirm', async () => {
        const f = await boot();
        f.auth.publish({ status: 'authenticated', account: account() });
        mockPublicCards();
        await f.controller.ownPairingCard();
        f.controller.setPeerCardInput(PEER_CARD);
        await f.controller.inspectPeerCard();
        f.controller.setComparedOnOtherDevice(true);
        f.auth.publish({ status: 'unavailable', account: null }, 'verification_lost');
        f.auth.reverifyForPairing.mockClear();
        f.auth.reverifyForPairing.mockImplementationOnce(async () => {
            f.auth.publish({ status: 'verifying', account: null });
            const renewed = account(RENEWED_BINDING);
            f.auth.publish({ status: 'authenticated', account: renewed });
            return renewed;
        });
        button('inspect-peer').click();
        await settle();
        expect(f.auth.reverifyForPairing).toHaveBeenCalledTimes(1);
        expect(f.native.messageInspectPeerCard).toHaveBeenLastCalledWith({
            credentialBinding: RENEWED_BINDING,
            card: PEER_CARD,
        });
        expect((document.getElementById('own-card') as HTMLTextAreaElement).value).toBe(OWN_CARD);
        expect((document.getElementById('peer-card') as HTMLTextAreaElement).value).toBe(PEER_CARD);
        expect(document.getElementById('peer-fingerprint')?.textContent).toBe(PEER_FINGERPRINT);
        const checkbox = document.getElementById('compared-peer') as HTMLInputElement;
        expect(checkbox.disabled).toBe(false);
        expect(checkbox.checked).toBe(false);
        expect(button('confirm-peer').disabled).toBe(true);
        expect(f.native.messageConfirmPeer).not.toHaveBeenCalled();
        expect(f.native.messageClaimPeer).not.toHaveBeenCalled();
        expect(f.native.messagePrepareText).not.toHaveBeenCalled();
        expect(f.native.messageSendPending).not.toHaveBeenCalled();
        expect(f.native.messageSyncInbox).not.toHaveBeenCalled();
        vi.mocked(f.native.messageConfirmPeer).mockImplementation(async ({ credentialBinding }) => ({
            ...nativeFacts(credentialBinding),
            pairing: 'confirmed',
            role: 'responder',
            fingerprint: PEER_FINGERPRINT,
        }));
        checkbox.checked = true;
        checkbox.dispatchEvent(new Event('change'));
        expect(button('confirm-peer').disabled).toBe(false);
        button('confirm-peer').click();
        await settle();
        expect(f.native.messageConfirmPeer).toHaveBeenCalledExactlyOnceWith({
            credentialBinding: RENEWED_BINDING,
            card: PEER_CARD,
            confirmedFingerprint: PEER_FINGERPRINT,
        });
        expect(f.auth.reverifyForPairing).toHaveBeenCalledTimes(1);
    });
    it('shows setup failures beside the pairing controls without exposing raw native errors', async () => {
        const f = await boot();
        f.auth.publish({ status: 'authenticated', account: account() });
        vi.mocked(f.native.messageRegisterDevice).mockRejectedValue(new Error('raw-native-error-canary'));
        button('register-device').click();
        await settle();
        expect(document.getElementById('pairing-action-status')?.textContent).toBe(
            document.getElementById('message-status')?.textContent,
        );
        expect(document.getElementById('pairing-action-status')?.textContent).toContain('Unavailable');
        expect(document.getElementById('pairing-action-status')?.getAttribute('aria-busy')).toBe('false');
        expect(document.body.textContent).not.toContain('raw-native-error-canary');
        expect(f.native.messageRegisterDevice).toHaveBeenCalledExactlyOnceWith({ credentialBinding: BINDING });
    });
    it('clears retained public cards and locks setup on explicit logout', async () => {
        const f = await boot();
        f.auth.publish({ status: 'authenticated', account: account() });
        mockPublicCards();
        await f.controller.ownPairingCard();
        f.controller.setPeerCardInput(PEER_CARD);
        f.auth.publish({ status: 'unavailable', account: null }, 'verification_lost');
        f.auth.signOut.mockImplementation(async () => f.auth.publish({ status: 'signed_out', account: null }));
        button('sign-out').click();
        await settle();
        expect(f.auth.signOut).toHaveBeenCalledTimes(1);
        expect((document.getElementById('own-card') as HTMLTextAreaElement).value).toBe('');
        expect((document.getElementById('peer-card') as HTMLTextAreaElement).value).toBe('');
        expect(button('copy-card').disabled).toBe(true);
        expect(button('inspect-peer').disabled).toBe(true);
        expect(button('register-device').disabled).toBe(true);
        expect(button('confirm-peer').disabled).toBe(true);
        expect((document.getElementById('compared-peer') as HTMLInputElement).checked).toBe(false);
        expect(f.native.messageConfirmPeer).not.toHaveBeenCalled();
    });
});
