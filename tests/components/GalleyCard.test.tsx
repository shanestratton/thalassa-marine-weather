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

describe('GalleyCard', () => {
    beforeEach(() => vi.clearAllMocks());

    it('renders without crashing', () => {
        const { container } = render(<GalleyCard onOpenCookingMode={vi.fn()} />);
        expect(container).toBeDefined();
    });

    it('renders content', () => {
        const { container } = render(<GalleyCard onOpenCookingMode={vi.fn()} />);
        expect(container.innerHTML.length).toBeGreaterThan(0);
    });
});
