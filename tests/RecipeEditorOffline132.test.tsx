/**
 * The recipe editor tells the truth when a save does not happen (132-B18,
 * binder audit GAL-04: "offline Save fails with an untrue message"), and crew
 * editing a skipper's recipe are not offered the community choice; and the
 * Captain's Table does not offer to rate a recipe shared from the Galley
 * before the one recipe store is live.
 *
 * Real components; the save is a stub that fails on cue (the services' own
 * behaviour is RecipesOneStore132.test.ts). Fictional data only: 'Kestrel',
 * 'Moqueca', 'Storm Stew'.
 */
import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommunityRecipe, StoredRecipe } from '../services/GalleyRecipeService';

const mocks = vi.hoisted(() => ({
    updateCustomRecipe: vi.fn(),
    browseCommunityRecipes: vi.fn(),
    getUserRating: vi.fn(),
}));

vi.mock('../services/GalleyRecipeService', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../services/GalleyRecipeService')>()),
    updateCustomRecipe: mocks.updateCustomRecipe,
    browseCommunityRecipes: mocks.browseCommunityRecipes,
    getUserRating: mocks.getUserRating,
}));
vi.mock('../services/ChatService', () => ({ ChatService: { getChannels: vi.fn().mockResolvedValue([]) } }));
vi.mock('../components/chat/CustomRecipeForm', () => ({ CustomRecipeForm: () => <div>Recipe form</div> }));
vi.mock('../components/Toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));

import { RecipeEditor } from '../components/galley/RecipeEditor';
import { CaptainsTable } from '../components/chat/CaptainsTable';

const STORED_PHOTO = 'https://project.example.test/storage/v1/object/public/recipe-photos/skipper-1/r-moqueca.jpg';

function moqueca(overrides: Partial<StoredRecipe> = {}): StoredRecipe {
    return {
        id: 'r-moqueca',
        spoonacular_id: null,
        user_id: 'skipper-1',
        title: 'Moqueca',
        image_url: STORED_PHOTO,
        ready_in_minutes: 45,
        servings: 4,
        source_url: '',
        instructions: 'Layer the fish.\nPour the coconut milk.',
        ingredients: [{ name: 'Snapper', amount: 1, unit: 'kg', scalable: true, aisle: 'Seafood' }],
        is_favorite: false,
        is_custom: true,
        visibility: 'shared',
        tags: [],
        created_at: '2026-10-15T00:00:00.000Z',
        updated_at: '2026-10-15T00:00:00.000Z',
        ...overrides,
    };
}

function toSave(change?: () => void) {
    change?.();
    for (const step of [2, 3, 4, 5]) fireEvent.click(screen.getByRole('button', { name: `Continue to step ${step}` }));
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateCustomRecipe.mockResolvedValue(null);
    mocks.getUserRating.mockResolvedValue(null);
});

describe('a failed edit says why, never "check your storage" (GAL-04)', () => {
    it('a stored photo change that could not reach the server says so, and nothing was changed', async () => {
        render(<RecipeEditor onClose={vi.fn()} onSaved={vi.fn()} recipe={moqueca()} />);
        toSave(() => fireEvent.change(screen.getByRole('textbox', { name: /Photo URL/ }), { target: { value: '' } }));
        fireEvent.click(screen.getByRole('button', { name: 'Save recipe changes' }));

        expect(await screen.findByRole('alert')).toHaveTextContent(
            'This photo change has to reach the server first, and it could not. Nothing was changed. Try again once you are online.',
        );
        expect(screen.queryByText(/Check your storage/)).not.toBeInTheDocument();
    });

    it('making a recipe with a stored photo personal says the photo comes down on the server first', async () => {
        render(<RecipeEditor onClose={vi.fn()} onSaved={vi.fn()} recipe={moqueca()} />);
        toSave();
        fireEvent.click(screen.getByRole('button', { name: /Personal/ }));
        fireEvent.click(screen.getByRole('button', { name: 'Save recipe changes' }));

        expect(await screen.findByRole('alert')).toHaveTextContent(
            'Making this recipe personal takes its photo down on the server first, and that did not work. Nothing was changed. Try again once you are online.',
        );
        expect(mocks.updateCustomRecipe).toHaveBeenCalledWith(
            'r-moqueca',
            expect.objectContaining({ visibility: 'personal' }),
        );
    });

    it('a text edit that did not save says it could not be saved on this phone', async () => {
        render(<RecipeEditor onClose={vi.fn()} onSaved={vi.fn()} recipe={moqueca({ image_url: '' })} />);
        toSave(() =>
            fireEvent.change(screen.getByRole('textbox', { name: 'Recipe Title' }), {
                target: { value: 'Moqueca baiana' },
            }),
        );
        fireEvent.click(screen.getByRole('button', { name: 'Save recipe changes' }));

        expect(await screen.findByRole('alert')).toHaveTextContent(
            'The recipe could not be saved on this phone. Close the editor and try again.',
        );
        expect(mocks.updateCustomRecipe).toHaveBeenCalledWith(
            'r-moqueca',
            expect.objectContaining({ title: 'Moqueca baiana' }),
        );
    });
});

describe("crew changing a recipe in the skipper's galley", () => {
    it('are told it stays in the boat’s galley, and are not offered the community', async () => {
        mocks.updateCustomRecipe.mockImplementation(async (_id: string, patch: Partial<StoredRecipe>) => ({
            ...moqueca({ image_url: '', visibility: 'personal', user_id: 'skipper-1' }),
            ...patch,
        }));
        const onSaved = vi.fn();
        render(
            <RecipeEditor
                onClose={vi.fn()}
                onSaved={onSaved}
                recipe={moqueca({ image_url: '', visibility: 'personal' })}
                sharedGalleyBoat="Kestrel"
            />,
        );
        toSave();

        expect(
            screen.getByText(
                "This recipe stays in Kestrel's galley, where the crew can see it. Only the skipper can share it with the community.",
            ),
        ).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Community/ })).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Save recipe changes' }));
        await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    });
});

describe("the Captain's Table and a recipe shared from the Galley, before the one store", () => {
    const galleyShared: CommunityRecipe = {
        id: 1,
        title: 'Storm Stew',
        readyInMinutes: 25,
        servings: 4,
        image: '',
        sourceUrl: '',
        ingredients: [{ name: 'Potato', amount: 4, unit: '', scalable: true, aisle: 'Produce' }],
        instructions: [{ number: 1, step: 'Simmer.' }],
        supabaseId: 'g-storm-stew',
        authorName: 'You',
        ratingAvg: 0,
        ratingCount: 0,
        createdAt: '2026-10-15T00:00:00.000Z',
        nauticalTags: [],
        manualTags: [],
        canRate: false,
    };

    it('shows it, says it cannot be rated yet, offers no wheels, and says how many it serves', async () => {
        mocks.browseCommunityRecipes.mockResolvedValue([galleyShared]);
        render(<CaptainsTable fullPage />);

        fireEvent.click(await screen.findByRole('button', { name: 'Open recipe: Storm Stew' }));
        const detail = await screen.findByRole('dialog', { name: 'Storm Stew' });

        expect(within(detail).getByText('Shared from a sailor’s Galley. It can’t be rated yet.')).toBeInTheDocument();
        expect(within(detail).queryByRole('button', { name: /^Rate \d wheel/ })).not.toBeInTheDocument();
        expect(within(detail).getByText('serves 4')).toBeInTheDocument();
        expect(mocks.getUserRating).not.toHaveBeenCalled();
    });

    it('a Captain’s Table recipe is rated as before, per person', async () => {
        mocks.browseCommunityRecipes.mockResolvedValue([
            { ...galleyShared, servings: 1, canRate: true, authorName: 'Sailor Nine' },
        ]);
        render(<CaptainsTable fullPage />);

        fireEvent.click(await screen.findByRole('button', { name: 'Open recipe: Storm Stew' }));
        const detail = await screen.findByRole('dialog', { name: 'Storm Stew' });

        expect(within(detail).getByRole('button', { name: 'Rate 5 wheels' })).toBeInTheDocument();
        expect(within(detail).getByText('per person')).toBeInTheDocument();
        await waitFor(() => expect(mocks.getUserRating).toHaveBeenCalledWith('g-storm-stew'));
    });
});
