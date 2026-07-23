import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CrewMember, CrewPermissions } from '../services/CrewService';
import type { Voyage } from '../services/VoyageService';
import { setAuthIdentityScope } from '../services/authIdentityScope';

const mocks = vi.hoisted(() => ({
    userId: 'crew-user',
    authError: false,
    queryError: false,
    voyages: [] as Voyage[],
    memberships: [] as CrewMember[],
    getMyMemberships: vi.fn(),
    getUser: vi.fn(),
    from: vi.fn(),
}));

vi.mock('../services/supabase', () => {
    const filterRows = (
        table: string,
        filters: Array<{ kind: 'eq' | 'in'; column: string; value: unknown }>,
    ): Array<Voyage | CrewMember> =>
        (table === 'vessel_crew' ? mocks.memberships : mocks.voyages).filter((row) =>
            filters.every((filter) => {
                const value = (row as unknown as Record<string, unknown>)[filter.column];
                return filter.kind === 'eq' ? value === filter.value : (filter.value as unknown[]).includes(value);
            }),
        );

    mocks.getUser.mockImplementation(async () => {
        if (mocks.authError) throw new Error('auth unavailable');
        return {
            data: {
                user: mocks.userId ? { id: mocks.userId, email: `${mocks.userId}@example.com` } : null,
            },
        };
    });
    mocks.from.mockImplementation((table: string) => {
        const filters: Array<{ kind: 'eq' | 'in'; column: string; value: unknown }> = [];
        const result = () =>
            mocks.queryError
                ? { data: null, error: { message: 'query failed' } }
                : { data: filterRows(table, filters), error: null };
        const builder: Record<string, unknown> = {};
        builder.select = vi.fn(() => builder);
        builder.eq = vi.fn((column: string, value: unknown) => {
            filters.push({ kind: 'eq', column, value });
            return builder;
        });
        builder.in = vi.fn((column: string, value: unknown[]) => {
            filters.push({ kind: 'in', column, value });
            return builder;
        });
        builder.maybeSingle = vi.fn(async () => {
            const response = result();
            return {
                data: Array.isArray(response.data) ? (response.data[0] ?? null) : null,
                error: response.error,
            };
        });
        builder.then = (
            resolve: (value: ReturnType<typeof result>) => unknown,
            reject?: (reason: unknown) => unknown,
        ) => Promise.resolve(result()).then(resolve, reject);
        return builder;
    });

    return {
        supabase: {
            auth: { getUser: mocks.getUser },
            from: mocks.from,
        },
    };
});

const defaultPermissions: CrewPermissions = {
    can_view_stores: false,
    can_edit_stores: false,
    can_view_galley: false,
    can_view_nav: false,
    can_view_weather: false,
    can_edit_log: false,
    can_view_passage: false,
    can_view_passage_meals: false,
    can_view_passage_chat: false,
    can_view_passage_route: false,
    can_view_passage_checklist: false,
};

vi.mock('../services/CrewService', () => ({
    DEFAULT_PERMISSIONS: {
        can_view_stores: false,
        can_edit_stores: false,
        can_view_galley: false,
        can_view_nav: false,
        can_view_weather: false,
        can_edit_log: false,
        can_view_passage: false,
        can_view_passage_meals: false,
        can_view_passage_chat: false,
        can_view_passage_route: false,
        can_view_passage_checklist: false,
    },
    getMyMemberships: mocks.getMyMemberships,
}));

vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
    clearPassagePlan,
    getActivePassageId,
    getAuthorizedSharedVoyages,
    getPassageStatus,
    getPassageStatusSync,
    hasLocalPassagePlan,
    setActivePassage,
} from '../services/PassagePlanService';

const voyage = (id: string, userId: string, status: Voyage['status'] = 'planning'): Voyage => ({
    id,
    user_id: userId,
    vessel_id: null,
    voyage_name: `Voyage ${id}`,
    departure_port: 'Brisbane',
    destination_port: 'Noumea',
    departure_time: null,
    eta: null,
    crew_count: 3,
    status,
    weather_master_id: userId,
    notes: null,
    created_at: '2026-07-23T00:00:00.000Z',
    updated_at: '2026-07-23T00:00:00.000Z',
});

const membership = (
    ownerId: string,
    voyageId: string | null,
    permissions: Partial<CrewPermissions> = {},
): CrewMember => ({
    id: `membership-${ownerId}-${voyageId ?? 'legacy'}`,
    owner_id: ownerId,
    crew_user_id: 'crew-user',
    crew_email: 'crew-user@example.com',
    owner_email: `${ownerId}@example.com`,
    shared_registers: ['passage_checklist'],
    permissions: {
        ...defaultPermissions,
        can_view_passage: true,
        can_view_passage_checklist: true,
        ...permissions,
    },
    status: 'accepted',
    role: 'deckhand',
    voyage_id: voyageId,
    created_at: '2026-07-23T00:00:00.000Z',
    updated_at: '2026-07-23T00:00:00.000Z',
});

describe('PassagePlanService', () => {
    beforeEach(() => {
        localStorage.clear();
        mocks.userId = 'crew-user';
        setAuthIdentityScope(null);
        setAuthIdentityScope(mocks.userId);
        mocks.authError = false;
        mocks.queryError = false;
        mocks.voyages = [];
        mocks.memberships = [];
        mocks.getMyMemberships.mockReset().mockResolvedValue([]);
        mocks.getUser.mockClear();
        mocks.from.mockClear();
    });

    describe('active selection', () => {
        it('persists, retrieves and clears one passage ID', () => {
            expect(getActivePassageId()).toBeNull();
            setActivePassage('voyage-1');
            expect(getActivePassageId()).toBe('voyage-1');
            expect(hasLocalPassagePlan()).toBe(true);

            clearPassagePlan();
            expect(getActivePassageId()).toBeNull();
            expect(hasLocalPassagePlan()).toBe(false);
        });

        it('dispatches exact selection and clear events', () => {
            const listener = vi.fn();
            window.addEventListener('thalassa:passage-changed', listener);

            setActivePassage('voyage-1');
            clearPassagePlan();

            expect(listener).toHaveBeenNthCalledWith(1, expect.objectContaining({ detail: { voyageId: 'voyage-1' } }));
            expect(listener).toHaveBeenNthCalledWith(2, expect.objectContaining({ detail: { voyageId: null } }));
            window.removeEventListener('thalassa:passage-changed', listener);
        });

        it('isolates the selected passage across accounts on the same device', () => {
            setActivePassage('crew-private-voyage');

            setAuthIdentityScope('other-user');
            expect(getActivePassageId()).toBeNull();
            setActivePassage('other-private-voyage');

            setAuthIdentityScope('crew-user');
            expect(getActivePassageId()).toBe('crew-private-voyage');
        });
    });

    describe('getPassageStatus', () => {
        it('verifies the explicit voyage rather than racing the local selection', async () => {
            mocks.userId = 'owner-2';
            setAuthIdentityScope(mocks.userId);
            mocks.voyages = [voyage('local-voyage', 'owner-1'), voyage('explicit-voyage', 'owner-2')];
            setActivePassage('local-voyage');

            const status = await getPassageStatus('explicit-voyage');

            expect(status.isOwner).toBe(true);
            expect(status.voyageId).toBe('explicit-voyage');
        });

        it('returns full access only when the authenticated user owns the resolved voyage', async () => {
            mocks.userId = 'owner-1';
            setAuthIdentityScope(mocks.userId);
            mocks.voyages = [voyage('voyage-1', 'owner-1')];

            const status = await getPassageStatus('voyage-1');

            expect(status).toMatchObject({
                visible: true,
                voyageId: 'voyage-1',
                ownerUserId: 'owner-1',
                isOwner: true,
                canEditStores: true,
                canViewMeals: true,
                canViewChat: true,
                canViewRoute: true,
                canViewChecklist: true,
            });
        });

        it('accepts a scoped membership only when its owner matches the voyage owner', async () => {
            mocks.voyages = [voyage('voyage-1', 'captain-1')];
            mocks.getMyMemberships.mockResolvedValue([
                membership('captain-1', 'voyage-1', {
                    can_view_passage_meals: true,
                    can_view_passage_checklist: false,
                    can_edit_stores: true,
                }),
            ]);

            const status = await getPassageStatus('voyage-1');

            expect(status).toMatchObject({
                visible: true,
                voyageId: 'voyage-1',
                ownerUserId: 'captain-1',
                isOwner: false,
                canEditStores: true,
                canViewMeals: true,
                canViewChecklist: false,
            });
        });

        it.each([
            ['scoped grant with the wrong owner', membership('attacker', 'voyage-1')],
            ['scoped grant for another voyage', membership('captain-1', 'voyage-2')],
            ['legacy grant with the wrong owner', membership('attacker', null)],
            [
                'grant belonging to another crew user',
                { ...membership('captain-1', 'voyage-1'), crew_user_id: 'someone-else' },
            ],
            ['unaccepted grant', { ...membership('captain-1', 'voyage-1'), status: 'pending' as const }],
        ])('rejects a %s', async (_label, candidate) => {
            mocks.voyages = [voyage('voyage-1', 'captain-1')];
            mocks.getMyMemberships.mockResolvedValue([candidate]);

            expect(await getPassageStatus('voyage-1')).toMatchObject({
                visible: false,
                voyageId: null,
            });
        });

        it('accepts a legacy grant only for a voyage actually owned by that captain', async () => {
            mocks.voyages = [voyage('voyage-1', 'captain-1')];
            mocks.getMyMemberships.mockResolvedValue([membership('captain-1', null)]);

            const status = await getPassageStatus('voyage-1');

            expect(status.visible).toBe(true);
            expect(status.voyageId).toBe('voyage-1');
            expect(status.isOwner).toBe(false);
        });

        it('unions matching scoped and legacy child grants like the database policies', async () => {
            mocks.voyages = [voyage('voyage-1', 'captain-1')];
            mocks.getMyMemberships.mockResolvedValue([
                membership('captain-1', null, {
                    can_view_passage_meals: true,
                    can_view_passage_checklist: false,
                }),
                membership('captain-1', 'voyage-1', {
                    can_view_passage_chat: true,
                    can_edit_stores: true,
                }),
            ]);

            expect(await getPassageStatus('voyage-1')).toMatchObject({
                visible: true,
                ownerUserId: 'captain-1',
                canEditStores: true,
                canViewMeals: true,
                canViewChat: true,
                canViewChecklist: true,
            });
        });

        it('never borrows Stores edit access from another vessel membership', async () => {
            mocks.voyages = [voyage('voyage-2', 'captain-2')];
            mocks.getMyMemberships.mockResolvedValue([
                membership('captain-1', null, {
                    can_view_passage_meals: true,
                    can_edit_stores: true,
                }),
                membership('captain-2', 'voyage-2', {
                    can_view_passage_meals: true,
                    can_edit_stores: false,
                }),
            ]);

            expect(await getPassageStatus('voyage-2')).toMatchObject({
                visible: true,
                voyageId: 'voyage-2',
                ownerUserId: 'captain-2',
                canEditStores: false,
                canViewMeals: true,
            });
        });

        it('discards a permission result that resolves after an account switch', async () => {
            mocks.voyages = [voyage('voyage-1', 'captain-1')];
            let resolveMemberships!: (rows: CrewMember[]) => void;
            mocks.getMyMemberships.mockReturnValueOnce(
                new Promise((resolve) => {
                    resolveMemberships = resolve;
                }),
            );

            const pending = getPassageStatus('voyage-1');
            await vi.waitFor(() => expect(mocks.getMyMemberships).toHaveBeenCalledTimes(1));
            setAuthIdentityScope('other-user');
            resolveMemberships([membership('captain-1', 'voyage-1', { can_edit_stores: true })]);

            expect(await pending).toEqual(
                expect.objectContaining({
                    visible: false,
                    voyageId: null,
                    canEditStores: false,
                }),
            );
        });

        it.each([
            ['an explicit empty selection', null, false, false],
            ['a missing voyage row', 'missing', false, false],
            ['a voyage lookup error', 'voyage-1', true, false],
            ['an authentication error', 'voyage-1', false, true],
        ])('fails closed for %s', async (_label, selectedId, queryError, authError) => {
            mocks.voyages = [voyage('voyage-1', 'captain-1')];
            mocks.queryError = queryError;
            mocks.authError = authError;
            mocks.getMyMemberships.mockResolvedValue([membership('captain-1', 'voyage-1')]);

            const status = await getPassageStatus(selectedId);

            expect(status.visible).toBe(false);
            expect(status.voyageId).toBeNull();
            expect(status.ownerUserId).toBeNull();
            expect(status.isOwner).toBe(false);
            expect(status.canEditStores).toBe(false);
        });
    });

    describe('getAuthorizedSharedVoyages', () => {
        it('resolves scoped rows and active/planning legacy-owner rows with ownership checks', async () => {
            mocks.voyages = [
                voyage('scoped', 'captain-1', 'completed'),
                voyage('legacy-planning', 'captain-2'),
                voyage('legacy-active', 'captain-2', 'active'),
                voyage('legacy-completed', 'captain-2', 'completed'),
                voyage('spoofed', 'different-owner'),
                voyage('own-voyage', 'crew-user'),
            ];

            mocks.memberships = [
                membership('captain-1', 'scoped'),
                membership('captain-2', null),
                membership('captain-1', 'spoofed'),
                membership('crew-user', 'own-voyage'),
            ];

            const result = await getAuthorizedSharedVoyages();

            expect(result.complete).toBe(true);
            expect(result.voyages.map(({ voyage: row }) => row.id).sort()).toEqual([
                'legacy-active',
                'legacy-planning',
                'scoped',
            ]);
            expect(result.voyages.find(({ voyage: row }) => row.id === 'scoped')?.ownerEmail).toBe(
                'captain-1@example.com',
            );
        });

        it('reports incomplete ownership resolution so callers cannot orphan-heal', async () => {
            mocks.voyages = [voyage('scoped', 'captain-1')];
            mocks.memberships = [membership('captain-1', 'scoped')];
            mocks.queryError = true;

            const result = await getAuthorizedSharedVoyages();

            expect(result).toEqual({ voyages: [], complete: false });
        });
    });

    it('keeps synchronous access fail-closed even with a local selection', () => {
        setActivePassage('voyage-1');
        expect(getPassageStatusSync()).toMatchObject({
            visible: false,
            voyageId: null,
            isOwner: false,
        });
    });
});
