/**
 * A shared galley is live across devices (Shane 2026-10-03: "can we share the
 * galley as well with invitees (as an option)").
 *
 * The real chain, end to end: a realtime payload from the socket goes into the
 * real LocalDatabase (Filesystem mocked), through the real galley services and
 * the real share snapshot (sharedBinders.ts), onto the open Galley page. Only
 * the socket, the sync engine and the passage lookup are fakes.
 * No real accounts or boats: 'crew-<n>', 'skipper-1', 'skipper-2', 'Test Boat'.
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Filesystem } from '@capacitor/filesystem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Payload = {
    eventType: 'INSERT' | 'UPDATE' | 'DELETE';
    new: Record<string, unknown>;
    old: Record<string, unknown>;
};

const rt = vi.hoisted(() => ({
    /** table → the newest open channel's postgres_changes callback */
    bindings: new Map<string, (payload: unknown) => void>(),
    user: { id: 'crew-1' },
}));

vi.mock('../services/supabase', () => ({
    supabase: {
        channel: () => {
            const api = {
                on: (_kind: string, filter: { table: string }, callback: (payload: unknown) => void) => {
                    rt.bindings.set(filter.table, callback);
                    return api;
                },
                subscribe: () => api,
            };
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
    useAuthStore: (selector: (state: { user: { id: string } }) => unknown) => selector({ user: rt.user }),
}));
vi.mock('../hooks/usePermissions', () => ({ usePermissions: () => ({ loaded: true }) }));
vi.mock('../components/SignInScreen', () => ({ SignInScreen: () => null }));
vi.mock('../components/passage/GalleyCookingMode', () => ({ GalleyCookingMode: () => null }));
vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));

import { authScopedStorageKey, setAuthIdentityScope } from '../services/authIdentityScope';
import { getAll, getById, getFullQueue, initLocalDatabase, mergePulledRecords } from '../services/vessel/LocalDatabase';
import { reloadSharedBindersFromStorage } from '../services/vessel/sharedBinders';
import { GalleyPage } from '../components/vessel/GalleyPage';

const NOW = '2026-10-03T00:00:00.000Z';
let accountCounter = 0;
let crew = 'crew-1';

function meal(id: string, owner: string, title: string) {
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
        ingredients: [],
        status: 'reserved',
        cook_started_at: null,
        completed_at: null,
        leftovers_saved: false,
        notes: null,
        created_at: NOW,
        updated_at: NOW,
    };
}

function recipe(id: string, owner: string, title: string) {
    return {
        id,
        spoonacular_id: null,
        user_id: owner,
        title,
        image_url: '',
        ready_in_minutes: 20,
        servings: 2,
        source_url: '',
        instructions: '',
        ingredients: [],
        is_favorite: false,
        is_custom: true,
        visibility: 'personal',
        tags: [],
        created_at: NOW,
        updated_at: NOW,
    };
}

function grocery(id: string, owner: string, name: string) {
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
        purchase_revision: 0,
        purchase_operation_id: null,
        store_location: 'Galley',
        provision_id: null,
        voyage_id: null,
        notes: null,
        created_at: NOW,
        updated_at: NOW,
    };
}

/** skipper-1 shares the Galley; skipper-2 shares only Equipment. */
function share(live: boolean): void {
    const access = (on: boolean) => ({ read: on, write: on });
    const registers = (galley: boolean) => ({
        stores: access(false),
        equipment: access(true),
        maintenance: access(false),
        documents: access(false),
        galley: access(galley),
    });
    act(() => {
        localStorage.setItem(
            authScopedStorageKey('thalassa_shared_binders_v1'),
            JSON.stringify({
                version: 1,
                userId: crew,
                confirmedAt: NOW,
                ...(live ? { galleyLive: true } : {}),
                skippers: [
                    {
                        ownerId: 'skipper-1',
                        vesselName: 'Test Boat',
                        lastAcceptedAt: '2026-10-02T00:00:00.000Z',
                        registers: registers(true),
                    },
                    {
                        ownerId: 'skipper-2',
                        vesselName: 'Other Boat',
                        lastAcceptedAt: '2026-10-01T00:00:00.000Z',
                        registers: registers(false),
                    },
                ],
            }),
        );
        reloadSharedBindersFromStorage();
    });
}

async function channelFor(table: string): Promise<(payload: unknown) => void> {
    // The hook subscribes after a real 300 ms delay.
    await waitFor(() => expect(rt.bindings.has(table)).toBe(true), { timeout: 5000 });
    return rt.bindings.get(table)!;
}

async function deliver(
    table: string,
    eventType: Payload['eventType'],
    row: { id: string; [field: string]: unknown },
): Promise<void> {
    const callback = await channelFor(table);
    const payload: Payload =
        eventType === 'DELETE'
            ? { eventType, new: {}, old: { id: row.id } }
            : { eventType, new: { ...row, updated_at: new Date().toISOString() }, old: {} };
    await act(async () => {
        callback(payload);
    });
}

async function openGalley(): Promise<void> {
    await mergePulledRecords('meal_plans', [
        meal('m-skipper', 'skipper-1', 'Skipper stew'),
        meal('m-crew', crew, 'Crew noodles'),
    ]);
    await mergePulledRecords('recipes', [
        recipe('r-skipper', 'skipper-1', 'Skipper chowder'),
        recipe('r-crew', crew, 'Crew curry'),
    ]);
    await mergePulledRecords('shopping_list', [
        grocery('g-skipper', 'skipper-1', 'Limes'),
        grocery('g-crew', crew, 'Chillies'),
    ]);
    render(<GalleyPage onBack={vi.fn()} />);
}

beforeEach(async () => {
    localStorage.clear();
    localStorage.setItem('thalassa_localdb_moved_to_library', '1');
    vi.mocked(Filesystem.readdir).mockResolvedValue({ files: [] });
    vi.mocked(Filesystem.writeFile).mockResolvedValue({ uri: 'mock://file' });
    rt.bindings.clear();
    accountCounter += 1;
    crew = `crew-${accountCounter}`;
    rt.user = { id: crew };
    act(() => setAuthIdentityScope(crew));
    await initLocalDatabase(crew);
});

afterEach(() => {
    act(() => setAuthIdentityScope(null));
    localStorage.clear();
});

describe('an open shared Galley follows the skipper’s galley live', () => {
    it('shows the skipper’s galley with the crew line; meal INSERT, UPDATE and DELETE land on the page', async () => {
        share(true);
        await openGalley();

        expect(await screen.findByText('Skipper stew')).toBeInTheDocument();
        expect(screen.getByTestId('shared-binder-line')).toHaveTextContent("Shared from Test Boat — you're crew");
        expect(screen.queryByText('Crew noodles')).not.toBeInTheDocument();
        expect(screen.getByText('1 item still needed')).toBeInTheDocument();

        await deliver('meal_plans', 'INSERT', meal('m-new', 'skipper-1', 'Fish tacos'));
        expect(await screen.findByText('Fish tacos')).toBeInTheDocument();

        await deliver('meal_plans', 'UPDATE', meal('m-new', 'skipper-1', 'Fish tacos with lime'));
        expect(await screen.findByText('Fish tacos with lime')).toBeInTheDocument();

        await deliver('meal_plans', 'DELETE', { id: 'm-new' });
        await waitFor(() => expect(screen.queryByText('Fish tacos with lime')).not.toBeInTheDocument());

        // A skipper who does not share the Galley: their row never shows.
        await deliver('meal_plans', 'INSERT', meal('m-other', 'skipper-2', 'Other boat curry'));
        await deliver('meal_plans', 'INSERT', meal('m-own', crew, 'My own toast'));
        expect(screen.queryByText('Other boat curry')).not.toBeInTheDocument();
        expect(screen.queryByText('My own toast')).not.toBeInTheDocument();
        expect(screen.getByText('Skipper stew')).toBeInTheDocument();
    });

    it('the grocery list summary follows shopping_list INSERT, UPDATE and DELETE', async () => {
        share(true);
        await openGalley();
        expect(await screen.findByText('1 item still needed')).toBeInTheDocument();

        await deliver('shopping_list', 'INSERT', grocery('g-new', 'skipper-1', 'Mint'));
        expect(await screen.findByText('2 items still needed')).toBeInTheDocument();

        await deliver('shopping_list', 'UPDATE', { ...grocery('g-new', 'skipper-1', 'Mint'), purchased: true });
        expect(await screen.findByText('1 item still needed')).toBeInTheDocument();
        expect(screen.getByText('1/2 purchased')).toBeInTheDocument();

        await deliver('shopping_list', 'DELETE', { id: 'g-new' });
        expect(await screen.findByText('0/1 purchased')).toBeInTheDocument();

        await deliver('shopping_list', 'INSERT', grocery('g-other', 'skipper-2', 'Other boat bread'));
        expect(screen.getByText('0/1 purchased')).toBeInTheDocument();
    });

    it('the recipe library follows recipes INSERT, UPDATE and DELETE', async () => {
        share(true);
        await openGalley();
        fireEvent.click(await screen.findByRole('tab', { name: /Saved recipes/ }));
        const panel = await screen.findByRole('tabpanel');
        expect(within(panel).getByText("The skipper's recipe library")).toBeInTheDocument();
        expect(within(panel).getByText('Skipper chowder')).toBeInTheDocument();
        expect(within(panel).queryByText('Crew curry')).not.toBeInTheDocument();

        await deliver('recipes', 'INSERT', recipe('r-new', 'skipper-1', 'Galley bread'));
        expect(await screen.findByText('Galley bread')).toBeInTheDocument();

        await deliver('recipes', 'UPDATE', recipe('r-new', 'skipper-1', 'Galley soda bread'));
        expect(await screen.findByText('Galley soda bread')).toBeInTheDocument();

        await deliver('recipes', 'DELETE', { id: 'r-new' });
        await waitFor(() => expect(screen.queryByText('Galley soda bread')).not.toBeInTheDocument());

        await deliver('recipes', 'INSERT', recipe('r-other', 'skipper-2', 'Other boat scones'));
        expect(screen.queryByText('Other boat scones')).not.toBeInTheDocument();
    });

    it('before the galley migration is pushed: the own galley, no crew line, no recipe or meal channel', async () => {
        share(false);
        await openGalley();

        expect(await screen.findByText('Crew noodles')).toBeInTheDocument();
        expect(screen.queryByTestId('shared-binder-line')).not.toBeInTheDocument();
        expect(screen.getByText('1 item still needed')).toBeInTheDocument();

        // The grocery list channel is the one it always had; nothing else opens.
        await channelFor('shopping_list');
        expect(rt.bindings.has('meal_plans')).toBe(false);
        expect(rt.bindings.has('recipes')).toBe(false);
    });
});

describe('the shared Galley’s grocery list', () => {
    it('ticks bought without the Stores share: bought, a quiet note, and no Stores row (not an error)', async () => {
        share(true);
        await openGalley();
        fireEvent.click(await screen.findByRole('button', { name: /Open shopping list/ }));

        const page = await screen.findByRole('dialog', { name: 'Shopping list' });
        expect(within(page).getByTestId('shared-binder-line')).toHaveTextContent('Shared from Test Boat');
        expect(within(page).getByText('Limes')).toBeInTheDocument();
        expect(within(page).queryByText('Chillies')).not.toBeInTheDocument();

        fireEvent.click(within(page).getByRole('button', { name: 'Mark Limes as purchased' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Skip price and mark Limes as purchased' }));

        expect(
            await screen.findByText(
                "Bought — Ship's Stores on Test Boat isn't shared with you to edit, so it wasn't added there.",
            ),
        ).toHaveAttribute('role', 'status');
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
        expect(getById<{ purchased: boolean; user_id: string }>('shopping_list', 'g-skipper')).toMatchObject({
            purchased: true,
            user_id: 'skipper-1',
        });
        expect(getAll('inventory_items')).toEqual([]);
        expect(getFullQueue().map((item) => item.table_name)).toEqual(['shopping_list']);
    });

    it('will not put back on the list what the skipper put in Ship’s Stores: a quiet note, nothing queued', async () => {
        share(true);
        await mergePulledRecords('shopping_list', [
            {
                ...grocery('g-eggs', 'skipper-1', 'Eggs'),
                purchased: true,
                purchased_at: NOW,
                purchased_quantity: 2,
                purchased_unit: 'each',
                purchase_revision: 1,
                notes: `[[thalassa:grocery-purchase:${JSON.stringify({
                    version: 2,
                    inventoryItemId: 'g-eggs',
                    quantity: 2,
                    unit: 'each',
                    provenance: 'Added from Grocery List purchase g-eggs',
                })}]]`,
            },
        ]);
        await openGalley();
        fireEvent.click(await screen.findByRole('button', { name: /Open shopping list/ }));
        const page = await screen.findByRole('dialog', { name: 'Shopping list' });
        fireEvent.click(within(page).getByRole('tab', { name: /Done/ }));
        fireEvent.click(await within(page).findByRole('button', { name: 'Undo Eggs' }));

        expect(
            await screen.findByText("Only someone who can edit Ship's Stores can put this back on the list."),
        ).toHaveAttribute('role', 'status');
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
        expect(getById<{ purchased: boolean }>('shopping_list', 'g-eggs')?.purchased).toBe(true);
        expect(getFullQueue()).toEqual([]);
    });
});
