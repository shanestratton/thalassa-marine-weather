/**
 * MealPlanService — date helpers + query tests
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const localStore = vi.hoisted(() => new Map<string, Map<string, unknown>>());

// Mock LocalDatabase
vi.mock('../services/vessel/LocalDatabase', () => {
    return {
        getAll: (table: string) => {
            const t = localStore.get(table);
            return t ? Array.from(t.values()) : [];
        },
        query: (table: string, fn: (item: unknown) => boolean) => {
            const t = localStore.get(table);
            if (!t) return [];
            return Array.from(t.values()).filter(fn);
        },
        atomicLocalTransaction: async (operation: (transaction: Record<string, unknown>) => unknown) => {
            const getTable = (table: string) => {
                let records = localStore.get(table);
                if (!records) {
                    records = new Map();
                    localStore.set(table, records);
                }
                return records;
            };
            const transaction = {
                getById: (table: string, id: string) => getTable(table).get(id) ?? null,
                getAll: (table: string) => Array.from(getTable(table).values()),
                query: (table: string, fn: (item: unknown) => boolean) =>
                    Array.from(getTable(table).values()).filter(fn),
                insert: (table: string, item: { id: string }) => {
                    getTable(table).set(item.id, item);
                    return item;
                },
                update: (table: string, id: string, updates: Record<string, unknown>) => {
                    const records = getTable(table);
                    const existing = records.get(id);
                    if (!existing) return null;
                    const updated = { ...(existing as Record<string, unknown>), ...updates };
                    records.set(id, updated);
                    return updated;
                },
                delta: (table: string, id: string, field: string, delta: number) => {
                    const records = getTable(table);
                    const existing = records.get(id) as Record<string, unknown> | undefined;
                    if (!existing) return null;
                    const updated = {
                        ...existing,
                        [field]: Math.max(0, Number(existing[field] ?? 0) + delta),
                    };
                    records.set(id, updated);
                    return updated;
                },
                delete: (table: string, id: string) => getTable(table).delete(id),
            };
            return operation(transaction);
        },
        insertLocal: async (table: string, item: { id: string }) => {
            if (!localStore.has(table)) localStore.set(table, new Map());
            localStore.get(table)!.set(item.id, item);
            return item;
        },
        updateLocal: async (table: string, id: string, updates: Record<string, unknown>) => {
            const t = localStore.get(table);
            if (!t) return null;
            const existing = t.get(id);
            if (!existing) return null;
            const updated = { ...(existing as Record<string, unknown>), ...updates };
            t.set(id, updated);
            return updated;
        },
        deleteLocal: async (table: string, id: string) => {
            localStore.get(table)?.delete(id);
        },
        deltaLocal: async (table: string, id: string, field: string, delta: number) => {
            const t = localStore.get(table);
            if (!t) return;
            const existing = t.get(id) as Record<string, unknown> | undefined;
            if (existing) {
                (existing as Record<string, number>)[field] =
                    ((existing as Record<string, number>)[field] || 0) + delta;
            }
        },
        generateUUID: () => `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    };
});

// Mock GalleyRecipeService
vi.mock('../services/GalleyRecipeService', () => ({
    scaleIngredient: (amount: number, scalable: boolean, originalServings: number, targetServings: number) => {
        if (!scalable) return amount;
        return Math.round(((amount * targetServings) / originalServings) * 10) / 10;
    },
    persistRecipe: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../utils/system', () => ({ triggerHaptic: vi.fn() }));

import {
    toUTCDateString,
    todayUTC,
    getVoyageDateRange,
    scheduleMeal,
    getMealPlans,
    getMealsForDate,
    getMealsByStatus,
    getStoresAvailability,
    unscheduleMeal as _unscheduleMeal,
    startCooking,
    completeMeal,
    skipMeal,
    saveLeftovers,
} from '../services/MealPlanService';
import { getAll, insertLocal } from '../services/vessel/LocalDatabase';
import type { MealSlot } from '../services/MealPlanService';

const OWNER_A = 'owner-a';
const OWNER_B = 'owner-b';

describe('MealPlanService', () => {
    beforeEach(() => {
        localStore.clear();
        vi.clearAllMocks();
    });

    // ── Date Helpers ─────────────────────
    describe('toUTCDateString', () => {
        it('converts date to YYYY-MM-DD', () => {
            const d = new Date('2026-03-23T22:00:00Z');
            expect(toUTCDateString(d)).toBe('2026-03-23');
        });

        it('handles midnight UTC', () => {
            const d = new Date('2026-01-01T00:00:00Z');
            expect(toUTCDateString(d)).toBe('2026-01-01');
        });
    });

    describe('todayUTC', () => {
        it('returns YYYY-MM-DD format', () => {
            const result = todayUTC();
            expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        });
    });

    describe('getVoyageDateRange', () => {
        it('returns correct number of dates', () => {
            const dates = getVoyageDateRange('2026-03-20', 5);
            expect(dates).toHaveLength(5);
        });

        it('starts from the given date', () => {
            const dates = getVoyageDateRange('2026-03-20', 3);
            expect(dates[0]).toBe('2026-03-20');
            expect(dates[1]).toBe('2026-03-21');
            expect(dates[2]).toBe('2026-03-22');
        });

        it('handles month boundaries', () => {
            const dates = getVoyageDateRange('2026-03-30', 4);
            expect(dates[0]).toBe('2026-03-30');
            expect(dates[1]).toBe('2026-03-31');
            expect(dates[2]).toBe('2026-04-01');
            expect(dates[3]).toBe('2026-04-02');
        });

        it('handles single day', () => {
            const dates = getVoyageDateRange('2026-06-15', 1);
            expect(dates).toEqual(['2026-06-15']);
        });

        it('returns empty for 0 days', () => {
            const dates = getVoyageDateRange('2026-06-15', 0);
            expect(dates).toEqual([]);
        });
    });

    // ── MealSlot type ─────────────────────
    describe('MealSlot type', () => {
        it('valid slots', () => {
            const slots: MealSlot[] = ['breakfast', 'lunch', 'dinner', 'snack'];
            expect(slots).toHaveLength(4);
        });
    });

    // ── Schedule + Query lifecycle ─────────────────────
    describe('scheduling lifecycle', () => {
        it('scheduleMeal creates a meal plan', async () => {
            const meal = {
                id: 42,
                title: 'Fish Tacos',
                servings: 4,
                readyInMinutes: 30,
                image: 'tacos.jpg',
                ingredients: [
                    { name: 'Fish', amount: 500, unit: 'g', scalable: true },
                    { name: 'Tortillas', amount: 8, unit: 'pcs', scalable: true },
                ],
            };

            const result = await scheduleMeal(meal as never, '2026-03-25', 'dinner', 'v-1', 4, OWNER_A);
            expect(result.user_id).toBe(OWNER_A);
            expect(result.title).toBe('Fish Tacos');
            expect(result.meal_slot).toBe('dinner');
            expect(result.status).toBe('reserved');
            expect(result.servings_planned).toBe(4);
            expect(result.planned_date).toBe('2026-03-25');
        });

        it('refuses to schedule a voyage meal without an authoritative owner', async () => {
            const meal = { id: 43, title: 'Unscoped', servings: 2, readyInMinutes: 10, image: '', ingredients: [] };

            await expect(scheduleMeal(meal as never, '2026-03-25', 'dinner', 'v-unscoped', 2)).rejects.toThrow(
                /authoritative voyage owner/i,
            );
            expect(getMealPlans('v-unscoped')).toEqual([]);
        });

        it('getMealPlans returns all plans', async () => {
            const meal = {
                id: 42,
                title: 'Pasta',
                servings: 2,
                readyInMinutes: 20,
                image: '',
                ingredients: [],
            };
            await scheduleMeal(meal as never, '2026-03-25', 'lunch', null, 2, OWNER_A);
            const plans = getMealPlans();
            expect(plans.length).toBeGreaterThanOrEqual(1);
        });

        it('getMealsForDate filters by date', async () => {
            const meal1 = { id: 1, title: 'Breakfast', servings: 2, readyInMinutes: 10, image: '', ingredients: [] };
            const meal2 = { id: 2, title: 'Lunch', servings: 2, readyInMinutes: 15, image: '', ingredients: [] };
            await scheduleMeal(meal1 as never, '2026-03-25', 'breakfast', 'v-1', 2, OWNER_A);
            await scheduleMeal(meal2 as never, '2026-03-26', 'lunch', 'v-1', 2, OWNER_A);

            const march25 = getMealsForDate('2026-03-25');
            // Should include the breakfast, not the lunch
            const hasMarch25 = march25.some((m) => m.planned_date === '2026-03-25');
            expect(hasMarch25).toBe(true);
        });

        it('getMealsByStatus filters by status', async () => {
            const meal = { id: 3, title: 'Steak', servings: 4, readyInMinutes: 30, image: '', ingredients: [] };
            await scheduleMeal(meal as never, '2026-03-27', 'dinner', null, 4, OWNER_A);

            const reserved = getMealsByStatus('reserved');
            expect(reserved.length).toBeGreaterThanOrEqual(1);
        });

        it('filters meal status queries to the selected voyage', async () => {
            const unique = Date.now();
            const meal = { id: 30, title: 'Scoped', servings: 2, readyInMinutes: 10, image: '', ingredients: [] };
            await scheduleMeal(meal as never, '2026-03-27', 'dinner', `voyage-a-${unique}`, 2, OWNER_A);
            await scheduleMeal(meal as never, '2026-03-27', 'lunch', `voyage-b-${unique}`, 2, OWNER_A);

            const selected = getMealsByStatus('reserved', `voyage-a-${unique}`);
            expect(selected).toHaveLength(1);
            expect(selected[0].voyage_id).toBe(`voyage-a-${unique}`);
        });

        it('completes concurrently only once and never subtracts below zero', async () => {
            const ingredientName = `Limited Fish ${Date.now()}`;
            const meal = {
                id: 4,
                title: 'Limited Fish Dinner',
                servings: 4,
                readyInMinutes: 30,
                image: '',
                ingredients: [{ name: ingredientName, amount: 5, unit: 'kg', scalable: true }],
            };
            const plan = await scheduleMeal(meal as never, '2026-03-28', 'dinner', null, 4, OWNER_A);
            await insertLocal('inventory_items', {
                id: `store-${plan.id}`,
                user_id: OWNER_A,
                item_name: ingredientName,
                quantity: 3,
            });

            const [first, duplicate] = await Promise.all([completeMeal(plan.id, 4), completeMeal(plan.id, 4)]);

            expect(first?.status).toBe('completed');
            expect(duplicate?.status).toBe('completed');
            expect(
                getAll<{ id: string; quantity: number }>('inventory_items').find(
                    (item) => item.id === `store-${plan.id}`,
                )?.quantity,
            ).toBe(0);

            await completeMeal(plan.id, 4);
            expect(
                getAll<{ id: string; quantity: number }>('inventory_items').find(
                    (item) => item.id === `store-${plan.id}`,
                )?.quantity,
            ).toBe(0);
        });

        it('converts recipe units and consumes canonical inventory across separate receipt rows', async () => {
            const ingredientName = `Canonical Rice ${Date.now()}`;
            const meal = {
                id: 40,
                title: 'Canonical Rice Dinner',
                servings: 4,
                readyInMinutes: 30,
                image: '',
                ingredients: [{ name: ingredientName, amount: 0.75, unit: 'kg', scalable: true }],
            };
            const plan = await scheduleMeal(meal as never, '2026-03-28', 'dinner', null, 4, OWNER_A);
            await insertLocal('inventory_items', {
                id: `store-a-${plan.id}`,
                user_id: OWNER_A,
                item_name: ingredientName,
                quantity: 250,
                unit: 'g',
            });
            await insertLocal('inventory_items', {
                id: `store-b-${plan.id}`,
                user_id: OWNER_A,
                item_name: ingredientName,
                quantity: 1000,
                unit: 'g',
            });

            const availability = getStoresAvailability().filter((item) => item.item_name === ingredientName);
            // The scheduling mock rounds scaled recipe amounts to one decimal,
            // so 0.75 kg is snapshotted as 0.8 kg.
            expect(availability.map((item) => item.reserved)).toEqual([250, 550]);

            await completeMeal(plan.id, 4);

            const stores = getAll<{ id: string; quantity: number }>('inventory_items');
            expect(stores.find((item) => item.id === `store-a-${plan.id}`)?.quantity).toBe(0);
            expect(stores.find((item) => item.id === `store-b-${plan.id}`)?.quantity).toBe(450);
        });

        it('does not guess across mass and volume dimensions while consuming stores', async () => {
            const ingredientName = `Density Unknown Sugar ${Date.now()}`;
            const meal = {
                id: 41,
                title: 'Density-safe Dessert',
                servings: 4,
                readyInMinutes: 20,
                image: '',
                ingredients: [{ name: ingredientName, amount: 2, unit: 'tbsp', scalable: true }],
            };
            const plan = await scheduleMeal(meal as never, '2026-03-28', 'dinner', null, 4, OWNER_A);
            await insertLocal('inventory_items', {
                id: `store-${plan.id}`,
                user_id: OWNER_A,
                item_name: ingredientName,
                quantity: 1000,
                unit: 'g',
            });

            await completeMeal(plan.id, 4);

            expect(
                getAll<{ id: string; quantity: number }>('inventory_items').find(
                    (item) => item.id === `store-${plan.id}`,
                )?.quantity,
            ).toBe(1000);
        });

        it('does not regress a completed meal into cooking or skipped', async () => {
            const meal = {
                id: 5,
                title: 'Finished Meal',
                servings: 2,
                readyInMinutes: 15,
                image: '',
                ingredients: [],
            };
            const plan = await scheduleMeal(meal as never, '2026-03-29', 'lunch', null, 2, OWNER_A);
            await completeMeal(plan.id);

            expect(await startCooking(plan.id)).toBeNull();
            expect(await skipMeal(plan.id)).toBeNull();
        });

        it('saves leftovers once even across concurrent and repeated requests', async () => {
            const meal = {
                id: 6,
                title: `Leftover Stew ${Date.now()}`,
                servings: 4,
                readyInMinutes: 45,
                image: '',
                ingredients: [],
            };
            const plan = await scheduleMeal(meal as never, '2026-03-30', 'dinner', null, 4, OWNER_A);
            await completeMeal(plan.id);

            await Promise.all([saveLeftovers(plan.id, 2), saveLeftovers(plan.id, 2)]);
            await saveLeftovers(plan.id, 2);

            const matchingLeftovers = getAll<{ user_id: string; item_name: string; quantity: number }>(
                'inventory_items',
            ).filter((item) => item.item_name === `${meal.title} (Leftovers)`);
            expect(matchingLeftovers).toHaveLength(1);
            expect(matchingLeftovers[0].quantity).toBe(2);
            expect(matchingLeftovers[0].user_id).toBe(OWNER_A);
        });

        it("reads and consumes only the selected vessel owner's matching stores", async () => {
            const unique = Date.now();
            const ingredientName = `Owner-scoped Rice ${unique}`;
            const voyageId = `owner-scoped-voyage-${unique}`;
            const meal = {
                id: 70,
                title: 'Owner-scoped Dinner',
                servings: 4,
                readyInMinutes: 30,
                image: '',
                ingredients: [{ name: ingredientName, amount: 2, unit: 'kg', scalable: true }],
            };
            const plan = await scheduleMeal(meal as never, '2026-04-01', 'dinner', voyageId, 4, OWNER_A);
            await insertLocal('inventory_items', {
                id: `owner-a-store-${unique}`,
                user_id: OWNER_A,
                item_name: ingredientName,
                quantity: 3,
                unit: 'kg',
            });
            await insertLocal('inventory_items', {
                id: `owner-b-store-${unique}`,
                user_id: OWNER_B,
                item_name: ingredientName,
                quantity: 100,
                unit: 'kg',
            });

            const availability = getStoresAvailability(voyageId, OWNER_A).filter(
                (item) => item.item_name === ingredientName,
            );
            expect(availability).toEqual([
                expect.objectContaining({
                    item_id: `owner-a-store-${unique}`,
                    item_name: ingredientName,
                    on_hand: 3,
                    reserved: 2,
                }),
            ]);

            await completeMeal(plan.id, 4);

            const stores = getAll<{ id: string; user_id: string; quantity: number }>('inventory_items');
            expect(stores.find((item) => item.id === `owner-a-store-${unique}`)?.quantity).toBe(1);
            expect(stores.find((item) => item.id === `owner-b-store-${unique}`)?.quantity).toBe(100);
        });
    });
});
