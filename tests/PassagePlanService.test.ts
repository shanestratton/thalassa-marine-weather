/**
 * PassagePlanService — localStorage + status tests
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/supabase', () => ({ supabase: null }));
vi.mock('../services/CrewService', () => ({
    DEFAULT_PERMISSIONS: {
        can_view_passage: false,
        can_view_passage_meals: false,
        can_view_passage_chat: false,
        can_view_passage_route: false,
        can_view_passage_checklist: false,
    },
    getMyMemberships: vi.fn().mockResolvedValue([]),
}));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
    setActivePassage,
    getActivePassageId,
    clearPassagePlan,
    hasLocalPassagePlan,
    getPassageStatus,
    getPassageStatusSync,
} from '../services/PassagePlanService';

describe('PassagePlanService', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    describe('setActivePassage / getActivePassageId', () => {
        it('returns null when no passage set', () => {
            expect(getActivePassageId()).toBeNull();
        });

        it('persists and retrieves passage ID', () => {
            setActivePassage('v-123');
            expect(getActivePassageId()).toBe('v-123');
        });

        it('dispatches thalassa:passage-changed event', () => {
            const listener = vi.fn();
            window.addEventListener('thalassa:passage-changed', listener);
            setActivePassage('v-123');
            expect(listener).toHaveBeenCalled();
            window.removeEventListener('thalassa:passage-changed', listener);
        });
    });

    describe('clearPassagePlan', () => {
        it('removes passage from localStorage', () => {
            setActivePassage('v-123');
            clearPassagePlan();
            expect(getActivePassageId()).toBeNull();
        });

        it('dispatches passage-changed event with null', () => {
            const listener = vi.fn();
            window.addEventListener('thalassa:passage-changed', listener);
            clearPassagePlan();
            expect(listener).toHaveBeenCalled();
            window.removeEventListener('thalassa:passage-changed', listener);
        });
    });

    describe('hasLocalPassagePlan (deprecated compat)', () => {
        it('returns false when no passage', () => {
            expect(hasLocalPassagePlan()).toBe(false);
        });

        it('returns true when passage is set', () => {
            setActivePassage('v-123');
            expect(hasLocalPassagePlan()).toBe(true);
        });
    });

    describe('getPassageStatusSync', () => {
        it('returns hidden when no passage selected', () => {
            const status = getPassageStatusSync();
            expect(status.visible).toBe(false);
            expect(status.isOwner).toBe(false);
        });

        it('returns all-visible when passage is selected (assumes owner)', () => {
            setActivePassage('v-123');
            const status = getPassageStatusSync();
            expect(status.visible).toBe(true);
            expect(status.isOwner).toBe(true);
            expect(status.voyageId).toBe('v-123');
            expect(status.canViewMeals).toBe(true);
            expect(status.canViewChat).toBe(true);
            expect(status.canViewRoute).toBe(true);
            expect(status.canViewChecklist).toBe(true);
        });
    });

    describe('getPassageStatus (async)', () => {
        it('returns hidden when no passage and no crew memberships (offline)', async () => {
            const status = await getPassageStatus();
            expect(status.visible).toBe(false);
        });
    });
});
