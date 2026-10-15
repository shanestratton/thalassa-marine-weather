/**
 * Saved recipes open, and you can cook, plan, favourite and delete them
 * (132-B18, binder audit GAL-08: "Saved recipes is a dead end").
 *
 * The real Galley page, the real RecipeSheet (loaded the first time a card is
 * opened), the real recipe and meal services over the real LocalDatabase
 * (Filesystem mocked). The socket, the sync engine and the passage lookup are
 * fakes, and Cooking Mode is a stand-in that names its meal. There is no
 * server: a delete that must reach one says it could not. Fictional galley
 * only: 'Kestrel' of 'skipper-<n>'; Feijoada, Ceviche de corvina.
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Filesystem } from '@capacitor/filesystem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rt = vi.hoisted(() => ({ user: { id: 'skipper-1' } as { id: string } | null }));

vi.mock('../services/supabase', () => ({
    supabase: {
        channel: () => {
            const api = { on: () => api, subscribe: () => api };
            return api;
        },
        removeChannel: vi.fn(),
    },
}));
vi.mock('../services/vessel/SyncService', () => ({
    onSyncComplete: () => () => undefined,
    onStatusChange: () => () => undefined,
    isFullReconciliationPending: () => false,
    requestFullReconciliation: vi.fn().mockResolvedValue({ pushed: 0, pulled: 0, errors: [] }),
    requestCatchUpSync: vi.fn(),
    syncNow: vi.fn().mockResolvedValue({ pushed: 0, pulled: 0, errors: [] }),
}));
vi.mock('../services/PassagePlanService', () => ({
    getActivePassageId: () => null,
    getPassageStatus: vi.fn(),
    NO_PASSAGE_ACCESS: {
        visible: false,
        voyageId: null,
        ownerUserId: null,
        isOwner: false,
        canEditStores: false,
        canViewMeals: false,
        canViewChat: false,
        canViewRoute: false,
        canViewChecklist: false,
    },
}));
vi.mock('../services/VoyageService', () => ({ getCachedActiveVoyage: () => null }));
vi.mock('../services/CrewService', () => ({ getMyCrew: vi.fn(async () => []) }));
vi.mock('../services/ProfilePhotoService', () => ({ compressImage: vi.fn() }));
vi.mock('../stores/authStore', () => ({
    useAuthStore: (selector: (state: { user: { id: string } | null }) => unknown) => selector({ user: rt.user }),
}));
vi.mock('../hooks/usePermissions', () => ({ usePermissions: () => ({ loaded: true }) }));
vi.mock('../components/SignInScreen', () => ({ SignInScreen: () => null }));
vi.mock('../components/passage/GalleyCookingMode', () => ({
    GalleyCookingMode: ({ meal }: { meal: { title: string } }) => (
        <div role="dialog" aria-label="Cooking Mode">
            {meal.title}
        </div>
    ),
}));
vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));

import { authScopedStorageKey, setAuthIdentityScope } from '../services/authIdentityScope';
import { getAll, getById, getFullQueue, initLocalDatabase, mergePulledRecords } from '../services/vessel/LocalDatabase';
import { reloadSharedBindersFromStorage } from '../services/vessel/sharedBinders';
import { getFavouriteIds } from '../services/galley/recipeFavourites';
import type { StoredRecipe } from '../services/GalleyRecipeService';
import type { MealPlan } from '../services/MealPlanService';
import { addLocalDays, toLocalDateString } from '../utils/localDate';
import { GalleyPage } from '../components/vessel/GalleyPage';

const NOW = '2026-10-15T00:00:00.000Z';
let skipper = 'skipper-1';
let accountCounter = 0;

function feijoada(overrides: Partial<StoredRecipe> = {}): StoredRecipe {
    return {
        id: '5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e',
        spoonacular_id: null,
        user_id: skipper,
        title: 'Feijoada',
        image_url: '',
        ready_in_minutes: 180,
        servings: 6,
        source_url: '',
        instructions: 'Soak the beans.\nBrown the pork.\nSimmer two hours.',
        ingredients: [
            { name: 'Black beans', amount: 500, unit: 'g', scalable: true, aisle: 'Dry' },
            { name: 'Pork shoulder', amount: 1, unit: 'kg', scalable: true, aisle: 'Meat' },
        ],
        is_favorite: false,
        is_custom: true,
        visibility: 'shared',
        tags: [],
        created_at: NOW,
        updated_at: NOW,
        ...overrides,
    };
}

const ceviche = (): StoredRecipe =>
    feijoada({
        id: '6c7d8e9f-0a1b-8c2d-9e3f-4a5b6c7d8e9f',
        title: 'Ceviche de corvina',
        is_custom: false,
        visibility: 'personal',
        source_url: 'https://www.example.test/ceviche',
        instructions: '',
    });

async function openRecipe(title: string) {
    fireEvent.click(await screen.findByRole('tab', { name: /Saved recipes/ }));
    fireEvent.click(await screen.findByRole('button', { name: `Open ${title}` }));
    return screen.findByRole('dialog', { name: title });
}

beforeEach(async () => {
    localStorage.clear();
    localStorage.setItem('thalassa_localdb_moved_to_library', '1');
    vi.mocked(Filesystem.readdir).mockResolvedValue({ files: [] });
    vi.mocked(Filesystem.writeFile).mockResolvedValue({ uri: 'mock://file' });
    accountCounter += 1;
    skipper = `skipper-${accountCounter}`;
    rt.user = { id: skipper };
    act(() => setAuthIdentityScope(skipper));
    localStorage.setItem(
        authScopedStorageKey('thalassa_shared_binders_v1'),
        JSON.stringify({ version: 1, userId: skipper, confirmedAt: NOW, galleyLive: true, skippers: [] }),
    );
    reloadSharedBindersFromStorage();
    await initLocalDatabase(skipper);
    await mergePulledRecords('recipes', [feijoada(), ceviche()]);
});

afterEach(async () => {
    await initLocalDatabase(null);
    act(() => setAuthIdentityScope(null));
    localStorage.clear();
});

describe('a saved recipe card opens the recipe (GAL-08)', () => {
    it('shows the whole recipe, read-only, with Edit and Delete for the owner', async () => {
        render(<GalleyPage onBack={vi.fn()} />);
        const sheet = await openRecipe('Feijoada');

        expect(within(sheet).getByText('180 min · serves 6 · 2 ingredients')).toBeInTheDocument();
        expect(within(sheet).getByText('Shared on the Captain’s Table')).toBeInTheDocument();
        expect(within(sheet).getByText('Pork shoulder')).toBeInTheDocument();
        expect(
            within(sheet)
                .getAllByRole('listitem')
                .map((item) => item.textContent),
        ).toEqual(expect.arrayContaining(['1.Soak the beans.', '2.Brown the pork.', '3.Simmer two hours.']));
        expect(within(sheet).getByRole('button', { name: 'Edit Feijoada' })).toBeInTheDocument();
        expect(within(sheet).getByRole('button', { name: 'Delete Feijoada' })).toBeInTheDocument();
        expect(within(sheet).queryByRole('textbox')).not.toBeInTheDocument();

        fireEvent.click(within(sheet).getByRole('button', { name: 'Close recipe' }));
        await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Feijoada' })).not.toBeInTheDocument());
    });

    it('an imported recipe opens too, says where it came from, and has no directions to show', async () => {
        render(<GalleyPage onBack={vi.fn()} />);
        const sheet = await openRecipe('Ceviche de corvina');

        expect(within(sheet).getByText('Saved from example.test')).toBeInTheDocument();
        expect(within(sheet).getByText('No directions saved with this recipe.')).toBeInTheDocument();
        expect(within(sheet).queryByRole('button', { name: 'Edit Ceviche de corvina' })).not.toBeInTheDocument();
    });
});

describe('the Favourite star works, and it is the Captain’s Table’s heart', () => {
    it('starring in the sheet marks the card and the one favourites list', async () => {
        render(<GalleyPage onBack={vi.fn()} />);
        const sheet = await openRecipe('Feijoada');
        const star = within(sheet).getByRole('button', { name: 'Favourite' });
        expect(star).toHaveAttribute('aria-pressed', 'false');

        fireEvent.click(star);

        expect(star).toHaveAttribute('aria-pressed', 'true');
        expect(getFavouriteIds()).toEqual(new Set([feijoada().id]));
        fireEvent.click(within(sheet).getByRole('button', { name: 'Close recipe' }));
        const card = await screen.findByRole('button', { name: 'Open Feijoada, favourite' });
        expect(within(card).getByText('Favourite')).toBeInTheDocument();
    });
});

describe('Cook or plan from the sheet', () => {
    it('Add to meals plans it for the day and meal chosen, linked to the recipe, and the Galley counts it', async () => {
        render(<GalleyPage onBack={vi.fn()} />);
        const sheet = await openRecipe('Feijoada');

        fireEvent.change(within(sheet).getByLabelText('Day'), { target: { value: '1' } });
        fireEvent.change(within(sheet).getByLabelText('Meal'), { target: { value: 'lunch' } });
        fireEvent.click(within(sheet).getByRole('button', { name: 'Fewer servings' }));
        expect(within(sheet).queryByRole('button', { name: 'Cook now' })).not.toBeInTheDocument();
        fireEvent.click(within(sheet).getByRole('button', { name: 'Add to meals' }));

        expect(await within(sheet).findByText('Added to meals: Tomorrow, lunch.')).toBeInTheDocument();
        const [meal] = getAll<MealPlan>('meal_plans');
        expect(meal).toMatchObject({
            user_id: skipper,
            voyage_id: null,
            recipe_id: feijoada().id,
            planned_date: toLocalDateString(addLocalDays(new Date(), 1)),
            meal_slot: 'lunch',
            servings_planned: 5,
            status: 'reserved',
        });
        expect(screen.getByText(/1 meal/)).toBeInTheDocument();
    });

    it('Cook now plans it for today and opens Cooking Mode on it', async () => {
        render(<GalleyPage onBack={vi.fn()} />);
        const sheet = await openRecipe('Feijoada');

        fireEvent.click(within(sheet).getByRole('button', { name: 'Cook now' }));

        expect(await screen.findByRole('dialog', { name: 'Cooking Mode' })).toHaveTextContent('Feijoada');
        expect(screen.queryByRole('dialog', { name: 'Feijoada' })).not.toBeInTheDocument();
        expect(getAll<MealPlan>('meal_plans')).toEqual([
            expect.objectContaining({ planned_date: toLocalDateString(new Date()), recipe_id: feijoada().id }),
        ]);
    });

    it('signed out, the sheet says to sign in to plan', async () => {
        rt.user = null;
        act(() => setAuthIdentityScope(null));
        await initLocalDatabase(null);
        await mergePulledRecords('recipes', [feijoada({ user_id: null })]);

        render(<GalleyPage onBack={vi.fn()} />);
        const sheet = await openRecipe('Feijoada');

        expect(within(sheet).getByText('Sign in to plan meals.')).toBeInTheDocument();
        expect(within(sheet).queryByRole('button', { name: 'Add to meals' })).not.toBeInTheDocument();
    });
});

describe('Delete has a button, and says what really happened', () => {
    it('a copy saved from a meal plan is deleted here and queued for the server', async () => {
        render(<GalleyPage onBack={vi.fn()} />);
        const sheet = await openRecipe('Ceviche de corvina');

        fireEvent.click(within(sheet).getByRole('button', { name: 'Delete Ceviche de corvina' }));
        const confirm = within(sheet).getByRole('group', { name: 'Delete Ceviche de corvina?' });
        expect(confirm).toHaveTextContent('It goes from this phone and your other devices.');
        fireEvent.click(within(confirm).getByRole('button', { name: 'Delete recipe' }));

        expect(
            await screen.findByText('Recipe deleted. It goes from your other devices once this phone syncs.'),
        ).toBeInTheDocument();
        expect(screen.queryByRole('dialog', { name: 'Ceviche de corvina' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Open Ceviche de corvina' })).not.toBeInTheDocument();
        expect(getById('recipes', ceviche().id)).toBeNull();
        expect(getFullQueue().map((item) => [item.mutation_type, item.record_id])).toEqual([['DELETE', ceviche().id]]);
    });

    it('a recipe they wrote cannot be deleted without the server: kept, and it says so; planned meals are counted first', async () => {
        render(<GalleyPage onBack={vi.fn()} />);
        const sheet = await openRecipe('Feijoada');
        fireEvent.click(within(sheet).getByRole('button', { name: 'Add to meals' }));
        await within(sheet).findByText(/Added to meals/);

        fireEvent.click(within(sheet).getByRole('button', { name: 'Delete Feijoada' }));
        const confirm = within(sheet).getByRole('group', { name: 'Delete Feijoada?' });
        expect(confirm).toHaveTextContent(', and from the Captain’s Table.');
        expect(confirm).toHaveTextContent(
            '1 planned meal cooks from it: they keep their ingredients but lose its directions.',
        );
        fireEvent.click(within(confirm).getByRole('button', { name: 'Delete recipe' }));

        expect(await within(sheet).findByRole('alert')).toHaveTextContent(
            'The server could not be reached, so nothing was deleted.',
        );
        expect(getById('recipes', feijoada().id)).not.toBeNull();
        expect(screen.getByRole('button', { name: 'Open Feijoada' })).toBeInTheDocument();
    });
});
