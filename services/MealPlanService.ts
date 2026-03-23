/**
 * MealPlanService — Passage Calendar + Ingredient Reservation + Leftovers.
 *
 * Handles:
 *  1. Scheduling recipes to voyage dates (breakfast/lunch/dinner/snack)
 *  2. Ingredient reservation — visually flags stores items as reserved
 *  3. Cooking mode lifecycle (planned → reserved → cooking → completed)
 *  4. DELTA subtractions from Ship's Stores on meal completion
 *  5. Leftover management → creates new Fridge/Prepared stores entry
 *
 * All operations go through LocalDatabase for offline-first sync.
 * Dates stored as UTC ISO strings for International Date Line safety.
 */

import { getAll, query, insertLocal, updateLocal, deltaLocal, generateUUID } from './vessel/LocalDatabase';
import { scaleIngredient, type RecipeIngredient, type GalleyMeal } from './GalleyRecipeService';
import { triggerHaptic } from '../utils/system';

// ── Types ──────────────────────────────────────────────────────────────────

export type MealSlot = 'breakfast' | 'lunch' | 'dinner' | 'snack';
export type MealStatus = 'planned' | 'reserved' | 'cooking' | 'completed' | 'skipped';

export interface MealPlan {
    id: string;
    voyage_id: string | null;
    recipe_id: string | null;
    spoonacular_id: number | null;
    title: string;
    planned_date: string; // ISO date string (UTC)
    meal_slot: MealSlot;
    servings_planned: number;
    ingredients: RecipeIngredient[];
    status: MealStatus;
    cook_started_at: string | null;
    completed_at: string | null;
    leftovers_saved: boolean;
    notes: string | null;
    created_at: string;
    updated_at: string;
}

export interface ReservedIngredient {
    ingredient_name: string;
    total_reserved: number;
    unit: string;
    meal_titles: string[];
    planned_dates: string[];
}

export interface StoresAvailability {
    item_id: string;
    item_name: string;
    on_hand: number;
    reserved: number;
    available: number; // on_hand - reserved
    unit: string;
}

// ── Constants ──────────────────────────────────────────────────────────────

const TABLE = 'meal_plans';
const STORES_TABLE = 'inventory_items';

// ── Scheduling ─────────────────────────────────────────────────────────────

/**
 * Schedule a recipe to a specific date and meal slot.
 * Auto-sets status to 'reserved' and snapshots ingredients.
 */
export async function scheduleMeal(
    meal: GalleyMeal,
    plannedDate: string,
    slot: MealSlot,
    voyageId: string | null,
    servings: number,
): Promise<MealPlan> {
    const now = new Date().toISOString();

    // Scale ingredients to planned servings
    const scaledIngredients = (meal.ingredients || []).map((ing) => ({
        ...ing,
        amount: scaleIngredient(ing.amount, ing.scalable, meal.servings, servings),
    }));

    const plan: MealPlan = {
        id: generateUUID(),
        voyage_id: voyageId,
        recipe_id: null,
        spoonacular_id: meal.id,
        title: meal.title,
        planned_date: plannedDate,
        meal_slot: slot,
        servings_planned: servings,
        ingredients: scaledIngredients,
        status: 'reserved',
        cook_started_at: null,
        completed_at: null,
        leftovers_saved: false,
        notes: null,
        created_at: now,
        updated_at: now,
    };

    await insertLocal(TABLE, plan);

    // Auto-persist the recipe to LocalDatabase for offline access at sea
    try {
        const { persistRecipe } = await import('./GalleyRecipeService');
        persistRecipe(meal).catch(() => {
            /* offline — recipe may already be stored */
        });
    } catch {
        /* GalleyRecipeService not available */
    }

    triggerHaptic('light');
    return plan;
}

/** Remove a scheduled meal */
export async function unscheduleMeal(mealPlanId: string): Promise<boolean> {
    const { deleteLocal } = await import('./vessel/LocalDatabase');
    await deleteLocal(TABLE, mealPlanId);
    triggerHaptic('light');
    return true;
}

// ── Querying ───────────────────────────────────────────────────────────────

/** Get all meal plans for a voyage */
export function getMealPlans(voyageId?: string): MealPlan[] {
    if (voyageId) {
        return query<MealPlan>(TABLE, (m) => m.voyage_id === voyageId);
    }
    return getAll<MealPlan>(TABLE);
}

/** Get meals for a specific date */
export function getMealsForDate(date: string, voyageId?: string): MealPlan[] {
    return query<MealPlan>(TABLE, (m) => {
        const dateMatch = m.planned_date === date;
        const voyageMatch = voyageId ? m.voyage_id === voyageId : true;
        return dateMatch && voyageMatch;
    });
}

/** Get meals by status */
export function getMealsByStatus(status: MealStatus): MealPlan[] {
    return query<MealPlan>(TABLE, (m) => m.status === status);
}

// ── Ingredient Reservation ─────────────────────────────────────────────────

/**
 * Calculate all reserved ingredients across active meal plans.
 * Only counts meals with status 'reserved' or 'cooking'.
 */
export function getReservedIngredients(voyageId?: string): ReservedIngredient[] {
    const activeMeals = query<MealPlan>(TABLE, (m) => {
        const statusMatch = m.status === 'reserved' || m.status === 'cooking';
        const voyageMatch = voyageId ? m.voyage_id === voyageId : true;
        return statusMatch && voyageMatch;
    });

    const aggregated = new Map<string, ReservedIngredient>();

    for (const meal of activeMeals) {
        for (const ing of meal.ingredients) {
            const key = `${ing.name.toLowerCase()}_${ing.unit.toLowerCase()}`;
            const existing = aggregated.get(key);
            if (existing) {
                existing.total_reserved += ing.amount;
                if (!existing.meal_titles.includes(meal.title)) {
                    existing.meal_titles.push(meal.title);
                }
                if (!existing.planned_dates.includes(meal.planned_date)) {
                    existing.planned_dates.push(meal.planned_date);
                }
            } else {
                aggregated.set(key, {
                    ingredient_name: ing.name,
                    total_reserved: ing.amount,
                    unit: ing.unit,
                    meal_titles: [meal.title],
                    planned_dates: [meal.planned_date],
                });
            }
        }
    }

    return Array.from(aggregated.values());
}

/**
 * Get stores availability: on_hand vs reserved vs available.
 * Used by the Ship's Stores UI to show visual reservation flags.
 */
export function getStoresAvailability(voyageId?: string): StoresAvailability[] {
    const storeItems = getAll<{
        id: string;
        item_name: string;
        quantity: number;
        unit?: string;
    }>(STORES_TABLE);

    const reserved = getReservedIngredients(voyageId);
    const reservedMap = new Map(reserved.map((r) => [r.ingredient_name.toLowerCase(), r]));

    return storeItems.map((item) => {
        const res = reservedMap.get(item.item_name.toLowerCase());
        const reservedQty = res ? res.total_reserved : 0;
        return {
            item_id: item.id,
            item_name: item.item_name,
            on_hand: item.quantity,
            reserved: Math.round(reservedQty * 10) / 10,
            available: Math.max(0, Math.round((item.quantity - reservedQty) * 10) / 10),
            unit: item.unit || 'whole',
        };
    });
}

// ── Cooking Mode Lifecycle ─────────────────────────────────────────────────

/** Start cooking a meal */
export async function startCooking(mealPlanId: string): Promise<MealPlan | null> {
    triggerHaptic('medium');
    return updateLocal<MealPlan>(TABLE, mealPlanId, {
        status: 'cooking' as MealStatus,
        cook_started_at: new Date().toISOString(),
    } as Partial<MealPlan>);
}

/**
 * Complete a meal — triggers DELTA subtractions from Ship's Stores.
 *
 * This is the "Salty Execution": each ingredient is subtracted from
 * stores using DELTA mutations for safe offline multi-device sync.
 */
export async function completeMeal(mealPlanId: string, servingsConsumed?: number): Promise<MealPlan | null> {
    const meal = query<MealPlan>(TABLE, (m) => m.id === mealPlanId)[0];
    if (!meal) return null;

    // Calculate consumption ratio
    const ratio = servingsConsumed ? servingsConsumed / meal.servings_planned : 1;

    // DELTA subtract each ingredient from Ship's Stores
    const storeItems = getAll<{ id: string; item_name: string }>(STORES_TABLE);
    const storeMap = new Map(storeItems.map((s) => [s.item_name.toLowerCase(), s.id]));

    for (const ing of meal.ingredients) {
        const storeId = storeMap.get(ing.name.toLowerCase());
        if (storeId) {
            const consumed = Math.round(ing.amount * ratio * 10) / 10;
            await deltaLocal(STORES_TABLE, storeId, 'quantity', -consumed);
        }
    }

    triggerHaptic('heavy');

    return updateLocal<MealPlan>(TABLE, mealPlanId, {
        status: 'completed' as MealStatus,
        completed_at: new Date().toISOString(),
    } as Partial<MealPlan>);
}

/** Skip a meal (removes reservation without subtracting stores) */
export async function skipMeal(mealPlanId: string): Promise<MealPlan | null> {
    return updateLocal<MealPlan>(TABLE, mealPlanId, {
        status: 'skipped' as MealStatus,
    } as Partial<MealPlan>);
}

// ── Leftover Management ────────────────────────────────────────────────────

/**
 * Save leftovers as a new Ship's Stores entry (Fridge/Prepared).
 *
 * @param mealPlanId - The completed meal
 * @param servingsRemaining - How many servings are left over
 */
export async function saveLeftovers(mealPlanId: string, servingsRemaining: number): Promise<void> {
    const meal = query<MealPlan>(TABLE, (m) => m.id === mealPlanId)[0];
    if (!meal || meal.status !== 'completed') return;

    const now = new Date().toISOString();

    // Create a new stores entry for the leftovers
    const leftoverItem = {
        id: generateUUID(),
        item_name: `${meal.title} (Leftovers)`,
        category: 'Fridge',
        quantity: servingsRemaining,
        min_quantity: 0,
        unit: 'serves',
        location_zone: 'Galley',
        location_specific: 'Fridge',
        expiry_date: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(), // 3 days
        notes: `Leftovers from ${meal.planned_date} ${meal.meal_slot}`,
        created_at: now,
        updated_at: now,
    };

    await insertLocal(STORES_TABLE, leftoverItem);

    // Flag the meal plan as having saved leftovers
    await updateLocal<MealPlan>(TABLE, mealPlanId, {
        leftovers_saved: true,
    } as Partial<MealPlan>);

    triggerHaptic('light');
}

// ── Timezone-Safe Date Helpers ─────────────────────────────────────────────

/**
 * Get a UTC date string from a local date (International Date Line safe).
 * Always stores as YYYY-MM-DD in UTC to avoid date-shift on IDL crossing.
 */
export function toUTCDateString(date: Date): string {
    return date.toISOString().split('T')[0];
}

/** Get today's date as a UTC string */
export function todayUTC(): string {
    return toUTCDateString(new Date());
}

/** Get a range of UTC date strings for a voyage */
export function getVoyageDateRange(startDate: string, days: number): string[] {
    const dates: string[] = [];
    const start = new Date(startDate + 'T00:00:00Z');
    for (let i = 0; i < days; i++) {
        const d = new Date(start.getTime() + i * 24 * 60 * 60 * 1000);
        dates.push(d.toISOString().split('T')[0]);
    }
    return dates;
}

// ── Shortfall Helper ───────────────────────────────────────────────────────

/**
 * Add a single ingredient shortfall to passage provisions.
 * Called from ChefPlate "ADD TO LIST" button per ingredient.
 */
export async function addShortfallItem(
    ingredientName: string,
    requiredQty: number,
    unit: string,
    recipeTitle: string,
    voyageId: string | null,
): Promise<boolean> {
    try {
        const { insertLocal: ins, generateUUID: uuid } = await import('./vessel/LocalDatabase');
        const now = new Date().toISOString();

        await ins('passage_provisions', {
            id: uuid(),
            passage_name: voyageId || 'Current Passage',
            recipe_title: recipeTitle,
            ingredient_name: ingredientName,
            required_qty: Math.round(requiredQty * 10) / 10,
            unit,
            scalable: true,
            store_item_id: null,
            store_item_name: null,
            on_hand_qty: 0,
            shortfall_qty: Math.round(requiredQty * 10) / 10,
            status: 'needed',
            created_at: now,
        });

        triggerHaptic('medium');
        return true;
    } catch {
        return false;
    }
}
