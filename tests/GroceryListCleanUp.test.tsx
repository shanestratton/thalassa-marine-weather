/**
 * The Grocery list, cleaned up (132-B17, Shane 2026-10-15: "definitely needs a
 * good clean up"; binder audit GAL-09, GAL-10).
 *
 *  - its place in the app: Boat Binder › Galley, Back goes to the Galley;
 *  - "Saved locally" offline, and a list that cannot be read says so with the
 *    house LoadErrorState, apart from an empty list;
 *  - line icons, not emoji; 44 pt ticks; tabular numbers; plain words;
 *  - each price in its row's currency, written the phone's way, and spend
 *    totalled per currency; quick picks from the shops this phone has used;
 *  - clear of the status bar and the home indicator, with Cooking Mode too;
 *  - every behaviour kept: ticking (with the shop), Add item, the voyage spend.
 *
 * The page is real; its services are stubs. Fictional data only: the
 * 'Kestrel' galley (skipper-1), Talamahu Market, the Nuku'alofa passage.
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@supabase/supabase-js';
import type { ShoppingItem, ShoppingListSummary } from '../services/ShoppingListService';
import type { MealPlan } from '../services/MealPlanService';
import type { PassageStatus } from '../services/PassagePlanService';
import { setAuthIdentityScope } from '../services/authIdentityScope';

const mocks = vi.hoisted(() => ({
    getShoppingList: vi.fn(),
    markPurchased: vi.fn(),
    unmarkPurchased: vi.fn(),
    addManualItem: vi.fn(),
    recentRetailers: vi.fn(() => [] as string[]),
    realtimeReloads: [] as (() => void)[],
    getMealSteps: vi.fn(),
}));

vi.mock('../stores/authStore', async () => {
    const { create } = await import('zustand');
    const useAuthStore = create<{ user: User | null; authChecked: boolean }>()(() => ({
        user: null,
        authChecked: true,
    }));
    return { useAuthStore };
});

vi.mock('../services/ShoppingListService', () => ({
    getShoppingList: mocks.getShoppingList,
    markPurchased: mocks.markPurchased,
    unmarkPurchased: mocks.unmarkPurchased,
    addManualItem: mocks.addManualItem,
    recentRetailers: mocks.recentRetailers,
}));

vi.mock('../services/MealPlanService', () => ({
    startCooking: vi.fn(),
    completeMeal: vi.fn(),
    saveLeftovers: vi.fn(),
    skipMeal: vi.fn(),
}));
vi.mock('../services/GalleyRecipeService', () => ({ getMealSteps: mocks.getMealSteps }));

vi.mock('../services/PurchaseUnits', () => ({
    toPurchasable: (name: string, quantity: number, unit: string) =>
        name === 'Rice'
            ? {
                  packageCount: 2,
                  packageLabel: '1 kg bag',
                  inventoryQuantity: 2000,
                  inventoryUnit: 'g',
                  matched: true,
              }
            : {
                  packageCount: quantity,
                  packageLabel: unit,
                  inventoryQuantity: quantity,
                  inventoryUnit: unit,
                  matched: false,
              },
}));

vi.mock('../services/PassagePlanService', () => ({}));
vi.mock('../hooks/usePermissions', () => ({
    usePermissions: () => ({
        loaded: true,
        isSkipper: true,
        canViewStores: true,
        canEditStores: true,
        canViewGalley: true,
        permissions: { can_view_passage_meals: true },
    }),
}));
vi.mock('../hooks/useRealtimeSync', () => ({
    useRealtimeSync: (_table: string, reload: () => void) => {
        mocks.realtimeReloads.push(reload);
    },
}));
vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));

import { useAuthStore } from '../stores/authStore';
import { useUIStore } from '../stores/uiStore';
import { GroceryListPage } from '../components/vessel/GroceryListPage';
import { GalleyCookingMode } from '../components/passage/GalleyCookingMode';
import { currencyName, currencySymbol, formatMoney, formatSpend } from '../utils/money';

const SKIPPER = { id: 'skipper-1', email: 'skipper@kestrel.example.test' } as User;
const NOW = '2026-10-10T00:00:00.000Z';
/** Any emoji at all: the page wears line icons (UX scorecard run 7, 132-B17). */
const EMOJI = /\p{Extended_Pictographic}/u;
/**
 * Money as the page's text reads to Testing Library: Intl puts a no-break
 * space in 'EUR 4.50' on some locales, and the queries collapse it.
 */
const plain = (text: string) => text.replace(/\s+/g, ' ');

function grocery(overrides: Partial<ShoppingItem>): ShoppingItem {
    return {
        id: 'grocery-tomatoes',
        user_id: 'skipper-1',
        ingredient_name: 'Tomatoes',
        required_qty: 4,
        unit: 'each',
        market_zone: 'Produce',
        actual_cost: null,
        currency: 'AUD',
        purchased: false,
        purchased_at: null,
        purchase_retailer: null,
        purchased_quantity: null,
        purchased_unit: null,
        store_location: 'Galley',
        provision_id: null,
        voyage_id: null,
        notes: null,
        created_at: NOW,
        updated_at: NOW,
        ...overrides,
    };
}

const tomatoes = grocery({});
const rice = grocery({
    id: 'grocery-rice',
    ingredient_name: 'Rice',
    required_qty: 1.5,
    unit: 'kg',
    market_zone: 'General',
});
const breadfruit = grocery({ id: 'grocery-breadfruit', ingredient_name: 'Breadfruit', currency: 'TOP' });
const milk = grocery({
    id: 'grocery-milk',
    ingredient_name: 'Milk',
    market_zone: 'Dairy',
    purchased: true,
    purchased_at: NOW,
    purchase_retailer: 'Talamahu Market',
    actual_cost: 4.5,
    currency: 'EUR',
});
const wine = grocery({
    id: 'grocery-wine',
    ingredient_name: 'Red wine',
    market_zone: 'Bottle Shop',
    purchased: true,
    purchased_at: NOW,
    actual_cost: 12,
    currency: 'AUD',
});

function summaryOf(items: ShoppingItem[]): ShoppingListSummary {
    const zones = new Map<ShoppingItem['market_zone'], ShoppingItem[]>();
    for (const item of items) zones.set(item.market_zone, [...(zones.get(item.market_zone) ?? []), item]);
    const purchased = items.filter((item) => item.purchased).length;
    return {
        total: items.length,
        purchased,
        remaining: items.length - purchased,
        totalCost: 0,
        currency: 'AUD',
        zones: [...zones.entries()].map(([zone, zoneItems]) => ({ zone, items: zoneItems })),
    };
}

const passage: PassageStatus = {
    visible: true,
    voyageId: 'voyage-nukualofa',
    ownerUserId: 'skipper-1',
    isOwner: true,
    canEditStores: true,
    canViewMeals: true,
    canViewChat: false,
    canViewRoute: false,
    canViewChecklist: false,
};

beforeEach(() => {
    vi.clearAllMocks();
    mocks.realtimeReloads.length = 0;
    mocks.recentRetailers.mockReturnValue([]);
    mocks.markPurchased.mockResolvedValue({ storesSkipped: false });
    mocks.getShoppingList.mockReturnValue(summaryOf([tomatoes, rice, milk, wine]));
    setAuthIdentityScope('skipper-1');
    useAuthStore.setState({ user: SKIPPER });
});

afterEach(() => {
    setAuthIdentityScope(null);
    useAuthStore.setState({ user: null });
    useUIStore.setState({ isOffline: false });
});

describe('its place, and the house load states', () => {
    it('sits under Boat Binder › Galley, and Back goes to the Galley', () => {
        const onBack = vi.fn();
        render(<GroceryListPage onBack={onBack} />);
        expect(screen.getByRole('heading', { level: 1, name: 'Grocery list' })).toBeInTheDocument();
        expect(screen.getByText('Boat Binder')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Back to Galley' }));
        expect(onBack).toHaveBeenCalledOnce();
    });

    it('says "Saved locally" while offline, as its binder siblings do', () => {
        useUIStore.setState({ isOffline: true });
        render(<GroceryListPage onBack={vi.fn()} />);
        expect(screen.getByText('Saved locally')).toBeInTheDocument();
    });

    it('a list that cannot be read is a load problem, never the empty list, and Try again reads it', async () => {
        mocks.getShoppingList.mockImplementationOnce(() => {
            throw new Error('[LocalDB] Not initialized.');
        });
        render(<GroceryListPage onBack={vi.fn()} />);

        expect(await screen.findByRole('heading', { name: "Couldn't load the grocery list" })).toBeInTheDocument();
        expect(screen.getByText(/not an empty list\. Nothing has been removed/)).toBeInTheDocument();
        expect(screen.queryByText('No grocery items yet')).not.toBeInTheDocument();
        // Nothing to add to while the list is unknown.
        expect(screen.queryByRole('button', { name: 'Add item' })).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
        expect(await screen.findByText('Tomatoes')).toBeInTheDocument();
        expect(screen.queryByRole('heading', { name: "Couldn't load the grocery list" })).not.toBeInTheDocument();
    });

    it('an empty list says so, with Add item, and is not an error', () => {
        mocks.getShoppingList.mockReturnValue(summaryOf([]));
        render(<GroceryListPage onBack={vi.fn()} />);
        expect(screen.getByRole('heading', { name: 'No grocery items yet' })).toBeInTheDocument();
        expect(screen.getByText(/Tap Add item below/)).toBeInTheDocument();
        expect(screen.queryByText(/Couldn't load/)).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Add item' })).toBeEnabled();
    });

    it('a reload that fails keeps the list on screen and says it may be out of date', async () => {
        render(<GroceryListPage onBack={vi.fn()} />);
        expect(screen.getByText('Tomatoes')).toBeInTheDocument();

        mocks.getShoppingList.mockImplementationOnce(() => {
            throw new Error('database is locked');
        });
        act(() => mocks.realtimeReloads.at(-1)!());

        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent('The grocery list could not be refreshed, so it may be out of date.');
        expect(screen.getByText('Tomatoes')).toBeInTheDocument();
        fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
        await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    });
});

describe('the house style: line icons, 44 pt targets, tabular numbers, plain words', () => {
    it('wears no emoji, and each aisle heading has a line icon', () => {
        mocks.getShoppingList.mockReturnValue(summaryOf([tomatoes, rice, milk, wine]));
        render(<GroceryListPage onBack={vi.fn()} />);
        fireEvent.click(screen.getByRole('tab', { name: /All/ }));

        const page = screen.getByRole('dialog', { name: 'Shopping list' });
        expect(page.textContent).not.toMatch(EMOJI);
        for (const aisle of ['Produce', 'General', 'Dairy', 'Bottle Shop']) {
            const heading = screen.getByRole('heading', { name: new RegExp(`^${aisle}`) });
            expect(heading.querySelector('svg')).not.toBeNull();
        }
    });

    it('each tick is a whole 44 pt button, and amounts line up', () => {
        render(<GroceryListPage onBack={vi.fn()} />);
        const tick = screen.getByRole('button', { name: 'Mark Tomatoes as purchased' });
        expect(tick).toHaveClass('h-11', 'w-11');
        // 2 × 1 kg bag to buy, for the 1.5 kg the meals need.
        expect(screen.getByText('2 × 1 kg bag')).toHaveClass('tabular-nums');
        expect(screen.getByText('need 1.5 kg')).toHaveClass('tabular-nums');
        for (const tab of screen.getAllByRole('tab')) expect(tab).toHaveClass('min-h-[44px]');
    });

    it('the Add item bar opens the form, whose aisle choices wear line icons, not emoji', () => {
        render(<GroceryListPage onBack={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: 'Add item' }));
        const dialog = screen.getByRole('dialog', { name: /Add to shopping list/ });
        expect(dialog.textContent).not.toMatch(EMOJI);
        expect(within(dialog).getByRole('spinbutton', { name: 'Quantity' })).toBeInTheDocument();
        const aisles = within(dialog).getByRole('group', { name: 'Aisle' });
        const choices = within(aisles).getAllByRole('button');
        expect(choices).toHaveLength(9);
        for (const choice of choices) {
            expect(choice.querySelector('svg')).not.toBeNull();
            expect(choice).toHaveClass('min-h-[44px]');
        }
    });
});

describe('money: each row in its own currency, written the phone’s way (GAL-09)', () => {
    it('a bought row shows its price in its currency; spend is per currency, never added across', () => {
        render(<GroceryListPage onBack={vi.fn()} />);
        fireEvent.click(screen.getByRole('tab', { name: /Done/ }));

        const euro = plain(formatMoney(4.5, 'EUR'));
        expect(screen.getByText(`· ${euro}`)).toHaveClass('tabular-nums');
        expect(screen.getByText('· Talamahu Market')).toBeInTheDocument();
        // The header: 2 to buy · 2 bought · A$12.00 + €4.50 spent (the phone's way).
        const spend = formatSpend([
            { currency: 'AUD', total: 12 },
            { currency: 'EUR', total: 4.5 },
        ]);
        const line = screen.getByText(
            (_, element) => element?.tagName === 'SPAN' && plain(element.textContent ?? '') === plain(`${spend} spent`),
        );
        expect(line).toHaveClass('tabular-nums');
        // Each amount is whole on its line; the line may break between them.
        expect([...line.querySelectorAll('.whitespace-nowrap')].map((amount) => plain(amount.textContent!))).toEqual([
            plain(formatMoney(12, 'AUD')),
            plain(formatMoney(4.5, 'EUR')),
        ]);
        expect(screen.queryByText(/\$16\.50/)).not.toBeInTheDocument();
    });

    it('the price box wears the row’s own currency, and names it for a screen reader', () => {
        mocks.getShoppingList.mockReturnValue(summaryOf([breadfruit]));
        render(<GroceryListPage onBack={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: 'Mark Breadfruit as purchased' }));
        const dialog = screen.getByRole('dialog', { name: /Mark as purchased/ });
        expect(within(dialog).getByText(currencySymbol('TOP'))).toBeInTheDocument();
        const price = within(dialog).getByRole('spinbutton', { name: 'Price (optional)' });
        expect(price).toHaveAccessibleDescription(`In ${currencyName('TOP')}`);
        expect(price).toHaveClass('tabular-nums');
    });

    it('the voyage spend, by aisle, closes a passage’s list', () => {
        render(<GroceryListPage onBack={vi.fn()} passageStatus={passage} />);
        const card = screen.getByRole('region', { name: 'Voyage spend' });
        expect(card).toHaveTextContent(
            plain(
                formatSpend([
                    { currency: 'AUD', total: 12 },
                    { currency: 'EUR', total: 4.5 },
                ]),
            ),
        );
        expect(within(card).getByText('Bottle Shop')).toBeInTheDocument();
        expect(within(card).getByText('Dairy')).toBeInTheDocument();
        expect(card.textContent).not.toMatch(EMOJI);
    });

    it('no voyage spend on the galley’s own list', () => {
        render(<GroceryListPage onBack={vi.fn()} />);
        expect(screen.queryByRole('region', { name: 'Voyage spend' })).not.toBeInTheDocument();
    });
});

describe('the quick picks are the shops this phone has used (GAL-09)', () => {
    it('none used yet: no chips, and no Coles or Woolworths', () => {
        render(<GroceryListPage onBack={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: 'Mark Tomatoes as purchased' }));
        const dialog = screen.getByRole('dialog', { name: /Mark as purchased/ });
        expect(within(dialog).getByRole('textbox', { name: 'Shop (optional)' })).toBeInTheDocument();
        expect(within(dialog).queryByRole('group', { name: 'Shops used lately' })).not.toBeInTheDocument();
        expect(within(dialog).queryByRole('button', { name: 'Coles' })).not.toBeInTheDocument();
    });

    it('a picked shop goes with the purchase, and the tick still goes to Stores', async () => {
        mocks.recentRetailers.mockReturnValue(['Talamahu Market', 'Fuel dock']);
        render(<GroceryListPage onBack={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: 'Mark Tomatoes as purchased' }));
        const dialog = screen.getByRole('dialog', { name: /Mark as purchased/ });
        const shops = within(dialog).getByRole('group', { name: 'Shops used lately' });
        const market = within(shops).getByRole('button', { name: 'Talamahu Market' });
        fireEvent.click(market);
        expect(market).toHaveAttribute('aria-pressed', 'true');
        expect(within(dialog).getByRole('textbox', { name: 'Shop (optional)' })).toHaveValue('Talamahu Market');
        fireEvent.change(within(dialog).getByRole('spinbutton', { name: 'Price (optional)' }), {
            target: { value: '6.5' },
        });

        await act(async () => {
            fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm purchase of Tomatoes' }));
        });
        expect(mocks.markPurchased).toHaveBeenCalledWith('grocery-tomatoes', 6.5, 'Talamahu Market', null, 'skipper-1');
        await waitFor(() =>
            expect(screen.queryByRole('dialog', { name: /Mark as purchased/ })).not.toBeInTheDocument(),
        );
    });
});

describe('clear of the notch and the home indicator (GAL-10)', () => {
    it('the Grocery list pads its top for the status bar and its bottom bar for the home indicator', () => {
        render(<GroceryListPage onBack={vi.fn()} />);
        const page = screen.getByRole('dialog', { name: 'Shopping list' });
        expect(page.style.paddingTop).toContain('safe-area-inset-top');
        const addBar = screen.getByRole('button', { name: 'Add item' }).closest('.shrink-0') as HTMLElement;
        expect(addBar.style.paddingBottom).toContain('safe-area-inset-bottom');
        // No floating button over the list's last row any more.
        expect(page.querySelector('.fixed.bottom-\\[calc\\(5rem\\+env\\(safe-area-inset-bottom\\)\\)\\]')).toBeNull();
    });

    function cookingMeal(): MealPlan {
        return {
            id: 'meal-ota-ika',
            user_id: 'skipper-1',
            voyage_id: null,
            recipe_id: null,
            spoonacular_id: null,
            title: 'ʻOta ʻika with a very long name that has to wrap on a small phone',
            planned_date: '2026-10-12',
            meal_slot: 'dinner',
            servings_planned: 4,
            ingredients: [{ name: 'Tuna', amount: 500, unit: 'g', scalable: true, aisle: 'Seafood' }],
            status: 'cooking',
            cook_started_at: null,
            completed_at: null,
            leftovers_saved: false,
            notes: null,
            created_at: NOW,
            updated_at: NOW,
        };
    }

    it('Cooking Mode’s title and Close clear the status bar; Complete & Subtract clears the home indicator', async () => {
        mocks.getMealSteps.mockResolvedValue([{ number: 1, step: 'Cube the tuna.' }]);
        render(<GalleyCookingMode meal={cookingMeal()} onClose={vi.fn()} onComplete={vi.fn()} />);
        const dialog = screen.getByRole('dialog', { name: /Cooking Mode/ });
        const close = within(dialog).getByRole('button', { name: 'Close cooking mode' });
        const header = close.closest('.border-b') as HTMLElement;
        expect(header.style.paddingTop).toContain('safe-area-inset-top');
        // A long meal name wraps beside Close instead of pushing it off the screen.
        expect(within(header).getByText(/ʻOta ʻika/).parentElement).toHaveClass('min-w-0');

        const step = await screen.findByRole('button', { name: 'Mark complete: Step 1, Cube the tuna.' });
        const steps = step.parentElement as HTMLElement;
        expect(steps.style.paddingBottom).toContain('safe-area-inset-bottom');
        fireEvent.click(step);
        const complete = await screen.findByRole('button', { name: /Complete & Subtract from Stores/ });
        const panel = complete.parentElement as HTMLElement;
        expect(panel.style.paddingBottom).toContain('safe-area-inset-bottom');
    });
});
