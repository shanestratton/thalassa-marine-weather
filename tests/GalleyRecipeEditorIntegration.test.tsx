import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GalleyPage } from '../components/vessel/GalleyPage';
import type { CreateRecipeInput, StoredRecipe } from '../services/GalleyRecipeService';
import { setAuthIdentityScope } from '../services/authIdentityScope';

const galleyMocks = vi.hoisted(() => ({
    getStoredRecipes: vi.fn(),
    createCustomRecipe: vi.fn(),
    updateCustomRecipe: vi.fn(),
}));

const mealMocks = vi.hoisted(() => ({
    getMealsByStatus: vi.fn(),
    startCooking: vi.fn(),
    completeMeal: vi.fn(),
    getStoresAvailability: vi.fn(),
}));

const shoppingMocks = vi.hoisted(() => ({
    getShoppingList: vi.fn(),
}));

vi.mock('../services/GalleyRecipeService', () => ({
    getStoredRecipes: galleyMocks.getStoredRecipes,
    createCustomRecipe: galleyMocks.createCustomRecipe,
    updateCustomRecipe: galleyMocks.updateCustomRecipe,
}));

vi.mock('../services/MealPlanService', () => ({
    getMealsByStatus: mealMocks.getMealsByStatus,
    getMealPlans: vi.fn(),
    startCooking: mealMocks.startCooking,
    completeMeal: mealMocks.completeMeal,
    getStoresAvailability: mealMocks.getStoresAvailability,
}));

vi.mock('../services/ShoppingListService', () => ({
    getShoppingList: shoppingMocks.getShoppingList,
}));

vi.mock('../utils/system', () => ({
    triggerHaptic: vi.fn(),
}));

vi.mock('../stores/authStore', () => ({
    useAuthStore: (selector: (state: { user: { id: string } }) => unknown) => selector({ user: { id: 'user-1' } }),
}));

const baseRecipe: StoredRecipe = {
    id: 'recipe-1',
    spoonacular_id: null,
    user_id: 'user-1',
    title: 'Sea Curry',
    image_url: 'https://example.test/curry.jpg',
    ready_in_minutes: 45,
    servings: 4,
    source_url: '',
    instructions: JSON.stringify([{ number: 1, step: 'Warm the pan' }]),
    ingredients: [{ name: 'Fish', amount: 2, unit: 'fillets', scalable: true, aisle: 'Seafood' }],
    is_favorite: false,
    is_custom: true,
    visibility: 'shared',
    tags: ['Dinner'],
    created_at: '2026-07-22T08:00:00.000Z',
    updated_at: '2026-07-22T08:00:00.000Z',
};

let storedRecipes: StoredRecipe[];

function openRecipeLibrary() {
    fireEvent.click(screen.getByRole('tab', { name: /Saved Recipes/ }));
}

function advanceToIngredients() {
    fireEvent.click(screen.getByRole('button', { name: 'Continue to step 2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue to step 3' }));
}

function advanceFromIngredientsToSave() {
    fireEvent.click(screen.getByRole('button', { name: 'Continue to step 4' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue to step 5' }));
}

beforeEach(() => {
    vi.clearAllMocks();
    setAuthIdentityScope(null);
    setAuthIdentityScope('user-1');
    storedRecipes = [];
    galleyMocks.getStoredRecipes.mockImplementation(() => storedRecipes);
    galleyMocks.createCustomRecipe.mockImplementation(async (input: CreateRecipeInput) => {
        const created: StoredRecipe = {
            id: 'created-recipe',
            spoonacular_id: null,
            user_id: 'user-1',
            title: input.title,
            image_url: input.image_url ?? '',
            ready_in_minutes: input.ready_in_minutes,
            servings: input.servings,
            source_url: '',
            instructions: input.instructions,
            ingredients: input.ingredients,
            is_favorite: false,
            is_custom: true,
            visibility: input.visibility,
            tags: input.tags,
            created_at: '2026-07-23T08:00:00.000Z',
            updated_at: '2026-07-23T08:00:00.000Z',
        };
        storedRecipes = [created];
        return created;
    });
    galleyMocks.updateCustomRecipe.mockImplementation(async (recipeId: string, patch: Partial<StoredRecipe>) => {
        const existing = storedRecipes.find((recipe) => recipe.id === recipeId);
        if (!existing) return null;
        const updated = { ...existing, ...patch };
        storedRecipes = storedRecipes.map((recipe) => (recipe.id === recipeId ? updated : recipe));
        return updated;
    });
    mealMocks.getMealsByStatus.mockReturnValue([]);
    mealMocks.startCooking.mockResolvedValue(true);
    mealMocks.completeMeal.mockResolvedValue(true);
    mealMocks.getStoresAvailability.mockReturnValue([]);
    shoppingMocks.getShoppingList.mockReturnValue(null);
});

describe('Galley recipe editor integration', () => {
    it('creates a recipe from the production library entry point and refreshes the list', async () => {
        render(<GalleyPage onBack={vi.fn()} />);
        openRecipeLibrary();

        const openEditor = screen.getByRole('button', { name: '+ New Recipe' });
        openEditor.focus();
        fireEvent.click(openEditor);

        expect(screen.getByRole('dialog', { name: 'NEW RECIPE' })).toBeInTheDocument();
        fireEvent.change(screen.getByRole('textbox', { name: 'Recipe Title' }), {
            target: { value: 'One-pot Sea Stew' },
        });
        advanceToIngredients();
        fireEvent.change(screen.getByRole('textbox', { name: 'Ingredient 1 name' }), {
            target: { value: 'Potato' },
        });
        advanceFromIngredientsToSave();
        fireEvent.click(screen.getByRole('button', { name: 'Save recipe' }));

        await waitFor(() => {
            expect(galleyMocks.createCustomRecipe).toHaveBeenCalledWith(
                expect.objectContaining({
                    title: 'One-pot Sea Stew',
                    ingredients: [expect.objectContaining({ name: 'Potato' })],
                }),
            );
        });
        expect(screen.queryByRole('dialog', { name: 'NEW RECIPE' })).not.toBeInTheDocument();
        expect(screen.getByText('One-pot Sea Stew')).toBeInTheDocument();
        expect(openEditor).toHaveFocus();
    });

    it('opens authored recipes in edit mode, normalizes legacy instructions, and persists changes', async () => {
        storedRecipes = [baseRecipe];
        render(<GalleyPage onBack={vi.fn()} />);
        openRecipeLibrary();

        const editButton = screen.getByRole('button', { name: 'Edit Sea Curry' });
        editButton.focus();
        fireEvent.click(editButton);

        expect(screen.getByRole('dialog', { name: 'EDIT RECIPE' })).toBeInTheDocument();
        const titleInput = screen.getByRole('textbox', { name: 'Recipe Title' });
        expect(titleInput).toHaveValue('Sea Curry');
        expect(titleInput).toHaveFocus();
        expect(screen.getByRole('textbox', { name: /Photo URL/ })).toHaveValue('https://example.test/curry.jpg');

        fireEvent.change(titleInput, { target: { value: 'Harbour Curry' } });
        advanceToIngredients();
        fireEvent.click(screen.getByRole('button', { name: 'Continue to step 4' }));
        expect(screen.getByRole('textbox', { name: 'Cooking Instructions' })).toHaveValue('Warm the pan');
        fireEvent.click(screen.getByRole('button', { name: 'Continue to step 5' }));
        fireEvent.click(screen.getByRole('button', { name: 'Save recipe changes' }));

        await waitFor(() => {
            expect(galleyMocks.updateCustomRecipe).toHaveBeenCalledWith(
                'recipe-1',
                expect.objectContaining({
                    title: 'Harbour Curry',
                    instructions: 'Warm the pan',
                    image_url: 'https://example.test/curry.jpg',
                    visibility: 'shared',
                }),
            );
        });
        expect(screen.queryByRole('dialog', { name: 'EDIT RECIPE' })).not.toBeInTheDocument();
        expect(screen.getByText('Harbour Curry')).toBeInTheDocument();
        expect(editButton).toHaveFocus();
    });

    it("does not offer editing for another sailor's saved community recipe", () => {
        storedRecipes = [{ ...baseRecipe, user_id: 'another-user' }];
        render(<GalleyPage onBack={vi.fn()} />);
        openRecipeLibrary();

        expect(screen.getByText('Sea Curry')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Edit Sea Curry' })).not.toBeInTheDocument();
    });
});
