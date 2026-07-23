import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import type { VoiceQueryResponse, VoiceTurn } from '../types/voice';

const mocks = vi.hoisted(() => ({
    getUser: vi.fn(),
    from: vi.fn(),
    channel: vi.fn(),
    removeChannel: vi.fn(),
}));

vi.mock('../services/supabase', () => ({
    supabase: {
        auth: { getUser: mocks.getUser },
        from: mocks.from,
        channel: mocks.channel,
        removeChannel: mocks.removeChannel,
    },
}));

import { publishTurn, startConversationSync } from '../services/voice/conversationSync';

interface Deferred<T> {
    promise: Promise<T>;
    resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
        resolve = res;
    });
    return { promise, resolve };
}

function authResult(userId: string | null, displayName = 'Alice') {
    return {
        data: {
            user: userId
                ? {
                      id: userId,
                      email: `${userId}@example.com`,
                      user_metadata: { display_name: displayName },
                  }
                : null,
        },
        error: null,
    };
}

function ownerQuery(
    result:
        | Promise<{ data: { owner_id: string } | null; error: null }>
        | { data: { owner_id: string } | null; error: null },
) {
    const query = {
        select: vi.fn(),
        eq: vi.fn(),
        maybeSingle: vi.fn(),
    };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    query.maybeSingle.mockReturnValue(result);
    return query;
}

function makeChannel() {
    const callbacks: Array<(payload: { new: unknown }) => void> = [];
    const channel = {
        on: vi.fn((_event: string, _filter: unknown, callback: (payload: { new: unknown }) => void) => {
            callbacks.push(callback);
            return channel;
        }),
        subscribe: vi.fn(() => channel),
    };
    return { channel, callbacks };
}

const turn: VoiceTurn = {
    id: 'turn-a',
    timestamp: Date.parse('2026-07-23T00:00:00.000Z'),
    transcript: 'What is the wind?',
    response: {
        transcript: 'What is the wind?',
        answer_text: 'Twelve knots.',
        source: 'cloud',
    },
};

const response: VoiceQueryResponse = turn.response;

function remoteRow(overrides: Record<string, unknown> = {}) {
    return {
        id: 'turn-b',
        vessel_owner_id: 'account-a',
        user_id: 'crew-b',
        user_name: 'Crew B',
        transcript: 'How deep is it?',
        answer_text: 'Eight metres.',
        source: 'bosun',
        tool_calls: null,
        created_at: '2026-07-23T00:01:00.000Z',
        ...overrides,
    };
}

describe('conversationSync identity boundary', () => {
    beforeEach(() => {
        setAuthIdentityScope(null);
        vi.clearAllMocks();
        setAuthIdentityScope('account-a');
        mocks.getUser.mockResolvedValue(authResult('account-a'));
        mocks.from.mockImplementation((table: string) => {
            if (table === 'vessel_identity') {
                return ownerQuery({ data: { owner_id: 'account-a' }, error: null });
            }
            throw new Error(`Unexpected table: ${table}`);
        });
        mocks.removeChannel.mockResolvedValue(undefined);
    });

    it('accepts only valid rows from the captured vessel and stops idempotently', async () => {
        const realtime = makeChannel();
        mocks.channel.mockReturnValue(realtime.channel);
        const onRemoteTurn = vi.fn();

        const handle = await startConversationSync({ onRemoteTurn });
        expect(handle.active).toBe(true);

        realtime.callbacks[0]?.({ new: remoteRow({ user_id: 'account-a' }) });
        realtime.callbacks[0]?.({ new: remoteRow({ vessel_owner_id: 'someone-else' }) });
        realtime.callbacks[0]?.({ new: remoteRow({ created_at: 'not-a-date' }) });
        realtime.callbacks[0]?.({ new: remoteRow() });

        expect(onRemoteTurn).toHaveBeenCalledOnce();
        expect(onRemoteTurn).toHaveBeenCalledWith(
            expect.objectContaining({
                id: 'turn-b',
                userId: 'crew-b',
                userName: 'Crew B',
                timestamp: Date.parse('2026-07-23T00:01:00.000Z'),
            }),
        );

        await handle.stop();
        await handle.stop();
        expect(handle.active).toBe(false);
        expect(mocks.removeChannel).toHaveBeenCalledOnce();
    });

    it('tears down the A channel synchronously at the B identity boundary', async () => {
        const realtime = makeChannel();
        mocks.channel.mockReturnValue(realtime.channel);
        const onRemoteTurn = vi.fn();
        const handle = await startConversationSync({ onRemoteTurn });

        setAuthIdentityScope('account-b');
        expect(handle.active).toBe(false);
        realtime.callbacks[0]?.({ new: remoteRow() });

        await vi.waitFor(() => expect(mocks.removeChannel).toHaveBeenCalledWith(realtime.channel));
        expect(onRemoteTurn).not.toHaveBeenCalled();
    });

    it('does not create a channel when A authentication resolves after switching to B', async () => {
        const auth = deferred<ReturnType<typeof authResult>>();
        mocks.getUser.mockReturnValueOnce(auth.promise);
        const pending = startConversationSync({ onRemoteTurn: vi.fn() });

        setAuthIdentityScope('account-b');
        auth.resolve(authResult('account-a'));

        await expect(pending).resolves.toMatchObject({ active: false });
        expect(mocks.from).not.toHaveBeenCalled();
        expect(mocks.channel).not.toHaveBeenCalled();
    });

    it('does not create a channel when A vessel resolution completes as B', async () => {
        const owner = deferred<{ data: { owner_id: string }; error: null }>();
        mocks.from.mockReturnValueOnce(ownerQuery(owner.promise));
        const pending = startConversationSync({ onRemoteTurn: vi.fn() });
        await vi.waitFor(() => expect(mocks.from).toHaveBeenCalledWith('vessel_identity'));

        setAuthIdentityScope('account-b');
        owner.resolve({ data: { owner_id: 'account-a' }, error: null });

        await expect(pending).resolves.toMatchObject({ active: false });
        expect(mocks.channel).not.toHaveBeenCalled();
    });

    it('rejects an old handle after an account change or same-user re-login', async () => {
        const realtime = makeChannel();
        mocks.channel.mockReturnValue(realtime.channel);
        const handle = await startConversationSync({ onRemoteTurn: vi.fn() });

        setAuthIdentityScope(null);
        setAuthIdentityScope('account-a');

        await expect(publishTurn(handle, turn, response)).resolves.toBe(false);
        expect(mocks.from).toHaveBeenCalledTimes(1);
    });

    it('does not insert when display-name authentication resolves after the identity changes', async () => {
        const realtime = makeChannel();
        mocks.channel.mockReturnValue(realtime.channel);
        const handle = await startConversationSync({ onRemoteTurn: vi.fn() });
        const auth = deferred<ReturnType<typeof authResult>>();
        mocks.getUser.mockReturnValueOnce(auth.promise);

        const pending = publishTurn(handle, turn, response);
        setAuthIdentityScope('account-b');
        auth.resolve(authResult('account-a'));

        await expect(pending).resolves.toBe(false);
        expect(mocks.from).toHaveBeenCalledTimes(1);
    });

    it('publishes with identifiers captured by the active authenticated handle', async () => {
        const realtime = makeChannel();
        mocks.channel.mockReturnValue(realtime.channel);
        const insert = vi.fn().mockResolvedValue({ error: null });
        mocks.from.mockImplementation((table: string) => {
            if (table === 'vessel_identity') {
                return ownerQuery({ data: { owner_id: 'account-a' }, error: null });
            }
            if (table === 'voice_conversations') return { insert };
            throw new Error(`Unexpected table: ${table}`);
        });
        const handle = await startConversationSync({ onRemoteTurn: vi.fn() });

        await expect(publishTurn(handle, turn, response)).resolves.toBe(true);
        expect(insert).toHaveBeenCalledWith({
            id: 'turn-a',
            vessel_owner_id: 'account-a',
            user_id: 'account-a',
            user_name: 'Alice',
            transcript: 'What is the wind?',
            answer_text: 'Twelve knots.',
            source: 'cloud',
            tool_calls: null,
        });
    });
});
