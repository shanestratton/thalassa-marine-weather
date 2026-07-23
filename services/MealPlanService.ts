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

import { atomicLocalTransaction, getAll, query, insertLocal, generateUUID } from './vessel/LocalDatabase';
import { scaleIngredient, type RecipeIngredient, type GalleyMeal } from './GalleyRecipeService';
import { convertQuantity } from './PurchaseUnits';
import { triggerHaptic } from '../utils/system';
import { getMyCrew } from './CrewService';

// ── Types ──────────────────────────────────────────────────────────────────

export type MealSlot = 'breakfast' | 'lunch' | 'dinner' | 'snack';
export type MealStatus = 'planned' | 'reserved' | 'cooking' | 'completed' | 'skipped';

export interface MealPlan {
    id: string;
    /**
     * Authoritative vessel owner. Missing only on legacy local snapshots,
     * which are deliberately excluded from owner-sensitive stores actions.
     */
    user_id?: string;
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
    ownerUserId: string | null = null,
): Promise<MealPlan> {
    const now = new Date().toISOString();
    const owner = ownerUserId?.trim() || '';
    if (voyageId && !owner) {
        throw new Error('An authoritative voyage owner is required to schedule a shared meal.');
    }

    // Scale ingredients to planned servings
    const scaledIngredients = (meal.ingredients || []).map((ing) => ({
        ...ing,
        amount: scaleIngredient(ing.amount, ing.scalable, meal.servings, servings, ing.unit),
    }));

    const plan: MealPlan = {
        id: generateUUID(),
        user_id: owner,
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
export function getMealPlans(voyageId?: string | null): MealPlan[] {
    if (voyageId !== undefined) {
        return query<MealPlan>(TABLE, (m) => m.voyage_id === voyageId);
    }
    return getAll<MealPlan>(TABLE);
}

/** Get meals for a specific date */
export function getMealsForDate(date: string, voyageId?: string | null): MealPlan[] {
    return query<MealPlan>(TABLE, (m) => {
        const dateMatch = m.planned_date === date;
        const voyageMatch = voyageId === undefined || m.voyage_id === voyageId;
        return dateMatch && voyageMatch;
    });
}

/** Get meals by status, optionally constrained to one selected voyage. */
export function getMealsByStatus(status: MealStatus, voyageId?: string | null): MealPlan[] {
    return query<MealPlan>(TABLE, (m) => m.status === status && (voyageId === undefined || m.voyage_id === voyageId));
}

// ── Ingredient Reservation ─────────────────────────────────────────────────

function normalizeOwnerId(ownerUserId: string | null | undefined): string | null {
    const normalized = ownerUserId?.trim();
    return normalized || null;
}

/**
 * Resolve a single owner from the selected voyage's local meal snapshots.
 * Returning null on missing or conflicting ownership deliberately fails
 * closed: a crew member can have several skippers' registers cached locally.
 */
function resolveMealOwner(voyageId?: string | null, explicitOwnerUserId?: string | null): string | null {
    const explicitOwner = normalizeOwnerId(explicitOwnerUserId);
    const owners = new Set(
        query<MealPlan>(TABLE, (meal) => voyageId === undefined || meal.voyage_id === voyageId)
            .map((meal) => normalizeOwnerId(meal.user_id))
            .filter((owner): owner is string => owner !== null),
    );

    if (explicitOwner) {
        // A verified passage owner can seed a brand-new plan. Once local meal
        // snapshots exist, however, disagreement means the context is stale
        // or corrupt and owner-sensitive reads must stop.
        if (voyageId !== undefined && owners.size > 0 && (owners.size !== 1 || !owners.has(explicitOwner))) {
            return null;
        }
        return explicitOwner;
    }

    return owners.size === 1 ? Array.from(owners)[0] : null;
}

/**
 * Calculate all reserved ingredients across active meal plans.
 * Only counts meals with status 'reserved' or 'cooking'.
 */
export function getReservedIngredients(voyageId?: string | null, ownerUserId?: string | null): ReservedIngredient[] {
    const owner = resolveMealOwner(voyageId, ownerUserId);
    if (!owner) return [];

    const activeMeals = query<MealPlan>(TABLE, (m) => {
        const statusMatch = m.status === 'reserved' || m.status === 'cooking';
        const voyageMatch = voyageId === undefined || m.voyage_id === voyageId;
        return statusMatch && voyageMatch && normalizeOwnerId(m.user_id) === owner;
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
export function getStoresAvailability(voyageId?: string | null, ownerUserId?: string | null): StoresAvailability[] {
    const owner = resolveMealOwner(voyageId, ownerUserId);
    if (!owner) return [];

    const storeItems = query<{
        id: string;
        user_id: string;
        item_name: string;
        quantity: number;
        unit?: string;
    }>(STORES_TABLE, (item) => normalizeOwnerId(item.user_id) === owner);

    const reserved = getReservedIngredients(voyageId, owner);
    const reservationsByName = new Map<string, Array<ReservedIngredient & { remaining: number }>>();
    for (const reservation of reserved) {
        const key = reservation.ingredient_name.toLowerCase().trim();
        const entries = reservationsByName.get(key) ?? [];
        entries.push({ ...reservation, remaining: reservation.total_reserved });
        reservationsByName.set(key, entries);
    }

    return storeItems.map((item) => {
        const onHand = Number.isFinite(item.quantity) ? Math.max(0, item.quantity) : 0;
        const reservations = reservationsByName.get(item.item_name.toLowerCase().trim()) ?? [];
        const inventoryUnit = item.unit?.trim() || reservations[0]?.unit || 'whole';
        let reservedQty = 0;

        for (const reservation of reservations) {
            if (reservation.remaining <= 0 || reservedQty >= onHand) continue;
            const availableInInventoryUnit = convertQuantity(reservation.remaining, reservation.unit, inventoryUnit);
            if (availableInInventoryUnit === null) continue;

            const allocated = Math.min(onHand - reservedQty, Math.max(0, availableInInventoryUnit));
            const allocatedInRecipeUnit = convertQuantity(allocated, inventoryUnit, reservation.unit);
            if (allocatedInRecipeUnit === null) continue;

            reservedQty += allocated;
            reservation.remaining = Math.max(0, reservation.remaining - allocatedInRecipeUnit);
        }

        return {
            item_id: item.id,
            item_name: item.item_name,
            on_hand: onHand,
            reserved: Math.round(reservedQty * 10_000) / 10_000,
            available: Math.max(0, Math.round((onHand - reservedQty) * 10_000) / 10_000),
            unit: inventoryUnit,
        };
    });
}

// ── Cooking Mode Lifecycle ─────────────────────────────────────────────────

/** Start cooking a meal */
export async function startCooking(mealPlanId: string): Promise<MealPlan | null> {
    const outcome = await atomicLocalTransaction((transaction) => {
        const meal = transaction.getById<MealPlan>(TABLE, mealPlanId);
        if (!meal) return { meal: null, startedNow: false };
        if (meal.status === 'cooking') return { meal, startedNow: false };
        if (meal.status !== 'planned' && meal.status !== 'reserved') {
            return { meal: null, startedNow: false };
        }

        const started = transaction.update<MealPlan>(TABLE, mealPlanId, {
            status: 'cooking' as MealStatus,
            cook_started_at: new Date().toISOString(),
        } as Partial<MealPlan>);
        return { meal: started, startedNow: started !== null };
    });
    if (outcome.startedNow) triggerHaptic('medium');
    return outcome.meal;
}

/**
 * Complete a meal — triggers DELTA subtractions from Ship's Stores.
 *
 * This is the "Salty Execution": each ingredient is subtracted from
 * stores using DELTA mutations for safe offline multi-device sync.
 */
async function completeMealOnce(mealPlanId: string, servingsConsumed?: number): Promise<MealPlan | null> {
    const outcome = await atomicLocalTransaction((transaction) => {
        const meal = transaction.getById<MealPlan>(TABLE, mealPlanId);
        if (!meal) return { meal: null, completedNow: false };
        if (meal.status === 'completed') return { meal, completedNow: false };
        if (meal.status !== 'reserved' && meal.status !== 'cooking') {
            return { meal: null, completedNow: false };
        }

        // Calculate consumption ratio. Guard against zero / corrupt
        // servings_planned: Infinity must never reach an inventory DELTA.
        const planned = meal.servings_planned > 0 ? meal.servings_planned : 1;
        const requestedServings =
            typeof servingsConsumed === 'number' && Number.isFinite(servingsConsumed) && servingsConsumed > 0
                ? Math.min(servingsConsumed, planned * 2)
                : planned;
        const ratio = requestedServings / planned;

        const mealOwner = normalizeOwnerId(meal.user_id);
        const storeItems = mealOwner
            ? transaction.query<{
                  id: string;
                  user_id: string;
                  item_name: string;
                  quantity: number;
                  unit?: string;
              }>(STORES_TABLE, (item) => normalizeOwnerId(item.user_id) === mealOwner)
            : [];
        const storesByName = new Map<string, Array<{ id: string; remaining: number; unit?: string }>>();
        for (const store of storeItems) {
            const key = store.item_name.toLowerCase().trim();
            const entries = storesByName.get(key) ?? [];
            entries.push({
                id: store.id,
                remaining: Number.isFinite(store.quantity) ? Math.max(0, store.quantity) : 0,
                unit: store.unit,
            });
            storesByName.set(key, entries);
        }

        for (const ingredient of meal.ingredients) {
            const stores = storesByName.get(ingredient.name.toLowerCase().trim());
            if (!stores) continue;

            let requested = Math.max(0, Math.round(ingredient.amount * ratio * 100_000_000) / 100_000_000);
            for (const store of stores) {
                if (requested <= 0 || store.remaining <= 0) continue;
                const inventoryUnit = store.unit?.trim() || ingredient.unit;
                const availableInRecipeUnit = convertQuantity(store.remaining, inventoryUnit, ingredient.unit);
                if (availableInRecipeUnit === null) continue;

                const consumedInRecipeUnit = Math.min(requested, Math.max(0, availableInRecipeUnit));
                const consumedInInventoryUnit = convertQuantity(consumedInRecipeUnit, ingredient.unit, inventoryUnit);
                if (consumedInInventoryUnit === null || consumedInInventoryUnit <= 0) continue;

                transaction.delta(STORES_TABLE, store.id, 'quantity', -consumedInInventoryUnit);
                store.remaining = Math.max(0, store.remaining - consumedInInventoryUnit);
                requested = Math.max(0, requested - consumedInRecipeUnit);
            }
        }

        const completed = transaction.update<MealPlan>(TABLE, mealPlanId, {
            status: 'completed' as MealStatus,
            completed_at: new Date().toISOString(),
        } as Partial<MealPlan>);
        return { meal: completed, completedNow: completed !== null };
    });

    if (outcome.completedNow) triggerHaptic('heavy');
    return outcome.meal;
}

export async function completeMeal(mealPlanId: string, servingsConsumed?: number): Promise<MealPlan | null> {
    return completeMealOnce(mealPlanId, servingsConsumed);
}

/** Skip a meal (removes reservation without subtracting stores) */
export async function skipMeal(mealPlanId: string): Promise<MealPlan | null> {
    return atomicLocalTransaction((transaction) => {
        const meal = transaction.getById<MealPlan>(TABLE, mealPlanId);
        if (!meal) return null;
        if (meal.status === 'skipped') return meal;
        if (meal.status !== 'planned' && meal.status !== 'reserved') return null;

        return transaction.update<MealPlan>(TABLE, mealPlanId, {
            status: 'skipped' as MealStatus,
        } as Partial<MealPlan>);
    });
}

// ── Leftover Management ────────────────────────────────────────────────────

/**
 * Save leftovers as a new Ship's Stores entry (Fridge/Prepared).
 *
 * @param mealPlanId - The completed meal
 * @param servingsRemaining - How many servings are left over
 */
async function saveLeftoversOnce(mealPlanId: string, servingsRemaining: number): Promise<void> {
    if (!Number.isFinite(servingsRemaining) || servingsRemaining <= 0) return;

    const saved = await atomicLocalTransaction((transaction) => {
        const meal = transaction.getById<MealPlan>(TABLE, mealPlanId);
        if (!meal || meal.status !== 'completed') return false;
        const mealOwner = normalizeOwnerId(meal.user_id);
        if (!mealOwner) return false;

        const itemName = `${meal.title} (Leftovers)`;
        const notes = `Leftovers from ${meal.planned_date} ${meal.meal_slot}`;
        const deterministicId = mealPlanId;
        const deterministicItem = transaction.getById<{
            id: string;
            user_id: string;
            item_name: string;
            unit?: string;
        }>(STORES_TABLE, deterministicId);
        if (
            deterministicItem &&
            (normalizeOwnerId(deterministicItem.user_id) !== mealOwner ||
                deterministicItem.item_name !== itemName ||
                deterministicItem.unit !== 'serves')
        ) {
            throw new Error('The deterministic leftovers record ID is already used by another stores item.');
        }

        // Recognize leftovers created by the previous random-ID implementation
        // so upgrading can repair a missing meal flag without duplicating food.
        const existingLegacyItem = transaction.query<{
            id: string;
            user_id: string;
            item_name: string;
            notes?: string | null;
        }>(
            STORES_TABLE,
            (item) =>
                normalizeOwnerId(item.user_id) === mealOwner && item.item_name === itemName && item.notes === notes,
        )[0];

        let changed = false;
        if (!deterministicItem && !existingLegacyItem) {
            const now = new Date().toISOString();
            transaction.insert(STORES_TABLE, {
                id: deterministicId,
                user_id: mealOwner,
                item_name: itemName,
                category: 'Fridge',
                quantity: servingsRemaining,
                min_quantity: 0,
                unit: 'serves',
                location_zone: 'Galley',
                location_specific: 'Fridge',
                expiry_date: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
                notes,
                created_at: now,
                updated_at: now,
            });
            changed = true;
        }

        if (!meal.leftovers_saved) {
            transaction.update<MealPlan>(TABLE, mealPlanId, {
                leftovers_saved: true,
            } as Partial<MealPlan>);
            changed = true;
        }
        return changed;
    });

    if (saved) triggerHaptic('light');
}

export async function saveLeftovers(mealPlanId: string, servingsRemaining: number): Promise<void> {
    return saveLeftoversOnce(mealPlanId, servingsRemaining);
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

// ── Voyage Context Helpers ─────────────────────────────────────────────────

export interface MealDayInfo {
    /** Number of actual passage days (departure → arrival) */
    passageDays: number;
    /** Number of emergency buffer days (2 per 5 passage days) */
    emergencyDays: number;
    /** Total days to plan meals for */
    totalDays: number;
    /** Array of ISO date strings for each day */
    dates: string[];
    /** Which dates are emergency buffer days */
    emergencyDates: Set<string>;
}

/**
 * Calculate meal planning days from voyage departure/arrival.
 *
 * Formula: 2 emergency days per 5 passage days.
 * Emergency days are appended after the ETA for weather delays,
 * mechanical issues, etc. Cook should plan shelf-stable meals for these.
 */
export function calculateMealDays(departureTime: string, eta: string): MealDayInfo {
    const dep = new Date(departureTime);
    const arr = new Date(eta);
    const diffMs = arr.getTime() - dep.getTime();
    const passageDays = Math.max(1, Math.ceil(diffMs / (24 * 60 * 60 * 1000)));
    const emergencyDays = Math.floor(passageDays / 5) * 2;
    const totalDays = passageDays + emergencyDays;

    const dates: string[] = [];
    const emergencyDates = new Set<string>();
    const startDate = new Date(departureTime + (departureTime.includes('T') ? '' : 'T00:00:00Z'));

    for (let i = 0; i < totalDays; i++) {
        const d = new Date(startDate.getTime() + i * 24 * 60 * 60 * 1000);
        const dateStr = d.toISOString().split('T')[0];
        dates.push(dateStr);
        if (i >= passageDays) {
            emergencyDates.add(dateStr);
        }
    }

    return { passageDays, emergencyDays, totalDays, dates, emergencyDates };
}

/**
 * Get crew count for a voyage from the crew roster.
 * Returns crew members + 1 (the captain/owner).
 */
export async function getCrewCount(voyageId: string): Promise<number> {
    try {
        const crew = await getMyCrew(voyageId);
        // +1 for the captain (who is the owner, not in the crew list)
        return crew.filter((c) => c.status === 'accepted').length + 1;
    } catch {
        return 1; // Offline fallback — at least the captain
    }
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
            voyage_id: voyageId,
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
            updated_at: now,
        });

        triggerHaptic('medium');
        return true;
    } catch {
        return false;
    }
}

// ── Aggregated Ingredients for Shopping List ────────────────────────────────

export interface AggregatedIngredient {
    /** Ingredient name (title-cased) */
    name: string;
    /** Total quantity across all scheduled meals */
    totalQty: number;
    /** Unit (e.g. "g", "ml", "whole") */
    unit: string;
    /** Which meals use this ingredient */
    mealTitles: string[];
    /** Pre-selected for shopping list (user can deselect) */
    selected: boolean;
}

/**
 * Aggregate all ingredients from scheduled meals for a voyage.
 * Deduplicates by name+unit and sums quantities.
 * Returns a flat list ready for the shopping list checklist UI.
 */
export function getAggregatedIngredients(voyageId?: string): AggregatedIngredient[] {
    const meals = query<MealPlan>(TABLE, (m) => {
        const statusOk = m.status !== 'completed' && m.status !== 'skipped';
        const voyageOk = voyageId ? m.voyage_id === voyageId : true;
        return statusOk && voyageOk;
    });

    const map = new Map<string, AggregatedIngredient>();

    for (const meal of meals) {
        for (const ing of meal.ingredients) {
            if (!ing.name || ing.amount <= 0) continue;
            const key = `${ing.name.toLowerCase()}__${ing.unit.toLowerCase()}`;
            const existing = map.get(key);
            if (existing) {
                existing.totalQty += ing.amount;
                if (!existing.mealTitles.includes(meal.title)) {
                    existing.mealTitles.push(meal.title);
                }
            } else {
                map.set(key, {
                    name: ing.name,
                    totalQty: ing.amount,
                    unit: ing.unit,
                    mealTitles: [meal.title],
                    selected: true,
                });
            }
        }
    }

    // Sort alphabetically, round quantities
    return Array.from(map.values())
        .map((i) => ({ ...i, totalQty: Math.round(i.totalQty * 10) / 10 }))
        .sort((a, b) => a.name.localeCompare(b.name));
}
