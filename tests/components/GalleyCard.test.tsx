/**
 * GalleyCard — smoke tests (630 LOC chat component)
 */
import React from 'react';
import { render } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../services/MealPlanService', () => ({
    MealPlanService: {
        getMealsForRange: vi.fn().mockResolvedValue([]),
        getTodaysMeals: vi.fn().mockResolvedValue([]),
        scheduleMeal: vi.fn().mockResolvedValue(undefined),
        deleteMeal: vi.fn().mockResolvedValue(undefined),
    },
}));
vi.mock('../../utils/system', () => ({ triggerHaptic: vi.fn() }));

import { GalleyCard } from '../../components/chat/GalleyCard';
import type { PassageStatus } from '../../services/PassagePlanService';

const ownerPassageStatus: PassageStatus = {
    visible: true,
    voyageId: 'voyage-1',
    ownerUserId: 'owner-1',
    isOwner: true,
    canEditStores: true,
    canViewMeals: true,
    canViewChat: true,
    canViewRoute: true,
    canViewChecklist: true,
};

describe('GalleyCard', () => {
    beforeEach(() => vi.clearAllMocks());

    it('renders without crashing', () => {
        const { container } = render(<GalleyCard passageStatus={ownerPassageStatus} onOpenCookingMode={vi.fn()} />);
        expect(container).toBeDefined();
    });

    it('renders content', () => {
        const { container } = render(<GalleyCard passageStatus={ownerPassageStatus} onOpenCookingMode={vi.fn()} />);
        expect(container.innerHTML.length).toBeGreaterThan(0);
    });

    it('fails closed when passage access has not been verified', () => {
        const { container } = render(<GalleyCard onOpenCookingMode={vi.fn()} />);
        expect(container).toBeEmptyDOMElement();
    });
});
