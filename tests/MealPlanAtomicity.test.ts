import { Filesystem } from '@capacitor/filesystem';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MealPlan } from '../services/MealPlanService';

vi.mock('../services/ShoppingListService', () => ({
    reconcileGroceryInventoryMirror: vi.fn().mockResolvedValue(undefined),
}));

type LocalDatabaseModule = typeof import('../services/vessel/LocalDatabase');
type MealPlanServiceModule = typeof import('../services/MealPlanService');

const OWNER = 'meal-owner';

function scopedFile(identity: string | null, legacyFile: string): string {
    const token = identity
        ? `user_${Array.from(new TextEncoder().encode(identity), (byte) => byte.toString(16).padStart(2, '0')).join(
              '',
          )}`
        : 'anonymous';
    return `vessel_${token}_${legacyFile.replace(/^vessel_/, '')}`;
}

function installFilesystem(disk: Map<string, string>): void {
    vi.mocked(Filesystem.readdir).mockImplementation(async () => ({
        files: Array.from(disk.keys()).map((name) => ({
            name,
            type: 'file',
            size: disk.get(name)?.length ?? 0,
            ctime: 0,
            mtime: 0,
            uri: `mock://${name}`,
        })),
    }));
    vi.mocked(Filesystem.readFile).mockImplementation(async ({ path }) => ({
        data: disk.get(path) ?? '',
    }));
    vi.mocked(Filesystem.writeFile).mockImplementation(async ({ path, data }) => {
        disk.set(path, String(data));
        return { uri: `mock://${path}` };
    });
    vi.mocked(Filesystem.deleteFile).mockImplementation(async ({ path }) => {
        disk.delete(path);
    });
    vi.mocked(Filesystem.rename).mockImplementation(async ({ from, to }) => {
        const contents = disk.get(from);
        if (contents === undefined) throw new Error(`Missing ${from}`);
        disk.set(to, contents);
        disk.delete(from);
    });
}

async function loadModules(disk: Map<string, string>): Promise<{
    database: LocalDatabaseModule;
    meals: MealPlanServiceModule;
}> {
    installFilesystem(disk);
    const database = await import('../services/vessel/LocalDatabase');
    await database.initLocalDatabase(OWNER);
    const meals = await import('../services/MealPlanService');
    return { database, meals };
}

function meal(overrides: Partial<MealPlan> = {}): MealPlan {
    return {
        id: '11111111-1111-4111-8111-111111111111',
        user_id: OWNER,
        voyage_id: 'voyage-atomic',
        recipe_id: null,
        spoonacular_id: null,
        title: 'Crash-safe curry',
        planned_date: '2026-07-23',
        meal_slot: 'dinner',
        servings_planned: 4,
        ingredients: [
            { name: 'Rice', amount: 1.5, unit: 'kg', scalable: true, aisle: 'Dry' },
            { name: 'Beans', amount: 500, unit: 'g', scalable: true, aisle: 'Dry' },
        ],
        status: 'reserved',
        cook_started_at: null,
        completed_at: null,
        leftovers_saved: false,
        notes: null,
        created_at: '2026-07-23T08:00:00.000Z',
        updated_at: '2026-07-23T08:00:00.000Z',
        ...overrides,
    };
}

describe('MealPlanService durable atomic workflows', () => {
    let disk: Map<string, string>;

    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        localStorage.clear();
        disk = new Map();
        installFilesystem(disk);
    });

    it('recovers every ingredient delta with the original operation IDs after a crash before the table write', async () => {
        let { database, meals } = await loadModules(disk);
        const plan = meal();
        await database.bulkUpsert('meal_plans', [plan]);
        await database.bulkUpsert('inventory_items', [
            { id: 'rice-store', user_id: OWNER, item_name: 'Rice', quantity: 2, unit: 'kg' },
            { id: 'beans-store', user_id: OWNER, item_name: 'Beans', quantity: 1, unit: 'kg' },
        ]);

        const inventoryTemporary = `${scopedFile(OWNER, 'vessel_inventory_items.json')}.tmp`;
        const durableWrite = vi.mocked(Filesystem.writeFile).getMockImplementation();
        let interrupted = false;
        vi.mocked(Filesystem.writeFile).mockImplementation(async (options) => {
            if (!interrupted && options.path === inventoryTemporary) {
                interrupted = true;
                throw new Error('simulated process interruption');
            }
            return durableWrite!(options);
        });

        await expect(meals.completeMeal(plan.id, 4)).rejects.toThrow('simulated process interruption');

        const journalFile = scopedFile(OWNER, 'vessel_local_transaction.json');
        const journal = JSON.parse(disk.get(journalFile) || '{}') as {
            queue: Array<{ id: string; mutation_type: string; record_id: string }>;
        };
        const committedDeltaIds = journal.queue.filter((item) => item.mutation_type === 'DELTA').map((item) => item.id);
        expect(committedDeltaIds).toHaveLength(2);

        // A same-process retry first finishes the pending journal and then
        // sees the completed meal instead of generating fresh deltas.
        await meals.completeMeal(plan.id, 4);
        expect(
            database
                .getFullQueue()
                .filter((item) => item.mutation_type === 'DELTA')
                .map((item) => item.id),
        ).toEqual(committedDeltaIds);

        // Hard restart: discard every module-level cache and recover only from
        // the repaired files.
        vi.resetModules();
        ({ database, meals } = await loadModules(disk));

        expect(database.getById<{ quantity: number }>('inventory_items', 'rice-store')?.quantity).toBe(0.5);
        expect(database.getById<{ quantity: number }>('inventory_items', 'beans-store')?.quantity).toBe(0.5);
        expect(database.getById<MealPlan>('meal_plans', plan.id)?.status).toBe('completed');

        const recoveredDeltaIds = database
            .getFullQueue()
            .filter((item) => item.mutation_type === 'DELTA')
            .map((item) => item.id);
        expect(recoveredDeltaIds).toEqual(committedDeltaIds);

        await meals.completeMeal(plan.id, 4);
        expect(database.getById<{ quantity: number }>('inventory_items', 'rice-store')?.quantity).toBe(0.5);
        expect(database.getById<{ quantity: number }>('inventory_items', 'beans-store')?.quantity).toBe(0.5);
        expect(
            database
                .getFullQueue()
                .filter((item) => item.mutation_type === 'DELTA')
                .map((item) => item.id),
        ).toEqual(committedDeltaIds);
    });

    it('does not double-consume when inventory reached disk but the completed meal flag did not', async () => {
        let { database, meals } = await loadModules(disk);
        const plan = meal();
        await database.bulkUpsert('meal_plans', [plan]);
        await database.bulkUpsert('inventory_items', [
            { id: 'rice-store', user_id: OWNER, item_name: 'Rice', quantity: 2, unit: 'kg' },
            { id: 'beans-store', user_id: OWNER, item_name: 'Beans', quantity: 1, unit: 'kg' },
        ]);

        const mealTemporary = `${scopedFile(OWNER, 'vessel_meal_plans.json')}.tmp`;
        const durableWrite = vi.mocked(Filesystem.writeFile).getMockImplementation();
        let interrupted = false;
        vi.mocked(Filesystem.writeFile).mockImplementation(async (options) => {
            if (!interrupted && options.path === mealTemporary) {
                interrupted = true;
                throw new Error('meal flag write interrupted');
            }
            return durableWrite!(options);
        });

        await expect(meals.completeMeal(plan.id, 4)).rejects.toThrow('meal flag write interrupted');
        const inventoryFile = scopedFile(OWNER, 'vessel_inventory_items.json');
        expect(JSON.parse(disk.get(inventoryFile) || '{}')['rice-store'].quantity).toBe(0.5);

        vi.resetModules();
        ({ database, meals } = await loadModules(disk));
        const operationIds = database.getFullQueue().map((item) => item.id);

        await meals.completeMeal(plan.id, 4);
        expect(database.getById<{ quantity: number }>('inventory_items', 'rice-store')?.quantity).toBe(0.5);
        expect(database.getById<{ quantity: number }>('inventory_items', 'beans-store')?.quantity).toBe(0.5);
        expect(database.getFullQueue().map((item) => item.id)).toEqual(operationIds);
    });

    it('recovers exactly one deterministic leftover and repairs either side on retry', async () => {
        let { database, meals } = await loadModules(disk);
        const plan = meal({
            status: 'completed',
            completed_at: '2026-07-23T09:00:00.000Z',
        });
        await database.bulkUpsert('meal_plans', [plan]);

        const mealTemporary = `${scopedFile(OWNER, 'vessel_meal_plans.json')}.tmp`;
        const durableWrite = vi.mocked(Filesystem.writeFile).getMockImplementation();
        let interrupted = false;
        vi.mocked(Filesystem.writeFile).mockImplementation(async (options) => {
            if (!interrupted && options.path === mealTemporary) {
                interrupted = true;
                throw new Error('leftover meal flag interrupted');
            }
            return durableWrite!(options);
        });

        await expect(meals.saveLeftovers(plan.id, 2)).rejects.toThrow('leftover meal flag interrupted');

        vi.resetModules();
        ({ database, meals } = await loadModules(disk));
        const operationIds = database.getFullQueue().map((item) => item.id);
        await meals.saveLeftovers(plan.id, 2);

        const leftovers = database
            .getAll<{ id: string; user_id: string; item_name: string; quantity: number }>('inventory_items')
            .filter((item) => item.item_name === `${plan.title} (Leftovers)`);
        expect(leftovers).toEqual([
            expect.objectContaining({
                id: plan.id,
                user_id: OWNER,
                quantity: 2,
            }),
        ]);
        expect(database.getById<MealPlan>('meal_plans', plan.id)?.leftovers_saved).toBe(true);
        expect(database.getFullQueue().map((item) => item.id)).toEqual(operationIds);

        // Repair the opposite historical partial state: the flag survived but
        // the deterministic stores row did not.
        await database.bulkDelete('inventory_items', [plan.id]);
        await meals.saveLeftovers(plan.id, 1);
        expect(
            database
                .getAll<{ id: string; item_name: string }>('inventory_items')
                .filter((item) => item.item_name === `${plan.title} (Leftovers)`),
        ).toHaveLength(1);
    });

    it('rolls back all staged table and outbox changes when transaction preparation throws', async () => {
        const { database } = await loadModules(disk);
        await database.bulkUpsert('inventory_items', [
            { id: 'rollback-store', user_id: OWNER, item_name: 'Oil', quantity: 3, unit: 'L' },
        ]);

        await expect(
            database.atomicLocalTransaction((transaction) => {
                transaction.delta('inventory_items', 'rollback-store', 'quantity', -2);
                transaction.insert('meal_plans', meal({ id: '22222222-2222-4222-8222-222222222222' }));
                throw new Error('recipe preparation failed');
            }),
        ).rejects.toThrow('recipe preparation failed');

        expect(database.getById<{ quantity: number }>('inventory_items', 'rollback-store')?.quantity).toBe(3);
        expect(database.getById('meal_plans', '22222222-2222-4222-8222-222222222222')).toBeNull();
        expect(database.getFullQueue()).toEqual([]);
        expect(disk.has(scopedFile(OWNER, 'vessel_local_transaction.json'))).toBe(false);
    });
});
