// @vitest-environment jsdom
/**
 * Injected Auth/plugin fixtures only. NOT native/Olm/Keychain/HTTPS/hosted policy,
 * physical iPhone–iPad evidence, or an independent security review.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import {
    MESSAGING_NOTICES,
    ResearchMessagingController,
    researchSendSetupReady,
    renderResearchMessages,
    type ResearchMessageFacts,
    type ResearchMessagingNativePlugin,
    type ResearchThreadMessage,
} from '../experiments/scuttlebutt-e2ee/bridge-web/messaging';
import type { ResearchAuthState } from '../experiments/scuttlebutt-e2ee/bridge-web/auth';

const BINDING = '11111111-1111-4111-8111-111111111111';
const RENEWED = '22222222-2222-4222-8222-222222222222';
const ID = '33333333-3333-4333-8333-333333333333';
const OTHER_ID = '44444444-4444-4444-8444-444444444444';
const FINGERPRINT = 'a'.repeat(64);
const PUBLIC_CARD = '{"public":"fixture-only-not-a-native-card"}';
const CLEAR = { ownerRevoked: false, peerRevoked: false, blockedByMe: false, blockedByPeer: false };
const controllers: ResearchMessagingController[] = [];
function authenticated(binding = BINDING): ResearchAuthState {
    return {
        status: 'authenticated',
        account: {
            accountId: '55555555-5555-4555-8555-555555555555',
            deviceId: '66666666-6666-4666-8666-666666666666',
            credentialBinding: binding,
            serverVerified: true,
        },
    };
}
function facts(binding = BINDING): ResearchMessageFacts {
    return {
        status: 'state',
        credentialBinding: binding,
        pairing: 'confirmed',
        role: 'initiator',
        fingerprint: FINGERPRINT,
        registration: 'acknowledged',
        claim: 'verified',
        policy: null,
    };
}
function outgoing(
    delivery: ResearchThreadMessage['delivery'] = 'pending',
    clientMessageId = ID,
): ResearchThreadMessage {
    return {
        clientMessageId,
        direction: 'outgoing',
        text: '<img src=x onerror=alert(1)>',
        delivery,
        reason: delivery === 'rejected' ? 'blocked' : null,
        localCreatedAtMillis: 1_700_000_000_000,
    };
}
function deferred() {
    let resolve!: (value: unknown) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<unknown>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}
async function settle() {
    for (let index = 0; index < 35; index += 1) await Promise.resolve();
}
function fixture(supported = true) {
    let authState = authenticated();
    const listeners = new Set<(state: ResearchAuthState) => void>();
    const auth = {
        getState: () => authState,
        subscribe(listener: (state: ResearchAuthState) => void) {
            listeners.add(listener);
            listener(authState);
            return () => {
                listeners.delete(listener);
            };
        },
    };
    let rows: ResearchThreadMessage[] = [];
    const threadResponse = (binding = BINDING) => ({
        status: 'thread',
        credentialBinding: binding,
        messages: rows.map((row) => ({ ...row })),
        unresolvedCount: 0,
        outgoingCapacity: 16,
        incomingCapacity: 16,
    });
    const native = {
        messageState: vi.fn<ResearchMessagingNativePlugin['messageState']>(async (options) =>
            facts(options.credentialBinding),
        ),
        messagePairingCard: vi.fn<ResearchMessagingNativePlugin['messagePairingCard']>(async (options) => ({
            status: 'pairing_card',
            credentialBinding: options.credentialBinding,
            card: PUBLIC_CARD,
            fingerprint: FINGERPRINT,
        })),
        messageInspectPeerCard: vi.fn<ResearchMessagingNativePlugin['messageInspectPeerCard']>(async (options) => ({
            status: 'peer_card',
            credentialBinding: options.credentialBinding,
            card: PUBLIC_CARD,
            fingerprint: FINGERPRINT,
        })),
        messageConfirmPeer: vi.fn<ResearchMessagingNativePlugin['messageConfirmPeer']>(async (options) =>
            facts(options.credentialBinding),
        ),
        messageRegisterDevice: vi.fn<ResearchMessagingNativePlugin['messageRegisterDevice']>(async (options) =>
            facts(options.credentialBinding),
        ),
        messageClaimPeer: vi.fn<ResearchMessagingNativePlugin['messageClaimPeer']>(async (options) =>
            facts(options.credentialBinding),
        ),
        messageRefreshPolicy: vi.fn<ResearchMessagingNativePlugin['messageRefreshPolicy']>(async (options) => ({
            status: 'policy',
            credentialBinding: options.credentialBinding,
            policy: { ...CLEAR },
        })),
        messageThread: vi.fn<ResearchMessagingNativePlugin['messageThread']>(async (options) =>
            threadResponse(options.credentialBinding),
        ),
        messagePrepareText: vi.fn<ResearchMessagingNativePlugin['messagePrepareText']>(async (options) => {
            rows.push({ ...outgoing('pending', options.clientMessageId), text: options.text });
            return {
                status: 'prepared',
                credentialBinding: options.credentialBinding,
                clientMessageId: options.clientMessageId,
            };
        }),
        messageSendPending: vi.fn<ResearchMessagingNativePlugin['messageSendPending']>(async (options) => {
            rows = rows.map((row) =>
                row.clientMessageId === options.clientMessageId ? { ...row, delivery: 'serverAccepted' as const } : row,
            );
            return {
                status: 'send_result',
                credentialBinding: options.credentialBinding,
                clientMessageId: options.clientMessageId,
                decision: 'server_accepted',
                reason: null,
            };
        }),
        messageSyncInbox: vi.fn<ResearchMessagingNativePlugin['messageSyncInbox']>(async (options) => ({
            status: 'inbox_result',
            credentialBinding: options.credentialBinding,
            stored: 0,
            duplicates: 0,
            historical: 0,
            unresolved: 0,
            historicalUnresolved: 0,
        })),
    };
    const createMessageId = vi.fn(() => ID);
    const controller = new ResearchMessagingController({ auth, native, supported: () => supported, createMessageId });
    controllers.push(controller);
    return {
        controller,
        native,
        createMessageId,
        threadResponse,
        listeners,
        setRows(value: ResearchThreadMessage[]) {
            rows = value;
        },
        publish(value: ResearchAuthState) {
            authState = value;
            for (const listener of listeners) listener(value);
        },
    };
}
afterEach(() => {
    for (const controller of controllers.splice(0)) controller.dispose();
    vi.restoreAllMocks();
});

const unreadySetups: { name: string; patch: Partial<ResearchMessageFacts> }[] = [
    { name: 'unpaired peer', patch: { pairing: 'unpaired', role: 'unpaired', fingerprint: null } },
    { name: 'legacy incomplete pin', patch: { pairing: 'legacyUnverified' } },
    { name: 'changed peer', patch: { pairing: 'changed' } },
    { name: 'revoked peer', patch: { pairing: 'revoked' } },
    { name: 'blocked peer', patch: { pairing: 'blocked' } },
    { name: 'missing full fingerprint', patch: { fingerprint: null } },
    { name: 'unregistered device', patch: { registration: 'none' } },
    { name: 'pending registration', patch: { registration: 'pending' } },
    { name: 'unpaired role', patch: { role: 'unpaired' } },
    { name: 'initial responder', patch: { role: 'responder', claim: 'none' } },
    { name: 'initiator without claim', patch: { claim: 'none' } },
    { name: 'initiator pending claim', patch: { claim: 'pending' } },
    { name: 'initiator expired claim', patch: { claim: 'expired' } },
    { name: 'initiator historical claim', patch: { claim: 'historical' } },
];

describe('research send setup hint — not a native permission', () => {
    it('refuses unknown setup and accepts only complete acknowledged initiator setup', () => {
        expect(researchSendSetupReady(null)).toBe(false);
        expect(researchSendSetupReady(facts())).toBe(true);
    });
    it.each(unreadySetups)('refuses $name', ({ patch }) => {
        expect(researchSendSetupReady({ ...facts(), ...patch })).toBe(false);
    });
    it.each(
        unreadySetups.filter(
            ({ patch }) =>
                patch.pairing !== undefined || patch.fingerprint !== undefined || patch.registration !== undefined,
        ),
    )('still requires full pairing and registration for an established session: $name', ({ patch }) => {
        expect(researchSendSetupReady({ ...facts(), ...patch, role: 'established', claim: 'historical' })).toBe(false);
    });
    it.each(['none', 'pending', 'verified', 'expired', 'historical'] as const)(
        'allows an established session with %s claim facts without claiming permission',
        (claim) => {
            expect(researchSendSetupReady({ ...facts(), role: 'established', claim })).toBe(true);
        },
    );
    it.each(['ownerRevoked', 'peerRevoked', 'blockedByMe', 'blockedByPeer'] as const)(
        'does not turn cached %s policy facts into a permission decision',
        (flag) => {
            expect(researchSendSetupReady({ ...facts(), policy: { ...CLEAR, [flag]: true } })).toBe(true);
        },
    );
});

describe('fresh native setup before new preparation — injected fixtures only', () => {
    it.each(unreadySetups)('preserves the draft and creates no attempt for $name', async ({ patch }) => {
        const f = fixture();
        const current = { ...facts(), ...patch };
        f.native.messageState.mockResolvedValueOnce(current);
        f.controller.setDraft('keep this draft until native setup is ready');
        await f.controller.sendText();
        expect(f.native.messageThread).toHaveBeenCalledExactlyOnceWith({ credentialBinding: BINDING });
        expect(f.native.messageState).toHaveBeenCalledExactlyOnceWith({ credentialBinding: BINDING });
        expect(f.controller.getState()).toMatchObject({
            draft: 'keep this draft until native setup is ready',
            attempt: null,
            facts: current,
            busy: false,
        });
        expect(f.controller.getState().notice).not.toBe(MESSAGING_NOTICES.idle);
        expect(f.controller.getState().notice).not.toBe(MESSAGING_NOTICES.unavailable);
        if (patch.role === 'responder') expect(f.controller.getState().notice).toMatch(/responder|receive/i);
        expect(f.createMessageId).not.toHaveBeenCalled();
        expect(f.native.messageRefreshPolicy).not.toHaveBeenCalled();
        expect(f.native.messagePrepareText).not.toHaveBeenCalled();
        expect(f.native.messageSendPending).not.toHaveBeenCalled();
        expect(f.threadResponse().messages).toEqual([]);
    });
    it('refuses unavailable fresh facts without acquiring policy, consuming a UUID or dropping the draft', async () => {
        const f = fixture();
        f.native.messageState.mockResolvedValueOnce({ status: 'unavailable', reason: 'unavailable' });
        f.controller.setDraft('draft survives missing setup evidence');
        await f.controller.sendText();
        expect(f.controller.getState()).toMatchObject({
            draft: 'draft survives missing setup evidence',
            attempt: null,
            facts: null,
            notice: MESSAGING_NOTICES.unavailable,
        });
        expect(f.createMessageId).not.toHaveBeenCalled();
        expect(f.native.messageRefreshPolicy).not.toHaveBeenCalled();
        expect(f.native.messagePrepareText).not.toHaveBeenCalled();
        expect(f.native.messageSendPending).not.toHaveBeenCalled();
    });
    it('does not use cached initiator readiness when the fresh native role is responder', async () => {
        const f = fixture();
        await f.controller.readState();
        expect(researchSendSetupReady(f.controller.getState().facts)).toBe(true);
        const responder = { ...facts(), role: 'responder' as const, claim: 'none' as const };
        f.native.messageState.mockResolvedValueOnce(responder);
        f.controller.setDraft('not an initial responder send');
        await f.controller.sendText();
        expect(f.native.messageState).toHaveBeenCalledTimes(2);
        expect(f.controller.getState()).toMatchObject({
            facts: responder,
            attempt: null,
            draft: 'not an initial responder send',
        });
        expect(researchSendSetupReady(f.controller.getState().facts)).toBe(false);
        expect(f.createMessageId).not.toHaveBeenCalled();
        expect(f.native.messageRefreshPolicy).not.toHaveBeenCalled();
        expect(f.native.messagePrepareText).not.toHaveBeenCalled();
        expect(f.native.messageSendPending).not.toHaveBeenCalled();
    });
    it('reconciles a durable pending message before setup and never generates a replacement ID', async () => {
        const f = fixture();
        f.setRows([{ ...outgoing(), text: 'already durable' }]);
        f.native.messageState.mockResolvedValue({ ...facts(), role: 'responder', claim: 'none' });
        f.controller.setDraft('not a replacement');
        await f.controller.sendText();
        expect(f.controller.getState().attempt).toEqual({ clientMessageId: ID, text: 'already durable' });
        expect(f.native.messageState).not.toHaveBeenCalled();
        expect(f.createMessageId).not.toHaveBeenCalled();
        expect(f.native.messageRefreshPolicy).not.toHaveBeenCalled();
        expect(f.native.messagePrepareText).not.toHaveBeenCalled();
        expect(f.native.messageSendPending).not.toHaveBeenCalled();
    });
    it.each(['historical', 'expired'] as const)(
        'permits a fresh established reply with a %s initial claim',
        async (claim) => {
            const f = fixture();
            f.native.messageState.mockResolvedValue({ ...facts(), role: 'established', claim });
            f.controller.setDraft('reply in the established native session');
            await f.controller.sendText();
            expect(f.native.messageState).toHaveBeenCalledExactlyOnceWith({ credentialBinding: BINDING });
            expect(f.native.messageRefreshPolicy).toHaveBeenCalledExactlyOnceWith({ credentialBinding: BINDING });
            expect(f.native.messagePrepareText).toHaveBeenCalledExactlyOnceWith({
                credentialBinding: BINDING,
                clientMessageId: ID,
                text: 'reply in the established native session',
            });
            expect(f.native.messageSendPending).toHaveBeenCalledTimes(1);
            expect(f.native.messageClaimPeer).not.toHaveBeenCalled();
            expect(f.controller.getState().notice).toBe(MESSAGING_NOTICES.accepted);
        },
    );
    it('refreshes responder facts after committed receive so the first reply uses an established session', async () => {
        const f = fixture();
        let established = false;
        const responder = { ...facts(), role: 'responder' as const, claim: 'none' as const };
        const current = { ...facts(), role: 'established' as const, claim: 'historical' as const };
        const incoming: ResearchThreadMessage = {
            clientMessageId: OTHER_ID,
            direction: 'incoming',
            text: 'native fixture committed initial message',
            delivery: 'received',
            reason: null,
            localCreatedAtMillis: null,
        };
        f.native.messageState.mockImplementation(async (options) => {
            if (established) expect(f.native.messageThread.mock.calls.length).toBeGreaterThan(0);
            return { ...(established ? current : responder), credentialBinding: options.credentialBinding };
        });
        f.native.messageSyncInbox.mockImplementationOnce(async (options) => {
            established = true; // Synthetic native effect, NOT provider/session proof.
            f.setRows([incoming]);
            return {
                status: 'inbox_result',
                credentialBinding: options.credentialBinding,
                stored: 1,
                duplicates: 0,
                historical: 0,
                unresolved: 0,
                historicalUnresolved: 0,
            };
        });
        await f.controller.readState();
        expect(researchSendSetupReady(f.controller.getState().facts)).toBe(false);
        await f.controller.receive();
        expect(f.native.messageState).toHaveBeenCalledTimes(2);
        expect(f.native.messageSyncInbox.mock.invocationCallOrder[0]).toBeLessThan(
            f.native.messageThread.mock.invocationCallOrder[0],
        );
        expect(f.native.messageThread.mock.invocationCallOrder[0]).toBeLessThan(
            f.native.messageState.mock.invocationCallOrder[1],
        );
        expect(f.controller.getState().facts).toEqual(current);
        expect(f.controller.getState().thread?.messages).toEqual([incoming]);
        expect(researchSendSetupReady(f.controller.getState().facts)).toBe(true);
        f.controller.setDraft('explicit established reply');
        await f.controller.sendText();
        expect(f.native.messageState).toHaveBeenCalledTimes(3);
        expect(f.native.messagePrepareText).toHaveBeenCalledExactlyOnceWith({
            credentialBinding: BINDING,
            clientMessageId: ID,
            text: 'explicit established reply',
        });
        expect(f.native.messageSendPending).toHaveBeenCalledTimes(1);
        expect(f.native.messageClaimPeer).not.toHaveBeenCalled();
        expect(f.controller.getState().notice).toBe(MESSAGING_NOTICES.accepted);
    });
    it('does not continue when a setup-facts observer reenters and renews Auth at publication', async () => {
        const f = fixture();
        let fenced = false;
        f.controller.subscribe((state) => {
            if (state.busy && state.facts && !fenced) {
                fenced = true;
                f.publish({ status: 'verifying', account: null });
                f.publish(authenticated(RENEWED));
            }
        });
        f.controller.setDraft('do not carry this draft into renewed Auth');
        await f.controller.sendText();
        expect(fenced).toBe(true);
        expect(f.controller.getState()).toMatchObject({
            available: true,
            busy: false,
            draft: '',
            attempt: null,
            facts: null,
            thread: null,
        });
        expect(f.createMessageId).not.toHaveBeenCalled();
        expect(f.native.messageRefreshPolicy).not.toHaveBeenCalled();
        expect(f.native.messagePrepareText).not.toHaveBeenCalled();
        expect(f.native.messageSendPending).not.toHaveBeenCalled();
    });
    it.each([
        { operation: 'send', fence: 'renewed Auth' },
        { operation: 'send', fence: 'hide/show' },
        { operation: 'receive', fence: 'renewed Auth' },
        { operation: 'receive', fence: 'hide/show' },
    ] as const)(
        'discards delayed $operation facts after $fence without continuing under the new ticket',
        async ({ operation, fence }) => {
            const f = fixture();
            const gate = deferred();
            f.native.messageState.mockImplementationOnce(() => gate.promise);
            f.controller.setDraft('private draft before the fence');
            const action = operation === 'send' ? f.controller.sendText() : f.controller.receive();
            await settle();
            expect(f.native.messageState).toHaveBeenCalledExactlyOnceWith({ credentialBinding: BINDING });
            expect(f.controller.getState().busy).toBe(true);
            if (fence === 'renewed Auth') {
                f.publish({ status: 'verifying', account: null });
                f.publish(authenticated(RENEWED));
            } else {
                f.controller.setVisible(false);
                f.controller.setVisible(true);
            }
            const callsAtFence = Object.values(f.native).map((method) => method.mock.calls.length);
            expect(f.controller.getState().busy).toBe(true);
            await f.controller.readState();
            expect(Object.values(f.native).map((method) => method.mock.calls.length)).toEqual(callsAtFence);
            gate.resolve({ ...facts(), role: 'established', claim: 'historical' });
            await action;
            expect(Object.values(f.native).map((method) => method.mock.calls.length)).toEqual(callsAtFence);
            expect(f.controller.getState()).toMatchObject({
                available: true,
                busy: false,
                facts: null,
                policy: null,
                thread: null,
                draft: '',
                attempt: null,
                inboxReport: null,
            });
            expect(f.createMessageId).not.toHaveBeenCalled();
            expect(f.native.messagePrepareText).not.toHaveBeenCalled();
            expect(f.native.messageSendPending).not.toHaveBeenCalled();
        },
    );
});

describe('isolated research messaging controller — injected fixtures only', () => {
    it('does no initialization, auth-change, visibility or disposal networking', () => {
        const f = fixture();
        f.publish({ status: 'verifying', account: null });
        f.publish(authenticated(RENEWED));
        f.controller.setVisible(false);
        f.controller.setVisible(true);
        f.controller.dispose();
        for (const method of Object.values(f.native)) expect(method).not.toHaveBeenCalled();
        expect(f.listeners.size).toBe(0);
    });
    it('fails closed outside native iOS and while signed out', async () => {
        const f = fixture(false);
        await f.controller.readState();
        await f.controller.registerDevice();
        await f.controller.receive();
        expect(f.controller.getState().available).toBe(false);
        for (const method of Object.values(f.native)) expect(method).not.toHaveBeenCalled();
        const signedOut = fixture();
        signedOut.publish({ status: 'signed_out', account: null });
        await signedOut.controller.ownPairingCard();
        expect(signedOut.native.messagePairingCard).not.toHaveBeenCalled();
    });
    it.each(['fixture-binding', 'AAAAAAAA-1111-4111-8111-111111111111', `${BINDING}\n`, ''])(
        'refuses noncanonical native credential binding %j',
        async (binding) => {
            const f = fixture();
            f.publish(authenticated(binding));
            await f.controller.readState();
            await f.controller.receive();
            expect(f.controller.getState().available).toBe(false);
            for (const method of Object.values(f.native)) expect(method).not.toHaveBeenCalled();
        },
    );
    it('requires native inspect plus explicit other-device comparison before confirm, and clears the old view', async () => {
        const f = fixture();
        f.controller.setDraft('draft to clear');
        await f.controller.ownPairingCard();
        f.controller.setPeerCardInput('input public card');
        await f.controller.confirmPeer();
        expect(f.native.messageConfirmPeer).not.toHaveBeenCalled();
        await f.controller.inspectPeerCard();
        await f.controller.confirmPeer();
        expect(f.native.messageConfirmPeer).not.toHaveBeenCalled();
        f.controller.setComparedOnOtherDevice(true);
        await f.controller.confirmPeer();
        expect(f.native.messageConfirmPeer).toHaveBeenCalledExactlyOnceWith({
            credentialBinding: BINDING,
            card: PUBLIC_CARD,
            confirmedFingerprint: FINGERPRINT,
        });
        expect(f.controller.getState()).toMatchObject({
            draft: '',
            ownCard: null,
            peerCardInput: '',
            inspectedPeer: null,
            comparedOnOtherDevice: false,
            facts: facts(),
        });
        expect(f.native.messageRegisterDevice).not.toHaveBeenCalled();
        expect(f.native.messageClaimPeer).not.toHaveBeenCalled();
    });
    it('editing an inspected card clears comparison and native confirmation eligibility', async () => {
        const f = fixture();
        f.controller.setPeerCardInput('one');
        await f.controller.inspectPeerCard();
        f.controller.setComparedOnOtherDevice(true);
        f.controller.setPeerCardInput('two');
        await f.controller.confirmPeer();
        expect(f.controller.getState().inspectedPeer).toBeNull();
        expect(f.native.messageConfirmPeer).not.toHaveBeenCalled();
    });
    it('registration/claim/state remain explicit facts, never auto-enrollment or a canSend badge', async () => {
        const f = fixture();
        await f.controller.readState();
        await f.controller.registerDevice();
        await f.controller.claimPeer();
        expect(f.native.messageRegisterDevice).toHaveBeenCalledExactlyOnceWith({ credentialBinding: BINDING });
        expect(f.native.messageClaimPeer).toHaveBeenCalledExactlyOnceWith({ credentialBinding: BINDING });
        expect(f.controller.getState().notice).toContain('responder');
        expect(f.controller.getState()).not.toHaveProperty('canSend');
        expect(f.native.messageRefreshPolicy).not.toHaveBeenCalled();
        expect(f.native.messagePrepareText).not.toHaveBeenCalled();
    });
    it('sends only through the original bound native policy/prepare/send, rendering committed history and honest acceptance', async () => {
        const f = fixture();
        f.controller.setDraft('<img src=x onerror=alert(1)>');
        await f.controller.sendText();
        expect(f.native.messageState).toHaveBeenCalledExactlyOnceWith({ credentialBinding: BINDING });
        expect(f.native.messageThread.mock.invocationCallOrder[0]).toBeLessThan(
            f.native.messageState.mock.invocationCallOrder[0],
        );
        expect(f.native.messageState.mock.invocationCallOrder[0]).toBeLessThan(
            f.native.messageRefreshPolicy.mock.invocationCallOrder[0],
        );
        expect(f.native.messageRefreshPolicy.mock.invocationCallOrder[0]).toBeLessThan(
            f.createMessageId.mock.invocationCallOrder[0],
        );
        expect(f.createMessageId.mock.invocationCallOrder[0]).toBeLessThan(
            f.native.messagePrepareText.mock.invocationCallOrder[0],
        );
        expect(f.native.messageRefreshPolicy).toHaveBeenCalledExactlyOnceWith({ credentialBinding: BINDING });
        expect(f.native.messagePrepareText).toHaveBeenCalledExactlyOnceWith({
            credentialBinding: BINDING,
            clientMessageId: ID,
            text: '<img src=x onerror=alert(1)>',
        });
        expect(f.native.messageSendPending).toHaveBeenCalledExactlyOnceWith({
            credentialBinding: BINDING,
            clientMessageId: ID,
        });
        expect(f.controller.getState()).toMatchObject({ attempt: null, draft: '', notice: MESSAGING_NOTICES.accepted });
        expect(f.controller.getState().thread?.messages[0]).toEqual(outgoing('serverAccepted'));
        expect(f.native.messageRegisterDevice).not.toHaveBeenCalled();
        expect(f.native.messageClaimPeer).not.toHaveBeenCalled();
    });
    it('only native committed incoming rows are shown and null time stays unknown', async () => {
        const f = fixture();
        const incoming: ResearchThreadMessage = {
            clientMessageId: OTHER_ID,
            direction: 'incoming',
            text: 'native committed reply',
            delivery: 'received',
            reason: null,
            localCreatedAtMillis: null,
        };
        f.setRows([incoming]);
        await f.controller.receive();
        expect(f.native.messageSyncInbox).toHaveBeenCalledExactlyOnceWith({ credentialBinding: BINDING });
        expect(f.controller.getState().thread?.messages).toEqual([incoming]);
        expect(f.native.messagePrepareText).not.toHaveBeenCalled();
        expect(f.native.messageClaimPeer).not.toHaveBeenCalled();
    });
    it('renders committed hostile plaintext literally and clears DOM rows on an auth fence', async () => {
        const f = fixture();
        const list = document.createElement('ol');
        f.controller.subscribe((state) => renderResearchMessages(list, state.thread?.messages ?? []));
        f.setRows([
            outgoing('serverAccepted'),
            {
                clientMessageId: OTHER_ID,
                direction: 'incoming',
                text: '<script>private</script>',
                delivery: 'received',
                reason: null,
                localCreatedAtMillis: null,
            },
        ]);
        await f.controller.readThread();
        expect(list.querySelector('img')).toBeNull();
        expect(list.querySelector('script')).toBeNull();
        expect(list.querySelector('.message-text')?.textContent).toBe('<img src=x onerror=alert(1)>');
        expect(list.textContent).toContain('Relay accepted · not delivered or read');
        expect(list.textContent).toContain('Time unknown');
        f.publish({ status: 'verifying', account: null });
        expect(list.childElementCount).toBe(0);
    });
    it('retains exact uncertain ID/text, disables new preparation and retries only the native pending record', async () => {
        const f = fixture();
        f.native.messageSendPending.mockRejectedValueOnce(new Error('private fixture failure'));
        f.controller.setDraft('same text');
        await f.controller.sendText();
        expect(f.controller.getState().attempt).toEqual({ clientMessageId: ID, text: 'same text' });
        f.controller.setDraft('replacement');
        await f.controller.sendText();
        expect(f.createMessageId).toHaveBeenCalledTimes(1);
        expect(f.native.messagePrepareText).toHaveBeenCalledTimes(1);
        await f.controller.retryPending();
        expect(f.native.messageSendPending.mock.calls).toEqual([
            [{ credentialBinding: BINDING, clientMessageId: ID }],
            [{ credentialBinding: BINDING, clientMessageId: ID }],
        ]);
        expect(f.native.messagePrepareText).toHaveBeenCalledTimes(1);
        expect(f.controller.getState().attempt).toBeNull();
    });
    it('lost preparation echo never triggers another prepare; retry reconciles native durable ID first', async () => {
        const f = fixture();
        f.native.messagePrepareText.mockImplementationOnce(async (options) => {
            f.setRows([{ ...outgoing(), text: options.text }]);
            throw new Error('lost echo');
        });
        f.controller.setDraft('same text');
        await f.controller.sendText();
        expect(f.native.messageSendPending).not.toHaveBeenCalled();
        await f.controller.retryPending();
        expect(f.native.messagePrepareText).toHaveBeenCalledTimes(1);
        expect(f.native.messageSendPending).toHaveBeenCalledTimes(1);
    });
    it('does not dispatch a missing or conflicting pending ID or prepare a replacement', async () => {
        const f = fixture();
        f.native.messagePrepareText.mockRejectedValueOnce(new Error('uncertain'));
        f.controller.setDraft('exact text');
        await f.controller.sendText();
        await f.controller.retryPending();
        expect(f.controller.getState().attempt?.clientMessageId).toBe(ID);
        expect(f.native.messageSendPending).not.toHaveBeenCalled();
        f.setRows([{ ...outgoing(), text: 'changed text' }]);
        await f.controller.retryPending();
        expect(f.native.messageSendPending).not.toHaveBeenCalled();
        expect(f.native.messagePrepareText).toHaveBeenCalledTimes(1);
    });
    it.each(['serverAccepted', 'rejected'] as const)(
        'reconciles a native %s row without redispatch',
        async (delivery) => {
            const f = fixture();
            f.native.messageSendPending.mockRejectedValueOnce(new Error('lost receipt'));
            f.controller.setDraft('<img src=x onerror=alert(1)>');
            await f.controller.sendText();
            f.setRows([outgoing(delivery)]);
            await f.controller.retryPending();
            expect(f.native.messageSendPending).toHaveBeenCalledTimes(1);
            expect(f.controller.getState().attempt).toBeNull();
            expect(f.controller.getState().notice).toBe(
                delivery === 'serverAccepted' ? MESSAGING_NOTICES.accepted : MESSAGING_NOTICES.rejected,
            );
        },
    );
    it('new explicit Send after hide/renew discovers native pending and never replaces it', async () => {
        const f = fixture();
        f.native.messageSendPending.mockRejectedValueOnce(new Error('lost receipt'));
        f.controller.setDraft('old attempt');
        await f.controller.sendText();
        f.controller.setVisible(false);
        expect(f.controller.getState().attempt).toBeNull();
        f.controller.setVisible(true);
        f.publish(authenticated(RENEWED));
        f.controller.setDraft('new attempt');
        await f.controller.sendText();
        expect(f.controller.getState().attempt).toEqual({ clientMessageId: ID, text: 'old attempt' });
        expect(f.native.messagePrepareText).toHaveBeenCalledTimes(1);
        expect(f.native.messageSendPending).toHaveBeenCalledTimes(1);
        await f.controller.retryPending();
        expect(f.native.messageSendPending).toHaveBeenLastCalledWith({
            credentialBinding: RENEWED,
            clientMessageId: ID,
        });
    });
    it('holds a nonplaintext admission barrier through hide/show while preparation has not committed yet', async () => {
        const f = fixture();
        const gate = deferred();
        f.native.messagePrepareText.mockImplementationOnce(async () => {
            await gate.promise;
            f.setRows([{ ...outgoing(), text: 'original attempt' }]);
            return { status: 'prepared', credentialBinding: BINDING, clientMessageId: ID };
        });
        f.controller.setDraft('original attempt');
        const oldAction = f.controller.sendText();
        await settle();
        expect(f.native.messagePrepareText).toHaveBeenCalledTimes(1);
        expect(f.threadResponse().messages).toEqual([]); // No durable row exists yet.
        f.controller.setVisible(false);
        expect(f.controller.getState()).toMatchObject({ draft: '', attempt: null, thread: null, busy: false });
        f.controller.setVisible(true);
        expect(f.controller.getState().busy).toBe(true);
        f.controller.setDraft('replacement');
        await f.controller.sendText();
        await f.controller.readThread();
        await f.controller.registerDevice();
        await f.controller.receive();
        expect(f.native.messageThread).toHaveBeenCalledTimes(1);
        expect(f.native.messagePrepareText).toHaveBeenCalledTimes(1);
        expect(f.native.messageRegisterDevice).not.toHaveBeenCalled();
        expect(f.native.messageSyncInbox).not.toHaveBeenCalled();
        gate.resolve(undefined);
        await oldAction;
        expect(f.controller.getState()).toMatchObject({ busy: false, thread: null, attempt: null });
        expect(f.native.messageSendPending).not.toHaveBeenCalled();
        f.controller.setDraft('replacement');
        await f.controller.sendText();
        expect(f.controller.getState().attempt).toEqual({ clientMessageId: ID, text: 'original attempt' });
        expect(f.native.messagePrepareText).toHaveBeenCalledTimes(1);
        expect(f.createMessageId).toHaveBeenCalledTimes(1);
    });
    it('releases the old action barrier after failure without publishing its outcome under renewed Auth', async () => {
        const f = fixture();
        const gate = deferred();
        f.native.messageRegisterDevice.mockImplementationOnce(() => gate.promise);
        const oldAction = f.controller.registerDevice();
        f.publish({ status: 'verifying', account: null });
        f.publish(authenticated(RENEWED));
        expect(f.controller.getState().busy).toBe(true);
        await f.controller.readState();
        expect(f.native.messageState).not.toHaveBeenCalled();
        f.controller.subscribe(() => {
            throw new Error('broken observer');
        });
        gate.reject(new Error('old private failure'));
        await oldAction;
        expect(f.controller.getState()).toMatchObject({ busy: false, facts: null, notice: MESSAGING_NOTICES.idle });
        await f.controller.readState();
        expect(f.native.messageState).toHaveBeenCalledExactlyOnceWith({ credentialBinding: RENEWED });
    });
    it.each(['ownerRevoked', 'peerRevoked', 'blockedByMe', 'blockedByPeer'] as const)(
        '%s policy refuses prepare/send and sync',
        async (flag) => {
            const f = fixture();
            f.native.messageRefreshPolicy.mockResolvedValue({
                status: 'policy',
                credentialBinding: BINDING,
                policy: { ...CLEAR, [flag]: true },
            });
            f.controller.setDraft('text');
            await f.controller.sendText();
            await f.controller.receive();
            expect(f.native.messagePrepareText).not.toHaveBeenCalled();
            expect(f.native.messageSendPending).not.toHaveBeenCalled();
            expect(f.native.messageSyncInbox).not.toHaveBeenCalled();
            expect(f.controller.getState().attempt).toBeNull();
        },
    );
    it('invalidates prior displayed clear policy before a failed refresh and never treats it as permission', async () => {
        const f = fixture();
        await f.controller.refreshPolicy();
        const gate = deferred();
        f.native.messageRefreshPolicy.mockImplementationOnce(() => gate.promise);
        const action = f.controller.refreshPolicy();
        expect(f.controller.getState().policy).toBeNull();
        gate.resolve({ status: 'unavailable', reason: 'unavailable' });
        await action;
        expect(f.controller.getState().policy).toBeNull();
        expect(f.native.messagePrepareText).not.toHaveBeenCalled();
    });
    it('allows only one admitted operation; concurrent clicks are not queued', async () => {
        const f = fixture();
        const gate = deferred();
        f.native.messageRegisterDevice.mockImplementationOnce(() => gate.promise);
        const action = f.controller.registerDevice();
        await f.controller.claimPeer();
        await f.controller.receive();
        expect(f.native.messageClaimPeer).not.toHaveBeenCalled();
        expect(f.native.messageRefreshPolicy).not.toHaveBeenCalled();
        gate.resolve(facts());
        await action;
        expect(f.controller.getState().busy).toBe(false);
    });
    it('isolates immediate and later observer exceptions, including auth fencing', async () => {
        const f = fixture();
        const good = vi.fn();
        expect(() =>
            f.controller.subscribe(() => {
                throw new Error('renderer');
            }),
        ).not.toThrow();
        f.controller.subscribe(good);
        await f.controller.readState();
        f.publish({ status: 'verifying', account: null });
        expect(good).toHaveBeenCalled();
        expect(f.controller.getState()).toMatchObject({ available: false, facts: null, thread: null });
    });
    it('fences observer reentry between native thread reconciliation and plaintext publication', async () => {
        const f = fixture();
        f.setRows([outgoing()]);
        let fenced = false;
        f.controller.subscribe((state) => {
            if (state.attempt && !fenced) {
                fenced = true;
                f.publish({ status: 'verifying', account: null });
            }
        });
        await f.controller.readThread();
        expect(fenced).toBe(true);
        expect(f.controller.getState()).toMatchObject({ available: false, attempt: null, thread: null });
    });
    it.each(['hidden', 'verifying', 'logout', 'account-switch', 'dispose'] as const)(
        '%s immediately clears plaintext/draft/cards/comparison/tickets',
        async (event) => {
            const f = fixture();
            f.setRows([outgoing('serverAccepted')]);
            await f.controller.readThread();
            f.controller.setDraft('private draft');
            await f.controller.ownPairingCard();
            f.controller.setPeerCardInput('peer');
            await f.controller.inspectPeerCard();
            f.controller.setComparedOnOtherDevice(true);
            if (event === 'hidden') f.controller.setVisible(false);
            else if (event === 'dispose') f.controller.dispose();
            else if (event === 'account-switch')
                f.publish({
                    ...authenticated(RENEWED),
                    account: { ...authenticated(RENEWED).account!, accountId: OTHER_ID },
                });
            else f.publish({ status: event === 'logout' ? 'signed_out' : 'verifying', account: null });
            expect(f.controller.getState()).toMatchObject({
                busy: false,
                thread: null,
                draft: '',
                ownCard: null,
                peerCardInput: '',
                inspectedPeer: null,
                comparedOnOtherDevice: false,
                attempt: null,
                facts: null,
                policy: null,
            });
        },
    );
});

type Fixture = ReturnType<typeof fixture>;
type Phase = {
    name: string;
    method: keyof ResearchMessagingNativePlugin;
    start: (f: Fixture) => Promise<void>;
    response: () => unknown;
    setup?: (f: Fixture) => Promise<void>;
    secondThread?: boolean;
};
async function uncertainAttempt(f: Fixture) {
    f.native.messageSendPending.mockRejectedValueOnce(new Error('lost fixture receipt'));
    f.controller.setDraft('<img src=x onerror=alert(1)>');
    await f.controller.sendText();
}
const phases: Phase[] = [
    { name: 'state', method: 'messageState', start: (f) => f.controller.readState(), response: () => facts() },
    {
        name: 'own card',
        method: 'messagePairingCard',
        start: (f) => f.controller.ownPairingCard(),
        response: () => ({
            status: 'pairing_card',
            credentialBinding: BINDING,
            card: PUBLIC_CARD,
            fingerprint: FINGERPRINT,
        }),
    },
    {
        name: 'inspect',
        method: 'messageInspectPeerCard',
        start: (f) => {
            f.controller.setPeerCardInput('peer');
            return f.controller.inspectPeerCard();
        },
        response: () => ({
            status: 'peer_card',
            credentialBinding: BINDING,
            card: PUBLIC_CARD,
            fingerprint: FINGERPRINT,
        }),
    },
    {
        name: 'confirm',
        method: 'messageConfirmPeer',
        setup: async (f) => {
            f.controller.setPeerCardInput('peer');
            await f.controller.inspectPeerCard();
            f.controller.setComparedOnOtherDevice(true);
        },
        start: (f) => f.controller.confirmPeer(),
        response: () => facts(),
    },
    {
        name: 'registration',
        method: 'messageRegisterDevice',
        start: (f) => f.controller.registerDevice(),
        response: () => facts(),
    },
    { name: 'claim', method: 'messageClaimPeer', start: (f) => f.controller.claimPeer(), response: () => facts() },
    {
        name: 'policy',
        method: 'messageRefreshPolicy',
        start: (f) => f.controller.refreshPolicy(),
        response: () => ({ status: 'policy', credentialBinding: BINDING, policy: { ...CLEAR } }),
    },
    {
        name: 'thread',
        method: 'messageThread',
        start: (f) => f.controller.readThread(),
        response: () => ({
            status: 'thread',
            credentialBinding: BINDING,
            messages: [outgoing('serverAccepted')],
            outgoingCapacity: 16,
            incomingCapacity: 16,
            unresolvedCount: 0,
        }),
    },
    {
        name: 'send preflight',
        method: 'messageThread',
        start: (f) => {
            f.controller.setDraft('text');
            return f.controller.sendText();
        },
        response: () => ({
            status: 'thread',
            credentialBinding: BINDING,
            messages: [],
            outgoingCapacity: 16,
            incomingCapacity: 16,
            unresolvedCount: 0,
        }),
    },
    {
        name: 'send setup',
        method: 'messageState',
        start: (f) => {
            f.controller.setDraft('text');
            return f.controller.sendText();
        },
        response: () => facts(),
    },
    {
        name: 'send policy',
        method: 'messageRefreshPolicy',
        start: (f) => {
            f.controller.setDraft('text');
            return f.controller.sendText();
        },
        response: () => ({ status: 'policy', credentialBinding: BINDING, policy: { ...CLEAR } }),
    },
    {
        name: 'prepare',
        method: 'messagePrepareText',
        start: (f) => {
            f.controller.setDraft('text');
            return f.controller.sendText();
        },
        response: () => ({ status: 'prepared', credentialBinding: BINDING, clientMessageId: ID }),
    },
    {
        name: 'send receipt',
        method: 'messageSendPending',
        start: (f) => {
            f.controller.setDraft('text');
            return f.controller.sendText();
        },
        response: () => ({
            status: 'send_result',
            credentialBinding: BINDING,
            clientMessageId: ID,
            decision: 'server_accepted',
            reason: null,
        }),
    },
    {
        name: 'post-send thread',
        method: 'messageThread',
        secondThread: true,
        start: (f) => {
            f.controller.setDraft('<img src=x onerror=alert(1)>');
            return f.controller.sendText();
        },
        response: () => ({
            status: 'thread',
            credentialBinding: BINDING,
            messages: [outgoing('serverAccepted')],
            outgoingCapacity: 16,
            incomingCapacity: 16,
            unresolvedCount: 0,
        }),
    },
    {
        name: 'receive policy',
        method: 'messageRefreshPolicy',
        start: (f) => f.controller.receive(),
        response: () => ({ status: 'policy', credentialBinding: BINDING, policy: { ...CLEAR } }),
    },
    {
        name: 'inbox',
        method: 'messageSyncInbox',
        start: (f) => f.controller.receive(),
        response: () => ({
            status: 'inbox_result',
            credentialBinding: BINDING,
            stored: 1,
            duplicates: 0,
            historical: 0,
            unresolved: 0,
            historicalUnresolved: 0,
        }),
    },
    {
        name: 'post-inbox thread',
        method: 'messageThread',
        start: (f) => f.controller.receive(),
        response: () => ({
            status: 'thread',
            credentialBinding: BINDING,
            messages: [outgoing('serverAccepted')],
            outgoingCapacity: 16,
            incomingCapacity: 16,
            unresolvedCount: 0,
        }),
    },
    {
        name: 'post-inbox setup',
        method: 'messageState',
        start: (f) => f.controller.receive(),
        response: () => ({ ...facts(), role: 'established', claim: 'historical' }),
    },
    {
        name: 'retry reconciliation',
        method: 'messageThread',
        setup: uncertainAttempt,
        start: (f) => f.controller.retryPending(),
        response: () => ({
            status: 'thread',
            credentialBinding: BINDING,
            messages: [outgoing()],
            outgoingCapacity: 16,
            incomingCapacity: 16,
            unresolvedCount: 0,
        }),
    },
    {
        name: 'retry policy',
        method: 'messageRefreshPolicy',
        setup: uncertainAttempt,
        start: (f) => f.controller.retryPending(),
        response: () => ({ status: 'policy', credentialBinding: BINDING, policy: { ...CLEAR } }),
    },
    {
        name: 'retry receipt',
        method: 'messageSendPending',
        setup: uncertainAttempt,
        start: (f) => f.controller.retryPending(),
        response: () => ({
            status: 'send_result',
            credentialBinding: BINDING,
            clientMessageId: ID,
            decision: 'server_accepted',
            reason: null,
        }),
    },
];
describe('strict native echoes and original UI-ticket races — injected fixtures', () => {
    it.each(phases)('discards $name completion after reverify, even when old echo is valid', async (phase) => {
        const f = fixture();
        await phase.setup?.(f);
        const gate = deferred();
        const initialCalls = f.native[phase.method].mock.calls.length;
        if (phase.secondThread) f.native.messageThread.mockResolvedValueOnce(f.threadResponse());
        f.native[phase.method].mockImplementationOnce(() => gate.promise);
        const action = phase.start(f);
        await settle();
        expect(f.native[phase.method]).toHaveBeenCalledTimes(initialCalls + (phase.secondThread ? 2 : 1));
        expect(f.controller.getState().busy).toBe(true);
        f.publish({ status: 'verifying', account: null });
        f.publish(authenticated(RENEWED));
        const callsAtFence = Object.values(f.native).map((method) => method.mock.calls.length);
        gate.resolve(phase.response());
        await action;
        expect(Object.values(f.native).map((method) => method.mock.calls.length)).toEqual(callsAtFence);
        expect(f.controller.getState()).toMatchObject({
            available: true,
            busy: false,
            facts: null,
            policy: null,
            thread: null,
            ownCard: null,
            inspectedPeer: null,
            draft: '',
            attempt: null,
            inboxReport: null,
        });
    });
    it.each(phases)('refuses $name success with wrong credential binding', async (phase) => {
        const f = fixture();
        await phase.setup?.(f);
        if (phase.secondThread) f.native.messageThread.mockResolvedValueOnce(f.threadResponse());
        f.native[phase.method].mockResolvedValueOnce({ ...(phase.response() as object), credentialBinding: RENEWED });
        await phase.start(f);
        expect(f.controller.getState().busy).toBe(false);
        if (phase.name !== 'post-send thread') expect(f.controller.getState().notice).toMatch(/Unavailable|unresolved/);
        expect(f.controller.getState().thread).toBeNull();
        if (phase.name === 'send policy' || phase.name === 'send preflight' || phase.name === 'send setup')
            expect(f.native.messagePrepareText).not.toHaveBeenCalled();
        if (phase.name === 'send setup') {
            expect(f.createMessageId).not.toHaveBeenCalled();
            expect(f.native.messageRefreshPolicy).not.toHaveBeenCalled();
            expect(f.controller.getState()).toMatchObject({ draft: 'text', attempt: null, facts: null });
        }
        if (phase.name === 'prepare') expect(f.native.messageSendPending).not.toHaveBeenCalled();
        if (phase.name === 'receive policy') expect(f.native.messageSyncInbox).not.toHaveBeenCalled();
    });
    it.each(phases)('refuses $name extra-field DTO instead of trusting a widened bridge', async (phase) => {
        const f = fixture();
        await phase.setup?.(f);
        if (phase.secondThread) f.native.messageThread.mockResolvedValueOnce(f.threadResponse());
        f.native[phase.method].mockResolvedValueOnce({ ...(phase.response() as object), bearer: 'never exposed' });
        await phase.start(f);
        expect(f.controller.getState().thread).toBeNull();
        expect(JSON.stringify(f.controller.getState())).not.toContain('never exposed');
    });
    it.each(['hidden', 'logout', 'dispose'] as const)('discards a valid send receipt after %s', async (event) => {
        const f = fixture();
        const gate = deferred();
        f.native.messageSendPending.mockImplementationOnce(() => gate.promise);
        f.controller.setDraft('text');
        const action = f.controller.sendText();
        await settle();
        expect(f.native.messageSendPending).toHaveBeenCalledTimes(1);
        if (event === 'hidden') f.controller.setVisible(false);
        else if (event === 'dispose') f.controller.dispose();
        else f.publish({ status: 'signed_out', account: null });
        gate.resolve({
            status: 'send_result',
            credentialBinding: BINDING,
            clientMessageId: ID,
            decision: 'server_accepted',
            reason: null,
        });
        await action;
        expect(f.controller.getState().thread).toBeNull();
        expect(f.controller.getState().attempt).toBeNull();
        expect(f.controller.getState().notice).not.toBe(MESSAGING_NOTICES.accepted);
    });
});

describe('malformed bounded DTOs — injected fixtures', () => {
    it.each([1, 'false', null, undefined])('rejects coerced policy boolean %j before crypto/inbox', async (bad) => {
        const f = fixture();
        f.native.messageRefreshPolicy.mockResolvedValue({
            status: 'policy',
            credentialBinding: BINDING,
            policy: { ...CLEAR, blockedByPeer: bad },
        });
        f.controller.setDraft('text');
        await f.controller.sendText();
        await f.controller.receive();
        expect(f.native.messagePrepareText).not.toHaveBeenCalled();
        expect(f.native.messageSyncInbox).not.toHaveBeenCalled();
    });
    it.each([
        { pairing: 'secure' },
        { role: 'sender' },
        { registration: true },
        { claim: 'ready' },
        { fingerprint: 'ABC' },
        { policy: { ...CLEAR, extra: false } },
        { policy: { ...CLEAR, ownerRevoked: 'false' } },
    ])('refuses malformed public state %j', async (patch) => {
        const f = fixture();
        f.native.messageState.mockResolvedValueOnce({ ...facts(), ...patch });
        await f.controller.readState();
        expect(f.controller.getState().facts).toBeNull();
    });
    it.each([
        { messages: [{ ...outgoing(), ciphertext: 'not a DTO' }] },
        { messages: [{ ...outgoing(), direction: 'inbound' }] },
        { messages: [{ ...outgoing(), delivery: 'delivered' }] },
        { messages: [{ ...outgoing(), localCreatedAtMillis: '123' }] },
        { messages: [{ ...outgoing(), localCreatedAtMillis: Number.MAX_SAFE_INTEGER + 1 }] },
        { messages: [{ ...outgoing(), reason: 'blocked' }] },
        { messages: [{ ...outgoing('rejected'), reason: 'other' }] },
        { messages: [{ ...outgoing(), direction: 'incoming', delivery: 'received', localCreatedAtMillis: 123 }] },
        { messages: [outgoing(), outgoing()] },
        { messages: Array.from({ length: 33 }, () => outgoing()) },
        { unresolvedCount: '0' },
        { outgoingCapacity: 17 },
        { incomingCapacity: 15 },
    ])('refuses whole malformed thread %j without publishing a first row', async (patch) => {
        const f = fixture();
        f.native.messageThread.mockResolvedValueOnce({ ...f.threadResponse(), ...patch });
        await f.controller.readThread();
        expect(f.controller.getState().thread).toBeNull();
    });
    it.each([
        { decision: 'delivered' },
        { clientMessageId: OTHER_ID },
        { decision: 'server_accepted', reason: 'blocked' },
        { decision: 'rejected', reason: null },
        { decision: 'rejected', reason: 'other' },
    ])('does not settle uncertainty from malformed send receipt %j', async (patch) => {
        const f = fixture();
        f.native.messageSendPending.mockResolvedValueOnce({
            status: 'send_result',
            credentialBinding: BINDING,
            clientMessageId: ID,
            decision: 'server_accepted',
            reason: null,
            ...patch,
        });
        f.controller.setDraft('text');
        await f.controller.sendText();
        expect(f.controller.getState().attempt?.clientMessageId).toBe(ID);
        expect(f.controller.getState().notice).toBe(MESSAGING_NOTICES.uncertain);
    });
    it.each([{ card: 'x'.repeat(4097) }, { card: 'é'.repeat(2049) }, { fingerprint: 'A'.repeat(64) }, { card: null }])(
        'refuses malformed public card %j',
        async (patch) => {
            const f = fixture();
            f.native.messagePairingCard.mockResolvedValueOnce({
                status: 'pairing_card',
                credentialBinding: BINDING,
                card: PUBLIC_CARD,
                fingerprint: FINGERPRINT,
                ...patch,
            });
            await f.controller.ownPairingCard();
            expect(f.controller.getState().ownCard).toBeNull();
        },
    );
    it.each([-1, 33, 0.5, '1'])('refuses malformed inbox count %j', async (stored) => {
        const f = fixture();
        f.native.messageSyncInbox.mockResolvedValueOnce({
            status: 'inbox_result',
            credentialBinding: BINDING,
            stored,
            duplicates: 0,
            historical: 0,
            unresolved: 0,
            historicalUnresolved: 0,
        });
        await f.controller.receive();
        expect(f.controller.getState().inboxReport).toBeNull();
        expect(f.native.messageThread).not.toHaveBeenCalled();
    });
    it('rejects blank and oversized text locally without generating IDs or preparing', async () => {
        const f = fixture();
        f.controller.setDraft(' \n\t');
        await f.controller.sendText();
        f.controller.setDraft('é'.repeat(8193));
        await f.controller.sendText();
        expect(f.createMessageId).not.toHaveBeenCalled();
        expect(f.native.messagePrepareText).not.toHaveBeenCalled();
    });
    it('valid terminal rejection is not relabelled as receipt uncertainty when local history is unavailable', async () => {
        const f = fixture();
        f.native.messageSendPending.mockResolvedValueOnce({
            status: 'send_result',
            credentialBinding: BINDING,
            clientMessageId: ID,
            decision: 'rejected',
            reason: 'device-revoked',
        });
        f.native.messageThread
            .mockResolvedValueOnce(f.threadResponse())
            .mockResolvedValueOnce({ status: 'unavailable', reason: 'unavailable' });
        f.controller.setDraft('text');
        await f.controller.sendText();
        expect(f.controller.getState().notice).toBe(MESSAGING_NOTICES.rejected);
        expect(f.controller.getState().attempt).toBeNull();
        expect(f.controller.getState().thread).toBeNull();
    });
    it('uses only expected binding and bounded public inputs, with no fallback/storage/bearer channel', async () => {
        const f = fixture();
        f.controller.setDraft('text');
        await f.controller.sendText();
        await f.controller.receive();
        for (const method of Object.values(f.native))
            for (const [options] of method.mock.calls) {
                expect(options.credentialBinding).toBe(BINDING);
                expect(
                    Object.keys(options).every((key) =>
                        ['credentialBinding', 'clientMessageId', 'text', 'card', 'confirmedFingerprint'].includes(key),
                    ),
                ).toBe(true);
            }
        // Supplemental source tripwire, NOT a substitute for the executed-port fixtures above.
        const controllerSource = readFileSync(
            new NodeURL('../experiments/scuttlebutt-e2ee/bridge-web/messaging.ts', import.meta.url),
            'utf8',
        );
        const rendererSource = readFileSync(
            new NodeURL('../experiments/scuttlebutt-e2ee/bridge-web/main.ts', import.meta.url),
            'utf8',
        );
        expect(controllerSource).not.toMatch(/localStorage|sessionStorage|indexedDB|ChatService|access_token|fetch\(/);
        expect(rendererSource).not.toMatch(/innerHTML|insertAdjacentHTML/);
        expect(controllerSource).toContain('content.textContent = message.text');
    });
});
