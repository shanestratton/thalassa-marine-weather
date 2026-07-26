import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    deleteVoyageLogOnly: vi.fn(),
    deleteDraftVoyageById: vi.fn(),
    removeCachedDraftVoyageById: vi.fn(),
    getCachedActiveVoyage: vi.fn(),
    getCachedDraftVoyages: vi.fn(),
    invalidateRoutesAndTracks: vi.fn(),
}));

vi.mock('../services/supabase', () => ({ supabase: null }));
vi.mock('../services/shiplog/EntryCrud', () => ({
    deleteVoyageLogOnly: (...args: unknown[]) => mocks.deleteVoyageLogOnly(...args),
}));
vi.mock('../services/VoyageService', () => ({
    deleteDraftVoyageById: (...args: unknown[]) => mocks.deleteDraftVoyageById(...args),
    removeCachedDraftVoyageById: (...args: unknown[]) => mocks.removeCachedDraftVoyageById(...args),
    getCachedActiveVoyage: (...args: unknown[]) => mocks.getCachedActiveVoyage(...args),
    getCachedDraftVoyages: (...args: unknown[]) => mocks.getCachedDraftVoyages(...args),
}));
vi.mock('../services/shiplog/RoutesAndTracks', () => ({
    invalidateRoutesAndTracks: (...args: unknown[]) => mocks.invalidateRoutesAndTracks(...args),
}));

import { setAuthIdentityScope } from '../services/authIdentityScope';
import { deleteSavedRoutePassageGraph } from '../services/savedRouteGraph';

describe('saved route graph deletion', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setAuthIdentityScope('account-a');
        mocks.deleteVoyageLogOnly.mockResolvedValue(true);
        mocks.deleteDraftVoyageById.mockResolvedValue(true);
        mocks.getCachedActiveVoyage.mockReturnValue(null);
        mocks.getCachedDraftVoyages.mockReturnValue([]);
    });

    afterEach(() => {
        setAuthIdentityScope(null);
    });

    it('removes only the exact planning mirror and never invokes the active-passage cascade', async () => {
        const passageVoyageId = '123e4567-e89b-42d3-a456-426614174000';
        mocks.getCachedDraftVoyages.mockReturnValue([{ id: passageVoyageId }]);
        await expect(
            deleteSavedRoutePassageGraph('trace-a', {
                plannedRouteId: 'planned_route-a',
                passageVoyageId,
            }),
        ).resolves.toBe(true);

        expect(mocks.deleteVoyageLogOnly).toHaveBeenCalledWith('planned_route-a');
        expect(mocks.removeCachedDraftVoyageById).toHaveBeenCalledWith(
            passageVoyageId,
            expect.objectContaining({ userId: 'account-a' }),
            'trace-a',
        );
        expect(mocks.deleteDraftVoyageById).not.toHaveBeenCalled();
        expect(mocks.invalidateRoutesAndTracks).toHaveBeenCalledWith(expect.objectContaining({ userId: 'account-a' }));
    });

    it('keeps the mirror geometry while its exact linked passage is active', async () => {
        const passageVoyageId = '123e4567-e89b-42d3-a456-426614174000';
        mocks.getCachedActiveVoyage.mockReturnValue({ id: passageVoyageId });

        await expect(
            deleteSavedRoutePassageGraph('trace-a', {
                plannedRouteId: 'planned_route-a',
                passageVoyageId,
            }),
        ).resolves.toBe(false);

        expect(mocks.deleteVoyageLogOnly).not.toHaveBeenCalled();
        expect(mocks.removeCachedDraftVoyageById).not.toHaveBeenCalled();
        expect(mocks.deleteDraftVoyageById).not.toHaveBeenCalled();
    });
});
