import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setAuthIdentityScope } from '../services/authIdentityScope';

const mocks = vi.hoisted(() => {
    const state = {
        authUser: null as { id: string } | null,
        builders: [] as Array<{
            kind: string;
            eqCalls: Array<[string, unknown]>;
            payload: unknown;
        }>,
    };
    return {
        state,
        getCurrentUser: vi.fn(),
        readResult: vi.fn(),
        insertResult: vi.fn(),
        updateResult: vi.fn(),
        deleteResult: vi.fn(),
    };
});

vi.mock('../services/supabase', () => ({
    getCurrentUser: mocks.getCurrentUser,
    supabase: {
        from: vi.fn(() => {
            const record = {
                kind: 'read',
                eqCalls: [] as Array<[string, unknown]>,
                payload: undefined as unknown,
            };
            mocks.state.builders.push(record);
            const builder: Record<string, unknown> & PromiseLike<unknown> = {
                select: vi.fn(() => builder),
                eq: vi.fn((column: string, value: unknown) => {
                    record.eqCalls.push([column, value]);
                    return builder;
                }),
                order: vi.fn(() => builder),
                insert: vi.fn((payload: unknown) => {
                    record.kind = 'insert';
                    record.payload = payload;
                    return builder;
                }),
                update: vi.fn((payload: unknown) => {
                    record.kind = 'update';
                    record.payload = payload;
                    return builder;
                }),
                delete: vi.fn(() => {
                    record.kind = 'delete';
                    return builder;
                }),
                single: vi.fn(() => mocks.insertResult()),
                maybeSingle: vi.fn(() => (record.kind === 'delete' ? mocks.deleteResult() : mocks.updateResult())),
                then: (resolve, reject) => Promise.resolve(mocks.readResult()).then(resolve, reject),
            };
            return builder;
        }),
    },
}));

vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { getKnowledgePromptBlock, updateKnowledge, addKnowledge } from '../services/CalypsoKnowledgeService';

function row(userId: string, title: string, body: string) {
    return {
        id: `${userId}-${title}`,
        user_id: userId,
        category: 'medical' as const,
        title,
        body,
        created_at: '2026-07-23T00:00:00.000Z',
        updated_at: '2026-07-23T00:00:00.000Z',
    };
}

describe('CalypsoKnowledgeService identity isolation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.state.builders.length = 0;
        mocks.state.authUser = null;
        mocks.getCurrentUser.mockImplementation(async () => mocks.state.authUser);
        mocks.readResult.mockResolvedValue({ data: [], error: null });
        mocks.insertResult.mockResolvedValue({ data: null, error: null });
        mocks.updateResult.mockResolvedValue({ data: { id: 'updated' }, error: null });
        mocks.deleteResult.mockResolvedValue({ data: { id: 'deleted' }, error: null });
        setAuthIdentityScope(null);
    });

    it('never serves account A medical notes from the prompt cache to B', async () => {
        setAuthIdentityScope('knowledge-account-a');
        mocks.state.authUser = { id: 'knowledge-account-a' };
        mocks.readResult.mockResolvedValueOnce({
            data: [row('knowledge-account-a', 'Account A allergy', 'Penicillin')],
            error: null,
        });
        const accountAPrompt = await getKnowledgePromptBlock();
        expect(accountAPrompt).toContain('Account A allergy');

        setAuthIdentityScope('knowledge-account-b');
        mocks.state.authUser = { id: 'knowledge-account-b' };
        mocks.readResult.mockResolvedValueOnce({
            data: [row('knowledge-account-b', 'Account B allergy', 'Latex')],
            error: null,
        });
        const accountBPrompt = await getKnowledgePromptBlock();

        expect(accountBPrompt).toContain('Account B allergy');
        expect(accountBPrompt).not.toContain('Account A allergy');
        expect(mocks.state.builders[0].eqCalls).toContainEqual(['user_id', 'knowledge-account-a']);
        expect(mocks.state.builders[1].eqCalls).toContainEqual(['user_id', 'knowledge-account-b']);
    });

    it('discards an account A prompt fetch which resolves after B becomes active', async () => {
        let resolveRead!: (result: { data: ReturnType<typeof row>[]; error: null }) => void;
        mocks.readResult.mockReturnValueOnce(
            new Promise((resolve) => {
                resolveRead = resolve;
            }),
        );
        setAuthIdentityScope('knowledge-deferred-a');
        mocks.state.authUser = { id: 'knowledge-deferred-a' };
        const pending = getKnowledgePromptBlock();

        await Promise.resolve();
        setAuthIdentityScope('knowledge-deferred-b');
        mocks.state.authUser = { id: 'knowledge-deferred-b' };
        resolveRead({
            data: [row('knowledge-deferred-a', 'A private diagnosis', 'Private details')],
            error: null,
        });

        await expect(pending).resolves.toBe('');
    });

    it('owner-filters updates and reports a deferred A completion as stale', async () => {
        let resolveUpdate!: (result: { data: { id: string }; error: null }) => void;
        mocks.updateResult.mockReturnValueOnce(
            new Promise((resolve) => {
                resolveUpdate = resolve;
            }),
        );
        setAuthIdentityScope('knowledge-update-a');
        mocks.state.authUser = { id: 'knowledge-update-a' };
        const pending = updateKnowledge('private-note', { title: 'Changed' });

        await Promise.resolve();
        setAuthIdentityScope('knowledge-update-b');
        mocks.state.authUser = { id: 'knowledge-update-b' };
        resolveUpdate({ data: { id: 'private-note' }, error: null });

        await expect(pending).resolves.toBe(false);
        expect(mocks.state.builders[0].eqCalls).toEqual([
            ['user_id', 'knowledge-update-a'],
            ['id', 'private-note'],
        ]);
    });

    it('does not insert when authentication changes during owner verification', async () => {
        let resolveUser!: (user: { id: string }) => void;
        mocks.getCurrentUser.mockReturnValueOnce(
            new Promise((resolve) => {
                resolveUser = resolve;
            }),
        );
        setAuthIdentityScope('knowledge-add-a');
        const pending = addKnowledge('general', 'A note', 'A body');

        setAuthIdentityScope('knowledge-add-b');
        mocks.state.authUser = { id: 'knowledge-add-b' };
        resolveUser({ id: 'knowledge-add-a' });

        await expect(pending).resolves.toBeNull();
        expect(mocks.state.builders).toHaveLength(0);
    });
});
