/**
 * crewChatGate: the Crew Chat card's remembered gate (one per account) and
 * its live reads, which answer or say nothing, never "no" on an error
 * (Shane 2026-10-06: the card must arrive with the others, and fast).
 * People here are fictional.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Reply {
    data: unknown;
    error: unknown;
}
const net = vi.hoisted(() => {
    const state = {
        sessionUserId: null as string | null,
        replies: {} as Record<string, () => Promise<Reply>>,
        queries: [] as Array<{ table: string; filters: Array<[string, unknown]> }>,
    };
    const from = (table: string) => {
        const query = { table, filters: [] as Array<[string, unknown]> };
        state.queries.push(query);
        const builder: Record<string, unknown> = {};
        Object.assign(builder, {
            select: () => builder,
            eq: (column: string, value: unknown) => {
                query.filters.push([column, value]);
                return builder;
            },
            limit: () => builder,
            then: (resolve: (reply: Reply) => unknown, reject: (error: unknown) => unknown) => {
                const key = `${table}:${query.filters.map(([column]) => column).join(',')}`;
                return (state.replies[key] ?? (() => Promise.resolve({ data: [], error: null })))().then(
                    resolve,
                    reject,
                );
            },
        });
        return builder;
    };
    return { state, from };
});
vi.mock('../services/supabase', () => ({
    supabase: {
        from: (table: string) => net.from(table),
        auth: {
            getSession: vi.fn(async () => ({
                data: { session: net.state.sessionUserId ? { user: { id: net.state.sessionUserId } } : null },
            })),
        },
    },
}));

import {
    readCrewChatChannelMemberships,
    readCrewChatGateMemory,
    readCrewChatRows,
    rememberCrewChatGate,
    type CrewChatGateMemory,
} from '../services/crew/crewChatGate';
import { getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';

const group = {
    id: 'crew-chat-skipper-1',
    name: 'Crew Chat',
    description: 'Private crew group',
    region: null,
    icon: '👥',
    is_global: false,
    is_private: true,
    owner_id: 'skipper-1',
    parent_id: null,
    created_at: '2026-10-01T00:00:00Z',
};
const memoryFor = (userId: string, extra: Partial<CrewChatGateMemory> = {}): CrewChatGateMemory => ({
    version: 1,
    userId,
    hasOwnedCrew: false,
    memberOwnerIds: ['skipper-1'],
    channel: group,
    passage: { voyageId: 'voyage-1', canViewChat: true },
    vesselNames: { 'skipper-1': 'Albatross' },
    ...extra,
});
const keyFor = (userId: string) => `thalassa_crew_chat_gate_v1::${encodeURIComponent(`user:${userId}`)}`;

function signIn(userId: string | null) {
    net.state.sessionUserId = userId;
    return setAuthIdentityScope(userId);
}

beforeEach(() => {
    localStorage.clear();
    net.state.replies = {};
    net.state.queries = [];
});
afterEach(() => {
    signIn(null);
});

describe('the remembered gate is one per account', () => {
    it('reads back what was remembered for the same account', () => {
        const scope = signIn('crew-a');
        rememberCrewChatGate(scope, memoryFor('crew-a'));
        expect(readCrewChatGateMemory(getAuthIdentityScope())).toEqual(memoryFor('crew-a'));
    });

    it('never reads one account’s gate for another, nor signed out', () => {
        rememberCrewChatGate(signIn('crew-a'), memoryFor('crew-a'));
        expect(readCrewChatGateMemory(signIn('crew-b'))).toBeNull();
        expect(readCrewChatGateMemory(signIn(null))).toBeNull();
    });

    it('ignores a stored gate whose account does not match its key, or that does not parse', () => {
        localStorage.setItem(keyFor('crew-a'), JSON.stringify(memoryFor('crew-b')));
        expect(readCrewChatGateMemory(signIn('crew-a'))).toBeNull();
        localStorage.setItem(keyFor('crew-a'), '{not json');
        expect(readCrewChatGateMemory(getAuthIdentityScope())).toBeNull();
    });

    it("keeps only a skipper's 👥 group, never the account's own or a public channel", () => {
        const scope = signIn('crew-a');
        for (const channel of [
            { ...group, owner_id: 'crew-a' },
            { ...group, is_private: false },
            { ...group, icon: '💬' },
            { ...group, owner_id: null },
        ]) {
            localStorage.setItem(keyFor('crew-a'), JSON.stringify(memoryFor('crew-a', { channel })));
            expect(readCrewChatGateMemory(scope)?.channel).toBeNull();
        }
    });

    it('drops the account itself from its skippers and bounds the list', () => {
        const scope = signIn('crew-a');
        const owners = ['crew-a', ...Array.from({ length: 20 }, (_, i) => `skipper-${i}`)];
        localStorage.setItem(keyFor('crew-a'), JSON.stringify(memoryFor('crew-a', { memberOwnerIds: owners })));
        const read = readCrewChatGateMemory(scope)?.memberOwnerIds ?? [];
        expect(read).not.toContain('crew-a');
        expect(read.length).toBe(8);
    });

    it('does not write for a scope that is no longer current, or for another account', () => {
        const stale = signIn('crew-a');
        signIn('crew-b');
        rememberCrewChatGate(stale, memoryFor('crew-a'));
        rememberCrewChatGate(getAuthIdentityScope(), memoryFor('crew-a'));
        expect(localStorage.getItem(keyFor('crew-a'))).toBeNull();
        expect(localStorage.getItem(keyFor('crew-b'))).toBeNull();
    });
});

describe('the live crew rows answer, or say nothing', () => {
    it('reads both questions in parallel, filtered to this account', async () => {
        const scope = signIn('crew-a');
        net.state.replies['vessel_crew:owner_id'] = () => Promise.resolve({ data: [{ id: 'row-1' }], error: null });
        net.state.replies['vessel_crew:crew_user_id,status'] = () =>
            Promise.resolve({ data: [{ owner_id: 'skipper-1' }, { owner_id: 'skipper-1' }], error: null });

        expect(await readCrewChatRows(scope)).toEqual({ hasOwnedCrew: true, memberOwnerIds: ['skipper-1'] });
        expect(net.state.queries.map((query) => query.filters)).toEqual([
            [['owner_id', 'crew-a']],
            [
                ['crew_user_id', 'crew-a'],
                ['status', 'accepted'],
            ],
        ]);
    });

    it('an error is no answer, never "no crew"', async () => {
        const scope = signIn('crew-a');
        net.state.replies['vessel_crew:crew_user_id,status'] = () =>
            Promise.resolve({ data: null, error: { message: 'Failed to fetch' } });
        expect(await readCrewChatRows(scope)).toBeNull();
    });

    it('a session for another account, or an account switch mid-read, is no answer', async () => {
        const scope = signIn('crew-a');
        net.state.sessionUserId = 'crew-b';
        expect(await readCrewChatRows(scope)).toBeNull();

        const again = signIn('crew-a');
        let land!: () => void;
        net.state.replies['vessel_crew:owner_id'] = () =>
            new Promise((resolve) => {
                land = () => resolve({ data: [], error: null });
            });
        const read = readCrewChatRows(again);
        await vi.waitFor(() => expect(land).toBeTypeOf('function'));
        signIn('crew-b');
        land();
        expect(await read).toBeNull();
    });
});

describe("the account's channel memberships", () => {
    it('lists every channel this account is in, with no channel list needed', async () => {
        const scope = signIn('crew-a');
        net.state.replies['channel_members:user_id'] = () =>
            Promise.resolve({ data: [{ channel_id: 'crew-chat-skipper-1' }, { channel_id: 'general' }], error: null });
        const read = await readCrewChatChannelMemberships(scope);
        expect(read?.complete).toBe(true);
        expect([...(read?.ids ?? [])]).toEqual(['crew-chat-skipper-1', 'general']);
    });

    it('an answer cut at its bound is partial, and an error is no answer', async () => {
        const scope = signIn('crew-a');
        net.state.replies['channel_members:user_id'] = () =>
            Promise.resolve({
                data: Array.from({ length: 500 }, (_, i) => ({ channel_id: `channel-${i}` })),
                error: null,
            });
        expect((await readCrewChatChannelMemberships(scope))?.complete).toBe(false);
        net.state.replies['channel_members:user_id'] = () => Promise.resolve({ data: null, error: { message: 'x' } });
        expect(await readCrewChatChannelMemberships(scope)).toBeNull();
    });
});
