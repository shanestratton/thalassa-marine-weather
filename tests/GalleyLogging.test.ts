/**
 * Galley failures leave a trace (126-B2b, binder audit GAL-13; Shane
 * 2026-10-09: "check all of the binders to make sure that they are at the same
 * standard as the rest of the app").
 *
 * The Galley services swallowed their failures: a purchase whose Ship's Stores
 * mirror failed, a sync that threw, a receipt that would not parse, a crew
 * count that fell back to one. Nothing reached the device log, so a bug report
 * came with no trace. Each catch now logs one warn with its own reason (warn
 * is the only level a production build keeps), and never an id, a name or a
 * title. What the sailor is told is unchanged.
 *
 * The real services over the real LocalDatabase on an in-memory filesystem
 * that can be told to fail one table's writes. Only the sync engine and the
 * crew roster are stubbed. Fictional data only: the 'Kestrel' galley
 * (skipper-1), 'Feijoada', 'Shackle pins', 'Ψαρόσουπα'.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

const h = vi.hoisted(() => ({
    /** Table files whose writes fail (e.g. '_inventory_items.json'). */
    failingFiles: new Set<string>(),
}));

vi.mock('@capacitor/filesystem', async () => {
    const { memoryFilesystemModule, memoryFs: fs } = await import('./helpers/memoryFilesystem');
    const module = memoryFilesystemModule();
    const readdir: typeof fs.readdir = async (options) => {
        if (options.path) return fs.readdir(options);
        const root = `${options.directory ?? 'DATA'}/`;
        const files = [...fs.files.entries()]
            .filter(([key]) => key.startsWith(root) && !key.slice(root.length).includes('/'))
            .map(([key, file]) => ({
                name: key.slice(root.length),
                type: 'file' as const,
                size: file.data.length,
                ctime: file.mtime,
                mtime: file.mtime,
                uri: `mem://${key}`,
            }));
        return { files };
    };
    const writeFile: typeof fs.writeFile = async (options) => {
        for (const suffix of h.failingFiles) {
            if (options.path.includes(suffix)) throw new Error('No space left on device');
        }
        return fs.writeFile(options);
    };
    return { ...module, Filesystem: { ...fs, readdir, writeFile } };
});

vi.mock('../services/vessel/SyncService', () => ({
    syncNow: vi.fn(async () => ({ pushed: 0, pulled: 0, errors: [] })),
}));
vi.mock('../services/CrewService', () => ({ getMyCrew: vi.fn(async () => []) }));
vi.mock('../services/VoyageService', () => ({ getCachedActiveVoyage: vi.fn(() => null) }));
vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));

import { memoryFs } from './helpers/memoryFilesystem';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import { bulkDelete, getById, initLocalDatabase, insertLocal } from '../services/vessel/LocalDatabase';
import { syncNow } from '../services/vessel/SyncService';
import { getMyCrew } from '../services/CrewService';
import {
    addManualItem,
    bulkAddToShoppingList,
    markPurchased,
    reconcileGroceryInventoryMirror,
    removeUnpurchasedProvisionItems,
    unmarkPurchased,
} from '../services/ShoppingListService';
import { addShortfallItem, getCrewCount } from '../services/MealPlanService';

const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
type WarnSpy = MockInstance<typeof console.warn>;
let warn: WarnSpy;

/** Every warn that carries this reason, as one line each. */
function warnings(reason: string): string[] {
    return warn.mock.calls
        .filter((call) => call.some((part) => part === reason))
        .map((call) => call.map((part) => String(part)).join(' '));
}

async function settle(): Promise<void> {
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(async () => {
    memoryFs.reset();
    h.failingFiles.clear();
    localStorage.clear();
    localStorage.setItem('thalassa_localdb_moved_to_library', '1');
    vi.mocked(syncNow).mockResolvedValue({ pushed: 0, pulled: 0, errors: [] });
    vi.mocked(getMyCrew).mockResolvedValue([]);
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    setAuthIdentityScope('skipper-1');
    await initLocalDatabase('skipper-1');
});

afterEach(async () => {
    h.failingFiles.clear();
    await initLocalDatabase(null);
    setAuthIdentityScope(null);
    warn.mockRestore();
});

describe('MealPlanService', () => {
    it('galley: crew-count — the roster fails, the count falls back to the captain', async () => {
        vi.mocked(getMyCrew).mockRejectedValueOnce(new Error('Failed to fetch'));

        await expect(getCrewCount('voyage-horta')).resolves.toBe(1);

        expect(warnings('galley: crew-count')).toEqual([expect.stringContaining('Failed to fetch')]);
    });

    it('galley: shortfall — the provisions write fails, the button reports false', async () => {
        h.failingFiles.add('_passage_provisions.json');

        await expect(addShortfallItem('Black beans', 500, 'g', 'Feijoada', null)).resolves.toBe(false);

        const [line] = warnings('galley: shortfall');
        expect(warnings('galley: shortfall')).toHaveLength(1);
        expect(line).toContain('No space left on device');
        expect(line).not.toMatch(/Feijoada|Black beans/);
    });
});

describe('ShoppingListService', () => {
    it('galley: purchase-mirror — the Stores mirror fails, the purchase still rejects as before', async () => {
        const item = await addManualItem({ name: 'Shackle pins', qty: 4, unit: 'each' });
        h.failingFiles.add('_inventory_items.json');

        await expect(markPurchased(item.id)).rejects.toThrow('No space left on device');

        const lines = warnings('galley: purchase-mirror');
        expect(lines).toHaveLength(1);
        expect(lines[0]).not.toMatch(UUID_ANYWHERE);
        expect(lines[0]).not.toContain('Shackle pins');

        // Undo with the mirror failing logs the same reason once more.
        h.failingFiles.clear();
        await reconcileGroceryInventoryMirror();
        h.failingFiles.add('_inventory_items.json');
        await expect(unmarkPurchased(item.id)).rejects.toThrow('No space left on device');
        expect(warnings('galley: purchase-mirror')).toHaveLength(2);
    });

    it('galley: purchase-sync — the immediate sync after a tick or an untick throws', async () => {
        const item = await addManualItem({ name: 'Shackle pins', qty: 4, unit: 'each' });
        vi.mocked(syncNow).mockRejectedValue(new Error('sync engine stopped'));

        await markPurchased(item.id);
        await unmarkPurchased(item.id);
        await settle();

        expect(warnings('galley: purchase-sync')).toEqual([
            expect.stringContaining('sync engine stopped'),
            expect.stringContaining('sync engine stopped'),
        ]);
    });

    it('galley: item-lock — a failed earlier change to the same item is traced when the next one runs', async () => {
        const item = await addManualItem({ name: 'Shackle pins', qty: 4, unit: 'each' });

        const wrongVoyage = markPurchased(item.id, undefined, undefined, 'voyage-elsewhere');
        const next = markPurchased(item.id);

        await expect(wrongVoyage).rejects.toThrow('does not belong to the selected voyage');
        await expect(next).resolves.toMatchObject({ storesSkipped: false });
        expect(warnings('galley: item-lock')).toEqual([
            expect.stringContaining('does not belong to the selected voyage'),
        ]);
    });

    it('galley: add-manual — the sync after a hand-added item throws (both the new and the merged paths)', async () => {
        vi.mocked(syncNow).mockRejectedValue(new Error('sync engine stopped'));

        await addManualItem({ name: 'Shackle pins', qty: 4, unit: 'each' });
        await addManualItem({ name: 'Shackle pins', qty: 2, unit: 'each' });
        await settle();

        expect(warnings('galley: add-manual')).toHaveLength(2);
    });

    it('galley: bulk-add — the sync after "Add all to shopping list" throws', async () => {
        vi.mocked(syncNow).mockRejectedValue(new Error('sync engine stopped'));

        await expect(
            bulkAddToShoppingList([{ name: 'Black beans', totalQty: 500, unit: 'g' }], null, 'skipper-1'),
        ).resolves.toBe(1);
        await settle();

        expect(warnings('galley: bulk-add')).toEqual([expect.stringContaining('sync engine stopped')]);
    });

    it('galley: provisions-cleanup — the sync after clearing passage provisions throws', async () => {
        await insertLocal('shopping_list', {
            id: 'provision-feijoada',
            user_id: 'skipper-1',
            ingredient_name: 'Black beans',
            required_qty: 500,
            unit: 'g',
            market_zone: 'General',
            actual_cost: null,
            currency: 'BRL',
            purchased: false,
            purchased_at: null,
            store_location: 'Galley',
            provision_id: null,
            voyage_id: null,
            notes: 'Passage provision',
            created_at: '2026-10-10T00:00:00.000Z',
            updated_at: '2026-10-10T00:00:00.000Z',
        });
        vi.mocked(syncNow).mockRejectedValue(new Error('sync engine stopped'));

        await expect(removeUnpurchasedProvisionItems()).resolves.toBe(1);
        await settle();

        expect(warnings('galley: provisions-cleanup')).toEqual([expect.stringContaining('sync engine stopped')]);
    });

    it('galley: receipt-parse — a damaged receipt marker is traced, without quoting the notes', async () => {
        await insertLocal('shopping_list', {
            id: 'damaged-receipt',
            user_id: 'skipper-1',
            ingredient_name: 'Ψαρόσουπα fish',
            required_qty: 1,
            unit: 'kg',
            market_zone: 'Butcher',
            actual_cost: 12,
            currency: 'EUR',
            purchased: true,
            purchased_at: '2026-10-10T00:00:00.000Z',
            store_location: 'Galley',
            provision_id: null,
            voyage_id: null,
            notes: 'From the Piraeus market [[thalassa:grocery-purchase:{"version":2,"retailer":"Ψαράς"]]',
            created_at: '2026-10-10T00:00:00.000Z',
            updated_at: '2026-10-10T00:00:00.000Z',
        });

        await expect(reconcileGroceryInventoryMirror()).resolves.toEqual({ repaired: 0, errors: [] });

        const lines = warnings('galley: receipt-parse');
        expect(lines.length).toBeGreaterThanOrEqual(1);
        for (const line of lines) expect(line).not.toMatch(/Piraeus|Ψαράς|retailer/);
    });

    it('galley: reconcile-item — one item the startup repair cannot rebuild is traced by reason, not id', async () => {
        const item = await addManualItem({ name: 'Shackle pins', qty: 4, unit: 'each' });
        await markPurchased(item.id);
        await bulkDelete('inventory_items', [item.id]);
        h.failingFiles.add('_inventory_items.json');

        const outcome = await reconcileGroceryInventoryMirror();

        expect(outcome.errors).toHaveLength(1);
        const lines = warnings('galley: reconcile-item');
        expect(lines).toEqual([expect.stringContaining('No space left on device')]);
        expect(lines[0]).not.toMatch(UUID_ANYWHERE);
    });
});

describe('the LocalDatabase ready chain', () => {
    it('warns with a count when the grocery mirror repair returns errors', async () => {
        for (const name of ['Shackle pins', 'Black beans']) {
            const item = await addManualItem({ name, qty: 2, unit: 'each' });
            await markPurchased(item.id);
            await bulkDelete('inventory_items', [item.id]);
            expect(getById('inventory_items', item.id)).toBeNull();
        }
        h.failingFiles.add('_inventory_items.json');

        // The next launch: the database loads, then its ready chain repairs.
        await initLocalDatabase(null);
        await initLocalDatabase('skipper-1');

        const lines = warn.mock.calls
            .map((call) => call.map((part) => String(part)).join(' '))
            .filter((line) => line.includes('Grocery mirror repair'));
        expect(lines).toEqual([expect.stringContaining('[LocalDB] Grocery mirror repair: 2 items failed')]);
        expect(lines[0]).not.toMatch(UUID_ANYWHERE);
        expect(lines[0]).not.toMatch(/Shackle|beans/);
    });
});
