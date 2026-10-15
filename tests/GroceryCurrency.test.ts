/**
 * Prices in your currency, written your phone's way (132-B17, binder audit
 * GAL-09).
 *
 * Every grocery row was stamped 'AUD' and every price written '$', and the
 * quick picks were Coles, Woolworths, Aldi and IGA for every sailor. Now:
 *  - new rows take the currency chosen in Settings → Preferences, or with
 *    none chosen, the phone region's (en-AU → AUD, fr-PF → XPF), else AUD;
 *  - rows already stored keep the currency they were saved in;
 *  - amounts are written by Intl for the phone's locale, and two currencies
 *    are never added together;
 *  - the quick picks are the shops this phone's purchases name, latest first.
 *
 * Fictional data only: the 'Kestrel' galley, Talamahu Market, Marché de Papeete.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, Map<string, unknown>>();
vi.mock('../services/vessel/LocalDatabase', () => ({
    getAll: (table: string) => Array.from(store.get(table)?.values() || []),
    query: (table: string, fn: (item: unknown) => boolean) => Array.from(store.get(table)?.values() || []).filter(fn),
    insertLocal: async (table: string, item: { id: string }) => {
        if (!store.has(table)) store.set(table, new Map());
        store.get(table)!.set(item.id, item);
        return item;
    },
    updateLocal: async (table: string, id: string, updates: Record<string, unknown>) => {
        const existing = store.get(table)?.get(id) as Record<string, unknown> | undefined;
        if (!existing) return null;
        Object.assign(existing, updates);
        return existing;
    },
    deleteLocal: async (table: string, id: string) => {
        store.get(table)?.delete(id);
    },
    bulkUpsert: async (table: string, records: Record<string, unknown>[]) => {
        if (!store.has(table)) store.set(table, new Map());
        for (const record of records) store.get(table)!.set(String(record.id), record);
    },
    bulkDelete: async (table: string, ids: string[]) => {
        for (const id of ids) store.get(table)?.delete(id);
    },
    generateUUID: () => `shop-${Math.random().toString(36).slice(2, 10)}`,
}));
vi.mock('../services/vessel/SyncService', () => ({ syncNow: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../services/VoyageService', () => ({ getCachedActiveVoyage: vi.fn(() => null) }));
vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));

import {
    CURRENCY_CHOICES,
    currencySymbol,
    formatMoney,
    formatSpend,
    regionCurrency,
    resolveCurrency,
    spendByCurrency,
} from '../utils/money';
import { groceryCurrency } from '../services/galley/groceryCurrency';
import { useSettingsStore } from '../stores/settingsStore';
import {
    addManualItem,
    bulkAddToShoppingList,
    generateShoppingList,
    getShoppingList,
    markPurchased,
    recentRetailers,
    type ShoppingItem,
} from '../services/ShoppingListService';

function chooseCurrency(currency: string | null | undefined) {
    useSettingsStore.setState((state) => ({ settings: { ...state.settings, currency } }));
}

function phoneSpeaks(...languages: string[]) {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(languages);
}

beforeEach(() => {
    store.clear();
    chooseCurrency(undefined);
    phoneSpeaks('en-AU');
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("the phone's region picks the currency when none is chosen", () => {
    it.each([
        [['en-AU'], 'AUD'],
        [['en-NZ'], 'NZD'],
        [['fr-PF'], 'XPF'],
        [['fr-NC'], 'XPF'],
        [['en-FJ'], 'FJD'],
        [['to-TO'], 'TOP'],
        [['en-US'], 'USD'],
        [['en-GB'], 'GBP'],
        [['de-DE'], 'EUR'],
        [['zh-Hant-HK'], 'HKD'],
        // The first language whose region is known wins: a bare 'en' names none.
        [['en', 'es-419', 'en-CA'], 'CAD'],
    ])('%j → %s', (languages, code) => {
        expect(regionCurrency(languages)).toBe(code);
    });

    it('names none for a bare language or an unknown region', () => {
        expect(regionCurrency(['en'])).toBeNull();
        expect(regionCurrency(['es-419'])).toBeNull();
        expect(regionCurrency(['en-AQ'])).toBeNull();
        expect(regionCurrency([])).toBeNull();
    });

    it('reads the phone itself when not told', () => {
        phoneSpeaks('fr-PF', 'en-AU');
        expect(regionCurrency()).toBe('XPF');
    });
});

describe('the chosen currency, else the region, else the Australian dollar', () => {
    it('a choice in Preferences wins over the region', () => {
        expect(resolveCurrency('NZD', ['en-US'])).toBe('NZD');
        expect(resolveCurrency(' nzd ', ['en-US'])).toBe('NZD');
    });

    it('no choice, or one that is not a currency code, follows the region', () => {
        expect(resolveCurrency(undefined, ['en-GB'])).toBe('GBP');
        expect(resolveCurrency(null, ['en-GB'])).toBe('GBP');
        expect(resolveCurrency('', ['en-GB'])).toBe('GBP');
        expect(resolveCurrency('dollars', ['en-GB'])).toBe('GBP');
    });

    it('with no region either, the Australian dollar every row had before', () => {
        expect(resolveCurrency(undefined, ['en'])).toBe('AUD');
    });

    it('every choice Preferences offers is a code the resolver keeps', () => {
        for (const { code } of CURRENCY_CHOICES) expect(resolveCurrency(code, ['en'])).toBe(code);
        expect(new Set(CURRENCY_CHOICES.map((choice) => choice.code)).size).toBe(CURRENCY_CHOICES.length);
    });

    it('groceryCurrency reads Preferences, then the phone', () => {
        phoneSpeaks('en-NZ');
        expect(groceryCurrency()).toBe('NZD');
        chooseCurrency('XPF');
        expect(groceryCurrency()).toBe('XPF');
        chooseCurrency(null);
        expect(groceryCurrency()).toBe('NZD');
    });
});

describe('amounts are written the phone’s way, never a bare $ for every currency', () => {
    it('Australian dollars on an Australian phone and on an American one', () => {
        expect(formatMoney(12.5, 'AUD', 'en-AU')).toBe('$12.50');
        expect(formatMoney(12.5, 'AUD', 'en-US')).toBe('A$12.50');
        expect(formatMoney(12.5, 'USD', 'en-US')).toBe('$12.50');
    });

    it('euros in France, with the sign after', () => {
        expect(formatMoney(12.5, 'EUR', 'fr-FR')).toMatch(/^12,50\s€$/);
    });

    it('a currency with no cents shows none', () => {
        expect(formatMoney(1200, 'XPF', 'fr-PF')).not.toContain(',00');
        expect(formatMoney(1200, 'JPY', 'en-AU')).not.toContain('.00');
    });

    it('a stored code Intl refuses is written plainly, an empty one as the old AUD', () => {
        expect(formatMoney(3, 'dollars', 'en-AU')).toBe('$3.00');
        expect(formatMoney(3, '', 'en-AU')).toBe('$3.00');
        expect(formatMoney(3, null, 'en-US')).toBe('A$3.00');
    });

    it('the sign beside the price box is the row currency’s', () => {
        expect(currencySymbol('AUD', 'en-AU')).toBe('$');
        expect(currencySymbol('NZD', 'en-NZ')).toBe('$');
        expect(currencySymbol('NZD', 'en-US')).toBe('NZ$');
        expect(currencySymbol('EUR', 'en-US')).toBe('€');
    });
});

describe('spend per currency: two currencies are never added together', () => {
    const row = (actual_cost: number | null, currency: string, purchased = true) => ({
        actual_cost,
        currency,
        purchased,
    });

    it('totals each currency apart, largest first, and leaves out unbought and unpriced rows', () => {
        const spent = spendByCurrency([
            row(4.5, 'AUD'),
            row(10, 'XPF'),
            row(3.25, 'AUD'),
            row(99, 'AUD', false),
            row(null, 'AUD'),
            row(0, 'NZD'),
        ]);
        expect(spent).toEqual([
            { currency: 'XPF', total: 10 },
            { currency: 'AUD', total: 7.75 },
        ]);
        expect(formatSpend(spent, 'en-AU')).toBe(`${formatMoney(10, 'XPF', 'en-AU')} + $7.75`);
    });

    it('nothing spent is an empty line', () => {
        expect(spendByCurrency([])).toEqual([]);
        expect(formatSpend([])).toBe('');
    });
});

describe('new rows take the chosen currency; stored rows keep theirs', () => {
    it('an item added by hand, from the Meal Calendar or from passage shortfalls', async () => {
        chooseCurrency('TOP');
        const manual = await addManualItem({ name: 'Taro', qty: 2, unit: 'kg', voyageId: null });
        await bulkAddToShoppingList([{ name: 'Limes', totalQty: 6, unit: 'each' }], null);
        const [fromShortfall] = await generateShoppingList(
            [{ id: 'p1', ingredient_name: 'Rice', shortfall_qty: 2, unit: 'kg', status: 'needed' } as never],
            null,
        );
        const rows = Array.from(store.get('shopping_list')!.values()) as ShoppingItem[];
        expect(manual.currency).toBe('TOP');
        expect(fromShortfall.currency).toBe('TOP');
        expect(rows.map((item) => item.currency)).toEqual(['TOP', 'TOP', 'TOP']);
    });

    it('with none chosen, the phone region’s', async () => {
        phoneSpeaks('fr-PF');
        const item = await addManualItem({ name: 'Baguette', qty: 1, unit: 'each', voyageId: null });
        expect(item.currency).toBe('XPF');
    });

    it('a row saved in AUD stays AUD after the choice changes, and its purchase keeps it', async () => {
        const kept = await addManualItem({ name: 'Flour', qty: 1, unit: 'kg', voyageId: null });
        expect(kept.currency).toBe('AUD');
        chooseCurrency('NZD');
        // Adding more of it tops the same row up: its currency is not touched.
        await addManualItem({ name: 'flour', qty: 1, unit: 'kg', voyageId: null });
        await markPurchased(kept.id, 4.2, 'Countdown');
        const row = store.get('shopping_list')!.get(kept.id) as ShoppingItem;
        expect(row).toMatchObject({ currency: 'AUD', actual_cost: 4.2, required_qty: 2 });
        expect(store.get('inventory_items')!.get(kept.id)).toMatchObject({ currency: 'AUD' });
    });

    it('an empty list reports the chosen currency, not AUD', () => {
        chooseCurrency('FJD');
        expect(getShoppingList(null).currency).toBe('FJD');
    });
});

describe('the quick picks are the shops this phone has used', () => {
    async function boughtAt(name: string, shop: string | undefined, at: string) {
        const item = await addManualItem({ name, qty: 1, unit: 'each', voyageId: null });
        await markPurchased(item.id, undefined, shop);
        (store.get('shopping_list')!.get(item.id) as ShoppingItem).purchased_at = at;
    }

    it('none until a purchase names a shop', async () => {
        await addManualItem({ name: 'Limes', qty: 1, unit: 'each', voyageId: null });
        await boughtAt('Salt', undefined, '2026-10-01T00:00:00.000Z');
        expect(recentRetailers()).toEqual([]);
    });

    it('latest first, one per shop in its latest spelling, at most five', async () => {
        await boughtAt('Taro', 'Talamahu Market', '2026-10-01T00:00:00.000Z');
        await boughtAt('Bread', 'Marché de Papeete', '2026-10-03T00:00:00.000Z');
        await boughtAt('Limes', '  talamahu   market ', '2026-10-05T00:00:00.000Z');
        await boughtAt('Diesel', 'Fuel dock', '2026-10-02T00:00:00.000Z');
        for (const [i, shop] of ['A', 'B', 'C', 'D'].entries()) {
            await boughtAt(`Item ${shop}`, `Shop ${shop}`, `2026-09-0${i + 1}T00:00:00.000Z`);
        }
        expect(recentRetailers()).toEqual(['talamahu market', 'Marché de Papeete', 'Fuel dock', 'Shop D', 'Shop C']);
        expect(recentRetailers(2)).toHaveLength(2);
    });

    it('a row put back on the list is no longer a purchase', async () => {
        await boughtAt('Taro', 'Talamahu Market', '2026-10-01T00:00:00.000Z');
        const row = Array.from(store.get('shopping_list')!.values())[0] as ShoppingItem;
        row.purchased = false;
        expect(recentRetailers()).toEqual([]);
    });
});
