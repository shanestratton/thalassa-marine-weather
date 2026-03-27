/**
 * ChefPlate — component tests
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock service dependencies
vi.mock('../services/MealPlanService', () => ({
    startCooking: vi.fn().mockResolvedValue(undefined),
    getStoresAvailability: vi.fn(() => [
        { item_name: 'eggs', available: 12, unit: 'pcs' },
        { item_name: 'butter', available: 2, unit: 'tbsp' },
    ]),
}));

vi.mock('../services/GalleyRecipeService', () => ({
    scaleIngredient: vi.fn(
        (amount: number, _scalable: boolean, _base: number, crew: number) =>
            Math.round(((amount * crew) / 4) * 10) / 10,
    ),
    getRecipeImageUrl: vi.fn(() => ''),
    getGalleyDifficulty: vi.fn(() => ({ score: 2, label: 'Simple', emoji: '🟢' })),
}));

vi.mock('../services/ShoppingListService', () => ({
    addManualItem: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../utils/system', () => ({ triggerHaptic: vi.fn() }));

import { ChefPlate } from '../components/chat/ChefPlate';

const makeMeal = (overrides = {}) => ({
    id: 'meal-1',
    title: '🍳 Scrambled Eggs',
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
    ingredients: [
        { name: 'eggs', amount: 4, unit: 'pcs', scalable: true, aisle: 'Dairy' },
        { name: 'butter', amount: 1, unit: 'tbsp', scalable: true, aisle: 'Dairy' },
        { name: 'truffle oil', amount: 0.5, unit: 'tbsp', scalable: false, aisle: 'Oils' },
    ],
    ...overrides,
});

describe('ChefPlate', () => {
    const defaultProps = {
        meal: makeMeal(),
        baseServings: 4,
        cooking: false,
        onCook: vi.fn(),
        shoppingSummary: null,
    };

    beforeEach(() => vi.clearAllMocks());

    it('renders the meal title', () => {
        render(<ChefPlate {...defaultProps} />);
        expect(screen.getByText('🍳 Scrambled Eggs')).toBeDefined();
    });

    it('renders article role with aria-label', () => {
        render(<ChefPlate {...defaultProps} />);
        const article = screen.getByRole('article');
        expect(article.getAttribute('aria-label')).toContain('Scrambled Eggs');
    });

    it('renders crew scaler controls', () => {
        render(<ChefPlate {...defaultProps} />);
        expect(screen.getByLabelText('Decrease servings')).toBeDefined();
        expect(screen.getByLabelText('Increase servings')).toBeDefined();
    });

    it('renders start prep button when not cooking', () => {
        render(<ChefPlate {...defaultProps} />);
        expect(screen.getByLabelText('Start cooking this meal')).toBeDefined();
    });

    it('renders complete button when prep has been started', () => {
        render(<ChefPlate {...defaultProps} meal={makeMeal({ status: 'cooking' })} />);
        expect(screen.getByLabelText('Complete this meal')).toBeDefined();
    });

    it('renders ingredient list with listitem roles', () => {
        render(<ChefPlate {...defaultProps} />);
        const items = screen.getAllByRole('listitem');
        expect(items.length).toBe(3);
    });

    it('shows shortfall count when ingredients are missing from stores', () => {
        render(<ChefPlate {...defaultProps} />);
        // 'truffle oil' is not in mocked stores, so should show SHORTFALL
        expect(screen.getByText(/SHORTFALL/)).toBeDefined();
    });

    it('renders share button', () => {
        render(<ChefPlate {...defaultProps} />);
        expect(screen.getByLabelText('Share recipe')).toBeDefined();
    });

    it('increments crew count on + click', () => {
        render(<ChefPlate {...defaultProps} />);
        const plusBtn = screen.getByLabelText('Increase servings');
        fireEvent.click(plusBtn);
        // Should now show "5" in the count
        expect(screen.getByText('5')).toBeDefined();
    });
});
