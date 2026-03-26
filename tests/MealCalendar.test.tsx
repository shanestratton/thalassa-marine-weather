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
        };
        render(<MealCalendar {...baseProps} mealDays={mealDays} />);
        // 3 slots per day (breakfast, lunch, dinner)
        expect(screen.getByLabelText(/Add Breakfast meal/)).toBeDefined();
        expect(screen.getByLabelText(/Add Lunch meal/)).toBeDefined();
        expect(screen.getByLabelText(/Add Dinner meal/)).toBeDefined();
    });

    it('renders voyage name in header', () => {
        const mealDays = {
            dates: ['2026-03-27'],
            emergencyDates: new Set<string>(),
            passageDays: 1,
            emergencyDays: 0,
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
        };
        render(<MealCalendar {...baseProps} mealDays={mealDays} />);
        expect(screen.getByText('Buffer')).toBeDefined();
    });

    it('renders provision passage CTA when meals exist', () => {
        const mealDays = {
            dates: ['2026-03-27'],
            emergencyDates: new Set<string>(),
            passageDays: 1,
            emergencyDays: 0,
        };
        const meal = {
            id: 'm1',
            title: 'Eggs',
            planned_date: '2026-03-27',
            meal_slot: 'breakfast' as const,
            servings_planned: 4,
            status: 'reserved' as const,
            spoonacular_id: null,
            ingredients: [],
        };
        render(<MealCalendar {...baseProps} mealDays={mealDays} activeMeals={[meal]} />);
        expect(screen.getByLabelText(/Provision passage/)).toBeDefined();
    });
});
