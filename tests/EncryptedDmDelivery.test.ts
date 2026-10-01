import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    DM_ENVELOPE_PROTOCOL,
    DM_ENVELOPE_VERSION,
    encodeDirectMessageEnvelope,
} from '../services/chat/e2ee/directMessageEnvelope';
import {
    createEncryptedDmDeliveryCoordinator,
    type EncryptedDmDeliveryDependencies,
    type EncryptedDmDeliveryGuard,
    type EncryptedDmDeliverySession,
    type EncryptedDmOutboxRecord,
    type EncryptedDmPeerIdentity,
} from '../services/chat/e2ee/encryptedDmDelivery';

// Mock framing bytes only: these tests prove no cryptographic or native guarantees.
const frame = {
    version: DM_ENVELOPE_VERSION,
    protocol: DM_ENVELOPE_PROTOCOL,
    messageType: 'prekey' as const,
    clientMessageId: 'message-1',
    senderDeviceId: 'alice-ios',
    recipientDeviceId: 'bob-ios',
    ciphertext: 'AQIDBA==',
};
const session: EncryptedDmDeliverySession = { userId: 'alice', senderDeviceId: 'alice-ios', generation: 7 };

function record(): EncryptedDmOutboxRecord {
    return {
        ownerUserId: 'alice',
        ownerSessionGeneration: 7,
        recipientUserId: 'bob',
        recipientIdentityKeyId: 'accepted-bob-key-1',
        recipientIdentityGeneration: 1,
        serializedEnvelope: encodeDirectMessageEnvelope(frame),
    };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

function harness(timeoutMs = 1000) {
    const state: { session: EncryptedDmDeliverySession | null; peer: EncryptedDmPeerIdentity | null } = {
        session: { ...session },
        peer: { identityKeyId: 'accepted-bob-key-1', status: 'accepted', generation: 1 },
    };
    const send = vi.fn<EncryptedDmDeliveryDependencies['send']>(async (item) => ({ ...item, accepted: true }));
    const confirm = vi.fn<EncryptedDmDeliveryDependencies['confirmServerAcceptance']>(async () => true);
    const confirmRejection = vi.fn<EncryptedDmDeliveryDependencies['confirmServerRejection']>(async () => true);
    const dependencies: EncryptedDmDeliveryDependencies = {
        getCurrentSession: () => state.session,
        getPeerIdentity: (recipientUserId, recipientDeviceId) => {
            if (recipientUserId !== 'bob' || recipientDeviceId !== 'bob-ios') return null;
            return state.peer;
        },
        send,
        confirmServerAcceptance: confirm,
        confirmServerRejection: confirmRejection,
    };
    return {
        state,
        send,
        confirm,
        confirmRejection,
        dependencies,
        coordinator: createEncryptedDmDeliveryCoordinator(dependencies, timeoutMs),
    };
}

afterEach(() => vi.useRealTimers());

describe('isolated ciphertext outbox delivery (mock adapters, not functioning E2EE)', () => {
    it.each([
        { version: 1, protocol: 'signal-triple-ratchet' },
        { version: 2, protocol: 'signal-triple-ratchet' },
        { version: 1, protocol: 'olm-v1' },
        { version: 2, protocol: 'olm-v2' },
        { version: 2, protocol: 'megolm-v1' },
    ])('never uploads or acknowledges an incompatible stored envelope: %j', async (patch) => {
        const h = harness();
        const item = { ...record(), serializedEnvelope: JSON.stringify({ ...frame, ...patch }) };
        expect(await h.coordinator.deliver(item, session)).toBe('invalid-record');
        expect(h.send).not.toHaveBeenCalled();
        expect(h.confirm).not.toHaveBeenCalled();
        expect(h.confirmRejection).not.toHaveBeenCalled();
    });

    it('confirms only an exact server acknowledgement and passes frozen ciphertext-only copies', async () => {
        const h = harness();
        const item = record();
        expect(await h.coordinator.deliver(item, session)).toBe('accepted');
        const [sent, guard] = h.send.mock.calls[0];
        expect(sent).toEqual(item);
        expect(sent).not.toBe(item);
        expect(Object.isFrozen(sent)).toBe(true);
        expect(Object.isFrozen(guard.session)).toBe(true);
        expect(Object.isFrozen(guard)).toBe(true);
        expect(h.confirm).toHaveBeenCalledExactlyOnceWith(sent, guard);
        expect(guard.isCurrent()).toBe(false); // Attempt lease ends even after success.
        expect(guard.signal.aborted).toBe(true);
    });

    it('snapshots caller-owned records and session objects before asynchronous work', async () => {
        const h = harness();
        const item = { ...record() };
        const callerSession = { ...session };
        const sent = record();
        const response = deferred<unknown>();
        h.send.mockReturnValueOnce(response.promise);
        const pending = h.coordinator.deliver(item, callerSession);
        item.recipientUserId = 'mallory';
        item.serializedEnvelope = 'PRIVATE TEXT';
        callerSession.userId = 'mallory';
        response.resolve({ ...sent, accepted: true });
        expect(await pending).toBe('accepted');
        expect(h.confirm.mock.calls[0][0]).toEqual(sent);
    });

    it('retries the exact serialized ciphertext and identifiers after an uncertain network failure', async () => {
        const h = harness();
        h.send.mockRejectedValueOnce(new Error('socket timeout after acceptance: PRIVATE TEXT'));
        const item = record();
        expect(await h.coordinator.deliver(item, session)).toBe('retryable-failure');
        expect(h.confirm).not.toHaveBeenCalled();
        expect(await h.coordinator.deliver(item, session)).toBe('accepted');
        expect(h.send.mock.calls.map(([sent]) => sent)).toEqual([item, item]);
        expect(h.send.mock.calls[0][0].serializedEnvelope).toBe(h.send.mock.calls[1][0].serializedEnvelope);
    });

    it.each(['false', 'throw'])('keeps confirmation failure retryable (%s)', async (failure) => {
        const h = harness();
        if (failure === 'false') h.confirm.mockResolvedValueOnce(false);
        else h.confirm.mockRejectedValueOnce({ message: 'PRIVATE TEXT', sessionState: 'SECRET KEY' });
        const item = record();
        expect(await h.coordinator.deliver(item, session)).toBe('retryable-failure');
        expect(await h.coordinator.deliver(item, session)).toBe('accepted');
        expect(h.send.mock.calls.map(([sent]) => sent.serializedEnvelope)).toEqual([
            item.serializedEnvelope,
            item.serializedEnvelope,
        ]);
    });

    it('bounds a hung send, aborts its guard, and never confirms its late acknowledgement', async () => {
        vi.useFakeTimers();
        const h = harness(50);
        const response = deferred<unknown>();
        h.send.mockReturnValueOnce(response.promise);
        const item = record();
        const pending = h.coordinator.deliver(item, session);
        const guard = h.send.mock.calls[0][1];
        await vi.advanceTimersByTimeAsync(50);
        expect(await pending).toBe('timed-out');
        expect(guard.signal.aborted).toBe(true);
        expect(guard.isCurrent()).toBe(false);
        expect(await h.coordinator.deliver(item, session)).toBe('accepted');
        response.resolve({ ...item, accepted: true });
        await Promise.resolve();
        expect(h.confirm).toHaveBeenCalledTimes(1);
        expect(h.send.mock.calls[0][0]).toEqual(h.send.mock.calls[1][0]);
    });

    it('invalidates a hung confirmation guard so its adapter cannot commit after timeout', async () => {
        vi.useFakeTimers();
        const h = harness(50);
        const commitReady = deferred<void>();
        let committed = false;
        let confirmationGuard: EncryptedDmDeliveryGuard | undefined;
        h.confirm.mockImplementationOnce(async (_item, guard) => {
            confirmationGuard = guard;
            await commitReady.promise;
            committed = guard.isCurrent(); // Mock of required atomic native guard.
            return committed;
        });
        const pending = h.coordinator.deliver(record(), session);
        await vi.advanceTimersByTimeAsync(50);
        expect(await pending).toBe('timed-out');
        expect(confirmationGuard?.isCurrent()).toBe(false);
        commitReady.resolve();
        await Promise.resolve();
        expect(committed).toBe(false);
    });

    it.each(['message', 'plaintext', 'preview', 'privateKey', 'sessionState', 'debug', 'toJSON'])(
        'rejects extra record field %s before calling adapters',
        async (field) => {
            const h = harness();
            expect(await h.coordinator.deliver({ ...record(), [field]: 'PRIVATE TEXT' }, session)).toBe(
                'invalid-record',
            );
            expect(h.send).not.toHaveBeenCalled();
            expect(h.confirm).not.toHaveBeenCalled();
        },
    );

    it.each(['hidden', 'symbol', 'accessor', 'prototype'])(
        'rejects unsafe JavaScript record shape %s without invoking getters',
        async (kind) => {
            const h = harness();
            const item = { ...record() };
            const getter = vi.fn(() => 'PRIVATE TEXT');
            if (kind === 'hidden') Object.defineProperty(item, 'plaintext', { value: 'PRIVATE TEXT' });
            if (kind === 'symbol') Object.defineProperty(item, Symbol('privateKey'), { value: 'SECRET KEY' });
            if (kind === 'accessor') Object.defineProperty(item, 'ownerUserId', { get: getter });
            if (kind === 'prototype') Object.setPrototypeOf(item, { plaintext: 'PRIVATE TEXT' });
            expect(await h.coordinator.deliver(item, session)).toBe('invalid-record');
            expect(getter).not.toHaveBeenCalled();
            expect(h.send).not.toHaveBeenCalled();
        },
    );

    it.each([
        null,
        'PRIVATE TEXT',
        {},
        { ownerUserId: '' },
        { ownerSessionGeneration: -1 },
        { ownerSessionGeneration: 1.5 },
        { ownerSessionGeneration: undefined },
        { recipientUserId: 'bob\nPRIVATE TEXT' },
        { recipientIdentityKeyId: '' },
        { recipientIdentityGeneration: -1 },
        { recipientIdentityGeneration: 1.5 },
        { recipientIdentityGeneration: undefined },
        { serializedEnvelope: 'PRIVATE TEXT' },
    ])('rejects malformed or incomplete outbox input %j', async (patch) => {
        const h = harness();
        const item =
            patch && typeof patch === 'object' && Object.keys(patch).length ? { ...record(), ...patch } : patch;
        expect(await h.coordinator.deliver(item, session)).toBe('invalid-record');
        expect(h.send).not.toHaveBeenCalled();
    });

    it.each(['ownerUserId', 'recipientUserId', 'recipientIdentityKeyId'] as const)(
        'rejects trailing line terminators in outbox %s before calling adapters',
        async (field) => {
            for (const ending of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
                const h = harness();
                const item = record();
                expect(await h.coordinator.deliver({ ...item, [field]: item[field] + ending }, session)).toBe(
                    'invalid-record',
                );
                expect(h.send).not.toHaveBeenCalled();
                expect(h.confirm).not.toHaveBeenCalled();
                expect(h.confirmRejection).not.toHaveBeenCalled();
            }
        },
    );

    it.each(['clientMessageId', 'senderDeviceId', 'recipientDeviceId'] as const)(
        'rejects trailing line terminators in stored envelope %s',
        async (field) => {
            for (const ending of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
                const h = harness();
                // Exercise an externally stored frame, bypassing the send encoder.
                const serializedEnvelope = JSON.stringify({ ...frame, [field]: frame[field] + ending });
                expect(await h.coordinator.deliver({ ...record(), serializedEnvelope }, session)).toBe(
                    'invalid-record',
                );
                expect(h.send).not.toHaveBeenCalled();
                expect(h.confirm).not.toHaveBeenCalled();
                expect(h.confirmRejection).not.toHaveBeenCalled();
            }
        },
    );

    it.each(['plaintext', 'duplicate-key', 'non-canonical', 'unsupported-protocol'])(
        'validates stored envelope framing before dispatch (%s)',
        async (kind) => {
            const h = harness();
            let serializedEnvelope = record().serializedEnvelope;
            if (kind === 'plaintext') serializedEnvelope = JSON.stringify({ ...frame, preview: 'PRIVATE TEXT' });
            if (kind === 'duplicate-key')
                serializedEnvelope = '{"ciphertext":"PRIVATE TEXT",' + serializedEnvelope.slice(1);
            if (kind === 'non-canonical') serializedEnvelope = JSON.stringify(frame, null, 2);
            if (kind === 'unsupported-protocol')
                serializedEnvelope = JSON.stringify({ ...frame, protocol: 'plaintext' });
            expect(await h.coordinator.deliver({ ...record(), serializedEnvelope }, session)).toBe('invalid-record');
            expect(h.send).not.toHaveBeenCalled();
        },
    );

    it.each([
        { userId: 'mallory' },
        { senderDeviceId: 'another-ios' },
        { generation: 6 },
        { generation: -1 },
        { generation: NaN },
    ])('blocks stale or mismatched caller authentication %j', async (patch) => {
        const h = harness();
        expect(await h.coordinator.deliver(record(), { ...session, ...patch })).toBe('blocked');
        expect(h.send).not.toHaveBeenCalled();
    });

    it.each(['userId', 'senderDeviceId'] as const)(
        'rejects trailing line terminators in caller session %s before consulting live state',
        async (field) => {
            for (const ending of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
                const h = harness();
                const getCurrentSession = vi.spyOn(h.dependencies, 'getCurrentSession');
                expect(await h.coordinator.deliver(record(), { ...session, [field]: session[field] + ending })).toBe(
                    'blocked',
                );
                expect(getCurrentSession).not.toHaveBeenCalled();
                expect(h.send).not.toHaveBeenCalled();
                expect(h.confirm).not.toHaveBeenCalled();
                expect(h.confirmRejection).not.toHaveBeenCalled();
            }
        },
    );

    it('blocks a record with a sender device different from the authenticated device', async () => {
        const h = harness();
        const item = {
            ...record(),
            serializedEnvelope: encodeDirectMessageEnvelope({ ...frame, senderDeviceId: 'other-ios' }),
        };
        expect(await h.coordinator.deliver(item, session)).toBe('blocked');
        expect(h.send).not.toHaveBeenCalled();
    });

    it.each([
        'logged-out',
        'switched-account',
        'new-generation',
        'changed-device',
        'revoked',
        'blocked',
        'changed',
        'new-key',
        'missing-peer',
    ])('blocks %s both before dispatch and during an outstanding send', async (change) => {
        const h = harness();
        const response = deferred<unknown>();
        h.send.mockReturnValueOnce(response.promise);
        const item = record();
        const pending = h.coordinator.deliver(item, session);
        if (change === 'logged-out') h.state.session = null;
        if (change === 'switched-account') h.state.session = { ...session, userId: 'mallory' };
        if (change === 'new-generation') h.state.session = { ...session, generation: 8 };
        if (change === 'changed-device') h.state.session = { ...session, senderDeviceId: 'new-ios' };
        if (change === 'revoked') h.state.peer = { ...h.state.peer!, status: 'revoked' };
        if (change === 'blocked') h.state.peer = { ...h.state.peer!, status: 'blocked' };
        if (change === 'changed') h.state.peer = { ...h.state.peer!, status: 'changed' };
        if (change === 'new-key') h.state.peer = { ...h.state.peer!, identityKeyId: 'new-bob-key' };
        if (change === 'missing-peer') h.state.peer = null;
        expect(h.send.mock.calls[0][1].isCurrent()).toBe(false);
        response.resolve({ ...item, accepted: true });
        expect(await pending).toBe('blocked');
        expect(await h.coordinator.deliver(item, session)).toBe('blocked');
        expect(h.send).toHaveBeenCalledTimes(1);
        expect(h.confirm).not.toHaveBeenCalled();
    });

    it.each(['switched-account', 'new-generation', 'revoked'])(
        'guards the native confirmation commit during %s',
        async (change) => {
            const h = harness();
            const commitReady = deferred<void>();
            let committed = false;
            h.confirm.mockImplementationOnce(async (_item, guard) => {
                await commitReady.promise;
                committed = guard.isCurrent();
                return committed;
            });
            const pending = h.coordinator.deliver(record(), session);
            await Promise.resolve();
            expect(h.confirm).toHaveBeenCalledTimes(1);
            if (change === 'switched-account') h.state.session = { ...session, userId: 'mallory' };
            if (change === 'new-generation') h.state.session = { ...session, generation: 8 };
            if (change === 'revoked') h.state.peer = { ...h.state.peer!, status: 'revoked' };
            commitReady.resolve();
            expect(await pending).toBe('blocked');
            expect(committed).toBe(false);
        },
    );

    it('does not mistake logout followed by login to the same user for the original session', async () => {
        const h = harness();
        const response = deferred<unknown>();
        h.send.mockReturnValueOnce(response.promise);
        const item = record();
        const pending = h.coordinator.deliver(item, session);
        h.state.session = null;
        h.state.session = { ...session, generation: session.generation + 1 };
        response.resolve({ ...item, accepted: true });
        expect(await pending).toBe('blocked');
        expect(h.confirm).not.toHaveBeenCalled();
    });

    it('invalidates an outstanding attempt when a revoked identity is later accepted again', async () => {
        const h = harness();
        const response = deferred<unknown>();
        h.send.mockReturnValueOnce(response.promise);
        const item = record();
        const pending = h.coordinator.deliver(item, session);
        h.state.peer = { ...h.state.peer!, status: 'revoked', generation: 2 };
        h.state.peer = { ...h.state.peer!, status: 'accepted', generation: 3 };
        response.resolve({ ...item, accepted: true });
        expect(await pending).toBe('blocked');
        expect(h.confirm).not.toHaveBeenCalled();
    });

    it.each(['revoked', 'blocked', 'changed'] as const)(
        'never revives queued ciphertext after %s and reacceptance between attempts',
        async (status) => {
            const h = harness();
            const item = record();
            h.send.mockRejectedValueOnce(new Error('Network unavailable'));
            expect(await h.coordinator.deliver(item, session)).toBe('retryable-failure');
            h.state.peer = { ...h.state.peer!, status, generation: 2 };
            h.state.peer = { ...h.state.peer!, status: 'accepted', generation: 3 };
            expect(await h.coordinator.deliver(item, session)).toBe('blocked');
            // A new coordinator still reads the old generation from durable input.
            const restarted = createEncryptedDmDeliveryCoordinator(h.dependencies);
            expect(await restarted.deliver(item, session)).toBe('blocked');
            expect(h.send).toHaveBeenCalledTimes(1);
            expect(h.confirm).not.toHaveBeenCalled();
        },
    );

    it('resumes pending ciphertext after coordinator recreation in the same durable session generation', async () => {
        const h = harness();
        const item = record();
        h.send.mockRejectedValueOnce(new Error('Network unavailable'));
        expect(await h.coordinator.deliver(item, session)).toBe('retryable-failure');
        const restarted = createEncryptedDmDeliveryCoordinator(h.dependencies);
        expect(await restarted.deliver(item, session)).toBe('accepted');
        expect(h.send.mock.calls.map(([sent]) => sent)).toEqual([item, item]);
    });

    it('never resends old queued ciphertext after same-owner relogin, including coordinator recreation', async () => {
        const h = harness();
        const item = record();
        h.send.mockRejectedValueOnce(new Error('Network unavailable'));
        expect(await h.coordinator.deliver(item, session)).toBe('retryable-failure');
        h.state.session = null;
        h.state.session = { ...session, generation: session.generation + 1 };
        expect(await h.coordinator.deliver(item, h.state.session)).toBe('blocked');
        const restarted = createEncryptedDmDeliveryCoordinator(h.dependencies);
        expect(await restarted.deliver(item, h.state.session)).toBe('blocked');
        expect(h.send).toHaveBeenCalledTimes(1);
        expect(h.confirm).not.toHaveBeenCalled();
    });

    it.each(['blocked', 'device-revoked', 'record-conflict'] as const)(
        'persists an exact terminal %s response and never uploads that record again',
        async (reason) => {
            const h = harness();
            const item = record();
            h.send.mockResolvedValueOnce({ ...item, accepted: false, reason });
            expect(await h.coordinator.deliver(item, session)).toBe('rejected');
            expect(h.confirmRejection).toHaveBeenCalledTimes(1);
            expect(h.confirmRejection.mock.calls[0][0]).toEqual(item);
            expect(h.confirmRejection.mock.calls[0][1]).toBe(reason);
            expect(h.confirm).not.toHaveBeenCalled();
            h.state.peer = { ...h.state.peer!, status: 'blocked', generation: 2 };
            h.state.peer = { ...h.state.peer!, status: 'accepted', generation: 3 };
            expect(await h.coordinator.deliver(item, session)).toBe('rejected');
            expect(h.send).toHaveBeenCalledTimes(1);
            expect(h.confirmRejection).toHaveBeenCalledTimes(2);
        },
    );

    it.each(['false', 'throw'])('retries rejection persistence without another upload after %s', async (failure) => {
        const h = harness();
        const item = record();
        h.send.mockResolvedValueOnce({ ...item, accepted: false, reason: 'blocked' });
        if (failure === 'false') h.confirmRejection.mockResolvedValueOnce(false);
        else h.confirmRejection.mockRejectedValueOnce(new Error('PRIVATE NATIVE ERROR'));
        expect(await h.coordinator.deliver(item, session)).toBe('rejection-pending');
        expect(await h.coordinator.deliver(item, session)).toBe('rejected');
        expect(h.send).toHaveBeenCalledTimes(1);
        expect(h.confirmRejection).toHaveBeenCalledTimes(2);
        expect(h.confirm).not.toHaveBeenCalled();
    });

    it('keeps separate authenticated refusals for different records sharing the same server IDs', async () => {
        const h = harness();
        const item = record();
        h.send.mockResolvedValueOnce({ ...item, accepted: false, reason: 'blocked' });
        expect(await h.coordinator.deliver(item, session)).toBe('rejected');
        const conflicting = {
            ...item,
            serializedEnvelope: encodeDirectMessageEnvelope({ ...frame, ciphertext: 'BQYHCA==' }),
        };
        h.send.mockResolvedValueOnce({ ...conflicting, accepted: false, reason: 'record-conflict' });
        expect(await h.coordinator.deliver(conflicting, session)).toBe('rejected');
        expect(h.send).toHaveBeenCalledTimes(2);
        expect(h.confirmRejection.mock.calls.map(([sent, reason]) => [sent, reason])).toEqual([
            [item, 'blocked'],
            [conflicting, 'record-conflict'],
        ]);
        expect(await h.coordinator.deliver(item, session)).toBe('rejected');
        expect(await h.coordinator.deliver(conflicting, session)).toBe('rejected');
        expect(h.send).toHaveBeenCalledTimes(2);
    });

    it.each(['thrown-response', 'network-error', 'abort-error'])(
        'does not treat %s as an authoritative server rejection',
        async (kind) => {
            const h = harness();
            const item = record();
            const error =
                kind === 'thrown-response'
                    ? { ...item, accepted: false, reason: 'blocked' }
                    : new Error('PRIVATE NETWORK ERROR');
            if (kind === 'abort-error') (error as Error).name = 'AbortError';
            h.send.mockRejectedValueOnce(error);
            expect(await h.coordinator.deliver(item, session)).toBe('retryable-failure');
            expect(h.confirmRejection).not.toHaveBeenCalled();
            expect(await h.coordinator.deliver(item, session)).toBe('accepted');
            expect(h.send).toHaveBeenCalledTimes(2);
        },
    );

    it.each([
        { reason: 'PRIVATE SERVER ERROR' },
        { reason: undefined },
        { recipientUserId: 'mallory' },
        { recipientIdentityGeneration: 2 },
        { plaintext: 'PRIVATE TEXT' },
    ])('refuses malformed or unbound terminal responses %j', async (patch) => {
        const h = harness();
        h.send.mockResolvedValueOnce({ ...record(), accepted: false, reason: 'blocked', ...patch });
        expect(await h.coordinator.deliver(record(), session)).toBe('invalid-acknowledgement');
        expect(h.confirmRejection).not.toHaveBeenCalled();
        expect(h.confirm).not.toHaveBeenCalled();
    });

    it('retains a terminal response across an account switch without committing under a stale owner', async () => {
        const h = harness();
        const response = deferred<unknown>();
        const item = record();
        h.send.mockReturnValueOnce(response.promise);
        const pending = h.coordinator.deliver(item, session);
        h.state.session = { ...session, userId: 'mallory', generation: 8 };
        response.resolve({ ...item, accepted: false, reason: 'blocked' });
        expect(await pending).toBe('rejection-pending');
        expect(h.confirmRejection).not.toHaveBeenCalled();
        h.state.session = { ...session, generation: 9 };
        expect(await h.coordinator.deliver(item, h.state.session)).toBe('rejected');
        expect(h.send).toHaveBeenCalledTimes(1);
    });

    it('invalidates rejection commits after account change and retries only cancellation', async () => {
        const h = harness();
        const item = record();
        const commitReady = deferred<void>();
        let committed = false;
        h.send.mockResolvedValueOnce({ ...item, accepted: false, reason: 'blocked' });
        h.confirmRejection.mockImplementationOnce(async (_item, _reason, guard) => {
            await commitReady.promise;
            committed = guard.isCurrent();
            return committed;
        });
        const pending = h.coordinator.deliver(item, session);
        await Promise.resolve();
        expect(h.confirmRejection).toHaveBeenCalledTimes(1);
        h.state.session = { ...session, generation: 8 };
        commitReady.resolve();
        expect(await pending).toBe('rejection-pending');
        expect(committed).toBe(false);
        expect(await h.coordinator.deliver(item, h.state.session)).toBe('rejected');
        expect(h.send).toHaveBeenCalledTimes(1);
    });

    it('can persist cancellation when the peer is blocked after upload, using only the owner guard', async () => {
        const h = harness();
        const item = record();
        const response = deferred<unknown>();
        h.send.mockReturnValueOnce(response.promise);
        h.confirmRejection.mockImplementationOnce(async (_item, _reason, guard) => guard.isCurrent());
        const pending = h.coordinator.deliver(item, session);
        h.state.peer = { ...h.state.peer!, status: 'blocked', generation: 2 };
        response.resolve({ ...item, accepted: false, reason: 'blocked' });
        expect(await pending).toBe('rejected');
        expect(h.confirm).not.toHaveBeenCalled();
    });

    it('remembers a late authenticated refusal after timeout without using its expired commit guard', async () => {
        vi.useFakeTimers();
        const h = harness(50);
        const item = record();
        const response = deferred<unknown>();
        h.send.mockReturnValueOnce(response.promise);
        const pending = h.coordinator.deliver(item, session);
        await vi.advanceTimersByTimeAsync(50);
        expect(await pending).toBe('timed-out');
        response.resolve({ ...item, accepted: false, reason: 'blocked' });
        await Promise.resolve();
        expect(h.confirmRejection).not.toHaveBeenCalled();
        expect(await h.coordinator.deliver(item, session)).toBe('rejected');
        expect(h.send).toHaveBeenCalledTimes(1);
    });

    it('keeps a timeout while cancelling terminal and retries only native rejection confirmation', async () => {
        vi.useFakeTimers();
        const h = harness(50);
        const item = record();
        const commitReady = deferred<void>();
        let committed = false;
        h.send.mockResolvedValueOnce({ ...item, accepted: false, reason: 'blocked' });
        h.confirmRejection.mockImplementationOnce(async (_item, _reason, guard) => {
            await commitReady.promise;
            committed = guard.isCurrent();
            return committed;
        });
        const pending = h.coordinator.deliver(item, session);
        await vi.advanceTimersByTimeAsync(50);
        expect(await pending).toBe('rejection-pending');
        commitReady.resolve();
        await Promise.resolve();
        expect(committed).toBe(false);
        expect(await h.coordinator.deliver(item, session)).toBe('rejected');
        expect(h.send).toHaveBeenCalledTimes(1);
    });

    it.each(['acceptance', 'network-error', 'timeout', 'native-confirmation-failure'] as const)(
        'does not apply timed-out A’s late record-conflict to different ciphertext B (%s)',
        async (outcome) => {
            vi.useFakeTimers();
            const h = harness(50);
            const itemA = record();
            const itemB = {
                ...itemA,
                serializedEnvelope: encodeDirectMessageEnvelope({ ...frame, ciphertext: 'BQYHCA==' }),
            };
            const responseA = deferred<unknown>();
            const responseB = deferred<unknown>();
            h.send.mockReturnValueOnce(responseA.promise).mockReturnValueOnce(responseB.promise);
            const attemptA = h.coordinator.deliver(itemA, session);
            await vi.advanceTimersByTimeAsync(50);
            expect(await attemptA).toBe('timed-out');
            const attemptB = h.coordinator.deliver(itemB, session);
            // B's request can reach the server first. The late conflict belongs
            // exclusively to A, even though both share the idempotency key.
            responseA.resolve({ ...itemA, accepted: false, reason: 'record-conflict' });
            await Promise.resolve();
            if (outcome === 'native-confirmation-failure') {
                h.confirm.mockResolvedValueOnce(false);
                responseB.resolve({ ...itemB, accepted: true });
            }
            if (outcome === 'acceptance') responseB.resolve({ ...itemB, accepted: true });
            if (outcome === 'network-error') responseB.reject(new Error('Network unavailable'));
            if (outcome === 'timeout') await vi.advanceTimersByTimeAsync(50);
            const expected =
                outcome === 'acceptance' ? 'accepted' : outcome === 'timeout' ? 'timed-out' : 'retryable-failure';
            expect(await attemptB).toBe(expected);
            expect(h.confirmRejection).not.toHaveBeenCalled();
            if (outcome === 'acceptance' || outcome === 'native-confirmation-failure') {
                expect(h.confirm).toHaveBeenCalledTimes(1);
                expect(h.confirm.mock.calls[0][0]).toEqual(itemB);
            } else {
                expect(h.confirm).not.toHaveBeenCalled();
            }
            expect(h.send).toHaveBeenCalledTimes(2);
            // Retry B through its complete continuation, including uncertainty
            // after server acceptance. A's cached refusal must not block this.
            expect(await h.coordinator.deliver(itemB, session)).toBe('accepted');
            expect(h.send.mock.calls.map(([sent]) => sent)).toEqual([itemA, itemB, itemB]);
            expect(h.confirm.mock.lastCall?.[0]).toEqual(itemB);
            // B's response never rewrites A's cached refusal onto B's bytes.
            expect(await h.coordinator.deliver(itemA, session)).toBe('rejected');
            expect(h.confirmRejection.mock.calls[0][0]).toEqual(itemA);
            expect(h.confirmRejection.mock.calls[0][1]).toBe('record-conflict');
            expect(h.send).toHaveBeenCalledTimes(3);
        },
    );

    it('does not let late conflicting A overwrite B’s exact cached terminal decision', async () => {
        vi.useFakeTimers();
        const h = harness(50);
        const itemA = record();
        const itemB = {
            ...itemA,
            serializedEnvelope: encodeDirectMessageEnvelope({ ...frame, ciphertext: 'BQYHCA==' }),
        };
        const responseA = deferred<unknown>();
        h.send
            .mockReturnValueOnce(responseA.promise)
            .mockResolvedValueOnce({ ...itemB, accepted: false, reason: 'blocked' });
        const attemptA = h.coordinator.deliver(itemA, session);
        await vi.advanceTimersByTimeAsync(50);
        expect(await attemptA).toBe('timed-out');
        h.confirmRejection.mockResolvedValueOnce(false);
        expect(await h.coordinator.deliver(itemB, session)).toBe('rejection-pending');
        responseA.resolve({ ...itemA, accepted: false, reason: 'record-conflict' });
        await Promise.resolve();
        expect(await h.coordinator.deliver(itemB, session)).toBe('rejected');
        expect(await h.coordinator.deliver(itemA, session)).toBe('rejected');
        expect(h.send).toHaveBeenCalledTimes(2);
        expect(h.confirmRejection.mock.calls.map(([item, reason]) => [item, reason])).toEqual([
            [itemB, 'blocked'],
            [itemB, 'blocked'],
            [itemA, 'record-conflict'],
        ]);
    });

    it.each([
        { accepted: false },
        { ownerUserId: 'mallory' },
        { ownerSessionGeneration: 8 },
        { recipientUserId: 'mallory' },
        { recipientIdentityKeyId: 'different-key' },
        { serializedEnvelope: 'PRIVATE TEXT' },
        { plaintext: 'PRIVATE TEXT' },
    ])('never confirms a mismatched or expanded acknowledgement %j', async (patch) => {
        const h = harness();
        h.send.mockResolvedValueOnce({ ...record(), accepted: true, ...patch });
        expect(await h.coordinator.deliver(record(), session)).toBe('invalid-acknowledgement');
        expect(h.confirm).not.toHaveBeenCalled();
    });

    it.each(['clientMessageId', 'senderDeviceId', 'recipientDeviceId', 'ciphertext'])(
        'rejects acknowledgement envelope mismatch in %s',
        async (field) => {
            const h = harness();
            const serializedEnvelope = encodeDirectMessageEnvelope({
                ...frame,
                [field]: field === 'ciphertext' ? 'BQYHCA==' : 'other-id',
            });
            h.send.mockResolvedValueOnce({ ...record(), serializedEnvelope, accepted: true });
            expect(await h.coordinator.deliver(record(), session)).toBe('invalid-acknowledgement');
            expect(h.confirm).not.toHaveBeenCalled();
        },
    );

    it('rejects acknowledgement getters without evaluating secret-bearing code', async () => {
        const h = harness();
        const getter = vi.fn(() => 'PRIVATE TEXT');
        const acknowledgement = { ...record(), accepted: true };
        Object.defineProperty(acknowledgement, 'serializedEnvelope', { get: getter });
        h.send.mockResolvedValueOnce(acknowledgement);
        expect(await h.coordinator.deliver(record(), session)).toBe('invalid-acknowledgement');
        expect(getter).not.toHaveBeenCalled();
        expect(h.confirm).not.toHaveBeenCalled();
    });

    it('blocks when local identity lookup throws, without exposing its error', async () => {
        const h = harness();
        h.dependencies.getPeerIdentity = () => {
            throw new Error('SECRET KEY');
        };
        expect(await h.coordinator.deliver(record(), session)).toBe('blocked');
        expect(h.send).not.toHaveBeenCalled();
    });

    it('rejects overlapping attempts for the same idempotency key, including conflicting bytes', async () => {
        const h = harness();
        const response = deferred<unknown>();
        h.send.mockReturnValueOnce(response.promise);
        const item = record();
        const pending = h.coordinator.deliver(item, session);
        expect(await h.coordinator.deliver(item, session)).toBe('busy');
        const conflicting = {
            ...item,
            serializedEnvelope: encodeDirectMessageEnvelope({ ...frame, ciphertext: 'BQYHCA==' }),
        };
        expect(await h.coordinator.deliver(conflicting, session)).toBe('busy');
        expect(h.send).toHaveBeenCalledTimes(1);
        response.resolve({ ...item, accepted: true });
        expect(await pending).toBe('accepted');
        expect(await h.coordinator.deliver(item, session)).toBe('accepted');
    });

    it('allows independent already-prepared messages concurrently', async () => {
        const h = harness();
        const response = deferred<unknown>();
        h.send.mockReturnValueOnce(response.promise);
        const item = record();
        const pending = h.coordinator.deliver(item, session);
        const second = {
            ...item,
            serializedEnvelope: encodeDirectMessageEnvelope({ ...frame, clientMessageId: 'message-2' }),
        };
        expect(await h.coordinator.deliver(second, session)).toBe('accepted');
        response.resolve({ ...item, accepted: true });
        expect(await pending).toBe('accepted');
        expect(h.confirm).toHaveBeenCalledTimes(2);
    });
});
