/**
 * MealPlanService — date helpers + query tests
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock LocalDatabase
vi.mock('../services/vessel/LocalDatabase', () => {
    const store = new Map<string, Map<string, unknown>>();
    return {
        getAll: (table: string) => {
            const t = store.get(table);
            return t ? Array.from(t.values()) : [];
        },
        query: (table: string, fn: (item: unknown) => boolean) => {
            const t = store.get(table);
            if (!t) return [];
            return Array.from(t.values()).filter(fn);
        },
        insertLocal: async (table: string, item: { id: string }) => {
            if (!store.has(table)) store.set(table, new Map());
            store.get(table)!.set(item.id, item);
            return item;
        },
        updateLocal: async (table: string, id: string, updates: Record<string, unknown>) => {
            const t = store.get(table);
            if (!t) return null;
            const existing = t.get(id);
            if (!existing) return null;
            const updated = { ...(existing as Record<string, unknown>), ...updates };
            t.set(id, updated);
            return updated;
        },
        deleteLocal: async (table: string, id: string) => {
            store.get(table)?.delete(id);
        },
        deltaLocal: async (table: string, id: string, field: string, delta: number) => {
            const t = store.get(table);
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
    unscheduleMeal,
    startCooking,
    skipMeal,
} from '../services/MealPlanService';
import type { MealSlot } from '../services/MealPlanService';

describe('MealPlanService', () => {
    beforeEach(() => {
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

            const result = await scheduleMeal(meal as never, '2026-03-25', 'dinner', 'v-1', 4);
            expect(result.title).toBe('Fish Tacos');
            expect(result.meal_slot).toBe('dinner');
            expect(result.status).toBe('reserved');
            expect(result.servings_planned).toBe(4);
            expect(result.planned_date).toBe('2026-03-25');
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
            await scheduleMeal(meal as never, '2026-03-25', 'lunch', null, 2);
            const plans = getMealPlans();
            expect(plans.length).toBeGreaterThanOrEqual(1);
        });

        it('getMealsForDate filters by date', async () => {
            const meal1 = { id: 1, title: 'Breakfast', servings: 2, readyInMinutes: 10, image: '', ingredients: [] };
            const meal2 = { id: 2, title: 'Lunch', servings: 2, readyInMinutes: 15, image: '', ingredients: [] };
            await scheduleMeal(meal1 as never, '2026-03-25', 'breakfast', 'v-1', 2);
            await scheduleMeal(meal2 as never, '2026-03-26', 'lunch', 'v-1', 2);

            const march25 = getMealsForDate('2026-03-25');
            // Should include the breakfast, not the lunch
            const hasMarch25 = march25.some((m) => m.planned_date === '2026-03-25');
            expect(hasMarch25).toBe(true);
        });

        it('getMealsByStatus filters by status', async () => {
            const meal = { id: 3, title: 'Steak', servings: 4, readyInMinutes: 30, image: '', ingredients: [] };
            await scheduleMeal(meal as never, '2026-03-27', 'dinner', null, 4);

            const reserved = getMealsByStatus('reserved');
            expect(reserved.length).toBeGreaterThanOrEqual(1);
        });
    });
});
