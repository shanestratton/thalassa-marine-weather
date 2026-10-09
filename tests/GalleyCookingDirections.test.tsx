/**
 * Cooking Mode shows the sailor's own directions (126-B2a, binder audit
 * GAL-07; Shane 2026-10-09: "check all of the binders to make sure that they
 * are at the same standard as the rest of the app").
 *
 * Cooking Mode looked steps up only by `spoonacular_id` and JSON-parsed them,
 * so a recipe written in the Galley (plain-text directions, no Spoonacular id)
 * always showed the generic five-line checklist. It now reads the recipe the
 * meal links to (`recipe_id`), plain text or JSON, and only a real Spoonacular
 * id ever goes to the provider.
 *
 * A real render: the real GalleyCookingMode, the real GalleyRecipeService and
 * MealPlanService, over the real LocalDatabase. Only the filesystem (the
 * global test mock) and haptics are stubbed. Fictional recipes only.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { Filesystem } from '@capacitor/filesystem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));

import { setAuthIdentityScope } from '../services/authIdentityScope';
import { initLocalDatabase, insertLocal, mergePulledRecords } from '../services/vessel/LocalDatabase';
import { createCustomRecipe, getMealSteps, searchRecipes, type StoredRecipe } from '../services/GalleyRecipeService';
import { copyMealPlan, scheduleMeal, type MealPlan } from '../services/MealPlanService';
import { supabase } from '../services/supabase';
import { FEATURE_VISIBILITY } from '../utils/featureVisibility';
import { GalleyCookingMode } from '../components/passage/GalleyCookingMode';

const NOW = '2026-10-10T00:00:00.000Z';
const PAO_DE_QUEIJO = '4b5c6d7e-8f9a-4b0c-9d1e-2f3a4b5c6d7e';
let phone = 0;

function cookingMeal(overrides: Partial<MealPlan>): MealPlan {
    return {
        id: `meal-${phone}`,
        user_id: `cook-${phone}`,
        voyage_id: null,
        recipe_id: null,
        spoonacular_id: null,
        title: 'Feijoada',
        planned_date: '2026-10-12',
        meal_slot: 'dinner',
        servings_planned: 6,
        ingredients: [{ name: 'Black beans', amount: 500, unit: 'g', scalable: true, aisle: 'Dry' }],
        status: 'cooking',
        cook_started_at: NOW,
        completed_at: null,
        leftovers_saved: false,
        notes: null,
        created_at: NOW,
        updated_at: NOW,
        ...overrides,
    };
}

function renderCooking(meal: MealPlan) {
    return render(<GalleyCookingMode meal={meal} onClose={vi.fn()} onComplete={vi.fn()} />);
}

const stepLabels = () =>
    screen.getAllByRole('button', { name: /^Mark complete:/ }).map((step) => step.getAttribute('aria-label'));

beforeEach(async () => {
    phone += 1;
    localStorage.clear();
    localStorage.setItem('thalassa_localdb_moved_to_library', '1');
    vi.mocked(Filesystem.readdir).mockResolvedValue({ files: [] });
    vi.mocked(Filesystem.writeFile).mockResolvedValue({ uri: 'mock://file' });
    setAuthIdentityScope(`cook-${phone}`);
    await initLocalDatabase(`cook-${phone}`);
});

afterEach(() => {
    (FEATURE_VISIBILITY as { spoonacular: boolean }).spoonacular = false;
    setAuthIdentityScope(null);
    localStorage.clear();
});

describe('Cooking Mode reads the recipe the meal links to', () => {
    it('a Galley recipe with plain-text directions shows those steps, not the checklist', async () => {
        const recipe = await createCustomRecipe({
            title: 'Feijoada',
            instructions: 'Soak beans.\r\n\r\nBrown pork.\nSimmer 2 h.',
            ready_in_minutes: 180,
            servings: 6,
            ingredients: [],
            tags: [],
            visibility: 'personal',
        });

        renderCooking(cookingMeal({ recipe_id: recipe!.id }));

        expect(await screen.findByText('Recipe directions')).toBeInTheDocument();
        expect(stepLabels()).toEqual([
            'Mark complete: Step 1, Soak beans.',
            'Mark complete: Step 2, Brown pork.',
            'Mark complete: Step 3, Simmer 2 h.',
        ]);
        expect(screen.queryByText('Prepare your workspace and galley equipment')).not.toBeInTheDocument();
    });

    it('a community twin with JSON RecipeStep[] directions shows its steps', async () => {
        const twin: StoredRecipe = {
            id: PAO_DE_QUEIJO,
            spoonacular_id: null,
            user_id: 'sailor-9',
            title: 'Pão de queijo',
            image_url: '',
            ready_in_minutes: 40,
            servings: 4,
            source_url: '',
            instructions: JSON.stringify([
                { number: 1, step: 'Scald the milk and oil.' },
                { number: 2, step: 'Beat in the tapioca flour, egg and cheese.' },
            ]),
            ingredients: [],
            is_favorite: false,
            is_custom: true,
            visibility: 'shared',
            tags: [],
            created_at: NOW,
            updated_at: NOW,
        };
        await mergePulledRecords('recipes', [twin]);

        renderCooking(cookingMeal({ title: 'Pão de queijo', recipe_id: PAO_DE_QUEIJO }));

        expect(await screen.findByText('Recipe directions')).toBeInTheDocument();
        expect(stepLabels()).toEqual([
            'Mark complete: Step 1, Scald the milk and oil.',
            'Mark complete: Step 2, Beat in the tapioca flour, egg and cheese.',
        ]);
    });

    it('no recipe link and no real Spoonacular id: the checklist, and no network', async () => {
        // Even with the provider switched on, a display key is never sent to it.
        (FEATURE_VISIBILITY as { spoonacular: boolean }).spoonacular = true;
        const invoke = vi.fn(async () => ({ data: null, error: null }));
        const client = supabase as unknown as { functions?: { invoke: typeof invoke } };
        const previousFunctions = client.functions;
        client.functions = { invoke };
        const fetchSpy = vi.spyOn(globalThis, 'fetch');

        try {
            renderCooking(cookingMeal({ title: 'Ψαρόσουπα (fish soup)', spoonacular_id: 1791234567890.42 }));

            expect(
                await screen.findByText(
                    'Detailed recipe directions are unavailable. Use this galley checklist with your saved recipe source.',
                ),
            ).toBeInTheDocument();
            expect(stepLabels()).toHaveLength(5);
            expect(invoke).not.toHaveBeenCalled();
            expect(fetchSpy).not.toHaveBeenCalled();
        } finally {
            client.functions = previousFunctions;
            fetchSpy.mockRestore();
        }
    });
});

describe('a recipe reaches Cooking Mode by the paths a sailor actually takes', () => {
    it('offline at sea: his own Galley recipe, found in the phone’s library and planned, cooks from his directions', async () => {
        const recipe = await createCustomRecipe({
            title: 'Feijoada',
            instructions: 'Soak beans.\nBrown pork.',
            ready_in_minutes: 180,
            servings: 6,
            ingredients: [{ name: 'Black beans', amount: 500, unit: 'g', scalable: true, aisle: 'Dry' }],
            tags: [],
            visibility: 'personal',
        });
        // No connection: both server tiers fail, so the search falls back to the phone's library.
        const client = supabase as unknown as { from: (...args: unknown[]) => unknown };
        const from = vi.spyOn(client, 'from').mockImplementation(() => {
            throw new TypeError('Failed to fetch');
        });

        try {
            const [found] = await searchRecipes('feijoada');
            expect(found).toMatchObject({ title: 'Feijoada', source: 'private', recipeId: recipe!.id });

            const plan = await scheduleMeal(found, '2026-10-12', 'dinner', null, 6, `cook-${phone}`);

            expect(plan).toMatchObject({ recipe_id: recipe!.id, spoonacular_id: null });
            expect(await getMealSteps(plan)).toEqual([
                { number: 1, step: 'Soak beans.' },
                { number: 2, step: 'Brown pork.' },
            ]);
        } finally {
            from.mockRestore();
        }
    });

    it('a meal planned before 126, copied to another day, keeps its recipe directions', async () => {
        // What the old persistRecipe stored: the steps under the search result's display key.
        const legacyKey = 1791234567890.42;
        const legacy: StoredRecipe = {
            id: '8c9d0e1f-2a3b-4c4d-9e5f-6a7b8c9d0e1f',
            spoonacular_id: legacyKey,
            user_id: null,
            title: 'Ψαρόσουπα (fish soup)',
            image_url: '',
            ready_in_minutes: 60,
            servings: 4,
            source_url: '',
            instructions: JSON.stringify([
                { number: 1, step: 'Simmer the fish heads.' },
                { number: 2, step: 'Strain and add the potatoes.' },
            ]),
            ingredients: [],
            is_favorite: false,
            is_custom: false,
            visibility: 'personal',
            tags: [],
            created_at: NOW,
            updated_at: NOW,
        };
        await insertLocal('recipes', legacy);
        const before = cookingMeal({ title: legacy.title, spoonacular_id: legacyKey, status: 'reserved' });

        const copy = await copyMealPlan(before, '2026-10-13', null, `cook-${phone}`);

        // The display key cannot go to the server; the copy links to the row instead.
        expect(copy).toMatchObject({ recipe_id: legacy.id, spoonacular_id: null, planned_date: '2026-10-13' });
        renderCooking({ ...copy, status: 'cooking', cook_started_at: NOW });
        expect(await screen.findByText('Recipe directions')).toBeInTheDocument();
        expect(stepLabels()).toEqual([
            'Mark complete: Step 1, Simmer the fish heads.',
            'Mark complete: Step 2, Strain and add the potatoes.',
        ]);
    });
});
