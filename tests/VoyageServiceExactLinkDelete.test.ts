import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    getUser: vi.fn(),
    row: null as Record<string, unknown> | null,
    calls: [] as Array<{ op: string; column?: string; value?: unknown }>,
}));

vi.mock('../services/supabase', () => ({
    supabase: {
        auth: {
            getUser: (...args: unknown[]) => mocks.getUser(...args),
        },
        from: () => {
            const filters: Array<{ kind: 'eq' | 'is'; column: string; value: unknown }> = [];
            let mode: 'select' | 'delete' = 'select';
            type MockBuilder = {
                select: () => MockBuilder;
                delete: () => MockBuilder;
                eq: (column: string, value: unknown) => MockBuilder;
                is: (column: string, value: unknown) => MockBuilder;
                maybeSingle: () => Promise<{ data: Record<string, unknown> | null; error: null }>;
            };
            const matches = (): boolean =>
                mocks.row !== null &&
                filters.every(({ column, value }) => {
                    const actual = mocks.row?.[column];
                    return actual === value;
                });
            const builder: MockBuilder = {
                select: () => {
                    mocks.calls.push({ op: 'select' });
                    return builder;
                },
                delete: () => {
                    mode = 'delete';
                    mocks.calls.push({ op: 'delete' });
                    return builder;
                },
                eq: (column: string, value: unknown) => {
                    filters.push({ kind: 'eq', column, value });
                    mocks.calls.push({ op: 'eq', column, value });
                    return builder;
                },
                is: (column: string, value: unknown) => {
                    filters.push({ kind: 'is', column, value });
                    mocks.calls.push({ op: 'is', column, value });
                    return builder;
                },
                maybeSingle: async () => {
                    const row = matches() ? mocks.row : null;
                    if (mode === 'delete' && row) mocks.row = null;
                    return { data: row, error: null };
                },
            };
            return builder;
        },
    },
}));

import { setAuthIdentityScope } from '../services/authIdentityScope';
import { deleteDraftVoyageById } from '../services/VoyageService';

const ownedPlanningRow = (savedRouteId: string | null): Record<string, unknown> => ({
    id: '123e4567-e89b-42d3-a456-426614174000',
    user_id: 'account-a',
    status: 'planning',
    saved_route_id: savedRouteId,
});

describe('deleteDraftVoyageById — exact saved-route graph links', () => {
    beforeEach(() => {
        localStorage.clear();
        vi.clearAllMocks();
        mocks.calls = [];
        mocks.getUser.mockResolvedValue({ data: { user: { id: 'account-a' } }, error: null });
        setAuthIdentityScope('account-a');
    });

    afterEach(() => {
        setAuthIdentityScope(null);
    });

    it('removes a legacy null-linked planning row only when an exact graph link opts in', async () => {
        mocks.row = ownedPlanningRow(null);

        await expect(
            deleteDraftVoyageById('123e4567-e89b-42d3-a456-426614174000', 'trace-canonical', {
                allowUnlinkedSavedRoute: true,
            }),
        ).resolves.toBe(true);

        expect(mocks.row).toBeNull();
        expect(mocks.calls).toContainEqual({ op: 'is', column: 'saved_route_id', value: null });
    });

    it('does not delete an unlinked row without the exact-link opt-in', async () => {
        mocks.row = ownedPlanningRow(null);

        await expect(deleteDraftVoyageById('123e4567-e89b-42d3-a456-426614174000', 'trace-canonical')).resolves.toBe(
            false,
        );

        expect(mocks.row).toEqual(ownedPlanningRow(null));
        expect(mocks.calls.some((call) => call.op === 'delete')).toBe(false);
    });

    it('never deletes a row already linked to a different saved route', async () => {
        mocks.row = ownedPlanningRow('trace-someone-else');

        await expect(
            deleteDraftVoyageById('123e4567-e89b-42d3-a456-426614174000', 'trace-canonical', {
                allowUnlinkedSavedRoute: true,
            }),
        ).resolves.toBe(false);

        expect(mocks.row).toEqual(ownedPlanningRow('trace-someone-else'));
        expect(mocks.calls.some((call) => call.op === 'delete')).toBe(false);
    });
});
