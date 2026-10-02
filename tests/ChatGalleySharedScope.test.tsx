/**
 * The chat galley follows a shared galley (Shane 2026-10-03: "Make the chat
 * galley follow a shared galley").
 *
 * While a skipper shares their Galley, the meals and grocery list kept with no
 * passage are the SKIPPER's (sharedBinders.galleyShareOwner). The Galley page
 * already reads them that way; the chat Galley card and its Meal Calendar read
 * with `undefined` (every row on the device) or with the crew member's own id
 * (an empty list in a shared galley), so the crew's own hidden galley showed
 * mixed in, and the shortfall maths counted nothing as already listed and
 * topped the skipper's items up twice over.
 *
 * The real chain: real LocalDatabase (Filesystem mocked), the real galley
 * services and the real share snapshot. Only the cloud, the sync engine and
 * the voyage lookup are fakes. No real accounts or boats: 'skipper-1',
 * 'crew-<n>', 'voyage-1', 'Test Boat'.
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Filesystem } from '@capacitor/filesystem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PassageStatus } from '../services/PassagePlanService';

vi.mock('../services/supabase', () => ({
    supabase: {
        from: () => ({ upsert: async () => ({ error: null }) }),
        auth: {
            getSession: async () => ({ data: { session: null }, error: null }),
            getUser: async () => ({ data: { user: null }, error: null }),
        },
    },
}));
vi.mock('../services/vessel/SyncService', () => ({
    syncNow: vi.fn().mockResolvedValue({ pushed: 0, pulled: 0, errors: [] }),
}));
vi.mock('../services/VoyageService', () => ({
    getCachedActiveVoyage: () => null,
    getVoyageById: vi.fn(async () => null),
}));
vi.mock('../services/CrewService', () => ({ getMyCrew: vi.fn(async () => []) }));
vi.mock('../services/ProfilePhotoService', () => ({ compressImage: vi.fn() }));
vi.mock('../contexts/CrewCountContext', () => ({
    useCrewCount: () => ({ crewCount: 2, setCrewCount: vi.fn() }),
}));
vi.mock('../components/chat/CaptainsTable', () => ({ CaptainsTable: () => null }));
vi.mock('../components/passage/GalleyCookingMode', () => ({ GalleyCookingMode: () => null }));
vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));

import { authScopedStorageKey, setAuthIdentityScope } from '../services/authIdentityScope';
import { getAll, getById, initLocalDatabase, mergePulledRecords } from '../services/vessel/LocalDatabase';
import { reloadSharedBindersFromStorage } from '../services/vessel/sharedBinders';
import { getMealsByStatus, type MealDayInfo, type MealPlan } from '../services/MealPlanService';
import { type ShoppingItem } from '../services/ShoppingListService';
import { GalleyCard } from '../components/chat/GalleyCard';
import { MealCalendar } from '../components/chat/MealCalendar';

const NOW = '2026-10-03T00:00:00.000Z';
let accountCounter = 0;
let CREW = 'crew-1';
const access = (read: boolean, write = read) => ({ read, write });

function share(options: { galley: boolean; stores?: { read: boolean; write: boolean } }): void {
    localStorage.setItem(
        authScopedStorageKey('thalassa_shared_binders_v1'),
        JSON.stringify({
            version: 1,
            userId: CREW,
            confirmedAt: NOW,
            galleyLive: true,
            skippers: [
                {
                    ownerId: 'skipper-1',
                    vesselName: 'Test Boat',
                    lastAcceptedAt: '2026-10-02T21:00:00.000Z',
                    registers: {
                        stores: options.stores ?? access(false),
                        equipment: access(false),
                        maintenance: access(false),
                        documents: access(false),
                        galley: access(options.galley),
                    },
                },
            ],
        }),
    );
    reloadSharedBindersFromStorage();
}

function meal(id: string, owner: string, title: string, overrides: Partial<MealPlan> = {}): MealPlan {
    return {
        id,
        user_id: owner,
        voyage_id: null,
        recipe_id: null,
        spoonacular_id: null,
        title,
        planned_date: '2026-10-04',
        meal_slot: 'dinner',
        servings_planned: 4,
        ingredients: [{ name: 'Rice', amount: 500, unit: 'g', scalable: true, aisle: 'Dry' }],
        status: 'reserved',
        cook_started_at: null,
        completed_at: null,
        leftovers_saved: false,
        notes: null,
        created_at: NOW,
        updated_at: NOW,
        ...overrides,
    };
}

function grocery(id: string, owner: string, name: string, overrides: Partial<ShoppingItem> = {}): ShoppingItem {
    return {
        id,
        user_id: owner,
        ingredient_name: name,
        required_qty: 2,
        unit: 'each',
        market_zone: 'Produce',
        actual_cost: null,
        currency: 'AUD',
        purchased: false,
        purchased_at: null,
        purchase_retailer: null,
        purchased_quantity: null,
        purchased_unit: null,
        purchase_revision: 0,
        purchase_operation_id: null,
        store_location: 'Galley',
        provision_id: null,
        voyage_id: null,
        notes: null,
        created_at: NOW,
        updated_at: NOW,
        ...overrides,
    };
}

/** The local mirror after a pull: the crew member's own galley, the skipper's, and a passage. */
async function pullBothGalleys(): Promise<void> {
    await mergePulledRecords('meal_plans', [
        meal('m-skipper', 'skipper-1', 'Skipper stew'),
        meal('m-crew', CREW, 'Crew noodles'),
        meal('m-passage', 'skipper-1', 'Passage pasta', { voyage_id: 'voyage-1' }),
    ]);
    await mergePulledRecords('shopping_list', [
        grocery('g-skipper', 'skipper-1', 'Limes'),
        grocery('g-crew', CREW, 'Chillies'),
        grocery('g-passage', 'skipper-1', 'Bread', { voyage_id: 'voyage-1' }),
    ]);
}

/** The galley kept with no passage, as a Galley page hands it to the card. */
const noPassage = (ownerUserId: string | null): PassageStatus => ({
    visible: true,
    voyageId: null,
    ownerUserId,
    isOwner: true,
    canEditStores: true,
    canViewMeals: true,
    canViewChat: false,
    canViewRoute: false,
    canViewChecklist: false,
});

const passage: PassageStatus = {
    visible: true,
    voyageId: 'voyage-1',
    ownerUserId: 'skipper-1',
    isOwner: false,
    canEditStores: false,
    canViewMeals: true,
    canViewChat: true,
    canViewRoute: true,
    canViewChecklist: true,
};

async function openCard(): Promise<void> {
    fireEvent.click(screen.getByRole('button', { name: 'Voyage Provisioning' }));
    await screen.findByRole('button', { name: /Meal Planner/ });
}

async function openShopping(remaining: number): Promise<void> {
    const label = new RegExp(`Shopping List — ${remaining} items? to buy`);
    fireEvent.click(await screen.findByRole('button', { name: label }));
}

const shoppingNames = () =>
    screen
        .queryAllByRole('button', { name: /^Mark .+ as purchased$/ })
        .map((button) => button.getAttribute('aria-label')!.replace(/^Mark | as purchased$/g, ''))
        .sort();

beforeEach(async () => {
    localStorage.clear();
    localStorage.setItem('thalassa_localdb_moved_to_library', '1');
    vi.mocked(Filesystem.readdir).mockResolvedValue({ files: [] });
    vi.mocked(Filesystem.writeFile).mockResolvedValue({ uri: 'mock://file' });
    accountCounter += 1;
    CREW = `crew-${accountCounter}`;
    setAuthIdentityScope(CREW);
    await initLocalDatabase(CREW);
});

afterEach(() => {
    setAuthIdentityScope(null);
    localStorage.clear();
});

describe('the chat Galley card follows a shared galley', () => {
    it('shows only the skipper’s meals and grocery items, never the crew’s own hidden ones', async () => {
        await pullBothGalleys();
        share({ galley: true });

        // A caller that still hands over the crew member's own id.
        render(<GalleyCard passageStatus={noPassage(CREW)} />);
        await openCard();

        expect(screen.getByRole('button', { name: /^Meal Planner — / })).toHaveAccessibleName(
            'Meal Planner — 1 meal planned',
        );
        await openShopping(1);
        expect(shoppingNames()).toEqual(['Limes']);
    });

    it('ticks the skipper’s item bought, scoped to the skipper’s galley', async () => {
        await pullBothGalleys();
        share({ galley: true });

        render(<GalleyCard passageStatus={noPassage(CREW)} />);
        await openCard();
        await openShopping(1);
        fireEvent.click(screen.getByRole('button', { name: 'Mark Limes as purchased' }));

        await waitFor(() => expect(getById<ShoppingItem>('shopping_list', 'g-skipper')?.purchased).toBe(true));
        expect(screen.queryByRole('alert')).toBeNull();
        expect(getById<ShoppingItem>('shopping_list', 'g-crew')?.purchased).toBe(false);
    });

    it('unshared, shows the crew member’s own galley as before', async () => {
        await mergePulledRecords('meal_plans', [meal('m-crew', CREW, 'Crew noodles')]);
        await mergePulledRecords('shopping_list', [
            grocery('g-crew', CREW, 'Chillies'),
            grocery('g-legacy', '', 'Onions'),
        ]);

        render(<GalleyCard passageStatus={noPassage(CREW)} />);
        await openCard();

        expect(screen.getByRole('button', { name: /^Meal Planner — / })).toHaveAccessibleName(
            'Meal Planner — 1 meal planned',
        );
        await openShopping(2);
        expect(shoppingNames()).toEqual(['Chillies', 'Onions']);
    });

    it('a selected passage keeps the passage’s own meals and list', async () => {
        await pullBothGalleys();
        share({ galley: true });

        render(<GalleyCard passageStatus={passage} />);
        await openCard();

        expect(screen.getByRole('button', { name: /^Meal Planner — / })).toHaveAccessibleName(
            'Meal Planner — 1 meal planned',
        );
        await openShopping(1);
        expect(shoppingNames()).toEqual(['Bread']);
    });

    it('with no passage, a passage’s meals and list stay with their passage', async () => {
        await mergePulledRecords('meal_plans', [
            meal('m-crew', CREW, 'Crew noodles'),
            meal('m-passage', 'skipper-1', 'Passage pasta', { voyage_id: 'voyage-1' }),
        ]);
        await mergePulledRecords('shopping_list', [
            grocery('g-crew', CREW, 'Chillies'),
            grocery('g-passage', 'skipper-1', 'Bread', { voyage_id: 'voyage-1' }),
        ]);

        render(<GalleyCard passageStatus={noPassage(CREW)} />);
        await openCard();

        expect(screen.getByRole('button', { name: /^Meal Planner — / })).toHaveAccessibleName(
            'Meal Planner — 1 meal planned',
        );
        await openShopping(1);
        expect(shoppingNames()).toEqual(['Chillies']);
    });

    it('follows the share as it starts and ends, without a remount', async () => {
        await mergePulledRecords('meal_plans', [meal('m-crew', CREW, 'Crew noodles')]);
        await mergePulledRecords('shopping_list', [grocery('g-crew', CREW, 'Chillies')]);

        render(<GalleyCard passageStatus={noPassage(CREW)} />);
        await openCard();
        await openShopping(1);
        expect(shoppingNames()).toEqual(['Chillies']);

        // The skipper ticks Galley: his rows come down and the share starts.
        await act(async () => {
            await mergePulledRecords('meal_plans', [
                meal('m-skipper', 'skipper-1', 'Skipper stew'),
                meal('m-skipper-2', 'skipper-1', 'Skipper curry', { meal_slot: 'lunch' }),
            ]);
            await mergePulledRecords('shopping_list', [grocery('g-skipper', 'skipper-1', 'Limes')]);
            share({ galley: true });
        });
        expect(screen.getByRole('button', { name: /^Meal Planner — / })).toHaveAccessibleName(
            'Meal Planner — 2 meals planned',
        );
        expect(shoppingNames()).toEqual(['Limes']);

        // He unticks it: the crew member's own list is back. His rows stay on
        // the device until the next full pull prunes them, and the card does
        // not reload after that prune, so his meals must not count meanwhile.
        act(() => share({ galley: false }));
        expect(shoppingNames()).toEqual(['Chillies']);
        expect(getMealsByStatus('reserved', null)).toHaveLength(3);
        expect(screen.getByRole('button', { name: /^Meal Planner — / })).toHaveAccessibleName(
            'Meal Planner — 1 meal planned',
        );
    });
});

describe('the Meal Calendar’s shortfall follows a shared galley', () => {
    const mealDays: MealDayInfo = {
        passageDays: 1,
        emergencyDays: 0,
        totalDays: 1,
        dates: ['2026-10-04'],
        emergencyDates: new Set<string>(),
    };

    const calendar = (activeMeals: MealPlan[], voyageId: string | null, ownerUserId: string | null) => (
        <MealCalendar
            mealDays={mealDays}
            crewCount={4}
            voyageId={voyageId}
            ownerUserId={ownerUserId}
            voyageName={null}
            activeMeals={activeMeals}
            onMealsChanged={vi.fn()}
            cookingMealId={null}
            onCookNow={vi.fn()}
            shoppingSummary={null}
        />
    );

    const rice = (owner: string) =>
        getAll<ShoppingItem>('shopping_list').filter(
            (item) => item.user_id === owner && item.ingredient_name === 'Rice' && item.voyage_id === null,
        );

    async function stockBothGalleys(skipperListed: number): Promise<void> {
        await mergePulledRecords('meal_plans', [meal('m-skipper', 'skipper-1', 'Skipper stew')]);
        await mergePulledRecords('shopping_list', [
            grocery('g-skipper-rice', 'skipper-1', 'Rice', { required_qty: skipperListed, unit: 'g' }),
            // The crew member's own galley, hidden while the skipper's is shared.
            grocery('g-crew-rice', CREW, 'Rice', { required_qty: 1000, unit: 'g' }),
        ]);
        await mergePulledRecords('inventory_items', [
            {
                id: 'i-rice',
                user_id: 'skipper-1',
                item_name: 'Rice',
                quantity: 100,
                unit: 'g',
                created_at: NOW,
                updated_at: NOW,
            },
        ]);
    }

    it('counts the skipper’s Stores and listed items, and tops the list up by the true shortfall', async () => {
        await stockBothGalleys(300);
        share({ galley: true, stores: access(true, false) });
        const activeMeals = getMealsByStatus('reserved', null);
        expect(activeMeals.map((m) => m.title)).toEqual(['Skipper stew']);

        // 500 g needed, 100 g in the skipper's Stores, 300 g already on his list.
        render(calendar(activeMeals, null, CREW));
        const add = await screen.findByRole('button', { name: 'Add 1 items to shopping list' });
        fireEvent.click(add);

        await screen.findByText(/1 item added to shopping list/);
        expect(rice('skipper-1').map((item) => item.required_qty)).toEqual([400]);
        expect(rice(CREW).map((item) => item.required_qty)).toEqual([1000]);
    });

    it('says fully stocked when the skipper’s list already covers the meals', async () => {
        // 100 g in the skipper's Stores and 400 g on his list cover the 500 g.
        await stockBothGalleys(400);
        share({ galley: true, stores: access(true, false) });

        render(calendar(getMealsByStatus('reserved', null), null, CREW));

        expect(await screen.findByRole('button', { name: 'All items fully stocked' })).toBeDisabled();
    });

    it('unshared, counts the crew member’s own list as before', async () => {
        await mergePulledRecords('meal_plans', [meal('m-crew', CREW, 'Crew noodles')]);
        await mergePulledRecords('shopping_list', [
            grocery('g-crew-rice', CREW, 'Rice', { required_qty: 200, unit: 'g' }),
        ]);

        render(calendar(getMealsByStatus('reserved', null), null, CREW));
        fireEvent.click(await screen.findByRole('button', { name: 'Add 1 items to shopping list' }));

        await screen.findByText(/1 item added to shopping list/);
        expect(rice(CREW).map((item) => item.required_qty)).toEqual([500]);
    });

    it('a selected passage counts the passage owner’s list, untouched by the galley share', async () => {
        await mergePulledRecords('meal_plans', [
            meal('m-passage', 'skipper-1', 'Passage pasta', { voyage_id: 'voyage-1' }),
        ]);
        await mergePulledRecords('shopping_list', [
            grocery('g-passage-rice', 'skipper-1', 'Rice', { required_qty: 300, unit: 'g', voyage_id: 'voyage-1' }),
            grocery('g-skipper-rice', 'skipper-1', 'Rice', { required_qty: 999, unit: 'g' }),
        ]);
        share({ galley: true });

        render(calendar(getMealsByStatus('reserved', 'voyage-1'), 'voyage-1', 'skipper-1'));
        fireEvent.click(await screen.findByRole('button', { name: 'Add 1 items to shopping list' }));

        await screen.findByText(/1 item added to shopping list/);
        expect(getById<ShoppingItem>('shopping_list', 'g-passage-rice')?.required_qty).toBe(500);
        expect(getById<ShoppingItem>('shopping_list', 'g-skipper-rice')?.required_qty).toBe(999);
    });
});
