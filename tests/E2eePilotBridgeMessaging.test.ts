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
    type ResearchMessagingAuth,
    type ResearchThreadMessage,
} from '../experiments/scuttlebutt-e2ee/bridge-web/messaging';
import type { ResearchAccount, ResearchAuthState } from '../experiments/scuttlebutt-e2ee/bridge-web/auth';

const BINDING = '11111111-1111-4111-8111-111111111111';
const RENEWED = '22222222-2222-4222-8222-222222222222';
const ID = '33333333-3333-4333-8333-333333333333';
const OTHER_ID = '44444444-4444-4444-8444-444444444444';
const FINGERPRINT = 'a'.repeat(64);
const ENVELOPE_SHA256 = 'a'.repeat(64); // Synthetic public hash, not a native ciphertext receipt.
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
function accountMode(mode: 'legacy-permitted' | 'protected-required', binding = BINDING) {
    return { status: 'account_mode' as const, credentialBinding: binding, mode };
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
        envelopeSha256: ENVELOPE_SHA256,
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
function fixture(supported = true, pairingContinuity = false) {
    let authState = authenticated();
    let publicOwner: Pick<ResearchAccount, 'accountId' | 'deviceId'> | null = authState.account;
    const listeners = new Set<(state: ResearchAuthState) => void>();
    const publish = (value: ResearchAuthState) => {
        authState = value;
        if (value.status === 'authenticated') publicOwner = value.account;
        else if (value.status === 'signed_out' || value.status === 'unsupported') publicOwner = null;
        for (const listener of listeners) listener(value);
    };
    const getPublicPairingOwner = vi.fn(() => publicOwner);
    const reverifyForPairing = vi.fn<() => Promise<ResearchAccount | null>>(async () => {
        publish({ status: 'verifying', account: null });
        const renewed = authenticated(RENEWED);
        publish(renewed);
        return renewed.account;
    });
    const auth: ResearchMessagingAuth = {
        getState: () => authState,
        subscribe(listener: (state: ResearchAuthState) => void) {
            listeners.add(listener);
            listener(authState);
            return () => {
                listeners.delete(listener);
            };
        },
    };
    if (pairingContinuity) {
        auth.getPublicPairingOwner = getPublicPairingOwner;
        auth.reverifyForPairing = reverifyForPairing;
    }
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
        messageRequireProtected: vi.fn<ResearchMessagingNativePlugin['messageRequireProtected']>(async (options) =>
            accountMode('protected-required', options.credentialBinding),
        ),
        messageAccountMode: vi.fn<ResearchMessagingNativePlugin['messageAccountMode']>(async (options) =>
            accountMode('legacy-permitted', options.credentialBinding),
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
        auth,
        native,
        createMessageId,
        threadResponse,
        listeners,
        getPublicPairingOwner,
        reverifyForPairing,
        setPublicOwner(value: Pick<ResearchAccount, 'accountId' | 'deviceId'> | null) {
            publicOwner = value;
        },
        setRows(value: ResearchThreadMessage[]) {
            rows = value;
        },
        publish,
    };
}
afterEach(() => {
    for (const controller of controllers.splice(0)) controller.dispose();
    vi.restoreAllMocks();
});

const accountModeActions = [
    {
        name: 'require protected',
        method: 'messageRequireProtected',
        run: (f: ReturnType<typeof fixture>) => f.controller.requireProtected(),
        expectedMode: 'protected-required',
    },
    {
        name: 'refresh account mode',
        method: 'messageAccountMode',
        run: (f: ReturnType<typeof fixture>) => f.controller.refreshAccountMode(),
        expectedMode: 'legacy-permitted',
    },
] as const;

describe('explicit durable account mode — injected owner-only Auth/plugin fixtures', () => {
    it.each(accountModeActions)(
        'dispatches $name with only the original credential binding and no peer setup',
        async (action) => {
            const f = fixture(true, true);
            expect(f.controller.getState().accountMode).toBeNull();
            await action.run(f);
            expect(f.native[action.method]).toHaveBeenCalledExactlyOnceWith({ credentialBinding: BINDING });
            for (const [method, mock] of Object.entries(f.native))
                if (method !== action.method) expect(mock).not.toHaveBeenCalled();
            expect(f.reverifyForPairing).not.toHaveBeenCalled();
            expect(f.createMessageId).not.toHaveBeenCalled();
            expect(f.controller.getState()).toMatchObject({
                available: true,
                busy: false,
                accountMode: action.expectedMode,
                facts: null,
                policy: null,
                thread: null,
                attempt: null,
                inboxReport: null,
            });
            expect(f.controller.getState()).not.toHaveProperty('canSend');
            expect(f.controller.getState()).not.toHaveProperty('encrypted');
        },
    );

    it.each(['legacy-permitted', 'protected-required'] as const)(
        'publishes the exact %s read result without selecting protection',
        async (mode) => {
            const f = fixture();
            f.native.messageAccountMode.mockResolvedValueOnce(accountMode(mode));
            await f.controller.refreshAccountMode();
            expect(f.controller.getState().accountMode).toBe(mode);
            expect(f.native.messageAccountMode).toHaveBeenCalledExactlyOnceWith({ credentialBinding: BINDING });
            expect(f.native.messageRequireProtected).not.toHaveBeenCalled();
            expect(f.native.messageRefreshPolicy).not.toHaveBeenCalled();
            expect(f.native.messagePrepareText).not.toHaveBeenCalled();
            expect(f.native.messageSendPending).not.toHaveBeenCalled();
        },
    );

    it('refuses a legacy-permitted mutation result without querying or claiming a successful cutover', async () => {
        const f = fixture();
        f.native.messageRequireProtected.mockResolvedValueOnce(accountMode('legacy-permitted'));
        await f.controller.requireProtected();
        expect(f.controller.getState()).toMatchObject({
            accountMode: null,
            busy: false,
            notice: MESSAGING_NOTICES.unavailable,
        });
        expect(f.native.messageRequireProtected).toHaveBeenCalledExactlyOnceWith({ credentialBinding: BINDING });
        expect(f.native.messageAccountMode).not.toHaveBeenCalled();
    });

    it('does not select or read account mode during explicit setup, history, preparation, send or receive actions', async () => {
        const f = fixture(true, true);
        await f.controller.readState();
        await f.controller.ownPairingCard();
        f.controller.setPeerCardInput('fixture public peer card');
        await f.controller.inspectPeerCard();
        f.controller.setComparedOnOtherDevice(true);
        await f.controller.confirmPeer();
        await f.controller.registerDevice();
        await f.controller.claimPeer();
        await f.controller.refreshPolicy();
        await f.controller.readThread();
        f.controller.setDraft('explicit send without mode selection');
        await f.controller.sendText();
        f.createMessageId.mockReturnValueOnce(OTHER_ID);
        f.controller.setDraft('explicit preparation without mode selection');
        await f.controller.prepareOnly();
        await f.controller.retryPending();
        await f.controller.receive();
        expect(f.native.messagePrepareText).toHaveBeenCalledTimes(2);
        expect(f.native.messageSendPending).toHaveBeenCalledTimes(2);
        expect(f.native.messageSyncInbox).toHaveBeenCalledTimes(1);
        expect(f.reverifyForPairing).toHaveBeenCalled();
        expect(f.native.messageRequireProtected).not.toHaveBeenCalled();
        expect(f.native.messageAccountMode).not.toHaveBeenCalled();
        expect(f.controller.getState().accountMode).toBeNull();
    });

    it.each(accountModeActions)(
        'keeps $name closed for unsupported, hidden, expired and signed-out owners',
        async (action) => {
            const unsupported = fixture(false, true);
            await action.run(unsupported);
            const f = fixture(true, true);
            f.controller.setVisible(false);
            await action.run(f);
            f.controller.setVisible(true);
            f.publish({ status: 'unavailable', account: null });
            await action.run(f);
            f.publish({ status: 'signed_out', account: null });
            await action.run(f);
            for (const current of [unsupported, f]) {
                expect(current.controller.getState().accountMode).toBeNull();
                expect(current.reverifyForPairing).not.toHaveBeenCalled();
                for (const method of Object.values(current.native)) expect(method).not.toHaveBeenCalled();
            }
        },
    );

    it.each(accountModeActions)(
        'clears a previous displayed mode before $name and leaves unavailable results unknown',
        async (action) => {
            const f = fixture();
            f.native.messageAccountMode.mockResolvedValueOnce(accountMode('protected-required'));
            await f.controller.refreshAccountMode();
            expect(f.controller.getState().accountMode).toBe('protected-required');
            for (const method of Object.values(f.native)) method.mockClear();
            const gate = deferred();
            f.native[action.method].mockImplementationOnce(() => gate.promise);
            const pending = action.run(f);
            expect(f.controller.getState()).toMatchObject({ accountMode: null, busy: true });
            expect(f.native[action.method]).toHaveBeenCalledExactlyOnceWith({ credentialBinding: BINDING });
            gate.resolve({ status: 'unavailable', reason: 'unavailable' });
            await pending;
            expect(f.controller.getState()).toMatchObject({
                accountMode: null,
                busy: false,
                notice: MESSAGING_NOTICES.unavailable,
            });
            for (const [method, mock] of Object.entries(f.native))
                if (method !== action.method) expect(mock).not.toHaveBeenCalled();
        },
    );

    const invalidResponses = [
        { name: 'null result', value: null },
        { name: 'array result', value: [accountMode('protected-required')] },
        { name: 'string result', value: 'protected-required' },
        { name: 'missing status', value: { credentialBinding: BINDING, mode: 'protected-required' } },
        { name: 'wrong status', value: { ...accountMode('protected-required'), status: 'state' } },
        { name: 'missing binding', value: { status: 'account_mode', mode: 'protected-required' } },
        { name: 'wrong binding', value: accountMode('protected-required', RENEWED) },
        { name: 'noncanonical binding', value: accountMode('protected-required', `${BINDING}\n`) },
        { name: 'missing mode', value: { status: 'account_mode', credentialBinding: BINDING } },
        { name: 'null mode', value: { ...accountMode('protected-required'), mode: null } },
        { name: 'boolean mode', value: { ...accountMode('protected-required'), mode: true } },
        { name: 'old legacy label', value: { ...accountMode('protected-required'), mode: 'legacy' } },
        { name: 'encryption label', value: { ...accountMode('protected-required'), mode: 'encrypted' } },
        {
            name: 'trailing mode newline',
            value: { ...accountMode('protected-required'), mode: 'protected-required\n' },
        },
        { name: 'extra owner field', value: { ...accountMode('protected-required'), ownerUserId: OTHER_ID } },
        { name: 'extra authority flag', value: { ...accountMode('protected-required'), canSend: true } },
        { name: 'extra private data', value: { ...accountMode('protected-required'), bearer: 'private-mode-canary' } },
    ];
    it.each(accountModeActions.flatMap((action) => invalidResponses.map((response) => ({ action, ...response }))))(
        'refuses $name for $action.name and publishes no stale mode or private error data',
        async ({ action, value }) => {
            const f = fixture();
            await f.controller.refreshAccountMode();
            f.native[action.method].mockResolvedValueOnce(value);
            await action.run(f);
            expect(f.controller.getState()).toMatchObject({
                accountMode: null,
                busy: false,
                notice: MESSAGING_NOTICES.unavailable,
            });
            expect(JSON.stringify(f.controller.getState())).not.toContain('private-mode-canary');
            expect(f.native.messagePrepareText).not.toHaveBeenCalled();
            expect(f.native.messageSendPending).not.toHaveBeenCalled();
        },
    );

    it.each(
        accountModeActions.flatMap((action) =>
            [
                'symbol field',
                'hidden extra',
                'hidden mode',
                'mode accessor',
                'null prototype',
                'inherited fields',
                'hostile proxy',
            ].map((representation) => ({ action, representation })),
        ),
    )(
        'refuses $representation for $action.name without invoking accessors or publishing private diagnostics',
        async ({ action, representation }) => {
            const f = fixture();
            const getter = vi.fn(() => 'protected-required');
            let value: unknown = accountMode('protected-required');
            if (representation === 'symbol field')
                Object.defineProperty(value, Symbol('private-mode-canary'), { value: 'private-mode-canary' });
            else if (representation === 'hidden extra')
                Object.defineProperty(value, 'privateModeCanary', { value: 'private-mode-canary' });
            else if (representation === 'hidden mode')
                Object.defineProperty(value, 'mode', { value: 'protected-required', enumerable: false });
            else if (representation === 'mode accessor')
                Object.defineProperty(value, 'mode', { get: getter, enumerable: true });
            else if (representation === 'null prototype')
                value = Object.assign(
                    Object.create(null) as Record<string, unknown>,
                    accountMode('protected-required'),
                );
            else if (representation === 'inherited fields') value = Object.create(accountMode('protected-required'));
            else
                value = new Proxy(accountMode('protected-required'), {
                    ownKeys() {
                        throw new Error('private-mode-canary');
                    },
                });
            f.native[action.method].mockResolvedValueOnce(value);
            await action.run(f);
            expect(getter).not.toHaveBeenCalled();
            expect(f.controller.getState()).toMatchObject({
                accountMode: null,
                busy: false,
                notice: MESSAGING_NOTICES.unavailable,
            });
            expect(JSON.stringify(f.controller.getState())).not.toContain('private-mode-canary');
        },
    );

    it.each(accountModeActions)(
        'clears the old mode after a current $name native failure without exposing its error',
        async (action) => {
            const f = fixture();
            await f.controller.refreshAccountMode();
            f.native[action.method].mockRejectedValueOnce(new Error('private-mode-error-canary'));
            await action.run(f);
            expect(f.controller.getState()).toMatchObject({
                accountMode: null,
                busy: false,
                notice: MESSAGING_NOTICES.unavailable,
            });
            expect(JSON.stringify(f.controller.getState())).not.toContain('private-mode-error-canary');
        },
    );

    it.each(
        accountModeActions.flatMap((action) =>
            ['initial busy', 'mode reset'].flatMap((publication) =>
                ['renewed', 'hide-show', 'logout-login'].map((event) => ({ action, publication, event })),
            ),
        ),
    )(
        'does not dispatch $action.name when its $publication observer triggers $event',
        async ({ action, publication, event }) => {
            const f = fixture(true, true);
            await f.controller.requireProtected();
            for (const method of Object.values(f.native)) method.mockClear();
            let fenced = false;
            f.controller.subscribe((state) => {
                if (!state.busy || fenced || (publication === 'mode reset' && state.accountMode !== null)) return;
                fenced = true;
                if (event === 'hide-show') {
                    f.controller.setVisible(false);
                    f.controller.setVisible(true);
                } else {
                    f.publish({ status: event === 'renewed' ? 'verifying' : 'signed_out', account: null });
                    f.publish(authenticated(RENEWED));
                }
            });
            await action.run(f);
            expect(fenced).toBe(true);
            expect(f.controller.getState()).toMatchObject({ accountMode: null, busy: false, available: true });
            for (const method of Object.values(f.native)) expect(method).not.toHaveBeenCalled();
            expect(f.reverifyForPairing).not.toHaveBeenCalled();
        },
    );

    it.each(['hidden', 'verifying', 'renewed', 'logout', 'account-switch', 'device-switch', 'dispose'] as const)(
        'clears the displayed account mode immediately on %s',
        async (event) => {
            const f = fixture(true, true);
            await f.controller.requireProtected();
            expect(f.controller.getState().accountMode).toBe('protected-required');
            for (const method of Object.values(f.native)) method.mockClear();
            if (event === 'hidden') f.controller.setVisible(false);
            else if (event === 'dispose') f.controller.dispose();
            else if (event === 'renewed') f.publish(authenticated(RENEWED));
            else if (event === 'account-switch' || event === 'device-switch')
                f.publish({
                    ...authenticated(RENEWED),
                    account: {
                        ...authenticated(RENEWED).account!,
                        [event === 'account-switch' ? 'accountId' : 'deviceId']: OTHER_ID,
                    },
                });
            else f.publish({ status: event === 'logout' ? 'signed_out' : 'verifying', account: null });
            expect(f.controller.getState().accountMode).toBeNull();
            for (const method of Object.values(f.native)) expect(method).not.toHaveBeenCalled();
            expect(f.reverifyForPairing).not.toHaveBeenCalled();
        },
    );

    it.each(
        accountModeActions.flatMap((action) =>
            ['hide-show', 'renewed', 'logout-login', 'unavailable', 'account-switch', 'device-switch', 'dispose'].map(
                (event) => ({ action, event }),
            ),
        ),
    )('keeps the $action.name barrier and discards its held completion after $event', async ({ action, event }) => {
        const f = fixture(true, true);
        const gate = deferred();
        const displayedModes: ('legacy-permitted' | 'protected-required' | null)[] = [];
        f.controller.subscribe((state) => displayedModes.push(state.accountMode));
        f.native[action.method].mockImplementationOnce(() => gate.promise);
        const pending = action.run(f);
        expect(f.native[action.method]).toHaveBeenCalledExactlyOnceWith({ credentialBinding: BINDING });
        if (event === 'hide-show') {
            f.controller.setVisible(false);
            f.controller.setVisible(true);
        } else if (event === 'dispose') f.controller.dispose();
        else if (event === 'unavailable') f.publish({ status: 'unavailable', account: null });
        else if (event === 'renewed' || event === 'logout-login') {
            f.publish({ status: event === 'renewed' ? 'verifying' : 'signed_out', account: null });
            f.publish(authenticated(RENEWED));
        } else
            f.publish({
                ...authenticated(RENEWED),
                account: {
                    ...authenticated(RENEWED).account!,
                    [event === 'account-switch' ? 'accountId' : 'deviceId']: OTHER_ID,
                },
            });
        expect(f.controller.getState()).toMatchObject({ accountMode: null, busy: true });
        const callsAtFence = Object.values(f.native).map((method) => method.mock.calls.length);
        const publicationFence = displayedModes.length;
        await f.controller.requireProtected();
        await f.controller.refreshAccountMode();
        await f.controller.readState();
        await f.controller.receive();
        expect(Object.values(f.native).map((method) => method.mock.calls.length)).toEqual(callsAtFence);
        gate.resolve(accountMode('protected-required'));
        await pending;
        expect(Object.values(f.native).map((method) => method.mock.calls.length)).toEqual(callsAtFence);
        expect(f.controller.getState().accountMode).toBeNull();
        expect(displayedModes.slice(publicationFence).every((mode) => mode === null)).toBe(true);
        if (event !== 'dispose') expect(f.controller.getState().busy).toBe(false);
        expect(f.reverifyForPairing).not.toHaveBeenCalled();
    });

    it.each(accountModeActions)(
        'releases a rejected old $name action without adopting its failure after Auth renewal',
        async (action) => {
            const f = fixture(true, true);
            const gate = deferred();
            f.native[action.method].mockImplementationOnce(() => gate.promise);
            const pending = action.run(f);
            f.publish({ status: 'verifying', account: null });
            f.publish(authenticated(RENEWED));
            await f.controller.refreshAccountMode();
            expect(f.controller.getState()).toMatchObject({ accountMode: null, busy: true });
            gate.reject(new Error('private-mode-error-canary'));
            await pending;
            expect(f.controller.getState()).toMatchObject({
                accountMode: null,
                busy: false,
                notice: MESSAGING_NOTICES.idle,
            });
            expect(JSON.stringify(f.controller.getState())).not.toContain('private-mode-error-canary');
            await f.controller.refreshAccountMode();
            expect(f.native.messageAccountMode).toHaveBeenLastCalledWith({ credentialBinding: RENEWED });
            expect(f.controller.getState().accountMode).toBe('legacy-permitted');
            expect(f.reverifyForPairing).not.toHaveBeenCalled();
        },
    );

    it.each(accountModeActions)(
        'allows only the admitted $name action and does not queue other clicks',
        async (action) => {
            const f = fixture();
            const gate = deferred();
            f.controller.setDraft('no preparation while account mode is pending');
            f.native[action.method].mockImplementationOnce(() => gate.promise);
            const pending = action.run(f);
            await f.controller.requireProtected();
            await f.controller.refreshAccountMode();
            await f.controller.readState();
            await f.controller.registerDevice();
            await f.controller.claimPeer();
            await f.controller.refreshPolicy();
            await f.controller.readThread();
            await f.controller.sendText();
            await f.controller.prepareOnly();
            await f.controller.receive();
            expect(f.native[action.method]).toHaveBeenCalledExactlyOnceWith({ credentialBinding: BINDING });
            for (const [method, mock] of Object.entries(f.native))
                if (method !== action.method) expect(mock).not.toHaveBeenCalled();
            expect(f.createMessageId).not.toHaveBeenCalled();
            gate.resolve(accountMode(action.expectedMode));
            await pending;
            expect(f.controller.getState()).toMatchObject({ busy: false, accountMode: action.expectedMode });
            for (const [method, mock] of Object.entries(f.native))
                if (method !== action.method) expect(mock).not.toHaveBeenCalled();
        },
    );

    it('does not admit either account-mode action while another native action is held', async () => {
        const f = fixture();
        const gate = deferred();
        f.native.messageRegisterDevice.mockImplementationOnce(() => gate.promise);
        const pending = f.controller.registerDevice();
        await f.controller.requireProtected();
        await f.controller.refreshAccountMode();
        expect(f.native.messageRequireProtected).not.toHaveBeenCalled();
        expect(f.native.messageAccountMode).not.toHaveBeenCalled();
        gate.resolve(facts());
        await pending;
        expect(f.controller.getState()).toMatchObject({ busy: false, accountMode: null });
    });
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
            envelopeSha256: ENVELOPE_SHA256,
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

describe('explicit prepare-only pending send — injected fixtures, not physical continuity evidence', () => {
    it('prepares one exact durable pending row and public envelope hash without uploading', async () => {
        const f = fixture(true, true);
        const draft = 'manual pending-send fixture';
        f.controller.setDraft(draft);
        await f.controller.prepareOnly();
        expect(f.native.messageThread).toHaveBeenCalledTimes(2);
        expect(f.native.messageThread.mock.invocationCallOrder[0]).toBeLessThan(
            f.native.messageState.mock.invocationCallOrder[0],
        );
        expect(f.native.messageState.mock.invocationCallOrder[0]).toBeLessThan(
            f.native.messageRefreshPolicy.mock.invocationCallOrder[0],
        );
        expect(f.native.messageRefreshPolicy.mock.invocationCallOrder[0]).toBeLessThan(
            f.createMessageId.mock.invocationCallOrder[0],
        );
        expect(f.native.messagePrepareText.mock.invocationCallOrder[0]).toBeLessThan(
            f.native.messageThread.mock.invocationCallOrder[1],
        );
        expect(f.native.messagePrepareText).toHaveBeenCalledExactlyOnceWith({
            credentialBinding: BINDING,
            clientMessageId: ID,
            text: draft,
        });
        expect(f.createMessageId).toHaveBeenCalledTimes(1);
        expect(f.controller.getState()).toMatchObject({
            busy: false,
            draft: '',
            attempt: { clientMessageId: ID, text: draft },
            thread: { messages: [{ ...outgoing(), text: draft }] },
        });
        expect(f.controller.getState().notice).toBe(MESSAGING_NOTICES.prepared);
        expect(f.reverifyForPairing).not.toHaveBeenCalled();
        expect(f.native.messageSendPending).not.toHaveBeenCalled();
        expect(f.native.messageSyncInbox).not.toHaveBeenCalled();
        f.controller.setDraft('replacement');
        await f.controller.prepareOnly();
        await f.controller.sendText();
        expect(f.native.messagePrepareText).toHaveBeenCalledTimes(1);
        expect(f.createMessageId).toHaveBeenCalledTimes(1);
        expect(f.native.messageSendPending).not.toHaveBeenCalled();
        expect(f.controller.getState().attempt).toEqual({ clientMessageId: ID, text: draft });
    });

    it('uploads the prepared ID only through a later explicit retry without new preparation', async () => {
        const f = fixture();
        f.controller.setDraft('same committed pending text');
        await f.controller.prepareOnly();
        expect(f.native.messageSendPending).not.toHaveBeenCalled();
        await f.controller.retryPending();
        expect(f.native.messageSendPending).toHaveBeenCalledExactlyOnceWith({
            credentialBinding: BINDING,
            clientMessageId: ID,
        });
        expect(f.native.messagePrepareText).toHaveBeenCalledTimes(1);
        expect(f.createMessageId).toHaveBeenCalledTimes(1);
        expect(f.controller.getState()).toMatchObject({ attempt: null, notice: MESSAGING_NOTICES.accepted });
    });

    it('a fresh controller explicitly restores and retries the retained pending row under fresh same-owner Auth', async () => {
        // Controller construction over retained injected rows only. This is
        // not process, native sealed-store or physical restart evidence.
        const f = fixture(true, true);
        const draft = 'same pending row after controller reconstruction';
        f.controller.setDraft(draft);
        await f.controller.prepareOnly();
        const original = { ...outgoing(), text: draft };
        expect(f.threadResponse().messages).toEqual([original]);
        expect(f.native.messageSendPending).not.toHaveBeenCalled();
        f.controller.dispose();
        f.publish(authenticated(RENEWED)); // Same account/device; a new expected credential binding.
        for (const method of Object.values(f.native)) method.mockClear();
        const replacementId = vi.fn(() => OTHER_ID);
        const resumed = new ResearchMessagingController({
            auth: f.auth,
            native: f.native,
            supported: () => true,
            createMessageId: replacementId,
        });
        controllers.push(resumed);
        for (const method of Object.values(f.native)) expect(method).not.toHaveBeenCalled();
        expect(replacementId).not.toHaveBeenCalled();
        expect(resumed.getState()).toMatchObject({
            available: true,
            busy: false,
            thread: null,
            attempt: null,
            facts: null,
            policy: null,
            inboxReport: null,
            draft: '',
            notice: MESSAGING_NOTICES.idle,
        });
        expect(researchSendSetupReady(resumed.getState().facts)).toBe(false);

        await resumed.readThread();
        expect(f.native.messageThread).toHaveBeenCalledExactlyOnceWith({ credentialBinding: RENEWED });
        expect(resumed.getState()).toMatchObject({
            thread: { credentialBinding: RENEWED, messages: [original] },
            attempt: { clientMessageId: ID, text: draft },
            facts: null,
            policy: null,
            notice: MESSAGING_NOTICES.uncertain,
        });
        expect(resumed.getState().thread?.messages[0]).toEqual(original);
        expect(f.native.messageState).not.toHaveBeenCalled();
        expect(f.native.messageRefreshPolicy).not.toHaveBeenCalled();
        expect(f.native.messagePrepareText).not.toHaveBeenCalled();
        expect(f.native.messageSendPending).not.toHaveBeenCalled();

        await resumed.retryPending();
        expect(f.native.messageRefreshPolicy).toHaveBeenCalledExactlyOnceWith({ credentialBinding: RENEWED });
        expect(f.native.messageSendPending).toHaveBeenCalledExactlyOnceWith({
            credentialBinding: RENEWED,
            clientMessageId: ID,
        });
        expect(f.native.messageRefreshPolicy.mock.invocationCallOrder[0]).toBeLessThan(
            f.native.messageSendPending.mock.invocationCallOrder[0],
        );
        expect(f.native.messagePrepareText).not.toHaveBeenCalled();
        expect(replacementId).not.toHaveBeenCalled();
        expect(f.createMessageId).toHaveBeenCalledTimes(1); // Only the original controller prepared.
        expect(f.reverifyForPairing).not.toHaveBeenCalled();
        for (const method of Object.values(f.native))
            for (const [options] of method.mock.calls) expect(options.credentialBinding).toBe(RENEWED);
        expect(resumed.getState()).toMatchObject({
            attempt: null,
            facts: null,
            notice: MESSAGING_NOTICES.accepted,
            thread: { messages: [{ ...original, delivery: 'serverAccepted' }] },
        });
    });

    it.each(unreadySetups)('keeps the draft with no attempt or upload for $name', async ({ patch }) => {
        const f = fixture();
        f.native.messageState.mockResolvedValueOnce({ ...facts(), ...patch });
        f.controller.setDraft('not yet admitted for preparation');
        await f.controller.prepareOnly();
        expect(f.controller.getState()).toMatchObject({
            busy: false,
            draft: 'not yet admitted for preparation',
            attempt: null,
        });
        expect(f.createMessageId).not.toHaveBeenCalled();
        expect(f.native.messageRefreshPolicy).not.toHaveBeenCalled();
        expect(f.native.messagePrepareText).not.toHaveBeenCalled();
        expect(f.native.messageSendPending).not.toHaveBeenCalled();
    });

    it.each(['ownerRevoked', 'peerRevoked', 'blockedByMe', 'blockedByPeer'] as const)(
        'refuses fresh %s policy before preparing',
        async (flag) => {
            const f = fixture();
            f.native.messageRefreshPolicy.mockResolvedValueOnce({
                status: 'policy',
                credentialBinding: BINDING,
                policy: { ...CLEAR, [flag]: true },
            });
            f.controller.setDraft('draft retained on policy refusal');
            await f.controller.prepareOnly();
            expect(f.controller.getState()).toMatchObject({
                attempt: null,
                draft: 'draft retained on policy refusal',
                notice: MESSAGING_NOTICES.unavailable,
            });
            expect(f.createMessageId).not.toHaveBeenCalled();
            expect(f.native.messagePrepareText).not.toHaveBeenCalled();
            expect(f.native.messageSendPending).not.toHaveBeenCalled();
        },
    );

    it('discovers existing native pending before setup and blocks replacement preparation or upload', async () => {
        const f = fixture();
        f.setRows([{ ...outgoing(), text: 'previous durable attempt' }]);
        f.controller.setDraft('replacement must not be prepared');
        await f.controller.prepareOnly();
        expect(f.controller.getState()).toMatchObject({
            attempt: { clientMessageId: ID, text: 'previous durable attempt' },
            draft: '',
            notice: MESSAGING_NOTICES.uncertain,
        });
        expect(f.native.messageThread).toHaveBeenCalledExactlyOnceWith({ credentialBinding: BINDING });
        expect(f.native.messageState).not.toHaveBeenCalled();
        expect(f.native.messageRefreshPolicy).not.toHaveBeenCalled();
        expect(f.createMessageId).not.toHaveBeenCalled();
        expect(f.native.messagePrepareText).not.toHaveBeenCalled();
        expect(f.native.messageSendPending).not.toHaveBeenCalled();
    });

    it('does not prepare when fresh setup is unavailable, even if earlier setup was ready', async () => {
        const f = fixture();
        await f.controller.readState();
        f.native.messageState.mockResolvedValueOnce({ status: 'unavailable', reason: 'unavailable' });
        f.controller.setDraft('preserved until fresh setup is available');
        await f.controller.prepareOnly();
        expect(f.controller.getState()).toMatchObject({
            attempt: null,
            draft: 'preserved until fresh setup is available',
            notice: MESSAGING_NOTICES.unavailable,
        });
        expect(f.createMessageId).not.toHaveBeenCalled();
        expect(f.native.messageRefreshPolicy).not.toHaveBeenCalled();
        expect(f.native.messagePrepareText).not.toHaveBeenCalled();
        expect(f.native.messageSendPending).not.toHaveBeenCalled();
    });

    it.each(['hidden', 'logout', 'dispose'] as const)(
        'does no preparation when an admission observer immediately triggers %s',
        async (event) => {
            const f = fixture();
            let fenced = false;
            const notices: string[] = [];
            f.controller.setDraft('cancel before native dispatch');
            f.controller.subscribe((state) => {
                notices.push(state.notice);
                if (!state.busy || fenced) return;
                fenced = true;
                if (event === 'hidden') f.controller.setVisible(false);
                else if (event === 'dispose') f.controller.dispose();
                else f.publish({ status: 'signed_out', account: null });
            });
            await f.controller.prepareOnly();
            expect(fenced).toBe(true);
            expect(f.createMessageId).not.toHaveBeenCalled();
            for (const method of Object.values(f.native)) expect(method).not.toHaveBeenCalled();
            expect(f.controller.getState()).toMatchObject({ thread: null, attempt: null, draft: '' });
            expect(notices).not.toContain(MESSAGING_NOTICES.prepared);
        },
    );

    it.each([
        { name: 'different ID', echo: { status: 'prepared', credentialBinding: BINDING, clientMessageId: OTHER_ID } },
        { name: 'wrong binding', echo: { status: 'prepared', credentialBinding: RENEWED, clientMessageId: ID } },
        { name: 'wrong status', echo: { status: 'send_result', credentialBinding: BINDING, clientMessageId: ID } },
        {
            name: 'widened DTO',
            echo: { status: 'prepared', credentialBinding: BINDING, clientMessageId: ID, accepted: true },
        },
        { name: 'missing ID', echo: { status: 'prepared', credentialBinding: BINDING } },
        { name: 'nonobject', echo: null },
    ])('pins the original uncertain attempt after a $name preparation echo', async ({ echo }) => {
        const f = fixture();
        f.native.messagePrepareText.mockImplementationOnce(async (options) => {
            f.setRows([{ ...outgoing(), text: options.text }]);
            return echo;
        });
        f.controller.setDraft('exact admitted text');
        await f.controller.prepareOnly();
        expect(f.controller.getState()).toMatchObject({
            busy: false,
            attempt: { clientMessageId: ID, text: 'exact admitted text' },
            draft: '',
            thread: null,
            notice: MESSAGING_NOTICES.uncertain,
        });
        await f.controller.prepareOnly();
        await f.controller.sendText();
        expect(f.createMessageId).toHaveBeenCalledTimes(1);
        expect(f.native.messagePrepareText).toHaveBeenCalledTimes(1);
        expect(f.native.messageSendPending).not.toHaveBeenCalled();
    });

    it('pins an uncertain native preparation failure and reconciles its exact durable ID later', async () => {
        const f = fixture();
        f.native.messagePrepareText.mockImplementationOnce(async (options) => {
            f.setRows([{ ...outgoing(), text: options.text }]);
            throw new Error('fixture preparation echo lost after durability');
        });
        f.controller.setDraft('durable despite the lost echo');
        await f.controller.prepareOnly();
        expect(f.controller.getState()).toMatchObject({
            attempt: { clientMessageId: ID, text: 'durable despite the lost echo' },
            notice: MESSAGING_NOTICES.uncertain,
        });
        await f.controller.prepareOnly();
        expect(f.native.messagePrepareText).toHaveBeenCalledTimes(1);
        expect(f.native.messageSendPending).not.toHaveBeenCalled();
        await f.controller.retryPending();
        expect(f.native.messagePrepareText).toHaveBeenCalledTimes(1);
        expect(f.native.messageSendPending).toHaveBeenCalledExactlyOnceWith({
            credentialBinding: BINDING,
            clientMessageId: ID,
        });
    });

    it.each([
        { name: 'missing row', rows: [] },
        { name: 'different ID', rows: [{ ...outgoing(), clientMessageId: OTHER_ID, text: 'exact admitted text' }] },
        { name: 'different text', rows: [{ ...outgoing(), text: 'different native text' }] },
        { name: 'absent plaintext', rows: [{ ...outgoing(), text: null }] },
        { name: 'already accepted', rows: [{ ...outgoing('serverAccepted'), text: 'exact admitted text' }] },
        { name: 'already rejected', rows: [{ ...outgoing('rejected'), text: 'exact admitted text' }] },
        {
            name: 'two total outgoing pending rows',
            rows: [
                { ...outgoing(), text: 'exact admitted text' },
                { ...outgoing('pending', OTHER_ID), text: 'unexpected second pending message' },
            ],
        },
        {
            name: 'incoming row',
            rows: [
                {
                    ...outgoing(),
                    direction: 'incoming',
                    delivery: 'received',
                    localCreatedAtMillis: null,
                    text: 'exact admitted text',
                },
            ],
        },
        {
            name: 'invalid envelope hash',
            rows: [{ ...outgoing(), text: 'exact admitted text', envelopeSha256: 'bad' }],
        },
    ])('refuses $name after preparation without clearing the original uncertain attempt', async ({ rows }) => {
        const f = fixture();
        f.native.messageThread
            .mockResolvedValueOnce(f.threadResponse())
            .mockResolvedValueOnce({ ...f.threadResponse(), messages: rows });
        f.controller.setDraft('exact admitted text');
        await f.controller.prepareOnly();
        expect(f.controller.getState()).toMatchObject({
            busy: false,
            attempt: { clientMessageId: ID, text: 'exact admitted text' },
            draft: '',
            thread: null,
            notice: MESSAGING_NOTICES.uncertain,
        });
        await f.controller.prepareOnly();
        await f.controller.sendText();
        expect(f.createMessageId).toHaveBeenCalledTimes(1);
        expect(f.native.messagePrepareText).toHaveBeenCalledTimes(1);
        expect(f.native.messageSendPending).not.toHaveBeenCalled();
    });

    it.each(['hidden', 'logout', 'dispose'] as const)(
        'keeps the admission barrier and discards a delayed preparation echo after %s',
        async (event) => {
            const f = fixture();
            const gate = deferred();
            const notices: string[] = [];
            f.controller.subscribe((state) => notices.push(state.notice));
            f.native.messagePrepareText.mockImplementationOnce(async (options) => {
                await gate.promise;
                f.setRows([{ ...outgoing(), text: options.text }]);
                return { status: 'prepared', credentialBinding: BINDING, clientMessageId: ID };
            });
            f.controller.setDraft('original pending fixture');
            const action = f.controller.prepareOnly();
            await settle();
            expect(f.native.messagePrepareText).toHaveBeenCalledTimes(1);
            if (event === 'hidden') {
                f.controller.setVisible(false);
                f.controller.setVisible(true);
            } else if (event === 'dispose') f.controller.dispose();
            else {
                f.publish({ status: 'signed_out', account: null });
                f.publish(authenticated(RENEWED));
            }
            const callsAtFence = Object.values(f.native).map((method) => method.mock.calls.length);
            f.controller.setDraft('replacement');
            await f.controller.prepareOnly();
            await f.controller.sendText();
            expect(Object.values(f.native).map((method) => method.mock.calls.length)).toEqual(callsAtFence);
            gate.resolve(undefined);
            await action;
            expect(Object.values(f.native).map((method) => method.mock.calls.length)).toEqual(callsAtFence);
            expect(f.controller.getState()).toMatchObject({ thread: null, attempt: null });
            expect(f.controller.getState().notice).not.toBe(MESSAGING_NOTICES.accepted);
            expect(f.controller.getState().notice).not.toBe(MESSAGING_NOTICES.prepared);
            expect(notices).not.toContain(MESSAGING_NOTICES.prepared);
            expect(f.native.messageSendPending).not.toHaveBeenCalled();
            if (event !== 'dispose') {
                f.controller.setDraft('replacement after old echo');
                await f.controller.prepareOnly();
                expect(f.controller.getState().attempt).toEqual({
                    clientMessageId: ID,
                    text: 'original pending fixture',
                });
            }
            expect(f.createMessageId).toHaveBeenCalledTimes(1);
            expect(f.native.messagePrepareText).toHaveBeenCalledTimes(1);
        },
    );

    it.each(['hide-show', 'reverify', 'logout'] as const)(
        'does not publish prepare-only success after a committed-thread observer triggers %s',
        async (event) => {
            const f = fixture();
            let fenced = false;
            const notices: string[] = [];
            f.controller.subscribe((state) => {
                notices.push(state.notice);
                if (!state.busy || state.thread?.messages[0]?.delivery !== 'pending' || fenced) return;
                fenced = true;
                if (event === 'hide-show') {
                    f.controller.setVisible(false);
                    f.controller.setVisible(true);
                } else {
                    f.publish({ status: event === 'logout' ? 'signed_out' : 'verifying', account: null });
                    f.publish(authenticated(RENEWED));
                }
            });
            f.controller.setDraft('original pending fixture');
            await f.controller.prepareOnly();
            expect(fenced).toBe(true);
            expect(f.controller.getState()).toMatchObject({ busy: false, thread: null, attempt: null, draft: '' });
            expect(notices).not.toContain(MESSAGING_NOTICES.accepted);
            expect(notices).not.toContain(MESSAGING_NOTICES.prepared);
            expect(f.controller.getState().notice).not.toBe(MESSAGING_NOTICES.prepared);
            expect(f.native.messageSendPending).not.toHaveBeenCalled();
            f.controller.setDraft('replacement after observer fence');
            await f.controller.prepareOnly();
            expect(f.controller.getState().attempt).toEqual({ clientMessageId: ID, text: 'original pending fixture' });
            expect(f.createMessageId).toHaveBeenCalledTimes(1);
            expect(f.native.messagePrepareText).toHaveBeenCalledTimes(1);
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
        f.controller.setDraft('unavailable runtime');
        await f.controller.prepareOnly();
        expect(f.controller.getState().available).toBe(false);
        for (const method of Object.values(f.native)) expect(method).not.toHaveBeenCalled();
        const signedOut = fixture();
        signedOut.publish({ status: 'signed_out', account: null });
        await signedOut.controller.ownPairingCard();
        signedOut.controller.setDraft('signed-out input');
        await signedOut.controller.prepareOnly();
        expect(signedOut.native.messagePairingCard).not.toHaveBeenCalled();
        expect(signedOut.native.messagePrepareText).not.toHaveBeenCalled();
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
            envelopeSha256: ENVELOPE_SHA256,
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
                envelopeSha256: 'b'.repeat(64),
            },
        ]);
        await f.controller.readThread();
        expect(list.querySelector('img')).toBeNull();
        expect(list.querySelector('script')).toBeNull();
        expect(list.querySelector('.message-text')?.textContent).toBe('<img src=x onerror=alert(1)>');
        expect(list.textContent).toContain('Relay accepted · not delivered or read');
        expect(list.textContent).toContain('Time unknown');
        expect(Array.from(list.querySelectorAll('.message-envelope-hash'), (row) => row.textContent)).toEqual([
            expect.stringContaining(ENVELOPE_SHA256),
            expect.stringContaining('b'.repeat(64)),
        ]);
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
        expect(f.controller.getState()).toMatchObject({ draft: '', attempt: null, thread: null, busy: true });
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
        '%s immediately clears private data and trust; only same-owner hide retains public fields',
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
                ownCard: event === 'hidden' ? { card: PUBLIC_CARD, fingerprint: FINGERPRINT } : null,
                peerCardInput: event === 'hidden' ? 'peer' : '',
                inspectedPeer: null,
                comparedOnOtherDevice: false,
                attempt: null,
                facts: null,
                policy: null,
            });
        },
    );
});

describe('public pairing continuity and explicit renewal — injected Auth/plugin fixtures only', () => {
    async function populatedFixture() {
        // Populate a previously verified view before exposing the new Auth
        // presentation/renewal methods. No synthetic renewal keeps private
        // state alive: each tested lifecycle fence must clear it immediately.
        const f = fixture();
        f.setRows([outgoing('serverAccepted')]);
        await f.controller.receive();
        await f.controller.refreshPolicy();
        await f.controller.ownPairingCard();
        f.controller.setPeerCardInput('raw peer card; no identity is inferred');
        await f.controller.inspectPeerCard();
        f.controller.setComparedOnOtherDevice(true);
        f.controller.setDraft('private draft must not survive');
        f.setRows([outgoing()]);
        await f.controller.readThread();
        expect(f.controller.getState()).toMatchObject({
            facts: facts(),
            policy: CLEAR,
            ownCard: { card: PUBLIC_CARD, fingerprint: FINGERPRINT },
            inspectedPeer: { card: PUBLIC_CARD, fingerprint: FINGERPRINT },
            comparedOnOtherDevice: true,
            // Durable pending reconciliation already clears its old draft.
            draft: '',
            attempt: { clientMessageId: ID },
            inboxReport: { stored: 0 },
        });
        f.auth.getPublicPairingOwner = f.getPublicPairingOwner;
        f.auth.reverifyForPairing = f.reverifyForPairing;
        return f;
    }

    it.each(['expired', 'verifying', 'renewed', 'hidden'] as const)(
        'retains only same-owner public export and raw peer text when %s',
        async (event) => {
            const f = await populatedFixture();
            if (event === 'hidden') f.controller.setVisible(false);
            else if (event === 'renewed') f.publish(authenticated(RENEWED));
            else f.publish({ status: event === 'expired' ? 'unavailable' : 'verifying', account: null });
            expect(f.controller.getState()).toMatchObject({
                ownCard: { card: PUBLIC_CARD, fingerprint: FINGERPRINT },
                peerCardInput: 'raw peer card; no identity is inferred',
                facts: null,
                policy: null,
                draft: '',
                thread: null,
                attempt: null,
                inboxReport: null,
                inspectedPeer: null,
                comparedOnOtherDevice: false,
                busy: false,
                available: event === 'renewed',
                pairingAvailable: event === 'expired' || event === 'renewed',
                publicCardsAvailable: event === 'expired' || event === 'renewed',
            });
            expect(f.reverifyForPairing).not.toHaveBeenCalled();
        },
    );

    it('retains public fields across expiry, reverify and clipboard-style hide/show, never restoring comparison', async () => {
        const f = await populatedFixture();
        f.publish({ status: 'unavailable', account: null });
        f.controller.setVisible(false);
        f.controller.setVisible(true);
        f.publish({ status: 'verifying', account: null });
        f.publish(authenticated(RENEWED));
        expect(f.controller.getState()).toMatchObject({
            available: true,
            pairingAvailable: true,
            publicCardsAvailable: true,
            ownCard: { card: PUBLIC_CARD, fingerprint: FINGERPRINT },
            peerCardInput: 'raw peer card; no identity is inferred',
            inspectedPeer: null,
            comparedOnOtherDevice: false,
            draft: '',
            thread: null,
            attempt: null,
        });
        await f.controller.confirmPeer();
        expect(f.native.messageConfirmPeer).not.toHaveBeenCalled();
        expect(f.reverifyForPairing).not.toHaveBeenCalled();
    });

    it('clears a nonempty private draft immediately on same-owner expiry while retaining raw public input', () => {
        const f = fixture(true, true);
        f.controller.setPeerCardInput('public peer input');
        f.controller.setDraft('private draft');
        expect(f.controller.getState().draft).toBe('private draft');
        f.publish({ status: 'unavailable', account: null });
        expect(f.controller.getState()).toMatchObject({ draft: '', peerCardInput: 'public peer input' });
        expect(f.reverifyForPairing).not.toHaveBeenCalled();
    });

    it.each(['logout', 'account-switch', 'device-switch', 'unsupported', 'dispose'] as const)(
        'drops public fields as well as private/trust state on %s',
        async (event) => {
            const f = await populatedFixture();
            if (event === 'dispose') f.controller.dispose();
            else if (event === 'logout' || event === 'unsupported')
                f.publish({ status: event === 'logout' ? 'signed_out' : 'unsupported', account: null });
            else
                f.publish({
                    ...authenticated(RENEWED),
                    account: {
                        ...authenticated(RENEWED).account!,
                        [event === 'account-switch' ? 'accountId' : 'deviceId']: OTHER_ID,
                    },
                });
            expect(f.controller.getState()).toMatchObject({
                ownCard: null,
                peerCardInput: '',
                inspectedPeer: null,
                comparedOnOtherDevice: false,
                facts: null,
                policy: null,
                draft: '',
                thread: null,
                attempt: null,
                inboxReport: null,
            });
            expect(f.reverifyForPairing).not.toHaveBeenCalled();
        },
    );

    it('does not retain expired public fields without a native-known presentation owner', async () => {
        const f = fixture();
        await f.controller.ownPairingCard();
        f.controller.setPeerCardInput('public peer');
        f.auth.reverifyForPairing = f.reverifyForPairing;
        f.publish({ status: 'unavailable', account: null });
        expect(f.controller.getState()).toMatchObject({
            ownCard: null,
            peerCardInput: '',
            available: false,
            publicCardsAvailable: false,
            pairingAvailable: false,
        });
        await f.controller.registerDevice();
        expect(f.reverifyForPairing).not.toHaveBeenCalled();
        expect(f.native.messageRegisterDevice).not.toHaveBeenCalled();
    });

    it('keeps public and setup permissions closed outside the supported native runtime despite owner metadata', async () => {
        const f = fixture(false, true);
        f.publish({ status: 'unavailable', account: null });
        f.controller.setPeerCardInput('public input outside native runtime');
        await f.controller.registerDevice();
        expect(f.controller.getState()).toMatchObject({
            available: false,
            pairingAvailable: false,
            publicCardsAvailable: false,
            peerCardInput: '',
        });
        expect(f.reverifyForPairing).not.toHaveBeenCalled();
        for (const method of Object.values(f.native)) expect(method).not.toHaveBeenCalled();
    });

    it.each([null, { accountId: 'not-a-uuid', deviceId: OTHER_ID }])(
        'refuses missing or malformed native-known owner metadata %j',
        async (owner) => {
            const f = fixture(true, true);
            f.setPublicOwner(owner);
            f.publish({ status: 'unavailable', account: null });
            f.controller.setPeerCardInput('public input');
            await f.controller.readState();
            expect(f.controller.getState()).toMatchObject({
                pairingAvailable: false,
                publicCardsAvailable: false,
                peerCardInput: '',
            });
            expect(f.reverifyForPairing).not.toHaveBeenCalled();
            for (const method of Object.values(f.native)) expect(method).not.toHaveBeenCalled();
        },
    );

    const setupActions = [
        { name: 'Read', method: 'messageState', run: (f: ReturnType<typeof fixture>) => f.controller.readState() },
        {
            name: 'Register',
            method: 'messageRegisterDevice',
            run: (f: ReturnType<typeof fixture>) => f.controller.registerDevice(),
        },
        {
            name: 'Export',
            method: 'messagePairingCard',
            run: (f: ReturnType<typeof fixture>) => f.controller.ownPairingCard(),
        },
        {
            name: 'Inspect',
            method: 'messageInspectPeerCard',
            run: (f: ReturnType<typeof fixture>) => f.controller.inspectPeerCard(),
        },
    ] as const;

    it.each(setupActions)('renews only the explicit $name action before one bound native dispatch', async (action) => {
        const f = fixture(true, true);
        f.controller.setPeerCardInput('detached raw public input');
        f.publish({ status: 'unavailable', account: null });
        expect(f.controller.getState()).toMatchObject({ available: false, pairingAvailable: true });
        await action.run(f);
        expect(f.reverifyForPairing).toHaveBeenCalledTimes(1);
        expect(f.native[action.method]).toHaveBeenCalledExactlyOnceWith(
            action.name === 'Inspect'
                ? { credentialBinding: RENEWED, card: 'detached raw public input' }
                : { credentialBinding: RENEWED },
        );
        for (const [method, mock] of Object.entries(f.native))
            if (method !== action.method) expect(mock).not.toHaveBeenCalled();
        expect(f.controller.getState()).toMatchObject({ available: true, busy: false });
    });

    it.each(setupActions)('fresh-renews $name even before the UI notices native lease expiry', async (action) => {
        const f = fixture(true, true);
        f.controller.setPeerCardInput('raw public input');
        expect(f.controller.getState().available).toBe(true);
        await action.run(f);
        expect(f.reverifyForPairing).toHaveBeenCalledTimes(1);
        expect(f.native[action.method]).toHaveBeenCalledTimes(1);
        expect(f.native[action.method].mock.calls[0][0].credentialBinding).toBe(RENEWED);
    });

    it.each(['null', 'throw'] as const)('does no native setup after renewal returns %s', async (failure) => {
        const f = fixture(true, true);
        f.publish({ status: 'unavailable', account: null });
        f.reverifyForPairing.mockImplementationOnce(async () => {
            f.publish({ status: 'verifying', account: null });
            f.publish({ status: 'unavailable', account: null });
            if (failure === 'throw') throw new Error('private fixture renewal failure');
            return null;
        });
        await f.controller.registerDevice();
        expect(f.reverifyForPairing).toHaveBeenCalledTimes(1);
        expect(f.controller.getState()).toMatchObject({ busy: false, facts: null, available: false });
        for (const method of Object.values(f.native)) expect(method).not.toHaveBeenCalled();
    });

    it('holds one action barrier through renewal, blocks edits and dispatches the bounded detached card once', async () => {
        const f = fixture(true, true);
        const gate = deferred();
        const raw = 'é'.repeat(2048); // Exactly 4096 UTF-8 bytes, not a parsed identity.
        f.controller.setPeerCardInput(raw);
        f.controller.setPeerCardInput(`${raw}x`);
        expect(f.controller.getState().peerCardInput).toBe(raw);
        f.publish({ status: 'unavailable', account: null });
        f.reverifyForPairing.mockImplementationOnce(async () => {
            f.publish({ status: 'verifying', account: null });
            await gate.promise;
            const renewed = authenticated(RENEWED);
            f.publish(renewed);
            return renewed.account;
        });
        const action = f.controller.inspectPeerCard();
        await settle();
        expect(f.controller.getState()).toMatchObject({ busy: true, available: false });
        f.controller.setPeerCardInput('replacement while renewing');
        f.controller.setComparedOnOtherDevice(true);
        await f.controller.inspectPeerCard();
        await f.controller.registerDevice();
        await f.controller.readState();
        await f.controller.ownPairingCard();
        expect(f.reverifyForPairing).toHaveBeenCalledTimes(1);
        expect(f.controller.getState()).toMatchObject({ peerCardInput: raw, comparedOnOtherDevice: false });
        for (const method of Object.values(f.native)) expect(method).not.toHaveBeenCalled();
        gate.resolve(undefined);
        await action;
        expect(f.native.messageInspectPeerCard).toHaveBeenCalledExactlyOnceWith({
            credentialBinding: RENEWED,
            card: raw,
        });
        expect(f.controller.getState()).toMatchObject({
            busy: false,
            peerCardInput: raw,
            comparedOnOtherDevice: false,
        });
        expect(f.native.messageRegisterDevice).not.toHaveBeenCalled();
    });

    it.each([
        'hide',
        'hide-show',
        'logout',
        'account-switch',
        'device-switch',
        'concurrent-binding',
        'dispose',
    ] as const)('cancels delayed setup after %s; no action is adopted by later Auth', async (event) => {
        const f = fixture(true, true);
        const gate = deferred();
        f.controller.setPeerCardInput('original public input');
        f.publish({ status: 'unavailable', account: null });
        f.reverifyForPairing.mockImplementationOnce(async () => {
            f.publish({ status: 'verifying', account: null });
            await gate.promise;
            return authenticated(RENEWED).account;
        });
        const action = f.controller.inspectPeerCard();
        await settle();
        if (event === 'hide' || event === 'hide-show') {
            f.controller.setVisible(false);
            if (event === 'hide-show') f.controller.setVisible(true);
            f.publish(authenticated(RENEWED));
        } else if (event === 'dispose') {
            f.controller.dispose();
            f.publish(authenticated(RENEWED));
        } else if (event === 'logout') f.publish({ status: 'signed_out', account: null });
        else if (event === 'concurrent-binding') f.publish(authenticated(OTHER_ID));
        else
            f.publish({
                ...authenticated(RENEWED),
                account: {
                    ...authenticated(RENEWED).account!,
                    [event === 'account-switch' ? 'accountId' : 'deviceId']: OTHER_ID,
                },
            });
        gate.resolve(undefined);
        await action;
        for (const method of Object.values(f.native)) expect(method).not.toHaveBeenCalled();
        expect(f.controller.getState()).toMatchObject({
            inspectedPeer: null,
            comparedOnOtherDevice: false,
            facts: null,
            draft: '',
            thread: null,
            attempt: null,
        });
        if (event !== 'dispose') expect(f.controller.getState().busy).toBe(false);
        expect(f.reverifyForPairing).toHaveBeenCalledTimes(1);
    });

    it('rejects a renewed account DTO whose binding does not equal the current native Auth binding', async () => {
        const f = fixture(true, true);
        f.publish({ status: 'unavailable', account: null });
        f.reverifyForPairing.mockImplementationOnce(async () => {
            f.publish(authenticated(RENEWED));
            return authenticated(BINDING).account;
        });
        await f.controller.registerDevice();
        expect(f.controller.getState()).toMatchObject({ busy: false, facts: null });
        for (const method of Object.values(f.native)) expect(method).not.toHaveBeenCalled();
    });

    it('rejects logout then same-owner login even when the delayed renewal matches the current account and binding', async () => {
        const f = fixture(true, true);
        const gate = deferred();
        f.controller.setPeerCardInput('old public input');
        f.publish({ status: 'unavailable', account: null });
        f.reverifyForPairing.mockImplementationOnce(async () => {
            f.publish({ status: 'verifying', account: null });
            await gate.promise;
            return authenticated(RENEWED).account;
        });
        const action = f.controller.registerDevice();
        await settle();
        f.publish({ status: 'signed_out', account: null });
        f.publish(authenticated(RENEWED));
        gate.resolve(undefined);
        await action;
        expect(f.controller.getState()).toMatchObject({
            available: true,
            busy: false,
            peerCardInput: '',
            facts: null,
        });
        expect(f.reverifyForPairing).toHaveBeenCalledTimes(1);
        for (const method of Object.values(f.native)) expect(method).not.toHaveBeenCalled();
    });

    it.each(['hide', 'dispose', 'logout'] as const)(
        'does not start renewal when a busy-state observer synchronously triggers %s',
        async (event) => {
            const f = fixture(true, true);
            let fenced = false;
            f.controller.subscribe((state) => {
                if (!state.busy || fenced) return;
                fenced = true;
                if (event === 'hide') f.controller.setVisible(false);
                else if (event === 'dispose') f.controller.dispose();
                else f.publish({ status: 'signed_out', account: null });
            });
            await f.controller.readState();
            expect(fenced).toBe(true);
            expect(f.reverifyForPairing).not.toHaveBeenCalled();
            for (const method of Object.values(f.native)) expect(method).not.toHaveBeenCalled();
        },
    );

    it('does not confirm under observer-renewed Auth even when the renewed binding is unchanged', async () => {
        const f = fixture(true, true);
        f.controller.setPeerCardInput('public peer input');
        await f.controller.inspectPeerCard();
        f.controller.setComparedOnOtherDevice(true);
        const revision = f.controller.getState().revision;
        let fenced = false;
        f.controller.subscribe((state) => {
            if (fenced || state.revision <= revision || state.inspectedPeer !== null) return;
            fenced = true;
            f.publish(authenticated(RENEWED));
        });
        await f.controller.confirmPeer();
        expect(fenced).toBe(true);
        expect(f.reverifyForPairing).toHaveBeenCalledTimes(1); // Explicit Inspect only.
        expect(f.native.messageConfirmPeer).not.toHaveBeenCalled();
        expect(f.controller.getState()).toMatchObject({
            available: true,
            ownCard: null,
            peerCardInput: '',
            inspectedPeer: null,
            comparedOnOtherDevice: false,
            facts: null,
        });
    });

    it.each(['send', 'prepare-only', 'confirm', 'claim', 'receive', 'policy', 'thread', 'retry'] as const)(
        '%s never renews automatically from an expired account or retained public fields',
        async (operation) => {
            const f = await populatedFixture();
            f.publish({ status: 'unavailable', account: null });
            for (const method of Object.values(f.native)) method.mockClear();
            if (operation === 'send') await f.controller.sendText();
            else if (operation === 'prepare-only') await f.controller.prepareOnly();
            else if (operation === 'confirm') await f.controller.confirmPeer();
            else if (operation === 'claim') await f.controller.claimPeer();
            else if (operation === 'receive') await f.controller.receive();
            else if (operation === 'policy') await f.controller.refreshPolicy();
            else if (operation === 'thread') await f.controller.readThread();
            else await f.controller.retryPending();
            expect(f.reverifyForPairing).not.toHaveBeenCalled();
            for (const method of Object.values(f.native)) expect(method).not.toHaveBeenCalled();
            expect(f.controller.getState()).toMatchObject({
                ownCard: { card: PUBLIC_CARD, fingerprint: FINGERPRINT },
                peerCardInput: 'raw peer card; no identity is inferred',
                inspectedPeer: null,
                comparedOnOtherDevice: false,
            });
        },
    );

    it.each(['send', 'prepare-only', 'claim', 'receive', 'policy', 'thread', 'retry'] as const)(
        'available %s still uses its original binding without a pairing renewal',
        async (operation) => {
            const f = fixture(true, true);
            if (operation === 'send' || operation === 'prepare-only' || operation === 'retry')
                f.controller.setDraft('explicit private message');
            if (operation === 'send') await f.controller.sendText();
            else if (operation === 'prepare-only') await f.controller.prepareOnly();
            else if (operation === 'claim') await f.controller.claimPeer();
            else if (operation === 'receive') await f.controller.receive();
            else if (operation === 'policy') await f.controller.refreshPolicy();
            else if (operation === 'thread') await f.controller.readThread();
            else {
                f.native.messageSendPending.mockRejectedValueOnce(new Error('fixture receipt uncertainty'));
                await f.controller.sendText();
                await f.controller.retryPending();
            }
            expect(f.reverifyForPairing).not.toHaveBeenCalled();
            for (const method of Object.values(f.native))
                for (const [options] of method.mock.calls) expect(options.credentialBinding).toBe(BINDING);
            expect(Object.values(f.native).some((method) => method.mock.calls.length > 0)).toBe(true);
        },
    );

    it('retained card inspection after renewal still requires a fresh human comparison before confirmation', async () => {
        const f = await populatedFixture();
        f.publish({ status: 'unavailable', account: null });
        f.native.messageConfirmPeer.mockClear();
        await f.controller.inspectPeerCard();
        expect(f.controller.getState()).toMatchObject({
            inspectedPeer: { card: PUBLIC_CARD, fingerprint: FINGERPRINT },
            comparedOnOtherDevice: false,
        });
        await f.controller.confirmPeer();
        expect(f.native.messageConfirmPeer).not.toHaveBeenCalled();
        f.controller.setComparedOnOtherDevice(true);
        await f.controller.confirmPeer();
        expect(f.native.messageConfirmPeer).toHaveBeenCalledExactlyOnceWith({
            credentialBinding: RENEWED,
            card: PUBLIC_CARD,
            confirmedFingerprint: FINGERPRINT,
        });
        expect(f.reverifyForPairing).toHaveBeenCalledTimes(1);
        expect(f.controller.getState()).toMatchObject({
            ownCard: null,
            peerCardInput: '',
            comparedOnOtherDevice: false,
        });
    });
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
        name: 'prepare-only preflight',
        method: 'messageThread',
        start: (f) => {
            f.controller.setDraft('text');
            return f.controller.prepareOnly();
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
        name: 'prepare-only setup',
        method: 'messageState',
        start: (f) => {
            f.controller.setDraft('text');
            return f.controller.prepareOnly();
        },
        response: () => facts(),
    },
    {
        name: 'prepare-only policy',
        method: 'messageRefreshPolicy',
        start: (f) => {
            f.controller.setDraft('text');
            return f.controller.prepareOnly();
        },
        response: () => ({ status: 'policy', credentialBinding: BINDING, policy: { ...CLEAR } }),
    },
    {
        name: 'prepare-only prepare',
        method: 'messagePrepareText',
        start: (f) => {
            f.controller.setDraft('text');
            return f.controller.prepareOnly();
        },
        response: () => ({ status: 'prepared', credentialBinding: BINDING, clientMessageId: ID }),
    },
    {
        name: 'prepare-only durable thread',
        method: 'messageThread',
        secondThread: true,
        start: (f) => {
            f.controller.setDraft('text');
            return f.controller.prepareOnly();
        },
        response: () => ({
            status: 'thread',
            credentialBinding: BINDING,
            messages: [{ ...outgoing(), text: 'text' }],
            outgoingCapacity: 16,
            incomingCapacity: 16,
            unresolvedCount: 0,
        }),
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
        const notices: string[] = [];
        f.controller.subscribe((state) => notices.push(state.notice));
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
        expect(notices).not.toContain(MESSAGING_NOTICES.prepared);
        expect(f.controller.getState().notice).not.toBe(MESSAGING_NOTICES.prepared);
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
        if (
            [
                'send policy',
                'send preflight',
                'send setup',
                'prepare-only policy',
                'prepare-only preflight',
                'prepare-only setup',
            ].includes(phase.name)
        )
            expect(f.native.messagePrepareText).not.toHaveBeenCalled();
        if (phase.name === 'send setup' || phase.name === 'prepare-only setup') {
            expect(f.createMessageId).not.toHaveBeenCalled();
            expect(f.native.messageRefreshPolicy).not.toHaveBeenCalled();
            expect(f.controller.getState()).toMatchObject({ draft: 'text', attempt: null, facts: null });
        }
        if (phase.name === 'prepare' || phase.name.startsWith('prepare-only'))
            expect(f.native.messageSendPending).not.toHaveBeenCalled();
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
    it.each([
        { name: 'missing', value: undefined, omit: true },
        { name: 'undefined', value: undefined, omit: false },
        { name: 'null', value: null, omit: false },
        { name: 'number', value: 123, omit: false },
        { name: 'array', value: [ENVELOPE_SHA256], omit: false },
        { name: 'uppercase', value: ENVELOPE_SHA256.toUpperCase(), omit: false },
        { name: 'short', value: 'a'.repeat(63), omit: false },
        { name: 'long', value: 'a'.repeat(65), omit: false },
        { name: 'nonhex', value: 'g'.repeat(64), omit: false },
        { name: 'trailing newline', value: `${ENVELOPE_SHA256}\n`, omit: false },
        { name: 'markup', value: '<img src=x onerror=alert(1)>', omit: false },
    ])(
        'rejects a $name envelope hash for the entire thread before publishing valid preceding content',
        async ({ value, omit }) => {
            const f = fixture();
            const incoming = {
                ...outgoing(),
                clientMessageId: OTHER_ID,
                direction: 'incoming',
                delivery: 'received',
                localCreatedAtMillis: null,
                envelopeSha256: value,
            };
            const invalidRow = omit
                ? Object.fromEntries(Object.entries(incoming).filter(([key]) => key !== 'envelopeSha256'))
                : incoming;
            f.native.messageThread.mockResolvedValueOnce({
                ...f.threadResponse(),
                messages: [outgoing('serverAccepted'), invalidRow],
            });
            await f.controller.readThread();
            expect(f.controller.getState()).toMatchObject({ thread: null, notice: MESSAGING_NOTICES.unavailable });
        },
    );

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
    it('prepare-only refuses blank or oversized text without IDs, native preparation or upload', async () => {
        const f = fixture();
        f.controller.setDraft(' \n\t');
        await f.controller.prepareOnly();
        f.controller.setDraft('é'.repeat(8193));
        await f.controller.prepareOnly();
        expect(f.createMessageId).not.toHaveBeenCalled();
        expect(f.native.messagePrepareText).not.toHaveBeenCalled();
        expect(f.native.messageSendPending).not.toHaveBeenCalled();
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
