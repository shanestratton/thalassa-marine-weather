/**
 * MealCalendar — component tests
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock service dependencies
vi.mock('../services/MealPlanService', () => ({
    scheduleMeal: vi.fn().mockResolvedValue(undefined),
    unscheduleMeal: vi.fn().mockResolvedValue(undefined),
    getStoresAvailability: vi.fn(() => []),
}));

vi.mock('../services/GalleyRecipeService', () => ({
    scaleIngredient: vi.fn((amount: number) => amount),
    searchRecipes: vi.fn().mockResolvedValue([]),
    getGalleyDifficulty: vi.fn(() => ({ score: 1, label: 'Simple', emoji: '🟢' })),
    getRecipeImageUrl: vi.fn(() => ''),
}));

vi.mock('../services/ShoppingListService', () => ({
    addManualItem: vi.fn().mockResolvedValue(undefined),
    getShoppingList: vi.fn(() => ({ total: 0, purchased: 0, remaining: 0, totalCost: 0, currency: 'AUD', zones: [] })),
}));

vi.mock('../utils/system', () => ({ triggerHaptic: vi.fn() }));

import { MealCalendar } from '../components/chat/MealCalendar';

describe('MealCalendar', () => {
    const baseProps = {
        crewCount: 4,
        voyageId: 'v1',
        voyageName: 'Brisbane to Sydney',
        activeMeals: [],
        onMealsChanged: vi.fn(),
        cookingMealId: null,
        onCookNow: vi.fn(),
        shoppingSummary: null,
        onCrewCountChange: vi.fn(),
        onShoppingChanged: vi.fn(),
    };

    beforeEach(() => vi.clearAllMocks());

    it('renders "Set Voyage Dates" when mealDays is null', () => {
        render(<MealCalendar {...baseProps} mealDays={null} />);
        expect(screen.getByText('Set Voyage Dates')).toBeDefined();
    });

    it('renders instruction text when no dates set', () => {
        render(<MealCalendar {...baseProps} mealDays={null} />);
        expect(screen.getByText(/Add departure and arrival dates/)).toBeDefined();
    });

    it('renders day grid when mealDays provided', () => {
        const mealDays = {
            dates: ['2026-03-27', '2026-03-28'],
            emergencyDates: new Set<string>(),
            passageDays: 2,
            emergencyDays: 0,
            totalDays: 2,
        };
        render(<MealCalendar {...baseProps} mealDays={mealDays} />);
        expect(screen.getByText('Day 1')).toBeDefined();
        expect(screen.getByText('Day 2')).toBeDefined();
    });

    it('renders grid role for accessibility', () => {
        const mealDays = {
            dates: ['2026-03-27'],
            emergencyDates: new Set<string>(),
            passageDays: 1,
            emergencyDays: 0,
            totalDays: 1,
        };
        render(<MealCalendar {...baseProps} mealDays={mealDays} />);
        expect(screen.getByRole('grid', { name: 'Meal calendar' })).toBeDefined();
    });

    it('renders crew count stepper', () => {
        const mealDays = {
            dates: ['2026-03-27'],
            emergencyDates: new Set<string>(),
            passageDays: 1,
            emergencyDays: 0,
            totalDays: 1,
        };
        render(<MealCalendar {...baseProps} mealDays={mealDays} />);
        expect(screen.getByLabelText('Decrease crew count')).toBeDefined();
        expect(screen.getByLabelText('Increase crew count')).toBeDefined();
    });

    it('renders empty slot buttons for each meal slot', () => {
        const mealDays = {
            dates: ['2026-03-27'],
            emergencyDates: new Set<string>(),
            passageDays: 1,
            emergencyDays: 0,
            totalDays: 1,
        };
        render(<MealCalendar {...baseProps} mealDays={mealDays} />);
        // 3 slots per day (Brekky, Lunch, Dinner per SLOT_CONFIG)
        expect(screen.getByLabelText(/Add Brekky meal/)).toBeDefined();
        expect(screen.getByLabelText(/Add Lunch meal/)).toBeDefined();
        expect(screen.getByLabelText(/Add Dinner meal/)).toBeDefined();
    });

    it('renders voyage name in header', () => {
        const mealDays = {
            dates: ['2026-03-27'],
            emergencyDates: new Set<string>(),
            passageDays: 1,
            emergencyDays: 0,
            totalDays: 1,
        };
        render(<MealCalendar {...baseProps} mealDays={mealDays} />);
        expect(screen.getByText(/Brisbane to Sydney/)).toBeDefined();
    });

    it('marks buffer days distinctively', () => {
        const mealDays = {
            dates: ['2026-03-27', '2026-03-28'],
            emergencyDates: new Set(['2026-03-28']),
            passageDays: 1,
            emergencyDays: 1,
            totalDays: 2,
        };
        render(<MealCalendar {...baseProps} mealDays={mealDays} />);
        expect(screen.getByText('Buffer')).toBeDefined();
    });

    it('renders provision CTA when meals exist', () => {
        const mealDays = {
            dates: ['2026-03-27'],
            emergencyDates: new Set<string>(),
            passageDays: 1,
            emergencyDays: 0,
            totalDays: 1,
        };
        const meal = {
            id: 'm1',
            title: 'Eggs',
            planned_date: '2026-03-27',
            meal_slot: 'breakfast' as const,
            servings_planned: 4,
            status: 'reserved' as const,
            spoonacular_id: null,
            voyage_id: null,
            recipe_id: null,
            cook_started_at: null,
            completed_at: null,
            leftovers_saved: false,
            notes: null,
            created_at: '2026-03-27T00:00:00Z',
            updated_at: '2026-03-27T00:00:00Z',
            ingredients: [],
        };
        render(<MealCalendar {...baseProps} mealDays={mealDays} activeMeals={[meal]} />);
        expect(screen.getByLabelText(/items to shopping list|fully stocked/i)).toBeDefined();
    });
});
