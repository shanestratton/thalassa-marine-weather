import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MealPlan } from '../services/MealPlanService';
import type { PassageStatus } from '../services/PassagePlanService';

const serviceMocks = vi.hoisted(() => ({
    getMealsByStatus: vi.fn(),
    getShoppingList: vi.fn(),
    getRecipeInstructions: vi.fn(),
    startCooking: vi.fn(),
    completeMeal: vi.fn(),
    saveLeftovers: vi.fn(),
    skipMeal: vi.fn(),
}));

vi.mock('../services/MealPlanService', () => ({
    getMealsByStatus: serviceMocks.getMealsByStatus,
    calculateMealDays: vi.fn(),
    getCrewCount: vi.fn().mockResolvedValue(4),
    startCooking: serviceMocks.startCooking,
    completeMeal: serviceMocks.completeMeal,
    saveLeftovers: serviceMocks.saveLeftovers,
    skipMeal: serviceMocks.skipMeal,
}));

vi.mock('../services/GalleyRecipeService', () => ({
    getRecipeInstructions: serviceMocks.getRecipeInstructions,
}));

vi.mock('../services/ShoppingListService', () => ({
    getShoppingList: serviceMocks.getShoppingList,
    markPurchased: vi.fn(),
}));

vi.mock('../services/VoyageService', () => ({
    getCachedActiveVoyage: vi.fn(() => null),
    getActiveVoyage: vi.fn().mockResolvedValue(null),
    getDraftVoyages: vi.fn().mockResolvedValue([]),
}));

vi.mock('../services/PassagePlanService', () => ({
    getActivePassageId: vi.fn(() => null),
}));

vi.mock('../services/PurchaseUnits', () => ({
    toPurchasable: vi.fn(),
}));

vi.mock('../contexts/CrewCountContext', () => ({
    useCrewCount: () => ({
        crewCount: 4,
        setCrewCount: vi.fn(),
    }),
}));

vi.mock('../utils/system', () => ({
    triggerHaptic: vi.fn(),
}));

vi.mock('../components/chat/MealCalendar', () => ({
    MealCalendar: ({ activeMeals, onCookNow }: { activeMeals: MealPlan[]; onCookNow: (meal: MealPlan) => void }) => (
        <button type="button" onClick={() => onCookNow(activeMeals[0])}>
            Start cooking {activeMeals[0]?.title}
        </button>
    ),
}));

vi.mock('../components/chat/CaptainsTable', () => ({
    CaptainsTable: () => <div>Recipe library</div>,
}));

import { GalleyCard } from '../components/chat/GalleyCard';
import { GalleyCookingMode } from '../components/passage/GalleyCookingMode';

const meal: MealPlan = {
    id: 'meal-1',
    voyage_id: 'voyage-1',
    recipe_id: 'recipe-1',
    spoonacular_id: 123,
    title: 'Sea pasta',
    planned_date: '2026-07-23',
    meal_slot: 'dinner',
    servings_planned: 4,
    ingredients: [],
    status: 'reserved',
    cook_started_at: null,
    completed_at: null,
    leftovers_saved: false,
    notes: null,
    created_at: '2026-07-23T07:00:00.000Z',
    updated_at: '2026-07-23T07:00:00.000Z',
};

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

describe('Galley cooking mode production integration', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        serviceMocks.getMealsByStatus.mockImplementation((status: string) => (status === 'reserved' ? [meal] : []));
        serviceMocks.getShoppingList.mockReturnValue({
            total: 0,
            purchased: 0,
            remaining: 0,
            zones: [],
        });
        serviceMocks.getRecipeInstructions.mockResolvedValue([
            { number: 1, step: 'Heat the pan' },
            { number: 2, step: 'Cook the pasta' },
        ]);
        serviceMocks.startCooking.mockResolvedValue({ ...meal, status: 'cooking' });
        serviceMocks.completeMeal.mockResolvedValue({ ...meal, status: 'completed' });
        serviceMocks.saveLeftovers.mockResolvedValue(undefined);
        serviceMocks.skipMeal.mockResolvedValue({ ...meal, status: 'skipped' });
    });

    it('launches one canonical workflow and mutates stores only at its explicit lifecycle actions', async () => {
        render(<GalleyCard passageStatus={ownerPassageStatus} />);

        fireEvent.click(screen.getByRole('button', { name: 'Voyage Provisioning' }));
        fireEvent.click(await screen.findByRole('button', { name: /Meal Planner/ }));

        const opener = await screen.findByRole('button', { name: 'Start cooking Sea pasta' });
        opener.focus();
        fireEvent.click(opener);

        const cookingDialog = screen.getByRole('dialog', { name: /Cooking Mode/ });
        expect(cookingDialog).toBeInTheDocument();
        expect(serviceMocks.startCooking).not.toHaveBeenCalled();
        expect(serviceMocks.completeMeal).not.toHaveBeenCalled();

        await waitFor(() =>
            expect(screen.getByRole('progressbar', { name: 'Cooking progress' })).toHaveAttribute('aria-valuemax', '2'),
        );
        fireEvent.click(screen.getByRole('button', { name: /Start Cooking/ }));

        await waitFor(() => expect(serviceMocks.startCooking).toHaveBeenCalledOnce());
        expect(await screen.findByText('Heat the pan')).toBeInTheDocument();
        const steps = await screen.findAllByRole('button', { name: /^Mark complete:/ });
        expect(steps).toHaveLength(2);
        fireEvent.click(steps[0]);
        fireEvent.click(steps[1]);

        fireEvent.click(await screen.findByRole('button', { name: /Complete & Subtract from Stores/ }));

        await waitFor(() => {
            expect(serviceMocks.completeMeal).toHaveBeenCalledWith('meal-1', 4);
            expect(screen.queryByRole('dialog', { name: /Cooking Mode/ })).not.toBeInTheDocument();
        });
        expect(opener).toHaveFocus();
    });

    it('locks repeated start actions while the first write is pending', async () => {
        let resolveStart!: (value: MealPlan) => void;
        serviceMocks.startCooking.mockImplementationOnce(
            () =>
                new Promise<MealPlan>((resolve) => {
                    resolveStart = resolve;
                }),
        );

        render(<GalleyCookingMode meal={meal} onClose={vi.fn()} onComplete={vi.fn()} />);
        const startButton = screen.getByRole('button', { name: /Start Cooking/ });

        fireEvent.click(startButton);
        fireEvent.click(startButton);
        expect(serviceMocks.startCooking).toHaveBeenCalledOnce();

        await act(async () => {
            resolveStart({ ...meal, status: 'cooking' });
        });
        expect(await screen.findByText('Heat the pan')).toBeInTheDocument();
    });
});
